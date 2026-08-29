# Self-hosting handbill

One Cloudflare Worker, one R2 bucket, two DNS records. About ten minutes the first time; free tier for any personal use.

## What you need

- A domain on Cloudflare (DNS managed there — the zone must be *active* in your account).
- A Cloudflare account with **R2 enabled** (R2 → *Get started*; Cloudflare asks for a payment method even on the free tier).
- [bun](https://bun.sh) ≥ 1.3 and a clone of this repository. `wrangler` is a devDependency; never install it globally.

Throughout, `<zone>` is your domain, for example `example.dev`. Pages will be served at `https://<hash>.<zone>` and the API at `https://api.<zone>`.

## 1. An API token for wrangler

My Profile → API Tokens → *Create Token* → start from **Edit Cloudflare Workers**, then:

- add `Account · Workers R2 Storage · Edit` and `Zone · DNS · Edit`. The template already includes Workers Scripts, Workers Routes, and Workers KV Storage; if you build the token by hand instead, add those too (`wrangler delete` needs KV read — it checks for preview namespaces before removing a Worker).
- Account Resources: *Include* → your account
- Zone Resources: *Include · Specific zone* → `<zone>`

Copy the token into `apps/worker/.env` (gitignored):

```
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_ACCOUNT_ID=<account id>   # Workers & Pages overview, right-hand column
```

`bunx wrangler whoami` from `apps/worker` must show your account. If it lists several, `CLOUDFLARE_ACCOUNT_ID` is what pins the right one.

## 2. Three edits in `wrangler.jsonc`

`apps/worker/wrangler.jsonc` ships pointing at the maintainer's deployment. Change the three lines marked `EDIT`:

```jsonc
"vars": { "ZONE": "<zone>" },
"routes": [
  { "pattern": "api.<zone>/*", "zone_name": "<zone>" },
  { "pattern": "*.<zone>/*",   "zone_name": "<zone>" }
],
"r2_buckets": [{ "binding": "BUCKET", "bucket_name": "handbill" }]
```

Keep the Worker `name` and the bucket name unless you have a reason not to.

## 3. DNS records

Two records on `<zone>`, both **proxied** (orange cloud). The IP is a placeholder — the Worker route answers, not an origin:

| Type | Name  | Content     | Proxy |
|------|-------|-------------|-------|
| A    | `api` | `192.0.2.1` | on    |
| A    | `*`   | `192.0.2.1` | on    |

Universal SSL covers `*.<zone>` automatically. It does not cover a second level (`*.*.<zone>`), which is why pages live directly under the zone.

Create the records before deploying: a Worker route can only attach to a hostname that has a proxied record.

## 4. Bucket, secret, deploy

From `apps/worker`:

```sh
bun install
bunx wrangler r2 bucket create handbill

# The token the CLI will send. Keep it; you need it in step 5.
TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" | bunx wrangler secret put PUBLISH_TOKEN

bunx wrangler deploy
```

`MAX_BYTES` is an optional var (bytes, default 5 MB) if you want a different cap.

## 5. Point the CLI at it

```sh
mkdir -p ~/.config/handbill
printf '{ "endpoint": "https://api.<zone>", "token": "%s" }\n' "$TOKEN" > ~/.config/handbill/config.json
chmod 600 ~/.config/handbill/config.json
```

Environment variables work too and win over the file: `HANDBILL_ENDPOINT`, `HANDBILL_TOKEN`. Then:

```sh
npm i -g handbill
handbill doctor
```

`doctor` checks the config, the token, `GET /v1/health`, that the token is accepted, and that the wildcard certificate is valid. Each check prints pass/fail and one sentence of what to do.

## 6. Prove it

```sh
curl -s https://api.<zone>/v1/health
# {"ok":true,"mode":"secret","zone":"<zone>"}

printf '<!doctype html><title>hello</title><p>hi' > /tmp/hi.html
handbill /tmp/hi.html
# https://<hash>.<zone>

curl -si "https://<hash>.<zone>/" | head -8
# HTTP/2 200 · content-type: text/html; charset=utf-8
# x-robots-tag: noindex, nofollow · cache-control: public, max-age=31536000, immutable

handbill list
handbill remove <hash>
```

## Scripting against it

Your instance describes itself. `GET https://api.<zone>/v1/openapi.json` is the OpenAPI 3.1 document generated from the same contract the Worker implements and the CLI is built from, so it can never describe an API your deployment does not serve. It needs no token and is cacheable — point a client generator at it, or read it and write the four `curl`s by hand. `https://api.<zone>/docs` renders that same document as a browsable reference; it pulls the viewer from a CDN, so it wants an internet connection, while the spec itself is served by the Worker alone. Neither route exposes anything you published.

## Deploy to Cloudflare button

The button in the README clones the repo into your account and provisions the Worker and the bucket from `wrangler.jsonc`. It cannot know your zone, so after it finishes you still do steps 2 (edit the routes and `ZONE` in the generated repo), 3, and the `secret put` in step 4.

## Limits and cost

- Documents: one self-contained HTML file per link, 5 MB cap by default.
- Free tier: Workers 100 000 requests/day; R2 10 GB stored, 1 million writes and 10 million reads per month. A published page is one object; a read is one R2 get on cache miss — Cloudflare's cache serves the rest because responses are `immutable`.
- Nothing phones home. Your account, your bucket, your token.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `wrangler deploy` rejects a route | The proxied DNS record for that hostname does not exist yet (step 3). |
| `curl` to `api.<zone>` returns Cloudflare 522/1016 | Record exists but is not proxied, or the route pattern does not match `api.<zone>/*`. |
| `handbill` exits with `401` | Token mismatch: what is in `config.json` is not what `wrangler secret put` stored. |
| `400 hash_mismatch` | The file changed between hashing and upload, or something rewrote the bytes in transit. Publish again. |
| `413` | Over `MAX_BYTES`. Inline less, or raise the var. |
| Certificate error on `https://<hash>.<zone>` | Universal SSL for the wildcard can take a few minutes after the `*` record is created. |
| `whoami` shows the wrong account | Set `CLOUDFLARE_ACCOUNT_ID` in `.env`. |

## Updating

```sh
git pull
bun install
cd apps/worker && bunx wrangler deploy
```

The API is versioned under `/v1` and does not break inside a major version; published links never change.

## Removing it

`bunx wrangler delete` removes the Worker and its routes (a hand-made token without KV read still deletes the Worker but then reports an authentication error). Empty and delete the bucket in the dashboard, delete the two DNS records, and remove `~/.config/handbill/config.json`. Every published link stops resolving.
