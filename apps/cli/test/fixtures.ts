import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach } from "bun:test"
import { hashDocument } from "../src/hash"
import { render } from "../src/markdown"
import { configHome, run, type RunOptions } from "./harness"
import { makeServer, type ServerOptions, TOKEN, ZONE } from "./server"

/**
 * What every round-trip test file starts from: the documents on disk, and a
 * `session` that owns one in-process server per test. The command tests live one
 * file per command — `pages`, `aliases`, `update`, `doctor`, `completions` — with
 * the output flags that cut across them in `flags.test.ts`.
 */

const files = mkdtempSync(join(tmpdir(), "handbill-docs-"))

/** A document on disk, with the hash and URL the CLI should end up printing for it. */
const document = (name: string, html: string) => {
  const path = join(files, name)
  writeFileSync(path, html)
  // The bytes, not the string: `hash` and the stored `size` are both about what
  // goes over the wire, which is not the number of UTF-16 code units.
  const bytes = new TextEncoder().encode(html)
  const hash = hashDocument(bytes)
  return { path, html, bytes, hash, url: `https://${hash}.${ZONE}` }
}

/** A markdown source on disk, with the page the CLI is expected to render from it. */
const markdown = (name: string, source: string) => {
  const path = join(files, name)
  writeFileSync(path, source)
  const bytes = new TextEncoder().encode(render(source, path))
  const hash = hashDocument(bytes)
  return { path, source, bytes, hash, url: `https://${hash}.${ZONE}` }
}

export const plan = document("plan.html", "<!doctype html><title>Quarter plan</title><p>Hello.</p>")
export const kickoff = document("kickoff.html", "<!doctype html><title>Kickoff</title>")
export const retro = document("retro.html", "<!doctype html><title>Retro</title>")
export const notes = markdown("notes.md", "# Weekly notes\n\nShipped the CLI.\n")

/**
 * A fresh server for each test in the calling file, and the CLI as a configured
 * user runs it, talking to that server. Called at the top of a test file so the
 * hooks belong to that file's suite; `server()` is the current one, because
 * every test gets a new store and a new clock. `options` is the deployment that
 * file is about — accounts, aliases, an admin token — and is the same for all of
 * its tests, since it is what the server is rebuilt from.
 */
export const session = (deployment: ServerOptions = {}) => {
  let server = makeServer(deployment)
  afterAll(() => server.dispose())

  beforeEach(() => {
    server.dispose()
    server = makeServer(deployment)
  })

  const cli = (
    args: ReadonlyArray<string>,
    options: Omit<RunOptions, "http" | "env"> & {
      readonly env?: Record<string, string | undefined>
      /** Defaults to the in-process server; override to test an endpoint that is down. */
      readonly http?: RunOptions["http"]
    } = {}
  ) =>
    run(args, {
      ...options,
      http: options.http ?? server.layer,
      env: {
        XDG_CONFIG_HOME: configHome(),
        HANDBILL_ENDPOINT: `https://api.${ZONE}`,
        HANDBILL_TOKEN: TOKEN,
        ...options.env
      }
    })

  return { cli, server: () => server }
}
