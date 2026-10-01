import { Context } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { Unauthorized } from "./errors"
import { Owner, Tier } from "./schemas"

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
