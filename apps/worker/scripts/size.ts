/**
 * The bundle-size gate: build the Worker the way `wrangler deploy` would and
 * fail if the gzipped result is over 1 MB. Run from `apps/worker` with
 * `bun run size`; needs no Cloudflare account.
 */
const LIMIT = 1024 * 1024
const root = new URL("..", import.meta.url).pathname

const built = Bun.spawnSync(
  ["./node_modules/.bin/wrangler", "deploy", "--dry-run", "--outdir", "dist"],
  { cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, CI: "1" } }
)
if (built.exitCode !== 0) process.exit(built.exitCode)

const bundle = await Bun.file(`${root}dist/index.js`).bytes()
const gzipped = Bun.gzipSync(bundle).byteLength
const report = `bundle: ${(bundle.byteLength / 1024).toFixed(1)} KiB, gzip: ${(
  gzipped / 1024
).toFixed(1)} KiB (limit ${LIMIT / 1024} KiB gzip)\n`

process.stdout.write(report)
if (gzipped > LIMIT) {
  process.stderr.write("bundle is over the gzip limit\n")
  process.exit(1)
}
