import { DateTime, Effect, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { PageList } from "@handbill/contract"
import { connect, handler, openIf, qrIf, required, targetHash } from "./command-kit"
import * as Document from "./document"
import { endpointFlag, jsonFlag, markdownFlag, openFlag, qrFlag } from "./flags"
import * as Output from "./output"

/**
 * The three commands a page's life is made of: publish it, see what is
 * published, take it down. `update` is a rotation of all three and lives in
 * `update.ts`.
 */

/**
 * The default command. `handbill plan.html` prints one URL and nothing else, so
 * an agent's last line is the deliverable.
 */
export const publish = Command.make(
  "handbill",
  {
    file: Argument.string("file").pipe(
      Argument.withDescription("HTML or markdown file to publish, or - to read stdin")
    ),
    endpoint: endpointFlag,
    json: jsonFlag,
    markdown: markdownFlag,
    open: openFlag,
    qr: qrFlag
  },
  handler(({ endpoint, file, json, markdown, open, qr }) =>
    Effect.gen(function* () {
      const client = yield* connect(endpoint)
      const document = yield* Document.load({ file, markdown })
      const result = yield* client.pages.publish({
        params: { hash: document.hash },
        payload: document.bytes
      })
      yield* json ? Output.json(result) : Output.line(result.url)
      yield* qrIf(qr, result.url)
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
    {
      command: "handbill plan.html --qr",
      description: "Publish, and print a scannable code for the URL to stderr"
    },
    { command: "handbill plan.html --json", description: "Print { hash, url, created } instead" }
  ])
)

export const list = Command.make(
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

export const remove = Command.make(
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
