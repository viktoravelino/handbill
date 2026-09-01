import { Effect, Option, Schema } from "effect"
import { Hash } from "@handbill/contract"
import { Browser } from "./browser"
import * as Client from "./client"
import * as Config from "./config"
import * as Output from "./output"
import { Qr } from "./qr"

/**
 * The pieces every command is built from: reporting, the configured client, and
 * the two side effects that come after a result is on stdout. The command files
 * — `pages.ts`, `aliases.ts`, `update.ts`, `doctor.ts` — hold the commands
 * themselves, and `commands.ts` assembles them into the tree.
 */

/**
 * Every command reports its own failures, so stdout only ever carries a result
 * and a failing command exits non-zero.
 */
export const handler =
  <I extends { readonly json: boolean }, R>(
    body: (input: I) => Effect.Effect<void, Output.Failure, R>
  ) =>
  (input: I) =>
    body(input).pipe(Output.reporting({ json: input.json }))

/** The configuration and the client that every API-calling command starts from. */
export const connect = Effect.fn(function* (endpoint: Option.Option<string>) {
  const settings = yield* Config.resolve({ endpoint })
  return yield* Client.make(yield* Config.credentials(settings))
})

/** An `Option` a command cannot go on without: its value, or the failure that says why. */
export const required = <A, E>(option: Option.Option<A>, failure: () => E): Effect.Effect<A, E> =>
  Option.match(option, { onNone: () => Effect.fail(failure()), onSome: Effect.succeed })

const decodeHash = Schema.decodeUnknownOption(Hash)

/** The hash inside a page target: a bare hash, or the first label of a URL. */
export const targetHash = (target: string): Option.Option<Hash> => {
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
export const openIf = (open: boolean, url: string) =>
  open ? Effect.flatMap(Browser, (browser) => browser.open(url)) : Effect.void

/**
 * `--qr`, once the result is on stdout: the code goes to stderr, so a pipe or a
 * `--json` consumer never sees it, and only when stderr is a terminal at all.
 */
export const qrIf = (qr: boolean, url: string) =>
  qr ? Effect.flatMap(Qr, (service) => service.print(url)) : Effect.void
