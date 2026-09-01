# handbill — conventions for agents and humans

This file is read by every coding agent (Codex, Cursor, Copilot, and others honour `AGENTS.md`; `CLAUDE.md` imports it). Keep it the single source of truth.

Hand someone a page: `handbill plan.html` → `https://<sha256[0:12]>.<zone>`. Self-host first on Cloudflare; a hosted tier later from the same code. The product definition, user stories, versions, and build order live in `docs/2026-08-28-prd.html` — read the relevant milestone before starting work.

## Ground rules

- The API contract lives in `packages/contract` and is versioned under `/v1`; it does not break inside a major version. Published links never change.
- Keep it small. **The Worker budget is 1310 lines of source** — every `.ts` file in `apps/worker/src` except `*.test.ts`, counted whole, comments included; tests grow freely. `QuotaExceeded` and every route definition live in `packages/contract`, which this budget does not count, and the WAF rules are a runbook rather than code. 0.4's billing webhook is deliberately _not_ priced in advance: it gets measured against 0.3's real code when 0.4 starts. `bun run --cwd apps/worker size` prints the count and fails over the budget, and the CI `size` job runs it. It is a budget, not a target: once it binds, a PR that adds lines takes something out and says what. If a feature needs a framework, the feature is wrong.
- No `any`. Prefer inferred types; brand IDs (`Hash`) with Schema. Write TypeScript Matt Pocock would sign off on.
- Non-goals are real: no multi-file sites, no server-side transforms, no analytics, no other clouds.
- YAGNI: build the milestone in front of you, not the next version.

## Stack

- **Effect 4**, pinned to an exact `4.0.0-rc.x` in every package (v3 is feature-frozen). Imports come from `effect/unstable/httpapi`, `effect/unstable/http`, `effect/unstable/cli`; platform code from `@effect/platform-node` (CLI). Never mix `@effect/platform` v3 packages in.
- **Cloudflare Workers + R2** via `wrangler` as a devDependency; `HttpRouter.toWebHandler` bridges Effect to the Workers `fetch` handler.
- **bun** workspaces, `bun test`, **oxlint** + **oxfmt**. Node ≥ 22 for the published CLI.
- Workspace packages import each other through the workspace symlink (`@handbill/contract` → its `src/index.ts`). Do not add TypeScript `references` between packages: a composite `noEmit` project cannot be referenced (TS6310).
- **Astro + Starlight** for `apps/web` (from 0.2). No app framework until a dashboard actually needs one.

## Layout

```
packages/contract   HttpApi + Schema — the single source of truth for the API
apps/worker         Effect on Workers; one file per service — storage (+ index) / auth / aliases / quotas
apps/cli            effect/unstable/cli; npm package "handbill"; bundled to dist/cli.js
apps/web            Astro site (0.2)
skills/handbill     the agent skill (SKILL.md)
docs/               PRD, SELF-HOSTING.md, RELEASING.md, WAF.md, DRILL.md, the original brainstorm
```

## Design invariants

- `hash = hex(sha256(bytes)).slice(0, 12)`; client computes it for the URL, server recomputes and rejects a mismatch (400).
- Served pages: `Content-Type: text/html; charset=utf-8`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: public, max-age=31536000, immutable`. Every path on a hash hostname serves the same document. An alias hostname serves the document it currently points at — served, never redirected — with `max-age=60` and the same other headers.
- Every stored object carries `customMetadata: { owner, title, publishedAt }` from day one — `owner` is what makes hosted mode (0.3) additive.
- Swappable layers: `StorageR2` / `StorageMemory`, `AliasesKV` / `AliasesDisabled`, `AuthSecret` / `AuthAccounts`, `IndexBucket` / `IndexKV`. A binding that may be missing picks its layer in `index.ts`; the handlers never ask whether a feature is on. Tests run on the memory layers; no Miniflare, no network.
- CLI stdout discipline: success prints exactly one line (the URL) or the `--json` object; everything else goes to stderr; non-zero exit on failure.
- Errors are `Schema.TaggedError`s with status annotations in the contract: `HashMismatch` 400, `Unauthorized` 401, `NotFound` 404, `TooLarge` 413.

## Working here

- `main` is protected: no direct pushes, no force-push, PR required with green `typecheck`, `lint`, `test`, and `size` jobs, branch up to date, squash merge only. Branches are deleted on merge. **Never merge a PR yourself and never enable auto-merge** — open it, make sure the checks are green, and stop; the maintainer merges.
- One GitHub issue per milestone; work on a branch named after it (`m3-worker`), open a PR with `Closes #N`. The PR title becomes the squash commit subject and the body its message — write both as you would a commit.
- The board is https://github.com/users/viktoravelino/projects/8. Use the `board` skill (`.claude/skills/board/`, also linked from `.agents/skills/`): `board.sh start <n>` when you begin, `board.sh add <n>` for every issue you create, `board.sh review <n>` right after opening the PR, `board.sh show` to see the state.
- Tests are focused: hashing, host classification, headers, error mapping, one in-process round-trip per CLI command. No smoke-test sprawl.
- Running the Worker by hand: `wrangler dev --var PUBLISH_TOKEN:<token>` keeps the token out of a `.dev.vars` file, and the CLI reaches it through `HANDBILL_ENDPOINT` and `HANDBILL_TOKEN`. Dev builds `request.url` from the configured route and ignores the request's `Host`, so `classifyHost` sees one hostname no matter what you send — testing a host class (`api`, a hash, an alias) means one `wrangler dev --local-upstream <host>` run per class, and a page fetched without it returns the API router's empty-body 404 rather than the page. Aliases need the `ALIASES` binding even in dev — `wrangler dev` has no flag for it — so uncomment the `kv_namespaces` line in `wrangler.jsonc` with any id (local KV is simulated) and never commit that edit.
- Comments explain how something is used, above functions and services; keep them current when code changes.
- Commits: imperative subject, scope prefix when useful (`worker:`, `cli:`), no AI attribution, no emoji.
- Never commit `.env`, `.dev.vars`, tokens, or `wrangler` state — `.gitignore` covers them. `PUBLISH_TOKEN` is a Worker secret.
