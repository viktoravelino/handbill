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

/**
 * Where `handbill` publishes when nothing says otherwise: the hosted
 * deployment. It is the last candidate in the chain rather than a special case,
 * so a self-hoster who sets `--endpoint`, `HANDBILL_ENDPOINT` or the config
 * file's `endpoint` notices nothing at all.
 */
export const DEFAULT_ENDPOINT = "https://api.handbill.dev"

/** The config file exists but cannot be used. A missing file is not an error. */
export class BadConfigFile extends Data.TaggedError("BadConfigFile")<{
  readonly path: string
  readonly reason: string
}> {}

/**
 * No key or token anywhere. The endpoint has no such failure — there is always
 * {@link DEFAULT_ENDPOINT} — so this is the one thing a command can be missing.
 */
export class MissingToken extends Data.TaggedError("MissingToken")<{
  readonly path: string
}> {}

/** Where a value came from, in precedence order. */
export type Source = "flag" | "env" | "file" | "default"

export interface Setting<A> {
  readonly value: A
  readonly source: Source
}

/**
 * Everything the CLI knows about how to reach a deployment. `doctor` reports
 * the sources and the missing key; every other command only wants the values
 * and gets them from {@link credentials}.
 */
export interface Settings {
  /** The config file path, whether or not anything is there. */
  readonly path: string
  /** Always resolved: the flag, the environment, the file, or the default. */
  readonly endpoint: Setting<string>
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

/**
 * The config file's JSON, whatever is in it. Absent is `None`; unreadable or
 * unparseable is a failure. {@link resolve} decodes the result and {@link save}
 * merges into it, which is why the two are separate: writing must not drop a
 * field this version of the CLI does not know about.
 */
const readJson = Effect.fn(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  // Only a file that is not there means "no config file". Every other read
  // failure — no permission, a directory in the way — is something the user has
  // to fix, and reporting it as a missing key would send them the wrong way.
  const contents = yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (error) => {
      const { _tag: cause } = error.reason
      return cause === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(new BadConfigFile({ path, reason: `the file system reported ${cause}` }))
    })
  )
  if (Option.isNone(contents)) return Option.none<unknown>()
  const json = yield* Effect.try((): unknown => JSON.parse(contents.value)).pipe(
    Effect.mapError(() => new BadConfigFile({ path, reason: "it is not valid JSON" }))
  )
  return Option.some(json)
})

const decodeConfigFile = Schema.decodeUnknownEffect(ConfigFile)

/** The config file path, from `XDG_CONFIG_HOME` or `~/.config`. */
const configPath = Effect.fn(function* (configHome: Option.Option<string>) {
  const path = yield* Path.Path
  const home = Option.getOrElse(configHome, () => path.join(homedir(), ".config"))
  return path.join(home, "handbill", "config.json")
})

/**
 * Resolves the configuration: flag beats environment beats config file beats
 * {@link DEFAULT_ENDPOINT}. The token has no flag — a secret on the command line
 * ends up in the shell history and in `ps` — so it comes from `HANDBILL_TOKEN`,
 * or from the file, where `handbill login` puts the key it mints.
 */
export const resolve = Effect.fn(function* (flags: { readonly endpoint: Option.Option<string> }) {
  const env = yield* environment
  const path = yield* configPath(env.configHome)
  const file = yield* Option.match(yield* readJson(path), {
    onNone: () => Effect.succeed(Option.none<ConfigFile>()),
    onSome: (json) =>
      decodeConfigFile(json).pipe(
        Effect.mapBoth({
          onFailure: (error) => new BadConfigFile({ path, reason: error.message }),
          onSuccess: Option.some
        })
      )
  })
  const fromFile = (read: (file: ConfigFile) => string | undefined) =>
    Option.flatMap(file, (contents) => Option.fromUndefinedOr(read(contents)))

  return {
    path,
    endpoint: Option.getOrElse(
      pick([
        ["flag", flags.endpoint],
        ["env", env.endpoint],
        ["file", fromFile((contents) => contents.endpoint)]
      ]),
      (): Setting<string> => ({ value: DEFAULT_ENDPOINT, source: "default" })
    ),
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

/** The endpoint and token an API call needs, or the failure that says there is no token. */
export const credentials = Effect.fn(function* (settings: Settings) {
  const token = yield* Option.isSome(settings.token)
    ? Effect.succeed(settings.token.value.value)
    : Effect.fail(new MissingToken({ path: settings.path }))
  return { endpoint: settings.endpoint.value, token }
})

/** A JSON object, which is the only shape the config file can have. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Writes the config file with `changes` merged into whatever is already there —
 * an `undefined` value removes the field. What `login` and `logout` use to add
 * and drop the key: the merge is against the raw JSON, so a field this version
 * of the CLI does not know about survives being written by it. The file holds a
 * credential, so it is left readable by this user only — `chmod` after the
 * write rather than a mode on it, because a mode only applies to a file being
 * created and a hand-written config is usually already there.
 */
export const save = Effect.fn(function* (
  settings: Settings,
  changes: { readonly [K in keyof ConfigFile]?: ConfigFile[K] | undefined }
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existing = yield* readJson(settings.path)
  const base = Option.filter(existing, isRecord).pipe(Option.getOrElse(() => ({})))
  const merged = Object.entries({ ...base, ...changes }).filter(([, value]) => value !== undefined)
  yield* fs
    .makeDirectory(path.dirname(settings.path), { recursive: true, mode: 0o700 })
    .pipe(
      Effect.andThen(
        fs.writeFileString(
          settings.path,
          `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`
        )
      ),
      Effect.andThen(fs.chmod(settings.path, 0o600))
    )
    .pipe(
      Effect.mapError(
        ({ reason: { _tag: cause } }) =>
          new BadConfigFile({
            path: settings.path,
            reason: `the file system reported ${cause} writing it`
          })
      )
    )
})
