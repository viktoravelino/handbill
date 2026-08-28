import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { hashDocument } from "../src/hash"
import { configHome, run, type RunOptions } from "./harness"
import { makeServer, PUBLISHED_AT, TOKEN, ZONE } from "./server"

const files = mkdtempSync(join(tmpdir(), "handbill-docs-"))

/** A document on disk, with the hash and URL the CLI should end up printing for it. */
const document = (name: string, html: string) => {
  const path = join(files, name)
  writeFileSync(path, html)
  const hash = hashDocument(new TextEncoder().encode(html))
  return { path, html, hash, url: `https://${hash}.${ZONE}` }
}

const plan = document("plan.html", "<!doctype html><title>Quarter plan</title><p>Hello.</p>")
const kickoff = document("kickoff.html", "<!doctype html><title>Kickoff</title>")
const retro = document("retro.html", "<!doctype html><title>Retro</title>")

const { hash, url } = plan

let server = makeServer()
afterAll(() => server.dispose())

beforeEach(() => {
  server.dispose()
  server = makeServer()
})

/** A transport where every request fails, standing in for an endpoint that is down. */
const unreachableFetch: typeof globalThis.fetch = Object.assign(
  () => Promise.reject(new Error("ECONNREFUSED")),
  { preconnect: () => Promise.resolve() }
)
const unreachable = Layer.succeed(FetchHttpClient.Fetch, unreachableFetch).pipe(
  Layer.merge(FetchHttpClient.layer)
)

/** The CLI as a configured user runs it, talking to the in-process server. */
const cli = (
  args: ReadonlyArray<string>,
  options: Omit<RunOptions, "http" | "env"> & {
    readonly env?: Record<string, string | undefined>
    /** Defaults to the in-process server; override to test an endpoint that is down. */
    readonly http?: RunOptions["http"]
  } = {}
) =>
  run(args, {
    ...options,
    http: options.http ?? server.layer,
    env: {
      XDG_CONFIG_HOME: configHome(),
      HANDBILL_ENDPOINT: `https://api.${ZONE}`,
      HANDBILL_TOKEN: TOKEN,
      ...options.env
    }
  })

describe("publish", () => {
  // S1.1
  test("prints one URL and nothing else", async () => {
    const outcome = await cli([plan.path])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([url])
    expect(outcome.stderr).toEqual([])
  })

  // S1.1: same bytes, same URL, and the second publish is not a create.
  test("is idempotent for the same bytes", async () => {
    const first = await cli([plan.path, "--json"])
    const second = await cli([plan.path, "--json"])
    expect(JSON.parse(first.stdout[0] ?? "")).toEqual({
      hash,
      url,
      created: true
    })
    expect(JSON.parse(second.stdout[0] ?? "")).toEqual({
      hash,
      url,
      created: false
    })
  })

  // S1.2
  test("reads stdin when the argument is -", async () => {
    const outcome = await cli(["-"], { stdin: plan.html })
    expect(outcome.stdout).toEqual([url])
    expect(server.hashes()).toEqual([hash])
  })

  // S1.3
  test("reports a rejected token on stderr and exits non-zero", async () => {
    const outcome = await cli([plan.path], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("rejected the token")
  })

  test("reports a rejected token as JSON on stderr with --json", async () => {
    const outcome = await cli([plan.path, "--json"], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(JSON.parse(outcome.stderr[0] ?? "")).toMatchObject({ error: "Unauthorized" })
  })

  test("says what to configure when there is no endpoint", async () => {
    const outcome = await run([plan.path], {
      http: server.layer,
      env: { XDG_CONFIG_HOME: configHome() }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("No endpoint configured")
  })
})

describe("list", () => {
  // S1.4: one line per page, newest first — the order is the Worker's, not the
  // order the store happens to iterate in. The clock moves a day between
  // publishes, so every page is unambiguously newer than the one before it and
  // the printed date says which is which.
  test("prints one line per page, newest first, with its title", async () => {
    await cli([kickoff.path])
    server.advance("1 day")
    await cli([retro.path])
    server.advance("1 day")
    await cli([plan.path])

    const outcome = await cli(["list"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([
      `2026-01-17  ${url}  Quarter plan`,
      `2026-01-16  ${retro.url}  Retro`,
      `2026-01-15  ${kickoff.url}  Kickoff`
    ])
  })

  test("prints the wire shape with --json", async () => {
    await cli([plan.path])
    const outcome = await cli(["list", "--json"])
    const body = JSON.parse(outcome.stdout[0] ?? "")
    expect(body.pages).toHaveLength(1)
    expect(body.pages[0]).toEqual({
      hash,
      url,
      title: "Quarter plan",
      publishedAt: PUBLISHED_AT,
      size: plan.html.length
    })
  })

  test("says nothing on stdout when there is nothing published", async () => {
    const outcome = await cli(["list"])
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr).toEqual(["No pages published."])
  })
})

describe("remove", () => {
  // S1.5
  test("accepts a URL and is idempotent", async () => {
    await cli([plan.path])
    const first = await cli(["remove", url])
    const second = await cli(["remove", url])
    expect(first.ok && second.ok).toBe(true)
    // Both calls report the same removal: the second is a no-op, not an error.
    expect(first.stdout).toEqual([hash])
    expect(second.stdout).toEqual([hash])
    expect(server.hashes()).toEqual([])
  })

  test("accepts a bare hash", async () => {
    await cli([plan.path])
    const outcome = await cli(["remove", hash, "--json"])
    expect(JSON.parse(outcome.stdout[0] ?? "")).toEqual({ hash, removed: true })
  })

  test("refuses anything that is not a hash or a URL", async () => {
    const outcome = await cli(["remove", "plan.html"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("not a handbill URL")
  })
})

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
      http: server.layer,
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

describe("completions", () => {
  test("prints a script for the shell it was asked for", async () => {
    const outcome = await cli(["completions", "zsh"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout.join("\n")).toContain("#compdef handbill")
  })

  // S1.3 asks for `--json` on every command, so this one wraps its script.
  test("wraps the script in an object under --json", async () => {
    const outcome = await cli(["completions", "zsh", "--json"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toHaveLength(1)
    expect(JSON.parse(outcome.stdout[0] ?? "").script).toContain("#compdef handbill")
  })
})
