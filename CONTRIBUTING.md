# Contributing

The conventions, invariants, and layout live in [AGENTS.md](AGENTS.md) — written for coding agents and humans alike, and the single source of truth. The short version:

- bun workspaces: `bun install`, then `bun run typecheck && bun run lint && bun test`.
- `main` takes only pull requests, squash-merged from an up-to-date branch with `typecheck`, `lint`, `test`, and `size` green. The PR title becomes the squash commit subject and the body its message — write both as you would a commit: imperative, scope prefix when useful (`worker:`, `cli:`), no emoji.
- The Worker has a source line budget, enforced by the `size` job (`bun run --cwd apps/worker size`). Once it binds, a PR that adds lines takes something out and says what.
- Tests are focused — hashing, host classification, headers, error mapping — not smoke-test sprawl. No `any`.

Before building a feature, read the relevant milestone in [the PRD](docs/2026-08-28-prd.html). The non-goals are real: no multi-file sites, no server-side transforms, no analytics, no other clouds.

Two things that are not issues or PRs: a security flaw in handbill goes through [private vulnerability reporting](SECURITY.md), and a page someone published on `handbill.dev` goes to `abuse@handbill.dev` — [how the report is handled](https://handbill.dev/docs/abuse/).
