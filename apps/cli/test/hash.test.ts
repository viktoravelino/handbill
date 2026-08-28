import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { hashDocument } from "../src/hash"

const encode = (text: string) => new TextEncoder().encode(text)

describe("hashDocument", () => {
  test("is the first 12 hex characters of the sha256 of the bytes", () => {
    const document = "<!doctype html><title>Plan</title>"
    expect(String(hashDocument(encode(document)))).toBe(
      createHash("sha256").update(document).digest("hex").slice(0, 12)
    )
  })

  test("is 12 lowercase hex characters", () => {
    expect(hashDocument(encode("anything"))).toMatch(/^[0-9a-f]{12}$/u)
  })

  // S1.1: the same bytes always name the same URL, and one changed byte does not.
  test("is stable for the same bytes and different for others", () => {
    expect(hashDocument(encode("<p>a</p>"))).toBe(hashDocument(encode("<p>a</p>")))
    expect(hashDocument(encode("<p>a</p>"))).not.toBe(hashDocument(encode("<p>b</p>")))
  })
})
