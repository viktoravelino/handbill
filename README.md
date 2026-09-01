# handbill

[![npm](https://img.shields.io/npm/v/handbill)](https://www.npmjs.com/package/handbill) [![npm downloads](https://img.shields.io/npm/dw/handbill)](https://www.npmjs.com/package/handbill) [![CI](https://github.com/viktoravelino/handbill/actions/workflows/ci.yml/badge.svg)](https://github.com/viktoravelino/handbill/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Hand someone a page. One command turns a self-contained HTML file — or a markdown file — into an unguessable, immutable link on a domain you own.

```
$ handbill plan.html
https://a3f9c1d4e2b8.yourdomain.dev
```

- **Yours.** A Cloudflare Worker and an R2 bucket you deploy once. Your account, your domain, your token, free tier. Nothing phones home.
- **Immutable.** The URL is the content hash. A link never changes under its reader; a new version is a new link.
- **Agent-native.** Ships an installable skill so coding agents end a task with a link instead of a file.

Docs: [handbill.dev/docs](https://handbill.dev/docs).

## Install

```sh
npm i -g handbill
```

Node ≥ 22. Two dependencies: `effect` and `marked`. Every night `main` is published as `handbill@nightly` if you want what has merged but not shipped. Then `handbill login` signs you in with GitHub and writes the key it mints to `~/.config/handbill/config.json`; the endpoint defaults to `https://api.handbill.dev`.

Point it at your own deployment (below) with the same file:

```json
{ "endpoint": "https://api.yourdomain.dev", "token": "…" }
```

or `HANDBILL_ENDPOINT` and `HANDBILL_TOKEN` in the environment, which win over the file. `--endpoint <url>` on any command beats both, and all three beat the default.

## Self-host in five steps

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/viktoravelino/handbill/tree/main/apps/worker)

From a clone of this repository, after `bun install`, in `apps/worker` (wrangler reads the `wrangler.jsonc` there):

1. In `wrangler.jsonc`, change the three lines marked `EDIT` to your zone.
2. Add two proxied DNS records on the zone: `api` and `*`.
3. `bunx wrangler r2 bucket create handbill`
4. `openssl rand -hex 32 | bunx wrangler secret put PUBLISH_TOKEN`
5. `bunx wrangler deploy`

The full walkthrough — token scopes, verification curls, limits, troubleshooting — is in [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md). Ten minutes the first time.

## Use

| Command                                 | What it does                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `handbill plan.html`                    | Publish. Prints exactly one line: the URL.                                                     |
| `handbill notes.md`                     | Render markdown to a self-contained page, publish that.                                        |
| `cat plan.html \| handbill -`           | Publish from stdin. Add `--markdown` to render it.                                             |
| `handbill plan.html --json`             | `{ "hash", "url", "created" }` instead. Every command takes `--json`.                          |
| `handbill list`                         | What you have published, newest first: date, URL, title.                                       |
| `handbill remove <url\|hash>`           | Unpublish. Idempotent.                                                                         |
| `handbill update <url\|hash> plan.html` | Republish: the new page up, its names moved, the old hash gone.                                |
| `handbill alias plan <url\|hash>`       | Point a name at a page: `plan.yourdomain.dev` serves it. Opt-in; `alias list`, `alias remove`. |
| `handbill doctor`                       | Config, token, endpoint, token accepted, wildcard certificate — each with a one-line fix.      |
| `handbill completions zsh`              | Shell completions (bash, zsh, fish).                                                           |

Errors are one sentence on stderr and a non-zero exit; stdout is only ever the result. `--open` on `handbill <file>`, `handbill update` and `handbill alias` opens the URL in your browser after printing it. `--qr` on `handbill <file>` and `handbill alias` prints a scannable QR code for the URL to stderr — hand someone the page across a table — and skips it silently when stderr is not a terminal, so pipes never see it.

## How it works

`hash = hex(sha256(bytes))[0:12]` — the first 12 hex characters of the digest. The client computes it to form the URL; the server recomputes it and rejects a mismatch. Publishing the same bytes twice returns the same URL and stores nothing new.

The page is served from `https://<hash>.<zone>` — its own origin — with `text/html; charset=utf-8`, `X-Robots-Tag: noindex, nofollow`, and `Cache-Control: public, max-age=31536000, immutable`. Every path on that hostname serves the same document. The API lives at `api.<zone>` under `/v1` and needs the bearer token for everything except `/v1/health`, the generated spec at `/v1/openapi.json`, and the reference that renders it at `/docs`.

Optionally, a **living name**: `handbill alias plan <hash>` makes `plan.<zone>` serve that page (cached for a minute, not a year) until you point the name elsewhere, while every hash link ever handed out keeps working. Names are guessable by construction, so the feature is off until you bind a KV namespace — [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md#living-names-optional) has the trade-off and the setup.

Revising a page is `handbill update <old> new.html`: it publishes the new file, re-points every name that pointed at the old page, and only then unpublishes the old hash — that order is why a reader following a name is not left on a 404. Same bytes, same hash, nothing to do. One caveat, inherited from the KV listing: `update` can only move names that `alias list` reports, and that listing lags a _newly created_ name by up to a minute, so give a new name a minute before updating the page under it. (What each listed name points at is read back by name first, so a stale entry in the listing is not enough to strand one.)

One self-contained HTML file per link, 5 MB by default. No multi-file sites, no assets, no transforms on the server — a `.md` file is rendered to a page by the CLI, with a built-in light/dark stylesheet, before anything is uploaded.

## The link is public, the token is yours

Anyone holding a link can read the page; the link is unguessable and not indexed, but it is not private and not encrypted. Publishing and unpublishing need the token, which only you hold. Details in [`SECURITY.md`](SECURITY.md).

## Agents

[`skills/handbill/SKILL.md`](skills/handbill/SKILL.md) teaches a coding agent when and how to publish with `handbill`: one file, one URL, what never to publish, how to list, name and unpublish, and what to do when it fails. Install it by symlinking the directory into the agent's skills folder (`~/.claude/skills/` for Claude Code, `~/.agents/skills/` for Codex); it needs only `handbill` on `PATH` and a configured endpoint and token.

## Development

```sh
bun install
bun run typecheck && bun run lint && bun test
```

```
packages/contract   the HttpApi — schemas, errors, endpoints; the single source of truth
apps/worker         Effect on Cloudflare Workers; deploy with wrangler
apps/cli            the npm package; bun build → dist/cli.js
apps/web            handbill.dev: Astro + Starlight, this README and docs/ rendered; deployed from main
skills/handbill     the agent skill
docs/               PRD, self-hosting, releasing
```

Effect 4 end to end, pinned to an exact release candidate. Conventions and invariants are in [`AGENTS.md`](AGENTS.md); the product definition, user stories, and roadmap in [`docs/2026-08-28-prd.html`](docs/2026-08-28-prd.html). Work is tracked in the issues and the project board.

## Roadmap

- **0.1** — self-host kit: Worker, CLI, skill (released)
- **0.2** — markdown input rendered in the CLI, living names on KV with `alias` commands, `--open`, OpenAPI + `/docs`, the site at [handbill.dev](https://handbill.dev) (released)
- **0.3** — hosted mode: the same Worker with accounts instead of a single token
- **0.4** — paid tier: a subscription that raises the hosted quotas, and nothing on the read path that knows about it
- **0.5** — sheets and time: inline local assets at publish time, expiring pages
- later — encrypted pages

## License

MIT
