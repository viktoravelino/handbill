import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { credentials, DEFAULT_ENDPOINT, MissingToken, resolve, save } from "../src/config"
import { configHome } from "./harness"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Resolves against a config home that already exists on disk. */
const resolveIn = (
  home: string,
  options: { readonly flag?: string; readonly env?: Record<string, string | undefined> } = {}
) =>
  Effect.runPromise(
    resolve({ endpoint: Option.fromUndefinedOr(options.flag) }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({ XDG_CONFIG_HOME: home, ...options.env })
        )
      ),
      Effect.provide(platform)
    )
  )

const resolveWith = (options: {
  readonly flag?: string
  readonly env?: Record<string, string | undefined>
  readonly file?: string
}) => resolveIn(configHome(options.file), options)

const file = JSON.stringify({ endpoint: "https://file.example.dev", token: "file-token" })

const contentsOf = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

describe("resolve", () => {
  // The whole endpoint chain in one place: flag, environment, file, default.
  test("takes the endpoint from the flag before the environment and the file", async () => {
    const settings = await resolveWith({
      flag: "https://flag.example.dev",
      env: { HANDBILL_ENDPOINT: "https://env.example.dev" },
      file
    })
    expect(settings.endpoint).toEqual({ value: "https://flag.example.dev", source: "flag" })
  })

  test("takes the endpoint from the environment before the file", async () => {
    const settings = await resolveWith({
      env: { HANDBILL_ENDPOINT: "https://env.example.dev" },
      file
    })
    expect(settings.endpoint).toEqual({ value: "https://env.example.dev", source: "env" })
  })

  test("falls back to the config file for both settings", async () => {
    const settings = await resolveWith({ file })
    expect(settings.endpoint).toEqual({ value: "https://file.example.dev", source: "file" })
    expect(Option.map(settings.token, (token) => Redacted.value(token.value))).toEqual(
      Option.some("file-token")
    )
  })

  test("takes the token from the environment before the file", async () => {
    const settings = await resolveWith({ env: { HANDBILL_TOKEN: "env-token" }, file })
    expect(Option.map(settings.token, (token) => token.source)).toEqual(Option.some("env"))
  })

  // S3.1: an unconfigured machine points at the hosted deployment, and a
  // self-hoster who set any of the three above notices nothing.
  test("falls back to the hosted endpoint, and to no token at all", async () => {
    const settings = await resolveWith({})
    expect(settings.endpoint).toEqual({ value: DEFAULT_ENDPOINT, source: "default" })
    expect(settings.token).toEqual(Option.none())
    expect(settings.path).toEndWith("/handbill/config.json")
  })

  // #161: a bearer key rides on nearly every request, so the endpoint has to be
  // one TLS protects. Loopback is the exception, because `wrangler dev` is there
  // and nothing leaves the machine.
  test("refuses an http:// endpoint that is not loopback", async () => {
    const failure = await resolveWith({ flag: "http://evil.test" }).catch((error: unknown) => error)
    expect(String(failure)).toContain("InsecureEndpoint")
  })

  test("takes http://localhost, which is where wrangler dev runs", async () => {
    const settings = await resolveWith({ flag: "http://localhost:8787" })
    expect(settings.endpoint.value).toBe("http://localhost:8787")
  })

  test("fails on a config file that is not valid JSON", async () => {
    const failure = await resolveWith({ file: "{ nope" }).catch((error: unknown) => error)
    expect(String(failure)).toContain("BadConfigFile")
  })
})

// #115: a key is only good against the deployment that minted it, and the file
// is the only place that can remember which one that was.
describe("where the key in the file was minted", () => {
  const mintedAt = async (contents: Record<string, string>) =>
    Option.getOrUndefined((await resolveWith({ file: JSON.stringify(contents) })).mintedAt)

  test("reads the endpoint the file records", async () => {
    expect(await mintedAt({ token: "hb_k", mintedAt: "https://api.example.dev" })).toBe(
      "https://api.example.dev"
    )
  })

  // The marker, so the hosted deployment stays free to move without stranding
  // every key ever minted against the address it used to have.
  test("resolves the default marker to wherever the default points now", async () => {
    expect(await mintedAt({ token: "hb_k", mintedAt: "default" })).toBe(DEFAULT_ENDPOINT)
  })

  // Every user who logged in before the field existed. Their key was minted at
  // the endpoint the file names, and at the default when it names none — which
  // is what the two shapes that existed before this field actually meant.
  test("falls back to the file's own endpoint, and then to the default", async () => {
    expect(await mintedAt({ token: "hb_k", endpoint: "https://api.example.dev" })).toBe(
      "https://api.example.dev"
    )
    expect(await mintedAt({ token: "hb_k" })).toBe(DEFAULT_ENDPOINT)
  })

  // An operator's own PUBLISH_TOKEN was never issued to anyone, so there is no
  // deployment to pin it to: `sendable` is the only rule that applies to it.
  test("has nothing to say about a token no deployment minted", async () => {
    expect(await mintedAt({ token: "publish-me", endpoint: "https://api.example.dev" })).toBe(
      undefined
    )
  })
})

describe("the config file", () => {
  // A read that fails for any reason other than "it is not there" has to be
  // reported, not swallowed into "no config": a directory in place of the file
  // stands in for the permission denied a test cannot portably provoke.
  test("fails on one it cannot read", async () => {
    const home = configHome()
    mkdirSync(join(home, "handbill", "config.json"), { recursive: true })
    const failure = await resolveIn(home).catch((error: unknown) => error)
    expect(String(failure)).toContain("BadConfigFile")
  })
})

describe("credentials", () => {
  test("fails on the one thing that can be missing", async () => {
    const settings = await resolveWith({ env: { HANDBILL_ENDPOINT: "https://env.example.dev" } })
    const failure = await Effect.runPromise(Effect.flip(credentials(settings)))
    expect(failure).toBeInstanceOf(MissingToken)
  })
})

describe("save", () => {
  /** Saves into a config home and hands back the file it wrote to. */
  const saveIn = (home: string, changes: { readonly token?: string | undefined }) =>
    Effect.runPromise(
      resolve({ endpoint: Option.none() }).pipe(
        Effect.flatMap((settings) => Effect.as(save(settings, changes), settings.path)),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ XDG_CONFIG_HOME: home }))
        ),
        Effect.provide(platform)
      )
    )

  // `login` writes one field into a file it does not own: a field this version
  // of the CLI has never heard of has to survive being written by it.
  test("merges into what is already there, unknown fields included", async () => {
    const home = configHome(JSON.stringify({ endpoint: "https://file.example.dev", editor: "hx" }))
    expect(contentsOf(await saveIn(home, { token: "hb_minted" }))).toEqual({
      endpoint: "https://file.example.dev",
      editor: "hx",
      token: "hb_minted"
    })
  })

  // What `logout` does: the field goes, the file stays.
  test("removes a field set to undefined, and creates a file that is not there", async () => {
    expect(contentsOf(await saveIn(configHome(), { token: undefined }))).toEqual({})
  })

  // The file holds a key. Both cases: one created here, and one that already
  // existed at the umask the fixture wrote it with (0644).
  test.each([
    ["a file it creates", undefined],
    ["a file that was already there", JSON.stringify({ editor: "hx" })]
  ])("leaves %s readable only by its owner", async (_, existing) => {
    const path = await saveIn(configHome(existing), { token: "hb_minted" })
    // eslint-disable-next-line no-bitwise
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  // The write goes to a sibling and is renamed over the target, so a crash
  // cannot leave a half-written config every later command reports as broken.
  // The directory rather than one guessed name: the sibling is named after the
  // writing process, so asserting on `config.json.pending` would pass even with
  // the rename deleted.
  test("leaves nothing behind next to the file", async () => {
    const path = await saveIn(configHome(), { token: "hb_minted" })
    expect(readdirSync(dirname(path))).toEqual(["config.json"])
  })
})
