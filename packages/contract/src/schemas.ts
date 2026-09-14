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
 * What an account is allowed to spend. It is on the key record from 0.3, and
 * the quota service reads its limits from a per-tier table keyed by this, so
 * 0.4's paid tier is one new row plus a webhook that writes the field rather
 * than a migration (architecture decision 11). Nothing on the read path ever
 * consults it: a lapsed card lowers a write quota and breaks no link.
 */
export const Tier = Schema.Literals(["free", "paid"])
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
 * The body of `PUT /v1/admin/tier/:owner`: what the operator is setting the
 * account to. It is the same field the billing webhook writes, so the manual
 * override and the automatic flip cannot drift apart — the override exists for
 * a delivery that never landed, and for support.
 */
export const TierChange = Schema.Struct({
  tier: Tier
}).annotate({ identifier: "TierChange" })
export type TierChange = typeof TierChange.Type

/**
 * What an account has spent: pages published today, and bytes kept stored. The
 * two counters the quota check reads, reported as they stand.
 */
export const AccountUsage = Schema.Struct({
  pagesToday: Schema.Natural,
  storedBytes: Schema.Natural
}).annotate({ identifier: "AccountUsage" })
export type AccountUsage = typeof AccountUsage.Type

/** What a tier allows, straight from the per-tier table the quota check reads. */
export const AccountLimits = Schema.Struct({
  pagesPerDay: Schema.Natural,
  storedBytes: Schema.Natural
}).annotate({ identifier: "AccountLimits" })
export type AccountLimits = typeof AccountLimits.Type

/**
 * The body of `GET /v1/account`: who the presented key belongs to, what it may
 * spend and what it has spent. `limits` is `null` where nothing is counted at
 * all — a self-hosted deployment pays its own bill — which is a different thing
 * from a limit of zero, so nothing rendering this has to guess which it met.
 */
export const Account = Schema.Struct({
  owner: Owner,
  tier: Tier,
  usage: AccountUsage,
  limits: Schema.NullOr(AccountLimits)
}).annotate({ identifier: "Account" })
export type Account = typeof Account.Type

/**
 * The body of `POST /v1/account/checkout`: where to go and pay. The session
 * behind the URL is created by the Worker with the owner taken from the key, so
 * a checkout can only ever pay for the account that asked for it. `https://` is
 * checked rather than assumed — the CLI hands this to a browser with `--open`,
 * and an endpoint is not trusted to have sent a URL scheme at all.
 */
export const Checkout = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https:\/\//u))
}).annotate({ identifier: "Checkout" })
export type Checkout = typeof Checkout.Type

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
