import type { AliasName, Hash } from "@handbill/contract"
import { AliasName as AliasNameSchema, Hash as HashSchema } from "@handbill/contract"
import { Effect, Option, Schema } from "effect"
import { Aliases } from "./aliases"
import { Storage } from "./storage"

/**
 * What a request's `Host` means. Four things live on the zone: the API, the
 * pages, the living names — which are only ever resolved, never guessed at —
 * and everything else, which is nothing.
 */
export type HostKind =
  | { readonly kind: "api" }
  | { readonly kind: "page"; readonly hash: Hash }
  | { readonly kind: "alias"; readonly name: AliasName }
  | { readonly kind: "unknown" }

const HASH_LABEL = /^[0-9a-f]{12}$/u
const isAliasName = Schema.is(AliasNameSchema)

/**
 * Lowercased and without the trailing dot a fully-qualified name carries. Both
 * the request's host and the configured zone go through it, so a `ZONE` pasted
 * out of DNS tooling as `example.dev.` classifies — and prints — the same as
 * `example.dev`. `makeApp` canonicalises the zone once so every URL the Worker
 * hands out agrees with what the classifier accepts.
 */
export const canonical = (name: string): string => name.toLowerCase().replace(/\.$/u, "")

/**
 * `api.<zone>` is the API, `<12-hex>.<zone>` is a page, any other single label
 * is an alias to look up, and the apex and anything deeper are nothing. Called
 * on every request before any Effect runs.
 */
export const classifyHost = (hostname: string, zone: string): HostKind => {
  const host = canonical(hostname.split(":")[0] ?? "")
  const suffix = `.${canonical(zone)}`
  if (host === `api${suffix}`) return { kind: "api" }
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length)
    if (HASH_LABEL.test(label)) return { kind: "page", hash: HashSchema.make(label) }
    if (isAliasName(label)) return { kind: "alias", name: label }
  }
  return { kind: "unknown" }
}

/** The apex, a subdomain deeper than one label, or a hash or name nobody published. */
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
 * A hash names bytes that cannot change under it, so its page is cached for a
 * year; an alias is a moving target and gets a minute, long enough to absorb a
 * burst of readers and short enough that republishing feels immediate.
 */
const IMMUTABLE = "public, max-age=31536000, immutable"
const ALIASED = "public, max-age=60"

/**
 * The document behind a hostname, kept out of search results either way. Every
 * path on the hostname serves the same document.
 */
export const servePage = (
  hash: Hash,
  cacheControl = IMMUTABLE
): Effect.Effect<Response, never, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const document = yield* storage.get(hash)
    if (Option.isNone(document)) return nothingHere()
    return new Response(document.value.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": cacheControl,
        "x-robots-tag": "noindex, nofollow",
        "x-content-type-options": "nosniff"
      }
    })
  })

/**
 * The document an alias currently points at — served, not redirected, so the
 * name stays in the reader's address bar and nothing leaks the hash it resolved
 * to. An unset name and a dangling one are both "nothing here".
 */
export const serveAlias = (name: AliasName): Effect.Effect<Response, never, Aliases | Storage> =>
  Effect.gen(function* () {
    const aliases = yield* Aliases
    const hash = yield* aliases.resolve(name)
    return Option.isNone(hash) ? nothingHere() : yield* servePage(hash.value, ALIASED)
  })
