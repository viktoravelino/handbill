import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Browser, BrowserLive, CannotOpen, isOpenable, opener } from "../src/browser"

/**
 * #160: `--open` hands a *server-supplied* string to the platform. The command
 * line it builds is asserted rather than spawned — nothing here starts a browser.
 */

const HOSTILE = "https://h.test/&calc and more"

// Windows has no `execve`: an argument array becomes one command line, and
// `cmd.exe` would read the `&` as a command separator. `rundll32` is handed the
// URL as an argument and never re-parses it, so the whole string stays one
// argument — `&`, the space, and all.
test("the Windows opener never goes through cmd.exe", () => {
  const [command, args] = opener("win32", HOSTILE)
  expect(command).toBe("rundll32")
  expect(args).toEqual(["url.dll,FileProtocolHandler", HOSTILE])
  expect(command).not.toContain("cmd")
  expect(args.join(" ")).not.toContain("/c")
})

test("the other platforms hand the URL over as one argument", () => {
  expect(opener("darwin", HOSTILE)).toEqual(["open", [HOSTILE]])
  expect(opener("linux", HOSTILE)).toEqual(["xdg-open", [HOSTILE]])
})

// The URL is parsed, not prefix-matched: anything that is not an https URL is
// refused before a process exists to be confused by it.
test("only an https URL is openable", () => {
  expect(isOpenable("https://h.test/&calc")).toBe(true)
  expect(isOpenable("http://h.test/")).toBe(false)
  expect(isOpenable("file:///etc/passwd")).toBe(false)
  expect(isOpenable("javascript:alert(1)")).toBe(false)
  expect(isOpenable("not a url at all")).toBe(false)
  expect(isOpenable("")).toBe(false)
})

test("opening a non-https URL fails without spawning anything", async () => {
  const failure = await Effect.runPromise(
    Effect.flip(
      Effect.provide(
        Effect.flatMap(Browser, (browser) => browser.open("file:///etc/passwd")),
        BrowserLive
      )
    )
  )
  expect(failure).toBeInstanceOf(CannotOpen)
  expect(failure.reason).toBe("not an https:// URL")
})
