import type { Hash } from "@handbill/contract"
import { Hash as HashSchema } from "@handbill/contract"
import { Effect, Option } from "effect"
import { Storage } from "./services"

/**
 * What a request's `Host` means. Only three things live on the zone: the API,
 * the pages, and everything else — which is nothing.
 */
export type HostKind =
  | { readonly kind: "api" }
  | { readonly kind: "page"; readonly hash: Hash }
  | { readonly kind: "unknown" }

const HASH_LABEL = /^[0-9a-f]{12}$/u

/**
 * `api.<zone>` is the API, `<12-hex>.<zone>` is a page, and the apex, `www` and
 * anything else are nothing. Called on every request before any Effect runs.
 */
export const classifyHost = (hostname: string, zone: string): HostKind => {
  const host = (hostname.toLowerCase().split(":")[0] ?? "").replace(/\.$/u, "")
  const suffix = `.${zone.toLowerCase()}`
  if (host === `api${suffix}`) return { kind: "api" }
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length)
    if (HASH_LABEL.test(label)) return { kind: "page", hash: HashSchema.make(label) }
  }
  return { kind: "unknown" }
}

/** The apex, `www`, an unknown subdomain, or a hash nobody published. */
export const nothingHere = (): Response =>
  new Response("Nothing here\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  })

/**
 * The document at a hash hostname. Immutable by construction — the bytes cannot
 * change under the URL — so it is cached for a year and kept out of search
 * results. Every path on the hostname serves the same document.
 */
export const servePage = (hash: Hash): Effect.Effect<Response, never, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const document = yield* storage.get(hash)
    if (Option.isNone(document)) return nothingHere()
    return new Response(document.value.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "x-robots-tag": "noindex, nofollow",
        "x-content-type-options": "nosniff"
      }
    })
  })
