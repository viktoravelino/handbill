import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
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

const client = (
  credentials: Credentials,
  transformClient?: (http: HttpClient.HttpClient) => HttpClient.HttpClient
) =>
  HttpApiClient.make(HandbillApi, { baseUrl: credentials.endpoint, transformClient }).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
        next(HttpClientRequest.bearerToken(request, credentials.token))
      )
    )
  )

export const make = (credentials: Credentials) => client(credentials)

/**
 * A client for the routes that carry no bearer: `POST /v1/keys`, where the
 * GitHub token in the body is the credential, and `GET /v1/health`. The
 * middleware still has to be satisfied to build a client at all, so it is
 * handed an empty token that those two routes never send.
 */
export const anonymous = (endpoint: string) => client({ endpoint, token: Redacted.make("") })

/**
 * A client that puts the key on every request, middleware or not. `DELETE
 * /v1/keys/current` is self-authorizing — the key in the header is the key it
 * revokes — and is deliberately off the `Authorization` middleware so an
 * already-revoked key still reaches the handler, so `logout` is the one caller
 * that has to attach the header itself.
 */
export const selfAuthorizing = (credentials: Credentials) =>
  client(credentials, HttpClient.mapRequest(HttpClientRequest.bearerToken(credentials.token)))
