import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { HandbillApi } from "./api"
import { HashMismatch, NotFound, TooLarge, Unauthorized } from "./errors"
import { AliasName, Hash, Page } from "./schemas"

const spec = OpenApi.fromApi(HandbillApi)

/** The error statuses an operation documents, e.g. `["400", "401", "413"]`. */
const errorStatuses = (
  paths: OpenApi.OpenAPISpecPaths,
  path: string,
  method: "get" | "put" | "delete"
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
// spec from a probe API is how we prove all four carry the status they declare.
describe("errors", () => {
  test("every error maps to its HTTP status", () => {
    class Probe extends HttpApi.make("probe").add(
      HttpApiGroup.make("probe", { topLevel: true }).add(
        HttpApiEndpoint.get("probe", "/probe", {
          success: Schema.String,
          error: [HashMismatch, Unauthorized, NotFound, TooLarge]
        })
      )
    ) {}

    expect(errorStatuses(OpenApi.fromApi(Probe).paths, "/probe", "get")).toEqual([
      "400",
      "401",
      "404",
      "413"
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
    expect(errorStatuses(spec.paths, "/v1/pages/{hash}", "put")).toEqual(["400", "401", "413"])
    expect(errorStatuses(spec.paths, "/v1/pages", "get")).toEqual(["401"])
    expect(errorStatuses(spec.paths, "/v1/pages/{hash}", "delete")).toEqual(["401"])
    // Every alias route can 404: a deployment without a KV binding has no
    // aliases to speak of, not an empty list of them.
    expect(errorStatuses(spec.paths, "/v1/aliases", "get")).toEqual(["401", "404"])
    expect(errorStatuses(spec.paths, "/v1/aliases/{name}", "put")).toEqual(["401", "404"])
    expect(errorStatuses(spec.paths, "/v1/aliases/{name}", "delete")).toEqual(["401", "404"])
    // health needs no token, so it has nothing to fail with.
    expect(errorStatuses(spec.paths, "/v1/health", "get")).toEqual([])
  })

  test("only the meta group is outside the bearer token", () => {
    expect(spec.paths["/v1/pages"]?.get?.security).toEqual([{ bearer: [] }])
    expect(spec.paths["/v1/aliases"]?.get?.security).toEqual([{ bearer: [] }])
    expect(spec.paths["/v1/health"]?.get?.security).toEqual([])
  })

  // The whole spec, so M3 and M4 notice if the contract moves under them.
  test("matches the published spec", () => {
    expect(spec).toMatchSnapshot()
  })
})
