import { expect, test } from "bun:test"
import { Owner, Unauthorized } from "@handbill/contract"
import { Clock, Effect, Layer } from "effect"
import { AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, type Identify, type KeyStore } from "./auth"
import { hashBytes } from "./hash"
import { QuotaMemory, TIER_LIMITS } from "./quotas"
import { IndexMemory, StorageMemory } from "./storage"

/**
 * M16 on memory layers: the per-owner quotas, and the operator's takedown. The
 * counters are a `Map` the test can read, and the Worker's clock is one the test
 * moves, so "tomorrow" is a value rather than a wait.
 */

const ZONE = "example.dev"
const MAX_BYTES = 64
const ADMIN = "operator-only"
const GITHUB_TOKEN = "gho_from-the-device-flow"
const OWNER = Owner.make("gh:4242")

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string) => Effect.runPromise(hashBytes(bytes(text)))
/** Distinct documents, all under `MAX_BYTES`, so each publish is a new page. */
const doc = (n: number) => `<html><title>p${n}</title></html>`

const identify: Identify = (githubToken) =>
  githubToken === GITHUB_TOKEN ? Effect.succeed(OWNER) : Effect.fail(new Unauthorized())

const memoryKeys = (): KeyStore => {
  const records = new Map<string, string>()
  return {
    get: (key): Promise<unknown> => Promise.resolve(JSON.parse(records.get(key) ?? "null")),
    put: (key, value): Promise<void> => Promise.resolve(void records.set(key, value))
  }
}

/** A clock the test moves by hand: the daily counter's key is a UTC date. */
const DAY_ONE = Date.UTC(2026, 0, 15)
const movableClock = (start: number) => {
  let millis = start
  const nanos = () => BigInt(millis) * 1_000_000n
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.sync(() => millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: () => Effect.void
  }
  return { clock, tomorrow: () => void (millis += 24 * 60 * 60 * 1000) }
}

/**
 * A hosted deployment: accounts, the per-owner index, quota counters the test
 * holds, and — unless a test says otherwise — an `ADMIN_TOKEN`, so the takedown
 * route is there.
 */
const hosted = (options: { readonly admin?: string } = { admin: ADMIN }) => {
  const counters = new Map<string, number>()
  const time = movableClock(DAY_ONE)
  const app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES, adminToken: options.admin },
    Layer.mergeAll(
      StorageMemory,
      IndexMemory,
      AuthAccounts(memoryKeys(), identify),
      AliasesMemory,
      QuotaMemory(counters),
      Layer.succeed(Clock.Clock, time.clock)
    )
  )
  return { app, counters, tomorrow: time.tomorrow }
}

type Hosted = ReturnType<typeof hosted>

const keyFor = async ({ app }: Hosted): Promise<string> => {
  const response = await app.fetch(
    new Request(`https://api.${ZONE}/v1/keys`, {
      method: "POST",
      body: JSON.stringify({ githubToken: GITHUB_TOKEN }),
      headers: { "content-type": "application/json" }
    })
  )
  return ((await response.json()) as { key: string }).key
}

const publish = async ({ app }: Hosted, key: string, body: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${await hashOf(body)}`, {
      method: "PUT",
      body: bytes(body),
      headers: { "content-type": "text/html", authorization: `Bearer ${key}` }
    })
  )

const removePage = async ({ app }: Hosted, key: string, hash: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${hash}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` }
    })
  )

const takedown = ({ app }: Hosted, hash: string, token: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/admin/pages/${hash}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    })
  )

const listPages = ({ app }: Hosted, key: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages`, { headers: { authorization: `Bearer ${key}` } })
  )

const servePage = ({ app }: Hosted, hash: string) =>
  app.fetch(new Request(`https://${hash}.${ZONE}/`))

/** The bytes counter as the deployment holds it, for the assertions about release. */
const storedBytes = ({ counters }: Hosted): number => counters.get(`q:${OWNER}:bytes`) ?? 0

// §05: 25 pages a day. The limit is enforced at the boundary — the 25th is
// allowed and the 26th is not — and the refusal says which limit and when it
// frees up, so a client is told the rule rather than just turned away.
test("the daily page limit trips on the page after the last one, and says so", async () => {
  const deployment = hosted()
  const key = await keyFor(deployment)
  const { pagesPerDay } = TIER_LIMITS.free
  for (let n = 0; n < pagesPerDay; n++) {
    expect((await publish(deployment, key, doc(n))).status).toBe(200)
  }

  const refused = await publish(deployment, key, doc(pagesPerDay))
  expect(refused.status).toBe(429)
  expect(await refused.json()).toEqual({
    _tag: "QuotaExceeded",
    limit: "pagesPerDay",
    allowed: pagesPerDay,
    // Midnight UTC after the day that was spent.
    resetsAt: "2026-01-16T00:00:00.000Z"
  })
  // Refused before the write: the page it would have created is not served.
  expect((await servePage(deployment, await hashOf(doc(pagesPerDay)))).status).toBe(404)
})

// The daily counter is keyed by UTC date, so a new day is a new key rather than
// a reset anyone has to run.
test("tomorrow the daily count starts again", async () => {
  const deployment = hosted()
  const key = await keyFor(deployment)
  for (let n = 0; n < TIER_LIMITS.free.pagesPerDay; n++) await publish(deployment, key, doc(n))
  expect((await publish(deployment, key, doc(99))).status).toBe(429)

  deployment.tomorrow()
  expect((await publish(deployment, key, doc(99))).status).toBe(200)
})

// Stored bytes are the other ceiling, and the one unpublishing gives back. The
// counter follows the bucket: what R2 held for the object is what is released.
test("publishing spends stored bytes and removing gives them back", async () => {
  const deployment = hosted()
  const key = await keyFor(deployment)
  const page = doc(1)
  await publish(deployment, key, page)
  expect(storedBytes(deployment)).toBe(page.length)

  expect((await removePage(deployment, key, await hashOf(page))).status).toBe(204)
  expect(storedBytes(deployment)).toBe(0)
})

// The stored-bytes limit itself, without writing 250 MB: the check is asked
// about a document that would cross it, and names the limit that refused.
test("a document that would cross the storage ceiling is refused by name", async () => {
  const deployment = hosted()
  const key = await keyFor(deployment)
  deployment.counters.set(`q:${OWNER}:bytes`, TIER_LIMITS.free.storedBytes)

  const refused = await publish(deployment, key, doc(1))
  expect(refused.status).toBe(429)
  expect(await refused.json()).toEqual({
    _tag: "QuotaExceeded",
    limit: "storedBytes",
    allowed: TIER_LIMITS.free.storedBytes
  })
})

// §07: takedown removes the page for good — served nowhere, listed nowhere — and
// the bytes go back to the owner it was taken from, not to whoever asked.
test("the operator takes a page down, and its owner gets the bytes back", async () => {
  const deployment = hosted()
  const key = await keyFor(deployment)
  const page = doc(1)
  await publish(deployment, key, page)
  const hash = await hashOf(page)

  expect((await takedown(deployment, hash, ADMIN)).status).toBe(204)
  expect((await servePage(deployment, hash)).status).toBe(404)
  expect(await (await listPages(deployment, key)).json()).toEqual({ pages: [] })
  expect(storedBytes(deployment)).toBe(0)
  // Idempotent: a hash that is not stored — taken down already, or never
  // published — is the same 204.
  expect((await takedown(deployment, hash, ADMIN)).status).toBe(204)
  expect((await takedown(deployment, "0123456789ab", ADMIN)).status).toBe(204)
})

// The two credentials are separate secrets and neither is the other: a user key
// cannot take a page down, and the admin token is not a key that can publish.
test("a user key is not the admin token, and the admin token is not a key", async () => {
  const deployment = hosted()
  const key = await keyFor(deployment)
  const page = doc(1)
  await publish(deployment, key, page)
  const hash = await hashOf(page)

  const asUser = await takedown(deployment, hash, key)
  expect(asUser.status).toBe(401)
  expect(await asUser.json()).toEqual({ _tag: "Unauthorized" })
  // Refused and untouched: the page is still served and still listed.
  expect((await servePage(deployment, hash)).status).toBe(200)

  expect((await publish(deployment, ADMIN, doc(2))).status).toBe(401)
})

// The same additive rule as the alias and key routes: no secret, no feature. A
// deployment that sets no `ADMIN_TOKEN` has no operator surface to find.
test("without an ADMIN_TOKEN the takedown route is absent", async () => {
  const deployment = hosted({})
  const key = await keyFor(deployment)
  const page = doc(1)
  await publish(deployment, key, page)
  const hash = await hashOf(page)

  const response = await takedown(deployment, hash, ADMIN)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ _tag: "NotFound" })
  expect((await servePage(deployment, hash)).status).toBe(200)
})
