import type { Hash, Mode } from "@handbill/contract"
import { Owner, Unauthorized } from "@handbill/contract"
import type { R2Bucket } from "@cloudflare/workers-types"
import { Context, Effect, Layer, Option, Redacted } from "effect"

/**
 * `ZONE` and `MAX_BYTES` as the handlers see them. Read once from the Worker
 * `env`; `zone` is also what the hostname classifier matches against, so it is
 * passed to `makeApp` as a plain value rather than pulled out of the layer.
 */
export interface WorkerConfig {
  readonly zone: string
  readonly maxBytes: number
}

export class Config extends Context.Service<Config, WorkerConfig>()("handbill/Config") {}

/** 5 MB, the cap the CLI enforces before it uploads. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

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
            const meta = metaFromR2(object.key as Hash, object.size, object.customMetadata)
            if (meta.owner === owner) found.push(meta)
          }
          if (!page.truncated) return found.toSorted(byNewest)
          cursor = page.cursor
        }
      })
  })

/**
 * Turns a bearer token into the owner it belongs to. `AuthSecret` is the
 * self-hosted layer (one `PUBLISH_TOKEN`, owner `"self"`); 0.3 swaps in an
 * accounts layer without the contract moving. `mode` is what `/v1/health`
 * reports so `handbill doctor` can say which one it reached.
 */
export interface AuthShape {
  readonly mode: Mode
  readonly authorize: (token: Redacted.Redacted) => Effect.Effect<Owner, Unauthorized>
}

export class Auth extends Context.Service<Auth, AuthShape>()("handbill/Auth") {}

/** Length-independent comparison, so a wrong token leaks nothing through timing. */
const secretEquals = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0)
  }
  return difference === 0
}

const SELF = Owner.make("self")

/** Self-hosted auth: one shared `PUBLISH_TOKEN` from the Worker secrets, every page owned by `"self"`. */
export const AuthSecret = (token: string): Layer.Layer<Auth> =>
  Layer.succeed(Auth, {
    mode: "secret",
    authorize: (candidate) =>
      token.length > 0 && secretEquals(token, Redacted.value(candidate))
        ? Effect.succeed(SELF)
        : Effect.fail(new Unauthorized())
  })
