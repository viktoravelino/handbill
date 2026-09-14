import { homedir } from "node:os"
import { Config, Data, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect"

/**
 * The `~/.config/handbill/config.json` document. Every field is optional so a
 * half-filled file still parses and `doctor` can say which half is missing.
 *
 * `endpoint` is a preference — where this machine publishes — while `mintedAt`
 * is provenance: the deployment that issued `token`, written by `handbill
 * login` and never used for routing. It carries the literal `"default"` when
 * the key was minted at {@link DEFAULT_ENDPOINT}, so the default stays free to
 * move without stranding a key.
 *
 * A file with a `token` and no `mintedAt` is every user who logged in before
 * this field existed. The rule for them, in {@link resolve}: the key is taken
 * to have been minted at the file's own `endpoint`, or at
 * {@link DEFAULT_ENDPOINT} when the file names none — which is what both
 * shapes that existed before this field actually mean.
 */
const ConfigFile = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  mintedAt: Schema.optional(Schema.String)
})
type ConfigFile = typeof ConfigFile.Type

/**
 * Where `handbill` publishes when nothing says otherwise: the hosted
 * deployment. It is the last candidate in the chain rather than a special case,
 * so a self-hoster who sets `--endpoint`, `HANDBILL_ENDPOINT` or the config
 * file's `endpoint` notices nothing at all.
 */
export const DEFAULT_ENDPOINT = "https://api.handbill.dev"

/**
 * The hosted site — the default endpoint without its `api.` label — which is
 * where the account page lives. `account --web` opens it and refuses for any
 * other endpoint: a self-hosted deployment is an API with no site behind it.
 */
export const DEFAULT_SITE = DEFAULT_ENDPOINT.replace("://api.", "://")

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

/**
 * A token that no deployment minted, and no endpoint to send it to but the
 * built-in default. Raised by {@link sendable} before any request, so an
 * operator's shared secret never reaches a host they did not name.
 */
export class UnnamedEndpoint extends Data.TaggedError("UnnamedEndpoint")<{
  readonly endpoint: string
}> {}

/**
 * The stored key was minted somewhere else. Raised by {@link sendable} before
 * any request: a key is only good against the deployment that issued it, so
 * pointing the CLI at another one is "log in there", never "reuse this key".
 */
export class WrongEndpoint extends Data.TaggedError("WrongEndpoint")<{
  readonly endpoint: string
  readonly mintedAt: string
  readonly path: string
}> {}

/**
 * An endpoint that would carry a credential over plain HTTP. `wrangler dev`
 * serves on loopback and is the only exception, because nothing there leaves
 * the machine.
 */
export class InsecureEndpoint extends Data.TaggedError("InsecureEndpoint")<{
  readonly endpoint: string
}> {}

/**
 * The prefix a handbill deployment puts on every key it mints — the Worker's
 * own, there so a leaked key is greppable. See {@link isMintedKey}.
 */
const KEY_PREFIX = "hb_"

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
  /**
   * The deployment that minted the key in the config file, as an absolute URL —
   * the `"default"` marker already resolved. `None` when the file holds no key
   * a deployment minted: an operator's own token has no issuer to pin it to.
   */
  readonly mintedAt: Option.Option<string>
  /**
   * Every credential this machine holds, winner or not — the environment's and
   * the file's. Only {@link token} is ever sent; this is for the one caller that
   * has to recognise a secret rather than use it, and a document carrying the
   * key that `HANDBILL_TOKEN` happens to be shadowing is just as leaked.
   */
  readonly secrets: ReadonlyArray<Redacted.Redacted<string>>
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
 * The same deployment, however it was spelled: a trailing slash and the case of
 * the host are not a different host. Comparing the strings raw would refuse a
 * key over `https://api.example.dev/` against `https://api.example.dev`.
 */
const normalise = (url: string) => url.trim().replace(/\/+$/u, "").toLowerCase()

/** Whether two spellings name one deployment; what `pinned` and `account --web` both ask. */
export const sameEndpoint = (left: string, right: string): boolean =>
  normalise(left) === normalise(right)

/**
 * Loopback, where `wrangler dev` runs. The only hosts a credential may reach
 * over plain HTTP, because the request never leaves the machine.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1"])

/**
 * Every endpoint the CLI will talk to has to be `https:` — a bearer key is
 * attached to all but two routes, and `--endpoint http://…` would otherwise
 * hand it to anything on the path. Checked in {@link resolve} rather than at the
 * call sites, so `login` — which posts a GitHub access token before any key
 * exists — is covered by the same rule.
 */
const secure = (endpoint: string) => {
  // Not a URL at all is the HTTP client's to report, with the message it has:
  // failing it here would only say the same thing less well.
  if (!URL.canParse(endpoint)) return Effect.void
  const { hostname, protocol } = new URL(endpoint)
  return protocol === "https:" || (protocol === "http:" && LOOPBACK.has(hostname))
    ? Effect.void
    : Effect.fail(new InsecureEndpoint({ endpoint }))
}

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

  const fileToken = fromFile((contents) => contents.token)

  const endpoint = Option.getOrElse(
    pick([
      ["flag", flags.endpoint],
      ["env", env.endpoint],
      ["file", fromFile((contents) => contents.endpoint)]
    ]),
    (): Setting<string> => ({ value: DEFAULT_ENDPOINT, source: "default" })
  )
  yield* secure(endpoint.value)

  return {
    path,
    endpoint,
    token: pick([
      ["env", env.token],
      ["file", Option.map(fileToken, Redacted.make)]
    ]),
    secrets: [
      ...Option.toArray(env.token),
      ...Option.toArray(Option.map(fileToken, Redacted.make))
    ],
    // Provenance belongs to a key a deployment minted and put in the file: an
    // operator's own `PUBLISH_TOKEN` was never issued to anyone, so there is no
    // deployment to pin it to and {@link sendable} is the only rule about it.
    // The `"default"` marker and the pre-`mintedAt` reading both resolve here,
    // so nothing downstream has to know either spelling.
    mintedAt: Option.map(
      Option.filter(fileToken, (token) => token.startsWith(KEY_PREFIX)),
      () => {
        const recorded = fromFile((contents) => contents.mintedAt)
        if (Option.isSome(recorded)) {
          return recorded.value === "default" ? DEFAULT_ENDPOINT : recorded.value
        }
        return Option.getOrElse(
          fromFile((contents) => contents.endpoint),
          () => DEFAULT_ENDPOINT
        )
      }
    )
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
 * of the CLI does not know about survives being written by it.
 *
 * The file holds a credential, so it is written to a sibling created `0600` and
 * renamed over the target. That is one move for two problems: the key is never
 * in a file at the process umask, not even for the length of a write, and a
 * `rename` is atomic, so a crash half way through leaves the old config rather
 * than a truncated one every later command would report as `BadConfigFile`.
 * The new inode carries the mode, so a hand-written `0644` config comes out
 * `0600` too, with no `chmod` to race.
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
  // Named after this process, so two `handbill` commands writing at once cannot
  // publish each other's half-written content through the rename.
  const pending = `${settings.path}.${process.pid}.pending`
  yield* fs.makeDirectory(path.dirname(settings.path), { recursive: true, mode: 0o700 }).pipe(
    Effect.andThen(
      fs.writeFileString(pending, `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`, {
        mode: 0o600
      })
    ),
    Effect.andThen(fs.rename(pending, settings.path)),
    // A rename that never happened leaves the sibling holding the key. It is
    // `0600`, so this is litter rather than disclosure, but litter that holds a
    // credential is worth sweeping up.
    Effect.onError(() => Effect.ignore(fs.remove(pending))),
    Effect.mapError(
      ({ reason: { _tag: cause } }) =>
        new BadConfigFile({
          path: settings.path,
          reason: `the file system reported ${cause} writing it`
        })
    )
  )
})

/**
 * Keys a handbill deployment mints start with `hb_` — the Worker's own prefix,
 * there so a leaked key is greppable. A self-hosted `PUBLISH_TOKEN` is an
 * operator-chosen string, so the prefix is the one thing that tells "a key this
 * CLI was given by a deployment" from "the operator's shared secret" without
 * asking anyone. It is a heuristic — an operator may choose a `PUBLISH_TOKEN`
 * starting with `hb_`, and then it is treated as a key — and the two places it
 * is used both fail safe: {@link Settings} still resolves, and the caller only
 * ever declines to send the token somewhere it was not told to.
 */
export const isMintedKey = (token: Redacted.Redacted<string>): boolean =>
  Redacted.value(token).startsWith(KEY_PREFIX)

/**
 * The one rule about where a credential may go, in the one place that states
 * it: a token no deployment minted is not sent to an endpoint nobody named.
 * That pairing — an operator's `PUBLISH_TOKEN` and a `handbill` that fell back
 * to {@link DEFAULT_ENDPOINT} — is the only case where a secret would reach a
 * host the user did not choose, and it is worth a failure rather than a
 * warning. A minted key takes the default in silence, which is what lets
 * `HANDBILL_TOKEN=hb_… handbill plan.html` work with nothing configured.
 *
 * Every path that puts a token on the wire goes through this: `connect` for the
 * publishing commands, `logout` before it revokes, and `doctor` inverted into a
 * check. It lives here rather than at those three call sites because the first
 * time the rule was written it was written once — and `logout` and `doctor`
 * quietly went on leaking.
 */
export const sendable = (settings: Settings, token: Redacted.Redacted<string>) =>
  settings.endpoint.source === "default" && !isMintedKey(token)
    ? Effect.fail(new UnnamedEndpoint({ endpoint: settings.endpoint.value }))
    : Effect.void

/**
 * The endpoint pin, and the reason `mintedAt` is written at all: the key in the
 * config file goes to the deployment that issued it and nowhere else. A
 * `--endpoint` that names another one means "log in there", never "reuse this
 * key" — the old key would otherwise be disclosed to a host that never minted
 * it, and answer 204 or 404 in a way that says nothing.
 *
 * A token from `HANDBILL_TOKEN` is the escape hatch: it was handed to this run
 * deliberately, and the file's provenance says nothing about it. So is a machine
 * with no key in the file at all.
 */
export const pinned = (settings: Settings): Effect.Effect<void, WrongEndpoint> => {
  if (Option.isNone(settings.token) || settings.token.value.source !== "file") return Effect.void
  return Option.isSome(settings.mintedAt) &&
    !sameEndpoint(settings.mintedAt.value, settings.endpoint.value)
    ? Effect.fail(
        new WrongEndpoint({
          endpoint: settings.endpoint.value,
          mintedAt: settings.mintedAt.value,
          path: settings.path
        })
      )
    : Effect.void
}

/**
 * Where a command that acts on the key itself — `logout`, and `login` giving
 * back the key it replaces — has to send it: the deployment that minted it, not
 * the one this run resolved. Those two commands are about the key rather than
 * about publishing with it, so they follow it home instead of stopping at
 * {@link pinned}, and `--endpoint` cannot redirect a revocation.
 */
export const mintedEndpoint = (
  settings: Settings,
  source: Source
): Effect.Effect<string, InsecureEndpoint> => {
  const where =
    source === "file"
      ? Option.getOrElse(settings.mintedAt, () => settings.endpoint.value)
      : settings.endpoint.value
  // `resolve` vouches for the endpoint it resolved, not for this one: `mintedAt`
  // is a line in a file a hand can edit, and it is about to receive a live key.
  return Effect.as(secure(where), where)
}
