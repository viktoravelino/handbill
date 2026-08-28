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

Pre-release. Nothing here runs yet. The product definition, user stories, and build order are in [`docs/2026-08-28-prd.html`](docs/2026-08-28-prd.html); work is tracked in the issues and the project board.

## License

MIT
