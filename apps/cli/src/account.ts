import { Effect, Option, Redacted } from "effect"
import { Command } from "effect/unstable/cli"
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
      const minted = yield* client.keys
        .mint({ payload: { githubToken: Redacted.value(githubToken) } })
        .pipe(
          Effect.catchTags({
            // Accounts were on a moment ago, so this is the endpoint changing
            // under the login rather than the self-hosted 404 checked above.
            NotFound: () =>
              Effect.fail(new Output.NoAccounts({ endpoint: settings.endpoint.value })),
            // The Worker asked GitHub who the token belongs to and GitHub said
            // nobody — the flow above succeeded, so this is not a token to retry.
            Unauthorized: () =>
              Effect.fail(
                new LoginFailed({ reason: "the endpoint did not accept the GitHub account" })
              )
          })
        )
      yield* Config.save(settings, {
        token: minted.key,
        // A key is only good against the deployment that minted it, so `login`
        // writes down which one that was — unless it is the built-in default,
        // which stays unpinned so it can move. Spread rather than `undefined`,
        // which would remove the field instead.
        ...(settings.endpoint.source === "default" ? {} : { endpoint: settings.endpoint.value })
      }).pipe(
        // Minting is the one moment the key exists in readable form: a file
        // that cannot be written must not swallow it, or the account is left
        // holding a live key nobody has.
        Effect.tapError(() =>
          Output.note(`The key was minted but not stored — keep it: ${minted.key}`)
        )
      )
      yield* Output.note(`Signed in to ${settings.endpoint.value}. The key is in ${settings.path}.`)
      // The file is not where the CLI will read a key from next: the
      // environment beats it, and the new key would never be used.
      if (Option.isSome(settings.token) && settings.token.value.source === "env") {
        yield* Output.note(
          "HANDBILL_TOKEN is set and wins over the file: unset it to use this key."
        )
      }
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
 * `logout`: the key revokes itself server-side, then leaves the config file.
 * The revocation goes first, so a failure there does not leave a live key
 * nobody holds any more; an endpoint with no accounts answers 404, and the
 * local key still goes.
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
      const client = yield* Client.selfAuthorizing({
        endpoint: settings.endpoint.value,
        token: current.value
      })
      const revoked = yield* client.keys.revoke({}).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () =>
          Effect.as(
            Output.note(
              `${settings.endpoint.value} does not run accounts, so there was no key to revoke.`
            ),
            false
          )
        )
      )
      yield* Config.save(settings, { token: undefined })
      // The revoked key was the environment's, so the file is not where it
      // lives and removing it there finishes nothing.
      if (current.source === "env") {
        yield* Output.note("HANDBILL_TOKEN is still set: unset it to finish signing out.")
      }
      yield* json ? Output.json({ revoked, path: settings.path }) : Output.line(settings.path)
    })
  )
).pipe(
  Command.withDescription(
    "Revoke the key this machine uses and remove it from the config file. Idempotent: a key that is already revoked is not an error."
  )
)
