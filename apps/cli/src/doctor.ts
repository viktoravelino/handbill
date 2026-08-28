import { Effect, Option, Redacted, Result } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Client from "./client"
import * as Config from "./config"
import * as Output from "./output"

/** `FAIL` is the only status that makes `doctor` exit non-zero. */
type Status = "ok" | "FAIL" | "skip"

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
}

const check = (name: string, status: Status, detail: string): Check => ({ name, status, detail })

const sourceOf = (source: Config.Source, path: string) => {
  switch (source) {
    case "flag":
      return "--endpoint"
    case "env":
      return "the environment"
    case "file":
      return path
  }
}

/** The two checks that only read configuration: an endpoint and a token. */
const configured = (settings: Config.Settings): ReadonlyArray<Check> => [
  Option.isSome(settings.endpoint)
    ? check(
        "config",
        "ok",
        `Endpoint ${settings.endpoint.value.value} from ${sourceOf(settings.endpoint.value.source, settings.path)}.`
      )
    : check(
        "config",
        "FAIL",
        `No endpoint: pass --endpoint, set HANDBILL_ENDPOINT, or write ${settings.path}.`
      ),
  Option.isSome(settings.token)
    ? check("token", "ok", `Token from ${sourceOf(settings.token.value.source, settings.path)}.`)
    : check("token", "FAIL", `No token: set HANDBILL_TOKEN or write ${settings.path}.`)
]

/** Does the endpoint take the token? Nothing to try when there is no token. */
const accepts = Effect.fn(function* (client: Client.Client, hasToken: boolean) {
  if (!hasToken) return check("auth", "skip", "Skipped: there is no token to send.")
  const pages = yield* Effect.result(client.pages.list({}))
  return Result.isSuccess(pages)
    ? check(
        "auth",
        "ok",
        `The endpoint accepted the token; it holds ${pages.success.pages.length} page(s).`
      )
    : check(
        "auth",
        "FAIL",
        `The endpoint refused the token: ${Output.describe(pages.failure).message}`
      )
})

/**
 * Pages live on `<hash>.<zone>`, so a wildcard certificate is what makes a
 * published URL openable at all. Any HTTP answer means the handshake worked.
 */
const wildcard = Effect.fn(function* (zone: string) {
  const probe = `https://000000000000.${zone}/`
  const reached = yield* Effect.result(HttpClient.get(probe))
  return Result.isSuccess(reached)
    ? check("tls", "ok", `${probe} completed a TLS handshake.`)
    : check("tls", "FAIL", `${probe} did not answer: ${Output.describe(reached.failure).message}`)
})

/** The three checks that need the network, in the order they depend on each other. */
const reachable = Effect.fn(function* (settings: Config.Settings, endpoint: string) {
  // A missing token still probes health, which needs none; `auth` is the check
  // that reports the token, and it is skipped when there is nothing to send.
  const hasToken = Option.isSome(settings.token)
  const client = yield* Client.make({
    endpoint,
    token: Option.match(settings.token, {
      onNone: () => Redacted.make(""),
      onSome: (setting) => setting.value
    })
  })

  const health = yield* Effect.result(client.meta.health({}))
  if (Result.isFailure(health)) {
    return [
      check("health", "FAIL", `GET /v1/health failed: ${Output.describe(health.failure).message}`),
      yield* accepts(client, hasToken),
      check("tls", "skip", "Skipped: the zone is only known from /v1/health.")
    ]
  }
  return [
    check(
      "health",
      "ok",
      `GET /v1/health answered: mode ${health.success.mode}, zone ${health.success.zone}.`
    ),
    yield* accepts(client, hasToken),
    yield* wildcard(health.success.zone)
  ]
})

/**
 * The five things that have to be true for publishing to work. A check whose
 * prerequisite failed is skipped rather than reported as a second failure, so
 * the first `FAIL` in the list is the thing to fix.
 */
export const diagnose = Effect.fn(function* (endpoint: Option.Option<string>) {
  const settings = yield* Config.resolve({ endpoint })
  const checks = configured(settings)
  if (Option.isNone(settings.endpoint)) {
    return [
      ...checks,
      ...["health", "auth", "tls"].map((name) =>
        check(name, "skip", "Skipped: there is no endpoint to reach.")
      )
    ]
  }
  return [...checks, ...(yield* reachable(settings, settings.endpoint.value.value))]
})

/** Prints the report — to stdout, because for `doctor` the report is the result. */
export const render = Effect.fn(function* (checks: ReadonlyArray<Check>, asJson: boolean) {
  if (asJson) {
    yield* Output.json({ checks })
  } else {
    for (const entry of checks) {
      yield* Output.line(`${entry.status.padEnd(4)}  ${entry.name.padEnd(6)}  ${entry.detail}`)
    }
  }
  const failed = checks.filter((entry) => entry.status === "FAIL").length
  if (failed > 0) yield* Effect.fail(new Output.ChecksFailed({ failed }))
})
