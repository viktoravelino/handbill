import { HandbillApi } from "@handbill/contract"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AliasesLive, AuthorizationLive, KeysLive, MetaLive, PagesLive } from "./api"
import { canonical, classifyHost, nothingHere, serveAlias, servePage } from "./pages"
import type { Aliases } from "./aliases"
import type { Auth } from "./auth"
import { Config, type WorkerConfig } from "./config"
import type { Index, Storage } from "./storage"

/**
 * `HttpApiBuilder` asks for the platform services that back `HttpServerResponse.file`,
 * which a Worker has no use for. A no-op filesystem satisfies them without
 * pulling anything real into the bundle.
 */
const PlatformLive = Layer.mergeAll(Etag.layer, Path.layer, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)

/** Everything the handlers need beyond the platform: config, storage, the per-owner index, auth, aliases. */
export type AppServices = Storage | Index | Auth | Aliases

/** The spec generated from the contract, and the Scalar page that renders it. Neither needs a token. */
const OPENAPI_PATH = "/v1/openapi.json"
const DOCS_PATH = "/docs"

/**
 * The docs page: Scalar, told where the spec is. `HttpApiScalar` would write this
 * page for us, but importing it drags the 3 MB browser build of Scalar into the
 * Worker bundle even when only its CDN variant is used, so the page is nine lines
 * here instead. The Scalar version is pinned because the page runs it — bump it
 * deliberately, not by drift. Nothing here describes the API; the spec does.
 */
const DocsLive = HttpRouter.add(
  "GET",
  DOCS_PATH,
  // `text` rather than `html` only so the charset is spelled out: every textual
  // response this Worker sends says `charset=utf-8`. The two safety headers are
  // the ones a served page gets — an instance's own reference is for whoever
  // runs it, not for a search index.
  HttpServerResponse.text(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>handbill API</title>
<div id="docs"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.min.js" crossorigin></script>
<script>
  Scalar.createApiReference(document.getElementById("docs"), { url: "${OPENAPI_PATH}" })
</script>
`,
    {
      contentType: "text/html; charset=utf-8",
      headers: { "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" }
    }
  )
)

/**
 * Those two are the only API responses worth caching: they are derived from the
 * contract, so they change on deploy and nowhere else. Everything else is
 * per-request state a shared cache must never hold on to.
 */
const cacheControl = (pathname: string): string =>
  pathname === OPENAPI_PATH || pathname === DOCS_PATH ? "public, max-age=300" : "no-store"

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
    Layer.mergeAll(HttpApiBuilder.layer(HandbillApi, { openapiPath: OPENAPI_PATH }), DocsLive).pipe(
      Layer.provide([PagesLive, AliasesLive, KeysLive, MetaLive]),
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
      const url = new URL(request.url)
      const host = classifyHost(url.hostname, zone)
      switch (host.kind) {
        case "api": {
          const response = await api.handler(request)
          response.headers.set("cache-control", cacheControl(url.pathname))
          return response
        }
        case "page":
          return runtime.runPromise(servePage(host.hash))
        case "alias":
          return runtime.runPromise(serveAlias(host.name))
        case "unknown":
          return nothingHere()
      }
    },
    dispose: async (): Promise<void> => {
      await Promise.all([api.dispose(), Effect.runPromise(runtime.disposeEffect)])
    }
  }
}
