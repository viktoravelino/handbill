import { Context, Data, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientError } from "effect/unstable/http"

/**
 * GitHub's device flow, which is all `handbill login` wants from GitHub: an
 * access token that proves who the user is. The Worker turns it into
 * `gh:<numeric id>` on `POST /v1/keys` and keeps nothing about it.
 *
 * It is a service so the whole GitHub side of `login` is one mockable edge: the
 * round-trip tests swap this layer for one that answers with a canned token and
 * exercise everything after it — the exchange, the config file, the output —
 * against the real Worker with no network.
 */

/**
 * The OAuth app `handbill login` authenticates against. A device-flow client id
 * is public and there is no client secret at all, so this is a constant rather
 * than configuration.
 *
 * TODO(#84): a release blocker for 0.3. The maintainer has to create the GitHub
 * OAuth app with device flow enabled and put its client id here; until then
 * GitHub refuses the first call with `unauthorized_client`, which `login`
 * reports as GitHub's own sentence rather than as a shape it did not expect.
 */
export const CLIENT_ID = "REPLACE_WITH_THE_HANDBILL_OAUTH_APP_CLIENT_ID"

/** Signing in failed for a reason the user can act on: GitHub said no, or the endpoint did. */
export class LoginFailed extends Data.TaggedError("LoginFailed")<{
  readonly reason: string
}> {}

/** What the user has to do, handed to `login` as soon as GitHub has issued it. */
export interface DeviceCode {
  /** The short code the user types into GitHub. */
  readonly userCode: string
  /** The page that asks for it. */
  readonly verificationUri: string
}

export interface GitHubDeviceShape {
  /**
   * Runs the whole flow and returns the access token. `announce` is called once,
   * as soon as there is a code to show, and the polling starts after it: the
   * command decides whether that means printing, opening a browser, or both.
   */
  readonly authorize: (
    announce: (code: DeviceCode) => Effect.Effect<void>
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    LoginFailed | HttpClientError.HttpClientError | Schema.SchemaError
  >
}

export class GitHubDevice extends Context.Service<GitHubDevice, GitHubDeviceShape>()(
  "handbill/GitHubDevice"
) {}

const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"

/**
 * What either endpoint answers with. Everything is optional because both of
 * them return `{ error, error_description }` instead of their own fields on any
 * refusal — a client id GitHub does not know, an expired code — and answering
 * that with a decode failure would blame the shape rather than say what GitHub
 * said. The caller checks for the fields it needed.
 */
const Grant = Schema.Struct({
  device_code: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  /** Seconds to wait between polls; GitHub's documented default is 5. */
  interval: Schema.optional(Schema.Number),
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String)
})
type Grant = typeof Grant.Type

const decodeGrant = Schema.decodeUnknownEffect(Grant)

/** GitHub's refusal in its own words, or a sentence for an answer with nothing in it. */
const refused = (grant: Grant) =>
  new LoginFailed({
    reason:
      grant.error_description ?? grant.error ?? "GitHub answered with neither a code nor an error"
  })

/**
 * One call to an OAuth endpoint. `accept: application/json` is what stops GitHub
 * answering these two in `application/x-www-form-urlencoded`.
 */
const ask = (url: string, body: Record<string, string>) =>
  HttpClient.execute(
    HttpClientRequest.post(url, { headers: { accept: "application/json" } }).pipe(
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeGrant)
  )

/**
 * Polls until the user has approved the code in their browser. `slow_down` is
 * GitHub asking for five more seconds between polls, and the wait comes first
 * because a poll made before the user has typed anything is one GitHub counts
 * against that limit.
 */
const poll = Effect.fn(function* (deviceCode: string, seconds: number) {
  let interval = seconds
  for (;;) {
    yield* Effect.sleep(Duration.seconds(interval))
    const grant = yield* ask(ACCESS_TOKEN_URL, {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
    if (grant.access_token !== undefined) return Redacted.make(grant.access_token)
    if (grant.error === "slow_down") interval += 5
    // `expired_token` is what bounds this loop: a code GitHub has given up on
    // ends the flow rather than being polled forever.
    else if (grant.error !== "authorization_pending") return yield* Effect.fail(refused(grant))
  }
})

/**
 * The real flow. No scope is requested: the only thing the Worker reads is the
 * numeric user id from `api.github.com/user`, which a token with no scope at all
 * already answers, so nothing here can touch a repository.
 */
const flow = Effect.fn(function* (announce: (code: DeviceCode) => Effect.Effect<void>) {
  const grant = yield* ask(DEVICE_CODE_URL, { client_id: CLIENT_ID })
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = grant
  if (deviceCode === undefined || userCode === undefined || uri === undefined) {
    return yield* Effect.fail(refused(grant))
  }
  yield* announce({ userCode, verificationUri: uri })
  return yield* poll(deviceCode, grant.interval ?? 5)
})

/** The published flow, on whatever `HttpClient` the CLI was built with. */
export const GitHubDeviceLive: Layer.Layer<GitHubDevice, never, HttpClient.HttpClient> =
  Layer.effect(
    GitHubDevice,
    Effect.map(HttpClient.HttpClient, (http) => ({
      authorize: (announce) =>
        flow(announce).pipe(Effect.provideService(HttpClient.HttpClient, http))
    }))
  )
