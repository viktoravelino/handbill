import { Hash, Owner } from "@handbill/contract"
import { expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import type { StorageShape, StoredDocument } from "./storage"
import { Index, IndexBucket, IndexMemory, Storage, StorageMemory } from "./storage"

const SELF = Owner.make("self")
const OTHER = Owner.make("someone-else")

const document = (hash: string, publishedAt: string, owner = SELF): StoredDocument => ({
  hash: Hash.make(hash),
  owner,
  title: hash,
  publishedAt,
  size: 3,
  body: new TextEncoder().encode("abc")
})

const run = <A>(f: (storage: StorageShape) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.flatMap(Storage, f).pipe(Effect.provide(StorageMemory)))

test("list is newest first and only the caller's pages", async () => {
  const listed = await run((storage) =>
    Effect.gen(function* () {
      yield* storage.put(document("aaaaaaaaaaaa", "2026-08-01T00:00:00.000Z"))
      yield* storage.put(document("cccccccccccc", "2026-08-03T00:00:00.000Z"))
      yield* storage.put(document("bbbbbbbbbbbb", "2026-08-02T00:00:00.000Z"))
      yield* storage.put(document("dddddddddddd", "2026-08-04T00:00:00.000Z", OTHER))
      return yield* storage.list(SELF)
    })
  )
  expect(listed.map((page): string => page.hash)).toEqual([
    "cccccccccccc",
    "bbbbbbbbbbbb",
    "aaaaaaaaaaaa"
  ])
})

test("remove is idempotent", async () => {
  const found = await run((storage) =>
    Effect.gen(function* () {
      yield* storage.put(document("aaaaaaaaaaaa", "2026-08-01T00:00:00.000Z"))
      yield* storage.remove(Hash.make("aaaaaaaaaaaa"))
      yield* storage.remove(Hash.make("aaaaaaaaaaaa"))
      return yield* storage.head(Hash.make("aaaaaaaaaaaa"))
    })
  )
  expect(Option.isNone(found)).toBe(true)
})

test("head reports the metadata without the bytes", async () => {
  const head = await run((storage) =>
    Effect.gen(function* () {
      yield* storage.put(document("aaaaaaaaaaaa", "2026-08-01T00:00:00.000Z"))
      return yield* storage.head(Hash.make("aaaaaaaaaaaa"))
    })
  )
  expect(Option.isSome(head) && head.value).toEqual({
    hash: Hash.make("aaaaaaaaaaaa"),
    owner: SELF,
    title: "aaaaaaaaaaaa",
    publishedAt: "2026-08-01T00:00:00.000Z",
    size: 3
  })
})

/** The hosted index and the bucket, the pair the R2-wins rule is about. */
const withIndexKV = <A>(f: (storage: StorageShape, index: Index["Service"]) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Storage, yield* Index)
    }).pipe(Effect.provide(Layer.mergeAll(StorageMemory, IndexMemory)))
  )

// The bucket wins, and there is no reconcile job (architecture §04, decision 04).
// A publish writes the object first and the index second, so a crash between them
// leaves a page in R2 with no index entry: invisible in `list`, still served.
test("a page in the bucket with no index entry is served but not listed", async () => {
  const { listed, stored } = await withIndexKV((storage, index) =>
    Effect.gen(function* () {
      yield* storage.put(document("aaaaaaaaaaaa", "2026-08-01T00:00:00.000Z"))
      // No `index.add` — the crash was between the two writes.
      return {
        listed: yield* index.list(SELF),
        stored: yield* storage.head(Hash.make("aaaaaaaaaaaa"))
      }
    })
  )
  expect(listed).toEqual([])
  // Still present, so `remove` (which reads ownership from R2, not the index)
  // still finds and deletes it — the orphan is removable by its owner.
  expect(Option.isSome(stored) && stored.value.owner).toBe(SELF)
})

// The mirror case: an index entry whose object never landed (or was removed out
// of band) is listed, but the page path 404s like any unknown hash.
test("an index entry with no object is listed but the object is gone", async () => {
  const { listed, stored } = await withIndexKV((storage, index) =>
    Effect.gen(function* () {
      yield* index.add({
        hash: Hash.make("bbbbbbbbbbbb"),
        owner: SELF,
        title: "orphan",
        publishedAt: "2026-08-02T00:00:00.000Z",
        size: 3
      })
      return {
        listed: yield* index.list(SELF),
        stored: yield* storage.get(Hash.make("bbbbbbbbbbbb"))
      }
    })
  )
  expect(listed.map((page): string => page.hash)).toEqual(["bbbbbbbbbbbb"])
  expect(Option.isNone(stored)).toBe(true)
})

// Self-hosted mode has no `ACCOUNTS` namespace: `IndexBucket` is the bucket walk,
// so `add`/`remove` do nothing and `list` reads straight from storage.
test("IndexBucket is the bucket walk: add and remove are no-ops", async () => {
  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage
      const index = yield* Index
      yield* storage.put(document("aaaaaaaaaaaa", "2026-08-01T00:00:00.000Z"))
      // A no-op: nothing was put in the bucket, so this must not appear.
      yield* index.add(document("cccccccccccc", "2026-08-03T00:00:00.000Z"))
      // Also a no-op: the object stays, so the page stays listed.
      yield* index.remove(SELF, Hash.make("aaaaaaaaaaaa"))
      return yield* index.list(SELF)
    }).pipe(Effect.provide(IndexBucket.pipe(Layer.provideMerge(StorageMemory))))
  )
  expect(listed.map((page): string => page.hash)).toEqual(["aaaaaaaaaaaa"])
})
