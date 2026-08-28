import { Argument, Command, Completions } from "effect/unstable/cli"
import * as Output from "./output"

/**
 * `--endpoint` and `--json` are on the default command and on every subcommand
 * that reaches the API, so the descriptor repeats them for each of those.
 */
const apiFlags: ReadonlyArray<Completions.FlagDescriptor> = [
  {
    name: "endpoint",
    aliases: [],
    description: "Base URL of the deployment",
    type: { _tag: "String" }
  },
  {
    name: "json",
    aliases: [],
    description: "Print the result as JSON",
    type: { _tag: "Boolean" }
  }
]

/**
 * The command tree as the completion generator wants it. The framework builds
 * this from the real commands for its own `--completions` flag but keeps the
 * conversion internal, so the subcommand describes the tree by hand;
 * `completions.test.ts` fails if the two ever drift apart.
 */
export const descriptor: Completions.CommandDescriptor = {
  name: "handbill",
  description: "Publish one self-contained HTML file at an unguessable, immutable URL",
  flags: apiFlags,
  arguments: [
    {
      name: "file",
      description: "HTML file to publish, or - to read stdin",
      required: true,
      variadic: false,
      type: { _tag: "Path", pathType: "file" }
    }
  ],
  subcommands: [
    {
      name: "list",
      description: "List published pages, newest first",
      flags: apiFlags,
      arguments: [],
      subcommands: []
    },
    {
      name: "remove",
      description: "Unpublish a page",
      flags: apiFlags,
      arguments: [
        {
          name: "target",
          description: "URL or hash",
          required: true,
          variadic: false,
          type: { _tag: "String" }
        }
      ],
      subcommands: []
    },
    {
      name: "doctor",
      description: "Check the configuration and the endpoint",
      flags: apiFlags,
      arguments: [],
      subcommands: []
    },
    {
      name: "completions",
      description: "Print a shell completion script",
      flags: [],
      arguments: [
        {
          name: "shell",
          description: "bash, zsh or fish",
          required: true,
          variadic: false,
          type: { _tag: "Choice", values: ["bash", "zsh", "fish"] }
        }
      ],
      subcommands: []
    }
  ]
}

export const completions = Command.make(
  "completions",
  { shell: Argument.choice("shell", ["bash", "zsh", "fish"]) },
  ({ shell }) => Output.line(Completions.generate("handbill", shell, descriptor))
).pipe(Command.withDescription("Print a shell completion script for bash, zsh or fish."))
