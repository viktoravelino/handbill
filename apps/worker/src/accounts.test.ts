import { describe, expect, test } from "bun:test"
import { Key, Owner, Unauthorized } from "@handbill/contract"
import { Effect, Layer, Schema } from "effect"
import { AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, githubOwner, type Identify, type KeyStore } from "./auth"
import { hashBytes, sha256Hex } from "./hash"
import { QuotaMemory } from "./quotas"
import { IndexMemory, StorageMemory } from "./storage"

/**
 * Accounts mode — the hosted tier's auth — on memory layers: a `Map` behind
 * `KeyStore` and a GitHub check that answers without a network. All the real
 * deployment puts behind those two is the `ACCOUNTS` KV namespace and one call
 * to `api.github.com`, so everything about keys is exercised here.
 */

const ZONE = "example.dev"
const MAX_BYTES = 64
const DOC = "<html><head><title>Plan</title></head><body>hi</body></html>"

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string) => Effect.runPromise(hashBytes(bytes(text)))

/** The map is a parameter so one test can look at the keys mint actually wrote. */
const memoryKeys = (records = new Map<string, string>()): KeyStore => ({
  get: (key): Promise<unknown> => Promise.resolve(JSON.parse(records.get(key) ?? "null")),
  put: (key, value): Promise<void> => Promise.resolve(void records.set(key, value))
})

/** Two GitHub tokens these tests know, each its own account; anything else is refused. */
const GITHUB_TOKEN = "gho_from-the-device-flow"
const OWNER = Owner.make("gh:4242")
const OTHER_TOKEN = "gho_a-second-account"
const OTHER = Owner.make("gh:9001")
const identify: Identify = (githubToken) =>
  githubToken === GITHUB_TOKEN
    ? Effect.succeed(OWNER)
    : githubToken === OTHER_TOKEN
      ? Effect.succeed(OTHER)
      : Effect.fail(new Unauthorized())

// One `ACCOUNTS` namespace backs both the keys (`AuthAccounts`) and the per-owner
// index (`IndexMemory`), the way one binding does in production.
const hosted = () =>
  makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      StorageMemory,
      IndexMemory,
      AuthAccounts(memoryKeys(), identify),
      AliasesMemory,
      QuotaMemory()
    )
  )

type App = ReturnType<typeof makeApp>

const mint = (app: App, githubToken: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/keys`, {
      method: "POST",
      body: JSON.stringify({ githubToken }),
      headers: { "content-type": "application/json" }
    })
  )

const isKey = Schema.is(Key)

/** The minted key, checked against the contract's own schema on the way out. */
const minted = async (response: Response) => {
  const body: unknown = await response.json()
  if (!isKey(body)) throw new Error(`not a minted key: ${JSON.stringify(body)}`)
  return body
}

const publishAs = (app: App, key: string, hash: string, body: string = DOC) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${hash}`, {
      method: "PUT",
      body: bytes(body),
      headers: { "content-type": "text/html", authorization: `Bearer ${key}` }
    })
  )

const listPages = (app: App, key: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages`, { headers: { authorization: `Bearer ${key}` } })
  )

const removePage = (app: App, key: string, hash: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${hash}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` }
    })
  )

const servePage = (app: App, hash: string) => app.fetch(new Request(`https://${hash}.${ZONE}/`))

/** The hashes a `list` response reports, in order. */
const pageHashes = async (response: Response): Promise<ReadonlyArray<string>> =>
  ((await response.json()) as { pages: ReadonlyArray<{ hash: string }> }).pages.map((p) => p.hash)

/** A second document, distinct bytes so it has its own hash, still under `MAX_BYTES`. */
const DOC_B = "<html><title>Memo</title>hi</html>"

/** Runs the real `githubOwner` with `globalThis.fetch` stubbed, then restores it. */
const withFetch = async (
  stub: () => Promise<Response>,
  run: (probe: typeof githubOwner) => Promise<unknown>
) => {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(stub, { preconnect: () => Promise.resolve() })
  try {
    return await run(githubOwner)
  } finally {
    globalThis.fetch = original
  }
}

/** A one-shot `fetch` that answers every call with this status and JSON body. */
const reply =
  (status: number, body: unknown = {}) =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

test("a minted key publishes as its GitHub owner, and health says accounts", async () => {
  const app = hosted()
  const response = await mint(app, GITHUB_TOKEN)
  expect(response.status).toBe(200)
  const { key, owner } = await minted(response)
  expect(owner).toBe(OWNER)
  // `hb_` and 32 random bytes as base64url: a greppable prefix, 43 characters.
  expect(key).toMatch(/^hb_[\w-]{43}$/u)

  expect(await (await app.fetch(new Request(`https://api.${ZONE}/v1/health`))).json()).toEqual({
    ok: true,
    mode: "accounts",
    zone: ZONE
  })

  const hash = await hashOf(DOC)
  expect((await publishAs(app, key, hash)).status).toBe(200)
  // The page belongs to the GitHub account rather than to `self`, and `list` is
  // by owner: this is what storing `owner` since 0.1 was for.
  const listed = await app.fetch(
    new Request(`https://api.${ZONE}/v1/pages`, { headers: { authorization: `Bearer ${key}` } })
  )
  expect(await listed.json()).toMatchObject({ pages: [{ hash }] })
})

// #111's review, deferred to M16: a key record is filed under its own digest, so
// without a second entry pointing the other way an owner's keys cannot be
// enumerated at all — and enumerating them is exactly what an operator holding
// `gh:<id>` from an abuse report has to do. Mint writes both.
test("minting also files an owner→key back-reference", async () => {
  const records = new Map<string, string>()
  const app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      StorageMemory,
      IndexMemory,
      AuthAccounts(memoryKeys(records), identify),
      AliasesMemory,
      QuotaMemory()
    )
  )
  const { key } = await minted(await mint(app, GITHUB_TOKEN))
  const digest = await Effect.runPromise(sha256Hex(bytes(key)))

  expect([...records.keys()].toSorted()).toEqual([`k:${digest}`, `o:${OWNER}:${digest}`])
  // The pointer is a pointer: the record itself stays the one place a key is
  // described, so nothing has to be kept in step with anything.
  expect(records.get(`o:${OWNER}:${digest}`)).toBe("")
})

test("a GitHub token GitHub refuses, and a key nobody minted, are both 401", async () => {
  const app = hosted()
  const refused = await mint(app, "not-a-github-token")
  expect(refused.status).toBe(401)
  expect(await refused.json()).toEqual({ _tag: "Unauthorized" })
  expect((await publishAs(app, "hb_never-minted", await hashOf(DOC))).status).toBe(401)
})

test("a key can revoke itself, and then it is not a key any more", async () => {
  const app = hosted()
  const { key } = await minted(await mint(app, GITHUB_TOKEN))
  const revoke = (bearer: string) =>
    app.fetch(
      new Request(`https://api.${ZONE}/v1/keys/current`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${bearer}` }
      })
    )

  expect((await revoke(key)).status).toBe(204)
  expect((await publishAs(app, key, await hashOf(DOC))).status).toBe(401)
  // Idempotent, like every other DELETE in the contract: revoking a key that is
  // already revoked, or one that was never minted, is a 204 too. The route is
  // deliberately off the authorize middleware so a revoked key reaches the
  // handler instead of being turned away as 401 before it.
  expect((await revoke(key)).status).toBe(204)
  expect((await revoke("hb_never-minted")).status).toBe(204)
})

// #111 review, MEDIUM: GitHub being down or rate-limiting must not be reported
// to the user as a bad token. Only a 401 from GitHub is `Unauthorized`; a 5xx,
// a 429 or the 403 of a secondary rate limit is a defect that fails the mint
// loudly (500) and tells the caller nothing false about their token. This drives
// the real `githubOwner`, the one thing `accountsApp` swaps out, with `fetch`
// stubbed.
describe("githubOwner", () => {
  test("a 200 resolves to gh:<id>", async () => {
    const owner = await withFetch(reply(200, { id: 4242 }), (probe) =>
      Effect.runPromise(probe("gho_valid"))
    )
    expect(owner).toBe("gh:4242")
  })

  test("a 401 is Unauthorized, but a 503, 429 or 403 is a defect, not a verdict", async () => {
    const unauthorized = await withFetch(reply(401), (probe) =>
      Effect.runPromise(Effect.flip(probe("gho_bad")))
    )
    expect(unauthorized).toBeInstanceOf(Unauthorized)

    for (const status of [503, 500, 429, 403]) {
      // A defect, not a tagged failure: `Effect.flip` would surface an
      // `Unauthorized`, so if the promise resolves rather than rejecting the
      // outage has been miscast as a bad token.
      await expect(
        withFetch(reply(status), (probe) => Effect.runPromise(Effect.flip(probe("gho_ok"))))
      ).rejects.toThrow(/github unavailable/u)
    }
  })
})

// #111 review, HIGH (part b): decision 08 keeps aliases operator-only in 0.3,
// and a hosted key is not the operator. Every writable or readable alias route
// answers a hosted key the same 404 an absent binding gives — it cannot set a
// name, remove one, or read another owner's hash by name. `list` is already
// owner-filtered, so it is a truthful empty rather than a leak.
test("a hosted key gets no alias surface at all", async () => {
  const app = hosted()
  const { key } = await minted(await mint(app, GITHUB_TOKEN))
  const hash = await hashOf(DOC)
  await publishAs(app, key, hash)
  const alias = (name: string, init?: RequestInit) =>
    app.fetch(
      new Request(`https://api.${ZONE}/v1/aliases/${name}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, ...init?.headers }
      })
    )

  const set = await alias("plan", {
    method: "PUT",
    body: JSON.stringify({ hash }),
    headers: { "content-type": "application/json" }
  })
  expect(set.status).toBe(404)
  expect(await set.json()).toEqual({ _tag: "NotFound" })
  expect((await alias("plan")).status).toBe(404)
  expect((await alias("plan", { method: "DELETE" })).status).toBe(404)
  // The one alias route a hosted key may reach answers with its own empty set.
  const list = await app.fetch(
    new Request(`https://api.${ZONE}/v1/aliases`, { headers: { authorization: `Bearer ${key}` } })
  )
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual({ aliases: [] })
})

/** A minted key for a GitHub token, the two-step every M14 test starts from. */
const keyFor = async (app: App, githubToken: string): Promise<string> =>
  (await minted(await mint(app, githubToken))).key

// M14 (§04, decision 05): the per-owner index makes `list` and `remove` scoped
// to the caller. Two accounts share one bucket and one `ACCOUNTS` namespace, and
// still see only their own pages.
test("two owners each see only their own pages", async () => {
  const app = hosted()
  const a = await keyFor(app, GITHUB_TOKEN)
  const b = await keyFor(app, OTHER_TOKEN)
  const hashA = await hashOf(DOC)
  const hashB = await hashOf(DOC_B)
  await publishAs(app, a, hashA)
  await publishAs(app, b, hashB, DOC_B)

  expect(await pageHashes(await listPages(app, a))).toEqual([hashA])
  expect(await pageHashes(await listPages(app, b))).toEqual([hashB])
})

// The gap M13's review flagged and M14 closes: one account cannot delete
// another's page. Ownership is read from R2, and a hash owned by someone else is
// a 404 that removes nothing — never a 403, so existence is not disclosed.
test("cross-owner remove is a 404 that deletes nothing", async () => {
  const app = hosted()
  const a = await keyFor(app, GITHUB_TOKEN)
  const b = await keyFor(app, OTHER_TOKEN)
  const hash = await hashOf(DOC)
  await publishAs(app, a, hash)

  const denied = await removePage(app, b, hash)
  expect(denied.status).toBe(404)
  expect(await denied.json()).toEqual({ _tag: "NotFound" })

  // Still served, still A's, still in A's listing.
  expect((await servePage(app, hash)).status).toBe(200)
  expect(await pageHashes(await listPages(app, a))).toEqual([hash])
})

test("an owner removes their own page: 204, gone from the listing and no longer served", async () => {
  const app = hosted()
  const a = await keyFor(app, GITHUB_TOKEN)
  const hash = await hashOf(DOC)
  await publishAs(app, a, hash)

  expect((await removePage(app, a, hash)).status).toBe(204)
  expect((await servePage(app, hash)).status).toBe(404)
  expect(await pageHashes(await listPages(app, a))).toEqual([])
})

// Same bytes, same address (decision 05): the second publisher gets the public,
// content-addressed URL but no ownership and no index entry — the first writer
// keeps it, so the second's `remove` 404s and the page is untouched.
test("a second owner publishing the same bytes gets the URL but not ownership", async () => {
  const app = hosted()
  const a = await keyFor(app, GITHUB_TOKEN)
  const b = await keyFor(app, OTHER_TOKEN)
  const hash = await hashOf(DOC)
  await publishAs(app, a, hash)

  const second = await publishAs(app, b, hash)
  expect(second.status).toBe(200)
  expect(await second.json()).toMatchObject({ hash, created: false })

  // No second index entry for B, and B cannot remove what A owns.
  expect(await pageHashes(await listPages(app, b))).toEqual([])
  expect((await removePage(app, b, hash)).status).toBe(404)
  expect((await servePage(app, hash)).status).toBe(200)
  expect(await pageHashes(await listPages(app, a))).toEqual([hash])
})

// A title larger than KV's 1024-byte metadata cap once made the hosted index
// write reject after the R2 write had landed — a 500 and a served-but-unlisted
// page. `extractTitle` now clamps, so publish stays a 200 and the page lists
// with a title that fits. (Needs a larger `maxBytes` than the shared apps do:
// the document carries the oversized title.)
test("a title over the KV metadata budget still publishes and lists, clamped", async () => {
  const app = makeApp(
    { zone: ZONE, maxBytes: 4096 },
    Layer.mergeAll(
      StorageMemory,
      IndexMemory,
      AuthAccounts(memoryKeys(), identify),
      AliasesMemory,
      QuotaMemory()
    )
  )
  const key = await keyFor(app, GITHUB_TOKEN)
  const doc = `<html><head><title>${"T".repeat(1000)}</title></head><body>hi</body></html>`
  const hash = await hashOf(doc)
  expect((await publishAs(app, key, hash, doc)).status).toBe(200)

  const listed = (await (await listPages(app, key)).json()) as {
    pages: ReadonlyArray<{ hash: string; title: string }>
  }
  expect(listed.pages.map((p) => p.hash)).toEqual([hash])
  expect(new TextEncoder().encode(listed.pages[0]!.title).length).toBeLessThanOrEqual(256)
})
