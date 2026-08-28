import { Effect, type Redacted } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi"
import { Authorization, HandbillApi } from "@handbill/contract"

export interface Credentials {
  readonly endpoint: string
  readonly token: Redacted.Redacted<string>
}

/**
 * A typed client for one deployment, derived from the contract. The bearer
 * token is attached by the contract's own `Authorization` middleware, so no
 * command hand-writes a header, a path or a status code.
 */
export type Client = Effect.Success<ReturnType<typeof make>>

export const make = (credentials: Credentials) =>
  HttpApiClient.make(HandbillApi, { baseUrl: credentials.endpoint }).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
        next(HttpClientRequest.bearerToken(request, credentials.token))
      )
    )
  )
