import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { session } from "./fixtures"
import { configHome, run } from "./harness"

/** The round-trips for `src/doctor.ts`: what the five checks report, and when they are skipped. */

const { cli, server } = session()

/** A transport where every request fails, standing in for an endpoint that is down. */
const unreachableFetch: typeof globalThis.fetch = Object.assign(
  () => Promise.reject(new Error("ECONNREFUSED")),
  { preconnect: () => Promise.resolve() }
)
const unreachable = Layer.succeed(FetchHttpClient.Fetch, unreachableFetch).pipe(
  Layer.merge(FetchHttpClient.layer)
)

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

  test("fails, and skips what it cannot reach, with no configuration", async () => {
    const outcome = await run(["doctor"], {
      http: server().layer,
      env: { XDG_CONFIG_HOME: configHome() }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout.join("\n")).toContain("FAIL  config")
    expect(outcome.stdout.join("\n")).toContain("skip  health")
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
