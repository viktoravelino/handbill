import { Data, Effect, Option, Redacted } from "effect"
import type { Settings, Source } from "./config"

/**
 * Where a credential may go. `resolve` in config.ts works out which
 * endpoint and which token a run has; the rules here decide whether that token
 * may be sent there — plain HTTP, an endpoint nobody named, a deployment that
 * did not mint the key — and where a key goes home to. config.ts re-exports all
 * of it, so callers reach it as `Config.<name>`.
 */

/**
 * The site that belongs to an endpoint — the zone under its `api.` label, which
 * is where the account page lives. `https://api.handbill.dev` is
 * `https://handbill.dev` and `https://api.handbill-staging.dev` is the staging
 * site, so the page is not pinned to one host and staging can be read the same
 * way. `None` for any other shape: an endpoint that is not `api.<zone>` is an
 * API with no site behind it, and a key is never handed to a guess. HTTPS only
 * — the URL carries the key, so loopback is not an exception here.
 */
export const siteFor = (endpoint: string): Option.Option<string> => {
  if (!URL.canParse(endpoint)) return Option.none()
  const { hostname, protocol } = new URL(endpoint)
  const zone = hostname.toLowerCase().replace(/^api\./u, "")
  return protocol === "https:" && zone !== hostname.toLowerCase() && zone.includes(".")
    ? Option.some(`https://${zone}`)
    : Option.none()
}

/**
 * A token that no deployment minted, and no endpoint to send it to but the
 * built-in default. Raised by {@link sendable} before any request, so an
 * operator's shared secret never reaches a host they did not name.
 */
export class UnnamedEndpoint extends Data.TaggedError("UnnamedEndpoint")<{
  readonly endpoint: string
}> {}

/**
 * The stored key was minted somewhere else. Raised by {@link sendable} before
 * any request: a key is only good against the deployment that issued it, so
 * pointing the CLI at another one is "log in there", never "reuse this key".
 */
export class WrongEndpoint extends Data.TaggedError("WrongEndpoint")<{
  readonly endpoint: string
  readonly mintedAt: string
  readonly path: string
}> {}

/**
 * An endpoint that would carry a credential over plain HTTP. `wrangler dev`
 * serves on loopback and is the only exception, because nothing there leaves
 * the machine.
 */
export class InsecureEndpoint extends Data.TaggedError("InsecureEndpoint")<{
  readonly endpoint: string
}> {}

/**
 * The prefix a handbill deployment puts on every key it mints — the Worker's
 * own, there so a leaked key is greppable. See {@link isMintedKey}.
 */
export const KEY_PREFIX = "hb_"

/**
 * The same deployment, however it was spelled: a trailing slash and the case of
 * the host are not a different host. Comparing the strings raw would refuse a
 * key over `https://api.example.dev/` against `https://api.example.dev`.
 */
const normalise = (url: string) => url.trim().replace(/\/+$/u, "").toLowerCase()

/** Whether two spellings name one deployment; what `pinned` and `account --web` both ask. */
export const sameEndpoint = (left: string, right: string): boolean =>
  normalise(left) === normalise(right)

/**
 * Loopback, where `wrangler dev` runs. The only hosts a credential may reach
 * over plain HTTP, because the request never leaves the machine.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1"])

/**
 * Every endpoint the CLI will talk to has to be `https:` — a bearer key is
 * attached to all but two routes, and `--endpoint http://…` would otherwise
 * hand it to anything on the path. Checked in `resolve` rather than at the
 * call sites, so `login` — which posts a GitHub access token before any key
 * exists — is covered by the same rule.
 */
export const secure = (endpoint: string) => {
  // Not a URL at all is the HTTP client's to report, with the message it has:
  // failing it here would only say the same thing less well.
  if (!URL.canParse(endpoint)) return Effect.void
  const { hostname, protocol } = new URL(endpoint)
  return protocol === "https:" || (protocol === "http:" && LOOPBACK.has(hostname))
    ? Effect.void
    : Effect.fail(new InsecureEndpoint({ endpoint }))
}

/**
 * Keys a handbill deployment mints start with `hb_` — the Worker's own prefix,
 * there so a leaked key is greppable. A self-hosted `PUBLISH_TOKEN` is an
 * operator-chosen string, so the prefix is the one thing that tells "a key this
 * CLI was given by a deployment" from "the operator's shared secret" without
 * asking anyone. It is a heuristic — an operator may choose a `PUBLISH_TOKEN`
 * starting with `hb_`, and then it is treated as a key — and the two places it
 * is used both fail safe: {@link Settings} still resolves, and the caller only
 * ever declines to send the token somewhere it was not told to.
 */
export const isMintedKey = (token: Redacted.Redacted<string>): boolean =>
  Redacted.value(token).startsWith(KEY_PREFIX)

/**
 * The one rule about where a credential may go, in the one place that states
 * it: a token no deployment minted is not sent to an endpoint nobody named.
 * That pairing — an operator's `PUBLISH_TOKEN` and a `handbill` that fell back
 * to `DEFAULT_ENDPOINT` — is the only case where a secret would reach a host
 * the user did not choose, and it is worth a failure rather than a warning. A
 * minted key takes the default in silence, which is what lets
 * `HANDBILL_TOKEN=hb_… handbill plan.html` work with nothing configured.
 *
 * Every path that puts a token on the wire goes through this: `connect` for the
 * publishing commands, `logout` before it revokes, and `doctor` inverted into a
 * check. It lives here rather than at those three call sites because the first
 * time the rule was written it was written once — and `logout` and `doctor`
 * quietly went on leaking.
 */
export const sendable = (settings: Settings, token: Redacted.Redacted<string>) =>
  settings.endpoint.source === "default" && !isMintedKey(token)
    ? Effect.fail(new UnnamedEndpoint({ endpoint: settings.endpoint.value }))
    : Effect.void

/**
 * The endpoint pin, and the reason `mintedAt` is written at all: the key in the
 * config file goes to the deployment that issued it and nowhere else. A
 * `--endpoint` that names another one means "log in there", never "reuse this
 * key" — the old key would otherwise be disclosed to a host that never minted
 * it, and answer 204 or 404 in a way that says nothing.
 *
 * A token from `HANDBILL_TOKEN` is the escape hatch: it was handed to this run
 * deliberately, and the file's provenance says nothing about it. So is a machine
 * with no key in the file at all.
 */
export const pinned = (settings: Settings): Effect.Effect<void, WrongEndpoint> => {
  if (Option.isNone(settings.token) || settings.token.value.source !== "file") return Effect.void
  return Option.isSome(settings.mintedAt) &&
    !sameEndpoint(settings.mintedAt.value, settings.endpoint.value)
    ? Effect.fail(
        new WrongEndpoint({
          endpoint: settings.endpoint.value,
          mintedAt: settings.mintedAt.value,
          path: settings.path
        })
      )
    : Effect.void
}

/**
 * Where a command that acts on the key itself — `logout`, and `login` giving
 * back the key it replaces — has to send it: the deployment that minted it, not
 * the one this run resolved. Those two commands are about the key rather than
 * about publishing with it, so they follow it home instead of stopping at
 * {@link pinned}, and `--endpoint` cannot redirect a revocation.
 */
export const mintedEndpoint = (
  settings: Settings,
  source: Source
): Effect.Effect<string, InsecureEndpoint> => {
  const where =
    source === "file"
      ? Option.getOrElse(settings.mintedAt, () => settings.endpoint.value)
      : settings.endpoint.value
  // `resolve` vouches for the endpoint it resolved, not for this one: `mintedAt`
  // is a line in a file a hand can edit, and it is about to receive a live key.
  return Effect.as(secure(where), where)
}
