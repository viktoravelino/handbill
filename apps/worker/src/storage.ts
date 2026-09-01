import { type Hash, Owner } from "@handbill/contract"
import type { KVNamespace, R2Bucket, R2Object } from "@cloudflare/workers-types"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { isHash } from "./hash"

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
const metaOf = ({ body: _body, ...meta }: StoredDocument): StoredMeta => meta

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

/**
 * Reads `customMetadata` back into a `StoredMeta`, tolerating objects written by
 * an older deployment. The hash is passed in rather than read off `object.key`:
 * the caller is the one that knows the key is a hash.
 */
const metaFromR2 = (hash: Hash, object: R2Object): StoredMeta => ({
  hash,
  owner: Owner.make(object.customMetadata?.["owner"] ?? "self"),
  title: object.customMetadata?.["title"] ?? "",
  publishedAt: object.customMetadata?.["publishedAt"] ?? "",
  size: object.size
})

/**
 * Production storage: one R2 object per document, metadata on the object itself
 * — no index to keep in sync. The bucket may be shared or hold leftovers from
 * something else, so `list` skips every key that is not a hash.
 */
export const StorageR2 = (bucket: R2Bucket): Layer.Layer<Storage> =>
  Layer.succeed(Storage, {
    put: ({ body, hash, owner, title, publishedAt }) =>
      Effect.promise(() =>
        bucket.put(hash, body, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
          customMetadata: { owner, title, publishedAt }
        })
      ),
    get: (hash) =>
      Effect.promise(async () => {
        const object = await bucket.get(hash)
        if (object === null) return Option.none()
        const body = new Uint8Array(await object.arrayBuffer())
        return Option.some({ ...metaFromR2(hash, object), body })
      }),
    head: (hash) =>
      Effect.promise(async () => {
        const object = await bucket.head(hash)
        return object === null ? Option.none() : Option.some(metaFromR2(hash, object))
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
            const meta = metaFromR2(object.key, object)
            if (meta.owner === owner) found.push(meta)
          }
          if (!page.truncated) return found.toSorted(byNewest)
          cursor = page.cursor
        }
      })
  })

/**
 * The per-owner page index: a derived view of the bucket that lets `list` answer
 * from one KV read instead of a whole-bucket scan. `add`/`remove` keep it in step
 * on publish and unpublish; `list` returns an owner's pages newest first.
 *
 * R2 is the source of truth and the bucket wins on any disagreement — there is
 * deliberately no reconcile job in 0.3 (architecture §04, decision 04). A publish
 * writes the object first and the index second, so a crash between them leaves an
 * object with no entry: invisible in `list`, yet still served and still removable
 * by its owner (which is why `remove` reads ownership from R2, never from here).
 * An entry with no object serves 404 like any unknown hash. Both states are
 * harmless, but only the owner's `remove` heals them — a same-hash republish
 * returns early on the existing object (publish `head` check) and never re-runs
 * `add`, so it does not re-file a missing entry.
 */
export interface IndexShape {
  readonly add: (meta: StoredMeta) => Effect.Effect<void>
  readonly remove: (owner: Owner, hash: Hash) => Effect.Effect<void>
  /** Every page the owner published, newest first. */
  readonly list: (owner: Owner) => Effect.Effect<ReadonlyArray<StoredMeta>>
}

export class Index extends Context.Service<Index, IndexShape>()("handbill/Index") {}

/**
 * The `i:` prefix a listing scans and the key one page is filed under. `owner`
 * can itself contain `:` (a hosted owner is `gh:<id>`), so the hash is never
 * recovered by splitting on `:` — it is whatever follows the owner prefix.
 */
const indexPrefix = (owner: Owner): string => `i:${owner}:`
const indexKey = (owner: Owner, hash: Hash): string => `${indexPrefix(owner)}${hash}`

/** One index entry as KV holds it, in `customMetadata` so `list` needs no per-key read. */
const IndexEntry = Schema.Struct({
  title: Schema.String,
  publishedAt: Schema.String,
  bytes: Schema.Number
})
const isIndexEntry = Schema.is(IndexEntry)

/**
 * Self-hosted index: no `ACCOUNTS` namespace, so the bucket is the index. `list`
 * defers to `Storage.list` — the owner-filtered bucket walk — and the two writes
 * are no-ops, because the object write already recorded the page. In secret mode
 * the operator owns every object, so this is the whole listing.
 */
export const IndexBucket: Layer.Layer<Index, never, Storage> = Layer.effect(
  Index,
  Effect.map(Storage, (storage) => ({
    add: () => Effect.void,
    remove: () => Effect.void,
    list: (owner) => storage.list(owner)
  }))
)

/** In-memory index for tests: same semantics as `IndexKV`, no account, no network. */
export const IndexMemory: Layer.Layer<Index> = Layer.sync(Index, () => {
  const entries = new Map<string, StoredMeta>()
  return {
    add: (meta) => Effect.sync(() => void entries.set(indexKey(meta.owner, meta.hash), meta)),
    remove: (owner, hash) => Effect.sync(() => void entries.delete(indexKey(owner, hash))),
    list: (owner) =>
      Effect.sync(() =>
        Array.from(entries.values())
          .filter((meta) => meta.owner === owner)
          .toSorted(byNewest)
      )
  }
})

/**
 * Hosted index: one `i:<owner>:<hash>` key per page in the `ACCOUNTS` namespace,
 * the `{ title, publishedAt, bytes }` entry carried as KV metadata so `list` is a
 * single prefix scan. The namespace is shared with `AuthAccounts`' `k:` keys;
 * anything that is not a well-formed entry under a hash is skipped.
 */
export const IndexKV = (kv: KVNamespace): Layer.Layer<Index> =>
  Layer.succeed(Index, {
    add: ({ hash, owner, title, publishedAt, size }) =>
      Effect.promise(() =>
        kv.put(indexKey(owner, hash), "", { metadata: { title, publishedAt, bytes: size } })
      ),
    remove: (owner, hash) => Effect.promise(() => kv.delete(indexKey(owner, hash))),
    list: (owner) =>
      Effect.promise(async () => {
        const prefix = indexPrefix(owner)
        const found: Array<StoredMeta> = []
        let cursor: string | undefined
        for (;;) {
          const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) })
          for (const key of page.keys) {
            const hash = key.name.slice(prefix.length)
            const meta = key.metadata
            if (!isIndexEntry(meta) || !isHash(hash)) continue
            found.push({
              hash,
              owner,
              title: meta.title,
              publishedAt: meta.publishedAt,
              size: meta.bytes
            })
          }
          if (page.list_complete) return found.toSorted(byNewest)
          cursor = page.cursor
        }
      })
  })
