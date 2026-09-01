# WAF rules and the abuse runbook

Two things protect a deployment that hosts strangers, and they are not the same thing:

- **Quotas** live in the Worker, count per account, and are about fairness and storage cost. 25 pages a day and 250 MB stored per owner, enforced on publish. They are code, they are tested, and they are described in [SELF-HOSTING.md](SELF-HOSTING.md).
- **Rate limits** live in the WAF, count per IP, and are about floods. They run *before* the Worker, so a flood costs no Worker invocations. They are configuration, not code — which is why they are written down here rather than committed: a zone is clicked together, and a rule nobody wrote down is a rule nobody can re-create.

This file is the record of what to set and why, plus what to do when a page is reported.

## The rules

Dashboard → the zone → **Security** → **WAF** → **Rate limiting rules** → *Create rule*.

### 1. `handbill-publish` — writes, 10 per minute per IP

The expensive, abusable calls: publishing a page and minting a key. A human publishing by hand does one every few seconds at most; ten a minute is generous for a person and useless for a script.

| Field | Value |
|---|---|
| If incoming requests match | `(http.host eq "api.<zone>" and http.request.method in {"PUT" "POST"})` |
| Characteristics | IP (client IP) |
| Period | 1 minute (10 seconds on the free plan — see below) |
| Requests | 10 |
| Action | Block |
| Duration | 1 minute |

`PUT` is `/v1/pages/<hash>` and `POST` is `/v1/keys`; both are on `api.<zone>` only, so nothing on a page hostname is touched. `DELETE` is deliberately out: unpublishing and revoking are how someone *stops* abusing, and rate-limiting the exit is the wrong trade.

### 2. `handbill-read` — reads, 300 per minute per IP

Pages are served from cache and are meant to be shared; this rule is only there so a scraper walking the hash space cannot bill the account for it. It should never fire for a real reader, including a page that loads a handful of subresources.

| Field | Value |
|---|---|
| If incoming requests match | `(http.host ne "api.<zone>")` |
| Characteristics | IP (client IP) |
| Period | 1 minute |
| Requests | 300 |
| Action | Block |
| Duration | 1 minute |

Guessing a live link is ~2⁴⁷ tries; at 300 a minute that is not a threat model, it is a heat-death. The rule exists for the bill, not for the secrecy.

### Free plan

The free plan allows **one** rate-limiting rule, and its period and mitigation timeout are fixed at 10 seconds. Check what the dashboard offers before assuming the table above is available as written. With one rule to spend, take rule 1 (writes) — reads are cached at the edge and cost far less per request — and scale the threshold to the period the plan gives you (10 seconds → 2 requests is the same rate as 10 a minute).

### Verifying

```sh
for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
    -H 'authorization: Bearer <a key>' -H 'content-type: text/html' \
    --data-binary '<!doctype html><title>rate</title>' \
    "https://api.<zone>/v1/pages/000000000000"
done
```

The first responses are the Worker's own (`400` for the deliberate hash mismatch — no page is created); once the rule bites they become `429` from the edge, with a Cloudflare error page rather than a JSON body. That difference is the check: a JSON `{"_tag":"QuotaExceeded"}` is the Worker's quota, an HTML `429` is the WAF.

## The abuse runbook

A report arrives naming a URL. Two acts, deliberately separate: take the **page** down, then decide about the **key**. A mistaken publish deserves the first and not the second.

### 1. Take the page down

```sh
export HANDBILL_ENDPOINT=https://api.<zone>
export HANDBILL_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
handbill admin takedown https://<hash>.<zone>
```

The object and its index entry go, the owner's stored bytes are released, and the URL 404s within seconds — nothing caches past the edge, which the delete purges. It is idempotent, so running it twice, or on a hash that was never published, is not an error. There is no tombstone: a taken-down page is indistinguishable from a hash that never existed.

`ADMIN_TOKEN` is the operator's own secret and never a user key. Keep it out of the config file (which is where an ordinary key lives) and pass it through the environment.

### 2. Decide about the key

Everything hosted lives in the one `ACCOUNTS` namespace under four prefixes: `k:<sha256(key)>` is a key record, `o:<owner>:<sha256(key)>` points from an owner back to their keys, `i:<owner>:<hash>` is a page index entry, and `q:<owner>:…` are the quota counters.

Find the owner of the page you took down (from the report, or from `i:` entries), then every key that owner holds:

```sh
NS=<the ACCOUNTS namespace id>
bunx wrangler kv key list --namespace-id "$NS" --prefix "o:gh:4242" # → o:gh:4242:<digest>, one per key
bunx wrangler kv key get  --namespace-id "$NS" "k:<digest>"
```

Revoking is a field on the record — the record stays, so the revocation is on the books and already-published pages keep serving:

```sh
bunx wrangler kv key put --namespace-id "$NS" "k:<digest>" \
  '{"owner":"gh:4242","created":"<as it was>","tier":"free","revoked":"2026-09-01T12:00:00.000Z"}'
```

That key stops authorizing immediately. It does not stop the account minting another one — `POST /v1/keys` is open to any GitHub account by design — so revocation buys time rather than closing a door. Repeat offenders are a policy problem (M17's terms), not a KV problem.

### 3. Sweep the account, if it comes to that

`handbill admin takedown` one hash at a time is the whole tool. To find everything an owner published:

```sh
bunx wrangler kv key list --namespace-id "$NS" --prefix "i:gh:4242:"   # → i:gh:4242:<hash>
```

Take each hash down, then revoke the keys. An owner's page count is quota-bounded at 25 a day, so this list is never long.

### 4. Write it down

Time from report to 404, and time from report to revoked key. The drill (M18) exists to make those two numbers real rather than aspirational; abuse tooling that has never been exercised is decoration.
