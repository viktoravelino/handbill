import { describe, expect, test } from "bun:test"
import { plan, session } from "./fixtures"
import { TOKEN } from "./server"

/** The round-trips for `handbill admin takedown` and `handbill admin tier` (src/admin.ts). */

/** What this deployment's `ADMIN_TOKEN` is; deliberately not the publishing token. */
const ADMIN = "operator-only"

const { cli, server } = session({ admin: ADMIN })
const asOperator = { env: { HANDBILL_ADMIN_TOKEN: ADMIN } }

describe("admin takedown", () => {
  test("takes a published page down and prints its hash", async () => {
    await cli([plan.path])
    expect(server().hashes()).toEqual([plan.hash])

    const outcome = await cli(["admin", "takedown", plan.url], asOperator)
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([plan.hash])
    expect(outcome.stderr).toEqual([])
    expect(server().hashes()).toEqual([])
  })

  // Idempotent all the way through, so a report can be worked twice without
  // anyone checking first — and a hash is as good as the URL from the report.
  test("is idempotent, and takes a bare hash too", async () => {
    await cli([plan.path])
    await cli(["admin", "takedown", plan.hash], asOperator)
    const again = await cli(["admin", "takedown", plan.hash, "--json"], asOperator)
    expect(again.ok).toBe(true)
    expect(JSON.parse(again.stdout[0] ?? "")).toEqual({ hash: plan.hash, removed: true })
  })

  // The two credentials are separate secrets: a key that publishes is not the
  // one that takes down, and the CLI says which one is wrong.
  test("the publishing token is not the admin token", async () => {
    await cli([plan.path])
    const outcome = await cli(["admin", "takedown", plan.hash], {
      env: { HANDBILL_ADMIN_TOKEN: TOKEN }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr[0]).toMatch(/did not accept this admin token/u)
    expect(server().hashes()).toEqual([plan.hash])
  })

  test("with no admin token configured, nothing is sent", async () => {
    await cli([plan.path])
    const outcome = await cli(["admin", "takedown", plan.hash])
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr[0]).toMatch(/HANDBILL_ADMIN_TOKEN/u)
    // The publish is the only call that reached the deployment.
    expect(server().requests()).toEqual([`PUT /v1/pages/${plan.hash}`])
  })
})

/**
 * The tier override needs a deployment with accounts: a self-hosted one has no
 * records to carry a tier and 404s the route, which is its own sentence.
 */
const hosted = session({ admin: ADMIN, accounts: true })

describe("admin tier", () => {
  test("sets an account's tier and prints it", async () => {
    const outcome = await hosted.cli(["admin", "tier", "gh:4242", "paid"], asOperator)
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual(["gh:4242 paid"])
    expect(outcome.stderr).toEqual([])
    // The colon in an owner is percent-encoded on the wire and decoded back by
    // the router, so the account the Worker writes is the one that was typed.
    expect(hosted.server().requests()).toEqual(["PUT /v1/admin/tier/gh%3A4242"])

    const json = await hosted.cli(["admin", "tier", "gh:4242", "free", "--json"], asOperator)
    expect(JSON.parse(json.stdout[0] ?? "")).toEqual({ owner: "gh:4242", tier: "free" })
  })

  // The 404 here has a cause takedown's does not: a self-hosted deployment has
  // no account records at all, so the sentence names both.
  test("a deployment with no accounts says so", async () => {
    const outcome = await cli(["admin", "tier", "gh:4242", "paid"], asOperator)
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr[0]).toMatch(/no accounts to carry a tier/u)
  })
})
