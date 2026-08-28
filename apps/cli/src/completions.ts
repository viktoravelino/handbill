import { Argument, Command, Completions } from "effect/unstable/cli"
import { jsonFlag } from "./flags"
import * as Output from "./output"

/** `--json` is on every command; only the ones that reach the API take `--endpoint`. */
const jsonDescriptor: Completions.FlagDescriptor = {
  name: "json",
  aliases: [],
  description: "Print the result as JSON",
  type: { _tag: "Boolean" }
}

const apiFlags: ReadonlyArray<Completions.FlagDescriptor> = [
  {
    name: "endpoint",
    aliases: [],
    description: "Base URL of the deployment",
    type: { _tag: "String" }
  },
  jsonDescriptor
]

/** `--markdown` belongs to the root command alone: it is the only one that renders anything. */
const publishFlags: ReadonlyArray<Completions.FlagDescriptor> = [
  ...apiFlags,
  {
    name: "markdown",
    aliases: [],
    description: "Render the input as markdown",
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
  flags: publishFlags,
  arguments: [
    {
      name: "file",
      description: "HTML or markdown file to publish, or - to read stdin",
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
      flags: [jsonDescriptor],
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
  { shell: Argument.choice("shell", ["bash", "zsh", "fish"]), json: jsonFlag },
  ({ json, shell }) => {
    // The script is text, not data, so `--json` only wraps it — enough for a
    // caller that reads every command the same way.
    const script = Completions.generate("handbill", shell, descriptor)
    return json ? Output.json({ script }) : Output.line(script)
  }
).pipe(Command.withDescription("Print a shell completion script for bash, zsh or fish."))
