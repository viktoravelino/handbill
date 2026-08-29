import { spawn } from "node:child_process"
import { Context, Data, Effect, Layer } from "effect"

/** `--open` was asked for and the browser could not be started. The URL is already on stdout. */
export class CannotOpen extends Data.TaggedError("CannotOpen")<{
  readonly url: string
  readonly reason: string
}> {}

/**
 * Opens a URL in the user's default browser. A service rather than a call so a
 * test can see what `--open` would have opened without a window appearing.
 */
export class Browser extends Context.Service<
  Browser,
  { readonly open: (url: string) => Effect.Effect<void, CannotOpen> }
>()("handbill/Browser") {}

/** The platform's "open this URL" command, and what goes between it and the URL. */
const opener = (): readonly [command: string, args: ReadonlyArray<string>] => {
  switch (process.platform) {
    case "darwin":
      return ["open", []]
    case "win32":
      // `start` is a cmd builtin, and the empty string is the window title it
      // would otherwise take the URL for.
      return ["cmd", ["/c", "start", ""]]
    default:
      return ["xdg-open", []]
  }
}

/**
 * Hands the URL to the platform's opener and lets go: detached and unreferenced,
 * so the CLI exits when it has printed rather than when the browser does. Only
 * failing to start the opener is an error; what the browser makes of the URL is
 * its own business.
 */
export const BrowserLive = Layer.succeed(Browser, {
  open: (url) =>
    Effect.callback<void, CannotOpen>((resume) => {
      const [command, args] = opener()
      const child = spawn(command, [...args, url], { detached: true, stdio: "ignore" })
      child.once("error", (error) =>
        resume(Effect.fail(new CannotOpen({ url, reason: error.message })))
      )
      child.once("spawn", () => {
        child.unref()
        resume(Effect.void)
      })
    })
})
