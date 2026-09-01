import { type Owner, QuotaExceeded, type Tier } from "@handbill/contract"
import type { KVNamespace } from "@cloudflare/workers-types"
import { Context, DateTime, Effect, Layer } from "effect"

/**
 * The quota numbers, and the one place they live (§05): how often a key
 * publishes, and how much it keeps stored. The tier is read off the key record,
 * so 0.4's paid tier is a row here plus a webhook that writes the field — not a
 * migration, and no handler that knows about money (decision 11). A tier the
 * contract adds without a row here fails to compile where `check` indexes this.
 */
export const TIER_LIMITS = { free: { pagesPerDay: 25, storedBytes: 250 * 1024 * 1024 } } as const

/**
 * The per-owner cost ceiling. `check` runs before the R2 write and fails with
 * the limit that tripped; `record` and `release` move the counters after it, in
 * §04's write order. Counters are best-effort — a KV race can let publish n+1
 * through — because this is a cost ceiling rather than a billing system, and the
 * per-IP WAF rules (docs/WAF.md) are what stop an actual flood.
 */
export interface QuotasShape {
  readonly check: (owner: Owner, tier: Tier, bytes: number) => Effect.Effect<void, QuotaExceeded>
  readonly record: (owner: Owner, bytes: number) => Effect.Effect<void>
  readonly release: (owner: Owner, bytes: number) => Effect.Effect<void>
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
  release: () => Effect.void
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
 * Read, add, write: KV has no atomic increment, so a lost race miscounts by one
 * page or one document, which a ceiling can afford. Floored at zero, so a
 * counter that drifted below what is stored cannot hand out free storage.
 */
const bump = (store: CounterStore, key: string, by: number, ttl?: number) =>
  Effect.promise(async () => store.write(key, Math.max(0, (await store.read(key)) + by), ttl))

/**
 * Quotas over any counter store — the enforcement written once, so the memory
 * layer and the KV layer cannot drift apart. `check` reads both counters and
 * fails on the first limit that is spent, before anything reaches R2. The daily
 * count says when it frees up on its own; stored bytes only unpublishing frees,
 * so that one names no time.
 */
const quotasOn = (store: CounterStore): Layer.Layer<Quotas> =>
  Layer.succeed(Quotas, {
    check: (owner, tier, bytes) =>
      Effect.gen(function* () {
        const { pagesPerDay, storedBytes } = TIER_LIMITS[tier]
        const now = yield* DateTime.now
        const [today, stored] = yield* Effect.promise(() =>
          Promise.all([store.read(dayKey(owner, now)), store.read(bytesKey(owner))])
        )
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
    // Unpublishing gives the bytes back; the day's page count is not refunded,
    // because that limit caps writes rather than what is kept.
    release: (owner, bytes) => bump(store, bytesKey(owner), -bytes)
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
