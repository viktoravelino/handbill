import { expect, test } from "bun:test"
import { Key, Owner, Unauthorized } from "@handbill/contract"
import { Effect, Layer, Schema } from "effect"
import { AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, type Identify, type KeyStore } from "./auth"
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
  const revoke = () =>
    app.fetch(
      new Request(`https://api.${ZONE}/v1/keys/current`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${key}` }
      })
    )

  expect((await revoke()).status).toBe(204)
  expect((await publishAs(app, key, await hashOf(DOC))).status).toBe(401)
  // Revoking twice is a 401, not a second 204: the key it names stopped being
  // one at the first call. What is idempotent is the record — the revocation is
  // written once and never fails on a key that already carries it.
  expect((await revoke()).status).toBe(401)
})
