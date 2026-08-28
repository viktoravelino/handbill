import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { credentials, resolve } from "../src/config"
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

describe("resolve", () => {
  test("takes the endpoint from the flag before the environment and the file", async () => {
    const settings = await resolveWith({
      flag: "https://flag.example.dev",
      env: { HANDBILL_ENDPOINT: "https://env.example.dev" },
      file
    })
    expect(settings.endpoint).toEqual(
      Option.some({ value: "https://flag.example.dev", source: "flag" })
    )
  })

  test("takes the endpoint from the environment before the file", async () => {
    const settings = await resolveWith({
      env: { HANDBILL_ENDPOINT: "https://env.example.dev" },
      file
    })
    expect(settings.endpoint).toEqual(
      Option.some({ value: "https://env.example.dev", source: "env" })
    )
  })

  test("falls back to the config file for both settings", async () => {
    const settings = await resolveWith({ file })
    expect(settings.endpoint).toEqual(
      Option.some({ value: "https://file.example.dev", source: "file" })
    )
    expect(Option.map(settings.token, (token) => Redacted.value(token.value))).toEqual(
      Option.some("file-token")
    )
  })

  test("takes the token from the environment before the file", async () => {
    const settings = await resolveWith({ env: { HANDBILL_TOKEN: "env-token" }, file })
    expect(Option.map(settings.token, (token) => token.source)).toEqual(Option.some("env"))
  })

  test("finds nothing when there is no file and no environment", async () => {
    const settings = await resolveWith({})
    expect(settings.endpoint).toEqual(Option.none())
    expect(settings.token).toEqual(Option.none())
    expect(settings.path).toEndWith("/handbill/config.json")
  })

  test("fails on a config file that is not valid JSON", async () => {
    const failure = await resolveWith({ file: "{ nope" }).catch((error: unknown) => error)
    expect(String(failure)).toContain("BadConfigFile")
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
  test("names the setting that is missing", async () => {
    const settings = await resolveWith({ env: { HANDBILL_ENDPOINT: "https://env.example.dev" } })
    const failure = await Effect.runPromise(Effect.flip(credentials(settings)))
    expect(failure.setting).toBe("token")
  })
})
