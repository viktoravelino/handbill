import { describe, expect, test } from "bun:test"
import { hashDocument } from "../src/hash"
import { kickoff, notes, plan, retro, session } from "./fixtures"
import { configHome, run } from "./harness"
import { PUBLISHED_AT, ZONE } from "./server"

/** The round-trips for the three commands in `src/pages.ts`: publish, list, remove. */

const { cli, server } = session()
const { hash, url } = plan

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
    expect(server().hashes()).toEqual([hash])
  })
})

describe("publish markdown", () => {
  // S2.1: the Worker only ever stores HTML, so what is published is the page the
  // CLI rendered — and `list` labels it with the H1, not the filename.
  test("renders a markdown file and publishes the page", async () => {
    const outcome = await cli([notes.path])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([notes.url])
    expect(server().hashes()).toEqual([notes.hash])

    const listed = await cli(["list"])
    expect(listed.stdout).toEqual([`2026-01-15  ${notes.url}  Weekly notes`])
  })

  // S2.1: stdin has no extension to read, so the flag is what says "markdown".
  test("renders stdin only when told to", async () => {
    const asMarkdown = await cli(["-", "--markdown"], { stdin: notes.source })
    // `-` has no filename to fall back to, but this source has an H1.
    expect(asMarkdown.stdout).toEqual([notes.url])

    const asBytes = await cli(["-"], { stdin: notes.source })
    expect(asBytes.stdout).toEqual([
      `https://${hashDocument(new TextEncoder().encode(notes.source))}.${ZONE}`
    ])
  })
})

describe("publish errors", () => {
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
      http: server().layer,
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
    server().advance("1 day")
    await cli([retro.path])
    server().advance("1 day")
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
      size: plan.bytes.length
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
    expect(server().hashes()).toEqual([])
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
