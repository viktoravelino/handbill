import { Effect, Option, Redacted, Result } from "effect"
import { Command } from "effect/unstable/cli"
import type { Key } from "@handbill/contract"
import { Browser } from "./browser"
import * as Client from "./client"
import { clientFor, handler, openIf, required } from "./command-kit"
import * as Config from "./config"
import { endpointFlag, jsonFlag, openFlag, upgradeFlag, webFlag } from "./flags"
import { GitHubDevice, LoginFailed } from "./github"
import * as Output from "./output"

/**
 * The three commands about the key rather than about a page: `login` mints one
 * against a hosted deployment and `logout` gives it back — both say so plainly
 * against a self-hosted deployment, which runs on one shared `PUBLISH_TOKEN`
 * and has no accounts to mint for — and `account` reports what the key in hand
 * is allowed to spend.
 */

/**
 * Hands a key back. `DELETE /v1/keys/current` authenticates with the key it
 * revokes and is off the `Authorization` middleware, so this needs nothing but
 * the key and answers 204 even for one that is already dead. All three callers
 * are here: signing out, replacing a key on a second `login`, and giving back
 * one that could not be stored.
 */
const revokeKey = Effect.fn(function* (endpoint: string, key: Redacted.Redacted<string>) {
  const client = yield* Client.selfAuthorizing({ endpoint, token: key })
  return yield* client.keys.revoke({})
})

/**
 * The exchange: a GitHub access token in, a handbill key out. Both failures the
 * route can answer get a sentence of their own, because the shared ones would
 * name the wrong thing — the alias 404 for `NotFound`, and a bearer the user
 * should check for `Unauthorized`, when what was refused is the GitHub account.
 */
const mint = Effect.fn(function* (
  settings: Config.Settings,
  client: Client.Client,
  githubToken: Redacted.Redacted<string>
) {
  return yield* client.keys.mint({ payload: { githubToken: Redacted.value(githubToken) } }).pipe(
    Effect.catchTags({
      // Accounts were on a moment ago, so this is the endpoint changing under
      // the login rather than the self-hosted 404 `login` checks for first.
      NotFound: () => Effect.fail(new Output.NoAccounts({ endpoint: settings.endpoint.value })),
      // The Worker asked GitHub who the token belongs to and GitHub said
      // nobody — the flow succeeded, so this is not a token to retry.
      Unauthorized: () =>
        Effect.fail(new LoginFailed({ reason: "the endpoint did not accept the GitHub account" }))
    })
  )
})

/**
 * Puts a freshly minted key where the next command will find it, and leaves no
 * live key behind on either side of the swap.
 */
const store = Effect.fn(function* (settings: Config.Settings, minted: Key) {
  yield* Config.save(settings, {
    token: minted.key,
    // A key is only good against the deployment that minted it, so `login`
    // writes down which one that was. `mintedAt` is the provenance every later
    // command checks the endpoint it is about to call against; `endpoint` is
    // still only a preference, and is left alone when the default was used so
    // it can move. Spread rather than `undefined`, which would remove it.
    mintedAt: settings.endpoint.source === "default" ? "default" : settings.endpoint.value,
    ...(settings.endpoint.source === "default" ? {} : { endpoint: settings.endpoint.value })
  }).pipe(
    // Minting is the one moment the key exists in readable form, so a file that
    // cannot be written must not simply swallow it — and printing it would put a
    // live credential in shell scrollback and CI logs, where it outlives the
    // failure. Giving it back leaks nothing. Whether that worked is the
    // difference between "nothing is left live" and its opposite, and the
    // likeliest cause of an unwritable config is also a decent way to be
    // offline, so the sentence is chosen rather than assumed: keys never expire.
    Effect.tapError(() =>
      Effect.flatMap(
        Effect.result(revokeKey(settings.endpoint.value, Redacted.make(minted.key))),
        (given) =>
          Output.note(
            Result.isSuccess(given)
              ? "The key could not be stored, so it was given back; nothing is left live."
              : `The key could not be stored and could not be given back either: a key now exists on ${settings.endpoint.value} that nothing holds.`
          )
      )
    )
  )
  // The key this one replaces would otherwise stay live forever: every `POST
  // /v1/keys` mints a fresh record, nothing expires the last one, and once it is
  // out of the file nobody can revoke it — the route needs the key in hand and
  // there is no listing. Only a key from the file, and only one a deployment
  // minted: the environment's token is not this command's to kill, and an
  // operator's `PUBLISH_TOKEN` never is.
  yield* Option.match(settings.token, {
    onNone: () => Effect.void,
    onSome: (previous) => {
      if (previous.source !== "file" || !Config.isMintedKey(previous.value)) return Effect.void
      // The deployment that minted it, which `--endpoint` may have just moved
      // away from: sending it to the one being logged in to would hand a live
      // production key to another host, get a meaningless answer, and leave the
      // real key live forever on the deployment that issued it.
      return Config.mintedEndpoint(settings, previous.source).pipe(
        Effect.flatMap((where) =>
          revokeKey(where, previous.value).pipe(
            Effect.catch(() =>
              Output.note(
                `The key this one replaces could not be given back at ${where}: it is still live there, and nothing holds it any more.`
              )
            )
          )
        ),
        // A `mintedAt` no key may cross — someone hand-edited it to plain http —
        // is worth saying out loud, not worth abandoning a login for: the new
        // key is already stored, and failing here would only lose it too.
        Effect.catchTag("InsecureEndpoint", (failure) =>
          Output.note(Output.describe(failure).message)
        )
      )
    }
  })
  yield* Output.note(`Signed in to ${settings.endpoint.value}. The key is in ${settings.path}.`)
  // The file is not where the CLI will read a key from next: the environment
  // beats it, and the new key would never be used.
  if (Option.isSome(settings.token) && settings.token.value.source === "env") {
    yield* Output.note("HANDBILL_TOKEN is set and wins over the file: unset it to use this key.")
  }
})

/**
 * `login`: GitHub's device flow for an access token, that token exchanged once
 * at `POST /v1/keys`, and the key it mints written to the config file. The
 * GitHub token is never stored — it proves who the user is and is then dropped.
 */
export const login = Command.make(
  "login",
  { endpoint: endpointFlag, json: jsonFlag },
  handler(({ endpoint, json }) =>
    Effect.gen(function* () {
      const settings = yield* Config.resolve({ endpoint })
      const client = yield* Client.anonymous(settings.endpoint.value)
      // Ask what the endpoint runs before sending anyone to GitHub: a
      // deployment on one shared token has no keys to mint, and finding that
      // out afterwards would have spent a real GitHub grant on nothing.
      const { mode } = yield* client.meta.health({})
      if (mode !== "accounts") {
        return yield* Effect.fail(new Output.NoAccounts({ endpoint: settings.endpoint.value }))
      }

      const browser = yield* Browser
      const device = yield* GitHubDevice
      const githubToken = yield* device.authorize((code) =>
        Effect.andThen(
          Output.note(`Open ${code.verificationUri} and enter the code ${code.userCode}.`),
          // The code and the URL are already on stderr, so a browser that will
          // not start is an inconvenience, not a failed login.
          Effect.ignore(browser.open(code.verificationUri))
        )
      )
      const minted = yield* mint(settings, client, githubToken)
      yield* store(settings, minted)
      yield* json
        ? Output.json({
            owner: minted.owner,
            endpoint: settings.endpoint.value,
            path: settings.path
          })
        : Output.line(minted.owner)
    })
  )
).pipe(
  Command.withDescription(
    "Sign in with GitHub and store the key it mints. The browser opens on a code to type; the key goes in ~/.config/handbill/config.json."
  ),
  Command.withExamples([
    { command: "handbill login", description: "Sign in to the hosted deployment" },
    {
      command: "handbill login --endpoint https://api.example.dev",
      description: "Sign in to another deployment that runs accounts"
    }
  ])
)

/**
 * Drops the key that was just revoked from wherever it actually lives, and says
 * so when that is somewhere `logout` cannot reach. The environment beats the
 * file, so a machine holding a key in both would otherwise have the file's key
 * deleted while the environment's was the one revoked — leaving it live and
 * unrevokable, since `DELETE /v1/keys/current` needs the key itself and the
 * file was the only thing holding it. Answers whether anything was cleared.
 */
const clearLocal = Effect.fn(function* (settings: Config.Settings, source: Config.Source) {
  if (source === "file") {
    // `mintedAt` is about the key and nothing else, so it goes with it: leaving
    // it behind would pin a file that no longer holds anything to pin.
    yield* Config.save(settings, { token: undefined, mintedAt: undefined })
    return true
  }
  yield* Output.note(
    `HANDBILL_TOKEN is set, so that is the key that was revoked. ${settings.path} was left alone: unset the variable and run \`handbill logout\` again to give back a key stored there.`
  )
  return false
})

/**
 * `logout`: the key revokes itself server-side, then leaves the config file.
 * The revocation goes first, so a failure there cannot leave a live key nobody
 * holds — and only the key that was actually revoked is cleared, which is why
 * the environment's key and the file's are never conflated here.
 */
export const logout = Command.make(
  "logout",
  { endpoint: endpointFlag, json: jsonFlag },
  handler(({ endpoint, json }) =>
    Effect.gen(function* () {
      const settings = yield* Config.resolve({ endpoint })
      const current = yield* required(
        settings.token,
        () => new Config.MissingToken({ path: settings.path })
      )
      // Before the revocation, not after its answer: a hosted deployment
      // answers 204 for a key it has never seen, so an operator's token sent
      // here would come back "revoked" and take the config file with it.
      yield* Config.sendable(settings, current.value)
      // The deployment that minted it, not the one this run resolved — so
      // `logout` does not go through `pinned`, which is the rule for *using* a
      // key. `--endpoint` and HANDBILL_ENDPOINT cannot redirect a revocation:
      // the key goes home, or nowhere. Only a key from `HANDBILL_TOKEN` has no
      // provenance, and then the resolved endpoint is all there is to go on.
      const where = yield* Config.mintedEndpoint(settings, current.source)
      const revoked = yield* revokeKey(where, current.value).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () =>
          // A 404 has two readings, and the key's own shape says which. A key a
          // deployment minted is one this deployment has never heard of — the
          // endpoint has moved under the login — and the real key is still live
          // somewhere else, so nothing is cleared and the command fails. Only an
          // operator's own token reaching a 404 means what it says: this
          // deployment runs no accounts and there was never a key to give back.
          Config.isMintedKey(current.value)
            ? Effect.fail(new Output.WrongDeployment({ endpoint: where }))
            : Effect.as(
                Output.note(`${where} does not run accounts, so there was no key to revoke.`),
                false
              )
        )
      )
      const cleared = yield* clearLocal(settings, current.source)
      yield* json ? Output.json({ revoked, cleared, endpoint: where }) : Output.line(where)
    })
  )
).pipe(
  Command.withDescription(
    "Revoke the key this machine uses and remove it from the config file. Idempotent: a key that is already revoked is not an error."
  )
)

/**
 * `--web`: the key handed to the browser, in the fragment of the account page's
 * URL. A fragment is never sent to a server and the page takes it straight out
 * of the address bar, which is what keeps "no login on the site" true — but the
 * URL itself is the key for as long as it exists, which is why it is printed
 * with a warning and why the page lives on one known host rather than wherever
 * `--endpoint` points. That host is the built-in default, and nothing else: a
 * self-hosted deployment is an API with no site behind it.
 */
const accountPage = Effect.fn(function* (settings: Config.Settings) {
  if (!Config.sameEndpoint(settings.endpoint.value, Config.DEFAULT_ENDPOINT)) {
    return yield* Effect.fail(new Output.NoAccountPage({ endpoint: settings.endpoint.value }))
  }
  const { token } = yield* Config.credentials(settings)
  // The same two guards every command puts in front of a key it is about to
  // hand over: an operator's own token never goes to the hosted site, and a key
  // another deployment minted is not this site's to read an account with.
  yield* Config.sendable(settings, token)
  yield* Config.pinned(settings)
  return `${Config.DEFAULT_SITE}/account/#key=${encodeURIComponent(Redacted.value(token))}`
})

/**
 * `account`: who the key belongs to, what it may spend and what it has spent —
 * the "did my upgrade land?" command, since the tier a publish is charged at is
 * the one printed here. `--upgrade` asks the deployment for a checkout URL
 * instead: the session is created server-side with the owner taken from the
 * key, so a URL can only ever pay for the account that asked for it.
 */
export const account = Command.make(
  "account",
  { endpoint: endpointFlag, json: jsonFlag, open: openFlag, upgrade: upgradeFlag, web: webFlag },
  handler(({ endpoint, json, open, upgrade, web }) =>
    Effect.gen(function* () {
      if (web && upgrade) {
        return yield* Effect.fail(
          new Output.ConflictingModes({ first: "--web", second: "--upgrade" })
        )
      }
      // The URL is `--upgrade`'s and `--web`'s: reading an account prints no URL
      // at all, and a flag that silently does nothing reads as one that failed.
      // `--web` opens the page whether or not `--open` is there, so it takes it.
      if (open && !upgrade && !web) {
        return yield* Effect.fail(new Output.NothingToOpen({ command: "handbill account" }))
      }
      const settings = yield* Config.resolve({ endpoint })
      if (web) {
        const url = yield* accountPage(settings)
        // The one place printing the URL is the point rather than a leak: the
        // page is the destination, and a browser that will not start leaves the
        // user something to paste into one themselves.
        yield* json ? Output.json({ url }) : Output.line(url)
        yield* Output.note(
          "That URL carries your key. It is for your browser and nothing else — do not paste it into a chat, an issue or a bug report."
        )
        return yield* Effect.flatMap(Browser, (browser) => browser.open(url))
      }
      const client = yield* clientFor(settings)
      if (upgrade) {
        const { url } = yield* client.account.checkout({}).pipe(
          // Nothing about the account: the 404 is a deployment with nothing to
          // sell, which is its own sentence rather than the shared alias one.
          Effect.catchTag("NotFound", () =>
            Effect.fail(new Output.NoBilling({ endpoint: settings.endpoint.value }))
          )
        )
        yield* json ? Output.json({ url }) : Output.line(url)
        return yield* openIf(open, url)
      }
      const current = yield* client.account.read({})
      if (json) return yield* Output.json(current)
      yield* Output.line(`owner   ${current.owner}`)
      yield* Output.line(`tier    ${current.tier}`)
      // Counting nothing is not the same as having nothing left, so a
      // deployment that pays its own bill says so instead of printing a zero.
      if (current.limits === null) {
        return yield* Output.line("quotas are not counted on this deployment.")
      }
      yield* Output.line(
        `pages   ${current.usage.pagesToday} / ${current.limits.pagesPerDay} today`
      )
      yield* Output.line(
        `stored  ${current.usage.storedBytes} / ${current.limits.storedBytes} bytes`
      )
    })
  )
).pipe(
  Command.withDescription(
    "Show what the key in hand is: its owner, its tier, and the quotas it has spent today. --upgrade prints a checkout URL for the paid tier instead, and is the only form --open applies to; --web opens the same account in the browser, on the hosted site only."
  ),
  Command.withExamples([
    { command: "handbill account", description: "Owner, tier and quota usage" },
    {
      command: "handbill account --upgrade",
      description: "Print a checkout URL that pays for this account"
    },
    {
      command: "handbill account --upgrade --open",
      description: "The same, opened in the browser after it is printed"
    },
    {
      command: "handbill account --web",
      description: "Open the account page on handbill.dev with this key"
    }
  ])
)
