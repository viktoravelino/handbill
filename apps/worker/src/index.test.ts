import { expect, test } from "bun:test"
import { productList } from "./billing"
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

// A var that names no product is a deployment with nothing to sell: `index.ts`
// gives it `BillingDisabled`, so the checkout 404s instead of asking Polar to
// create a session with an empty `products` and failing on every retry.
test("POLAR_PRODUCT_ID is a list, and separators alone name nothing", () => {
  const unset: Env["POLAR_PRODUCT_ID"] = undefined
  expect(productList("prod_month , prod_year")).toEqual(["prod_month", "prod_year"])
  expect(productList("prod_month")).toEqual(["prod_month"])
  expect(productList(unset)).toEqual([])
  expect(productList("")).toEqual([])
  expect(productList(",")).toEqual([])
  expect(productList(" ")).toEqual([])
})
