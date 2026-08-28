import { Hash, Owner } from "@handbill/contract"
import type { R2Bucket } from "@cloudflare/workers-types"
import { Context, Effect, Layer, Option, Schema } from "effect"

/** Everything about a stored document except its bytes — i.e. its `customMetadata` plus the object size. */
export interface StoredMeta {
  readonly hash: Hash
  readonly owner: Owner
  readonly title: string
  /** ISO-8601, stored verbatim in `customMetadata.publishedAt`. */
  readonly publishedAt: string
  readonly size: number
}

export interface StoredDocument extends StoredMeta {
  readonly body: Uint8Array
}

/**
 * The object store, keyed by hash. `StorageR2` is production, `StorageMemory`
 * is what the tests run on — the swap is the whole reason this is a service.
 * Backend failures are defects: there is nothing a caller can do about them and
 * the contract has no error for them.
 */
export interface StorageShape {
  readonly put: (document: StoredDocument) => Effect.Effect<void>
  readonly get: (hash: Hash) => Effect.Effect<Option.Option<StoredDocument>>
  readonly head: (hash: Hash) => Effect.Effect<Option.Option<StoredMeta>>
  readonly remove: (hash: Hash) => Effect.Effect<void>
  /** Every page the owner published, newest first. */
  readonly list: (owner: Owner) => Effect.Effect<ReadonlyArray<StoredMeta>>
}

export class Storage extends Context.Service<Storage, StorageShape>()("handbill/Storage") {}

/** The stored document minus its bytes — what `head` and `list` report. */
const metaOf = (document: StoredDocument): StoredMeta => ({
  hash: document.hash,
  owner: document.owner,
  title: document.title,
  publishedAt: document.publishedAt,
  size: document.size
})

/** Newest first, hash-ordered within the same instant so listings are stable. */
const byNewest = (a: StoredMeta, b: StoredMeta): number =>
  b.publishedAt.localeCompare(a.publishedAt) || a.hash.localeCompare(b.hash)

/** In-memory storage for tests: same semantics as R2, no account, no network. */
export const StorageMemory: Layer.Layer<Storage> = Layer.sync(Storage, () => {
  const objects = new Map<string, StoredDocument>()
  return {
    put: (document) => Effect.sync(() => void objects.set(document.hash, document)),
    get: (hash) => Effect.sync(() => Option.fromNullishOr(objects.get(hash))),
    head: (hash) => Effect.sync(() => Option.map(Option.fromNullishOr(objects.get(hash)), metaOf)),
    remove: (hash) => Effect.sync(() => void objects.delete(hash)),
    list: (owner) =>
      Effect.sync(() =>
        Array.from(objects.values(), metaOf)
          .filter((object) => object.owner === owner)
          .toSorted(byNewest)
      )
  }
})

/** Reads `customMetadata` back into a `StoredMeta`, tolerating objects written by an older deployment. */
const metaFromR2 = (
  hash: Hash,
  size: number,
  customMetadata: Record<string, string> | undefined
): StoredMeta => ({
  hash,
  owner: Owner.make(customMetadata?.["owner"] ?? "self"),
  title: customMetadata?.["title"] ?? "",
  publishedAt: customMetadata?.["publishedAt"] ?? "",
  size
})

/**
 * Every key this Worker writes is a hash, but the bucket may be shared or hold
 * leftovers from something else. `list` skips whatever is not one rather than
 * reporting a key the contract's `Hash` would reject.
 */
const isHash = Schema.is(Hash)

/** Production storage: one R2 object per document, metadata on the object itself — no index to keep in sync. */
export const StorageR2 = (bucket: R2Bucket): Layer.Layer<Storage> =>
  Layer.succeed(Storage, {
    put: ({ body, hash, ...meta }) =>
      Effect.promise(() =>
        bucket.put(hash, body, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
          customMetadata: { owner: meta.owner, title: meta.title, publishedAt: meta.publishedAt }
        })
      ),
    get: (hash) =>
      Effect.promise(async () => {
        const object = await bucket.get(hash)
        if (object === null) return Option.none()
        const body = new Uint8Array(await object.arrayBuffer())
        return Option.some({ ...metaFromR2(hash, object.size, object.customMetadata), body })
      }),
    head: (hash) =>
      Effect.promise(async () => {
        const object = await bucket.head(hash)
        return object === null
          ? Option.none()
          : Option.some(metaFromR2(hash, object.size, object.customMetadata))
      }),
    remove: (hash) => Effect.promise(() => bucket.delete(hash)),
    list: (owner) =>
      Effect.promise(async () => {
        const found: Array<StoredMeta> = []
        let cursor: string | undefined
        for (;;) {
          const page = await bucket.list({
            include: ["customMetadata"],
            ...(cursor ? { cursor } : {})
          })
          for (const object of page.objects) {
            if (!isHash(object.key)) continue
            const meta = metaFromR2(object.key, object.size, object.customMetadata)
            if (meta.owner === owner) found.push(meta)
          }
          if (!page.truncated) return found.toSorted(byNewest)
          cursor = page.cursor
        }
      })
  })
