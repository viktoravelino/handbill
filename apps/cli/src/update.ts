import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { Alias, AliasName, Hash } from "@handbill/contract"
import { decodeName } from "./aliases"
import type * as Client from "./client"
import { clientFor, handler, openIf, required, targetHash } from "./command-kit"
import * as Config from "./config"
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
 * A name the listing does not report at all — set within the last minute — is
 * what discovery alone cannot reach, and `update` would remove the old hash out
 * from under it. `--alias` is the way past that: a name given on the command
 * line is added to the discovered set and read by key like any other, so a name
 * the caller has just created follows the page without waiting for the listing —
 * and one that does not resolve at all fails the command rather than being
 * dropped, because the old page is about to be removed on the strength of it.
 */
const repoint = Effect.fn(function* (
  client: Client.Client,
  from: Hash,
  to: Hash,
  explicit: ReadonlyArray<AliasName>
) {
  const listed = yield* client.aliases.list({}).pipe(
    Effect.map(({ aliases }) => aliases),
    Effect.catchTag("NotFound", (failure) =>
      Effect.andThen(
        Output.note(Output.describe(failure).message),
        Effect.succeed<ReadonlyArray<Alias>>([])
      )
    )
  )
  // The union, deduped: `--alias` augments discovery rather than replacing it,
  // so naming the fresh one does not strand the names the listing does report.
  const names = [...new Set([...listed.map((alias) => alias.name), ...explicit])]
  // One read per name. A *discovered* name that answers 404 was removed between
  // the listing and here, which is not a failure: it is a name that is no longer
  // set. An explicit one is the opposite — the caller said it exists, and acting
  // as if it did not is how the old page gets unpublished under it — so the
  // rotation stops here, before the remove, and says which name.
  const current = yield* Effect.forEach(names, (name) =>
    client.aliases
      .read({ params: { name } })
      .pipe(
        Effect.catchTag("NotFound", () =>
          explicit.includes(name)
            ? Effect.fail(new Output.UnknownAlias({ name }))
            : Effect.succeed(null)
        )
      )
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

/** Names to re-point on top of the ones the listing reports; repeat for several. */
const aliasFlag = Flag.string("alias").pipe(
  Flag.withDescription(
    "Also re-point this name, whether or not the listing reports it yet; repeatable"
  ),
  Flag.atLeast(0)
)

/**
 * `update <target> <file>`: the revision rotation in one command. The order is
 * the point — publish, then re-point, then remove — so a reader following a name
 * never meets the gap where the new page is not up yet or the old one is already
 * gone. A name created in the last minute is the one discovery cannot see:
 * `--alias` names it explicitly. See {@link repoint}.
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
    alias: aliasFlag,
    endpoint: endpointFlag,
    json: jsonFlag,
    markdown: markdownFlag,
    open: openFlag
  },
  handler(({ alias, endpoint, file, json, markdown, open, target }) =>
    Effect.gen(function* () {
      const old = yield* required(targetHash(target), () => new Output.BadTarget({ target }))
      // Every `--alias` decoded before anything is published: a name the
      // contract will not store is a typo, and finding out after the upload
      // would leave the rotation half done.
      const named = yield* Effect.forEach(alias, (name) =>
        required(decodeName(name), () => new Output.BadName({ name }))
      )
      const settings = yield* Config.resolve({ endpoint })
      const client = yield* clientFor(settings)
      const document = yield* Document.load({ file, markdown, settings })
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
        const moved = yield* repoint(client, old, document.hash, named)
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
    },
    {
      command: "handbill update a3f9c1d4e2b8 plan.html --alias plan",
      description: "Move a name too new for the listing to report yet"
    }
  ])
)
