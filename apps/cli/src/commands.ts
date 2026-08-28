import { DateTime, Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { Hash, PageList } from "@handbill/contract"
import * as Client from "./client"
import { completions } from "./completions"
import * as Config from "./config"
import * as Doctor from "./doctor"
import { endpointFlag, jsonFlag } from "./flags"
import { hashDocument } from "./hash"
import * as Output from "./output"

/**
 * Every command reports its own failures, so stdout only ever carries a result
 * and a failing command exits non-zero.
 */
const handler =
  <I extends { readonly json: boolean }, R>(
    body: (input: I) => Effect.Effect<void, Output.Failure, R>
  ) =>
  (input: I) =>
    body(input).pipe(Output.reporting({ json: input.json }))

/** The bytes to publish: a file, or stdin when the argument is `-`. */
const readDocument = Effect.fn(function* (file: string) {
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

/** The configuration and the client that every API-calling command starts from. */
const connect = Effect.fn(function* (endpoint: Option.Option<string>) {
  const settings = yield* Config.resolve({ endpoint })
  return yield* Client.make(yield* Config.credentials(settings))
})

const decodeHash = Schema.decodeUnknownOption(Hash)

/** The hash inside a `remove` target: a bare hash, or the first label of a URL. */
const targetHash = (target: string): Option.Option<Hash> => {
  const bare = decodeHash(target)
  if (Option.isSome(bare)) return bare
  try {
    return decodeHash(new URL(target).hostname.split(".")[0] ?? "")
  } catch {
    return Option.none()
  }
}

/**
 * The default command. `handbill plan.html` prints one URL and nothing else, so
 * an agent's last line is the deliverable.
 */
const publish = Command.make(
  "handbill",
  {
    file: Argument.string("file").pipe(
      Argument.withDescription("Self-contained HTML file to publish, or - to read stdin")
    ),
    endpoint: endpointFlag,
    json: jsonFlag
  },
  handler(({ endpoint, file, json }) =>
    Effect.gen(function* () {
      const client = yield* connect(endpoint)
      const bytes = yield* readDocument(file)
      const result = yield* client.pages.publish({
        params: { hash: hashDocument(bytes) },
        payload: bytes
      })
      yield* json ? Output.json(result) : Output.line(result.url)
    })
  )
).pipe(
  Command.withDescription(
    "Hand someone a page: publish one self-contained HTML file at an unguessable, immutable URL."
  ),
  Command.withExamples([
    { command: "handbill plan.html", description: "Publish a file and print its URL" },
    { command: "pandoc notes.md -s | handbill -", description: "Publish from stdin" },
    { command: "handbill plan.html --json", description: "Print { hash, url, created } instead" }
  ])
)

const list = Command.make(
  "list",
  { endpoint: endpointFlag, json: jsonFlag },
  handler(({ endpoint, json }) =>
    Effect.gen(function* () {
      const client = yield* connect(endpoint)
      const pages = yield* client.pages.list({})
      // `--json` prints the contract's wire shape, so a script sees the same
      // `publishedAt` string the API sent.
      if (json) return yield* Output.json(yield* Schema.encodeEffect(PageList)(pages))
      if (pages.pages.length === 0) return yield* Output.note("No pages published.")
      for (const page of pages.pages) {
        const title = page.title === "" ? "(untitled)" : page.title
        yield* Output.line(`${DateTime.formatIsoDate(page.publishedAt)}  ${page.url}  ${title}`)
      }
    })
  )
).pipe(Command.withDescription("List the pages you have published, newest first."))

const remove = Command.make(
  "remove",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("The URL of a published page, or its 12-character hash")
    ),
    endpoint: endpointFlag,
    json: jsonFlag
  },
  handler(({ endpoint, json, target }) =>
    Effect.gen(function* () {
      const hash = yield* Option.match(targetHash(target), {
        onNone: () => Effect.fail(new Output.BadTarget({ target })),
        onSome: Effect.succeed
      })
      const client = yield* connect(endpoint)
      // The endpoint is idempotent, so unpublishing twice is not an error.
      yield* client.pages.remove({ params: { hash } })
      yield* json ? Output.json({ hash, removed: true }) : Output.line(hash)
    })
  )
).pipe(Command.withDescription("Unpublish a page. Idempotent: removing it twice is not an error."))

const doctor = Command.make(
  "doctor",
  { endpoint: endpointFlag, json: jsonFlag },
  handler(({ endpoint, json }) =>
    Doctor.diagnose(endpoint).pipe(
      // A config file that cannot be parsed is exactly what doctor exists to
      // explain, so it becomes a failed check rather than an aborted command.
      Effect.catchTag("BadConfigFile", (error) =>
        Effect.succeed<ReadonlyArray<Doctor.Check>>([
          { name: "config", status: "FAIL", detail: Output.describe(error).message }
        ])
      ),
      Effect.flatMap((checks) => Doctor.render(checks, json))
    )
  )
).pipe(
  Command.withDescription(
    "Check the configuration, the endpoint, the token and the wildcard certificate."
  )
)

/** The whole CLI: publish by default, everything else as a subcommand. */
export const handbill = publish.pipe(Command.withSubcommands([list, remove, doctor, completions]))
