import { Clock, Context, Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Hash } from "@handbill/contract"
import { Owner, Unauthorized } from "@handbill/contract"
import { AliasesDisabled, AliasesMemory } from "@handbill/worker/src/aliases"
import { makeApp } from "@handbill/worker/src/app"
import { AuthAccounts, AuthSecret, type Identify, type KeyStore } from "@handbill/worker/src/auth"
import { IndexBucket, IndexMemory, Storage, StorageMemory } from "@handbill/worker/src/storage"

export const TOKEN = "publish-me"
export const ZONE = "example.dev"

/**
 * Accounts mode as the CLI meets it: two GitHub accounts the in-memory
 * `identify` knows, so `login` mints a key for one of them and a test can put a
 * page beyond the other's reach. Nothing else about GitHub is involved — the
 * CLI's own device flow is a swapped layer, and the Worker's check is this
 * function.
 */
export const GITHUB_TOKEN = "gho_from-the-device-flow"
export const OWNER = Owner.make("gh:4242")
export const OTHER_GITHUB_TOKEN = "gho_a-second-account"
export const OTHER_OWNER = Owner.make("gh:9001")

const identify: Identify = (githubToken) =>
  githubToken === GITHUB_TOKEN
    ? Effect.succeed(OWNER)
    : githubToken === OTHER_GITHUB_TOKEN
      ? Effect.succeed(OTHER_OWNER)
      : Effect.fail(new Unauthorized())

/** The `ACCOUNTS` namespace as a `Map`: one key record per minted key. */
const memoryKeys = (): KeyStore => {
  const records = new Map<string, string>()
  return {
    get: (key): Promise<unknown> => Promise.resolve(JSON.parse(records.get(key) ?? "null")),
    put: (key, value): Promise<void> => Promise.resolve(void records.set(key, value))
  }
}

/** Small enough that a test can go over it without carrying a megabyte around. */
export const MAX_BYTES = 4096

/** Where the Worker's clock starts; every page published before an `advance` carries this instant. */
const CLOCK_START = Date.UTC(2026, 0, 15)
export const PUBLISHED_AT = new Date(CLOCK_START).toISOString()

/** `AuthSecret` owns every page as `"self"`, so that is who `hashes` asks about by default. */
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
 * The CLI-facing `fetch`: every call recorded as `PUT /v1/pages/<hash>`, in
 * order, then handed to the Worker. A command that rotates several calls is only
 * correct if they happen in the right order, and that is not visible in the
 * final state. `preconnect` is part of the runtime's `fetch` type and the client
 * never calls it.
 */
const recordingFetch = (
  app: ReturnType<typeof makeApp>,
  requests: Array<string>
): typeof globalThis.fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return app.fetch(request)
    },
    { preconnect: () => Promise.resolve() }
  )

/**
 * The two layers accounts mode swaps: per-account keys instead of one shared
 * token, and its own index rather than the bucket a self-hosted Worker reads.
 */
const authAndIndex = (accounts: boolean, storage: Layer.Layer<Storage>) =>
  accounts
    ? Layer.mergeAll(AuthAccounts(memoryKeys(), identify), IndexMemory)
    : Layer.mergeAll(AuthSecret(TOKEN), IndexBucket.pipe(Layer.provide(storage)))

/**
 * The real Worker on `StorageMemory`, handed to the CLI as its `fetch`. The
 * round-trip tests drive `makeApp` — the same function `wrangler` calls — so
 * they exercise the Worker's own layers, routing and headers with no network
 * and no account. `aliases: false` is a deployment with no KV binding, and
 * `accounts: true` is the hosted tier: keys instead of one shared token.
 */
export const makeServer = (
  options: { readonly aliases?: boolean; readonly accounts?: boolean } = {}
) => {
  // Built here rather than inside `makeApp` so the test can read the store
  // without going through the API. `StorageMemory` has no finalizer, so
  // closing the scope leaves the instance alive.
  const storage = Context.get(Effect.runSync(Effect.scoped(Layer.build(StorageMemory))), Storage)
  const time = controlledClock(CLOCK_START)

  const storageLayer = Layer.succeed(Storage, storage)
  const app = makeApp(
    { zone: ZONE, maxBytes: MAX_BYTES },
    Layer.mergeAll(
      storageLayer,
      authAndIndex(options.accounts === true, storageLayer),
      options.aliases === false ? AliasesDisabled : AliasesMemory,
      // `Clock` is a reference, so this only replaces the default the Worker's
      // own runtime would have used; it adds nothing to `AppServices`.
      Layer.succeed(Clock.Clock, time.clock)
    )
  )

  // Every API call the CLI made, in order; `recordingFetch` fills it.
  const requests: Array<string> = []
  const fetch = recordingFetch(app, requests)

  return {
    /** Point the CLI's `HttpClient` at the Worker instead of the network. */
    layer: Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer)),
    /**
     * The Worker reached directly, outside the CLI: what a reader would get from
     * a hostname, and how a test sets up state another account owns.
     */
    fetch: (url: string, init?: RequestInit) => app.fetch(new Request(url, init)),
    dispose: () => app.dispose(),
    /** Move the Worker's clock, so pages published after it are demonstrably newer. */
    advance: time.advance,
    /** The API calls made so far, method and path, in order. */
    requests: (): ReadonlyArray<string> => [...requests],
    /**
     * The CLI-facing handler itself, so a test can wrap it and break one call.
     * The rotation `update` performs is only interesting when it is interrupted.
     */
    transport: (request: Request) => fetch(request),
    /** What the store holds for an owner, for assertions that do not go through the API. */
    hashes: (owner: Owner = SELF): ReadonlyArray<Hash> =>
      Effect.runSync(storage.list(owner)).map((meta) => meta.hash)
  }
}
