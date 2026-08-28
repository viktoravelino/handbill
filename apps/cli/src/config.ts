import { homedir } from "node:os"
import { Config, Data, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect"

/**
 * The `~/.config/handbill/config.json` document. Both fields are optional so a
 * half-filled file still parses and `doctor` can say which half is missing.
 */
const ConfigFile = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String)
})
type ConfigFile = typeof ConfigFile.Type

/** The config file exists but cannot be used. A missing file is not an error. */
export class BadConfigFile extends Data.TaggedError("BadConfigFile")<{
  readonly path: string
  readonly reason: string
}> {}

/** A setting the command needs was not found in any of the three places. */
export class MissingSetting extends Data.TaggedError("MissingSetting")<{
  readonly setting: "endpoint" | "token"
  readonly path: string
}> {}

/** Where a value came from, in precedence order. */
export type Source = "flag" | "env" | "file"

export interface Setting<A> {
  readonly value: A
  readonly source: Source
}

/**
 * Everything the CLI knows about how to reach a deployment. `doctor` reports
 * the sources and the missing pieces; every other command only wants the values
 * and gets them from {@link credentials}.
 */
export interface Settings {
  /** The config file path, whether or not anything is there. */
  readonly path: string
  readonly file: Option.Option<ConfigFile>
  readonly endpoint: Option.Option<Setting<string>>
  readonly token: Option.Option<Setting<Redacted.Redacted<string>>>
}

/**
 * Environment overrides, read through `Config` rather than `process.env` so a
 * test can supply a `ConfigProvider` instead of mutating the process. A failure
 * here is a broken provider, not something a user can fix.
 */
const environment = Effect.all({
  endpoint: Config.option(Config.string("HANDBILL_ENDPOINT")),
  token: Config.option(Config.redacted("HANDBILL_TOKEN")),
  configHome: Config.option(Config.string("XDG_CONFIG_HOME"))
}).pipe(Effect.orDie)

/** The first candidate that has a value, tagged with where it came from. */
const pick = <A>(
  candidates: ReadonlyArray<readonly [Source, Option.Option<A>]>
): Option.Option<Setting<A>> => {
  for (const [source, candidate] of candidates) {
    if (Option.isSome(candidate)) return Option.some({ value: candidate.value, source })
  }
  return Option.none()
}

/** Reads and decodes the config file. Absent is `None`; corrupt is a failure. */
const readConfigFile = Effect.fn(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const contents = yield* Effect.option(fs.readFileString(path))
  if (Option.isNone(contents)) return Option.none<ConfigFile>()
  const json = yield* Effect.try(() => JSON.parse(contents.value) as unknown).pipe(
    Effect.mapError(() => new BadConfigFile({ path, reason: "it is not valid JSON" }))
  )
  const decoded = yield* Schema.decodeUnknownEffect(ConfigFile)(json).pipe(
    Effect.mapError((error) => new BadConfigFile({ path, reason: error.message }))
  )
  return Option.some(decoded)
})

/**
 * Resolves the configuration: flag beats environment beats config file. The
 * token has no flag — a secret on the command line ends up in the shell history
 * and in `ps` — so it comes from `HANDBILL_TOKEN` or the file.
 */
export const resolve = Effect.fn(function* (flags: { readonly endpoint: Option.Option<string> }) {
  const path = yield* Path.Path
  const env = yield* environment
  const home = Option.getOrElse(env.configHome, () => path.join(homedir(), ".config"))
  const configPath = path.join(home, "handbill", "config.json")
  const file = yield* readConfigFile(configPath)
  const fromFile = (read: (file: ConfigFile) => string | undefined) =>
    Option.flatMap(file, (contents) => Option.fromUndefinedOr(read(contents)))

  return {
    path: configPath,
    file,
    endpoint: pick([
      ["flag", flags.endpoint],
      ["env", env.endpoint],
      ["file", fromFile((contents) => contents.endpoint)]
    ]),
    token: pick([
      ["env", env.token],
      [
        "file",
        Option.map(
          fromFile((contents) => contents.token),
          Redacted.make
        )
      ]
    ])
  } satisfies Settings
})

/** The endpoint and token an API call needs, or a failure naming what is missing. */
export const credentials = Effect.fn(function* (settings: Settings) {
  const endpoint = yield* Option.isSome(settings.endpoint)
    ? Effect.succeed(settings.endpoint.value.value)
    : Effect.fail(new MissingSetting({ setting: "endpoint", path: settings.path }))
  const token = yield* Option.isSome(settings.token)
    ? Effect.succeed(settings.token.value.value)
    : Effect.fail(new MissingSetting({ setting: "token", path: settings.path }))
  return { endpoint, token }
})
