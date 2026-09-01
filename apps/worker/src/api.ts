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
import { Auth } from "./auth"
import { Config } from "./config"
import { Storage } from "./storage"

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
        // reports the URL that already exists.
        const existing = yield* storage.head(hash)
        if (Option.isSome(existing)) return { hash, url: pageUrl(zone, hash), created: false }
        const now = yield* DateTime.now
        yield* storage.put({
          hash,
          owner,
          title: extractTitle(payload),
          publishedAt: DateTime.formatIso(now),
          size: payload.length,
          body: payload
        })
        return { hash, url: pageUrl(zone, hash), created: true }
      })
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const { zone } = yield* Config
        const storage = yield* Storage
        const owner = yield* CurrentOwner
        const stored = yield* storage.list(owner)
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
    // Idempotent by design: 204 whether or not the page was there.
    .handle("remove", ({ params }) =>
      Effect.flatMap(Storage, (storage) => storage.remove(params.hash))
    )
)

/**
 * Living names. Nothing here checks whether aliases are enabled: `AliasesDisabled`
 * fails these three with `NotFound`, so a deployment without a KV binding serves
 * a 404 on every route in the group.
 */
export const AliasesLive = HttpApiBuilder.group(HandbillApi, "aliases", (handlers) =>
  handlers
    .handle("set", ({ params, payload }) =>
      Effect.gen(function* () {
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
      Effect.flatMap(Aliases, (aliases) => aliases.remove(params.name))
    )
)

/**
 * The bearer token exactly as presented. `revoke` acts on the key itself, not on
 * the owner behind it, so it reads back the header the middleware has already
 * accepted rather than carrying a second identity through the contract.
 */
const presentedKey = (headers: Headers.Headers): Redacted.Redacted =>
  Redacted.make(
    Option.getOrElse(Headers.get(headers, "authorization"), () => "").replace(/^bearer\s+/iu, "")
  )

/**
 * Keys. Nothing here asks whether accounts are on either: `AuthSecret` fails
 * both with `NotFound`, so a deployment on one shared token 404s these two the
 * way it 404s the alias routes when there is no KV binding.
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
