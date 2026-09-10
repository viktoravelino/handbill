import { Owner } from "@handbill/contract"
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

/**
 * `handbill admin tier <owner> <free|paid>`: the manual override for a billing
 * webhook that never landed, and the support tool. It writes the same field the
 * webhook writes, absolutely rather than incrementally — the tier named is the
 * tier the account ends on — so it is idempotent, and an owner who has not
 * minted a key yet is a success that wrote nothing.
 */
const tier = Command.make(
  "tier",
  {
    owner: Argument.string("owner").pipe(
      Argument.withDescription("The account as the deployment names it: `gh:<numeric id>`")
    ),
    tier: Argument.choice("tier", ["free", "paid"]).pipe(
      Argument.withDescription("The tier that account is on from now on")
    ),
    endpoint: endpointFlag,
    json: jsonFlag
  },
  handler(({ endpoint, json, owner, tier: moveTo }) =>
    Effect.gen(function* () {
      const settings = yield* Settings.resolve({ endpoint })
      const configured = settings.endpoint.value
      const token = yield* required(
        yield* adminToken,
        () => new Output.MissingAdminToken({ endpoint: configured })
      )
      yield* Settings.sendable(settings, token)
      const client = yield* Client.selfAuthorizing({ endpoint: configured, token })
      yield* client.admin
        .tier({ params: { owner: Owner.make(owner) }, payload: { tier: moveTo } })
        // As with takedown, neither answer is about the account: 404 is a
        // deployment with no operator surface or no accounts at all, 401 a
        // token it does not accept.
        .pipe(
          Effect.catchTags({
            NotFound: () => Effect.fail(new Output.TierRefused({ endpoint: configured })),
            Unauthorized: () =>
              Effect.fail(new Output.TierRefused({ endpoint: configured, rejected: true }))
          })
        )
      yield* json ? Output.json({ owner, tier: moveTo }) : Output.line(`${owner} ${moveTo}`)
    })
  )
).pipe(
  Command.withDescription(
    "Set what an account may spend: `paid` for the hosted paid tier, `free` for everyone else. Needs the deployment's ADMIN_TOKEN in HANDBILL_ADMIN_TOKEN. Idempotent."
  ),
  Command.withExamples([
    {
      command: "handbill admin tier gh:4242 paid",
      description: "Every live key that account holds moves to the paid quotas"
    },
    { command: "handbill admin tier gh:4242 free", description: "And back, when it lapses" }
  ])
)

/** `admin` on its own is a heading: the operator subcommands hang off it. */
export const admin = Command.make("admin").pipe(
  Command.withDescription("Operator commands for whoever runs the deployment."),
  Command.withSubcommands([takedown, tier])
)
