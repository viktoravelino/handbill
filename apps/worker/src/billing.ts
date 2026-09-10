import { Owner, type Tier } from "@handbill/contract"
import { DateTime, Effect, Option, Schema } from "effect"
import { secretEquals } from "./auth"

const utf8 = new TextEncoder()
const text = new TextDecoder()

/**
 * Standard Webhooks verification on WebCrypto, which saves pulling Polar's SDK
 * into the Worker: HMAC-SHA256 over `<id>.<timestamp>.<body>` — hence the raw
 * body — matched against any `v1,<base64>` entry in the space-separated
 * `webhook-signature`, of which a rotation sends two.
 *
 * KEY DERIVATION — do not "fix" this. A Polar secret reads `whsec_<base64>`,
 * which looks strippable and decodable and is neither: `validateEvent` in
 * `@polar-sh/sdk` (`src/webhooks.ts`) hands `standardwebhooks` a base64
 * *encoding* of the whole secret, which it decodes straight back, its `whsec_`
 * strip never firing since base64 has no underscore. The key is the UTF-8 bytes
 * of the secret as Polar shows it. (Both sources read 2026-09-10.)
 */
export const verifySignature = (
  secret: string,
  headers: Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>,
  body: Uint8Array
): Effect.Effect<boolean> =>
  Effect.flatMap(DateTime.now, (clock) => {
    const { "webhook-id": id, "webhook-signature": sigs, "webhook-timestamp": ts } = headers
    // Standard Webhooks' window, checked before any HMAC: a signature that
    // verifies is still a replay at five minutes old, and a bad number is `NaN`.
    const skew = DateTime.toEpochMillis(clock) / 1000 - Number(ts)
    if (!Number.isFinite(skew) || Math.abs(skew) > 300) return Effect.succeed(false)
    return Effect.promise(async () => {
      const hmac = { name: "HMAC", hash: "SHA-256" }
      const key = await crypto.subtle.importKey("raw", utf8.encode(secret), hmac, false, ["sign"])
      const content = utf8.encode(`${id}.${ts}.${text.decode(body)}`)
      const mac = await crypto.subtle.sign("HMAC", key, content)
      const expected = btoa(String.fromCodePoint(...new Uint8Array(mac)))
      return sigs.split(" ").some((v) => v.startsWith("v1,") && secretEquals(v.slice(3), expected))
    })
  })

/** The slice of a Polar event this Worker reads: a field we do not name cannot break one. */
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
/** Parse and validate in one step, so a body that is not JSON is a `None`, not a throw. */
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SubscriptionEvent))

/** `gh:<numeric id>` is the only owner `AuthAccounts` issues; `self` and the rest are not owners. */
const asOwner = (id: unknown): Option.Option<Owner> =>
  typeof id === "string" && /^gh:\d+$/u.test(id) ? Option.some(Owner.make(id)) : Option.none()

/**
 * Status, never event name: writing the state an event carries rather than a step
 * in a sequence is what makes a replay idempotent. Only a verdict is here, and a
 * free one is not final alone — Polar can set `canceled` when a cancellation is
 * *asked for*, so `ended_at` is what says access has actually gone.
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
 * — not a subscription event, not decodable, a status or a pending cancellation
 * that decides nothing, an owner it cannot name — all 202, none different on a
 * retry. The owner is `metadata.owner`, set at checkout (0.4 §03), else
 * `external_id`. Accepted: Polar promises no order, so a stale `active` re-pays.
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
