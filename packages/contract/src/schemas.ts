import { Schema } from "effect"

/**
 * The content address of a document: the first 12 hex characters of
 * `sha256(bytes)`. The client computes it to form the URL and the server
 * recomputes it, so a hash always names the bytes it was minted from.
 * 48 bits — unguessable, and short enough to read out loud.
 */
export const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)).pipe(
  Schema.brand("Hash")
)
export type Hash = typeof Hash.Type

/**
 * Who published a page. Stored on every object from 0.1, where it is always
 * `"self"`; the hosted tier (0.3) is what makes it vary, which is why it is in
 * the contract now rather than later.
 */
export const Owner = Schema.String.pipe(Schema.brand("Owner"))
export type Owner = typeof Owner.Type

/**
 * Which auth layer the Worker is running: one shared `PUBLISH_TOKEN`
 * (self-hosted) or per-account API keys (hosted, 0.3).
 */
export const Mode = Schema.Literals(["secret", "accounts"])
export type Mode = typeof Mode.Type

/**
 * What an account is allowed to spend. It is on the key record from 0.3 and
 * only `free` exists there; the quota service reads its limits from a per-tier
 * table keyed by this, so 0.4's paid tier is a new row and a webhook that writes
 * the field rather than a migration (architecture decision 11).
 */
export const Tier = Schema.Literals(["free"])
export type Tier = typeof Tier.Type

/**
 * The two quotas a hosted account can spend: pages published today, and bytes
 * kept stored. Named on the wire, so `QuotaExceeded` says which one tripped.
 */
export const QuotaLimit = Schema.Literals(["pagesPerDay", "storedBytes"])
export type QuotaLimit = typeof QuotaLimit.Type

/**
 * One published page as `GET /v1/pages` reports it. `title` is the document's
 * `<title>`, or `""` when it has none — callers render their own placeholder.
 */
export const Page = Schema.Struct({
  hash: Hash,
  url: Schema.String,
  title: Schema.String,
  publishedAt: Schema.DateTimeUtcFromString,
  size: Schema.Natural
}).annotate({ identifier: "Page" })
export type Page = typeof Page.Type

/** The body of `GET /v1/pages`: every page the caller owns, newest first. */
export const PageList = Schema.Struct({
  pages: Schema.Array(Page)
}).annotate({ identifier: "PageList" })
export type PageList = typeof PageList.Type

/**
 * The body of a successful publish. `created` is `false` when the bytes were
 * already stored — publishing twice is a no-op that returns the same URL.
 */
export const PublishResult = Schema.Struct({
  hash: Hash,
  url: Schema.String,
  created: Schema.Boolean
}).annotate({ identifier: "PublishResult" })
export type PublishResult = typeof PublishResult.Type

/** The body of `GET /v1/health`: enough for `handbill doctor` to say what it reached. */
export const Health = Schema.Struct({
  ok: Schema.Boolean,
  mode: Mode,
  zone: Schema.String
}).annotate({ identifier: "Health" })
export type Health = typeof Health.Type

/**
 * The body of `POST /v1/keys`: a GitHub access token the caller already holds
 * (the CLI gets one from GitHub's device flow). The Worker verifies it with
 * GitHub once and keeps nothing about it — it is an identity proof, not a
 * credential this API stores.
 */
export const KeyRequest = Schema.Struct({
  githubToken: Schema.String
}).annotate({ identifier: "KeyRequest" })
export type KeyRequest = typeof KeyRequest.Type

/**
 * A freshly minted key and the owner it authenticates. The server stores only
 * `SHA-256(key)`, so this response is the one time the key exists in readable
 * form: whoever loses it mints another rather than recovering this one.
 */
export const Key = Schema.Struct({
  key: Schema.String,
  owner: Owner
}).annotate({ identifier: "Key" })
export type Key = typeof Key.Type

/**
 * A living name for a page: one DNS label under the zone, so `plan` is served at
 * `https://plan.<zone>`. The pattern is a hostname label (1–63 characters,
 * alphanumeric ends, hyphens inside) minus the two labels the zone has already
 * spoken for — `api`, which the API answers on, and anything shaped like a
 * hash, which the classifier resolves out of storage and never out of KV.
 * Unlike a hash, an alias is guessable by construction and mutable on purpose.
 */
export const AliasName = Schema.String.check(
  Schema.isPattern(/^(?!api$)(?![0-9a-f]{12}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
).pipe(Schema.brand("AliasName"))
export type AliasName = typeof AliasName.Type

/** Where an alias points, as `PUT /v1/aliases/:name` takes it. */
export const AliasTarget = Schema.Struct({
  hash: Hash
}).annotate({ identifier: "AliasTarget" })
export type AliasTarget = typeof AliasTarget.Type

/** One alias: the name, what it currently points at, and the URL it is served from. */
export const Alias = Schema.Struct({
  name: AliasName,
  hash: Hash,
  url: Schema.String
}).annotate({ identifier: "Alias" })
export type Alias = typeof Alias.Type

/** The body of `GET /v1/aliases`: every alias the caller owns, by name. */
export const AliasList = Schema.Struct({
  aliases: Schema.Array(Alias)
}).annotate({ identifier: "AliasList" })
export type AliasList = typeof AliasList.Type
