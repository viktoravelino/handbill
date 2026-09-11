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
import {
  AlreadyPaid,
  HashMismatch,
  NotFound,
  QuotaExceeded,
  TooLarge,
  Unauthorized
} from "./errors"
import {
  Account,
  Alias,
  AliasList,
  AliasName,
  AliasTarget,
  Checkout,
  Hash,
  Health,
  Key,
  KeyRequest,
  Owner,
  PageList,
  PublishResult,
  Tier,
  TierChange
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
 * What the caller's key is allowed to spend, resolved alongside the owner and
 * read by the quota check. Always `"free"` in 0.3; a self-hosted deployment
 * reports it too and counts nothing (decision 11).
 */
export class CurrentTier extends Context.Service<CurrentTier, Tier>()(
  "handbill/Authorization/CurrentTier"
) {}

/**
 * Bearer auth for the `pages` group. `requiredForClient` means a generated
 * client has to supply the token, so the CLI cannot forget it. The Worker swaps
 * the implementation (`AuthSecret` → `AuthAccounts`) without the contract moving.
 */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  {
    provides: CurrentOwner | CurrentTier
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

/**
 * The billing webhook's body: the provider's JSON, kept as the bytes that
 * arrived rather than decoded into a struct. The signature is over the exact
 * body, so anything that re-serialises it — even `JSON.parse` and back — breaks
 * verification; this is `HtmlDocument`'s trick applied for the same reason.
 */
export const WebhookBody = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "application/json" })
)

/**
 * How large a delivery may be before the route stops reading it (413). A Polar
 * subscription event is a couple of kilobytes; anything near this is not one,
 * and refusing it by length costs less than an HMAC over a megabyte.
 */
export const WEBHOOK_MAX_BYTES = 64 * 1024

/** Everything behind the bearer token: publishing, listing and unpublishing pages. */
export class PagesGroup extends HttpApiGroup.make("pages")
  .add(
    HttpApiEndpoint.put("publish", "/pages/:hash", {
      params: { hash: Hash },
      payload: HtmlDocument,
      success: PublishResult,
      error: [HashMismatch, TooLarge, QuotaExceeded]
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

/**
 * The caller's own account: what `handbill account` prints and what the account
 * page reads. Behind the bearer middleware, like the pages group — both answers
 * are about the key presented, and nothing else here names an account.
 *
 * The checkout session is created by the Worker rather than linked to, which is
 * the whole point of the route: the owner it is stamped with is the owner the
 * key resolved to, so holding an account's key is the only way to a checkout
 * that pays for that account. `NotFound` is a deployment with nothing to sell —
 * no billing configured, or secret mode, whose one owner is the operator — and
 * `AlreadyPaid` is an account that has nothing to buy, a second subscription
 * being two things racing to set one tier rather than more quota.
 */
export class AccountGroup extends HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.get("read", "/account", {
      success: Account
    }),
    HttpApiEndpoint.post("checkout", "/account/checkout", {
      success: Checkout,
      error: [NotFound, AlreadyPaid]
    })
  )
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: "Account",
      description: "Tier, usage and the upgrade link for the key presented."
    })
  ) {}

/**
 * The operator's own surface: one route, and the only thing in the API that can
 * kill a published link (§01). It is outside the bearer middleware for the same
 * reason the key routes are — the credential is a different secret, the
 * deployment's `ADMIN_TOKEN`, which the Worker reads from the header itself and
 * compares against no user key. A deployment that sets no such secret has no
 * operator surface and answers `404 NotFound`, the way an absent KV binding
 * takes the alias routes away; a wrong token is `401 Unauthorized`.
 *
 * Takedown and revocation are two acts (§07): this removes the page, and
 * whether the key that published it also dies is a separate decision the
 * operator makes against KV.
 */
export class AdminGroup extends HttpApiGroup.make("admin")
  .add(
    // Idempotent like every other DELETE here: a hash that is not stored — never
    // published, or taken down already — is a 204. A taken-down page then 404s
    // like a hash that never existed; no tombstone (decision, §11).
    HttpApiEndpoint.delete("takedown", "/admin/pages/:hash", {
      params: { hash: Hash },
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, NotFound]
    }),
    // The manual override for a webhook that never landed, and the support tool
    // (0.4 §03): it writes the same field the webhook does. Idempotent and
    // absolute — the tier it names is the tier the owner ends on — so an owner
    // with no keys is a 204 that writes nothing. `NotFound` is the two absences
    // this route can have: no admin token, and no accounts to hold a tier.
    HttpApiEndpoint.put("tier", "/admin/tier/:owner", {
      params: { owner: Owner },
      payload: TierChange,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, NotFound]
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Admin",
      description:
        "Operator takedown and the tier override. Absent unless the deployment sets an admin token."
    })
  ) {}

/**
 * The provider's side of the paid tier: one route, called by Polar rather than
 * by anyone holding a handbill credential. It is outside the bearer middleware
 * because the credential is the signature over the body — there is no token to
 * resolve to an owner, and the owner is something the event carries.
 *
 * A deployment that configures no webhook secret is not selling anything and
 * answers `404 NotFound`, the same additive rule the alias, key and admin
 * routes follow. A body whose signature does not verify, or whose timestamp is
 * outside the replay window, is `401 Unauthorized`.
 *
 * Everything that verifies is `202 Accepted`, including an event this Worker
 * does nothing with — a status that decides nothing, an owner it cannot name:
 * the provider retries on any other status, and there is nothing to retry when
 * the answer would not change. A body over `WEBHOOK_MAX_BYTES` is `413`, read
 * by length before anything reads it at all.
 */
export class BillingGroup extends HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.post("webhook", "/billing/webhook", {
      payload: WebhookBody,
      // The Standard Webhooks headers, all three required: the signature is
      // over `<id>.<timestamp>.<body>`, so a delivery missing any of them
      // cannot be verified and is not a delivery.
      headers: {
        "webhook-id": Schema.String,
        "webhook-timestamp": Schema.String,
        "webhook-signature": Schema.String
      },
      success: HttpApiSchema.Accepted,
      error: [Unauthorized, NotFound, TooLarge]
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Billing",
      description:
        "The payment provider's subscription webhook. Absent unless the deployment sets a webhook secret."
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
  .add(AccountGroup)
  .add(AdminGroup)
  .add(BillingGroup)
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
