import { Hash } from "@handbill/contract"
import { Effect } from "effect"

const HEX = "0123456789abcdef"

/**
 * `hex(sha256(bytes)).slice(0, 12)` — the content address a page is named by.
 * The client computes it to form the URL and the Worker recomputes it on every
 * publish, so a hash always names the bytes it was minted from.
 */
export const hashBytes = (bytes: Uint8Array): Effect.Effect<Hash> =>
  Effect.map(
    // `digest` wants an `ArrayBuffer`-backed view; a request body is never
    // backed by a `SharedArrayBuffer`.
    Effect.promise(() => crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    (digest) => {
      const view = new Uint8Array(digest, 0, 6)
      let hex = ""
      for (const byte of view) {
        hex += HEX[byte >> 4]! + HEX[byte & 15]!
      }
      return Hash.make(hex)
    }
  )

const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/iu
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'"
}

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
    .replaceAll(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES[entity]!)
    .replaceAll(/\s+/gu, " ")
    .trim()
}
