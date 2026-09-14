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

/**
 * Every URL `--open` passes here came off the wire, so it is parsed before it is
 * spawned: `https:` or nothing. The contract's `HttpsUrl` says the same thing at
 * the other end, and this is the check that does not depend on the endpoint
 * having been the one the contract describes.
 */
export const isOpenable = (url: string): boolean =>
  URL.canParse(url) && new URL(url).protocol === "https:"

/**
 * The platform's "open this URL" command, and what goes between it and the URL.
 * Windows never goes through `cmd /c start`: it has no `execve`, so the argument
 * array is re-serialised into one command line that `cmd.exe` then re-parses,
 * where `&` in a URL starts a second command. `rundll32` takes the URL as an
 * argument and hands it to the shell's protocol handler, with no parsing step in
 * between. Exported so a test can read the command line without spawning one.
 */
export const opener = (
  platform: NodeJS.Platform,
  url: string
): readonly [command: string, args: ReadonlyArray<string>] => {
  switch (platform) {
    case "darwin":
      return ["open", [url]]
    case "win32":
      return ["rundll32", ["url.dll,FileProtocolHandler", url]]
    default:
      return ["xdg-open", [url]]
  }
}

/**
 * Hands the URL to the platform's opener and lets go: detached and unreferenced,
 * so the CLI exits when it has printed rather than when the browser does. Only a
 * URL that is not `https:` and failing to start the opener are errors; what the
 * browser makes of the URL is its own business.
 */
export const BrowserLive = Layer.succeed(Browser, {
  open: (url) =>
    Effect.callback<void, CannotOpen>((resume) => {
      if (!isOpenable(url)) {
        return resume(Effect.fail(new CannotOpen({ url, reason: "not an https:// URL" })))
      }
      const [command, args] = opener(process.platform, url)
      const child = spawn(command, [...args], { detached: true, stdio: "ignore" })
      child.once("error", (error) =>
        resume(Effect.fail(new CannotOpen({ url, reason: error.message })))
      )
      child.once("spawn", () => {
        child.unref()
        resume(Effect.void)
      })
    })
})
