import { Effect, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { AliasName } from "@handbill/contract"
import { connect, handler, openIf, qrIf, required, targetHash } from "./command-kit"
import { endpointFlag, jsonFlag, openFlag, qrFlag } from "./flags"
import * as Output from "./output"

/**
 * `alias` and its two subcommands: the living names, kept apart from the pages
 * they point at. `update` re-points them and lives in `update.ts`.
 */

const decodeName = Schema.decodeUnknownOption(AliasName)

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
export const alias = Command.make(
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
    open: openFlag,
    qr: qrFlag
  },
  handler(({ endpoint, json, name, open, qr, target }) =>
    Effect.gen(function* () {
      const aliasName = yield* required(decodeName(name), () => new Output.BadName({ name }))
      const hash = yield* required(targetHash(target), () => new Output.BadTarget({ target }))
      const client = yield* connect(endpoint)
      const result = yield* client.aliases.set({ params: { name: aliasName }, payload: { hash } })
      yield* json ? Output.json(result) : Output.line(result.url)
      yield* qrIf(qr, result.url)
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
