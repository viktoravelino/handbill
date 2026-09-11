import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types"
import { Layer } from "effect"
import { AliasesDisabled, AliasesKV } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, AuthSecret, keyStore } from "./auth"
import { BillingDisabled, BillingPolar } from "./billing"
import { DEFAULT_MAX_BYTES, DEFAULT_POLAR_API } from "./config"
import { QuotaKV, QuotaUnlimited } from "./quotas"
import { IndexBucket, IndexKV, StorageR2 } from "./storage"

/**
 * The bindings `wrangler.jsonc` declares and explains, under the rule every
 * optional one obeys: what is not bound is absent rather than empty. `ACCOUNTS`
 * decides what the deployment is — keys, index and counters, or one shared token.
 */
export interface Env {
  readonly ZONE: string
  readonly MAX_BYTES?: string
  readonly PUBLISH_TOKEN?: string
  readonly ADMIN_TOKEN?: string
  readonly POLAR_WEBHOOK_SECRET?: string
  readonly POLAR_ACCESS_TOKEN?: string
  readonly POLAR_PRODUCT_ID?: string
  readonly POLAR_API?: string
  readonly BUCKET: R2Bucket
  readonly ALIASES?: KVNamespace
  readonly ACCOUNTS?: KVNamespace
}

/**
 * `MAX_BYTES` arrives as a string or not at all. Anything that is not a positive
 * whole number — missing, empty, a typo — falls back to the default, because a
 * `NaN` cap silently disables the size check and a `0` cap rejects every publish.
 */
export const maxBytesFrom = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES
}

/**
 * Built once per isolate. The bindings do not change between requests, so the
 * layers are built on the first one and reused.
 */
let app: ReturnType<typeof makeApp> | undefined

const appFor = (env: Env) => {
  const storage = StorageR2(env.BUCKET)
  const { ADMIN_TOKEN: adminToken, POLAR_WEBHOOK_SECRET: webhookSecret, ZONE: zone } = env
  const { POLAR_ACCESS_TOKEN: polar, POLAR_PRODUCT_ID: product } = env
  const api = env.POLAR_API ?? DEFAULT_POLAR_API
  return (app ??= makeApp(
    { zone, maxBytes: maxBytesFrom(env.MAX_BYTES), adminToken, webhookSecret },
    Layer.mergeAll(
      storage,
      // Quotas ride the same binding: hosting strangers is what makes a ceiling
      // worth having, and an operator pays their own bill.
      env.ACCOUNTS === undefined ? QuotaUnlimited : QuotaKV(env.ACCOUNTS),
      // `ACCOUNTS` binds the index the same way it binds auth: with it, `list`
      // reads the KV index and `remove` deletes its entry; without it, the
      // bucket walk is the index and those writes are no-ops (`IndexBucket`
      // needs the shared `Storage`, so it is provided that one instance).
      env.ACCOUNTS === undefined ? IndexBucket.pipe(Layer.provide(storage)) : IndexKV(env.ACCOUNTS),
      env.ACCOUNTS === undefined
        ? AuthSecret(env.PUBLISH_TOKEN ?? "")
        : AuthAccounts(keyStore(env.ACCOUNTS)),
      env.ALIASES === undefined ? AliasesDisabled : AliasesKV(env.ALIASES),
      // Both or neither, an empty secret counting as unset: a token with no
      // product buys nothing and a product with no token cannot be charged for.
      polar && product ? BillingPolar({ api, token: polar, productId: product }) : BillingDisabled
    )
  ))
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => appFor(env).fetch(request)
}
