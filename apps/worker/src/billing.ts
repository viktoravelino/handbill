import { Checkout, NotFound, Owner, type Tier } from "@handbill/contract"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { secretEquals } from "./auth"

const utf8 = new TextEncoder()
const text = new TextDecoder()

/**
 * Standard Webhooks verification on WebCrypto, which saves pulling Polar's SDK
 * into the Worker: HMAC-SHA256 over `<id>.<timestamp>.<body>` — hence the raw
 * body — against any `v1,<base64>` in `webhook-signature`, two on a rotation.
 *
 * KEY DERIVATION — do not "fix" this to a single rule. Polar hands the library
 * the secret itself for a Standard Webhooks one and a base64 *encoding* of the
 * string for a legacy one (`server/polar/webhook/tasks.py`, the
 * `uses_standard_webhook_signature` branch), which the library then strips of
 * `whsec_` and base64-decodes. So `whsec_<b64>` keys on the decoded suffix and
 * anything else on the string's UTF-8 bytes; a real delivery proved it (#137).
 */
export const verifySignature = (
  secret: string,
  headers: Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>,
  body: Uint8Array
): Effect.Effect<boolean> =>
  Effect.flatMap(DateTime.now, (clock) => {
    const { "webhook-id": id, "webhook-signature": sigs, "webhook-timestamp": ts } = headers
    // Standard Webhooks' window, before any HMAC: a verified signature five
    // minutes old is still a replay, and a timestamp that is not one is `NaN`.
    const skew = DateTime.toEpochMillis(clock) / 1000 - Number(ts)
    if (!Number.isFinite(skew) || Math.abs(skew) > 300) return Effect.succeed(false)
    return Effect.promise(async () => {
      const hmac = { name: "HMAC", hash: "SHA-256" }
      const raw = secret.startsWith("whsec_")
        ? Uint8Array.from(atob(secret.slice(6)), (c) => c.codePointAt(0) ?? 0)
        : utf8.encode(secret)
      const key = await crypto.subtle.importKey("raw", raw, hmac, false, ["sign"])
      const content = utf8.encode(`${id}.${ts}.${text.decode(body)}`)
      const mac = await crypto.subtle.sign("HMAC", key, content)
      const expected = btoa(String.fromCodePoint(...new Uint8Array(mac)))
      return sigs.split(" ").some((v) => v.startsWith("v1,") && secretEquals(v.slice(3), expected))
    })
  })

/** The Polar fields this Worker reads, decoded as an `Option`: an unnamed field cannot break a delivery, and a body that is not JSON is a miss rather than a throw. */
const SubscriptionEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    ended_at: Schema.optional(Schema.NullishOr(Schema.String)),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    customer: Schema.optional(Schema.Struct({ external_id: Schema.NullishOr(Schema.String) }))
  })
})
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SubscriptionEvent))

/** `gh:<numeric id>` is the only owner `AuthAccounts` issues; `self` and the rest are not. */
const asOwner = (id: unknown): Option.Option<Owner> =>
  typeof id === "string" && /^gh:\d+$/u.test(id) ? Option.some(Owner.make(id)) : Option.none()

/**
 * Status, never event name: writing the state an event carries rather than a step
 * in a sequence is what makes a replay idempotent. Only a verdict is here, and a
 * free one not final alone: Polar sets `canceled` on request, `ended_at` on end.
 */
const TIER_FOR: Record<string, Tier> = {
  active: "paid",
  trialing: "paid",
  canceled: "free",
  revoked: "free",
  incomplete_expired: "free"
}

/**
 * The tier flip a verified body asks for, or `None` when there is nothing to do
 * — not a subscription event, not decodable, a status or pending cancellation
 * that decides nothing, an owner it cannot name — all 202, none different on a
 * retry. Owner: `metadata.owner` from checkout (0.4 §03), else `external_id`.
 * Accepted: Polar promises no order, so a stale `active` re-pays.
 */
export const readFlip = (body: Uint8Array) =>
  Option.flatMap(decodeEvent(text.decode(body)), ({ data, type }) => {
    const { customer, ended_at: ended, id, metadata, status } = data
    const tier = TIER_FOR[status]
    if (!type.startsWith("subscription.") || tier === undefined) return Option.none()
    if (tier === "free" && (ended === undefined || ended === null)) return Option.none()
    const named = Option.orElse(asOwner(metadata?.["owner"]), () => asOwner(customer?.external_id))
    return Option.map(named, (owner) => ({ owner, tier, subscriptionId: id }))
  })

/** Where an owner goes to pay, when the deployment sells anything at all. */
export class Billing extends Context.Service<
  Billing,
  { readonly checkout: (owner: Owner) => Effect.Effect<Checkout, NotFound> }
>()("handbill/Billing") {}

/** Nothing to sell: the checkout route 404s the way the alias routes do with no KV binding. */
export const BillingDisabled: Layer.Layer<Billing> = Layer.succeed(Billing, {
  checkout: () => Effect.fail(new NotFound())
})

const isSession = Schema.is(Checkout)

/**
 * A checkout session per request, with both owner fields written: `metadata` is
 * what `readFlip` reads back, and `external_customer_id` files it under one
 * Polar customer per owner, which makes that fallback real. Failure honesty as
 * on `githubOwner`: anything but a session throws, so the route 500s instead.
 */
export const BillingPolar = (config: {
  readonly api: string
  readonly token: string
  readonly productId: string
}): Layer.Layer<Billing> =>
  Layer.succeed(Billing, {
    checkout: (owner) =>
      Effect.promise(async () => {
        // The trailing slash is load-bearing: Polar 307s without it, and the
        // redirected POST arrives with no body.
        const response = await fetch(`${config.api}/v1/checkouts/`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            products: [config.productId],
            metadata: { owner },
            external_customer_id: owner
          })
        })
        const session: unknown = response.ok ? await response.json() : null
        if (!isSession(session)) throw new Error(`polar checkout failed: ${response.status}`)
        return session
      })
  })
