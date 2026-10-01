import {
  Authorization,
  CurrentOwner,
  CurrentTier,
  HandbillApi,
  type Hash,
  HashMismatch,
  NotFound,
  TooLarge
} from "@handbill/contract"
import { DateTime, Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { extractTitle, hashBytes } from "./hash"
import { AccountLive, AdminLive, BillingLive, KeysLive } from "./accounts"
import { Aliases } from "./aliases"
import { Auth, OPERATOR } from "./auth"
import { Config } from "./config"
import { Quotas } from "./quotas"
import { Index, Storage } from "./storage"

/**
 * `publishedAt` as the contract wants it. Objects written before the field
 * existed carry no timestamp and sort last rather than failing the listing.
 */
const publishedAt = (iso: string): DateTime.Utc =>
  Option.getOrElse(DateTime.make(iso), () => DateTime.makeUnsafe(0))

/** The public URL of a page or a name: the label is the whole hostname. */
export const pageUrl = (zone: string, label: string): string => `https://${label}.${zone}`

/**
 * Bearer auth for the `pages` group: the token goes through whichever `Auth`
 * layer is installed, and the handlers get the owner and the tier back — the
 * single place the two modes differ, and the only read of the key record.
 */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.map(Auth, (auth) => ({
    bearer: (httpEffect, { credential }) =>
      Effect.flatMap(auth.authorize(credential), ({ owner, tier }) =>
        Effect.provideService(httpEffect, CurrentOwner, owner).pipe(
          Effect.provideService(CurrentTier, tier)
        )
      )
  }))
)

/** `PUT /v1/pages/:hash`: the bytes must hash to the address the client claimed. */
const publish = (claimed: Hash, payload: Uint8Array) =>
  Effect.gen(function* () {
    const { maxBytes, zone } = yield* Config
    const storage = yield* Storage
    const owner = yield* CurrentOwner
    if (payload.length > maxBytes) return yield* Effect.fail(new TooLarge({ maxBytes }))
    const hash = yield* hashBytes(payload)
    if (hash !== claimed) return yield* Effect.fail(new HashMismatch({ expected: hash }))
    // Same bytes, same address: publishing twice stores nothing new, and a
    // collision leaves the first writer's `owner` alone (decision 05).
    const existing = yield* storage.head(hash)
    if (Option.isSome(existing)) return { hash, url: pageUrl(zone, hash), created: false }
    // Checked before the write, counted after it (§04's order), and after the
    // `head` above so a republish spends nothing.
    const quotas = yield* Quotas
    yield* quotas.check(owner, yield* CurrentTier, payload.length)
    const now = yield* DateTime.now
    const meta = {
      hash,
      owner,
      title: extractTitle(payload),
      publishedAt: DateTime.formatIso(now),
      size: payload.length
    }
    // Object first, then the index: a crash between them leaves a page that
    // is not listed until it is republished, never a listing with no page.
    yield* storage.put({ ...meta, body: payload })
    yield* (yield* Index).add(meta)
    yield* quotas.record(owner, payload.length)
    return { hash, url: pageUrl(zone, hash), created: true }
  })

/** Publish, list and unpublish — everything behind the token. */
export const PagesLive = HttpApiBuilder.group(HandbillApi, "pages", (handlers) =>
  handlers
    .handle("publish", ({ params, payload }) => publish(params.hash, payload))
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
    // Idempotent for a page that is not there (204), ownership-checked otherwise.
    // Ownership is read from R2 (`head`), never the index, so a crashed publish
    // that left an object with no entry is still removable by its owner.
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const owner = yield* CurrentOwner
        const existing = yield* storage.head(params.hash)
        if (Option.isSome(existing) && existing.value.owner !== owner) {
          return yield* Effect.fail(new NotFound())
        }
        const removed = yield* storage.remove(params.hash)
        yield* (yield* Index).remove(owner, params.hash)
        // The bytes go back at R2's own size for the object, and only to the request
        // that removed it: a second DELETE refunding again is free storage (#157).
        if (removed && Option.isSome(existing)) {
          yield* (yield* Quotas).release(owner, existing.value.size)
        }
      })
    )
)

/**
 * Living names. Whether the feature is on stays out of the handlers
 * (`AliasesDisabled` 404s every route); so does who may use it — this gate,
 * which decision 08 keeps operator-only. `list` needs none.
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
        // answers what the name points at now. Unset and no KV are the same 404.
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

/** The one endpoint that needs no token: what `handbill doctor` probes. */
export const MetaLive = HttpApiBuilder.group(HandbillApi, "meta", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function* () {
      const { build, version, zone } = yield* Config
      const auth = yield* Auth
      // A var the deploy did not set is absent from the body, never an empty string.
      const deploy = { ...(version ? { version } : {}), ...(build ? { build } : {}) }
      return { ok: true, mode: auth.mode, zone, ...deploy }
    })
  )
)

/** Every group's handlers, as the tuple `Layer.provide` wants; `makeApp` spreads it. */
export const Groups = [
  PagesLive,
  AliasesLive,
  KeysLive,
  AccountLive,
  AdminLive,
  BillingLive,
  MetaLive
] as const
