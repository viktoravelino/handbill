// Daily metrics snapshot: GitHub traffic, stars, npm downloads, and Cloudflare
// Web Analytics, merged into date-keyed JSON files on the `metrics` branch.
// GitHub's traffic API only keeps 14 days and Web Analytics retention is
// limited too — this job is what turns those rolling windows into history.
//
// Dependency-free, Node >= 22. Sections skip with a warning when their token
// is missing; the run fails only if every section failed.
//
// Env: REPO (owner/name)            required
//      DATA_DIR                     where the JSON lives (default ./data)
//      METRICS_PAT | GITHUB_TOKEN   traffic API needs a user with push access;
//                                   the Actions installation token usually 403s
//      NPM_PACKAGE                  npm package name (skip npm when unset)
//      CF_API_TOKEN, CF_ACCOUNT_TAG, CF_SITE_TAG   Web Analytics (skip when unset)

/* oxlint-disable no-console -- console.error is this script's logging; CI reads it */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const repo = process.env.REPO
if (!repo) {
  console.error("REPO is required (owner/name)")
  process.exit(1)
}
const dataDir = process.env.DATA_DIR ?? "./data"
const ghToken = process.env.METRICS_PAT || process.env.GITHUB_TOKEN
const today = new Date().toISOString().slice(0, 10)

await mkdir(dataDir, { recursive: true })

const readJson = async (name) => {
  try {
    return JSON.parse(await readFile(join(dataDir, name), "utf8"))
  } catch {
    return {}
  }
}
// Date-keyed maps merge by overwrite: sources revise recent (partial) days,
// so the newest snapshot of a date always wins.
const writeJson = (name, obj) =>
  writeFile(
    join(dataDir, name),
    JSON.stringify(Object.fromEntries(Object.entries(obj).toSorted()), null, 2) + "\n"
  )

const get = async (url, headers) => {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

let ok = 0
const failures = []
const section = async (name, fn) => {
  try {
    await fn()
    ok++
  } catch (err) {
    failures.push(name)
    console.error(`${name}: ${err.message}`)
  }
}

// --- GitHub: traffic views/clones per day, repo counts, referrers/paths ----
const gh = (path) =>
  get(`https://api.github.com/repos/${repo}${path}`, {
    authorization: `Bearer ${ghToken}`,
    accept: "application/vnd.github+json"
  })

await section("github traffic", async () => {
  const github = await readJson("github.json")
  github.views ??= {}
  github.clones ??= {}
  github.repo ??= {}
  const [views, clones, info] = await Promise.all([
    gh("/traffic/views?per=day"),
    gh("/traffic/clones?per=day"),
    gh("")
  ])
  for (const v of views.views)
    github.views[v.timestamp.slice(0, 10)] = { count: v.count, uniques: v.uniques }
  for (const c of clones.clones)
    github.clones[c.timestamp.slice(0, 10)] = { count: c.count, uniques: c.uniques }
  github.repo[today] = {
    stars: info.stargazers_count,
    forks: info.forks_count,
    watchers: info.subscribers_count
  }
  await writeJson("github.json", github)
})

await section("github referrers", async () => {
  const [referrers, paths] = await Promise.all([
    gh("/traffic/popular/referrers"),
    gh("/traffic/popular/paths")
  ])
  const line = JSON.stringify({ date: today, referrers, paths })
  const name = join(dataDir, "referrers.ndjson")
  const existing = await readFile(name, "utf8").catch(() => "")
  await writeFile(name, existing + line + "\n")
})

// --- npm: daily downloads (last month each run; merge covers gaps) ---------
await section("npm", async () => {
  const pkg = process.env.NPM_PACKAGE
  if (!pkg) return console.error("npm: NPM_PACKAGE unset, skipping")
  const npm = await readJson("npm.json")
  const range = await get(`https://api.npmjs.org/downloads/range/last-month/${pkg}`)
  for (const d of range.downloads) npm[d.day] = d.downloads
  await writeJson("npm.json", npm)
})

// --- Cloudflare Web Analytics: pageviews + visits per day ------------------
await section("web analytics", async () => {
  const { CF_API_TOKEN, CF_ACCOUNT_TAG, CF_SITE_TAG } = process.env
  if (!CF_API_TOKEN || !CF_ACCOUNT_TAG || !CF_SITE_TAG)
    return console.error("web analytics: CF_* unset, skipping")
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
  const query = `query { viewer { accounts(filter: {accountTag: "${CF_ACCOUNT_TAG}"}) {
    rumPageloadEventsAdaptiveGroups(
      filter: {siteTag: "${CF_SITE_TAG}", date_geq: "${since}", date_leq: "${today}"},
      limit: 100, orderBy: [date_ASC]
    ) { count sum { visits } dimensions { date } } } } }`
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query })
  })
  const body = await res.json()
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors))
  const web = await readJson("web.json")
  for (const g of body.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups)
    web[g.dimensions.date] = { pageviews: g.count, visits: g.sum.visits }
  await writeJson("web.json", web)
})

if (ok === 0) {
  console.error(`every section failed: ${failures.join(", ")}`)
  process.exit(1)
}
console.error(
  `done: ${ok} section(s) ok${failures.length ? `, failed: ${failures.join(", ")}` : ""}`
)
