# handbill

Hand someone a page. One command turns a self-contained HTML file into an unguessable, immutable link on a domain you own.

```
handbill plan.html
  ↳ https://a3f9c1d4e2b8.yourdomain.dev
```

- **Yours.** A Cloudflare Worker and an R2 bucket you deploy once. Your account, your domain, your token, free tier.
- **Immutable.** The URL is the content hash. It never changes under a reader; a new version is a new link.
- **Agent-native.** Ships an installable skill so coding agents end a task with a link.

## Status

Pre-release. The Worker, the CLI, and the agent skill are in place; self-hosting docs and the first npm release are in progress. The product definition, user stories, and build order are in [`docs/2026-08-28-prd.html`](docs/2026-08-28-prd.html); work is tracked in the issues and the project board.

## Agents

[`skills/handbill/SKILL.md`](skills/handbill/SKILL.md) teaches a coding agent when and how to publish with `handbill`: one file, one URL, what never to publish, how to list and unpublish, and what to do when it fails. Install it by symlinking the directory into the agent's skills folder (`~/.claude/skills/` for Claude Code, `~/.agents/skills/` for Codex); it needs only `handbill` on `PATH` and a configured endpoint and token.

## License

MIT
