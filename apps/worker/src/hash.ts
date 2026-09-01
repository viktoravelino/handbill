import { Hash } from "@handbill/contract"
import { Effect, Schema } from "effect"

/**
 * Is this string a page address? The one place the hash shape is decided: the
 * hostname classifier, R2 and KV all ask this rather than each carrying a copy
 * of the pattern, so a key written by something else is never mistaken for one
 * of ours. Narrows to the branded `Hash`, so callers need no cast.
 */
export const isHash = Schema.is(Hash)

const hex = (byte: number): string => byte.toString(16).padStart(2, "0")

/**
 * The whole 64-character digest of some bytes. A page address is its first
 * twelve characters; the accounts layer stores the full digest of an API key,
 * which is the only form of a key the Worker ever keeps.
 */
export const sha256Hex = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.map(
    // `digest` wants an `ArrayBuffer`-backed view; a request body is never
    // backed by a `SharedArrayBuffer`.
    Effect.promise(() => crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    (digest) => Array.from(new Uint8Array(digest), hex).join("")
  )

/**
 * `hex(sha256(bytes)).slice(0, 12)` — the content address a page is named by.
 * The client computes it to form the URL and the Worker recomputes it on every
 * publish, so a hash always names the bytes it was minted from.
 */
export const hashBytes = (bytes: Uint8Array): Effect.Effect<Hash> =>
  // Six bytes of the digest is the whole twelve-character address.
  Effect.map(sha256Hex(bytes), (digest) => Hash.make(digest.slice(0, 12)))

const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/iu
/** Keyed by the entity's name, which is what the regex below captures. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }

/**
 * The document's `<title>`, stored as `customMetadata.title` so `handbill list`
 * can label a link without downloading it. `""` when the document has none —
 * callers render their own placeholder. Only the head of the document is
 * decoded; a `<title>` never lives past the first 64 KiB.
 */
export const extractTitle = (bytes: Uint8Array): string => {
  const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024))
  const matched = TITLE.exec(head)?.[1]
  if (matched === undefined) return ""
  return matched
    .replaceAll(/&(amp|lt|gt|quot|#39);/gu, (_, name: string) => ENTITIES[name]!)
    .replaceAll(/\s+/gu, " ")
    .trim()
}
