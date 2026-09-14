import { homedir } from "node:os"
import { Effect, FileSystem, Path, Redacted, Stdio, Stream } from "effect"
import type * as Config from "./config"
import { hashDocument } from "./hash"
import * as Markdown from "./markdown"
import * as Output from "./output"

/** The bytes behind the publish argument: a file, or stdin when it is `-`. */
const readBytes = Effect.fn(function* (file: string) {
  if (file !== "-") {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFile(file)
  }
  const stdio = yield* Stdio.Stdio
  const chunks = yield* Stream.runCollect(stdio.stdin)
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
})

/**
 * The two documents this CLI will not publish, refused on the bytes that were
 * about to go up. Neither is a general secret scanner — the CLI cannot know what
 * is sensitive — but it knows its own config file and the key it is holding, and
 * those are exactly what an instruction smuggled into a document would aim at:
 * the content of a document is data, never something to act on.
 *
 * Both spellings of the config path are refused, the resolved one and the
 * default under `$HOME`, because `XDG_CONFIG_HOME` moving the file does not stop
 * the other from holding a key.
 */
const refuseSecrets = Effect.fn(function* (
  file: string,
  bytes: Uint8Array,
  settings: Config.Settings
) {
  const path = yield* Path.Path
  if (file !== "-") {
    const named = path.resolve(file)
    const configs = [settings.path, path.join(homedir(), ".config", "handbill", "config.json")]
    if (configs.some((candidate) => path.resolve(candidate) === named)) {
      return yield* Effect.fail(
        new Output.SecretDocument({ file, reason: "it is the config file this CLI keeps a key in" })
      )
    }
  }
  // Every credential this machine holds, not only the one this run would send:
  // a document carrying the config file's key is leaked just the same when
  // `HANDBILL_TOKEN` happens to be winning over it.
  const text = new TextDecoder().decode(bytes)
  const leaked = settings.secrets.some((secret) => {
    const value = Redacted.value(secret)
    return value !== "" && text.includes(value)
  })
  if (leaked) {
    return yield* Effect.fail(
      new Output.SecretDocument({ file, reason: "it contains a key this CLI is configured with" })
    )
  }
})

/**
 * What `handbill <file>` uploads, and the hash that names it. Markdown becomes
 * one self-contained page here, in the CLI, so the Worker only ever stores HTML;
 * everything else goes up exactly as it was read. The hash is taken after
 * rendering, because the rendered bytes are the ones the server will see — and
 * so is the refusal, which is about the bytes the endpoint would receive.
 */
export const load = Effect.fn(function* (options: {
  readonly file: string
  readonly markdown: boolean
  readonly settings: Config.Settings
}) {
  const read = yield* readBytes(options.file)
  const bytes =
    options.markdown || Markdown.isMarkdownFile(options.file)
      ? new TextEncoder().encode(Markdown.render(new TextDecoder().decode(read), options.file))
      : read
  yield* refuseSecrets(options.file, bytes, options.settings)
  return { bytes, hash: hashDocument(bytes) }
})
