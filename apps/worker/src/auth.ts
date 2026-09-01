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
 * keys own `gh:<id>` — so a handler that gates an action on `owner === OPERATOR`
 * allows the operator in both modes and no hosted user in accounts mode, which
 * is how "operator-only" features (aliases, decision 08) stay operator-only
 * without any handler asking which mode is on.
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
    // The tier is reported for shape's sake: the same deployment runs
    // `QuotaUnlimited`, so nothing ever reads a limit for the operator.
    authorize: (candidate) =>
      token.length > 0 && secretEquals(token, Redacted.value(candidate))
        ? Effect.succeed({ owner: OPERATOR, tier: "free" as const })
        : Effect.fail(new Unauthorized()),
    mint: () => Effect.fail(new NotFound()),
    revoke: () => Effect.fail(new NotFound())
  })

/**
 * The slice of the `ACCOUNTS` KV namespace this layer needs. Narrow on purpose:
 * a `Map` satisfies it, which is how the tests drive accounts mode with no
 * Miniflare and no account.
 */
export interface KeyStore {
  readonly get: (key: string) => Promise<unknown>
  readonly put: (key: string, value: string) => Promise<void>
}

/** The `ACCOUNTS` binding as `AuthAccounts` wants it. Every value is a JSON record. */
export const keyStore = (kv: KVNamespace): KeyStore => ({
  get: (key) => kv.get(key, "json"),
  put: (key, value) => kv.put(key, value)
})

/**
 * What `k:<sha256(key)>` holds. `tier` is the quota table's key (decision 11):
 * only `free` exists in 0.3, and 0.4's paid tier is a webhook that rewrites the
 * field rather than a KV migration. Anything else in the namespace, from another
 * prefix or an older shape, is simply not a key.
 */
const KeyRecord = Schema.Struct({
  owner: Owner,
  created: Schema.String,
  revoked: Schema.optional(Schema.String),
  tier: TierSchema
})

const isKeyRecord = Schema.is(KeyRecord)

/** `hb_` + 32 random bytes as base64url: the prefix makes a leaked key greppable. */
const mintKey = (): string => {
  const random = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
  return `hb_${random.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`
}

/**
 * A presented key and what it names: the digest is the KV key, so the key itself
 * is never stored. A record that is missing, revoked, or some other tool's value
 * under the same name all come back `undefined` — one answer, which `authorize`
 * reads as "not a caller" and `revoke` as "nothing to do".
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
 * Only GitHub actively refusing the token — a `401` — is `Unauthorized`. A `5xx`,
 * a `429`, or the `403` GitHub returns for a secondary rate limit is GitHub
 * being unavailable, not a verdict on the token: it throws, so the route dies as
 * a `500` that does not tell the user their token is bad and mints nothing.
 * That is design §03's failure honesty and §11's "an outage blocks new keys and
 * nothing else" — publishing never calls this path, so it is untouched either
 * way.
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

/**
 * Hosted auth: one record per key in the `ACCOUNTS` namespace, filed under the
 * key's digest. Nothing here can turn a record back into a key, so a leaked KV
 * dump mints nothing and a lost key is re-minted rather than recovered.
 * `identify` is the GitHub check, an argument so tests answer it without a
 * network.
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
        const record = JSON.stringify({ owner, created, tier: "free" })
        // Two writes: the record, and an `o:<owner>:<digest>` back-reference, so
        // the operator can get from an abuse report to every key one account
        // holds and revoke them (docs/WAF.md). A record is only reachable by
        // digest, so without this an owner's keys cannot be enumerated at all
        // (#111 review, deferred here). It is a pointer, not a copy: the value is
        // empty and `k:` stays the one truth about a key.
        yield* Effect.promise(() =>
          Promise.all([store.put(`k:${digest}`, record), store.put(`o:${owner}:${digest}`, "")])
        )
        // The one moment the key exists in readable form: it is the response.
        return { key, owner }
      }),
    // Idempotent: a key already revoked, or never minted, returns without
    // failing, so the route answers 204 either way (this is why `DELETE
    // /v1/keys/current` is not behind the authorize middleware — a revoked key
    // must reach here rather than 401 first). The record stays, so the
    // revocation is on the books and already-served pages keep serving.
    revoke: (candidate) =>
      Effect.gen(function* () {
        const { id, record } = yield* readKey(store, candidate)
        if (record === undefined) return
        const revoked = DateTime.formatIso(yield* DateTime.now)
        yield* Effect.promise(() => store.put(id, JSON.stringify({ ...record, revoked })))
      })
  })
