---
name: handbill
description: Publish a self-contained HTML or markdown document (plan, report, review) to an unguessable, immutable URL with the handbill CLI. Use when the user asks to publish, share, deploy, or "give me a link" for an HTML or markdown file. Also revises a published page in place, lists what is published, names a page with an alias, and unpublishes.
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
- **A key must exist.** `~/.config/handbill/config.json` with a `token`, or the environment variable `HANDBILL_TOKEN`. The endpoint is optional — it defaults to `https://api.handbill.dev`, and `endpoint` in that file or `HANDBILL_ENDPOINT` overrides it. If there is no key, tell the user to run `handbill login` — do not run it for them, it needs their browser, and do not go looking for a token elsewhere.

## List what is published

```bash
handbill list            # one line per page, newest first: date, url, title
handbill list --json
```

Titles come from the document's `<title>` — for markdown, from the first H1, or the filename when there is none — so give every page a meaningful one. Use this when the user asks what has been published or has lost a link.

## Revise a published page

```bash
handbill update <old-url-or-hash> plan.html   # → the new URL
handbill update <old-url-or-hash> notes.md --json
```

Use this, not a second `handbill <file>`, whenever the user asks to fix, revise or re-publish something already published. It does the whole rotation in one command and in the order that matters: publish the new file, re-point every alias that named the old page, then unpublish the old hash — so a reader following an alias is not left on a 404. stdout is still exactly the new URL; the names it moved and the hash it removed are reported on stderr, and `--json` adds them as `{ "hash", "url", "created", "removed", "aliases" }`.

Three things to expect: the old link stops working, so hand the user the new URL and say the old one is gone; updating to bytes that are already published is a no-op that prints the same URL, which is the right answer, not a failure; and on a deployment with aliases switched off, `update` prints the one-sentence notice on stderr and finishes anyway.

**Do not `update` a page within a minute of creating an alias on it.** `update` can only move the names that `alias list` reports, and that listing lags a _newly created_ name by up to a minute (same lag as under "Name a page"). A name missing from the listing is not moved, and `update` still unpublishes the old hash — leaving that name serving a 404. If you have just created a name with `alias`, publish the revision with `handbill <file>` and re-point the name yourself with `alias`, or wait a minute. Re-pointing an existing name is safe: `update` reads each listed name back by name before it decides, so the hashes the listing carries can be stale without stranding anyone.

## Unpublish

```bash
handbill remove <url-or-hash>
```

Idempotent: succeeds even if the page is already gone. Use it immediately if something sensitive was published by mistake, then tell the user.

## Name a page

```bash
handbill alias plan <url-or-hash>   # → https://plan.<zone>, serving that page from now on
handbill alias list                 # one line per alias: url, hash
handbill alias remove plan          # the name stops answering; the page stays published
```

An alias is a living name: the reader's link keeps showing the latest version while every hash link stays exactly what it was, and `handbill update` re-points it at each revision for you. Only use one when the user asks for a stable or readable link, and say two things when you do: **names are guessable** (a hash is unguessable; `plan` is a word anyone who knows the zone can try), and **the feature is opt-in** — a deployment without its KV binding answers every `alias` command with one sentence saying how to enable it. Report that sentence to the user; do not work around it. One more thing to expect: the name works the moment `alias` prints its URL, but `alias list` can take up to a minute to show a fresh name (the deployment's key listing is eventually consistent). "No aliases set." right after a successful `alias` is that lag — trust the printed URL, do not set the name again.

## Showing the page

`--open` on `handbill <file>`, `handbill update` and `handbill alias` opens the printed URL in the user's default browser after printing it. stdout is still exactly one line. Use it only when the user asked to see the page, not by default.

`--qr` on `handbill <file>` and `handbill alias` also prints a scannable QR code for the URL — to stderr, so stdout is still exactly one line — for handing the page to someone physically present. When stderr is not a terminal the code is silently skipped, so the flag never breaks a pipe. Use it only when the user asks for a QR code or to share with a phone.

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
