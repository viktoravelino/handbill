import { describe, expect, test } from "bun:test"
import { Clock, Duration, Effect, Layer, Redacted, Result } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { type DeviceCode, GitHubDevice, GitHubDeviceLive } from "../src/github"

/**
 * `src/github.ts` driven at its own seam. The round-trip tests swap the whole
 * `GitHubDevice` service, which is right for them and leaves this file
 * unexecuted — so here the stub is one step lower, at `fetch`, and the poll
 * loop, the `slow_down` back-off, the bound on an expired code and the
 * all-optional decode that exists because GitHub words its refusals at HTTP 200
 * all run for real. No network, and no waiting: the clock returns from `sleep`
 * at once and remembers what it was asked for.
 */

/** One answer from github.com, in the order the flow will ask for them. */
interface Answer {
  readonly status?: number
  /** A string is sent as-is, so a test can answer with something that is not JSON. */
  readonly body: unknown
}

const DEVICE_CODE = {
  device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  interval: 5
}

const github = (answers: ReadonlyArray<Answer>) => {
  const queue = [...answers]
  const urls: Array<string> = []
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input))
      const answer = queue.shift()
      if (answer === undefined) return Promise.reject(new Error("github was asked once too often"))
      const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)
      return Promise.resolve(
        new Response(body, {
          status: answer.status ?? 200,
          headers: { "content-type": "application/json" }
        })
      )
    },
    { preconnect: () => Promise.resolve() }
  )
  return {
    layer: Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.merge(FetchHttpClient.layer)),
    urls
  }
}

/** A clock that never actually waits, and records the seconds asked of it. */
const impatient = (waited: Array<number>): Clock.Clock => {
  let millis = 0
  const nanos = () => BigInt(millis) * 1_000_000n
  return {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.sync(() => millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.sync(() => {
        waited.push(Duration.toMillis(duration) / 1000)
        millis += Duration.toMillis(duration)
      })
  }
}

/** The real flow over those answers: what it returned, what it announced, what it waited. */
const authorize = async (answers: ReadonlyArray<Answer>) => {
  const waited: Array<number> = []
  const announced: Array<DeviceCode> = []
  const feed = github(answers)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const device = yield* GitHubDevice
      return yield* device.authorize((code) => Effect.sync(() => void announced.push(code)))
    }).pipe(
      Effect.map(Redacted.value),
      Effect.result,
      // Flat, not `GitHubDeviceLive.pipe(Layer.provide(feed.layer))`: the fetch
      // implementation is a reference the client reads off the *running* fiber,
      // so supplying it only while the layer is built leaves the requests going
      // to the real github.com.
      Effect.provide(GitHubDeviceLive),
      Effect.provide(feed.layer),
      Effect.provide(Layer.succeed(Clock.Clock, impatient(waited)))
    )
  )
  return { result, waited, announced, urls: feed.urls }
}

describe("the device flow", () => {
  test("announces the code, polls past a pending answer, and returns the token", async () => {
    const { announced, result, urls } = await authorize([
      { body: DEVICE_CODE },
      { body: { error: "authorization_pending" } },
      { body: { access_token: "gho_approved", token_type: "bearer" } }
    ])
    expect(announced).toEqual([
      { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" }
    ])
    expect(Result.isSuccess(result) && result.success).toBe("gho_approved")
    expect(urls[0]).toBe("https://github.com/login/device/code")
    expect(urls.slice(1)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://github.com/login/oauth/access_token"
    ])
  })

  // GitHub counts polls made too quickly against the flow, so the back-off has
  // to actually widen rather than be logged and ignored.
  test("waits the interval, and five seconds longer after slow_down", async () => {
    const { result, waited } = await authorize([
      { body: DEVICE_CODE },
      { body: { error: "slow_down" } },
      { body: { access_token: "gho_approved" } }
    ])
    expect(waited).toEqual([5, 10])
    expect(Result.isSuccess(result)).toBe(true)
  })

  // What bounds the loop: any error that is not "keep going" ends it.
  test("stops on an expired code, in GitHub's own words", async () => {
    const { result } = await authorize([
      { body: DEVICE_CODE },
      {
        body: {
          error: "expired_token",
          error_description: "This device code has expired."
        }
      }
    ])
    expect(Result.isFailure(result) && result.failure.reason).toBe("This device code has expired.")
  })
})

describe("when GitHub refuses", () => {
  // A refusal arrives as HTTP 200 with an `error` field, which is why `Grant`
  // is all-optional: decoding it strictly would blame the shape instead.
  test("reports a client id GitHub does not know, without polling", async () => {
    const { result, urls } = await authorize([
      {
        body: {
          error: "unauthorized_client",
          error_description: "The client_id is not valid."
        }
      }
    ])
    expect(Result.isFailure(result) && result.failure.reason).toBe("The client_id is not valid.")
    expect(urls).toHaveLength(1)
  })

  // "The endpoint" means the handbill deployment everywhere else in this CLI,
  // so a GitHub outage must not send anyone to look at it.
  test("names github.com when github.com is what failed", async () => {
    const { result } = await authorize([{ status: 502, body: "<html>Bad gateway</html>" }])
    expect(Result.isFailure(result) && result.failure.reason).toContain("github.com did not answer")
  })
})
