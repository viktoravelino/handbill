import { Clock, Context, Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Hash } from "@handbill/contract"
import { Owner } from "@handbill/contract"
import { makeApp } from "@handbill/worker/src/app"
import { AuthSecret, Storage, StorageMemory } from "@handbill/worker/src/services"

export const TOKEN = "publish-me"
export const ZONE = "example.dev"

/** Small enough that a test can go over it without carrying a megabyte around. */
export const MAX_BYTES = 4096

/** Where the Worker's clock starts; every page published before an `advance` carries this instant. */
const CLOCK_START = Date.UTC(2026, 0, 15)
export const PUBLISHED_AT = new Date(CLOCK_START).toISOString()

/** `AuthSecret` owns every page as `"self"`, so that is who `hashes` asks about. */
const SELF = Owner.make("self")

/**
 * A clock the test moves by hand, so `publishedAt` is chosen rather than
 * observed. The Worker stamps it from its own `Clock` when a page is published,
 * and two publishes in the same millisecond tie — `list` then falls back to its
 * hash tie-break and an ordering test becomes a coin toss. `TestClock` does not
 * help: advancing it is an `Effect` that has to run inside the Worker's
 * runtime, and a test only reaches that runtime through `fetch`.
 */
const controlledClock = (start: number) => {
  let millis = start
  const nanos = () => BigInt(millis) * 1_000_000n
  const advance = (duration: Duration.Input) => void (millis += Duration.toMillis(duration))
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.sync(() => millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) => Effect.sync(() => advance(duration))
  }
  return { clock, advance }
}

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
  const time = controlledClock(CLOCK_START)

  const app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      Layer.succeed(Storage, storage),
      AuthSecret(TOKEN),
      // `Clock` is a reference, so this only replaces the default the Worker's
      // own runtime would have used; it adds nothing to `AppServices`.
      Layer.succeed(Clock.Clock, time.clock)
    )
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
    /** Move the Worker's clock, so pages published after it are demonstrably newer. */
    advance: time.advance,
    /** What the store holds, for assertions that do not go through the API. */
    hashes: (): ReadonlyArray<Hash> => Effect.runSync(storage.list(SELF)).map((meta) => meta.hash)
  }
}
