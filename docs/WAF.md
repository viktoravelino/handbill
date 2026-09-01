# WAF rules and the abuse runbook

Two things protect a deployment that hosts strangers:

- **Quotas** live in the Worker, count per account, and are about fairness and storage cost. 25 pages a day and 250 MB stored per owner, enforced on publish. They are code, they are tested, and they are described in [SELF-HOSTING.md](SELF-HOSTING.md).
- **Rate limits** live in the WAF, count per IP, and are about floods. They run *before* the Worker, so a flood costs no Worker invocations. They are configuration, not code — which is why they are written down here rather than committed: a zone is clicked together, and a rule nobody wrote down is a rule nobody can re-create.

They have different jobs, but they are **not independent**, and it is worth being exact about why. The quota counters are Workers KV values, and KV is eventually consistent: `check` reads a count that `record` may already have raised, and inside that window every request in flight reads the same stale number. So the overshoot on the daily limit is not one page — it is however many publishes an attacker can get in before the counter catches up, which is a rate they choose. **Rule 1 below is what bounds that rate, which makes it required rather than recommended before a zone hosts strangers.** Without it, "25 pages a day" degrades towards "25 per round trip the attacker is willing to wait for".

The honest summary: quotas are a cost ceiling that assumes a rate limit underneath it. Making the counters exact would mean Durable Objects, which 0.3 deliberately does not have.

This file is the record of what to set and why, plus what to do when a page is reported.

## The rules

Dashboard → the zone → **Security** → **WAF** → **Rate limiting rules** → *Create rule*.

### 1. `handbill-publish` — writes, 10 per minute per IP · **required**

The expensive, abusable calls: publishing a page and minting a key. A human publishing by hand does one every few seconds at most; ten a minute is generous for a person and useless for a script.

This is the rule the daily quota leans on (see above), so a zone that hosts strangers should not be without it. It is also the one rule the free plan can express, which is convenient: if you can only have one, this is it.

| Field | Value |
|---|---|
| If incoming requests match | `(http.host eq "api.<zone>" and http.request.method in {"PUT" "POST"})` |
| Characteristics | IP (client IP) |
| Period | 1 minute (10 seconds on the free plan — see below) |
| Requests | 10 |
| Action | Block |
| Duration | 1 minute |

`PUT` is `/v1/pages/<hash>` and `POST` is `/v1/keys`; both are on `api.<zone>` only, so nothing on a page hostname is touched. `DELETE` is deliberately out: unpublishing and revoking are how someone *stops* abusing, and rate-limiting the exit is the wrong trade.

### 2. `handbill-read` — reads, 300 per minute per IP · recommended

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

### Free plan: the rules

The free plan allows **one** rate-limiting rule, and its period and mitigation timeout are fixed at 10 seconds. Check what the dashboard offers before assuming the table above is available as written. With one rule to spend, take rule 1 (writes) — reads are cached at the edge and cost far less per request — and scale the threshold to the period the plan gives you (10 seconds → 2 requests is the same rate as 10 a minute).

### Free plan: the other ceiling, which is KV writes

Not a WAF matter, but it belongs next to the one above, because it is the second plan limit that decides whether a deployment can host strangers — and M16 moved it. Workers KV's free plan allows on the order of **1,000 writes a day**, and a hosted publish now costs three of them:

| | before M16 | now |
|---|---|---|
| publish | 1 write (`i:` index entry) | **3** (`i:`, `q:<owner>:d:<date>`, `q:<owner>:bytes`) |
| remove / takedown | 1 delete | 1 delete + 1 write |
| mint a key | 1 write | **2** (`k:`, `o:`) |

So roughly **330 publishes a day** exhausts the free plan's KV writes — about thirteen accounts publishing their full 25 — after which writes start failing. Note what that costs: the index and the daily-count writes are not best-effort, so a failed KV write there is a defect and the publish answers **500 after the object is already stored and serving**. The caller is told it failed and the page is live; a retry then takes the same-bytes early return and answers 200 without charging anything, so the state converges, but the first answer is a lie and it is hard to diagnose from outside. The byte *release* on remove is deliberately different — it is swallowed, because a 500 there would misreport a removal that worked and the retry could never fix the counter.

Be on a paid KV plan before hosting strangers, not after. Self-hosted deployments write no KV at all unless aliases are on.

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

The object and its index entry go, and the owner's stored bytes are released. It is idempotent, so running it twice, or on a hash that was never published, is not an error. There is no tombstone: a taken-down page is indistinguishable from a hash that never existed.

**What a takedown does and does not reach.** At the origin it is immediate: the object is gone and any *new* request 404s. But pages are served `Cache-Control: public, max-age=31536000, immutable`, which is what makes a hash URL safe to hand out — and it means a reader who already fetched the page keeps their own copy for up to a year and is told not to revalidate. A takedown stops new fetches; it cannot reach a browser that already has it. Cloudflare's edge copy *can* be cleared, and should be, since it serves everyone: Caching → Configuration → **Purge Cache** → purge by URL (`https://<hash>.<zone>/`), or `POST /zones/<id>/purge_cache` with that URL. Nothing in the Worker does this for you.

So the honest promise to a reporter is "it stops being served now", not "every copy is gone". M18's drill should measure the first from a fresh client.

`ADMIN_TOKEN` is the operator's own secret and never a user key. Keep it out of the config file (which is where an ordinary key lives) and pass it through the environment.

### 2. Decide about the key

Everything hosted lives in the one `ACCOUNTS` namespace under four prefixes: `k:<sha256(key)>` is a key record, `o:<owner>:<sha256(key)>` points from an owner back to their keys, `i:<owner>:<hash>` is a page index entry, and `q:<owner>:…` are the quota counters.

Find the owner of the page you took down (from the report, or from `i:` entries), then every key that owner holds:

```sh
NS=<the ACCOUNTS namespace id>
# → o:gh:4242:<digest>, one per key ever minted: revoke leaves the pointer in
# place, so this over-counts live keys. The k: record is what says which are live.
bunx wrangler kv key list --namespace-id "$NS" --prefix "o:gh:4242"
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

### 4. Fix a stuck counter, if an owner reports one

`q:<owner>:bytes` is derived state that is never recomputed, and it can drift upward: a KV write that failed during a removal is not retried (the retry finds the object already gone and has nothing to release), so an owner can end up charged for storage they no longer have — and at 250 MB of phantom bytes they cannot publish at all. Nothing self-heals this. Delete the counter and it starts again from zero:

```sh
bunx wrangler kv key delete --namespace-id "$NS" "q:gh:4242:bytes"
bunx wrangler kv key list   --namespace-id "$NS" --prefix "i:gh:4242:"   # what they actually hold
```

Zeroing it under-counts rather than over-counts, which is the direction this codebase prefers everywhere else; if you want it exact, sum the `bytes` metadata on that owner's `i:` entries and `kv key put` that number instead. The daily counter (`q:<owner>:d:<yyyymmdd>`) needs no such tool: it expires itself in 48 hours.

### 5. Write it down

Time from report to 404, and time from report to revoked key. The drill (M18) exists to make those two numbers real rather than aspirational; abuse tooling that has never been exercised is decoration.
