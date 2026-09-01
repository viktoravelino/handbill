/**
 * The Worker size gate, in both senses: how big the deployed bundle is and how
 * much source there is to read. Run from `apps/worker` with `bun run size`;
 * needs no Cloudflare account. CI runs it as the `size` job, and its output is
 * what a Worker PR quotes as its before/after line count.
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const BUNDLE_LIMIT = 1024 * 1024
/**
 * See AGENTS.md — `src/*.ts` minus tests, which grow freely. Raised from 750 to
 * 1125 for 0.3 in #88, and to 1310 ahead of M16 (#85) once M13/M14 had shown
 * what a hosted service actually costs. AGENTS.md carries the itemisation;
 * these two places move together.
 */
const SOURCE_LINE_LIMIT = 1310
// `fileURLToPath`, not `.pathname`: the latter keeps the URL escaping, so a
// checkout under a path with a space in it would not resolve.
const root = fileURLToPath(new URL("..", import.meta.url))

const sourceFiles = readdirSync(join(root, "src"))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .toSorted()

// Every line counts, comments included — the budget is about how much there is to read.
// Not `wc -l`: a file whose last line has no newline after it still has that line, and
// the budget should not depend on the formatter having normalised the file first.
const counts = await Promise.all(
  sourceFiles.map(async (name) => {
    const text = await Bun.file(join(root, "src", name)).text()
    return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  })
)
const lines = counts.reduce((total, count) => total + count, 0)

process.stdout.write(
  `${sourceFiles.map((name, index) => `  ${name} ${counts[index]}`).join("\n")}\n` +
    `source: ${lines} lines across ${sourceFiles.length} files (limit ${SOURCE_LINE_LIMIT})\n`
)

const built = Bun.spawnSync(
  ["./node_modules/.bin/wrangler", "deploy", "--dry-run", "--outdir", "dist"],
  { cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, CI: "1" } }
)
if (built.exitCode !== 0) process.exit(built.exitCode)

const bundle = await Bun.file(join(root, "dist/index.js")).bytes()
const gzipped = Bun.gzipSync(bundle).byteLength
const report = `bundle: ${(bundle.byteLength / 1024).toFixed(1)} KiB, gzip: ${(
  gzipped / 1024
).toFixed(1)} KiB (limit ${BUNDLE_LIMIT / 1024} KiB gzip)\n`

process.stdout.write(report)

let failed = false
if (lines > SOURCE_LINE_LIMIT) {
  process.stderr.write(
    `worker source is ${lines - SOURCE_LINE_LIMIT} lines over the budget — take something out in this PR and say what\n`
  )
  failed = true
}
if (gzipped > BUNDLE_LIMIT) {
  process.stderr.write("bundle is over the gzip limit\n")
  failed = true
}
if (failed) process.exit(1)
