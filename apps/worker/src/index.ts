import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types"
import { Layer } from "effect"
import { AliasesDisabled, AliasesKV } from "./aliases"
import { makeApp } from "./app"
import { AuthAccounts, AuthSecret, keyStore } from "./auth"
import { DEFAULT_MAX_BYTES } from "./config"
import { StorageR2 } from "./storage"

/**
 * The bindings `wrangler.jsonc` declares. `ZONE` and the bucket are config,
 * `PUBLISH_TOKEN` is a secret (`wrangler secret put PUBLISH_TOKEN`) and
 * `MAX_BYTES` is optional — it defaults to the CLI's 5 MB cap. `ALIASES` and
 * `ACCOUNTS` are the opt-in KV namespaces: without either one that feature is
 * absent rather than empty. Binding `ACCOUNTS` is what makes a deployment a
 * host — per-account keys instead of the one shared `PUBLISH_TOKEN` — and
 * unbinding it puts the Worker back on the token without touching a page.
 */
export interface Env {
  readonly ZONE: string
  readonly MAX_BYTES?: string
  readonly PUBLISH_TOKEN?: string
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

const appFor = (env: Env) =>
  (app ??= makeApp(
    { zone: env.ZONE, maxBytes: maxBytesFrom(env.MAX_BYTES) },
    Layer.mergeAll(
      StorageR2(env.BUCKET),
      env.ACCOUNTS === undefined
        ? AuthSecret(env.PUBLISH_TOKEN ?? "")
        : AuthAccounts(keyStore(env.ACCOUNTS)),
      env.ALIASES === undefined ? AliasesDisabled : AliasesKV(env.ALIASES)
    )
  ))

export default {
  fetch: (request: Request, env: Env): Promise<Response> => appFor(env).fetch(request)
}
