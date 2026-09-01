import { Command } from "effect/unstable/cli"
import { login, logout } from "./account"
import { admin } from "./admin"
import { alias } from "./aliases"
import { completions } from "./completions"
import { doctor } from "./doctor"
import { list, publish, remove } from "./pages"
import { update } from "./update"

/**
 * The command tree, and nothing else: each command is defined in the file named
 * after what it acts on — `pages.ts`, `aliases.ts`, `update.ts`, `account.ts`,
 * `doctor.ts`, `admin.ts`, `completions.ts` — and built from the helpers in
 * `command-kit.ts`. The order below is the order `--help` lists them in, so
 * `admin` sits last before the plumbing: it is for whoever runs the deployment,
 * not for whoever publishes to it.
 */
export const handbill = publish.pipe(
  Command.withSubcommands([update, list, remove, alias, login, logout, doctor, admin, completions])
)
