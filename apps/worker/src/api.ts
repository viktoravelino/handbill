import {
  AlreadyPaid,
  Authorization,
  CurrentOwner,
  CurrentTier,
  HandbillApi,
  HashMismatch,
  NotFound,
  TooLarge,
  Unauthorized,
  WEBHOOK_MAX_BYTES
} from "@handbill/contract"
import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { Headers, HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { extractTitle, hashBytes } from "./hash"
import { Aliases } from "./aliases"
import { Auth, OPERATOR, secretEquals } from "./auth"
import { Billing, readFlip, verifySignature } from "./billing"
import { Config } from "./config"
import { Quotas } from "./quotas"
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
 * Bearer auth for the `pages` group: it resolves the token through whichever
 * `Auth` layer is installed and hands the handlers the owner and the tier — the
 * single place the two modes differ, and the only read of the key record (§11).
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
        // Checked before the write, counted after it (§04's order): a spent quota
        // costs no R2 write beyond the `head` above, which has to run first so a
        // republish spends nothing, and a crash between the two undercounts
        // rather than charging for a page that is not there.
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
        // Object first, then the index: the bucket is the source of truth, so a
        // crash after the object write leaves a page that simply is not listed
        // until it is republished — never a listed page that is not there.
        yield* storage.put({ ...meta, body: payload })
        yield* (yield* Index).add(meta)
        yield* quotas.record(owner, payload.length)
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
    // Idempotent for a page that is not there (204), but ownership-checked: a
    // hash owned by someone else answers 404, deletes nothing, and never 403 —
    // decision 05's bar is that a non-owner learns no *ownership*. Ownership is
    // read from R2 (`head`), never the index, so a crashed publish that left an
    // object with no entry is still removable by its owner.
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
 * Living names. Two things stay out of the handlers: whether the feature is on
 * (`AliasesDisabled` fails every route with `NotFound`) and who may use it —
 * this gate, which decision 08 keeps operator-only. `list` needs none.
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
 * The bearer token exactly as presented. `revoke` acts on the key itself, not the
 * owner behind it, and is off the authorize middleware so a revoked key can still
 * reach it — hence reading the header rather than taking a `CurrentOwner`.
 */
const presentedKey = (headers: Headers.Headers): Redacted.Redacted =>
  Redacted.make(
    Option.getOrElse(Headers.get(headers, "authorization"), () => "").replace(/^bearer\s+/iu, "")
  )

/**
 * Keys. Nothing here asks whether accounts are on: `AuthSecret` fails `mint` and
 * `revoke` with `NotFound`, the way a missing KV binding 404s the alias routes.
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

/**
 * The caller's own account. `limits` comes from `Quotas`, so neither handler asks
 * which layer is on, and the one outbound call the checkout makes is bounded by
 * WAF rule 1 (2 writes / 10 s per IP on api.handbill.dev): nobody can spend the
 * Polar rate limit from here.
 */
export const AccountLive = HttpApiBuilder.group(HandbillApi, "account", (handlers) =>
  handlers
    .handle("read", () =>
      Effect.gen(function* () {
        const owner = yield* CurrentOwner
        const tier = yield* CurrentTier
        const quotas = yield* Quotas
        return { owner, tier, usage: yield* quotas.usage(owner), limits: quotas.limits(tier) }
      })
    )
    .handle("checkout", () =>
      Effect.gen(function* () {
        const owner = yield* CurrentOwner
        if (owner === OPERATOR) return yield* Effect.fail(new NotFound())
        if ((yield* CurrentTier) === "paid") return yield* Effect.fail(new AlreadyPaid())
        return yield* (yield* Billing).checkout(owner)
      })
    )
)

/**
 * The gate on every admin route: `ADMIN_TOKEN`, not `CurrentOwner` — a hosted
 * deployment's operator is not one of its accounts, so nothing here touches
 * `Auth`. No secret (unset or empty) is a 404, no operator surface; wrong, 401.
 */
const adminOnly = Effect.gen(function* () {
  const { adminToken } = yield* Config
  const request = yield* HttpServerRequest.HttpServerRequest
  if (adminToken === undefined || adminToken === "") return yield* Effect.fail(new NotFound())
  const presented = Redacted.value(presentedKey(request.headers))
  if (!secretEquals(adminToken, presented)) return yield* Effect.fail(new Unauthorized())
})

/**
 * The operator's two routes. `takedown` is the only thing in the API that can kill
 * a published link: the owner comes from R2, so the freed bytes land on whoever
 * published it, idempotently and with no tombstone (§07). `tier` writes the field
 * the webhook does, stamped `now` so no retried delivery can undo it (#143).
 */
export const AdminLive = HttpApiBuilder.group(HandbillApi, "admin", (handlers) =>
  handlers
    .handle("takedown", ({ params }) =>
      Effect.gen(function* () {
        yield* adminOnly
        const storage = yield* Storage
        const existing = yield* storage.head(params.hash)
        if (Option.isNone(existing)) return
        const { owner, size } = existing.value
        const removed = yield* storage.remove(params.hash)
        yield* (yield* Index).remove(owner, params.hash)
        if (removed) yield* (yield* Quotas).release(owner, size)
      })
    )
    .handle("tier", ({ params: { owner }, payload }) =>
      Effect.flatMap(Effect.andThen(adminOnly, Effect.all([Auth, DateTime.now])), ([auth, now]) =>
        Effect.asVoid(auth.setTier(owner, payload.tier, DateTime.formatIso(now)))
      )
    )
)

/**
 * The webhook wiring: the contract spells out the answers, `billing.ts` verifies
 * and reads, and this decides between them. Logs carry the decision, not the body.
 */
export const BillingLive = HttpApiBuilder.group(HandbillApi, "billing", (handlers) =>
  handlers.handle("webhook", ({ headers, payload }) =>
    Effect.gen(function* () {
      const secret = (yield* Config).webhookSecret
      if (secret === undefined || secret === "") return yield* Effect.fail(new NotFound())
      const maxBytes = WEBHOOK_MAX_BYTES
      if (payload.length > maxBytes) return yield* Effect.fail(new TooLarge({ maxBytes }))
      const verified = yield* verifySignature(secret, headers, payload)
      if (!verified) return yield* Effect.fail(new Unauthorized())
      const flip = readFlip(payload)
      if (Option.isNone(flip)) return yield* Effect.log(`billing: no-op ${headers["webhook-id"]}`)
      const { at, owner, subscriptionId, tier } = flip.value
      const moved = yield* (yield* Auth).setTier(owner, tier, at, subscriptionId)
      yield* Effect.log(`billing: ${subscriptionId} moved ${moved} keys of ${owner} to ${tier}`)
    })
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
