import { Hash, Owner } from "@handbill/contract"
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { StorageShape, StoredDocument } from "./storage"
import { Storage, StorageMemory } from "./storage"

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
