import {
  Console,
  Data,
  DateTime,
  Effect,
  Match,
  type PlatformError,
  Runtime,
  type Schema
} from "effect"
import type { HttpClientError } from "effect/unstable/http"
import type {
  AlreadyPaid,
  HashMismatch,
  NotFound,
  QuotaExceeded,
  TooLarge,
  Unauthorized
} from "@handbill/contract"
import type { CannotOpen } from "./browser"
import {
  type BadConfigFile,
  type InsecureEndpoint,
  type MissingToken,
  type UnnamedEndpoint,
  type WrongEndpoint
} from "./config"
import type {
  BadName,
  BadTarget,
  CannotRepoint,
  ChecksFailed,
  ConflictingModes,
  MissingAdminToken,
  NoAccountPage,
  NoAccounts,
  NoBilling,
  NothingToOpen,
  NotYours,
  SecretDocument,
  TakedownRefused,
  TierRefused,
  UnknownAlias,
  WrongDeployment
} from "./failures"
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

/** The CLI's own failures, reachable as `Output.<Name>` like everything else here. */
export * from "./failures"

/**
 * Every failure a command can end on. Keeping it a closed union is what makes
 * {@link describe} exhaustive, so a new error cannot ship without a sentence.
 */
export type Failure =
  | AlreadyPaid
  | BadConfigFile
  | BadName
  | BadTarget
  | CannotOpen
  | CannotRepoint
  | ChecksFailed
  | HashMismatch
  | ConflictingModes
  | HttpClientError.HttpClientError
  | InsecureEndpoint
  | LoginFailed
  | MissingAdminToken
  | MissingToken
  | NoAccountPage
  | NoAccounts
  | NoBilling
  | NotFound
  | NothingToOpen
  | NotYours
  | PlatformError.PlatformError
  | QuotaExceeded
  | Schema.SchemaError
  | SecretDocument
  | TakedownRefused
  | TierRefused
  | TooLarge
  | Unauthorized
  | UnknownAlias
  | UnnamedEndpoint
  | WrongDeployment
  | WrongEndpoint

export interface Described {
  /** The failure's tag, which is what `--json` consumers switch on. */
  readonly error: string
  /** One sentence for a human, and for the `message` field of `--json`. */
  readonly message: string
}

/** The tag and the sentence a user sees for every failure the CLI can produce. */
export const describe = Match.typeTags<Failure, Described>()({
  AlreadyPaid: () => ({
    error: "AlreadyPaid",
    message:
      "This account is already on the paid tier, so there is nothing to buy. Manage or cancel the subscription from the customer portal Polar emailed a link to."
  }),
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
  InsecureEndpoint: (failure) => ({
    error: "InsecureEndpoint",
    message: `${failure.endpoint} is not an https:// endpoint, and this CLI sends a key with nearly every request. Name an https:// endpoint, or http://localhost for a \`wrangler dev\` run.`
  }),
  LoginFailed: (failure) => ({
    error: "LoginFailed",
    message: `Could not sign in: ${failure.reason}.`
  }),
  MissingAdminToken: (failure) => ({
    error: "MissingAdminToken",
    message: `No admin token configured for ${failure.endpoint}. The admin commands use the deployment's ADMIN_TOKEN secret, not your key: set HANDBILL_ADMIN_TOKEN.`
  }),
  MissingToken: (failure) => ({
    error: "MissingToken",
    message: `No key configured. Run \`handbill login\`, set HANDBILL_TOKEN, or put a token in ${failure.path}.`
  }),
  ConflictingModes: (failure) => ({
    error: "ConflictingModes",
    message: `${failure.first} and ${failure.second} each print a URL of their own, so they cannot be combined: run one, then the other.`
  }),
  NoAccountPage: (failure) => ({
    error: "NoAccountPage",
    message: `The account page lives on the hosted site of an \`api.<zone>\` deployment, so --web has no site to open for ${failure.endpoint}. \`handbill account\` prints the same owner, tier and quotas against any deployment.`
  }),
  NoAccounts: (failure) => ({
    error: "NoAccounts",
    message: `${failure.endpoint} does not run accounts, so there is no key to mint. A self-hosted deployment publishes with its PUBLISH_TOKEN: set HANDBILL_TOKEN, or put it in the config file.`
  }),
  NoBilling: (failure) => ({
    error: "NoBilling",
    message: `${failure.endpoint} has no paid tier to buy: it is configured with no payment provider, or it runs on one shared PUBLISH_TOKEN, where the only account is the operator's own.`
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
  NothingToOpen: (failure) => ({
    error: "NothingToOpen",
    message: `\`${failure.command}\` prints no URL, so --open has nothing to open. \`handbill account --upgrade --open\` opens a checkout.`
  }),
  NotYours: (failure) => ({
    error: "NotYours",
    message: `Nothing here to unpublish for ${failure.hash}: either it was never published on this deployment, or it belongs to another account.`
  }),
  PlatformError: (failure) => ({
    error: "PlatformError",
    message: `Could not read the document: ${failure.message}`
  }),
  // The two hosted limits read differently: the daily one frees itself, and the
  // storage one only unpublishing frees, so the sentence says which it is.
  QuotaExceeded: (failure) => ({
    error: "QuotaExceeded",
    message:
      failure.limit === "pagesPerDay"
        ? `You have published ${failure.allowed} pages today, which is this account's daily limit. It resets at ${failure.resetsAt === undefined ? "the next UTC midnight" : DateTime.formatIso(failure.resetsAt)}.`
        : `This account is storing its full ${failure.allowed} bytes, so nothing was published — and nothing already published was removed. Unpublish with \`handbill remove\` until you are back under the limit.`
  }),
  SchemaError: (failure) => ({
    error: "SchemaError",
    message: `The endpoint answered with something this CLI does not understand: ${failure.message}`
  }),
  SecretDocument: (failure) => ({
    error: "SecretDocument",
    message: `Refusing to publish ${failure.file}: ${failure.reason}. A published page is readable by anyone holding its link.`
  }),
  TakedownRefused: (failure) => ({
    error: "TakedownRefused",
    message:
      failure.rejected === true
        ? `${failure.endpoint} did not accept this admin token. HANDBILL_ADMIN_TOKEN has to match the deployment's ADMIN_TOKEN secret; a publishing key is not it.`
        : `${failure.endpoint} has no takedown route: it sets no ADMIN_TOKEN secret. Set one (\`wrangler secret put ADMIN_TOKEN\`) and redeploy.`
  }),
  TierRefused: (failure) => ({
    error: "TierRefused",
    message:
      failure.rejected === true
        ? `${failure.endpoint} did not accept this admin token. HANDBILL_ADMIN_TOKEN has to match the deployment's ADMIN_TOKEN secret; a publishing key is not it.`
        : `${failure.endpoint} has no tier route: it sets no ADMIN_TOKEN secret, or it runs on one shared PUBLISH_TOKEN and has no accounts to carry a tier.`
  }),
  TooLarge: (failure) => ({
    error: "TooLarge",
    message: `The document is over the server's cap of ${failure.maxBytes} bytes.`
  }),
  Unauthorized: () => ({
    error: "Unauthorized",
    message:
      "The endpoint rejected the token. Run `handbill login` for a hosted deployment, or check it against the Worker's PUBLISH_TOKEN."
  }),
  UnknownAlias: (failure) => ({
    error: "UnknownAlias",
    message: `--alias "${failure.name}" names no alias on this deployment: it was never set, it has been removed, or aliases are off here. Nothing was re-pointed and the old page is still published.`
  }),
  UnnamedEndpoint: (failure) => ({
    error: "UnnamedEndpoint",
    message: `This token was not minted by \`handbill login\`, and no endpoint was named — it will not be sent to ${failure.endpoint}. Pass --endpoint, set HANDBILL_ENDPOINT, or put "endpoint" in the config file.`
  }),
  WrongDeployment: (failure) => ({
    error: "WrongDeployment",
    message: `${failure.endpoint} does not know this key, so it is not the deployment that minted it. Nothing was revoked and the local key was left alone: point --endpoint or HANDBILL_ENDPOINT at the deployment you logged in to.`
  }),
  WrongEndpoint: (failure) => ({
    error: "WrongEndpoint",
    message: `The key in ${failure.path} was minted by ${failure.mintedAt}, so it will not be sent to ${failure.endpoint}: run \`handbill login --endpoint ${failure.endpoint}\` to sign in there instead.`
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
