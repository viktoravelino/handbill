import { expect, test } from "bun:test"
import { Effect } from "effect"
import { extractTitle, hashBytes } from "./hash"

const bytes = (text: string) => new TextEncoder().encode(text)
const hashOf = (text: string): Promise<string> => Effect.runPromise(hashBytes(bytes(text)))

test("hashBytes is the first 12 hex characters of sha256", async () => {
  // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  expect(await hashOf("abc")).toBe("ba7816bf8f01")
  expect(await hashOf("")).toBe("e3b0c44298fc")
})

test("hashBytes changes with the bytes", async () => {
  expect(await hashOf("<h1>a</h1>")).not.toBe(await hashOf("<h1>b</h1>"))
})

test("extractTitle reads the document title, entities and all", () => {
  expect(extractTitle(bytes("<html><head><title>Plan &amp; Review</title></head></html>"))).toBe(
    "Plan & Review"
  )
  expect(extractTitle(bytes('<TITLE lang="en">\n  Two   lines\n</TITLE>'))).toBe("Two lines")
})

test("extractTitle is empty when there is no title", () => {
  expect(extractTitle(bytes("<html><body>no head</body></html>"))).toBe("")
})
