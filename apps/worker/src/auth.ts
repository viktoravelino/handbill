import type { Mode } from "@handbill/contract"
import { Owner, Unauthorized } from "@handbill/contract"
import { Context, Effect, Layer, Redacted } from "effect"

/**
 * Turns a bearer token into the owner it belongs to. `AuthSecret` is the
 * self-hosted layer (one `PUBLISH_TOKEN`, owner `"self"`); 0.3 swaps in an
 * accounts layer without the contract moving. `mode` is what `/v1/health`
 * reports so `handbill doctor` can say which one it reached.
 */
export interface AuthShape {
  readonly mode: Mode
  readonly authorize: (token: Redacted.Redacted) => Effect.Effect<Owner, Unauthorized>
}

export class Auth extends Context.Service<Auth, AuthShape>()("handbill/Auth") {}

/** Length-independent comparison, so a wrong token leaks nothing through timing. */
const secretEquals = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0)
  }
  return difference === 0
}

const SELF = Owner.make("self")

/** Self-hosted auth: one shared `PUBLISH_TOKEN` from the Worker secrets, every page owned by `"self"`. */
export const AuthSecret = (token: string): Layer.Layer<Auth> =>
  Layer.succeed(Auth, {
    mode: "secret",
    authorize: (candidate) =>
      token.length > 0 && secretEquals(token, Redacted.value(candidate))
        ? Effect.succeed(SELF)
        : Effect.fail(new Unauthorized())
  })
