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

// A title that fits R2's ~2 KiB customMetadata but not KV's 1024-byte metadata
// would let publish's R2 write land and the hosted index write reject — a 500
// and a served-but-unlisted page. The title is clamped so both writes fit.
test("extractTitle clamps an oversized title to the metadata budget on a char boundary", () => {
  const long = "x".repeat(1000)
  const title = extractTitle(bytes(`<title>${long}</title>`))
  expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(256)
  expect(title).toBe("x".repeat(256))

  // Multi-byte characters are never split: an emoji is 4 UTF-8 bytes, so the
  // clamp stops before the one that would cross 256, leaving valid UTF-8.
  const emoji = extractTitle(bytes(`<title>${"😀".repeat(100)}</title>`))
  const encoded = new TextEncoder().encode(emoji).length
  expect(encoded).toBeLessThanOrEqual(256)
  expect(encoded % 4).toBe(0)
})
