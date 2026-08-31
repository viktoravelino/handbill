import { DateTime, Effect, Option, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { type Alias, AliasName, Hash, PageList } from "@handbill/contract"
import { Browser } from "./browser"
import * as Client from "./client"
import { completions } from "./completions"
import * as Config from "./config"
import * as Doctor from "./doctor"
import * as Document from "./document"
import { endpointFlag, jsonFlag, markdownFlag, openFlag } from "./flags"
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

/**
 * Points every alias that currently names `from` at `to`, and returns the names
 * it moved. A deployment with aliases switched off answers 404 on the listing:
 * there is nothing to re-point, so `update` says so once on stderr and finishes
 * the rotation anyway.
 */
const repoint = Effect.fn(function* (client: Client.Client, from: Hash, to: Hash) {
  const naming = yield* client.aliases.list({}).pipe(
    Effect.map(({ aliases }) => aliases.filter((alias) => alias.hash === from)),
    Effect.catchTag("NotFound", (failure) =>
      Effect.andThen(
        Output.note(Output.describe(failure).message),
        Effect.succeed<ReadonlyArray<Alias>>([])
      )
    )
  )
  yield* Effect.forEach(naming, (alias) =>
    Effect.andThen(
      client.aliases.set({ params: { name: alias.name }, payload: { hash: to } }),
      Output.note(`Re-pointed ${alias.name} at ${to}.`)
    )
  )
  return naming.map((alias) => alias.name)
})

/**
 * `update <target> <file>`: the revision rotation in one command. The order is
 * the point — publish, then re-point, then remove — so a reader following an
 * alias never meets the gap where the new page is not up yet or the old one is
 * already gone.
 */
const update = Command.make(
  "update",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("The URL of the page being replaced, or its 12-character hash")
    ),
    file: Argument.string("file").pipe(
      Argument.withDescription("HTML or markdown file to publish in its place, or - to read stdin")
    ),
    endpoint: endpointFlag,
    json: jsonFlag,
    markdown: markdownFlag,
    open: openFlag
  },
  handler(({ endpoint, file, json, markdown, open, target }) =>
    Effect.gen(function* () {
      const old = yield* required(targetHash(target), () => new Output.BadTarget({ target }))
      const client = yield* connect(endpoint)
      const document = yield* Document.load({ file, markdown })
      const published = yield* client.pages.publish({
        params: { hash: document.hash },
        payload: document.bytes
      })
      // Same bytes, same hash: the aliases already point at the page, and
      // removing the old hash would unpublish what was just uploaded.
      const rotated = document.hash !== old
      const aliases = rotated ? yield* repoint(client, old, document.hash) : []
      if (rotated) {
        yield* client.pages.remove({ params: { hash: old } })
        yield* Output.note(`Removed ${old}.`)
      }
      yield* json
        ? Output.json({ ...published, removed: rotated, aliases })
        : Output.line(published.url)
      yield* openIf(open, published.url)
    })
  )
).pipe(
  Command.withDescription(
    "Replace a published page: publish the new file, re-point every alias that named the old one, and unpublish it. Same bytes, same hash: nothing happens."
  ),
  Command.withExamples([
    {
      command: "handbill update https://a3f9c1d4e2b8.example.dev plan.html",
      description: "Publish the revision, move the names, drop the old page"
    },
    {
      command: "handbill update a3f9c1d4e2b8 notes.md --json",
      description: "The same by hash: { hash, url, created, removed, aliases }"
    }
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
  Command.withSubcommands([update, list, remove, alias, doctor, completions])
)
