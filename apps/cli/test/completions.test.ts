import { afterAll, expect, test } from "bun:test"
import { handbill } from "../src/commands"
import { descriptor } from "../src/completions"
import { run } from "./harness"
import { makeServer } from "./server"

// `--help` never reaches the transport, but the harness wants one.
const server = makeServer()
afterAll(() => server.dispose())

/**
 * The flags `<command> --help` lists for the command itself. The GLOBAL FLAGS
 * section under it belongs to the framework, not to the descriptor.
 */
const helpFlags = async (path: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const { stdout } = await run([...path, "--help"], { http: server.layer })
  const help = stdout.join("\n")
  const start = help.indexOf("\nFLAGS\n")
  if (start === -1) return []
  const section = help.slice(start).split("\nGLOBAL FLAGS\n")[0] ?? ""
  return [...section.matchAll(/^\s+--([a-z-]+)/gmu)].map(([, name]) => name ?? "")
}

// The completion descriptor is written by hand because the framework keeps its
// own command-to-descriptor conversion internal. This is what catches a new
// subcommand that never reaches the generated script.
test("the completion descriptor lists the same subcommands as the command tree", () => {
  expect(descriptor.subcommands.map((command) => command.name)).toEqual(
    handbill.subcommands.flatMap((group) => group.commands.map((command) => command.name))
  )
  expect(descriptor.name).toBe(handbill.name)
})

// Flags drift the same way subcommands do, and a flag the descriptor omits is a
// flag the shell will not complete.
test.each([
  [[] as ReadonlyArray<string>, descriptor],
  ...descriptor.subcommands.map((command) => [[command.name], command] as const)
])("the completion descriptor lists the real flags of %p", async (path, command) => {
  expect(command.flags.map((flag) => flag.name).toSorted()).toEqual(
    [...(await helpFlags(path))].toSorted()
  )
})
