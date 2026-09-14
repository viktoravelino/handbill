import { expect, test } from "bun:test"
import type { Account } from "@handbill/contract"
import { Owner, Unauthorized } from "@handbill/contract"
import { Effect, Layer } from "effect"
import { AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, AuthSecret, type Identify, type KeyStore } from "./auth"
import { type Billing, BillingDisabled, BillingPolar } from "./billing"
import { hashBytes } from "./hash"
import { QuotaMemory, QuotaUnlimited, TIER_LIMITS } from "./quotas"
import { IndexBucket, IndexMemory, StorageMemory } from "./storage"

/**
 * M20 on memory layers: what `GET /v1/account` reports, and the checkout the
 * Worker creates rather than links to. Polar is one `fetch` away, stubbed here
 * the way `githubOwner` is in `accounts.test.ts` — no network, no account.
 */

const ZONE = "example.dev"
const MAX_BYTES = 4096
const ADMIN = "operator-only"
const TOKEN = "publish-me"
const GITHUB_TOKEN = "gho_from-the-device-flow"
const OWNER = Owner.make("gh:4242")
const CHECKOUT_URL = "https://sandbox.polar.sh/checkout/abc123"

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string) => Effect.runPromise(hashBytes(bytes(text)))
const DOC = "<html><title>Plan</title></html>"

const identify: Identify = (githubToken) =>
  githubToken === GITHUB_TOKEN ? Effect.succeed(OWNER) : Effect.fail(new Unauthorized())

const memoryKeys = (): KeyStore => {
  const records = new Map<string, string>()
  return {
    get: (key): Promise<unknown> => Promise.resolve(JSON.parse(records.get(key) ?? "null")),
    put: (key, value): Promise<void> => Promise.resolve(void records.set(key, value)),
    list: (prefix): Promise<ReadonlyArray<string>> =>
      Promise.resolve([...records.keys()].filter((key) => key.startsWith(prefix)))
  }
}

/** A hosted deployment: accounts, counted quotas, and whatever it has to sell. */
const hosted = (billing: Layer.Layer<Billing> = BillingDisabled) =>
  makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES, adminToken: ADMIN },
    Layer.mergeAll(
      StorageMemory,
      IndexMemory,
      AuthAccounts(memoryKeys(), identify),
      AliasesMemory,
      QuotaMemory(),
      billing
    )
  )

/** Self-hosted: one shared token, nothing counted, and an operator who is not a customer. */
const selfHosted = (billing: Layer.Layer<Billing> = BillingDisabled) =>
  makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      IndexBucket.pipe(Layer.provideMerge(StorageMemory)),
      AuthSecret(TOKEN),
      AliasesMemory,
      QuotaUnlimited,
      billing
    )
  )

type App = ReturnType<typeof makeApp>

const keyFor = async (app: App): Promise<string> => {
  const response = await app.fetch(
    new Request(`https://api.${ZONE}/v1/keys`, {
      method: "POST",
      body: JSON.stringify({ githubToken: GITHUB_TOKEN }),
      headers: { "content-type": "application/json" }
    })
  )
  return ((await response.json()) as { key: string }).key
}

const publish = async (app: App, key: string, body: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${await hashOf(body)}`, {
      method: "PUT",
      body: bytes(body),
      headers: { "content-type": "text/html", authorization: `Bearer ${key}` }
    })
  )

const unpublish = async (app: App, key: string, body: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${await hashOf(body)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` }
    })
  )

const account = async (app: App, key: string): Promise<Account> => {
  const response = await app.fetch(
    new Request(`https://api.${ZONE}/v1/account`, { headers: { authorization: `Bearer ${key}` } })
  )
  expect(response.status).toBe(200)
  return (await response.json()) as Account
}

const checkout = (app: App, key: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/account/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` }
    })
  )

/**
 * The Worker's outbound `fetch` answered by the test, with every call recorded:
 * the request body is the only place the owner stamped onto a session is
 * visible, and it is the whole point of creating the session server-side.
 */
const withPolar = async <A>(
  reply: () => Response,
  run: () => Promise<A>
): Promise<{ result: A; calls: ReadonlyArray<{ url: string; body: unknown }> }> => {
  const calls: Array<{ url: string; body: unknown }> = []
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof globalThis.fetch>) => {
      const [input, init] = args
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) as unknown })
      return Promise.resolve(reply())
    },
    { preconnect: () => Promise.resolve() }
  )
  try {
    return { result: await run(), calls }
  } finally {
    globalThis.fetch = original
  }
}

const polar = BillingPolar({
  api: "https://sandbox-api.polar.sh",
  token: "polar_oat_test",
  productId: "prod_1"
})

test("usage follows what is published and what is given back", async () => {
  const app = hosted()
  const key = await keyFor(app)
  expect(await account(app, key)).toEqual({
    owner: OWNER,
    tier: "free",
    usage: { pagesToday: 0, storedBytes: 0 },
    limits: TIER_LIMITS.free
  })

  expect((await publish(app, key, DOC)).status).toBe(200)
  expect((await account(app, key)).usage).toEqual({
    pagesToday: 1,
    storedBytes: bytes(DOC).length
  })

  // Unpublishing gives the bytes back but not the day's count: that limit caps
  // writes rather than what is kept, which is exactly what the numbers say.
  expect((await unpublish(app, key, DOC)).status).toBe(204)
  expect((await account(app, key)).usage).toEqual({ pagesToday: 1, storedBytes: 0 })
})

// A deployment that counts nothing has no ceiling to report, and `null` is how
// the route says so: a zero limit would read as an account with nothing left.
test("a self-hosted deployment reports no limits at all", async () => {
  const app = selfHosted()
  const current = await account(app, TOKEN)
  expect(current).toEqual({
    owner: Owner.make("self"),
    tier: "free",
    usage: { pagesToday: 0, storedBytes: 0 },
    limits: null
  })
})

// The tier is read off the key record, so the operator's override — and the
// webhook that writes the same field — is visible here the moment it lands.
test("the tier and its limits follow a flip", async () => {
  const app = hosted()
  const key = await keyFor(app)
  const flipped = await app.fetch(
    new Request(`https://api.${ZONE}/v1/admin/tier/${encodeURIComponent(OWNER)}`, {
      method: "PUT",
      body: JSON.stringify({ tier: "paid" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }
    })
  )
  expect(flipped.status).toBe(204)

  const current = await account(app, key)
  expect(current.tier).toBe("paid")
  expect(current.limits).toEqual(TIER_LIMITS.paid)
})

test("the checkout is created for the owner the key resolved to", async () => {
  const app = hosted(polar)
  const key = await keyFor(app)
  const { calls, result } = await withPolar(
    () => new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 201 }),
    () => checkout(app, key)
  )
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ url: CHECKOUT_URL })
  // The trailing slash keeps Polar from answering 307 and dropping the body.
  expect(calls).toEqual([
    {
      url: "https://sandbox-api.polar.sh/v1/checkouts/",
      // The owner is the authenticated one, never anything the caller sent:
      // this is what a stranger cannot forge a checkout for (#132). It goes in
      // twice on purpose — `metadata` is what the webhook reads back, and
      // `external_customer_id` is one Polar customer per owner, which is what
      // `readFlip`'s `customer.external_id` fallback needs to exist.
      body: {
        products: ["prod_1"],
        metadata: { owner: OWNER },
        external_customer_id: OWNER
      }
    }
  ])
})

// A second subscription is not more quota: it would charge twice and leave two
// subscriptions racing to set one tier. 409, and Polar is never asked.
test("an account already paying has nothing to buy", async () => {
  const app = hosted(polar)
  const key = await keyFor(app)
  await app.fetch(
    new Request(`https://api.${ZONE}/v1/admin/tier/${encodeURIComponent(OWNER)}`, {
      method: "PUT",
      body: JSON.stringify({ tier: "paid" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }
    })
  )

  const { calls, result } = await withPolar(
    () => new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 201 }),
    () => checkout(app, key)
  )
  expect(result.status).toBe(409)
  expect(calls).toEqual([])
})

test("a deployment with no billing configured has no checkout", async () => {
  const app = hosted()
  const key = await keyFor(app)
  expect((await checkout(app, key)).status).toBe(404)
})

// Secret mode has exactly one owner, the operator, who pays their own R2 bill
// rather than this deployment: nothing to sell even where Polar is configured,
// and nothing is asked of Polar either.
test("secret mode has nothing to upgrade", async () => {
  const app = selfHosted(polar)
  const { calls, result } = await withPolar(
    () => new Response(JSON.stringify({ url: CHECKOUT_URL }), { status: 201 }),
    () => checkout(app, TOKEN)
  )
  expect(result.status).toBe(404)
  expect(calls).toEqual([])
})

// Polar being down is not a verdict about the account, exactly as a GitHub
// outage is not one about a token: the route dies rather than inventing a URL.
test("Polar unavailable is a 500, not a checkout", async () => {
  const app = hosted(polar)
  const key = await keyFor(app)
  const { result } = await withPolar(
    () => new Response("upstream", { status: 503 }),
    () => checkout(app, key)
  )
  expect(result.status).toBe(500)
})
