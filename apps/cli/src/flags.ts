import { Flag } from "effect/unstable/cli"

/**
 * The flags more than one command takes. They live here rather than in any one
 * command file so every command file — `completions.ts` included — can use them
 * without importing a sibling that imports it back.
 */
export const endpointFlag = Flag.string("endpoint").pipe(
  Flag.withDescription("Base URL of the deployment; beats HANDBILL_ENDPOINT and the config file"),
  Flag.optional
)

export const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print the result as one JSON object on stdout"),
  Flag.withDefault(false)
)

/** On the commands whose result is a page worth looking at: publish, update and alias. */
export const openFlag = Flag.boolean("open").pipe(
  Flag.withDescription("Open the printed URL in the default browser"),
  Flag.withDefault(false)
)

/** On publish and alias, the commands whose result is a URL worth handing across a table. */
export const qrFlag = Flag.boolean("qr").pipe(
  Flag.withDescription(
    "Also print a scannable QR code for the URL to stderr; skipped when stderr is not a terminal"
  ),
  Flag.withDefault(false)
)

/** On the two commands that take a document: publish and update. */
export const markdownFlag = Flag.boolean("markdown").pipe(
  Flag.withDescription("Render the input as markdown, whatever it is named — needed for stdin"),
  Flag.withDefault(false)
)
