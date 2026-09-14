import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { plan, session } from "./fixtures"
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
 * Everything the CLI does against a deployment in accounts mode — `login`,
 * `logout` and `account`, what `doctor` makes of the hosted tier, and the one
 * page error that only exists there. They share a file because they share the
 * setup: a Worker with keys instead of one shared token, and two GitHub
 * accounts to be.
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
  readonly mintedAt?: string
  readonly token?: string
}

const configFile = (): StoredConfig =>
  JSON.parse(readFileSync(join(home, "handbill", "config.json"), "utf8"))

/** A key for one of the two accounts, minted straight from a Worker. */
const mint = async (githubToken: string, on = server): Promise<string> => {
  const response = await on.fetch(`https://api.${ZONE}/v1/keys`, {
    method: "POST",
    body: JSON.stringify({ githubToken }),
    headers: { "content-type": "application/json" }
  })
  const body = (await response.json()) as { readonly key: string }
  return body.key
}

/** The other deployment in the endpoint-pin tests: the one that minted the stored key. */
const ELSEWHERE = "https://api.elsewhere.dev"

/**
 * Two deployments behind one `fetch`, and every URL recorded whole. Which host
 * a key was sent to is the whole question here, and `server.requests()` keeps
 * only the path. A request for {@link ELSEWHERE} is re-addressed to the second
 * Worker's own zone, because a Worker classifies hosts against the zone it was
 * deployed with; nothing bodied is sent there, so the method and headers are all
 * that has to survive the move.
 */
const twoDeployments = () => {
  const urls: Array<string> = []
  const elsewhere = makeServer({ accounts: true })
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      urls.push(`${request.method} ${request.url}`)
      const url = new URL(request.url)
      return url.origin === ELSEWHERE
        ? elsewhere.fetch(`https://api.${ZONE}${url.pathname}`, {
            method: request.method,
            headers: request.headers
          })
        : server.transport(request)
    },
    { preconnect: () => Promise.resolve() }
  )
  return {
    elsewhere,
    urls: (): ReadonlyArray<string> => [...urls],
    layer: Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer))
  }
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

  // The nastiest shape of the unnamed-endpoint hazard, because the 404 reading
  // below cannot save it: a hosted deployment answers 204 for a key it has
  // never seen, so an operator's token sent here would come back "revoked" and
  // take the config file with it. Refused before the request, so the token
  // never leaves and the file is untouched.
  test("will not send a token that is not a key to the default endpoint", async () => {
    home = configHome(JSON.stringify({ token: TOKEN }))
    const outcome = await cli(["logout"], { env: { HANDBILL_ENDPOINT: undefined } })
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("no endpoint was named")
    expect(configFile().token).toBe(TOKEN)
    expect(server.requests()).toEqual([])
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

// #115/#161: the key in the file belongs to one deployment, and the CLI now
// knows which. Pointing it somewhere else means "log in there", never "send this
// key there and see what it says".
describe("the endpoint that minted the key", () => {
  test("refuses to send a stored key anywhere else, naming both endpoints", async () => {
    home = configHome(JSON.stringify({ token: "hb_stored", mintedAt: ELSEWHERE }))
    const outcome = await cli(["list"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain(`was minted by ${ELSEWHERE}`)
    expect(outcome.stderr.join("\n")).toContain(`will not be sent to https://api.${ZONE}`)
    // Before any request: the key never leaves.
    expect(server.requests()).toEqual([])
  })

  test("sends it to the deployment that minted it", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    expect(configFile().mintedAt).toBe(`https://api.${ZONE}`)
    expect((await cli(["list"])).ok).toBe(true)
  })

  // Every user who logged in before `mintedAt` existed: the file's own endpoint
  // is what their key was minted at, and the default when it names none.
  test("takes a config file written before the field existed", async () => {
    const key = await mint(GITHUB_TOKEN)
    home = configHome(JSON.stringify({ endpoint: `https://api.${ZONE}`, token: key }))
    const outcome = await cli(["list"], { env: { HANDBILL_ENDPOINT: undefined } })
    expect(outcome.ok).toBe(true)
  })

  // `logout` is about the key, not about publishing with it: it follows the key
  // home whatever the environment says, so a revocation cannot be redirected.
  test("logout revokes at the minting endpoint, whatever the environment names", async () => {
    const both = twoDeployments()
    const stale = await mint(GITHUB_TOKEN, both.elsewhere)
    home = configHome(JSON.stringify({ token: stale, mintedAt: ELSEWHERE }))

    const outcome = await cli(["logout", "--json"], { http: both.layer })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.stdout[0] ?? "")).toMatchObject({
      revoked: true,
      endpoint: ELSEWHERE
    })
    expect(both.urls()).toContain(`DELETE ${ELSEWHERE}/v1/keys/current`)
    // The provenance goes with the key it belonged to.
    expect(configFile().token).toBeUndefined()
    expect(configFile().mintedAt).toBeUndefined()
    await both.elsewhere.dispose()
  })

  // `mintedAt` is a line in a file a hand can edit, and it is about to receive a
  // live key: the scheme is checked on it too, not only on the resolved endpoint.
  test("refuses to give a key back over plain http", async () => {
    home = configHome(JSON.stringify({ token: "hb_stored", mintedAt: "http://evil.test" }))
    const outcome = await cli(["logout"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stderr.join("\n")).toContain("is not an https:// endpoint")
    expect(server.requests()).toEqual([])
    expect(configFile().token).toBe("hb_stored")
  })

  // The same guard on the login side, where the new key is already stored: the
  // old one is not sent, and the login is not thrown away over it either.
  test("login will not give a key back over plain http, and says so", async () => {
    home = configHome(JSON.stringify({ token: "hb_stored", mintedAt: "http://evil.test" }))
    const outcome = await cli(["login"], { githubToken: GITHUB_TOKEN })
    expect(outcome.ok).toBe(true)
    expect(outcome.stderr.join("\n")).toContain("is not an https:// endpoint")
    expect(String(configFile().token)).toStartWith("hb_")
    expect(configFile().mintedAt).toBe(`https://api.${ZONE}`)
  })

  // The gap #161 names: `login --endpoint` used to hand the live key to the host
  // being logged in to, which answers 204 for a key it has never seen — leaving
  // the real one live forever on the deployment that issued it.
  test("login gives the key it replaces back to the deployment that minted it", async () => {
    const both = twoDeployments()
    const stale = await mint(GITHUB_TOKEN, both.elsewhere)
    home = configHome(JSON.stringify({ token: stale, mintedAt: ELSEWHERE }))

    const outcome = await cli(["login"], { githubToken: GITHUB_TOKEN, http: both.layer })
    expect(outcome.ok).toBe(true)
    expect(both.urls()).toContain(`DELETE ${ELSEWHERE}/v1/keys/current`)
    expect(both.urls()).not.toContain(`DELETE https://api.${ZONE}/v1/keys/current`)

    // Dead where it lived, not merely forgotten here.
    const refused = await both.elsewhere.fetch(`https://api.${ZONE}/v1/pages`, {
      headers: { authorization: `Bearer ${stale}` }
    })
    expect(refused.status).toBe(401)
    await both.elsewhere.dispose()
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

/** Where a deployment that sells something sends the caller to pay. */
const CHECKOUT_URL = "https://sandbox.polar.sh/checkout/abc123"

describe("account", () => {
  test("prints the owner, the tier and what the quotas have been spent on", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    await cli([plan.path])

    const outcome = await cli(["account"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stderr).toEqual([])
    expect(outcome.stdout).toEqual([
      `owner   ${OWNER}`,
      "tier    free",
      "pages   1 / 25 today",
      `stored  ${plan.bytes.length} / ${250 * 1024 * 1024} bytes`
    ])

    const json = await cli(["account", "--json"])
    expect(JSON.parse(json.stdout[0] ?? "")).toEqual({
      owner: OWNER,
      tier: "free",
      usage: { pagesToday: 1, storedBytes: plan.bytes.length },
      limits: { pagesPerDay: 25, storedBytes: 250 * 1024 * 1024 }
    })
  })

  // A deployment that pays its own R2 bill counts nothing, so there is no
  // limit to print: saying so beats printing a zero that reads as "spent".
  const selfHosted = session()

  test("says so where nothing is counted", async () => {
    const outcome = await selfHosted.cli(["account"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([
      "owner   self",
      "tier    free",
      "quotas are not counted on this deployment."
    ])
  })
})

describe("account --upgrade", () => {
  // Its own deployment: this one has a payment provider configured, which the
  // sessions the module's server refuses are the absence of. The admin token is
  // how a test moves an account onto the paid tier without a Polar webhook.
  const ADMIN = "operator-only"
  const selling = makeServer({ accounts: true, checkoutUrl: CHECKOUT_URL, admin: ADMIN })
  afterAll(() => selling.dispose())

  test("prints the checkout URL and nothing else, and can open it", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN, http: selling.layer })

    const outcome = await cli(["account", "--upgrade"], { http: selling.layer })
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual([CHECKOUT_URL])
    expect(outcome.stderr).toEqual([])
    expect(outcome.opened).toEqual([])

    // Still one line on stdout with `--open`: the browser is a second reader of
    // the URL, never the first. Which owner the session was created for is the
    // Worker's test to make — the CLI never names one, which is the point.
    const opened = await cli(["account", "--upgrade", "--open"], { http: selling.layer })
    expect(opened.stdout).toEqual([CHECKOUT_URL])
    expect(opened.opened).toEqual([CHECKOUT_URL])
  })

  // Paying twice for one account is the mistake this refuses: the sentence sends
  // the user to the portal rather than to a second subscription.
  test("an account already on the paid tier is told, not sold to", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN, http: selling.layer })
    await selling.fetch(`https://api.${ZONE}/v1/admin/tier/${encodeURIComponent(OWNER)}`, {
      method: "PUT",
      body: JSON.stringify({ tier: "paid" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }
    })

    const outcome = await cli(["account", "--upgrade"], { http: selling.layer })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("already on the paid tier")
  })

  // `--open` opens what a command printed, and reading an account prints no URL:
  // silently doing nothing would look like the browser failing to start.
  test("--open without --upgrade says there is nothing to open", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const outcome = await cli(["account", "--open"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.opened).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("--open has nothing to open")
  })

  test("a deployment with nothing to sell says so and fails", async () => {
    await cli(["login"], { githubToken: GITHUB_TOKEN })
    const outcome = await cli(["account", "--upgrade"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("has no paid tier to buy")
  })
})

// M21: the browser gets the key in a URL fragment, which never reaches a server
// — so `--web` needs no request at all. M22: the site is the zone under the
// endpoint's `api.` label, so staging opens staging and an endpoint with no site
// behind it is refused.
/** A machine logged in to the hosted deployment: the key in the file, minted at the default. */
const hostedHome = () => configHome(JSON.stringify({ token: "hb_web_key", mintedAt: "default" }))

describe("account --web", () => {
  const webCli = (args: ReadonlyArray<string>) =>
    run(args, {
      http: server.layer,
      env: { XDG_CONFIG_HOME: hostedHome(), HANDBILL_ENDPOINT: undefined }
    })

  test("prints the account page URL with the key in it, opens it, and asks nothing of the API", async () => {
    const outcome = await webCli(["account", "--web"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual(["https://handbill.dev/account/#key=hb_web_key"])
    expect(outcome.opened).toEqual(["https://handbill.dev/account/#key=hb_web_key"])
    // Printed on purpose here — the URL is the destination — but the key is in
    // it, so the warning is not optional.
    expect(outcome.stderr.join("\n")).toContain("carries your key")
    expect(server.requests()).toEqual([])
  })

  // A trailing slash and a capital are the same deployment; `--open` is what the
  // command already does, so it is accepted rather than refused.
  test("takes the default endpoint however it is spelled, and takes --open", async () => {
    const outcome = await run(["account", "--web", "--open"], {
      http: server.layer,
      env: { XDG_CONFIG_HOME: hostedHome(), HANDBILL_ENDPOINT: "https://API.handbill.dev/" }
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual(["https://handbill.dev/account/#key=hb_web_key"])
    expect(outcome.opened).toEqual(["https://handbill.dev/account/#key=hb_web_key"])
  })

  test("--json carries the same URL and nothing else", async () => {
    const outcome = await webCli(["account", "--web", "--json"])
    expect(JSON.parse(outcome.stdout[0] ?? "")).toEqual({
      url: "https://handbill.dev/account/#key=hb_web_key"
    })
  })

  // Another deployment of the same code has its own site under the same rule:
  // `api.<zone>` in, `<zone>` out, with no host written into the CLI.
  test("opens the staging site for the staging endpoint", async () => {
    const outcome = await run(["account", "--web"], {
      http: server.layer,
      env: {
        XDG_CONFIG_HOME: configHome(
          JSON.stringify({ token: "hb_web_key", mintedAt: "https://api.handbill-staging.dev" })
        ),
        HANDBILL_ENDPOINT: "https://api.handbill-staging.dev"
      }
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual(["https://handbill-staging.dev/account/#key=hb_web_key"])
    expect(outcome.opened).toEqual(["https://handbill-staging.dev/account/#key=hb_web_key"])
    expect(server.requests()).toEqual([])
  })

  // No `api.` label, so no zone to derive a site from. A self-hosted deployment
  // is an API with no site behind it: there is nowhere to send the key, and it
  // is not sent.
  test("refuses for a self-hosted endpoint", async () => {
    const outcome = await run(["account", "--web", "--endpoint", "https://self.host"], {
      http: server.layer,
      env: { XDG_CONFIG_HOME: hostedHome(), HANDBILL_ENDPOINT: undefined }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.opened).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("api.<zone>")
  })

  // Both print a URL, and stdout carries exactly one line.
  test("cannot be combined with --upgrade", async () => {
    const outcome = await webCli(["account", "--web", "--upgrade"])
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout).toEqual([])
    expect(outcome.stderr.join("\n")).toContain("cannot be combined")
  })
})
