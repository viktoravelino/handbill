import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { HandbillApi } from "./api"
import { HashMismatch, NotFound, QuotaExceeded, TooLarge, Unauthorized } from "./errors"
import { AliasName, Hash, Page } from "./schemas"

const spec = OpenApi.fromApi(HandbillApi)

/** The error statuses an operation documents, e.g. `["400", "401", "413"]`. */
const errorStatuses = (
  paths: OpenApi.OpenAPISpecPaths,
  path: string,
  method: "get" | "post" | "put" | "delete"
) => {
  const operation = paths[path]?.[method]
  if (operation === undefined) throw new Error(`${method.toUpperCase()} ${path} is not in the spec`)
  return Object.keys(operation.responses ?? {})
    .filter((status) => Number(status) >= 400)
    .toSorted()
}

describe("Hash", () => {
  test("accepts 12 lowercase hex characters", () => {
    expect(Schema.encodeSync(Hash)(Schema.decodeUnknownSync(Hash)("a3f9c1d4e2b8"))).toBe(
      "a3f9c1d4e2b8"
    )
  })

  test.each([
    ["too short", "a3f9c1d4e2b"],
    ["too long", "a3f9c1d4e2b8f"],
    ["uppercase", "A3F9C1D4E2B8"],
    ["not hex", "a3f9c1d4e2bz"]
  ])("rejects %s", (_, input) => {
    expect(() => Schema.decodeUnknownSync(Hash)(input)).toThrow()
  })
})

describe("AliasName", () => {
  test.each(["plan", "plan-v2", "notes2026", "w", "a3f9c1d4e2b"])("accepts %s", (input) => {
    expect(Schema.encodeSync(AliasName)(Schema.decodeUnknownSync(AliasName)(input))).toBe(input)
  })

  test.each([
    // `api` is the API's own hostname and 12 hex is a hash: an alias with
    // either name could be stored but never resolved.
    ["the API label", "api"],
    ["a hash", "a3f9c1d4e2b8"],
    ["a leading hyphen", "-plan"],
    ["a trailing hyphen", "plan-"],
    ["an uppercase letter", "Plan"],
    ["a dot", "plan.v2"],
    ["nothing", ""],
    ["more than 63 characters", "p".repeat(64)]
  ])("rejects %s", (_, input) => {
    expect(() => Schema.decodeUnknownSync(AliasName)(input)).toThrow()
  })
})

describe("Page", () => {
  // The wire format is the one the previous deployment sent, so already-stored
  // objects and the old client keep working: publishedAt stays an ISO string.
  test("round-trips publishedAt as an ISO string", () => {
    const wire = {
      hash: "a3f9c1d4e2b8",
      url: "https://a3f9c1d4e2b8.example.dev",
      title: "Plan",
      publishedAt: "2026-08-28T15:25:10.123Z",
      size: 42
    }
    expect(Schema.encodeSync(Page)(Schema.decodeUnknownSync(Page)(wire))).toEqual(wire)
  })
})

// `NotFound` is the one error no v0.1 endpoint can raise — the page-serving path
// is a hostname branch, not an API route, and DELETE is idempotent. Generating a
// spec from a probe API is how we prove all five carry the status they declare.
describe("errors", () => {
  test("every error maps to its HTTP status", () => {
    class Probe extends HttpApi.make("probe").add(
      HttpApiGroup.make("probe", { topLevel: true }).add(
        HttpApiEndpoint.get("probe", "/probe", {
          success: Schema.String,
          error: [HashMismatch, Unauthorized, NotFound, TooLarge, QuotaExceeded]
        })
      )
    ) {}

    expect(errorStatuses(OpenApi.fromApi(Probe).paths, "/probe", "get")).toEqual([
      "400",
      "401",
      "404",
      "413",
      "429"
    ])
  })
})

describe("spec", () => {
  // The M2 spike: the publish body is raw HTML, not JSON in disguise.
  test("publish takes a raw text/html body", () => {
    expect(spec.paths["/v1/pages/{hash}"]?.put?.requestBody).toEqual({
      content: { "text/html": { schema: { type: "string", format: "binary" } } },
      required: true
    })
  })

  test("documents the error responses each endpoint can return", () => {
    // 429 is the hosted quota; a self-hosted deployment counts nothing and never raises it.
    expect(errorStatuses(spec.paths, "/v1/pages/{hash}", "put")).toEqual([
      "400",
      "401",
      "413",
      "429"
    ])
    expect(errorStatuses(spec.paths, "/v1/pages", "get")).toEqual(["401"])
    // DELETE stays idempotent for an absent page, but a hash owned by another
    // account is a 404: cross-owner remove discloses nothing (decision 05).
    expect(errorStatuses(spec.paths, "/v1/pages/{hash}", "delete")).toEqual(["401", "404"])
    // Every alias route can 404: a deployment without a KV binding has no
    // aliases to speak of, not an empty list of them.
    expect(errorStatuses(spec.paths, "/v1/aliases", "get")).toEqual(["401", "404"])
    expect(errorStatuses(spec.paths, "/v1/aliases/{name}", "get")).toEqual(["401", "404"])
    expect(errorStatuses(spec.paths, "/v1/aliases/{name}", "put")).toEqual(["401", "404"])
    expect(errorStatuses(spec.paths, "/v1/aliases/{name}", "delete")).toEqual(["401", "404"])
    // Both key routes 404 where accounts are off. `mint` carries its own 401
    // because the credential it checks is the GitHub token in its body; `revoke`
    // has no 401 at all — it is idempotent, so an already-revoked or unknown key
    // is a 204, and 404 is only the accounts-off case.
    expect(errorStatuses(spec.paths, "/v1/keys", "post")).toEqual(["401", "404"])
    expect(errorStatuses(spec.paths, "/v1/keys/current", "delete")).toEqual(["404"])
    // health needs no token, so it has nothing to fail with.
    expect(errorStatuses(spec.paths, "/v1/health", "get")).toEqual([])
  })

  // Takedown: 404 where the deployment sets no admin token — the operator
  // surface is absent, not empty — and 401 where it does and this is not it. A
  // hash that is not stored is a 204, so neither status is about the page.
  test("the takedown route documents an absent operator surface and a wrong token", () => {
    expect(errorStatuses(spec.paths, "/v1/admin/pages/{hash}", "delete")).toEqual(["401", "404"])
  })

  test("both key routes are outside the bearer middleware", () => {
    expect(spec.paths["/v1/pages"]?.get?.security).toEqual([{ bearer: [] }])
    expect(spec.paths["/v1/aliases"]?.get?.security).toEqual([{ bearer: [] }])
    expect(spec.paths["/v1/health"]?.get?.security).toEqual([])
    // For both key routes the credential is the request itself, not a bearer the
    // middleware resolves: mint carries the GitHub token in its body, revoke the
    // key to kill in its own header. Revoke off the middleware is also what lets
    // it stay idempotent — a revoked key reaches the handler instead of 401ing.
    expect(spec.paths["/v1/keys"]?.post?.security).toEqual([])
    expect(spec.paths["/v1/keys/current"]?.delete?.security).toEqual([])
    // Takedown is outside it too, and for a stronger reason: the credential is a
    // different secret entirely, so no user key may resolve on this route.
    expect(spec.paths["/v1/admin/pages/{hash}"]?.delete?.security).toEqual([])
  })

  // The whole spec, so M3 and M4 notice if the contract moves under them.
  test("matches the published spec", () => {
    expect(spec).toMatchSnapshot()
  })
})
