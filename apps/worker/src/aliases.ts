import type { AliasName, Hash } from "@handbill/contract"
import { AliasName as AliasNameSchema, NotFound, Owner } from "@handbill/contract"
import type { KVNamespace } from "@cloudflare/workers-types"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { isHash } from "./hash"

/** An alias as `list` reports it: the name, what it points at, and who set it. */
export interface StoredAlias {
  readonly name: AliasName
  readonly hash: Hash
  readonly owner: Owner
}

/**
 * Living names. `resolve` is on the page-serving path and answers `none` for a
 * name nobody set; the three write/read routes fail with `NotFound` when the
 * deployment has no KV binding, which is how "the feature is absent" reaches the
 * API without every handler asking whether it is switched on.
 */
export interface AliasesShape {
  readonly resolve: (name: AliasName) => Effect.Effect<Option.Option<Hash>>
  readonly set: (name: AliasName, hash: Hash, owner: Owner) => Effect.Effect<void, NotFound>
  readonly remove: (name: AliasName) => Effect.Effect<void, NotFound>
  readonly list: (owner: Owner) => Effect.Effect<ReadonlyArray<StoredAlias>, NotFound>
}

export class Aliases extends Context.Service<Aliases, AliasesShape>()("handbill/Aliases") {}

/** By name, so a listing reads like a directory. */
const byName = (a: StoredAlias, b: StoredAlias): number => a.name.localeCompare(b.name)

/** No KV binding, no feature: every route 404s and no hostname ever resolves. */
export const AliasesDisabled: Layer.Layer<Aliases> = Layer.succeed(Aliases, {
  resolve: () => Effect.succeed(Option.none()),
  set: () => Effect.fail(new NotFound()),
  remove: () => Effect.fail(new NotFound()),
  list: () => Effect.fail(new NotFound())
})

/** In-memory aliases for tests: same semantics as KV, no account, no network. */
export const AliasesMemory: Layer.Layer<Aliases> = Layer.sync(Aliases, () => {
  const names = new Map<string, StoredAlias>()
  return {
    resolve: (name) =>
      Effect.sync(() => Option.map(Option.fromNullishOr(names.get(name)), (alias) => alias.hash)),
    set: (name, hash, owner) => Effect.sync(() => void names.set(name, { name, hash, owner })),
    remove: (name) => Effect.sync(() => void names.delete(name)),
    list: (owner) =>
      Effect.sync(() =>
        Array.from(names.values())
          .filter((alias) => alias.owner === owner)
          .toSorted(byName)
      )
  }
})

/**
 * A KV namespace holds whatever was put in it, including keys from an older
 * deployment or another tool; anything that is not an alias pointing at a hash
 * is treated as absent rather than served or listed.
 */
const isAliasName = Schema.is(AliasNameSchema)

/**
 * Aliases on KV: the name is the key and the hash is the value, so resolving one
 * on the page path is a single read. `owner` and the hash are also written as
 * metadata, which is all `list` gets back from KV — the duplicate keeps a
 * listing one request instead of one per name.
 */
export const AliasesKV = (kv: KVNamespace): Layer.Layer<Aliases> =>
  Layer.succeed(Aliases, {
    resolve: (name) =>
      Effect.promise(async () => {
        const hash = await kv.get(name)
        return hash !== null && isHash(hash) ? Option.some(hash) : Option.none()
      }),
    set: (name, hash, owner) =>
      Effect.promise(() => kv.put(name, hash, { metadata: { owner, hash } })),
    remove: (name) => Effect.promise(() => kv.delete(name)),
    list: (owner) =>
      Effect.promise(async () => {
        const found: Array<StoredAlias> = []
        let cursor: string | undefined
        for (;;) {
          const page = await kv.list<{ owner: string; hash: string }>(cursor ? { cursor } : {})
          for (const key of page.keys) {
            const meta = key.metadata
            if (meta === undefined || meta.owner !== owner) continue
            if (!isAliasName(key.name) || !isHash(meta.hash)) continue
            found.push({ name: key.name, hash: meta.hash, owner: Owner.make(meta.owner) })
          }
          if (page.list_complete) return found.toSorted(byName)
          cursor = page.cursor
        }
      })
  })
