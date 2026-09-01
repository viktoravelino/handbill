import { beforeEach, expect, test } from "bun:test"
import { HandbillApi } from "@handbill/contract"
import { Effect, Layer } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { AliasesDisabled, AliasesMemory } from "./aliases"
import { makeApp } from "./app"
import { hashBytes } from "./hash"
import { AuthSecret } from "./auth"
import { IndexBucket, StorageMemory } from "./storage"

const ZONE = "example.dev"
const TOKEN = "s3cret"
const MAX_BYTES = 64

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string) => Effect.runPromise(hashBytes(bytes(text)))

let app: ReturnType<typeof makeApp>

beforeEach(() => {
  app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      IndexBucket.pipe(Layer.provideMerge(StorageMemory)),
      AuthSecret(TOKEN),
      AliasesMemory
    )
  )
})

const publish = (hash: string, body: string, token: string | null = TOKEN) =>
  app.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${hash}`, {
      method: "PUT",
      body: bytes(body),
      headers: {
        "content-type": "text/html",
        ...(token === null ? {} : { authorization: `Bearer ${token}` })
      }
    })
  )

const api = (path: string, init?: RequestInit) =>
  app.fetch(
    new Request(`https://api.${ZONE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...init?.headers }
    })
  )

const DOC = "<html><head><title>Plan</title></head><body>hi</body></html>"

test("health reports the mode and the zone without a token", async () => {
  const response = await app.fetch(new Request(`https://api.${ZONE}/v1/health`))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, mode: "secret", zone: ZONE })
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("publishing returns the page URL and serves the document", async () => {
  const hash = await hashOf(DOC)
  const published = await publish(hash, DOC)
  expect(published.status).toBe(200)
  expect(await published.json()).toEqual({ hash, url: `https://${hash}.${ZONE}`, created: true })

  const page = await app.fetch(new Request(`https://${hash}.${ZONE}/`))
  expect(page.status).toBe(200)
  expect(await page.text()).toBe(DOC)
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(page.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow")
})

test("every path on a hash hostname serves the same document", async () => {
  const hash = await hashOf(DOC)
  await publish(hash, DOC)
  const deep = await app.fetch(new Request(`https://${hash}.${ZONE}/anything/at/all?x=1`))
  expect(deep.status).toBe(200)
  expect(await deep.text()).toBe(DOC)
})

test("publishing the same bytes twice creates nothing new", async () => {
  const hash = await hashOf(DOC)
  await publish(hash, DOC)
  const again = await publish(hash, DOC)
  expect(again.status).toBe(200)
  expect(await again.json()).toEqual({ hash, url: `https://${hash}.${ZONE}`, created: false })

  const listed = await (await api("/v1/pages")).json()
  expect(listed).toEqual({
    pages: [
      {
        hash,
        url: `https://${hash}.${ZONE}`,
        title: "Plan",
        publishedAt: expect.any(String),
        size: DOC.length
      }
    ]
  })
})

test("a hash that is not the hash of the bytes is a 400 naming the right one", async () => {
  const wrong = "000000000000"
  const response = await publish(wrong, DOC)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ _tag: "HashMismatch", expected: await hashOf(DOC) })
})

test("a document over the cap is a 413 naming the cap", async () => {
  const big = "x".repeat(MAX_BYTES + 1)
  const response = await publish(await hashOf(big), big)
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ _tag: "TooLarge", maxBytes: MAX_BYTES })
})

test("publishing without a usable token is a 401", async () => {
  expect((await publish(await hashOf(DOC), DOC, null)).status).toBe(401)
  expect((await publish(await hashOf(DOC), DOC, "wrong")).status).toBe(401)
  expect((await app.fetch(new Request(`https://api.${ZONE}/v1/pages`))).status).toBe(401)
})

test("removing is idempotent and the page stops being served", async () => {
  const hash = await hashOf(DOC)
  await publish(hash, DOC)
  expect((await api(`/v1/pages/${hash}`, { method: "DELETE" })).status).toBe(204)
  expect((await api(`/v1/pages/${hash}`, { method: "DELETE" })).status).toBe(204)

  const page = await app.fetch(new Request(`https://${hash}.${ZONE}/`))
  expect(page.status).toBe(404)
  expect(page.headers.get("cache-control")).toBe("no-store")
})

test("a zone configured as a fully qualified name is canonical everywhere", async () => {
  const fq = makeApp(
    { zone: "Example.dev.", maxBytes: MAX_BYTES },
    Layer.mergeAll(
      IndexBucket.pipe(Layer.provideMerge(StorageMemory)),
      AuthSecret(TOKEN),
      AliasesMemory
    )
  )
  const hash = await hashOf(DOC)
  const published = await fq.fetch(
    new Request(`https://api.${ZONE}/v1/pages/${hash}`, {
      method: "PUT",
      body: bytes(DOC),
      headers: { "content-type": "text/html", authorization: `Bearer ${TOKEN}` }
    })
  )
  expect(await published.json()).toEqual({ hash, url: `https://${hash}.${ZONE}`, created: true })

  const health = await fq.fetch(new Request(`https://api.${ZONE}/v1/health`))
  expect(await health.json()).toEqual({ ok: true, mode: "secret", zone: ZONE })
})

test("the apex, an unset name and an unpublished hash are all nothing", async () => {
  for (const url of [`https://${ZONE}/`, `https://www.${ZONE}/`, `https://a3f9c1d4e2b8.${ZONE}/`]) {
    const response = await app.fetch(new Request(url))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Nothing here\n")
  }
})

// Short on purpose: `DOC` plus a version marker would be over `MAX_BYTES`.
const OTHER = "<html><title>Plan v2</title>hello</html>"

const setAlias = (name: string, hash: string) =>
  api(`/v1/aliases/${name}`, {
    method: "PUT",
    body: JSON.stringify({ hash }),
    headers: { "content-type": "application/json" }
  })

// S2.2: the name is what a reader keeps, the hash is what never moves.
test("an alias serves the page it points at, and follows it when it moves", async () => {
  const first = await hashOf(DOC)
  const second = await hashOf(OTHER)
  await publish(first, DOC)
  await publish(second, OTHER)

  const set = await setAlias("plan", first)
  expect(set.status).toBe(200)
  expect(await set.json()).toEqual({ name: "plan", hash: first, url: `https://plan.${ZONE}` })

  const page = await app.fetch(new Request(`https://plan.${ZONE}/anything`))
  expect(page.status).toBe(200)
  expect(await page.text()).toBe(DOC)
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(page.headers.get("cache-control")).toBe("public, max-age=60")
  expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow")

  await setAlias("plan", second)
  expect(await (await app.fetch(new Request(`https://plan.${ZONE}/`))).text()).toBe(OTHER)

  // The old link is still the old bytes, cached as if nothing had happened.
  const old = await app.fetch(new Request(`https://${first}.${ZONE}/`))
  expect(await old.text()).toBe(DOC)
  expect(old.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
})

test("aliases are listed with their URLs and removing one is idempotent", async () => {
  const hash = await hashOf(DOC)
  await publish(hash, DOC)
  await setAlias("plan", hash)
  await setAlias("notes", hash)

  expect(await (await api("/v1/aliases")).json()).toEqual({
    aliases: [
      { name: "notes", hash, url: `https://notes.${ZONE}` },
      { name: "plan", hash, url: `https://plan.${ZONE}` }
    ]
  })

  expect((await api("/v1/aliases/plan", { method: "DELETE" })).status).toBe(204)
  expect((await api("/v1/aliases/plan", { method: "DELETE" })).status).toBe(204)
  expect((await app.fetch(new Request(`https://plan.${ZONE}/`))).status).toBe(404)
})

// `api` is the API's own hostname and a 12-hex name is a hash: neither could
// ever be resolved as an alias, so the contract refuses to store them.
test.each(["api", "a3f9c1d4e2b8", "-plan", "plan.v2"])(
  "%s is not a name an alias can have",
  async (name) => {
    expect((await setAlias(name, await hashOf(DOC))).status).toBe(400)
  }
)

// The route #95 asked for: a name read by key, not out of the lagging listing.
test("an alias can be read by name, and an unset name is a 404", async () => {
  const hash = await hashOf(DOC)
  await publish(hash, DOC)
  await setAlias("plan", hash)

  const read = await api("/v1/aliases/plan")
  expect(read.status).toBe(200)
  expect(await read.json()).toEqual({ name: "plan", hash, url: `https://plan.${ZONE}` })
  expect((await api("/v1/aliases/notes")).status).toBe(404)
})

test("without a KV binding the whole alias feature is absent", async () => {
  const off = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      IndexBucket.pipe(Layer.provideMerge(StorageMemory)),
      AuthSecret(TOKEN),
      AliasesDisabled
    )
  )
  const request = (path: string, init?: RequestInit) =>
    off.fetch(
      new Request(`https://api.${ZONE}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, ...init?.headers }
      })
    )

  for (const response of [
    await request("/v1/aliases"),
    await request("/v1/aliases/plan"),
    await request("/v1/aliases/plan", { method: "DELETE" }),
    await request("/v1/aliases/plan", {
      method: "PUT",
      body: JSON.stringify({ hash: await hashOf(DOC) }),
      headers: { "content-type": "application/json" }
    })
  ]) {
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ _tag: "NotFound" })
  }

  expect((await off.fetch(new Request(`https://plan.${ZONE}/`))).status).toBe(404)
})

// Accounts are the opt-in aliases are: no binding, no keys. The Worker that
// does have one is `accounts.test.ts`.
test("without an ACCOUNTS binding there are no keys to mint or revoke", async () => {
  const minted = await api("/v1/keys", {
    method: "POST",
    body: JSON.stringify({ githubToken: "gho_anything" }),
    headers: { "content-type": "application/json" }
  })
  expect(minted.status).toBe(404)
  expect(await minted.json()).toEqual({ _tag: "NotFound" })
  expect((await api("/v1/keys/current", { method: "DELETE" })).status).toBe(404)
})

// The spec is the contract's, not a second description of the API kept in the
// Worker: `OpenApi.fromApi` here is the same call the route makes, and the
// contract's own snapshot test is what keeps that document honest.
test("the spec is served from the contract, with no token", async () => {
  const response = await app.fetch(new Request(`https://api.${ZONE}/v1/openapi.json`))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("cache-control")).toBe("public, max-age=300")
  expect(await response.json()).toEqual(JSON.parse(JSON.stringify(OpenApi.fromApi(HandbillApi))))
})

// The page carries no description of the API — it points Scalar at the spec
// route, so the two can never drift apart.
test("the docs page renders and needs no token", async () => {
  const response = await app.fetch(new Request(`https://api.${ZONE}/docs`))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(response.headers.get("cache-control")).toBe("public, max-age=300")
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")

  const page = await response.text()
  expect(page).toContain("@scalar/api-reference@1.67.0/")
  expect(page).toContain('{ url: "/v1/openapi.json" }')
})
