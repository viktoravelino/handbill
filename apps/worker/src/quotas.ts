import type { AccountLimits, AccountUsage, Owner, Tier } from "@handbill/contract"
import { QuotaExceeded } from "@handbill/contract"
import type { KVNamespace } from "@cloudflare/workers-types"
import { Context, DateTime, Effect, Layer } from "effect"

/**
 * The quota numbers, and the one place they live (§05): how often a key publishes, and how much
 * it keeps stored. The tier is read off the key record, so the paid tier is this second row plus
 * a webhook that writes the field — no migration, no handler that knows about money (decision 11),
 * and a tier with no row fails to compile. Page size is no row: 5 MB caps every tier (0.4 §02).
 */
export const TIER_LIMITS = {
  free: { pagesPerDay: 25, storedBytes: 250 * 1024 * 1024 },
  paid: { pagesPerDay: 250, storedBytes: 5 * 1024 * 1024 * 1024 }
} as const

/**
 * The per-owner cost ceiling. `check` runs before the R2 write and fails with the limit
 * that tripped; `record` and `release` move the counters after it (§04's order). Counters
 * are eventually consistent: parallel requests all read one stale count and overshoot by a
 * publish rate rather than by one, so WAF rule 1 is required rather than advisory.
 */
export interface QuotasShape {
  readonly check: (owner: Owner, tier: Tier, bytes: number) => Effect.Effect<void, QuotaExceeded>
  readonly record: (owner: Owner, bytes: number) => Effect.Effect<void>
  readonly release: (owner: Owner, bytes: number) => Effect.Effect<void>
  /** For the account route: the counters `check` reads, and the row it spends against. */
  readonly usage: (owner: Owner) => Effect.Effect<AccountUsage>
  readonly limits: (tier: Tier) => AccountLimits | null
}

export class Quotas extends Context.Service<Quotas, QuotasShape>()("handbill/Quotas") {}

/**
 * Self-hosted: the operator pays their own R2 bill, so nothing is counted and
 * nothing refused. A deployment with no `ACCOUNTS` binding gets this one, which
 * is why no handler asks whether quotas are on.
 */
export const QuotaUnlimited: Layer.Layer<Quotas> = Layer.succeed(Quotas, {
  check: () => Effect.void,
  record: () => Effect.void,
  release: () => Effect.void,
  // `null` limits, never a zero ceiling, which would read as nothing left.
  usage: () => Effect.succeed({ pagesToday: 0, storedBytes: 0 }),
  limits: () => null
})

/**
 * The counters as this service wants them: a number under a key, absent reading
 * as zero. A `Map` satisfies it, which is how the tests run quotas with no KV.
 */
interface CounterStore {
  readonly read: (key: string) => Promise<number>
  readonly write: (key: string, value: number, ttlSeconds?: number) => Promise<void>
}

/** Two days, so yesterday's counter expires itself instead of needing a sweep. */
const DAY_TTL = 48 * 60 * 60

/** The §04 keys. The day is UTC, so everyone's counter resets at one instant. */
const dayKey = (owner: Owner, now: DateTime.Utc): string =>
  `q:${owner}:d:${DateTime.formatIsoDate(now).replaceAll("-", "")}`
const bytesKey = (owner: Owner): string => `q:${owner}:bytes`

/**
 * Read, add, write: KV has no atomic increment. Floored at zero, so a counter
 * that drifted below what is stored cannot hand out free storage.
 */
const bump = (store: CounterStore, key: string, by: number, ttl?: number) =>
  Effect.promise(async () => store.write(key, Math.max(0, (await store.read(key)) + by), ttl))

/** Both counters at one instant, read together: `check` spends against them and `usage` reports them. */
const read = (store: CounterStore, owner: Owner, now: DateTime.Utc) =>
  Effect.promise(async () => {
    const [pagesToday, storedBytes] = await Promise.all([
      store.read(dayKey(owner, now)),
      store.read(bytesKey(owner))
    ])
    return { pagesToday, storedBytes }
  })

/**
 * Quotas over any counter store — the enforcement written once, so the memory
 * layer and the KV layer cannot drift apart. `check` reads both counters and
 * fails on the first limit that is spent, before anything reaches R2. The daily
 * count says when it frees up on its own; stored bytes only unpublishing frees,
 * so that one names no time.
 */
export const quotasOn = (store: CounterStore): Layer.Layer<Quotas> =>
  Layer.succeed(Quotas, {
    check: (owner, tier, bytes) =>
      Effect.gen(function* () {
        const { pagesPerDay, storedBytes } = TIER_LIMITS[tier]
        const now = yield* DateTime.now
        const { pagesToday: today, storedBytes: stored } = yield* read(store, owner, now)
        if (today >= pagesPerDay) {
          const resetsAt = DateTime.startOf(DateTime.add(now, { days: 1 }), "day")
          const spent = { limit: "pagesPerDay", allowed: pagesPerDay, resetsAt } as const
          return yield* Effect.fail(new QuotaExceeded(spent))
        }
        if (stored + bytes > storedBytes) {
          const spent = { limit: "storedBytes", allowed: storedBytes } as const
          return yield* Effect.fail(new QuotaExceeded(spent))
        }
      }),
    record: (owner, bytes) =>
      Effect.gen(function* () {
        yield* bump(store, dayKey(owner, yield* DateTime.now), 1, DAY_TTL)
        yield* bump(store, bytesKey(owner), bytes)
      }),
    // Unpublishing gives the bytes back; the day's count is not refunded, because that
    // limit caps writes rather than what is kept. Swallowed, not fatal: the object is
    // already gone, so a 500 here misreports a removal that worked, and the retry finds
    // nothing to release and leaves the counter high for good (#118 review).
    release: (owner, bytes) => Effect.ignoreCause(bump(store, bytesKey(owner), -bytes)),
    usage: (owner) => Effect.flatMap(DateTime.now, (now) => read(store, owner, now)),
    limits: (tier) => TIER_LIMITS[tier]
  })

/**
 * In-memory counters for tests: same semantics as KV, no account, no network.
 * The map is a parameter so a test can seed a day's count or read one back.
 */
export const QuotaMemory = (counters = new Map<string, number>()): Layer.Layer<Quotas> =>
  quotasOn({
    read: (key) => Promise.resolve(counters.get(key) ?? 0),
    write: (key, value) => Promise.resolve(void counters.set(key, value))
  })

/**
 * Counters in the `ACCOUNTS` namespace, sharing the binding with the key records
 * and the index. Values are decimal strings; anything else under one of these
 * keys reads as zero rather than `NaN`, which would compare false against every
 * limit and switch quotas off in silence.
 */
export const QuotaKV = (kv: KVNamespace): Layer.Layer<Quotas> =>
  quotasOn({
    read: async (key) => Number(await kv.get(key)) || 0,
    write: (key, value, ttlSeconds) =>
      kv.put(key, String(value), ttlSeconds === undefined ? {} : { expirationTtl: ttlSeconds })
  })
