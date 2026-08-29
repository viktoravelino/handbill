import { expect, test } from "bun:test"
import { AliasName, Hash } from "@handbill/contract"
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
  ["plan.example.dev", "alias"],
  ["PLAN.example.dev", "alias"],
  ["plan-v2.example.dev", "alias"],
  ["www.example.dev", "alias"],
  // Not 12 hex, so not a hash — a readable name to look up instead.
  ["a3f9c1d4e2b.example.dev", "alias"],
  ["a3f9c1d4e2b8c.example.dev", "alias"],
  ["a3f9c1d4e2bg.example.dev", "alias"],
  // Not a hostname label at all: hyphen at an end, too long, empty.
  ["-plan.example.dev", "unknown"],
  [`${"p".repeat(64)}.example.dev`, "unknown"],
  ["example.dev", "unknown"],
  [".example.dev", "unknown"],
  // A label has to be the whole subdomain, for a hash and for a name.
  ["x.a3f9c1d4e2b8.example.dev", "unknown"],
  ["x.plan.example.dev", "unknown"],
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

test("an alias host carries the name, lowercased", () => {
  expect(classifyHost("Plan.example.dev", ZONE)).toEqual({
    kind: "alias",
    name: AliasName.make("plan")
  })
})
