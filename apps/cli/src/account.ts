import { Effect, Option, Redacted } from "effect"
import { Command } from "effect/unstable/cli"
import { Browser } from "./browser"
import { clientFor, handler, openIf } from "./command-kit"
import * as Config from "./config"
import { endpointFlag, jsonFlag, openFlag, upgradeFlag, webFlag } from "./flags"
import * as Output from "./output"

/**
 * `account` reports what the key in hand is allowed to spend. `login` and
 * `logout`, the commands that mint and give back that key, are in keys.ts.
 */

/**
 * `--web`: the key handed to the browser, in the fragment of the account page's
 * URL. A fragment is never sent to a server and the page takes it straight out
 * of the address bar, which is what keeps "no login on the site" true — but the
 * URL itself is the key for as long as it exists, which is why it is printed
 * with a warning and why the site is derived from the endpoint rather than
 * taken from a flag. {@link Config.siteFor} is that derivation: the zone under
 * an `api.` label, so the hosted deployment and staging each open their own
 * site and anything else is refused — an endpoint with no site behind it has
 * nowhere to send the key.
 */
const openAccountPage = Effect.fn(function* (settings: Config.Settings, json: boolean) {
  const derived = Config.siteFor(settings.endpoint.value)
  if (Option.isNone(derived)) {
    return yield* Effect.fail(new Output.NoAccountPage({ endpoint: settings.endpoint.value }))
  }
  const { token } = yield* Config.credentials(settings)
  // The same two guards every command puts in front of a key it is about to
  // hand over: an operator's own token never goes to the hosted site, and a key
  // another deployment minted is not this site's to read an account with.
  yield* Config.sendable(settings, token)
  yield* Config.pinned(settings)
  const url = `${derived.value}/account/#key=${encodeURIComponent(Redacted.value(token))}`
  // The one place printing the URL is the point rather than a leak: the page is
  // the destination, and a browser that will not start leaves the user
  // something to paste into one themselves.
  yield* json ? Output.json({ url }) : Output.line(url)
  yield* Output.note(
    "That URL carries your key. It is for your browser and nothing else — do not paste it into a chat, an issue or a bug report."
  )
  return yield* Effect.flatMap(Browser, (browser) => browser.open(url))
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
      if (web) return yield* openAccountPage(settings, json)
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
    "Show what the key in hand is: its owner, its tier, and the quotas it has spent today. --upgrade prints a checkout URL for the paid tier instead, and is the only form --open applies to; --web opens the same account in the browser, on the site that belongs to the endpoint's zone."
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
      description: "Open the account page on the endpoint's site with this key"
    }
  ])
)
