import { Flag } from "effect/unstable/cli"

/**
 * The two flags more than one command takes. They live here rather than in
 * `commands.ts` so `completions.ts` can use them without importing the command
 * tree that imports it back.
 */
export const endpointFlag = Flag.string("endpoint").pipe(
  Flag.withDescription("Base URL of the deployment; beats HANDBILL_ENDPOINT and the config file"),
  Flag.optional
)

export const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print the result as one JSON object on stdout"),
  Flag.withDefault(false)
)
