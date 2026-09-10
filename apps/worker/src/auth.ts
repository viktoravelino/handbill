import type { Key, Mode, Tier } from "@handbill/contract"
import { NotFound, Owner, Tier as TierSchema, Unauthorized } from "@handbill/contract"
import type { KVNamespace } from "@cloudflare/workers-types"
import { Context, DateTime, Effect, Layer, Redacted, Schema } from "effect"
import { sha256Hex } from "./hash"

/**
 * Turns a bearer token into the caller it belongs to, and mints and revokes the
 * keys that make one. `AuthSecret` is the self-hosted layer (one
 * `PUBLISH_TOKEN`, owner `"self"`, no keys to mint); `AuthAccounts` is the
 * hosted one. `mode` is what `/v1/health` reports so `handbill doctor` can say
 * which one it reached.
 */
export interface AuthShape {
  readonly mode: Mode
  /** Who the token belongs to and what it may spend: the quota check needs both. */
  readonly authorize: (
    token: Redacted.Redacted
  ) => Effect.Effect<{ owner: Owner; tier: Tier }, Unauthorized>
  readonly mint: (githubToken: string) => Effect.Effect<Key, Unauthorized | NotFound>
  readonly revoke: (token: Redacted.Redacted) => Effect.Effect<void, NotFound>
  /** What the owner's keys may spend from now on, and how many moved. No accounts, `NotFound`. */
  readonly setTier: (owner: Owner, tier: Tier, sub?: string) => Effect.Effect<number, NotFound>
}

export class Auth extends Context.Service<Auth, AuthShape>()("handbill/Auth") {}

/**
 * Length-independent comparison, so a wrong token leaks nothing through timing.
 * Shared with the admin route, which checks a different secret the same way.
 */
export const secretEquals = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0)
  }
  return difference === 0
}

/**
 * The operator: the single owner a self-hosted deployment has, and the identity
 * `AuthSecret` resolves every token to. `AuthAccounts` never issues it — hosted
 * keys own `gh:<id>` — so a handler that gates on `owner === OPERATOR` allows
 * the operator in both modes and no hosted user in accounts mode, which is how
 * "operator-only" features (aliases, decision 08) need no handler to ask.
 */
export const OPERATOR = Owner.make("self")

/**
 * Self-hosted auth: one shared `PUBLISH_TOKEN` from the Worker secrets, every
 * page owned by the operator. There are no accounts here, so the two key routes
 * fail with `NotFound` exactly as `AliasesDisabled` fails the alias routes — the
 * feature is absent rather than empty, and no handler has to ask.
 */
export const AuthSecret = (token: string): Layer.Layer<Auth> =>
  Layer.succeed(Auth, {
    mode: "secret",
    // Tier is shape only: `QuotaUnlimited` runs here, so no limit is ever read.
    authorize: (candidate) =>
      token.length > 0 && secretEquals(token, Redacted.value(candidate))
        ? Effect.succeed({ owner: OPERATOR, tier: "free" as const })
        : Effect.fail(new Unauthorized()),
    mint: () => Effect.fail(new NotFound()),
    revoke: () => Effect.fail(new NotFound()),
    // No accounts, no record to carry a tier: 404 like the key routes.
    setTier: () => Effect.fail(new NotFound())
  })

/**
 * The slice of the `ACCOUNTS` KV namespace this layer needs. Narrow on purpose:
 * a `Map` satisfies it, which is how the tests drive accounts mode with no
 * Miniflare and no account.
 */
export interface KeyStore {
  readonly get: (key: string) => Promise<unknown>
  readonly put: (key: string, value: string) => Promise<void>
  /** The key names under a prefix: one KV page (1000) of `o:<owner>:` is one owner's keys. */
  readonly list: (prefix: string) => Promise<ReadonlyArray<string>>
}

/** The `ACCOUNTS` binding as `AuthAccounts` wants it. Every value is a JSON record. */
export const keyStore = (kv: KVNamespace): KeyStore => ({
  get: (key) => kv.get(key, "json"),
  put: (key, value) => kv.put(key, value),
  list: async (prefix) => (await kv.list({ prefix })).keys.map(({ name }) => name)
})

/**
 * What `k:<sha256(key)>` holds. `tier` is the quota table's key (decision 11),
 * rewritten in place by `setTier` rather than migrated; `subscriptionId` names
 * the subscription that paid for it, kept for good, so a lapsed account —
 * `tier: "free"`, id intact — is still traceable. Anything else is not a key.
 */
const KeyRecord = Schema.Struct({
  owner: Owner,
  created: Schema.String,
  revoked: Schema.optional(Schema.String),
  tier: TierSchema,
  subscriptionId: Schema.optional(Schema.String)
})

const isKeyRecord = Schema.is(KeyRecord)

/** `hb_` + 32 random bytes as base64url: the prefix makes a leaked key greppable. */
const mintKey = (): string => {
  const random = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
  return `hb_${random.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`
}

/**
 * A presented key and what it names: the digest is the KV key, so the key itself
 * is never stored. Missing, revoked, or another tool's value under the same name
 * all come back `undefined` — which `authorize` reads as "not a caller".
 */
const readKey = (store: KeyStore, presented: Redacted.Redacted) =>
  Effect.gen(function* () {
    const digest = yield* sha256Hex(new TextEncoder().encode(Redacted.value(presented)))
    const stored = yield* Effect.promise(() => store.get(`k:${digest}`))
    const record = isKeyRecord(stored) && stored.revoked === undefined ? stored : undefined
    return { id: `k:${digest}`, record }
  })

/** How `AuthAccounts` learns whose GitHub access token it was handed. */
export type Identify = (githubToken: string) => Effect.Effect<Owner, Unauthorized>

const isGitHubUser = Schema.is(Schema.Struct({ id: Schema.Number }))

/**
 * The Worker's only outbound call, made on `POST /v1/keys` and nowhere else: a
 * GitHub access token becomes `gh:<numeric id>`, which survives its owner
 * renaming themselves.
 *
 * Only GitHub actively refusing the token — a `401` — is `Unauthorized`. A
 * `5xx`, a `429`, or a secondary rate limit's `403` is GitHub unavailable, not a
 * verdict: it throws, so the route dies as a `500` that mints nothing and calls
 * no token bad. An outage blocks new keys, not publishing.
 */
export const githubOwner: Identify = (githubToken) =>
  Effect.flatMap(
    Effect.promise(async () => {
      const response = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${githubToken}`, "user-agent": "handbill" }
      })
      if (response.status >= 500 || response.status === 429 || response.status === 403) {
        throw new Error(`github unavailable: ${response.status}`)
      }
      return response.ok ? await response.json() : null
    }),
    (user) =>
      isGitHubUser(user)
        ? Effect.succeed(Owner.make(`gh:${user.id}`))
        : Effect.fail(new Unauthorized())
  )

/** The live keys an owner holds via `o:<owner>:`: what `mint` inherits and `setTier` rewrites. */
const liveKeys = async (store: KeyStore, owner: Owner) => {
  const prefix = `o:${owner}:`
  const ids = (await store.list(prefix)).map((name) => `k:${name.slice(prefix.length)}`)
  const read = await Promise.all(ids.map(async (id) => ({ id, record: await store.get(id) })))
  return read.flatMap(({ id, record }) =>
    isKeyRecord(record) && record.revoked === undefined ? [{ id, record }] : []
  )
}

/**
 * Hosted auth: one record per key in the `ACCOUNTS` namespace, filed under the
 * key's digest. Nothing here can turn a record back into a key, so a leaked KV
 * dump mints nothing and a lost key is re-minted rather than recovered.
 * `identify` is the GitHub check, an argument so tests answer it with no network.
 */
export const AuthAccounts = (
  store: KeyStore,
  identify: Identify = githubOwner
): Layer.Layer<Auth> =>
  Layer.succeed(Auth, {
    mode: "accounts",
    authorize: (candidate) =>
      Effect.flatMap(readKey(store, candidate), ({ record }) =>
        record === undefined
          ? Effect.fail(new Unauthorized())
          : Effect.succeed({ owner: record.owner, tier: record.tier })
      ),
    mint: (githubToken) =>
      Effect.gen(function* () {
        const owner = yield* identify(githubToken)
        const key = mintKey()
        const digest = yield* sha256Hex(new TextEncoder().encode(key))
        const created = DateTime.formatIso(yield* DateTime.now)
        // A second machine joins the account it already belongs to, tier and
        // subscription included, or a paying user's next login would be free.
        const [kin] = yield* Effect.promise(() => liveKeys(store, owner))
        const record = JSON.stringify({ tier: "free", ...kin?.record, owner, created })
        // Two writes: the record, and an `o:<owner>:<digest>` back-reference —
        // the only way to enumerate an account's keys, since a record is
        // reachable by digest alone (#111). It is what `liveKeys` reads, for an
        // abuse report (docs/WAF.md) and for a flip. A pointer, not a copy: the
        // value is empty and `k:` stays the one truth about a key.
        yield* Effect.promise(() =>
          Promise.all([store.put(`k:${digest}`, record), store.put(`o:${owner}:${digest}`, "")])
        )
        // The one moment the key exists in readable form: it is the response.
        return { key, owner }
      }),
    // Idempotent: a key already revoked, or never minted, returns without
    // failing, so the route answers 204 either way — which is why `DELETE
    // /v1/keys/current` is off the authorize middleware, a revoked key having to
    // reach here rather than 401 first. The record stays, on the books.
    revoke: (candidate) =>
      Effect.gen(function* () {
        const { id, record } = yield* readKey(store, candidate)
        if (record === undefined) return
        const revoked = DateTime.formatIso(yield* DateTime.now)
        yield* Effect.promise(() => store.put(id, JSON.stringify({ ...record, revoked })))
      }),
    // Every live key at once, so two machines move together, and an owner with
    // no key yet is not an error — `mint` inherits. Scoped to the subscription
    // that paid, because `metadata.owner` is filled in at checkout: otherwise a
    // stranger could name a victim and later cancel to strip their tier. No
    // `sub` is the operator's override, which writes anything.
    setTier: (owner, tier, sub) =>
      Effect.promise(async () => {
        let moved = 0
        for (const { id, record } of await liveKeys(store, owner)) {
          const { subscriptionId: held, tier: spends } = record
          // An upgrade claims any record not already paying — unclaimed, or
          // lapsed and free to re-subscribe — and its own; a lapse, only its own.
          const mine = sub === undefined || held === sub || (tier === "paid" && spends === "free")
          if (!mine) continue
          await store.put(id, JSON.stringify({ ...record, tier, subscriptionId: sub ?? held }))
          moved += 1
        }
        return moved
      })
  })
