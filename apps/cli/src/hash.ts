import { createHash } from "node:crypto"
import { Schema } from "effect"
import { Hash } from "@handbill/contract"

/**
 * The content address of a document: `hex(sha256(bytes))[0:12]`. The CLI mints
 * it to build the URL it prints; the server recomputes it and rejects a
 * mismatch, so the two must agree byte for byte.
 */
export const hashDocument = (bytes: Uint8Array): Hash =>
  Schema.decodeUnknownSync(Hash)(createHash("sha256").update(bytes).digest("hex").slice(0, 12))
