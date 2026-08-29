/**
 * The CLI reference page, from the CLI itself: `handbill <command> --help` for
 * every command in the tree, so the page cannot say something the binary does
 * not. Writes src/generated/cli.md (gitignored); `build` and `dev` run it first.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { handbill } from "handbill/src/commands"

const CLI = fileURLToPath(new URL("../../cli/", import.meta.url))
const OUT = fileURLToPath(new URL("../src/generated/cli.md", import.meta.url))

/** What this script needs of a command: its name and what is under it. */
interface Node {
  readonly name: string
  readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<Node> }>
}

/** Every command path, parents before children: `[]`, `["alias"]`, `["alias", "remove"]`. */
const paths = (
  command: Node,
  path: ReadonlyArray<string> = []
): ReadonlyArray<ReadonlyArray<string>> => [
  path,
  ...command.subcommands.flatMap((group) =>
    group.commands.flatMap((sub) => paths(sub, [...path, sub.name]))
  )
]

const help = (path: ReadonlyArray<string>): string => {
  const run = Bun.spawnSync(["bun", "src/cli.ts", ...path, "--help"], { cwd: CLI })
  if (run.exitCode !== 0)
    throw new Error(`handbill ${path.join(" ")} --help failed:\n${run.stderr}`)
  const text = run.stdout.toString()
  // The global flags are the same on every command; the root shows them once.
  return (path.length === 0 ? text : text.replace(/GLOBAL FLAGS\n(?:.+\n)+\n?/u, "")).trimEnd()
}

const sections = paths(handbill).map(
  (path) => `## ${["handbill", ...path].join(" ")}\n\n\`\`\`text\n${help(path)}\n\`\`\``
)

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(
  OUT,
  `Every command answers \`--help\`; this page is that output, generated from the CLI at build time. Success prints exactly one line on stdout — the URL — or one JSON object with \`--json\`; everything else goes to stderr, and a failure exits non-zero.\n\n${sections.join("\n\n")}\n`
)
