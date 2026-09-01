import { Effect, Option, Redacted, Result } from "effect"
import { Command } from "effect/unstable/cli"
import type { Key } from "@handbill/contract"
import { Browser } from "./browser"
import * as Client from "./client"
import { handler, required } from "./command-kit"
import * as Config from "./config"
import { endpointFlag, jsonFlag } from "./flags"
import { GitHubDevice, LoginFailed } from "./github"
import * as Output from "./output"

/**
 * The two commands that own the key in `~/.config/handbill/config.json`:
 * `login` mints one against a hosted deployment, `logout` gives it back. Both
 * say so plainly against a self-hosted deployment, which runs on one shared
 * `PUBLISH_TOKEN` and has no accounts to mint for.
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
    // writes down which one that was — unless it is the built-in default, which
    // stays unpinned so it can move. Spread rather than `undefined`, which
    // would remove the field instead.
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
    onSome: (previous) =>
      previous.source === "file" && Config.isMintedKey(previous.value)
        ? Effect.ignore(revokeKey(settings.endpoint.value, previous.value))
        : Effect.void
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
    yield* Config.save(settings, { token: undefined })
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
      const revoked = yield* revokeKey(settings.endpoint.value, current.value).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () =>
          // A 404 has two readings, and the key's own shape says which. A key a
          // deployment minted is one this deployment has never heard of — the
          // endpoint has moved under the login — and the real key is still live
          // somewhere else, so nothing is cleared and the command fails. Only an
          // operator's own token reaching a 404 means what it says: this
          // deployment runs no accounts and there was never a key to give back.
          Config.isMintedKey(current.value)
            ? Effect.fail(new Output.WrongDeployment({ endpoint: settings.endpoint.value }))
            : Effect.as(
                Output.note(
                  `${settings.endpoint.value} does not run accounts, so there was no key to revoke.`
                ),
                false
              )
        )
      )
      const cleared = yield* clearLocal(settings, current.source)
      yield* json
        ? Output.json({ revoked, cleared, endpoint: settings.endpoint.value })
        : Output.line(settings.endpoint.value)
    })
  )
).pipe(
  Command.withDescription(
    "Revoke the key this machine uses and remove it from the config file. Idempotent: a key that is already revoked is not an error."
  )
)
