import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { kickoff, plan, retro, session } from "./fixtures"
import { makeServer, ZONE } from "./server"

/**
 * The round-trips for `src/update.ts`: the rotation, what it reports, and what
 * it says when a call after the publish fails.
 */

const { cli, server } = session()
const { hash, url } = plan
const planUrl = `https://plan.${ZONE}`

/**
 * The in-process server with one call handed to `instead` — another server, or a
 * rejection standing in for a connection that drops. A command that rotates
 * several calls is only half specified by its happy path: this is how the tests
 * reach what `update` does when a call after the publish fails.
 */
const broken = (
  fails: (request: Request) => boolean,
  instead: (request: Request) => ReturnType<ReturnType<typeof makeServer>["transport"]>
) => {
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      return fails(request) ? instead(request) : server().transport(request)
    },
    { preconnect: () => Promise.resolve() }
  )
  return Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer))
}

describe("update", () => {
  // The whole rotation, and the order it happens in: the new page is up before
  // any name moves, and the old hash goes last, so a reader following `plan`
  // never meets a 404 in between.
  test("publishes, re-points the names and removes the old hash, in that order", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])

    const from = server().requests().length
    const outcome = await cli(["update", url, retro.path])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([retro.url])
    expect(server().requests().slice(from)).toEqual([
      `PUT /v1/pages/${retro.hash}`,
      "GET /v1/aliases",
      "PUT /v1/aliases/plan",
      `DELETE /v1/pages/${hash}`
    ])

    expect(server().hashes()).toEqual([retro.hash])
    expect(await (await server().fetch(`${planUrl}/`)).text()).toBe(retro.html)
    expect((await server().fetch(`${url}/`)).status).toBe(404)
  })

  // Updating a page to the bytes it already has is a no-op, not a way to
  // unpublish it: the hash is the same, so removing it would delete the page.
  test("does nothing when the bytes are unchanged", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])

    const from = server().requests().length
    const outcome = await cli(["update", url, plan.path, "--json"])
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toEqual({
      hash,
      url,
      created: false,
      removed: false,
      aliases: []
    })
    expect(server().requests().slice(from)).toEqual([`PUT /v1/pages/${hash}`])
    expect(server().hashes()).toEqual([hash])
    expect(await (await server().fetch(`${planUrl}/`)).text()).toBe(plan.html)
  })
})

describe("update and the names", () => {
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
    expect(await (await server().fetch(`https://kickoff.${ZONE}/`)).text()).toBe(kickoff.html)
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
})

describe("update target", () => {
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
})

describe("update failures", () => {
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
    expect(server().hashes().toSorted()).toEqual([retro.hash, hash].toSorted())
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
    expect(server().hashes()).toContain(hash)
  })
})
