import { Context, Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi
} from "effect/unstable/httpapi"
import { HashMismatch, NotFound, TooLarge, Unauthorized } from "./errors"
import {
  Alias,
  AliasList,
  AliasName,
  AliasTarget,
  Hash,
  Health,
  Key,
  KeyRequest,
  Owner,
  PageList,
  PublishResult
} from "./schemas"

/**
 * The owner the bearer token resolved to. `Authorization` provides it, so every
 * handler in the `pages` group can read it without touching headers. Always
 * `"self"` while the Worker runs in secret mode.
 */
export class CurrentOwner extends Context.Service<CurrentOwner, Owner>()(
  "handbill/Authorization/CurrentOwner"
) {}

/**
 * Bearer auth for the `pages` group. `requiredForClient` means a generated
 * client has to supply the token, so the CLI cannot forget it. The Worker swaps
 * the implementation (`AuthSecret` → `AuthAccounts`) without the contract moving.
 */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  {
    provides: CurrentOwner
    requires: never
  }
>()("handbill/Authorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

/**
 * The publish body: the HTML document itself, sent raw rather than wrapped in
 * JSON. `asUint8Array` is what keeps the bytes untouched end to end — the server
 * reads the request as an array buffer and hashes exactly what was sent.
 */
export const HtmlDocument = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "text/html" })
)

/** Everything behind the bearer token: publishing, listing and unpublishing pages. */
export class PagesGroup extends HttpApiGroup.make("pages")
  .add(
    HttpApiEndpoint.put("publish", "/pages/:hash", {
      params: { hash: Hash },
      payload: HtmlDocument,
      success: PublishResult,
      error: [HashMismatch, TooLarge]
    }),
    HttpApiEndpoint.get("list", "/pages", {
      success: PageList
    }),
    // Idempotent for a page that is not there — 204 whether or not it was, so
    // unpublishing a mistake is one command with no questions — but a hash owned
    // by another account is `404 NotFound`, never 403: the owner check deletes
    // nothing and discloses nothing (the Worker reads ownership from R2).
    HttpApiEndpoint.delete("remove", "/pages/:hash", {
      params: { hash: Hash },
      success: HttpApiSchema.NoContent,
      error: NotFound
    })
  )
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: "Pages",
      description: "Publish, list and unpublish documents."
    })
  ) {}

/**
 * Living names. The whole group is optional: a deployment without a KV binding
 * answers `404 NotFound` on every route here, which is why `NotFound` is on all
 * three rather than only on the lookups.
 */
export class AliasesGroup extends HttpApiGroup.make("aliases")
  .add(
    HttpApiEndpoint.put("set", "/aliases/:name", {
      params: { name: AliasName },
      payload: AliasTarget,
      success: Alias,
      error: NotFound
    }),
    HttpApiEndpoint.get("list", "/aliases", {
      success: AliasList,
      error: NotFound
    }),
    // One name, read by key rather than out of the listing. The listing is a
    // lagging index; this is what the name points at now. `NotFound` covers
    // both "nobody set it" and "this deployment has no aliases at all".
    HttpApiEndpoint.get("read", "/aliases/:name", {
      params: { name: AliasName },
      success: Alias,
      error: NotFound
    }),
    // Idempotent like unpublishing: 204 whether or not the name was in use.
    HttpApiEndpoint.delete("remove", "/aliases/:name", {
      params: { name: AliasName },
      success: HttpApiSchema.NoContent,
      error: NotFound
    })
  )
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: "Aliases",
      description: "Point a readable name at a hash. Absent unless the deployment enables it."
    })
  ) {}

/**
 * Keys, the hosted tier's identity. The whole group is optional the way the
 * alias group is: a deployment running on one shared `PUBLISH_TOKEN` has no
 * accounts to mint keys for and answers `404 NotFound` on both routes.
 *
 * Neither route is behind the bearer middleware, because for both the credential
 * *is* the body or header rather than a bearer the middleware would resolve:
 * `mint` carries the GitHub token in its body, and `revoke` reads the key to
 * kill from its own `Authorization` header. Keeping `revoke` off the middleware
 * is also what makes it idempotent — a key that is already revoked must reach
 * the handler and get its 204, not be rejected as `Unauthorized` first.
 */
export class KeysGroup extends HttpApiGroup.make("keys")
  .add(
    HttpApiEndpoint.post("mint", "/keys", {
      payload: KeyRequest,
      success: Key,
      error: [Unauthorized, NotFound]
    }),
    // The key in the `Authorization` header revokes itself, so logging out needs
    // nothing but the key already in hand, and the only thing it can revoke is
    // that key. Idempotent: 204 whether or not the key was still live, and 404
    // only where accounts are off. (`NotFound`, not the middleware's 401.)
    HttpApiEndpoint.delete("revoke", "/keys/current", {
      success: HttpApiSchema.NoContent,
      error: NotFound
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Keys",
      description: "Mint and revoke API keys. Absent unless the deployment runs accounts."
    })
  ) {}

/** Unauthenticated endpoints. `health` is what `handbill doctor` probes. */
export class MetaGroup extends HttpApiGroup.make("meta")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: Health
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Meta",
      description: "Endpoints that need no token."
    })
  ) {}

/**
 * The whole API, and the single source of truth for it: the Worker implements it
 * with `HttpApiBuilder`, the CLI consumes it with `HttpApiClient.make`, and
 * `OpenApi.fromApi` generates the spec. Nobody hand-writes a fetch or a status code.
 */
export class HandbillApi extends HttpApi.make("handbill")
  .add(PagesGroup)
  .add(AliasesGroup)
  .add(KeysGroup)
  .add(MetaGroup)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "handbill",
      version: "0.1.0",
      description:
        "Hand someone a page: one self-contained HTML file at an unguessable, immutable URL."
    })
  ) {}
