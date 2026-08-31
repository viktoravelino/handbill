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

/** `--open` is on the commands whose result is a page: publish, update and alias. */
const openDescriptor: Completions.FlagDescriptor = {
  name: "open",
  aliases: [],
  description: "Open the printed URL in the default browser",
  type: { _tag: "Boolean" }
}

/** `--qr` is on publish and `alias`, the two commands that print a shareable URL. */
const qrDescriptor: Completions.FlagDescriptor = {
  name: "qr",
  aliases: [],
  description: "Also print a scannable QR code for the URL to stderr",
  type: { _tag: "Boolean" }
}

/** `--markdown` belongs to the two commands that take a document: the root and `update`. */
const documentFlags: ReadonlyArray<Completions.FlagDescriptor> = [
  ...apiFlags,
  {
    name: "markdown",
    aliases: [],
    description: "Render the input as markdown",
    type: { _tag: "Boolean" }
  },
  openDescriptor
]

/**
 * The command tree as the completion generator wants it. The framework builds
 * this from the real commands for its own `--completions` flag but keeps the
 * conversion internal, so the subcommand describes the tree by hand;
 * `completions.test.ts` fails if the two ever drift apart.
 */
export const descriptor: Completions.CommandDescriptor = {
  name: "handbill",
  description: "Publish one self-contained HTML or markdown file at an unguessable, immutable URL",
  flags: [...documentFlags, qrDescriptor],
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
      name: "update",
      description: "Republish a page, moving its names and dropping the old hash",
      flags: documentFlags,
      arguments: [
        {
          name: "target",
          description: "URL or hash of the page being replaced",
          required: true,
          variadic: false,
          type: { _tag: "String" }
        },
        {
          name: "file",
          description: "HTML or markdown file to publish in its place, or - to read stdin",
          required: true,
          variadic: false,
          type: { _tag: "Path", pathType: "file" }
        }
      ],
      subcommands: []
    },
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
      name: "alias",
      description: "Point a name at a page",
      flags: [...apiFlags, openDescriptor, qrDescriptor],
      arguments: [
        {
          name: "name",
          description: "The name, one DNS label",
          required: true,
          variadic: false,
          type: { _tag: "String" }
        },
        {
          name: "target",
          description: "URL or hash",
          required: true,
          variadic: false,
          type: { _tag: "String" }
        }
      ],
      subcommands: [
        {
          name: "remove",
          description: "Remove an alias",
          flags: apiFlags,
          arguments: [
            {
              name: "name",
              description: "The alias to remove",
              required: true,
              variadic: false,
              type: { _tag: "String" }
            }
          ],
          subcommands: []
        },
        {
          name: "list",
          description: "List aliases by name",
          flags: apiFlags,
          arguments: [],
          subcommands: []
        }
      ]
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
