import { expect, test } from "bun:test"
import type { Env } from "./index"
import { maxBytesFrom } from "./index"
import { DEFAULT_MAX_BYTES } from "./config"

test("MAX_BYTES falls back to the default unless it is a positive whole number", () => {
  const unset: Env["MAX_BYTES"] = undefined
  expect(maxBytesFrom("1048576")).toBe(1048576)
  expect(maxBytesFrom(unset)).toBe(DEFAULT_MAX_BYTES)
  expect(maxBytesFrom("")).toBe(DEFAULT_MAX_BYTES)
  expect(maxBytesFrom("5mb")).toBe(DEFAULT_MAX_BYTES)
  expect(maxBytesFrom("0")).toBe(DEFAULT_MAX_BYTES)
  expect(maxBytesFrom("-1")).toBe(DEFAULT_MAX_BYTES)
})
