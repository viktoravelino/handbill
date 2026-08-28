---
name: code-review
description: How to review pull requests in handbill — the invariants to check, what to ignore, and how to phrase findings. Use for every pull request review in this repository.
---

# Code review for handbill

Read `AGENTS.md` first; every rule there is a review criterion. The product definition is `docs/2026-08-28-prd.html`; the issue linked from the PR (`Closes #N`) is the spec for the change.

## What to check, in priority order

1. **Design invariants** (any violation is a blocking finding)
   - `hash = hex(sha256(bytes)).slice(0, 12)`; the server recomputes it and rejects a mismatch with 400. The client never trusts its own hash.
   - Served pages carry `Content-Type: text/html; charset=utf-8`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: public, max-age=31536000, immutable`. Every path on a hash hostname serves the same document; the apex and unknown hosts return 404 with `no-store`.
   - Every stored object has `customMetadata: { owner, title, publishedAt }`.
   - Errors are the contract's tagged errors (`HashMismatch` 400, `Unauthorized` 401, `NotFound` 404, `TooLarge` 413); no ad-hoc status codes.
   - CLI stdout discipline: success prints exactly one line (the URL) or one `--json` object; everything else goes to stderr; non-zero exit on failure.
   - Auth fails closed: a missing `PUBLISH_TOKEN` must reject, never allow.
2. **Effect usage**
   - `effect` pinned to the exact `4.0.0-rc.x` in every package; imports from `effect/unstable/httpapi`, `effect/unstable/http`, `effect/unstable/cli`; no `@effect/platform` v3 packages.
   - Services are swappable layers (`StorageR2`/`StorageMemory`, `AuthSecret`/`AuthAccounts`); nothing reaches R2 or the network directly from a handler.
   - Tests run on the memory layers with `bun test`; no Miniflare, no network, no Cloudflare account.
3. **Scope and ownership**
   - The PR touches only the directories its issue owns (`apps/worker`, `apps/cli`, `packages/contract`, …). Flag changes to root configs, the contract, or another app that the issue did not ask for.
   - `bun.lock` changes are fine when they follow a `package.json` change in the same PR; a lockfile diff with no dependency change is suspicious.
4. **TypeScript quality**: no `any`, no casts to silence the compiler, inferred types over redundant annotations, no one-line wrapper functions. Comments above functions and services describe how they are used and match the code.
5. **Tests**: focused on behaviour (hashing, host classification, headers, error mapping, one round-trip per CLI command). Flag missing coverage for a changed invariant; do not ask for smoke tests.

## What not to comment on

- Formatting and import order — `oxfmt` and `oxlint` run in CI and are the authority.
- Style preferences not written in `AGENTS.md`.
- The choice of Effect, Cloudflare, bun, or the monorepo layout — decided in the PRD.
- Deployment steps in the PR body — those are for the human who deploys.

## How to write findings

- One comment per finding, anchored to the line, stating the invariant or rule it breaks and the concrete failure it causes. Suggest the fix when it is short.
- Distinguish **blocking** (invariant, correctness, scope) from **nit** (naming, comments) in the first word of the comment.
- If the PR is clean, say so in the summary in one sentence; do not invent findings. A review with no comments is the signal that moves the issue to "Ready to Merge".
