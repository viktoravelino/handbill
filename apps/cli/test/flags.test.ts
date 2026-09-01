import { describe, expect, test } from "bun:test"
import { render as renderQr } from "../src/qr"
import { plan, session } from "./fixtures"
import { ZONE } from "./server"

/**
 * The two flags that belong to no single command — `--qr` and `--open`, the
 * `qrIf` and `openIf` of `src/command-kit.ts` — exercised through publish and
 * alias, the commands that take them. Both act on a URL that is already on
 * stdout, so what they must not do is change it.
 */

const { cli } = session()
const { hash, url } = plan

describe("--qr", () => {
  // #92: the code is a second copy of the URL on stderr, never part of the
  // result — stdout must be byte-identical to a run without the flag.
  test("draws the printed URL's code on stderr and leaves stdout identical", async () => {
    const plain = await cli([plan.path])
    const outcome = await cli([plan.path, "--qr"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toEqual(plain.stdout)
    expect(outcome.stderr).toEqual([renderQr(url)])
  })

  // #92: the URL on stdout is the product. stderr that is not a terminal gets
  // no code, and a --json consumer reads the same object either way.
  test("is silent into a pipe and invisible to --json", async () => {
    const piped = await cli([plan.path, "--qr"], { tty: false })
    expect(piped.stdout).toEqual([url])
    expect(piped.stderr).toEqual([])
    const asJson = await cli([plan.path, "--json", "--qr"])
    expect(asJson.stdout.length).toBe(1)
    expect(JSON.parse(asJson.stdout[0] ?? "")).toMatchObject({ hash, url })
  })
})

describe("--open", () => {
  // S2.4: the browser is a second reader of the URL; stdout is still one line.
  test("opens the printed URL, after printing it", async () => {
    const published = await cli([plan.path, "--open"])
    expect(published.stdout).toEqual([url])
    expect(published.opened).toEqual([url])

    const aliased = await cli(["alias", "plan", hash, "--open", "--json"])
    expect(aliased.stdout).toHaveLength(1)
    expect(aliased.opened).toEqual([`https://plan.${ZONE}`])
  })

  test("opens nothing when the command fails", async () => {
    const outcome = await cli([plan.path, "--open"], { env: { HANDBILL_TOKEN: "wrong" } })
    expect(outcome.ok).toBe(false)
    expect(outcome.opened).toEqual([])
  })
})
