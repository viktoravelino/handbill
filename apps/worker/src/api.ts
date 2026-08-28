import {
  Authorization,
  CurrentOwner,
  HandbillApi,
  HashMismatch,
  TooLarge
} from "@handbill/contract"
import { DateTime, Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { extractTitle, hashBytes } from "./hash"
import { Auth } from "./auth"
import { Config } from "./config"
import { Storage } from "./storage"

/**
 * `publishedAt` as the contract wants it. Objects written before the field
 * existed carry no timestamp and sort last rather than failing the listing.
 */
const publishedAt = (iso: string): DateTime.Utc =>
  Option.getOrElse(DateTime.make(iso), () => DateTime.makeUnsafe(0))

/** The public URL of a page: the hash is the hostname, so the link never changes under a reader. */
export const pageUrl = (zone: string, hash: string): string => `https://${hash}.${zone}`

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
