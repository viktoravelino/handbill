import { expect, test } from "bun:test"
import { Owner, Unauthorized, WEBHOOK_MAX_BYTES } from "@handbill/contract"
import { Clock, Effect, Layer } from "effect"
import { AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, type Identify, type KeyStore } from "./auth"
import { BillingDisabled } from "./billing"
import { hashBytes } from "./hash"
import { QuotaMemory, TIER_LIMITS } from "./quotas"
import { IndexMemory, StorageMemory } from "./storage"

/**
 * M19 on memory layers: the Polar webhook and the operator's tier override. The
 * key records are a `Map` the test reads directly, and the Worker's clock is
 * frozen, so a delivery's timestamp and the daily quota's date key are both
 * values rather than whatever the wall clock says while the suite runs.
 */

const ZONE = "example.dev"
const MAX_BYTES = 64
const ADMIN = "operator-only"
/** Shaped like a current Polar secret — `whsec_` then base64 — of the word "fake". */
const SECRET = "whsec_ZmFrZQ=="
/** One from before Polar's Standard Webhooks cutoff, keyed on the string itself. */
const LEGACY = "polar-endpoint-secret-of-the-older-kind"
const GITHUB_TOKEN = "gho_from-the-device-flow"
const OWNER = Owner.make("gh:4242")
const SUBSCRIPTION = "sub_c444fc13"

/** Frozen at noon UTC, so a fresh delivery is never near the five-minute edge. */
const NOW_MILLIS = Date.UTC(2026, 0, 15, 12, 0, 0)
const NOW = Math.floor(NOW_MILLIS / 1000)
const TODAY = `q:${OWNER}:d:20260115`
/** Access is gone as of this instant; a lapse Polar has only scheduled has none. */
const ENDED = { ended_at: "2026-01-15T11:00:00.000Z" }

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string) => Effect.runPromise(hashBytes(bytes(text)))
const doc = (n: number) => `<html><title>p${n}</title></html>`

const identify: Identify = (githubToken) =>
  githubToken === GITHUB_TOKEN ? Effect.succeed(OWNER) : Effect.fail(new Unauthorized())

/** The records map is the test's window on `ACCOUNTS`: one JSON value per key. */
const memoryKeys = (records: Map<string, string>): KeyStore => ({
  get: (key): Promise<unknown> => Promise.resolve(JSON.parse(records.get(key) ?? "null")),
  put: (key, value): Promise<void> => Promise.resolve(void records.set(key, value)),
  list: (prefix): Promise<ReadonlyArray<string>> =>
    Promise.resolve([...records.keys()].filter((key) => key.startsWith(prefix)))
})

const frozen: Clock.Clock = {
  currentTimeMillisUnsafe: () => NOW_MILLIS,
  currentTimeMillis: Effect.succeed(NOW_MILLIS),
  currentTimeNanosUnsafe: () => BigInt(NOW_MILLIS) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(NOW_MILLIS) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(NOW_MILLIS) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(NOW_MILLIS) * 1_000_000n),
  sleep: () => Effect.void
}

/**
 * A hosted deployment with, unless a test says otherwise, both operator secrets
 * set. `records` and `counters` are the two stores the assertions read.
 */
const hosted = (
  options: { readonly admin?: string | undefined; readonly secret?: string | undefined } = {
    admin: ADMIN,
    secret: SECRET
  }
) => {
  const records = new Map<string, string>()
  const counters = new Map<string, number>()
  const app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES, adminToken: options.admin, webhookSecret: options.secret },
    Layer.mergeAll(
      StorageMemory,
      IndexMemory,
      AuthAccounts(memoryKeys(records), identify),
      AliasesMemory,
      QuotaMemory(counters),
      BillingDisabled,
      Layer.succeed(Clock.Clock, frozen)
    )
  )
  return { app, records, counters }
}

type Hosted = ReturnType<typeof hosted>

const mint = async ({ app }: Hosted): Promise<string> => {
  const response = await app.fetch(
    new Request(`https://api.${ZONE}/v1/keys`, {
      method: "POST",
      body: JSON.stringify({ githubToken: GITHUB_TOKEN }),
      headers: { "content-type": "application/json" }
    })
  )
  return ((await response.json()) as { key: string }).key
}

const revoke = ({ app }: Hosted, key: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/keys/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` }
    })
  )

const publish = async ({ app }: Hosted, key: string, body: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${await hashOf(body)}`, {
      method: "PUT",
      body: bytes(body),
      headers: { "content-type": "text/html", authorization: `Bearer ${key}` }
    })
  )

const listPages = ({ app }: Hosted, key: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages`, { headers: { authorization: `Bearer ${key}` } })
  )

/** The `k:` records, which is where a flip has to land, without their digests. */
interface StoredKey {
  readonly tier: string
  readonly revoked?: string
  readonly subscriptionId?: string
}
const keyRecords = ({ records }: Hosted): ReadonlyArray<StoredKey> =>
  [...records.entries()]
    .filter(([name]) => name.startsWith("k:"))
    .map(([, value]) => JSON.parse(value) as StoredKey)

/**
 * The same HMAC the Worker computes, keyed the two ways Polar keys it: the base64
 * after `whsec_`, or the bytes of a legacy secret's string. Deriving it any other
 * way passes against a Worker that agrees and fails against Polar, which is how
 * the first cut of this shipped a 401 against a real delivery.
 */
const keyBytes = (secret: string) =>
  secret.startsWith("whsec_")
    ? Uint8Array.from(atob(secret.slice(6)), (c) => c.codePointAt(0) ?? 0)
    : bytes(secret)

const sign = async (
  id: string,
  timestamp: number,
  body: string,
  secret: string = SECRET
): Promise<string> => {
  const hmac = { name: "HMAC", hash: "SHA-256" }
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), hmac, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, bytes(`${id}.${timestamp}.${body}`))
  return `v1,${btoa(String.fromCodePoint(...new Uint8Array(mac)))}`
}

/** One delivery, signed unless the test hands it something else. */
const deliver = async (
  { app }: Hosted,
  event: unknown,
  over: {
    readonly id?: string
    readonly timestamp?: number
    readonly signature?: string
    readonly secret?: string
  } = {}
) => {
  const body = JSON.stringify(event)
  const id = over.id ?? "msg_2451"
  const timestamp = over.timestamp ?? NOW
  return app.fetch(
    new Request(`https://api.${ZONE}/v1/billing/webhook`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": over.signature ?? (await sign(id, timestamp, body, over.secret))
      }
    })
  )
}

/** A Polar subscription event as the fields this Worker reads see it. */
const subscription = (type: string, status: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { id: SUBSCRIPTION, status, metadata: { owner: OWNER }, ...data }
})

/** The one tier every live key of the owner is on, or `undefined` if they disagree. */
const tierOf = (deployment: Hosted): string | undefined => {
  const live = keyRecords(deployment).filter((record) => record.revoked === undefined)
  return live.every((record) => record.tier === live[0]?.tier) ? live[0]?.tier : undefined
}

// The whole point of the `o:` back-reference: one delivery moves every live key
// the account holds, so a person logged in on a laptop and a CI runner is paid
// on both — and the key they revoked stays dead and stays free.
test("an active subscription flips every live key of the owner, and no revoked one", async () => {
  const deployment = hosted()
  const laptop = await mint(deployment)
  const runner = await mint(deployment)
  const retired = await mint(deployment)
  expect((await revoke(deployment, retired)).status).toBe(204)

  const response = await deliver(deployment, subscription("subscription.active", "active"))
  expect(response.status).toBe(202)

  const live = keyRecords(deployment).filter((record) => record.revoked === undefined)
  expect(live).toHaveLength(2)
  expect(live.every((record) => record.tier === "paid")).toBe(true)
  expect(live.every((record) => record.subscriptionId === SUBSCRIPTION)).toBe(true)
  const dead = keyRecords(deployment).filter((record) => record.revoked !== undefined)
  expect(dead).toHaveLength(1)
  expect(dead[0]?.tier).toBe("free")
  expect(dead[0]?.subscriptionId).toBeUndefined()
  // Both live keys still work, which is what "flipped, not rewritten" means.
  expect((await listPages(deployment, laptop)).status).toBe(200)
  expect((await listPages(deployment, runner)).status).toBe(200)
})

// Polar retries until it sees a 2xx, so the same delivery arrives more than
// once. The handler writes the state the event carries rather than a step, so
// the second one lands on the answer the first one left.
test("the same delivery twice is the same account state", async () => {
  const deployment = hosted()
  await mint(deployment)
  const event = subscription("subscription.active", "active")
  expect((await deliver(deployment, event)).status).toBe(202)
  const first = keyRecords(deployment)
  expect((await deliver(deployment, event)).status).toBe(202)
  expect(keyRecords(deployment)).toEqual(first)
})

// A lapse lowers what the account may spend and touches nothing else: decision
// 11's whole point is that money is on the write path, never the read path.
test("a revoked subscription goes back to free and leaves the pages published", async () => {
  const deployment = hosted()
  const key = await mint(deployment)
  expect((await publish(deployment, key, doc(1))).status).toBe(200)
  await deliver(deployment, subscription("subscription.active", "active"))

  const lapse = subscription("subscription.revoked", "revoked", ENDED)
  expect((await deliver(deployment, lapse)).status).toBe(202)
  const [record] = keyRecords(deployment)
  expect(record?.tier).toBe("free")
  // The id stays behind, so a lapsed account is still traceable for support.
  expect(record?.subscriptionId).toBe(SUBSCRIPTION)
  const listed = (await (await listPages(deployment, key)).json()) as {
    pages: ReadonlyArray<unknown>
  }
  expect(listed.pages).toHaveLength(1)
})

test("a body that is not signed with the endpoint secret is 401", async () => {
  const deployment = hosted()
  await mint(deployment)
  const forged = await deliver(deployment, subscription("subscription.active", "active"), {
    signature: "v1,bm90LXRoZS1yaWdodC1zaWduYXR1cmU="
  })
  expect(forged.status).toBe(401)
  expect(keyRecords(deployment)[0]?.tier).toBe("free")
})

// A captured delivery replayed later verifies perfectly; the timestamp is the
// only thing that makes it stale, so the window is checked before the HMAC.
test("a correctly signed delivery six minutes old is 401", async () => {
  const deployment = hosted()
  await mint(deployment)
  const stale = await deliver(deployment, subscription("subscription.active", "active"), {
    timestamp: NOW - 360
  })
  expect(stale.status).toBe(401)
  expect(keyRecords(deployment)[0]?.tier).toBe("free")
})

// Everything that verifies is 202, including the deliveries there is nothing to
// do about: a non-2xx would only buy a retry that came out the same way.
test("an event this Worker does not act on is accepted and changes nothing", async () => {
  const deployment = hosted()
  await mint(deployment)
  const other = await deliver(deployment, subscription("order.paid", "active"))
  expect(other.status).toBe(202)
  expect(keyRecords(deployment)[0]?.tier).toBe("free")
})

test("a subscription with no owner this deployment can name is accepted too", async () => {
  const deployment = hosted()
  await mint(deployment)
  // `self` is the operator, never an account: an owner off a checkout has to
  // look like one `AuthAccounts` issues or it is not an owner at all.
  const nameless = await deliver(
    deployment,
    subscription("subscription.active", "active", { metadata: { owner: "self" } })
  )
  expect(nameless.status).toBe(202)
  expect(keyRecords(deployment)[0]?.tier).toBe("free")
})

test("without a webhook secret the route is not there", async () => {
  const deployment = hosted({ admin: ADMIN, secret: undefined })
  await mint(deployment)
  const response = await deliver(deployment, subscription("subscription.active", "active"))
  expect(response.status).toBe(404)
})

/** The operator's override: the same write, over the admin token. */
const setTier = ({ app }: Hosted, tier: string, token: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/admin/tier/${OWNER}`, {
      method: "PUT",
      body: JSON.stringify({ tier }),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
    })
  )

test("the tier route is absent without an ADMIN_TOKEN and refuses a wrong one", async () => {
  const open = hosted({ admin: undefined, secret: SECRET })
  await mint(open)
  expect((await setTier(open, "paid", ADMIN)).status).toBe(404)
  expect(keyRecords(open)[0]?.tier).toBe("free")

  const deployment = hosted()
  const key = await mint(deployment)
  expect((await setTier(deployment, "paid", key)).status).toBe(401)
  expect(keyRecords(deployment)[0]?.tier).toBe("free")
})

// The override and the webhook write the same field, so what the operator sets
// is what the next request authorizes as.
test("the operator can set a tier, and the key authorizes on it", async () => {
  const deployment = hosted()
  const key = await mint(deployment)
  expect((await setTier(deployment, "paid", ADMIN)).status).toBe(204)
  expect(keyRecords(deployment)[0]?.tier).toBe("paid")
  expect((await listPages(deployment, key)).status).toBe(200)
})

// Decision 11 end to end: the tier is a row in `TIER_LIMITS`, so a flip is the
// whole of what being paid buys. The free row's day is spent, the paid row's is
// not, and nothing on the publish path asked about money.
test("a flipped key spends against the paid row of the quota table", async () => {
  const deployment = hosted()
  const key = await mint(deployment)
  deployment.counters.set(TODAY, TIER_LIMITS.free.pagesPerDay)
  expect((await publish(deployment, key, doc(1))).status).toBe(429)

  await deliver(deployment, subscription("subscription.active", "active"))
  expect((await publish(deployment, key, doc(1))).status).toBe(200)
  expect(TIER_LIMITS.paid.pagesPerDay).toBeGreaterThan(TIER_LIMITS.free.pagesPerDay)
})

// `metadata.owner` is filled in at checkout by whoever is paying, so a stranger
// can name someone else's account. Scoping every write to the subscription that
// owns the record is what keeps that from being either a free upgrade paid for
// by a stranger, or — the real damage — a cancellation that strips a victim.
test("a second subscription cannot take over or lapse an account that already pays", async () => {
  const deployment = hosted()
  await mint(deployment)
  await deliver(deployment, subscription("subscription.active", "active"))
  expect(tierOf(deployment)).toBe("paid")

  const intruder = { id: "sub_stranger" }
  const seize = await deliver(deployment, subscription("subscription.active", "active", intruder), {
    id: "msg_seize"
  })
  expect(seize.status).toBe(202)
  expect(keyRecords(deployment)[0]?.subscriptionId).toBe(SUBSCRIPTION)

  const strip = await deliver(
    deployment,
    subscription("subscription.revoked", "revoked", { ...intruder, ...ENDED }),
    { id: "msg_strip" }
  )
  expect(strip.status).toBe(202)
  expect(tierOf(deployment)).toBe("paid")
})

// Without this a paying user's second `handbill login` would publish on the free
// row forever, since a new record is written from scratch.
test("a key minted after an upgrade inherits the tier and the subscription", async () => {
  const deployment = hosted()
  await mint(deployment)
  await deliver(deployment, subscription("subscription.active", "active"))
  const second = await mint(deployment)

  expect(tierOf(deployment)).toBe("paid")
  const fresh = keyRecords(deployment).at(-1)
  expect(fresh?.subscriptionId).toBe(SUBSCRIPTION)
  expect((await listPages(deployment, second)).status).toBe(200)
})

// A failed charge is a retry in progress, not a verdict: Polar will send
// `active` or `revoked` when it knows. Cutting the account off in between would
// punish a card that is about to go through.
test("a payment being retried is accepted and leaves the tier alone", async () => {
  const deployment = hosted()
  await mint(deployment)
  await deliver(deployment, subscription("subscription.active", "active"))

  for (const status of ["past_due", "unpaid", "incomplete"]) {
    const response = await deliver(deployment, subscription("subscription.updated", status), {
      id: `msg_${status}`
    })
    expect(response.status).toBe(202)
    expect(tierOf(deployment)).toBe("paid")
  }
})

test("a trial is paid, and its owner can come from the customer instead", async () => {
  const deployment = hosted()
  const key = await mint(deployment)
  // No `metadata.owner` at all: the customer Polar holds carries the account,
  // which is the path a subscription created outside the pricing page takes.
  const response = await deliver(
    deployment,
    subscription("subscription.active", "trialing", {
      metadata: {},
      customer: { external_id: OWNER }
    })
  )
  expect(response.status).toBe(202)
  expect(tierOf(deployment)).toBe("paid")
  expect((await listPages(deployment, key)).status).toBe(200)
})

// Refused by length before the HMAC: a body this route will not read is not
// worth hashing, and 413 is already the contract's answer for one too big.
test("a delivery over the size cap is 413", async () => {
  const deployment = hosted()
  await mint(deployment)
  const padded = subscription("subscription.active", "active", {
    padding: "x".repeat(WEBHOOK_MAX_BYTES)
  })
  expect((await deliver(deployment, padded)).status).toBe(413)
  expect(tierOf(deployment)).toBe("free")
})

// A lapse leaves the old id on the record, so an upgrade that only ever claimed
// its own subscription could never sell to the same person twice.
test("an account that lapsed can subscribe again on a new subscription", async () => {
  const deployment = hosted()
  await mint(deployment)
  await deliver(deployment, subscription("subscription.active", "active"))
  await deliver(deployment, subscription("subscription.revoked", "revoked", ENDED), {
    id: "msg_lapse"
  })
  expect(tierOf(deployment)).toBe("free")

  const renewed = { id: "sub_second" }
  await deliver(deployment, subscription("subscription.active", "active", renewed), {
    id: "msg_again"
  })
  expect(tierOf(deployment)).toBe("paid")
  expect(keyRecords(deployment)[0]?.subscriptionId).toBe("sub_second")
})

// The other half of that rule: claiming a free record is what lets a stranger
// park a subscription on a victim, so it has to be a thing the victim can undo
// simply by paying — the gift lapses, and their own subscription then lands.
test("a subscription parked on a free account does not lock it out", async () => {
  const deployment = hosted()
  await mint(deployment)
  const gift = { id: "sub_gift" }
  await deliver(deployment, subscription("subscription.active", "active", gift), { id: "msg_gift" })
  await deliver(
    deployment,
    subscription("subscription.revoked", "revoked", { ...gift, ...ENDED }),
    {
      id: "msg_ungift"
    }
  )
  expect(tierOf(deployment)).toBe("free")

  await deliver(deployment, subscription("subscription.active", "active"), { id: "msg_own" })
  expect(tierOf(deployment)).toBe("paid")
  expect(keyRecords(deployment)[0]?.subscriptionId).toBe(SUBSCRIPTION)
})

// Polar can set `canceled` the moment someone clicks cancel, with the period
// already paid for. Access ends when `ended_at` does, not before.
test("a cancellation that has not taken effect leaves the account paid", async () => {
  const deployment = hosted()
  await mint(deployment)
  await deliver(deployment, subscription("subscription.active", "active"))

  const scheduled = await deliver(
    deployment,
    subscription("subscription.canceled", "canceled", { ended_at: null }),
    { id: "msg_scheduled" }
  )
  expect(scheduled.status).toBe(202)
  expect(tierOf(deployment)).toBe("paid")
})

// Polar keyed webhooks on the bytes of the secret string before it moved to
// Standard Webhooks, and still signs endpoints from back then that way. Both
// derivations are live, so both are covered.
test("a legacy secret with no whsec_ prefix verifies too", async () => {
  const deployment = hosted({ admin: ADMIN, secret: LEGACY })
  await mint(deployment)
  const response = await deliver(deployment, subscription("subscription.active", "active"), {
    secret: LEGACY
  })
  expect(response.status).toBe(202)
  expect(tierOf(deployment)).toBe("paid")
})

// The other half: keyed the wrong way, a delivery is not a delivery. This is the
// 401 a real `subscription.updated` got, and it is silent from the outside.
test("the two derivations are not interchangeable", async () => {
  const deployment = hosted()
  await mint(deployment)
  const event = subscription("subscription.active", "active")
  const legacyKeyed = await sign("msg_2451", NOW, JSON.stringify(event), LEGACY)
  const response = await deliver(deployment, event, { signature: legacyKeyed })
  expect(response.status).toBe(401)
  expect(tierOf(deployment)).toBe("free")
})
