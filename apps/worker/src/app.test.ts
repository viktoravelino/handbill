import { beforeEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { makeApp } from "./app"
import { hashBytes } from "./hash"
import { AuthSecret, StorageMemory } from "./services"

const ZONE = "example.dev"
const TOKEN = "s3cret"
const MAX_BYTES = 64

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string) => Effect.runPromise(hashBytes(bytes(text)))

let app: ReturnType<typeof makeApp>

beforeEach(() => {
  app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(StorageMemory, AuthSecret(TOKEN))
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
    Layer.mergeAll(StorageMemory, AuthSecret(TOKEN))
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

test("the apex, www and an unpublished hash are all nothing", async () => {
  for (const url of [`https://${ZONE}/`, `https://www.${ZONE}/`, `https://a3f9c1d4e2b8.${ZONE}/`]) {
    const response = await app.fetch(new Request(url))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Nothing here\n")
  }
})
