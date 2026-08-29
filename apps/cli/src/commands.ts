import { DateTime, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { AliasName, Hash, PageList } from "@handbill/contract"
import { Browser } from "./browser"
import * as Client from "./client"
import { completions } from "./completions"
import * as Config from "./config"
import * as Doctor from "./doctor"
import * as Document from "./document"
import { endpointFlag, jsonFlag, openFlag } from "./flags"
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

/** Only `publish` renders, so its flag lives with it rather than in `flags.ts`. */
const markdownFlag = Flag.boolean("markdown").pipe(
  Flag.withDescription("Render the input as markdown, whatever it is named — needed for stdin"),
  Flag.withDefault(false)
)

/** The configuration and the client that every API-calling command starts from. */
const connect = Effect.fn(function* (endpoint: Option.Option<string>) {
  const settings = yield* Config.resolve({ endpoint })
  return yield* Client.make(yield* Config.credentials(settings))
})

/** An `Option` a command cannot go on without: its value, or the failure that says why. */
const required = <A, E>(option: Option.Option<A>, failure: () => E): Effect.Effect<A, E> =>
  Option.match(option, { onNone: () => Effect.fail(failure()), onSome: Effect.succeed })

const decodeHash = Schema.decodeUnknownOption(Hash)
const decodeName = Schema.decodeUnknownOption(AliasName)

/** The hash inside a page target: a bare hash, or the first label of a URL. */
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
 * `--open`, once the result is on stdout. The browser is a second reader of the
 * URL, never the first: stdout is still exactly one line.
 */
const openIf = (open: boolean, url: string) =>
  open ? Effect.flatMap(Browser, (browser) => browser.open(url)) : Effect.void

/**
 * The default command. `handbill plan.html` prints one URL and nothing else, so
 * an agent's last line is the deliverable.
 */
const publish = Command.make(
  "handbill",
  {
    file: Argument.string("file").pipe(
      Argument.withDescription("HTML or markdown file to publish, or - to read stdin")
    ),
    endpoint: endpointFlag,
    json: jsonFlag,
    markdown: markdownFlag,
    open: openFlag
  },
  handler(({ endpoint, file, json, markdown, open }) =>
    Effect.gen(function* () {
      const client = yield* connect(endpoint)
      const document = yield* Document.load({ file, markdown })
      const result = yield* client.pages.publish({
        params: { hash: document.hash },
        payload: document.bytes
      })
      yield* json ? Output.json(result) : Output.line(result.url)
      yield* openIf(open, result.url)
    })
  )
).pipe(
  Command.withDescription(
    "Hand someone a page: publish one self-contained HTML file, or a markdown file rendered to one, at an unguessable, immutable URL."
  ),
  Command.withExamples([
    { command: "handbill plan.html", description: "Publish a file and print its URL" },
    { command: "handbill notes.md", description: "Render markdown to a page and publish that" },
    { command: "handbill - --markdown", description: "Publish markdown from stdin" },
    {
      command: "handbill plan.html --open",
      description: "Publish, then open the URL in the browser"
    },
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
      const hash = yield* required(targetHash(target), () => new Output.BadTarget({ target }))
      const client = yield* connect(endpoint)
      // The endpoint is idempotent, so unpublishing twice is not an error.
      yield* client.pages.remove({ params: { hash } })
      yield* json ? Output.json({ hash, removed: true }) : Output.line(hash)
    })
  )
).pipe(Command.withDescription("Unpublish a page. Idempotent: removing it twice is not an error."))

/** `alias remove <name>`: the name stops answering; the page it pointed at stays published. */
const aliasRemove = Command.make(
  "remove",
  {
    name: Argument.string("name").pipe(Argument.withDescription("The alias to remove")),
    endpoint: endpointFlag,
    json: jsonFlag
  },
  handler(({ endpoint, json, name }) =>
    Effect.gen(function* () {
      const aliasName = yield* required(decodeName(name), () => new Output.BadName({ name }))
      const client = yield* connect(endpoint)
      // Idempotent like `remove`: a name that was never set is not an error.
      yield* client.aliases.remove({ params: { name: aliasName } })
      yield* json ? Output.json({ name: aliasName, removed: true }) : Output.line(aliasName)
    })
  )
).pipe(
  Command.withDescription(
    "Remove an alias. Idempotent, and the page it pointed at stays published."
  )
)

/** `alias list`: the column style of `list` — the URL, then what it points at. */
const aliasList = Command.make(
  "list",
  { endpoint: endpointFlag, json: jsonFlag },
  handler(({ endpoint, json }) =>
    Effect.gen(function* () {
      const client = yield* connect(endpoint)
      const { aliases } = yield* client.aliases.list({})
      if (json) return yield* Output.json({ aliases })
      if (aliases.length === 0) return yield* Output.note("No aliases set.")
      for (const alias of aliases) yield* Output.line(`${alias.url}  ${alias.hash}`)
    })
  )
).pipe(Command.withDescription("List your aliases by name: the URL and the hash it points at."))

/**
 * `alias <name> <target>`: a living name for a page. `https://<name>.<zone>`
 * serves whatever the name points at now, while every hash link keeps serving
 * the bytes it always did. `list` and `remove` are subcommands here, so those
 * two words are the one thing a name cannot be.
 */
const alias = Command.make(
  "alias",
  {
    name: Argument.string("name").pipe(
      Argument.withDescription("The name, one DNS label: served at https://<name>.<zone>")
    ),
    target: Argument.string("target").pipe(
      Argument.withDescription("The URL of a published page, or its 12-character hash")
    ),
    endpoint: endpointFlag,
    json: jsonFlag,
    open: openFlag
  },
  handler(({ endpoint, json, name, open, target }) =>
    Effect.gen(function* () {
      const aliasName = yield* required(decodeName(name), () => new Output.BadName({ name }))
      const hash = yield* required(targetHash(target), () => new Output.BadTarget({ target }))
      const client = yield* connect(endpoint)
      const result = yield* client.aliases.set({ params: { name: aliasName }, payload: { hash } })
      yield* json ? Output.json(result) : Output.line(result.url)
      yield* openIf(open, result.url)
    })
  )
).pipe(
  Command.withDescription(
    "Point a name at a page: https://<name>.<zone> serves it until the name is pointed elsewhere. Names are guessable, and the deployment has to switch aliases on."
  ),
  Command.withExamples([
    {
      command: "handbill alias plan https://a3f9c1d4e2b8.example.dev",
      description: "plan.example.dev now serves that page"
    },
    {
      command: "handbill alias plan a3f9c1d4e2b8 --open",
      description: "The same by hash, then open it"
    },
    {
      command: "handbill alias list",
      description: "Every alias: its URL and the hash it points at"
    },
    {
      command: "handbill alias remove plan",
      description: "The name stops answering; the page stays"
    }
  ]),
  Command.withSubcommands([aliasRemove, aliasList])
)

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
export const handbill = publish.pipe(
  Command.withSubcommands([list, remove, alias, doctor, completions])
)
