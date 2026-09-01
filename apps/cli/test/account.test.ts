import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { plan } from "./fixtures"
import { configHome, run, type RunOptions, USER_CODE, VERIFICATION_URI } from "./harness"
import {
  GITHUB_TOKEN,
  makeServer,
  OTHER_GITHUB_TOKEN,
  OTHER_OWNER,
  OWNER,
  TOKEN,
  ZONE
} from "./server"

/**
 * Everything the CLI does against a deployment in accounts mode: `login` and
 * `logout` from `src/account.ts`, what `doctor` makes of the hosted tier, and
 * the one page error that only exists there — a hash another account owns.
 * They share a file because they share the setup: a Worker with keys instead of
 * one shared token, and two GitHub accounts to be.
 */

let server = makeServer({ accounts: true })
let home = configHome()

afterAll(() => server.dispose())

beforeEach(() => {
  server.dispose()
  server = makeServer({ accounts: true })
  home = configHome()
})

/** The CLI on a machine that knows an endpoint and nothing else — no key anywhere. */
const cli = (
  args: ReadonlyArray<string>,
  options: {
    readonly env?: Record<string, string | undefined>
    readonly githubToken?: string
    readonly http?: RunOptions["http"]
  } = {}
) =>
  run(args, {
    http: options.http ?? server.layer,
    githubToken: options.githubToken,
    env: { XDG_CONFIG_HOME: home, HANDBILL_ENDPOINT: `https://api.${ZONE}`, ...options.env }
  })

/** The config file as these tests read it back; `editor` stands in for a field the CLI never writes. */
interface StoredConfig {
  readonly endpoint?: string
  readonly editor?: string
  readonly token?: string
}

const configFile = (): StoredConfig =>
  JSON.parse(readFileSync(join(home, "handbill", "config.json"), "utf8"))

/** A key for one of the two accounts, minted straight from the Worker. */
const mint = async (githubToken: string): Promise<string> => {
  const response = await server.fetch(`https://api.${ZONE}/v1/keys`, {
    method: "POST",
    body: JSON.stringify({ githubToken }),
    headers: { "content-type": "application/json" }
  })
  const body = (await response.json()) as { readonly key: string }
  return body.key
}

describe("login", () => {
  // S3.1: the whole point of the milestone — nothing configured but an
  // endpoint, and one command later a page publishes.
  test("mints a key, stores it, and publishes with it", async () => {
    const outcome = await cli(["login", "--json"], { githubToken: GITHUB_TOKEN })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toMatchObject({ owner: OWNER })
    // The code to type goes to stderr, and the page that asks for it is opened.
    expect(outcome.stderr.join("\n")).toContain(USER_CODE)
    expect(outcome.opened).toEqual([VERIFICATION_URI])
    expect(String(configFile().token)).toStartWith("hb_")

    const published = await cli([plan.path])
    expect(published.stdout).toEqual([plan.url])
    expect(server.hashes(OWNER)).toEqual([plan.hash])
  })

  test("prints the owner and nothing else on stdout", async () => {
    const outcome = await cli(["login"], { githubToken: GITHUB_TOKEN })
    expect(outcome.stdout).toEqual([OWNER])
  })

  // The config file is the user's, not the CLI's: logging in adds a key to it
  // and leaves everything else — the endpoint included — exactly as it was.
  test("merges the key into an existing config file", async () => {
    home = configHome(JSON.stringify({ endpoint: `https://api.${ZONE}`, editor: "hx" }))
    const outcome = await cli(["login"], {
      githubToken: GITHUB_TOKEN,
      env: { HANDBILL_ENDPOINT: undefined }
    })
    expect(outcome.ok).toBe(true)
    expect(configFile()).toMatchObject({ endpoint: `https://api.${ZONE}`, editor: "hx" })
  })

  test("reports a flow the user did not finish, and writes nothing", async () => {
    const outcome = await cli(["login"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("Could not sign in")
    expect(() => configFile()).toThrow()
  })
})

describe("logout", () => {
  test("revokes the key server-side and removes it from the config file", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const key = String(configFile().token)
    const outcome = await cli(["logout", "--json"])
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toMatchObject({ revoked: true })
    expect(configFile().token).toBeUndefined()

    // The revocation is the server's, not just the file's: the key it wrote is
    // dead even in the hands of someone who kept a copy.
    const published = await cli([plan.path], { env: { HANDBILL_TOKEN: key } })
    expect(published.ok).toBe(false)
    expect(published.stderr.join("\n")).toContain("rejected the token")
  })

  test("has nothing to do without a key", async () => {
    const outcome = await cli(["logout"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("No key configured")
  })
})

// Which key `logout` is holding decides both what it revokes and what it may
// clear, and the two are not always the same key.
describe("logout and the key it is actually holding", () => {
  // The environment beats the file, so the environment's key is the one that
  // gets revoked — and clearing the file would then delete a *different* live
  // key that nothing could ever revoke again, because the route needs the key
  // itself and the file was the only thing holding it.
  test("revokes the environment's key and leaves the file's alone", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const stored = String(configFile().token)
    const exported = await mint(GITHUB_TOKEN)

    const outcome = await cli(["logout", "--json"], { env: { HANDBILL_TOKEN: exported } })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toMatchObject({ revoked: true, cleared: false })
    expect(outcome.stderr.join("\n")).toContain("HANDBILL_TOKEN is set")
    expect(configFile().token).toBe(stored)

    // The one that was left behind is still usable, so signing out again
    // without the variable reaches it.
    expect((await cli([plan.path])).ok).toBe(true)
  })

  // A key a deployment minted meeting a 404 means "this is not where it came
  // from", not "there was nothing to revoke" — so nothing local is cleared and
  // the command does not claim success over a key that is still live.
  test("refuses to sign out at a deployment that never minted the key", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const stored = String(configFile().token)
    const elsewhere = makeServer()
    const outcome = await cli(["logout"], { http: elsewhere.layer })
    await elsewhere.dispose()
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("is not the deployment that minted it")
    expect(configFile().token).toBe(stored)
  })
})

// Every `POST /v1/keys` mints a fresh record and nothing expires the one
// before it, so the key a second login overwrites would otherwise stay live in
// KV forever — unrevokable, because the route needs the key in hand and the
// file that held it has just been overwritten.
describe("logging in twice", () => {
  test("gives back the key it replaces", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const first = String(configFile().token)

    await cli(["login"], { githubToken: GITHUB_TOKEN })
    expect(configFile().token).not.toBe(first)

    // Dead, not merely forgotten.
    const published = await cli([plan.path], { env: { HANDBILL_TOKEN: first } })
    expect(published.ok).toBe(false)
    expect(published.stderr.join("\n")).toContain("rejected the token")
  })
})

describe("login and the endpoint it signed in to", () => {
  // A key is only good against the deployment that minted it, so `login`
  // remembers a deployment named on the command line.
  test("stores an endpoint given as a flag next to the key", async () => {
    const outcome = await cli(["login", "--endpoint", `https://api.${ZONE}`], {
      githubToken: GITHUB_TOKEN,
      env: { HANDBILL_ENDPOINT: undefined }
    })
    expect(outcome.ok).toBe(true)
    expect(configFile().endpoint).toBe(`https://api.${ZONE}`)
  })

  // The key went to the file, but the file is not where the next command will
  // look: say so rather than let the next publish fail on the old key.
  test("says the environment will go on winning over the new key", async () => {
    const outcome = await cli(["login"], {
      githubToken: GITHUB_TOKEN,
      env: { HANDBILL_TOKEN: "hb_older" }
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.stderr.join("\n")).toContain("HANDBILL_TOKEN is set")
  })
})

// A self-hosted deployment mints nothing and has nothing to revoke: both key
// routes answer 404, and that is not the aliases-are-off 404 the shared
// sentence explains.
describe("against a deployment with no accounts", () => {
  // Found out from `/v1/health` before anyone is sent to GitHub, so a login
  // that cannot work does not spend a real GitHub grant getting there.
  test("login says there is no key to mint, without opening a browser", async () => {
    const secret = makeServer()
    const outcome = await cli(["login"], { githubToken: GITHUB_TOKEN, http: secret.layer })
    await secret.dispose()
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("does not run accounts")
    expect(outcome.opened).toEqual([])
  })

  // Nothing to give back server-side, so the local key is all there is to drop.
  test("logout still clears the local key", async () => {
    const secret = makeServer()
    home = configHome(JSON.stringify({ token: TOKEN }))
    const outcome = await cli(["logout", "--json"], { http: secret.layer })
    await secret.dispose()
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toMatchObject({ revoked: false })
    expect(outcome.stderr.join("\n")).toContain("does not run accounts")
    expect(configFile().token).toBeUndefined()
  })
})

describe("doctor in accounts mode", () => {
  test("reports the endpoint, the mode, and a key the endpoint accepts", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const outcome = await cli(["doctor", "--json"])
    expect(outcome.ok).toBe(true)
    const { checks } = JSON.parse(outcome.stdout[0] ?? "")
    const detail = (name: string) =>
      checks.find((check: { name: string }) => check.name === name)?.detail
    expect(detail("config")).toContain(`https://api.${ZONE}`)
    expect(detail("health")).toContain("mode accounts")
    expect(detail("auth")).toContain("accepted the key")
  })

  test("tells a refused key to log in again", async () => {
    const outcome = await cli(["doctor", "--json"], { env: { HANDBILL_TOKEN: "hb_wrong" } })
    expect(outcome.ok).toBe(false)
    const { checks } = JSON.parse(outcome.stdout[0] ?? "")
    expect(checks.find((check: { name: string }) => check.name === "auth")).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("handbill login")
    })
  })
})

// #113: the 404 `remove` can now meet is a page another account owns, and it
// used to be explained as "aliases are off on this deployment".
describe("remove across accounts", () => {
  test("says a page belongs to someone else rather than blaming aliases", async () => {
    const theirs = await mint(OTHER_GITHUB_TOKEN)
    await server.fetch(`https://api.${ZONE}/v1/pages/${plan.hash}`, {
      method: "PUT",
      body: plan.bytes,
      headers: { "content-type": "text/html", authorization: `Bearer ${theirs}` }
    })

    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const outcome = await cli(["remove", plan.hash])
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("belongs to another account")
    expect(server.hashes(OTHER_OWNER)).toEqual([plan.hash])
  })
})
