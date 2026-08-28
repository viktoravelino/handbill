---
name: handbill
description: Publish a self-contained HTML or markdown document (plan, report, review) to an unguessable, immutable URL with the handbill CLI. Use when the user asks to publish, share, deploy, or "give me a link" for an HTML or markdown file. Also lists what is published and unpublishes.
---

# handbill

`handbill <file>` uploads one self-contained HTML file — or a markdown file, which it renders to one first — and prints its public URL. Nothing else goes to stdout. The URL is content-addressed — the first 12 hex characters of the file's sha256 — so the same bytes always give the same link and never a duplicate; a changed file is a new link, and a published link never changes under its reader.

```bash
handbill plan.html              # → https://<hash>.<zone>
handbill notes.md               # markdown, rendered to a styled page first
cat plan.html | handbill -      # from stdin, no temp file
cat notes.md | handbill - --markdown
handbill plan.html --json       # → { "hash", "url", "created" }
```

On success, reply to the user with the URL and stop.

## Before publishing

- **One file per link.** A `.md` or `.markdown` file is rendered by the CLI into one self-contained page — built-in light/dark stylesheet, no external requests — and that page is what gets published; the deployment never sees markdown. Anything else goes up byte for byte, so HTML must be self-contained: a file that references local images, stylesheets, or scripts will 404 on the page.
- **Write markdown when the deliverable is prose.** It is shorter than hand-writing a document shell and reads well in both themes. Reach for HTML when the page needs its own design or any JavaScript.
- **It becomes public.** The link is unguessable and served with `noindex`, but anyone holding it can read it. Do not publish secrets, tokens, customer data, or internal material the user did not explicitly ask to share. When in doubt, say what you are about to publish and let the user confirm.
- **Configuration must exist.** `~/.config/handbill/config.json` with `{ "endpoint", "token" }`, or the environment variables `HANDBILL_ENDPOINT` and `HANDBILL_TOKEN`. If neither is present, tell the user — do not go looking for a token elsewhere.

## List what is published

```bash
handbill list            # one line per page, newest first: date, url, title
handbill list --json
```

Titles come from the document's `<title>` — for markdown, from the first H1, or the filename when there is none — so give every page a meaningful one. Use this when the user asks what has been published or has lost a link.

## Unpublish

```bash
handbill remove <url-or-hash>
```

Idempotent: succeeds even if the page is already gone. Use it immediately if something sensitive was published by mistake, then tell the user.

## When something fails

- Every failure is one sentence on stderr and a non-zero exit (`{ "error", "message" }` on stderr with `--json`). Report it; do not retry in a loop.
- `handbill doctor` checks, in order: config present, token present, endpoint reachable, token accepted, wildcard TLS valid — each with a one-line fix. Run it first when a command fails for a reason that is not the file.
- `command not found: handbill` → the CLI is not installed. `npm i -g handbill`, or from a checkout of the repository: `bun run --cwd apps/cli build && npm i -g ./apps/cli`.
- A `5xx` from the endpoint is the deployment's problem (`apps/worker` in the repository), not the file's. Tell the user and stop.

## Installing this skill

Copy or symlink this directory to where the agent reads skills from:

```bash
# Claude Code
ln -s "$PWD/skills/handbill" ~/.claude/skills/handbill
# Codex
ln -s "$PWD/skills/handbill" ~/.agents/skills/handbill
```

The skill only needs `handbill` on `PATH` and a configured endpoint and token.
