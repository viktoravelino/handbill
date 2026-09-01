import { Config, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import * as Client from "./client"
import { handler, required, targetHash } from "./command-kit"
import * as Settings from "./config"
import { endpointFlag, jsonFlag } from "./flags"
import * as Output from "./output"

/**
 * The operator's commands. Everything here authenticates with the deployment's
 * `ADMIN_TOKEN` rather than with the key `handbill login` mints — the operator
 * of a hosted deployment is not one of its accounts — so the token comes from
 * `HANDBILL_ADMIN_TOKEN` and never from the config file, which is where an
 * ordinary user's key lives.
 */
const adminToken = Config.option(Config.redacted("HANDBILL_ADMIN_TOKEN")).pipe(Effect.orDie)

/**
 * `handbill admin takedown <hash|url>`: the page stops being served, everywhere,
 * for good. Idempotent — a hash that is not there is not an error — so the drill
 * can be re-run against a report without checking first. Taking a page down does
 * not touch the key that published it; revoking that is a separate act.
 */
const takedown = Command.make(
  "takedown",
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
      const settings = yield* Settings.resolve({ endpoint })
      const configured = settings.endpoint.value
      const token = yield* required(
        yield* adminToken,
        () => new Output.MissingAdminToken({ endpoint: configured })
      )
      // The same rule every other command obeys: an operator secret is not sent
      // to an endpoint nobody named.
      yield* Settings.sendable(settings, token)
      const client = yield* Client.selfAuthorizing({ endpoint: configured, token })
      yield* client.admin.takedown({ params: { hash } }).pipe(
        // The route carries its own two answers, and neither is about the page:
        // 404 is a deployment with no operator surface at all, 401 a token it
        // does not accept. Both would otherwise be reported as something else.
        Effect.catchTags({
          NotFound: () => Effect.fail(new Output.TakedownRefused({ endpoint: configured })),
          Unauthorized: () =>
            Effect.fail(new Output.TakedownRefused({ endpoint: configured, rejected: true }))
        })
      )
      yield* json ? Output.json({ hash, removed: true }) : Output.line(hash)
    })
  )
).pipe(
  Command.withDescription(
    "Take a page down: it stops being served and is removed from its owner's list. Needs the deployment's ADMIN_TOKEN in HANDBILL_ADMIN_TOKEN. Idempotent."
  ),
  Command.withExamples([
    {
      command: "handbill admin takedown https://a3f9c1d4e2b8.handbill.dev",
      description: "The reported URL stops answering within seconds"
    },
    { command: "handbill admin takedown a3f9c1d4e2b8", description: "The same, by hash" }
  ])
)

/** `admin` on its own is a heading: the operator subcommands hang off it. */
export const admin = Command.make("admin").pipe(
  Command.withDescription("Operator commands for whoever runs the deployment."),
  Command.withSubcommands([takedown])
)
