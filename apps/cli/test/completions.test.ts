import { expect, test } from "bun:test"
import { handbill } from "../src/commands"
import { descriptor } from "../src/completions"

// The completion descriptor is written by hand because the framework keeps its
// own command-to-descriptor conversion internal. This is what catches a new
// subcommand that never reaches the generated script.
test("the completion descriptor lists the same subcommands as the command tree", () => {
  expect(descriptor.subcommands.map((command) => command.name)).toEqual(
    handbill.subcommands.flatMap((group) => group.commands.map((command) => command.name))
  )
  expect(descriptor.name).toBe(handbill.name)
})
