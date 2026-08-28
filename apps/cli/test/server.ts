import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Hash } from "@handbill/contract"
import { Owner } from "@handbill/contract"
import { makeApp } from "@handbill/worker/src/app"
import { AuthSecret, Storage, StorageMemory } from "@handbill/worker/src/services"

export const TOKEN = "publish-me"
export const ZONE = "example.dev"

/** Small enough that a test can go over it without carrying a megabyte around. */
export const MAX_BYTES = 4096

/** `AuthSecret` owns every page as `"self"`, so that is who `hashes` asks about. */
const SELF = Owner.make("self")

/**
 * The real Worker on `StorageMemory`, handed to the CLI as its `fetch`. The
 * round-trip tests drive `makeApp` — the same function `wrangler` calls — so
 * they exercise the Worker's own layers, routing and headers with no network
 * and no account.
 */
export const makeServer = () => {
  // Built here rather than inside `makeApp` so the test can read the store
  // without going through the API. `StorageMemory` has no finalizer, so
  // closing the scope leaves the instance alive.
  const storage = Context.get(Effect.runSync(Effect.scoped(Layer.build(StorageMemory))), Storage)

  const app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(Layer.succeed(Storage, storage), AuthSecret(TOKEN))
  )

  // `preconnect` is part of the runtime's `fetch` type and the client never
  // calls it; the rest is the Worker standing in for the network.
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      ),
    { preconnect: () => Promise.resolve() }
  )

  return {
    /** Point the CLI's `HttpClient` at the Worker instead of the network. */
    layer: Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer)),
    dispose: () => app.dispose(),
    /** What the store holds, for assertions that do not go through the API. */
    hashes: (): ReadonlyArray<Hash> => Effect.runSync(storage.list(SELF)).map((meta) => meta.hash)
  }
}
