import { expect, test } from "bun:test"
import { Hash } from "@handbill/contract"
import { classifyHost } from "./pages"

const ZONE = "example.dev"

const table = [
  ["api.example.dev", "api"],
  ["API.Example.dev", "api"],
  ["a3f9c1d4e2b8.example.dev", "page"],
  ["a3f9c1d4e2b8.example.dev:8787", "page"],
  ["A3F9C1D4E2B8.example.dev", "page"],
  // Fully qualified, trailing dot and all.
  ["api.example.dev.", "api"],
  ["a3f9c1d4e2b8.example.dev.", "page"],
  ["example.dev", "unknown"],
  ["www.example.dev", "unknown"],
  // Not 12 hex: too short, too long, out of alphabet.
  ["a3f9c1d4e2b.example.dev", "unknown"],
  ["a3f9c1d4e2b8c.example.dev", "unknown"],
  ["a3f9c1d4e2bg.example.dev", "unknown"],
  // A hash label has to be the whole subdomain.
  ["x.a3f9c1d4e2b8.example.dev", "unknown"],
  // Another zone that merely ends the same way.
  ["a3f9c1d4e2b8.notexample.dev", "unknown"],
  ["api.example.dev.evil.test", "unknown"]
] as const

test.each(table)("classifyHost(%s) is %s", (hostname, expected) => {
  expect(classifyHost(hostname, ZONE).kind).toBe(expected)
})

test("a zone configured as a fully qualified name still matches", () => {
  expect(classifyHost("api.example.dev", "Example.dev.").kind).toBe("api")
  expect(classifyHost("a3f9c1d4e2b8.example.dev", "example.dev.").kind).toBe("page")
})

test("a page host carries the hash", () => {
  expect(classifyHost("a3f9c1d4e2b8.example.dev", ZONE)).toEqual({
    kind: "page",
    hash: Hash.make("a3f9c1d4e2b8")
  })
})
