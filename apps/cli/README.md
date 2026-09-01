# handbill

Hand someone a page. One command turns a self-contained HTML file — or a markdown file — into an unguessable, immutable link on a domain you own.

```
$ handbill plan.html
https://a3f9c1d4e2b8.yourdomain.dev
```

The URL is the content hash: the same bytes always give the same link, a changed file is a new link, and a published link never changes under its reader. Pages are served with `noindex` and long-lived immutable caching from your own Cloudflare Worker and R2 bucket — your account, your domain, your token.

Docs: [handbill.dev/docs](https://handbill.dev/docs).

## Install

```sh
npm i -g handbill
```

Node ≥ 22. Two dependencies: `effect` and `marked`. Bleeding edge from `main`: `npm i -g handbill@nightly`.

## Sign in, or point it at your own

```sh
handbill login
```

Opens `github.com/login/device` on a short code, mints an API key for your GitHub account, and writes it to `~/.config/handbill/config.json`. Nothing else to configure: the endpoint defaults to the hosted deployment. `handbill logout` revokes that key and removes it again.

Self-hosting instead? Put your deployment in the same file:

```json
{ "endpoint": "https://api.yourdomain.dev", "token": "…" }
```

The endpoint is taken from the first of these that says anything, so a config file that names one behaves exactly as it always has:

1. `--endpoint <url>`, for one command
2. `HANDBILL_ENDPOINT`, for one shell
3. `endpoint` in the config file, for this machine
4. `https://api.handbill.dev`, the default

The token has no flag — a secret on the command line ends up in the shell history — so it comes from `HANDBILL_TOKEN` or from `token` in the config file, which is where `handbill login` puts the key it mints.

Don't have a deployment yet? It is one Worker, one bucket and two DNS records — about ten minutes: [self-hosting guide](https://github.com/viktoravelino/handbill/blob/main/docs/SELF-HOSTING.md).

## Use

| Command                                   | What it does                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `handbill plan.html`                      | Publish. Prints exactly one line: the URL.                                                |
| `handbill notes.md`                       | Render markdown to a self-contained page, publish that.                                   |
| `handbill - < plan.html`                  | Publish from stdin. Add `--markdown` to render it.                                        |
| `handbill plan.html --json`               | `{ "hash", "url", "created" }` instead. Every command takes `--json`.                     |
| `handbill list`                           | What you have published, newest first: date, URL, title.                                  |
| `handbill remove <url-or-hash>`           | Unpublish. Idempotent.                                                                    |
| `handbill update <url-or-hash> plan.html` | Republish: the new page up, its names moved, the old hash gone.                           |
| `handbill alias plan <url-or-hash>`       | Point a name at a page: `https://plan.yourdomain.dev` serves it. Opt-in, see below.       |
| `handbill alias list`                     | Your aliases: URL, then the hash each points at. `handbill alias remove plan` drops one.  |
| `handbill login`                          | Sign in with GitHub; prints the account the key belongs to. `handbill logout` revokes it. |
| `handbill doctor`                         | Endpoint, mode, key, key accepted, wildcard certificate — each with a one-line fix.       |
| `handbill completions zsh`                | Shell completions (bash, zsh, fish).                                                      |

Errors are one sentence on stderr and a non-zero exit; stdout is only ever the result — safe to pipe, safe for agents. `--open` on `handbill <file>`, `handbill update` and `handbill alias` opens the URL in your browser after printing it; stdout is still that one line. `--qr` on `handbill <file>` and `handbill alias` prints a scannable QR code for the URL to stderr — and skips it silently when stderr is not a terminal, so pipes never see it.

## Names

A hash link is the bytes, forever. An alias is a name you can point somewhere else: `plan.yourdomain.dev` serves whatever `plan` currently points at, and re-pointing it is visible within a minute, while every hash link ever handed out keeps working. The name answers as soon as `alias` prints its URL; `alias list` can lag a fresh name by up to a minute (KV lists are eventually consistent), so "No aliases set." straight after setting one is the lag, not a failure. Names are one DNS label — lowercase letters, digits and inner hyphens — and neither `api`, a hash, `list` nor `remove`.

**Names are guessable by construction.** A hash is 48 random bits; `plan` is a word anyone who knows your zone can try. Put behind a name only what you would not mind a stranger reading. That is why the feature is off until you switch it on: it needs a KV namespace bound to the Worker (`ALIASES`, in the [self-hosting guide](https://github.com/viktoravelino/handbill/blob/main/docs/SELF-HOSTING.md#living-names-optional)), and until then every `alias` command says so.

## Revise

```sh
handbill update https://a3f9c1d4e2b8.yourdomain.dev plan.html
```

One command for the whole rotation: publish the new file, re-point every name that pointed at the old page, then unpublish the old hash — in that order, so a reader following a name is not left on a 404. It prints the new URL and nothing else; `--json` adds what it did (`{ "hash", "url", "created", "removed", "aliases" }`), and the names it moved are reported on stderr. Update a page to bytes it already has and nothing happens.

The names it moves are the ones `alias list` reports, and it re-reads each of them by name before it moves anything, so a listing that reports a name against a stale hash no longer misleads it. What the listing does not report at all, it still cannot move: a name **created** in the last minute may be missing from the listing entirely, and `update` would then unpublish the page it points at. Give a brand-new name a minute before updating the page under it. Nothing else in the rotation is at risk — if any step fails, the new URL is still printed on stderr and the old page is left alone.

## Markdown

A `.md` or `.markdown` file is rendered by the CLI, not by the server: you get one HTML document with a built-in light/dark stylesheet and no external requests, and that document is what is hashed and published. The `<title>` comes from the first H1, or from the filename when the document has none. Raw HTML in the source is passed through as written. `--markdown` renders whatever you hand it, which is how stdin says so:

```sh
handbill notes.md
cat notes.md | handbill - --markdown
```

## One file, one link

Publish a self-contained HTML document: inline your styles and scripts, no references to local files. 5 MB by default. Anyone holding the link can read the page; the link is unguessable and not indexed, but it is not private. Details in the repository's [SECURITY.md](https://github.com/viktoravelino/handbill/blob/main/SECURITY.md).

## Source

[github.com/viktoravelino/handbill](https://github.com/viktoravelino/handbill) — Worker, CLI, and the agent skill, MIT.
