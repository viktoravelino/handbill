import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { handbill } from "./commands"

/** Keep in sync with the `version` field in `package.json`. */
const version = "0.1.1-rc.0"

/**
 * The published entry point. `fetch` is the transport because Node 22 has it
 * built in, which keeps the bundle to one runtime dependency.
 */
const program = Command.run(handbill, { version }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
)

// Commands write their own failures to stderr, so the runtime only has to set
// the exit code.
NodeRuntime.runMain(program)
