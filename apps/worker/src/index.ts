import type { R2Bucket } from "@cloudflare/workers-types"
import { Layer } from "effect"
import { makeApp } from "./app"
import { AuthSecret, DEFAULT_MAX_BYTES, StorageR2 } from "./services"

/**
 * The bindings `wrangler.jsonc` declares. `ZONE` and the bucket are config,
 * `PUBLISH_TOKEN` is a secret (`wrangler secret put PUBLISH_TOKEN`) and
 * `MAX_BYTES` is optional — it defaults to the CLI's 5 MB cap.
 */
export interface Env {
  readonly ZONE: string
  readonly MAX_BYTES?: string
  readonly PUBLISH_TOKEN?: string
  readonly BUCKET: R2Bucket
}

/**
 * Built once per isolate. The bindings do not change between requests, so the
 * layers are built on the first one and reused.
 */
let app: ReturnType<typeof makeApp> | undefined

const appFor = (env: Env) =>
  (app ??= makeApp(
    { zone: env.ZONE, maxBytes: Number(env.MAX_BYTES ?? DEFAULT_MAX_BYTES) },
    Layer.mergeAll(StorageR2(env.BUCKET), AuthSecret(env.PUBLISH_TOKEN ?? ""))
  ))

export default {
  fetch: (request: Request, env: Env): Promise<Response> => appFor(env).fetch(request)
}
