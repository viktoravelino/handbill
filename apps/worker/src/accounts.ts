import {
  AlreadyPaid,
  CurrentOwner,
  CurrentTier,
  HandbillApi,
  NotFound,
  TooLarge,
  Unauthorized,
  WEBHOOK_MAX_BYTES
} from "@handbill/contract"
import { DateTime, Effect, Option, Redacted } from "effect"
import { Headers, HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth, OPERATOR, secretEquals } from "./auth"
import { Billing, readFlip, verifySignature } from "./billing"
import { Config } from "./config"
import { Quotas } from "./quotas"
import { Index, Storage } from "./storage"

// The account side of the API — keys, account, the webhook that moves a tier, and
// the operator's routes — split from `api.ts`, whose `Groups` still collects them.

/**
 * The bearer token exactly as presented. `revoke` acts on the key itself and is
 * off the authorize middleware, so it reads the header rather than `CurrentOwner`.
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
 * which layer is on, and WAF rule 1 is what bounds the checkout's outbound call.
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
 * a published link; the owner comes from R2, so the freed bytes land on whoever
 * published it. `tier` writes the webhook's own field, stamped `now` (#143).
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
