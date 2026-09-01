import { Console, Data, Effect, Match, type PlatformError, Runtime, type Schema } from "effect"
import type { HttpClientError } from "effect/unstable/http"
import type { HashMismatch, NotFound, TooLarge, Unauthorized } from "@handbill/contract"
import type { CannotOpen } from "./browser"
import type { BadConfigFile, MissingToken } from "./config"
import type { LoginFailed } from "./github"

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

/** `remove`, `update` or `alias` was handed a page that is neither a hash nor a handbill URL. */
export class BadTarget extends Data.TaggedError("BadTarget")<{
  readonly target: string
}> {}

/** `alias` was handed a name the contract will not store. */
export class BadName extends Data.TaggedError("BadName")<{
  readonly name: string
}> {}

/**
 * `update` could not move a name the deployment had just listed for it. The
 * feature is plainly on — the listing answered — so this is not the 404
 * {@link describe} explains as "aliases are off", and it says which name.
 */
export class CannotRepoint extends Data.TaggedError("CannotRepoint")<{
  readonly name: string
}> {}

/** `doctor` ran to the end and something it checked is broken. */
export class ChecksFailed extends Data.TaggedError("ChecksFailed")<{
  readonly failed: number
}> {}

/** `login` reached an endpoint that runs on one shared token and has no keys to mint. */
export class NoAccounts extends Data.TaggedError("NoAccounts")<{
  readonly endpoint: string
}> {}

/**
 * `remove` was handed a hash the endpoint will not unpublish. The 404 is the
 * "not yours" answer — never a 403, which would confirm another account holds it
 * — so it covers a page belonging to someone else and one that was never here.
 */
export class NotYours extends Data.TaggedError("NotYours")<{
  readonly hash: string
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
  | CannotRepoint
  | ChecksFailed
  | HashMismatch
  | HttpClientError.HttpClientError
  | LoginFailed
  | MissingToken
  | NoAccounts
  | NotFound
  | NotYours
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
    message: `Could not use ${failure.path}: ${failure.reason}.`
  }),
  BadName: (failure) => ({
    error: "BadName",
    message: `"${failure.name}" is not a name an alias can have: one DNS label of lowercase letters, digits and inner hyphens, and neither "api" nor a hash.`
  }),
  BadTarget: (failure) => ({
    error: "BadTarget",
    message: `"${failure.target}" is not a handbill URL or a 12-character hash. An alias URL names a page without being one: pass the hash it points at, which \`handbill alias list\` prints.`
  }),
  CannotOpen: (failure) => ({
    error: "CannotOpen",
    message: `Could not open ${failure.url} in a browser: ${failure.reason}`
  }),
  CannotRepoint: (failure) => ({
    error: "CannotRepoint",
    message: `Could not point "${failure.name}" at the new page: the endpoint answered 404 for a name it had just listed. The page is published; the name still points at the old one.`
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
  LoginFailed: (failure) => ({
    error: "LoginFailed",
    message: `Could not sign in: ${failure.reason}.`
  }),
  MissingToken: (failure) => ({
    error: "MissingToken",
    message: `No key configured. Run \`handbill login\`, set HANDBILL_TOKEN, or put a token in ${failure.path}.`
  }),
  NoAccounts: (failure) => ({
    error: "NoAccounts",
    message: `${failure.endpoint} does not run accounts, so there is no key to mint. A self-hosted deployment publishes with its PUBLISH_TOKEN: set HANDBILL_TOKEN, or put it in the config file.`
  }),
  // Every caller that can reach a 404 on a route other than the alias ones maps
  // it to something that names what was not found — `NotYours` from `remove`,
  // `NoAccounts` from `login`, `CannotRepoint` from `update`, which has already
  // had a listing answered — so what is left here is the alias group, where a
  // deployment with no KV binding 404s the feature rather than the name.
  NotFound: () => ({
    error: "NotFound",
    message:
      "Aliases are off on this deployment: it has no ALIASES KV binding. Create one (docs/SELF-HOSTING.md) and redeploy."
  }),
  NotYours: (failure) => ({
    error: "NotYours",
    message: `Nothing here to unpublish for ${failure.hash}: either it was never published on this deployment, or it belongs to another account.`
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
    message:
      "The endpoint rejected the token. Run `handbill login` for a hosted deployment, or check it against the Worker's PUBLISH_TOKEN."
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
