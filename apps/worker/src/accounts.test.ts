import { describe, expect, test } from "bun:test"
import { Key, Owner, Unauthorized } from "@handbill/contract"
import { Effect, Layer, Schema } from "effect"
import { AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, githubOwner, type Identify, type KeyStore } from "./auth"
import { hashBytes } from "./hash"
import { StorageMemory } from "./storage"

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

const memoryKeys = (): KeyStore => {
  const records = new Map<string, string>()
  return {
    get: (key): Promise<unknown> => Promise.resolve(JSON.parse(records.get(key) ?? "null")),
    put: (key, value): Promise<void> => Promise.resolve(void records.set(key, value))
  }
}

/** The one GitHub token these tests know. Anything else is a token GitHub refused. */
const GITHUB_TOKEN = "gho_from-the-device-flow"
const OWNER = Owner.make("gh:4242")
const identify: Identify = (githubToken) =>
  githubToken === GITHUB_TOKEN ? Effect.succeed(OWNER) : Effect.fail(new Unauthorized())

const hosted = () =>
  makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(StorageMemory, AuthAccounts(memoryKeys(), identify), AliasesMemory)
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

const publishAs = (app: App, key: string, hash: string) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${hash}`, {
      method: "PUT",
      body: bytes(DOC),
      headers: { "content-type": "text/html", authorization: `Bearer ${key}` }
    })
  )

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
