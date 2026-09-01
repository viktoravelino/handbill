import { Effect, Option, Redacted, Result } from "effect"
import { Command } from "effect/unstable/cli"
import { HttpClient } from "effect/unstable/http"
import type { Mode } from "@handbill/contract"
import * as Client from "./client"
import { handler } from "./command-kit"
import * as Config from "./config"
import { endpointFlag, jsonFlag } from "./flags"
import * as Output from "./output"

/**
 * The `doctor` command and the five checks it runs, together the way
 * `completions.ts` keeps its command next to the script it prints. Nothing
 * outside runs a check on its own, so only the command is exported.
 */

/** `FAIL` is the only status that makes `doctor` exit non-zero. */
type Status = "ok" | "FAIL" | "skip"

interface Check {
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
    case "default":
      return "the built-in default"
  }
}

/**
 * The two checks that only read configuration. There is always an endpoint —
 * {@link Config.DEFAULT_ENDPOINT} is the last resort — so `config` reports which
 * one and where it came from rather than ever failing; a missing key still does.
 */
const configured = (settings: Config.Settings): ReadonlyArray<Check> => [
  check(
    "config",
    "ok",
    `Endpoint ${settings.endpoint.value} from ${sourceOf(settings.endpoint.source, settings.path)}.`
  ),
  Option.isSome(settings.token)
    ? check("token", "ok", `Key from ${sourceOf(settings.token.value.source, settings.path)}.`)
    : check(
        "token",
        "FAIL",
        `No key: run \`handbill login\`, set HANDBILL_TOKEN, or write ${settings.path}.`
      )
]

/**
 * What to do about a credential the endpoint refused. Which fix it is depends
 * on the auth the endpoint runs, and `/v1/health` is the only thing that says:
 * when it did not answer, both are named rather than one of them guessed.
 */
const refusedFix = (mode: Option.Option<Mode>): string => {
  if (Option.isNone(mode)) {
    return "run `handbill login` for a hosted deployment, or check it against the Worker's PUBLISH_TOKEN"
  }
  return mode.value === "accounts"
    ? "run `handbill login` to mint a new key"
    : "check it against the Worker's PUBLISH_TOKEN"
}

/** Does the endpoint take the key? Nothing to try when there is none. */
const accepts = Effect.fn(function* (
  client: Client.Client,
  hasToken: boolean,
  mode: Option.Option<Mode>
) {
  if (!hasToken) return check("auth", "skip", "Skipped: there is no key to send.")
  const pages = yield* Effect.result(client.pages.list({}))
  if (Result.isSuccess(pages)) {
    return check(
      "auth",
      "ok",
      `The endpoint accepted the key; it holds ${pages.success.pages.length} page(s).`
    )
  }
  // Only a 401 says anything about the key. A transport or decode failure is
  // its own problem, and blaming the key for it sends the user hunting for a
  // secret that was fine all along.
  const described = Output.describe(pages.failure)
  if (described.error !== "Unauthorized") {
    return check("auth", "FAIL", `GET /v1/pages did not answer: ${described.message}`)
  }
  return check("auth", "FAIL", `The endpoint refused the key: ${refusedFix(mode)}.`)
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

/**
 * The three checks that need the network, in the order they depend on each
 * other. `health` is also what tells the two later checks which auth the
 * endpoint runs — accounts or one shared secret — so they can name the fix.
 */
const reachable = Effect.fn(function* (settings: Config.Settings) {
  // A missing key still probes health, which needs none; `auth` is the check
  // that reports the key, and it is skipped when there is nothing to send.
  const hasToken = Option.isSome(settings.token)
  const client = yield* Client.make({
    endpoint: settings.endpoint.value,
    token: Option.match(settings.token, {
      onNone: () => Redacted.make(""),
      onSome: (setting) => setting.value
    })
  })

  const health = yield* Effect.result(client.meta.health({}))
  if (Result.isFailure(health)) {
    const described = Output.describe(health.failure)
    // An endpoint that cannot be reached at all makes key acceptance
    // unknowable, so `auth` is skipped rather than failed a second time for the
    // same reason. A health answer that merely did not decode still leaves the
    // key worth trying — with no mode to name the fix from.
    const unreachable = described.error === "HttpClientError"
    return [
      check("health", "FAIL", `GET /v1/health failed: ${described.message}`),
      unreachable
        ? check("auth", "skip", "Skipped: the endpoint could not be reached.")
        : yield* accepts(client, hasToken, Option.none()),
      check("tls", "skip", "Skipped: the zone is only known from /v1/health.")
    ]
  }
  return [
    check(
      "health",
      "ok",
      `GET /v1/health answered: mode ${health.success.mode}, zone ${health.success.zone}.`
    ),
    yield* accepts(client, hasToken, Option.some(health.success.mode)),
    yield* wildcard(health.success.zone)
  ]
})

/**
 * The five things that have to be true for publishing to work. A check whose
 * prerequisite failed is skipped rather than reported as a second failure, so
 * the first `FAIL` in the list is the thing to fix.
 */
const diagnose = Effect.fn(function* (endpoint: Option.Option<string>) {
  const settings = yield* Config.resolve({ endpoint })
  return [...configured(settings), ...(yield* reachable(settings))]
})

/** Prints the report — to stdout, because for `doctor` the report is the result. */
const render = Effect.fn(function* (checks: ReadonlyArray<Check>, asJson: boolean) {
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

export const doctor = Command.make(
  "doctor",
  { endpoint: endpointFlag, json: jsonFlag },
  handler(({ endpoint, json }) =>
    diagnose(endpoint).pipe(
      // A config file that cannot be parsed is exactly what doctor exists to
      // explain, so it becomes a failed check rather than an aborted command.
      Effect.catchTag("BadConfigFile", (error) =>
        Effect.succeed<ReadonlyArray<Check>>([
          { name: "config", status: "FAIL", detail: Output.describe(error).message }
        ])
      ),
      Effect.flatMap((checks) => render(checks, json))
    )
  )
).pipe(
  Command.withDescription(
    "Check the configuration, which endpoint and mode it reaches, whether the key is accepted, and the wildcard certificate."
  )
)
