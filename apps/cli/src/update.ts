import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import type { Alias, Hash } from "@handbill/contract"
import type * as Client from "./client"
import { connect, handler, openIf, required, targetHash } from "./command-kit"
import * as Document from "./document"
import { endpointFlag, jsonFlag, markdownFlag, openFlag } from "./flags"
import * as Output from "./output"

/**
 * The one command that spans pages and aliases: publish, re-point, remove. It
 * sits apart from `pages.ts` and `aliases.ts` because the ordering below, not
 * any single call, is what it is for.
 */

/**
 * Points every alias that currently names `from` at `to`, and returns the names
 * it moved. A deployment with aliases switched off answers 404 on the listing:
 * there is nothing to re-point, so `update` says so once on stderr and finishes
 * the rotation anyway. A 404 on a *set* is a different animal — the listing had
 * just answered, so the feature is plainly on — and fails the command by name.
 *
 * The listing is the deployment's KV `list`, and it is used for discovery only:
 * nothing in the contract answers "which names point at this hash", so there is
 * no other way to learn the names. What each of them points at is then read back
 * by key (`GET /v1/aliases/:name`), because the listing is an eventually
 * consistent index of both the names and their hashes — a name it reports
 * against a stale hash would otherwise be left behind and have its page removed
 * under it, or dragged back from a re-point made since.
 *
 * What is left is a name the listing does not report at all, set within the last
 * minute: `update` cannot see it, and still removes the old hash. That residual
 * gap is #95, and the READMEs and the skill say so rather than promise.
 */
const repoint = Effect.fn(function* (client: Client.Client, from: Hash, to: Hash) {
  const listed = yield* client.aliases.list({}).pipe(
    Effect.map(({ aliases }) => aliases),
    Effect.catchTag("NotFound", (failure) =>
      Effect.andThen(
        Output.note(Output.describe(failure).message),
        Effect.succeed<ReadonlyArray<Alias>>([])
      )
    )
  )
  // One read per listed name. A name removed between the listing and here
  // answers 404, which is not a failure: it is a name that is no longer set.
  const current = yield* Effect.forEach(listed, (alias) =>
    client.aliases
      .read({ params: { name: alias.name } })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
  )
  const naming = current.filter((alias): alias is Alias => alias?.hash === from)
  yield* Effect.forEach(naming, (alias) =>
    client.aliases.set({ params: { name: alias.name }, payload: { hash: to } }).pipe(
      // The listing answered a moment ago, so a 404 here is not the
      // aliases-are-off 404 the shared sentence explains. Name what failed.
      Effect.catchTag("NotFound", () =>
        Effect.fail(new Output.CannotRepoint({ name: alias.name }))
      ),
      Effect.andThen(Output.note(`Re-pointed ${alias.name} at ${to}.`))
    )
  )
  return naming.map((alias) => alias.name)
})

/**
 * `update <target> <file>`: the revision rotation in one command. The order is
 * the point — publish, then re-point, then remove — so a reader following a name
 * the listing reports never meets the gap where the new page is not up yet or
 * the old one is already gone. See {@link repoint} for the name it may not
 * report.
 */
export const update = Command.make(
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
      // The page is permanent the moment the publish returns, so nothing below
      // may swallow the URL the user came for: a rotation that fails half way
      // still has to say where the new page is.
      const aliases = yield* Effect.gen(function* () {
        if (!rotated) return []
        const moved = yield* repoint(client, old, document.hash)
        // A 404 here is the old page belonging to another account, not the
        // aliases-are-off 404: `remove` reads it the same way.
        yield* client.pages
          .remove({ params: { hash: old } })
          .pipe(Effect.catchTag("NotFound", () => Effect.fail(new Output.NotYours({ hash: old }))))
        yield* Output.note(`Removed ${old}.`)
        return moved
      }).pipe(Effect.tapError(() => Output.note(`The new page is published at ${published.url}.`)))
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
