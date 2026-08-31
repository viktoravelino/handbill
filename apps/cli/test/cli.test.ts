import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { hashDocument } from "../src/hash"
import { render } from "../src/markdown"
import { configHome, run, type RunOptions } from "./harness"
import { makeServer, PUBLISHED_AT, TOKEN, ZONE } from "./server"

const files = mkdtempSync(join(tmpdir(), "handbill-docs-"))

/** A document on disk, with the hash and URL the CLI should end up printing for it. */
const document = (name: string, html: string) => {
  const path = join(files, name)
  writeFileSync(path, html)
  // The bytes, not the string: `hash` and the stored `size` are both about what
  // goes over the wire, which is not the number of UTF-16 code units.
  const bytes = new TextEncoder().encode(html)
  const hash = hashDocument(bytes)
  return { path, html, bytes, hash, url: `https://${hash}.${ZONE}` }
}

const plan = document("plan.html", "<!doctype html><title>Quarter plan</title><p>Hello.</p>")

/** A markdown source on disk, with the page the CLI is expected to render from it. */
const markdown = (name: string, source: string) => {
  const path = join(files, name)
  writeFileSync(path, source)
  const bytes = new TextEncoder().encode(render(source, path))
  const hash = hashDocument(bytes)
  return { path, source, bytes, hash, url: `https://${hash}.${ZONE}` }
}

const notes = markdown("notes.md", "# Weekly notes\n\nShipped the CLI.\n")
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

/**
 * The in-process server with one call handed to `instead` — another server, or a
 * rejection standing in for a connection that drops. A command that rotates
 * several calls is only half specified by its happy path: this is how the tests
 * reach what `update` does when a call after the publish fails.
 */
const broken = (
  fails: (request: Request) => boolean,
  instead: (request: Request) => ReturnType<typeof server.transport>
) => {
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      return fails(request) ? instead(request) : server.transport(request)
    },
    { preconnect: () => Promise.resolve() }
  )
  return Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer))
}

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

  // S2.1: the Worker only ever stores HTML, so what is published is the page the
  // CLI rendered — and `list` labels it with the H1, not the filename.
  test("renders a markdown file and publishes the page", async () => {
    const outcome = await cli([notes.path])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([notes.url])
    expect(server.hashes()).toEqual([notes.hash])

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

describe("alias", () => {
  const planUrl = `https://plan.${ZONE}`

  // S2.2: one line, the alias URL — and the Worker really serves the page there.
  test("points a name at a page and prints the alias URL", async () => {
    await cli([plan.path])
    const outcome = await cli(["alias", "plan", url])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([planUrl])
    expect(outcome.stderr).toEqual([])
    expect(await (await server.fetch(`${planUrl}/`)).text()).toBe(plan.html)
  })

  test("accepts a bare hash and prints the wire shape with --json", async () => {
    await cli([plan.path])
    const outcome = await cli(["alias", "plan", hash, "--json"])
    expect(JSON.parse(outcome.stdout[0] ?? "")).toEqual({ name: "plan", hash, url: planUrl })
  })

  test("refuses a name the contract would not store", async () => {
    const outcome = await cli(["alias", "api", hash])
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("not a name an alias can have")
  })

  test("lists aliases by name, URL then hash", async () => {
    const empty = await cli(["alias", "list"])
    expect(empty.stdout).toEqual([])
    expect(empty.stderr).toEqual(["No aliases set."])

    await cli([plan.path])
    await cli(["alias", "plan", hash])
    await cli(["alias", "notes", hash])
    const outcome = await cli(["alias", "list"])
    expect(outcome.stdout).toEqual([`https://notes.${ZONE}  ${hash}`, `${planUrl}  ${hash}`])

    const asJson = await cli(["alias", "list", "--json"])
    expect(JSON.parse(asJson.stdout[0] ?? "")).toEqual({
      aliases: [
        { name: "notes", hash, url: `https://notes.${ZONE}` },
        { name: "plan", hash, url: planUrl }
      ]
    })
  })

  test("removes a name, idempotently, and leaves the page published", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])
    const first = await cli(["alias", "remove", "plan"])
    const second = await cli(["alias", "remove", "plan", "--json"])
    expect(first.ok && second.ok).toBe(true)
    expect(first.stdout).toEqual(["plan"])
    expect(JSON.parse(second.stdout[0] ?? "")).toEqual({ name: "plan", removed: true })
    expect((await server.fetch(`${planUrl}/`)).status).toBe(404)
    expect(server.hashes()).toEqual([hash])
  })

  // On a deployment with no KV binding the feature is absent, not empty, and
  // the CLI says how to switch it on rather than reporting a missing name.
  test("says how to enable aliases when the deployment has none", async () => {
    const off = makeServer({ aliases: false })
    try {
      const outcome = await cli(["alias", "list", "--json"], { http: off.layer })
      expect(outcome.ok).toBe(false)
      expect(outcome.stdout).toEqual([])
      expect(JSON.parse(outcome.stderr[0] ?? "")).toEqual({
        error: "NotFound",
        message: expect.stringContaining("ALIASES")
      })
    } finally {
      await off.dispose()
    }
  })
})

describe("update", () => {
  const planUrl = `https://plan.${ZONE}`

  // The whole rotation, and the order it happens in: the new page is up before
  // any name moves, and the old hash goes last, so a reader following `plan`
  // never meets a 404 in between.
  test("publishes, re-points the names and removes the old hash, in that order", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])

    const from = server.requests().length
    const outcome = await cli(["update", url, retro.path])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([retro.url])
    expect(server.requests().slice(from)).toEqual([
      `PUT /v1/pages/${retro.hash}`,
      "GET /v1/aliases",
      "PUT /v1/aliases/plan",
      `DELETE /v1/pages/${hash}`
    ])

    expect(server.hashes()).toEqual([retro.hash])
    expect(await (await server.fetch(`${planUrl}/`)).text()).toBe(retro.html)
    expect((await server.fetch(`${url}/`)).status).toBe(404)
  })

  // Only the aliases that named the old page move; the rest stay where they are.
  test("reports what it moved with --json, and leaves other aliases alone", async () => {
    await cli([plan.path])
    await cli([kickoff.path])
    await cli(["alias", "plan", hash])
    await cli(["alias", "kickoff", kickoff.hash])

    const outcome = await cli(["update", hash, retro.path, "--json"])
    expect(JSON.parse(outcome.stdout[0] ?? "")).toEqual({
      hash: retro.hash,
      url: retro.url,
      created: true,
      removed: true,
      aliases: ["plan"]
    })
    expect(outcome.stderr).toEqual([`Re-pointed plan at ${retro.hash}.`, `Removed ${hash}.`])
    expect(await (await server.fetch(`https://kickoff.${ZONE}/`)).text()).toBe(kickoff.html)
  })

  // Updating a page to the bytes it already has is a no-op, not a way to
  // unpublish it: the hash is the same, so removing it would delete the page.
  test("does nothing when the bytes are unchanged", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])

    const from = server.requests().length
    const outcome = await cli(["update", url, plan.path, "--json"])
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toEqual({
      hash,
      url,
      created: false,
      removed: false,
      aliases: []
    })
    expect(server.requests().slice(from)).toEqual([`PUT /v1/pages/${hash}`])
    expect(server.hashes()).toEqual([hash])
    expect(await (await server.fetch(`${planUrl}/`)).text()).toBe(plan.html)
  })

  // Aliases off is not a failed update: there is nothing to re-point, so the
  // notice goes to stderr and the rotation finishes.
  test("says aliases are off and finishes the rotation anyway", async () => {
    const off = makeServer({ aliases: false })
    try {
      await cli([plan.path], { http: off.layer })
      const outcome = await cli(["update", url, retro.path], { http: off.layer })
      expect(outcome.ok).toBe(true)
      expect(outcome.stdout).toEqual([retro.url])
      expect(outcome.stderr.join("\n")).toContain("ALIASES")
      expect(off.hashes()).toEqual([retro.hash])
    } finally {
      await off.dispose()
    }
  })

  // An alias URL is a handbill URL; it just is not the one `update` can act on.
  // Saying only "not a handbill URL" would deny the URL the user most likely
  // kept, so the sentence names the way out.
  test("refuses a target that is not a hash or a URL, and says what to pass instead", async () => {
    const outcome = await cli(["update", `https://plan.${ZONE}`, retro.path])
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("not a handbill URL")
    expect(outcome.stderr.join("\n")).toContain("handbill alias list")
  })

  // The page is permanent the moment the publish returns. Losing its URL
  // because the tidying-up failed would be the one unrecoverable outcome, so
  // the URL is on stderr even though the command exits non-zero.
  test("still says where the new page is when the removal fails", async () => {
    await cli([plan.path])
    const outcome = await cli(["update", url, retro.path], {
      // The connection drops on the removal, after the page is already up.
      http: broken(
        (request) => request.method === "DELETE",
        () => Promise.reject(new Error("ECONNRESET"))
      )
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr).toContain(`The new page is published at ${retro.url}.`)
    // Nothing was lost: the rotation stopped, so both pages are still up.
    expect(server.hashes().toSorted()).toEqual([retro.hash, hash].toSorted())
  })

  // A 404 from `alias set` is not the 404 that means "aliases are off": the
  // listing answered a moment earlier. Blaming the KV binding would send the
  // user to create one they already have.
  test("names the alias it could not move, rather than blaming the binding", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])
    // The 404 is a real one: a deployment with no KV binding answers every
    // alias route that way, and only the `set` is routed to it.
    const off = makeServer({ aliases: false })
    const outcome = await cli(["update", url, retro.path], {
      http: broken(
        (request) => request.method === "PUT" && request.url.includes("/aliases/"),
        (request) => off.transport(request)
      )
    }).finally(() => off.dispose())
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain('Could not point "plan" at the new page')
    expect(outcome.stderr.join("\n")).not.toContain("ALIASES KV binding")
    // The remove comes after the re-point, so the old page is still there for
    // the alias that still names it.
    expect(server.hashes()).toContain(hash)
  })
})

describe("--open", () => {
  // S2.4: the browser is a second reader of the URL; stdout is still one line.
  test("opens the printed URL, after printing it", async () => {
    const published = await cli([plan.path, "--open"])
    expect(published.stdout).toEqual([url])
    expect(published.opened).toEqual([url])

    const aliased = await cli(["alias", "plan", hash, "--open", "--json"])
    expect(aliased.stdout).toHaveLength(1)
    expect(aliased.opened).toEqual([`https://plan.${ZONE}`])
  })

  test("opens nothing when the command fails", async () => {
    const outcome = await cli([plan.path, "--open"], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    expect(outcome.opened).toEqual([])
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
