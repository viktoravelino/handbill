import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { DateTime, Effect, Layer, Redacted, Schema } from "effect"
import { Etag, FetchHttpClient, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Authorization,
  CurrentOwner,
  HandbillApi,
  type Hash,
  HashMismatch,
  Owner,
  type Page,
  TooLarge,
  Unauthorized
} from "@handbill/contract"
import { hashDocument } from "../src/hash"

export const TOKEN = "publish-me"
export const ZONE = "example.dev"

/** Small enough that a test can go over it without carrying a megabyte around. */
export const MAX_BYTES = 4096

const owner = Schema.decodeUnknownSync(Owner)("self")

/** The `<title>` the Worker would store alongside the bytes, or `""`. */
const titleOf = (bytes: Uint8Array) =>
  new TextDecoder()
    .decode(bytes)
    .match(/<title>([\s\S]*?)<\/title>/iu)?.[1]
    ?.trim() ?? ""

/**
 * The contract implemented over a `Map`, served through `HttpRouter.toWebHandler`
 * and handed to the CLI as its `fetch`. It stands in for the Worker (M3) so the
 * round-trip tests exercise real encoding, routing and status codes without a
 * network or a second package.
 */
export const makeServer = () => {
  const pages = new Map<Hash, { bytes: Uint8Array; page: Page }>()

  const PagesLive = HttpApiBuilder.group(HandbillApi, "pages", (handlers) =>
    handlers
      .handle("publish", ({ params, payload }) =>
        Effect.gen(function* () {
          const expected = hashDocument(payload)
          if (expected !== params.hash) return yield* Effect.fail(new HashMismatch({ expected }))
          if (payload.length > MAX_BYTES) {
            return yield* Effect.fail(new TooLarge({ maxBytes: MAX_BYTES }))
          }
          const url = `https://${params.hash}.${ZONE}`
          const created = !pages.has(params.hash)
          if (created) {
            pages.set(params.hash, {
              bytes: payload,
              page: {
                hash: params.hash,
                url,
                title: titleOf(payload),
                publishedAt: yield* DateTime.now,
                size: payload.length
              }
            })
          }
          return { hash: params.hash, url, created }
        })
      )
      .handle("list", () =>
        Effect.succeed({
          // Newest first is the server's job, so the CLI only has to print.
          pages: [...pages.values()]
            .map((entry) => entry.page)
            .toSorted(
              (a, b) =>
                DateTime.toEpochMillis(b.publishedAt) - DateTime.toEpochMillis(a.publishedAt)
            )
        })
      )
      // Idempotent: a hash that was never there is still a 204.
      .handle("remove", ({ params }) => Effect.sync(() => void pages.delete(params.hash)))
  )

  const MetaLive = HttpApiBuilder.group(HandbillApi, "meta", (handlers) =>
    handlers.handle("health", () =>
      Effect.succeed({ ok: true, mode: "secret" as const, zone: ZONE })
    )
  )

  const AuthLive = Layer.succeed(Authorization, {
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === TOKEN
        ? Effect.provideService(httpEffect, CurrentOwner, owner)
        : Effect.fail(new Unauthorized())
  })

  const App = HttpApiBuilder.layer(HandbillApi).pipe(
    Layer.provide([PagesLive, MetaLive]),
    Layer.provide(AuthLive),
    Layer.provide(Etag.layer),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer)
  )

  const { dispose, handler } = HttpRouter.toWebHandler(App, { disableLogger: true })

  // `preconnect` is part of the runtime's `fetch` type and the client never
  // calls it; the rest is the handler standing in for the network.
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      handler(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      ),
    { preconnect: () => Promise.resolve() }
  )

  return {
    /** Point the CLI's `HttpClient` at the handler instead of the network. */
    layer: Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer)),
    dispose,
    /** What the store holds, for assertions that do not go through the API. */
    hashes: (): ReadonlyArray<Hash> => [...pages.keys()]
  }
}
