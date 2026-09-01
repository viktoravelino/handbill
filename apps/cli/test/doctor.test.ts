import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { session } from "./fixtures"
import { configHome, run } from "./harness"

/** The round-trips for `src/doctor.ts`: what the five checks report, and when they are skipped. */

const { cli } = session()

/** A transport where every request fails, standing in for an endpoint that is down. */
const unreachableFetch: typeof globalThis.fetch = Object.assign(
  () => Promise.reject(new Error("ECONNREFUSED")),
  { preconnect: () => Promise.resolve() }
)
const unreachable = Layer.succeed(FetchHttpClient.Fetch, unreachableFetch).pipe(
  Layer.merge(FetchHttpClient.layer)
)

/**
 * A transport that answers `/v1/health` and records what every request carried,
 * so a test can assert on the `Authorization` headers `doctor` put on the wire
 * rather than only on what it printed. Health has to succeed for `auth` to run
 * at all, which the in-process Worker cannot do for a hostname off its zone.
 */
const recording = () => {
  const sent: Array<{ readonly path: string; readonly authorization: string | null }> = []
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      sent.push({ path: url.pathname, authorization: request.headers.get("authorization") })
      return Promise.resolve(
        url.pathname === "/v1/health"
          ? Response.json({ ok: true, mode: "accounts", zone: "handbill.dev" })
          : new Response(null, { status: 404 })
      )
    },
    { preconnect: () => Promise.resolve() }
  )
  return {
    layer: Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer)),
    sent
  }
}

describe("doctor", () => {
  // S1.7
  test("passes every check against a working endpoint", async () => {
    const outcome = await cli(["doctor", "--json"])
    expect(outcome.ok).toBe(true)
    const { checks } = JSON.parse(outcome.stdout[0] ?? "")
    expect(checks.map((check: { name: string }) => check.name)).toEqual([
      "config",
      "token",
      "health",
      "auth",
      "tls"
    ])
    expect(checks.every((check: { status: string }) => check.status === "ok")).toBe(true)
  })

  // With no configuration there is still an endpoint — the hosted default — so
  // `config` reports it and the key is the only thing missing.
  test("blames the missing key, not the endpoint, with no configuration", async () => {
    const outcome = await run(["doctor"], {
      http: unreachable,
      env: { XDG_CONFIG_HOME: configHome() }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout.join("\n")).toContain("ok    config  Endpoint https://api.handbill.dev")
    expect(outcome.stdout.join("\n")).toContain("FAIL  token")
    expect(outcome.stdout.join("\n")).toContain("handbill login")
    expect(outcome.stderr.join("\n")).toContain("check(s) failed")
  })

  test("reports a token the endpoint refuses", async () => {
    const outcome = await cli(["doctor", "--json"], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    const { checks } = JSON.parse(outcome.stdout[0] ?? "")
    expect(checks.find((check: { name: string }) => check.name === "auth")).toMatchObject({
      status: "FAIL"
    })
  })
  // One FAIL, not three: an endpoint nothing answers on says nothing about the
  // token or the certificate, so those are unknowable rather than broken.
  test("blames only health when nothing answers", async () => {
    const outcome = await cli(["doctor", "--json"], { http: unreachable })
    expect(outcome.ok).toBe(false)
    const { checks } = JSON.parse(outcome.stdout[0] ?? "")
    expect(
      checks.map((check: { name: string; status: string }) => `${check.status} ${check.name}`)
    ).toEqual(["ok config", "ok token", "FAIL health", "skip auth", "skip tls"])
  })
})

describe("doctor and a token it may not send", () => {
  // `doctor` is what someone runs *because* publishing just refused them, so it
  // has to report that state without reproducing the leak: no probe, no bearer,
  // and the same sentence the refusal gives.
  test("reports it instead of sending it", async () => {
    const transport = recording()
    const outcome = await run(["doctor", "--json"], {
      http: transport.layer,
      env: { XDG_CONFIG_HOME: configHome(JSON.stringify({ token: "publish-me-self-hosted" })) }
    })
    expect(outcome.ok).toBe(false)
    const { checks } = JSON.parse(outcome.stdout[0] ?? "")
    expect(checks.find((check: { name: string }) => check.name === "auth")).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("no endpoint was named")
    })
    expect(transport.sent.some((request) => request.path === "/v1/pages")).toBe(false)
    expect(transport.sent.every((request) => request.authorization === null)).toBe(true)
  })
})
