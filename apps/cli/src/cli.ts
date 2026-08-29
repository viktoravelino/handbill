import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import pkg from "../package.json" with { type: "json" }
import { BrowserLive } from "./browser"
import { handbill } from "./commands"

/** `bun build` inlines the JSON, so `--version` is whatever package.json said at build time. */
const version = pkg.version

/**
 * The published entry point. `fetch` is the transport because Node 22 has it
 * built in, which keeps the bundle to one runtime dependency; the browser is
 * whatever the platform opens URLs with.
 */
const program = Command.run(handbill, { version }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, BrowserLive))
)

// Commands write their own failures to stderr, so the runtime only has to set
// the exit code.
NodeRuntime.runMain(program)
