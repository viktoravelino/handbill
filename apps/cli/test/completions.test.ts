import { describe, expect, test } from "bun:test"
import type { Command, Completions } from "effect/unstable/cli"
import { handbill } from "../src/commands"
import { descriptor } from "../src/completions"
import { session } from "./fixtures"
import { run } from "./harness"

// `--help` never reaches the transport, but the harness wants one; the
// round-trip below wants a real one.
const { cli, server } = session()

/**
 * The flags `<command> --help` lists for the command itself. The GLOBAL FLAGS
 * section under it belongs to the framework, not to the descriptor.
 */
const helpFlags = async (path: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const { stdout } = await run([...path, "--help"], { http: server().layer })
  const help = stdout.join("\n")
  const start = help.indexOf("\nFLAGS\n")
  if (start === -1) return []
  const section = help.slice(start).split("\nGLOBAL FLAGS\n")[0] ?? ""
  return [...section.matchAll(/^\s+--([a-z-]+)/gmu)].map(([, name]) => name ?? "")
}

/** The names of a command tree, nested the way they are reached. */
interface Tree {
  readonly name: string
  readonly subcommands: ReadonlyArray<Tree>
}

const treeOf = (command: Command.Command.Any): Tree => ({
  name: command.name,
  subcommands: command.subcommands.flatMap((group) => group.commands.map(treeOf))
})

const treeOfDescriptor = (command: Completions.CommandDescriptor): Tree => ({
  name: command.name,
  subcommands: command.subcommands.map(treeOfDescriptor)
})

/** Every command in a descriptor, with the arguments that reach it — the root included. */
const walk = (
  command: Completions.CommandDescriptor,
  path: ReadonlyArray<string> = []
): ReadonlyArray<readonly [ReadonlyArray<string>, Completions.CommandDescriptor]> => [
  [path, command] as const,
  ...command.subcommands.flatMap((sub) => walk(sub, [...path, sub.name]))
]

// The completion descriptor is written by hand because the framework keeps its
// own command-to-descriptor conversion internal. This is what catches a new
// subcommand — at any depth — that never reaches the generated script.
test("the completion descriptor mirrors the command tree", () => {
  expect(treeOfDescriptor(descriptor)).toEqual(treeOf(handbill))
})

// Flags drift the same way subcommands do, and a flag the descriptor omits is a
// flag the shell will not complete.
test.each(walk(descriptor))(
  "the completion descriptor lists the real flags of %p",
  async (path, command) => {
    expect(command.flags.map((flag) => flag.name).toSorted()).toEqual(
      [...(await helpFlags(path))].toSorted()
    )
  }
)

describe("completions", () => {
  test("prints a script for the shell it was asked for", async () => {
    const outcome = await cli(["completions", "zsh"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout.join("\n")).toContain("#compdef handbill")
  })

  // S1.3 asks for `--json` on every command, so this one wraps its script.
  test("wraps the script in an object under --json", async () => {
    const outcome = await cli(["completions", "zsh", "--json"])
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toHaveLength(1)
    expect(JSON.parse(outcome.stdout[0] ?? "").script).toContain("#compdef handbill")
  })
})
