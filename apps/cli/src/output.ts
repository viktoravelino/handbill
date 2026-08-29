import { Console, Data, Effect, Match, type PlatformError, Runtime, type Schema } from "effect"
import type { HttpClientError } from "effect/unstable/http"
import type { HashMismatch, NotFound, TooLarge, Unauthorized } from "@handbill/contract"
import type { CannotOpen } from "./browser"
import type { BadConfigFile, MissingSetting } from "./config"

/** stdout carries the result and nothing else: one line, or one JSON object. */
export const line = (text: string) => Console.log(text)

export const json = (value: unknown) => Console.log(JSON.stringify(value))

/** Diagnostics and failures. Never stdout, so `handbill plan.html` stays pipeable. */
export const note = (text: string) => Console.error(text)

/**
 * Raised once a failure has been written to stderr: the process exits 1 and the
 * runtime does not log the cause a second time.
 */
export class Reported extends Data.TaggedError("Reported") {
  override readonly [Runtime.errorReported] = false
}

/** `remove` or `alias` was handed a page that is neither a hash nor a handbill URL. */
export class BadTarget extends Data.TaggedError("BadTarget")<{
  readonly target: string
}> {}

/** `alias` was handed a name the contract will not store. */
export class BadName extends Data.TaggedError("BadName")<{
  readonly name: string
}> {}

/** `doctor` ran to the end and something it checked is broken. */
export class ChecksFailed extends Data.TaggedError("ChecksFailed")<{
  readonly failed: number
}> {}

/**
 * Every failure a command can end on. Keeping it a closed union is what makes
 * {@link describe} exhaustive, so a new error cannot ship without a sentence.
 */
export type Failure =
  | BadConfigFile
  | BadName
  | BadTarget
  | CannotOpen
  | ChecksFailed
  | HashMismatch
  | HttpClientError.HttpClientError
  | MissingSetting
  | NotFound
  | PlatformError.PlatformError
  | Schema.SchemaError
  | TooLarge
  | Unauthorized

export interface Described {
  /** The failure's tag, which is what `--json` consumers switch on. */
  readonly error: string
  /** One sentence for a human, and for the `message` field of `--json`. */
  readonly message: string
}

/** The tag and the sentence a user sees for every failure the CLI can produce. */
export const describe = Match.typeTags<Failure, Described>()({
  BadConfigFile: (failure) => ({
    error: "BadConfigFile",
    message: `Could not read ${failure.path}: ${failure.reason}.`
  }),
  BadName: (failure) => ({
    error: "BadName",
    message: `"${failure.name}" is not a name an alias can have: one DNS label of lowercase letters, digits and inner hyphens, and neither "api" nor a hash.`
  }),
  BadTarget: (failure) => ({
    error: "BadTarget",
    message: `"${failure.target}" is not a handbill URL or a 12-character hash.`
  }),
  CannotOpen: (failure) => ({
    error: "CannotOpen",
    message: `Could not open ${failure.url} in a browser: ${failure.reason}`
  }),
  ChecksFailed: (failure) => ({
    error: "ChecksFailed",
    message: `${failure.failed} check(s) failed.`
  }),
  HashMismatch: (failure) => ({
    error: "HashMismatch",
    message: `The server hashed the upload to ${failure.expected}, not to the hash this CLI computed: the bytes changed in transit.`
  }),
  HttpClientError: (failure) => ({
    error: "HttpClientError",
    message: `Could not talk to the endpoint: ${failure.message}`
  }),
  MissingSetting: (failure) => ({
    error: "MissingSetting",
    message:
      failure.setting === "endpoint"
        ? `No endpoint configured. Pass --endpoint, set HANDBILL_ENDPOINT, or put it in ${failure.path}.`
        : `No token configured. Set HANDBILL_TOKEN or put it in ${failure.path}.`
  }),
  // The API only answers 404 on the alias routes, and only when the deployment
  // has no KV binding: the feature is absent, not the name.
  NotFound: () => ({
    error: "NotFound",
    message:
      "Aliases are off on this deployment: it has no ALIASES KV binding. Create one (docs/SELF-HOSTING.md) and redeploy."
  }),
  PlatformError: (failure) => ({
    error: "PlatformError",
    message: `Could not read the document: ${failure.message}`
  }),
  SchemaError: (failure) => ({
    error: "SchemaError",
    message: `The endpoint answered with something this CLI does not understand: ${failure.message}`
  }),
  TooLarge: (failure) => ({
    error: "TooLarge",
    message: `The document is over the server's cap of ${failure.maxBytes} bytes.`
  }),
  Unauthorized: () => ({
    error: "Unauthorized",
    message: "The endpoint rejected the token. Check it against the Worker's PUBLISH_TOKEN."
  })
})

/**
 * Writes a failure to stderr in the shape the caller asked for and ends the
 * command non-zero. Wrap a command body in this and stdout stays clean whatever
 * goes wrong.
 */
export const reporting =
  (options: { readonly json: boolean }) =>
  <A, R>(effect: Effect.Effect<A, Failure, R>): Effect.Effect<A, Reported, R> =>
    Effect.catch(effect, (failure) => {
      const described = describe(failure)
      return Effect.andThen(
        note(options.json ? JSON.stringify(described) : described.message),
        Effect.fail(new Reported())
      )
    })
