import {
  Authorization,
  CurrentOwner,
  HandbillApi,
  HashMismatch,
  NotFound,
  TooLarge
} from "@handbill/contract"
import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { Headers, HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { extractTitle, hashBytes } from "./hash"
import { Aliases } from "./aliases"
import { Auth, OPERATOR } from "./auth"
import { Config } from "./config"
import { Index, Storage } from "./storage"

/**
 * `publishedAt` as the contract wants it. Objects written before the field
 * existed carry no timestamp and sort last rather than failing the listing.
 */
const publishedAt = (iso: string): DateTime.Utc =>
  Option.getOrElse(DateTime.make(iso), () => DateTime.makeUnsafe(0))

/**
 * The public URL of a page: the label is the whole hostname, so a hash link
 * never changes under a reader and an alias link changes only its contents.
 */
export const pageUrl = (zone: string, label: string): string => `https://${label}.${zone}`

/**
 * Bearer auth for the `pages` group. It resolves the token through whichever
 * `Auth` layer is installed and provides the resulting `CurrentOwner` to the
 * handlers, which is the single place `secret` and `accounts` mode differ.
 */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.map(Auth, (auth) => ({
    bearer: (httpEffect, { credential }) =>
      Effect.flatMap(auth.authorize(credential), (owner) =>
        Effect.provideService(httpEffect, CurrentOwner, owner)
      )
  }))
)

/** Publish, list and unpublish — everything behind the token. */
export const PagesLive = HttpApiBuilder.group(HandbillApi, "pages", (handlers) =>
  handlers
    .handle("publish", ({ params, payload }) =>
      Effect.gen(function* () {
        const { maxBytes, zone } = yield* Config
        const storage = yield* Storage
        const owner = yield* CurrentOwner
        if (payload.length > maxBytes) return yield* Effect.fail(new TooLarge({ maxBytes }))
        const hash = yield* hashBytes(payload)
        if (hash !== params.hash) return yield* Effect.fail(new HashMismatch({ expected: hash }))
        // Same bytes, same address: publishing twice stores nothing new and
        // reports the URL that already exists. On a hash collision this is the
        // second publisher — they get the same public URL but no index entry and
        // no ownership: the first writer keeps `owner` (architecture decision 05).
        const existing = yield* storage.head(hash)
        if (Option.isSome(existing)) return { hash, url: pageUrl(zone, hash), created: false }
        const now = yield* DateTime.now
        const meta = {
          hash,
          owner,
          title: extractTitle(payload),
          publishedAt: DateTime.formatIso(now),
          size: payload.length
        }
        // Object first, then the index: the bucket is the source of truth, so a
        // crash after the object write leaves a page that simply is not listed
        // until it is republished — never a listed page that is not there.
        yield* storage.put({ ...meta, body: payload })
        yield* (yield* Index).add(meta)
        return { hash, url: pageUrl(zone, hash), created: true }
      })
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const { zone } = yield* Config
        const owner = yield* CurrentOwner
        const stored = yield* (yield* Index).list(owner)
        return {
          pages: stored.map((page) => ({
            hash: page.hash,
            url: pageUrl(zone, page.hash),
            title: page.title,
            publishedAt: publishedAt(page.publishedAt),
            size: page.size
          }))
        }
      })
    )
    // Idempotent for a page that is not there (204), but ownership-checked:
    // a hash owned by someone else answers 404, deletes nothing, and never 403.
    // Decision 05's bar is that a non-owner learns no *ownership* — 404 is the
    // "not yours" answer, not a "forbidden" that would confirm another account
    // holds it. (Existence itself is already public: the page serves 200 on its
    // hash host to anyone with the hash.) Ownership is read from R2 (`head`),
    // never the index, so a crashed publish that left an object with no entry is
    // still removable by its owner.
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const owner = yield* CurrentOwner
        const existing = yield* storage.head(params.hash)
        if (Option.isSome(existing) && existing.value.owner !== owner) {
          return yield* Effect.fail(new NotFound())
        }
        yield* storage.remove(params.hash)
        yield* (yield* Index).remove(owner, params.hash)
      })
    )
)

/**
 * Living names. Two things stay out of the handlers: whether the feature is on
 * (`AliasesDisabled` fails every route with `NotFound`, so no KV binding is a
 * 404 without anyone asking) and who may use it — `operatorOnly` below.
 *
 * Decision 08: aliases stay operator-only in 0.3. `OPERATOR` is the one owner a
 * self-hosted deployment issues and the one `AuthAccounts` never does, so this
 * gate is a no-op in secret mode and shuts the whole writable/readable alias
 * surface to hosted keys in accounts mode — with the same `NotFound` an absent
 * binding gives, so a hosted caller cannot even tell a name exists. Enforcing
 * decision 08 in code was a gap the #111 review caught: any key could set or
 * remove names and read another owner's hash by name. `list` needs no gate — it
 * is already filtered to the caller's own owner, which is empty for a hosted
 * key.
 */
const operatorOnly = Effect.flatMap(CurrentOwner, (owner) =>
  owner === OPERATOR ? Effect.void : Effect.fail(new NotFound())
)

export const AliasesLive = HttpApiBuilder.group(HandbillApi, "aliases", (handlers) =>
  handlers
    .handle("set", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* operatorOnly
        const { zone } = yield* Config
        const aliases = yield* Aliases
        const owner = yield* CurrentOwner
        yield* aliases.set(params.name, payload.hash, owner)
        return { name: params.name, hash: payload.hash, url: pageUrl(zone, params.name) }
      })
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const { zone } = yield* Config
        const aliases = yield* Aliases
        const owner = yield* CurrentOwner
        const stored = yield* aliases.list(owner)
        return {
          aliases: stored.map(({ hash, name }) => ({ name, hash, url: pageUrl(zone, name) }))
        }
      })
    )
    .handle("read", ({ params }) =>
      Effect.gen(function* () {
        yield* operatorOnly
        const { zone } = yield* Config
        const aliases = yield* Aliases
        // `resolve` is the page path's own lookup — one read by key, so this
        // answers what the name points at now rather than what the listing has
        // caught up with. Unset and no-KV-binding are the same 404.
        const hash = yield* aliases.resolve(params.name)
        if (Option.isNone(hash)) return yield* Effect.fail(new NotFound())
        return { name: params.name, hash: hash.value, url: pageUrl(zone, params.name) }
      })
    )
    .handle("remove", ({ params }) =>
      Effect.andThen(
        operatorOnly,
        Effect.flatMap(Aliases, (aliases) => aliases.remove(params.name))
      )
    )
)

/**
 * The bearer token exactly as presented. `revoke` acts on the key itself, not on
 * the owner behind it, and is off the authorize middleware (so a revoked key can
 * still reach it), so it reads the `Authorization` header straight rather than
 * taking a `CurrentOwner` the middleware would have resolved.
 */
const presentedKey = (headers: Headers.Headers): Redacted.Redacted =>
  Redacted.make(
    Option.getOrElse(Headers.get(headers, "authorization"), () => "").replace(/^bearer\s+/iu, "")
  )

/**
 * Keys. Nothing here asks whether accounts are on: `AuthSecret` fails both `mint`
 * and `revoke` with `NotFound`, so a deployment on one shared token 404s these
 * two the way it 404s the alias routes when there is no KV binding.
 */
export const KeysLive = HttpApiBuilder.group(HandbillApi, "keys", (handlers) =>
  handlers
    .handle("mint", ({ payload }) => Effect.flatMap(Auth, (auth) => auth.mint(payload.githubToken)))
    .handle("revoke", () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* auth.revoke(presentedKey(request.headers))
      })
    )
)

/** The one endpoint that needs no token: what `handbill doctor` probes. */
export const MetaLive = HttpApiBuilder.group(HandbillApi, "meta", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function* () {
      const { zone } = yield* Config
      const auth = yield* Auth
      return { ok: true, mode: auth.mode, zone }
    })
  )
)
