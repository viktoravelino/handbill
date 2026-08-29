import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Console, ConfigProvider, Effect, Exit, Layer, Stdio, Stream } from "effect"
import { CliOutput, Command } from "effect/unstable/cli"
import type { HttpClient } from "effect/unstable/http"
import { handbill } from "../src/commands"

export interface Outcome {
  /** Everything the command wrote to stdout, one entry per line. */
  readonly stdout: ReadonlyArray<string>
  readonly stderr: ReadonlyArray<string>
  /** `false` when the command exited non-zero. */
  readonly ok: boolean
}

export interface RunOptions {
  /** The transport the CLI talks to; always the in-process server in tests. */
  readonly http: Layer.Layer<HttpClient.HttpClient>
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
}

const runCommand = Command.runWith(handbill, { version: "0.1.0-test" })

/**
 * Runs the real command tree with captured output. Everything a command touches
 * — arguments, environment, standard input, HTTP, the help formatter — comes
 * from a layer, so a test never mutates the process and never depends on it:
 * without the formatter the framework colours `--help` whenever stdout is a
 * TTY, and the tests that read help text pass in CI but fail in a terminal.
 */
export const run = async (args: ReadonlyArray<string>, options: RunOptions): Promise<Outcome> => {
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  const capture: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...parts: ReadonlyArray<unknown>) => stdout.push(parts.join(" ")),
    error: (...parts: ReadonlyArray<unknown>) => stderr.push(parts.join(" "))
  })

  const stdio = Stdio.layerTest({
    stdin:
      options.stdin === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(options.stdin))
  })

  const exit = await Effect.runPromiseExit(
    runCommand(args).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(options.http),
      Effect.provide(CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.env ?? {}))),
      // Stdio comes first so the test's standard input wins over the process's.
      Effect.provide(stdio),
      Effect.provide(NodeServices.layer)
    )
  )

  return { stdout, stderr, ok: Exit.isSuccess(exit) }
}

/** A throwaway `XDG_CONFIG_HOME` so config-file tests never touch a real home. */
export const configHome = (contents?: string) => {
  const home = mkdtempSync(join(tmpdir(), "handbill-"))
  if (contents !== undefined) {
    mkdirSync(join(home, "handbill"))
    writeFileSync(join(home, "handbill", "config.json"), contents)
  }
  return home
}
