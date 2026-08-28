import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { hashDocument } from "../src/hash"
import { configHome, run, type RunOptions } from "./harness"
import { makeServer, TOKEN, ZONE } from "./server"

const document = "<!doctype html><title>Quarter plan</title><p>Hello.</p>"
const bytes = new TextEncoder().encode(document)
const hash = hashDocument(bytes)

const files = mkdtempSync(join(tmpdir(), "handbill-docs-"))
const plan = join(files, "plan.html")
writeFileSync(plan, document)

let server = makeServer()
afterAll(() => server.dispose())

beforeEach(() => {
  server.dispose()
  server = makeServer()
})

/** The CLI as a configured user runs it, talking to the in-process server. */
const cli = (
  args: ReadonlyArray<string>,
  options: Omit<RunOptions, "http" | "env"> & {
    readonly env?: Record<string, string | undefined>
  } = {}
) =>
  run(args, {
    ...options,
    http: server.layer,
    env: {
      XDG_CONFIG_HOME: configHome(),
      HANDBILL_ENDPOINT: "http://handbill.test",
      HANDBILL_TOKEN: TOKEN,
      ...options.env
    }
  })

describe("publish", () => {
  // S1.1
  test("prints one URL and nothing else", async () => {
    const outcome = await cli([plan])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([`https://${hash}.${ZONE}`])
    expect(outcome.stderr).toEqual([])
  })

  // S1.1: same bytes, same URL, and the second publish is not a create.
  test("is idempotent for the same bytes", async () => {
    const first = await cli([plan, "--json"])
    const second = await cli([plan, "--json"])
    expect(JSON.parse(first.stdout[0] ?? "")).toEqual({
      hash,
      url: `https://${hash}.${ZONE}`,
      created: true
    })
    expect(JSON.parse(second.stdout[0] ?? "")).toEqual({
      hash,
      url: `https://${hash}.${ZONE}`,
      created: false
    })
  })

  // S1.2
  test("reads stdin when the argument is -", async () => {
    const outcome = await cli(["-"], { stdin: document })
    expect(outcome.stdout).toEqual([`https://${hash}.${ZONE}`])
    expect(server.hashes()).toEqual([hash])
  })

  // S1.3
  test("reports a rejected token on stderr and exits non-zero", async () => {
    const outcome = await cli([plan], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("rejected the token")
  })

  test("reports a rejected token as JSON on stderr with --json", async () => {
    const outcome = await cli([plan, "--json"], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(JSON.parse(outcome.stderr[0] ?? "")).toMatchObject({ error: "Unauthorized" })
  })

  test("says what to configure when there is no endpoint", async () => {
    const outcome = await run([plan], {
      http: server.layer,
      env: { XDG_CONFIG_HOME: configHome() }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("No endpoint configured")
  })
})

describe("list", () => {
  // S1.4
  test("prints one line per page with its title", async () => {
    await cli([plan])
    const outcome = await cli(["list"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toHaveLength(1)
    expect(outcome.stdout[0]).toContain(`https://${hash}.${ZONE}`)
    expect(outcome.stdout[0]).toContain("Quarter plan")
  })

  test("prints the wire shape with --json", async () => {
    await cli([plan])
    const outcome = await cli(["list", "--json"])
    const body = JSON.parse(outcome.stdout[0] ?? "")
    expect(body.pages).toHaveLength(1)
    expect(body.pages[0]).toMatchObject({ hash, title: "Quarter plan" })
    expect(typeof body.pages[0].publishedAt).toBe("string")
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
    await cli([plan])
    const first = await cli(["remove", `https://${hash}.${ZONE}`])
    const second = await cli(["remove", `https://${hash}.${ZONE}`])
    expect(first.ok && second.ok).toBe(true)
    expect(first.stdout).toEqual([hash])
    expect(server.hashes()).toEqual([])
  })

  test("accepts a bare hash", async () => {
    await cli([plan])
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
})

describe("completions", () => {
  test("prints a script for the shell it was asked for", async () => {
    const outcome = await cli(["completions", "zsh"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout.join("\n")).toContain("#compdef handbill")
  })
})
