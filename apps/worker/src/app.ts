import { HandbillApi } from "@handbill/contract"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AuthorizationLive, MetaLive, PagesLive } from "./api"
import { canonical, classifyHost, nothingHere, servePage } from "./pages"
import type { Auth } from "./auth"
import type { WorkerConfig } from "./config"
import { Config } from "./config"
import type { Storage } from "./storage"

/**
 * `HttpApiBuilder` asks for the platform services that back `HttpServerResponse.file`,
 * which a Worker has no use for. A no-op filesystem satisfies them without
 * pulling anything real into the bundle.
 */
const PlatformLive = Layer.mergeAll(Etag.layer, Path.layer, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)

/** Everything the handlers need beyond the platform: config, storage, auth. */
export type AppServices = Storage | Auth

/**
 * The Worker as a single `fetch`: classify the hostname, then either hand the
 * request to the Effect web handler for the API or read the document out of
 * storage. `services` is where `StorageR2`/`AuthSecret` and their in-memory
 * counterparts swap in, so the tests drive exactly this function.
 */
export const makeApp = (config: WorkerConfig, services: Layer.Layer<AppServices>) => {
  // One canonical zone for the whole Worker: the classifier matches it, and
  // `pageUrl` and `/v1/health` hand it out.
  const zone = canonical(config.zone)
  const withConfig = Layer.provideMerge(services, Layer.succeed(Config, { ...config, zone }))
  // One memo map, so the API handler and the page path share a single instance
  // of every service — the in-memory bucket above all.
  const memoMap = Layer.makeMemoMapUnsafe()
  const api = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HandbillApi).pipe(
      Layer.provide([PagesLive, MetaLive]),
      Layer.provide(AuthorizationLive),
      // Handler requirements are per-request in Effect 4's router; the same
      // layer also satisfies the middleware's build-time need for `Auth`.
      HttpRouter.provideRequest(withConfig),
      Layer.provide(withConfig),
      Layer.provide(PlatformLive)
    ),
    // Cloudflare already logs every request; a second log line per request
    // only costs CPU.
    { memoMap, disableLogger: true }
  )
  const runtime = ManagedRuntime.make(withConfig, { memoMap })

  return {
    fetch: async (request: Request): Promise<Response> => {
      const host = classifyHost(new URL(request.url).hostname, zone)
      switch (host.kind) {
        case "api": {
          const response = await api.handler(request)
          response.headers.set("cache-control", "no-store")
          return response
        }
        case "page":
          return runtime.runPromise(servePage(host.hash))
        case "unknown":
          return nothingHere()
      }
    },
    dispose: async (): Promise<void> => {
      await Promise.all([api.dispose(), Effect.runPromise(runtime.disposeEffect)])
    }
  }
}
