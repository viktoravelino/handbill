# handbill

Hand someone a page. One command turns a self-contained HTML file — or a markdown file — into an unguessable, immutable link on a domain you own.

```
$ handbill plan.html
https://a3f9c1d4e2b8.yourdomain.dev
```

The URL is the content hash: the same bytes always give the same link, a changed file is a new link, and a published link never changes under its reader. Pages are served with `noindex` and long-lived immutable caching from your own Cloudflare Worker and R2 bucket — your account, your domain, your token.

## Install

```sh
npm i -g handbill
```

Node ≥ 22. Two dependencies: `effect` and `marked`. Bleeding edge from `main`: `npm i -g handbill@nightly`.

## Point it at a deployment

`~/.config/handbill/config.json`:

```json
{ "endpoint": "https://api.yourdomain.dev", "token": "…" }
```

or `HANDBILL_ENDPOINT` and `HANDBILL_TOKEN` in the environment (they win over the file). `--endpoint` on any command overrides both for one run.

Don't have a deployment yet? It is one Worker, one bucket and two DNS records — about ten minutes: [self-hosting guide](https://github.com/viktoravelino/handbill/blob/main/docs/SELF-HOSTING.md).

## Use

| Command                         | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `handbill plan.html`            | Publish. Prints exactly one line: the URL.                                                |
| `handbill notes.md`             | Render markdown to a self-contained page, publish that.                                   |
| `handbill - < plan.html`        | Publish from stdin. Add `--markdown` to render it.                                        |
| `handbill plan.html --json`     | `{ "hash", "url", "created" }` instead. Every command takes `--json`.                     |
| `handbill list`                 | What you have published, newest first: date, URL, title.                                  |
| `handbill remove <url-or-hash>` | Unpublish. Idempotent.                                                                    |
| `handbill doctor`               | Config, token, endpoint, token accepted, wildcard certificate — each with a one-line fix. |
| `handbill completions zsh`      | Shell completions (bash, zsh, fish).                                                      |

Errors are one sentence on stderr and a non-zero exit; stdout is only ever the result — safe to pipe, safe for agents.

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
