import { describe, expect, test } from "bun:test"
import { plan, session } from "./fixtures"
import { makeServer, ZONE } from "./server"

/** The round-trips for `src/aliases.ts`: the name, its listing, and its removal. */

const { cli, server } = session()
const { hash, url } = plan
const planUrl = `https://plan.${ZONE}`

describe("alias", () => {
  // S2.2: one line, the alias URL — and the Worker really serves the page there.
  test("points a name at a page and prints the alias URL", async () => {
    await cli([plan.path])
    const outcome = await cli(["alias", "plan", url])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([planUrl])
    expect(outcome.stderr).toEqual([])
    expect(await (await server().fetch(`${planUrl}/`)).text()).toBe(plan.html)
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
})

describe("alias list", () => {
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
})

describe("alias remove", () => {
  test("removes a name, idempotently, and leaves the page published", async () => {
    await cli([plan.path])
    await cli(["alias", "plan", hash])
    const first = await cli(["alias", "remove", "plan"])
    const second = await cli(["alias", "remove", "plan", "--json"])
    expect(first.ok && second.ok).toBe(true)
    expect(first.stdout).toEqual(["plan"])
    expect(JSON.parse(second.stdout[0] ?? "")).toEqual({ name: "plan", removed: true })
    expect((await server().fetch(`${planUrl}/`)).status).toBe(404)
    expect(server().hashes()).toEqual([hash])
  })
})

describe("aliases switched off", () => {
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
