# The 0.3 drill

[WAF.md](WAF.md) is what you read during an incident. This is what you read once, before there is one.

Four scenarios, in order: a stranger publishes, a report becomes a takedown and a dead key, the daily quota refuses a publish, and the kill switch is thrown and put back. Each is a script — pre-conditions, the commands verbatim, what success looks like — with `Result:` and `Time:` lines left blank on purpose. **Fill them in this file, in a commit.** A drill whose numbers live in someone's head is the same as no drill.

Two standing rules:

- **A finding is an issue, not a patch.** When a step fails, or the words that led someone into it were wrong, open an issue and carry on with the drill. Fixing inline turns a measurement into a debugging session and you lose the rest of the run.
- **Nothing here is a real attack.** Publish pages that say they are a drill. A convincing fake phishing page on `handbill.dev` can be reported by a stranger, and then the rehearsal is an incident.

## Run log

| Run | Date | Operator | Worker deployed | Notes |
|---|---|---|---|---|
| 1 | — | — | — | — |

## Shared pre-conditions

Check these once, before scenario A:

```sh
curl -s https://api.handbill.dev/v1/health
# {"ok":true,"mode":"accounts","zone":"handbill.dev"}

cd apps/worker
bunx wrangler secret list          # PUBLISH_TOKEN and ADMIN_TOKEN both present
bunx wrangler kv namespace list    # note the ACCOUNTS id; every KV command below wants it
```

You also need, in hand: the `ADMIN_TOKEN` value, the `PUBLISH_TOKEN` value, and **two GitHub accounts** — a *publisher* to be taken down and a *bystander* whose key must survive it. One account cannot prove tenant isolation.

**`--remote` on every `kv key` command, without exception.** `wrangler kv key list|get|put|delete` default to the *local* simulated store, silently: a production namespace id reads there as an empty namespace, so a `list` prints `[]` and a `put` writes to `.wrangler/state`, both exit 0 with no warning. The trap is that `kv namespace list` above is remote-only, so you are handed a real id and then hand it to a local store. In B7 that failure is expensive — the key is never revoked, B8 finds it still publishing, and the drill records a working control as broken. Every `kv key` line below carries the flag; if you retype one from memory, retype the flag.

**Rate limits apply to you too.** WAF rule 1 blocks a client that exceeds 2 requests in 10 seconds against `PUT`/`POST` on `api.handbill.dev` — and `handbill login` (POST `/v1/keys`) and `handbill <file>` (PUT `/v1/pages/…`) are both in that count. Leave six seconds between writes. A blocked request is answered by Cloudflare's HTML error page rather than the Worker's JSON, so the CLI has nothing it recognises to report — on a publish it says *"The endpoint answered with something this CLI does not understand"*. Throughout the drill: an **HTML** 429 is the WAF, a **JSON** `QuotaExceeded` is the Worker. The `sleep 6` in the loops below is exactly at the limit rather than under it, so a stray `curl` from a second terminal in the same window trips it — the drill often has two people on one zone, so keep the writes coming from one of them.

---

## A · The stranger test

The 0.3 exit criterion, verbatim: *a stranger publishes with no config in under two minutes*.

**Pre-conditions**

- A person who has not seen this repository, on their own machine, Node ≥ 22 installed, signed in to GitHub in a browser.
- They are handed exactly one thing: <https://handbill.dev/docs/hosted/>. No hints, no narration. **You do not answer questions during the run** — a question asked is the finding, and a run you coached is a discarded run.
- Their environment is clean: `env | grep HANDBILL` prints nothing, and `~/.config/handbill/` does not exist.
- Give them the file to publish. Writing HTML is not what is being measured:

```sh
printf '<!doctype html><title>drill</title><p>hello' > hi.html
```

**Start** the clock when the page is on their screen. **Stop** it when a `https://<hash>.handbill.dev` URL is printed in their terminal. The npm install counts. Approving the device code on GitHub counts. Reading counts.

**Commands** — theirs, from the page, not from here:

```sh
npm i -g handbill
handbill login
handbill hi.html
```

**Expected.** `login` prints a short code and opens `github.com/login/device`; after approval it says nothing else on stdout. `handbill hi.html` prints exactly one line. Opening that URL serves the page.

If they reach for `npx handbill` instead, let them — the roadmap's own wording is `npx` while the page teaches `npm i -g`. Which one a stranger picks unprompted is worth knowing; both are measured against the same two minutes.

**A rate-limit trip is not a docs failure.** `login` and the publish are two writes, which is exactly what WAF rule 1 allows in ten seconds — and a stranger is precisely the person who mistypes a filename and runs the publish twice. The third request is blocked by the edge, so they get an HTML 429 and the CLI's *"answered with something this CLI does not understand"*, which under this scenario's own rules you may not explain to them. If that happens: note it, **discard the run**, wait a minute and start again — or raise rule 1's threshold for the duration of scenario A and put it back afterwards. Scoring a WAF block as the hosted page failing a stranger is the one way this scenario produces a wrong answer.

**Record**

- Total, and the three splits: install done, login done, URL printed.
- Every question they asked and every place they stopped to re-read, quoted.
- Anything they typed that the page did not tell them to type.

**Result:** —
**Time:** — (install — · login — · publish —)

**If this fails** (over two minutes, or they got stuck): fix the words, not the person. Open an issue against `apps/web/src/docs/hosted.md` quoting the sentence they were standing on when the clock ran out.

---

## B · The abuse drill, end to end

Report → takedown → revocation, on production, with a stopwatch. Time every step; the two numbers that matter are *report received → 404* and *report received → key dead*.

### B1 · Publish as a hosted user

**Pre-conditions.** The publisher's key in hand. Use the environment, not the config file, so your own key stays where it is.

```sh
export HANDBILL_ENDPOINT=https://api.handbill.dev
export HANDBILL_TOKEN=<the publisher's key>
printf '<!doctype html><title>drill</title><p>Abuse drill, not a real page.' > /tmp/drill.html
handbill /tmp/drill.html
# https://<hash>.handbill.dev
```

Publish a second page from the same key, six seconds later. It is never reported and never taken down: it is what proves at the end that revoking a key does not unpublish what it published.

**Expected.** Two URLs. Fetch the first one in a browser — deliberately, because a page that was never fetched never entered the edge cache, and B5 is about the cache.

**Result:** — (reported page —, second page —)
**Time:** —

### B2 · Report it as a stranger would

**Pre-conditions.** A mailbox that is not the operator's. The reporter starts at <https://handbill.dev/docs/abuse/> and finds the address there — being told it defeats the step.

Send: the URL in full, one sentence saying what is wrong with it, and a way to reply. Nothing else.

**Expected.** The mail arrives at `abuse@handbill.dev` and lands in the operator's inbox, not in spam. This leg is the part that breaks silently — forwarding, a filter, a DNS record that expired — and nothing else in the system will ever tell you it broke.

**Record.** How long it took the reporter to find the address; whether the page's three-item list was enough to write a usable report; where the mail landed.

**Result:** —
**Time:** — (sent → received)

### B3 · The operator receives it

The clock for everything below starts here, at the moment the report is *seen* — that is the number the abuse page promises against ("taking it down is seconds").

**Result:** —
**Time:** — (received at —, seen at —)

### B4 · Find the owner, then take the page down

**Owner first.** Takedown deletes the index entry, so the cheap way from a hash to an account is gone the moment you run it.

```sh
NS=<the ACCOUNTS namespace id>
bunx wrangler kv key list --remote --namespace-id "$NS" --prefix "i:" | grep <hash>
# → i:gh:4242:<hash>
```

Then:

```sh
export HANDBILL_ENDPOINT=https://api.handbill.dev
export HANDBILL_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
handbill admin takedown https://<hash>.handbill.dev
```

**Expected.** The hash on stdout, exit 0. It is idempotent — running it twice is not an error. `HANDBILL_ADMIN_TOKEN` never goes in the config file.

**Result:** — (owner —)
**Time:** —

### B5 · Confirm the 404, and purge

```sh
curl -s -o /dev/null -w '%{http_code}\n' "https://<hash>.handbill.dev/"
# 404
```

If that answers `200`, it is the edge cache, not the origin: pages are served `immutable`, so a copy the edge took in B1 outlives the object by a year. **Purge it** — Cloudflare dashboard → the zone → Caching → Configuration → *Purge Cache* → by URL, `https://<hash>.handbill.dev/` — then check again from a client that has never seen the page (another network, or a phone off wifi).

**Expected.** 404 from every client that did not already have the page. A reader who already fetched it keeps their copy: that is the limit of the promise, stated on the abuse page, and not a failure of this step.

**Record.** Whether the first `curl` needed the purge — the honest answer to "how long until it stops being served" is the one that includes it.

**Result:** —
**Time:** — (B3 → first 404)

### B6 · Confirm it left the owner's list

From the publisher's terminal, whose key is still live at this point:

```sh
handbill list      # the reported hash is gone; the second page is still there
```

**Result:** —
**Time:** —

### B7 · Revoke the publisher's keys

A separate decision from the takedown, and a separate act — see WAF.md, *Decide about the key*. Do it here because the drill has to exercise it.

```sh
NS=<the ACCOUNTS namespace id>
OWNER=gh:<the publisher's numeric id>
bunx wrangler kv key list --remote --namespace-id "$NS" --prefix "o:$OWNER:"
# → o:gh:4242:<digest>, one per key ever minted; the k: record says which are live
bunx wrangler kv key get --remote --namespace-id "$NS" "k:<digest>"
# → {"owner":"gh:4242","created":"2026-09-01T…","tier":"free"}
bunx wrangler kv key put --remote --namespace-id "$NS" "k:<digest>" \
  '{"owner":"gh:4242","created":"<as it was>","tier":"free","revoked":"<now, ISO 8601>"}'
```

**Expected.** The record reads back with `revoked` set, and every other field exactly as it was. Repeat for every digest the `o:` prefix listed.

**Result:** — (keys revoked: —)
**Time:** — (B3 → key dead)

### B8 · Confirm the key is dead

From the publisher's terminal:

```sh
handbill list
printf '<!doctype html><title>dead</title>' > /tmp/dead.html   # fresh bytes, so a
handbill /tmp/dead.html                                        # success cannot be a republish
```

**Expected.** Both fail, non-zero, on stderr: *"The endpoint rejected the token. Run `handbill login` for a hosted deployment, or check it against the Worker's PUBLISH_TOKEN."* Nothing on stdout.

**Result:** —
**Time:** —

### B9 · Confirm nobody else was touched

This is the step the whole scenario exists for. Three checks:

```sh
# 1. the publisher's other page still serves — revocation is not unpublishing
curl -s -o /dev/null -w '%{http_code}\n' "https://<second hash>.handbill.dev/"      # 200

# 2. the bystander can still list and publish
HANDBILL_TOKEN=<the bystander's key> handbill list
HANDBILL_TOKEN=<the bystander's key> handbill /tmp/bystander.html                    # a URL

# 3. the publisher can mint a new key — revocation buys time, it does not close a door
handbill login    # on the publisher's account, if you want to confirm it
```

**Expected.** 200, a listing, a URL. Check 3 is meant to succeed: `POST /v1/keys` is open to any GitHub account by design, and a repeat offender is a policy problem, not a KV one.

**Result:** —
**Time:** —

### B · Headline numbers

| | |
|---|---|
| Report received → page 404s | — |
| Report received → key dead | — |
| Purge needed? | — |

**If any step fails:** finish the scenario anyway — a half-run drill measures nothing — then open one issue per failure. A takedown that did not 404, a report that never arrived, and a revoked key that still published are three different bugs in three different systems.

---

## C · The daily quota refuses a publish

The 429 the code promises, observed on production rather than in a test. The refusal was seen on `handbill.dev` on 2026-09-01; what it said goes in the slot at the end of this scenario, verbatim, and the loop is here so it can be re-run after any change to `quotas.ts`.

**Pre-conditions.** An account you are willing to spend a day's quota on — the day's page count is not refunded by unpublishing, so this account cannot publish again until the next UTC midnight. `sleep 6` holds the loop at WAF rule 1's allowance rather than over it, so nothing else may write to the zone while it runs.

```sh
export HANDBILL_ENDPOINT=https://api.handbill.dev
export HANDBILL_TOKEN=<a key you can spend>
for i in $(seq 1 30); do
  printf '<!doctype html><title>q%s</title>' "$i" > "/tmp/q$i.html"
  handbill "/tmp/q$i.html" || break
  sleep 6
done
```

**Expected.** At the 26th publish or a little after it, a non-zero exit and one line on stderr:

> You have published 25 pages today, which is this account's daily limit. It resets at `<the next UTC midnight, ISO>`.

*A little after* is the point, and it is why the loop runs to 30 rather than 26. The counters are eventually consistent, so the run may get one or two past 25 — never short of it — and a loop that stops at 26 can finish without ever seeing the refusal, which reads as "no 429" when it was only "no headroom". Four spare pages on an account already written off for the day buy the difference between an observation and an ambiguity. An **HTML** 429 instead is the WAF, not the quota; slow the loop down.

The counter behind it:

```sh
NS=<the ACCOUNTS namespace id>
bunx wrangler kv key get --remote --namespace-id "$NS" "q:<owner>:d:$(date -u +%Y%m%d)"
bunx wrangler kv key get --remote --namespace-id "$NS" "q:<owner>:bytes"
```

**Record.** The message verbatim, the number of publishes that actually went through, and the counter's value when it stopped.

**Observed message:** —
**Publishes before the refusal:** —
**Result:** —
**Time:** —

**Clean-up.** `handbill remove` each hash to give the stored bytes back; the day's count expires itself in 48 hours.

**If this fails** (no 429, or a 429 with the wrong limit named): the quota is the cost ceiling for the whole service. Open an issue and say so in it.

---

## D · Backout rehearsal — the kill switch

Architecture §08's claim, tested: *remove the `ACCOUNTS` binding and deploy — the Worker reverts to secret mode, hosted publishing 401s, and every already-published page keeps serving.* The point of rehearsing is to learn what the flip really costs before the day you need it.

**Pre-conditions**

- `bunx wrangler secret list` shows `PUBLISH_TOKEN`. Without it, secret mode authorises nobody, and this stops being a backout and becomes an outage of all writing.
- The `ACCOUNTS` namespace id written down. You are about to delete the line that holds it.
- A quiet hour. Reads are unaffected throughout; hosted *writes* fail for the whole window. Target under five minutes.
- `apps/worker/wrangler.jsonc` ships with `kv_namespaces` commented out and the production deployment runs with it uncommented — a local edit that is never committed. It stays uncommitted through this rehearsal too. Check with `git diff apps/worker/wrangler.jsonc` at the start and at the end: the diff you finish with must be the diff you started with.

### D1 · Record the state to return to

```sh
cd apps/worker
NS=<the ACCOUNTS namespace id>
git diff wrangler.jsonc                         # the ACCOUNTS + ALIASES bindings, uncommitted
curl -s https://api.handbill.dev/v1/health      # {"ok":true,"mode":"accounts",…}
bunx wrangler kv key get --remote --namespace-id "$NS" "q:<owner>:bytes"   # note the number
```

Pick two page URLs that must keep serving: one published by a hosted account, one published before 0.3.

**Result:** —

### D2 · Unbind and deploy

Comment the `ACCOUNTS` entry out of `kv_namespaces` — leave `ALIASES` bound, and keep the namespace id in the comment, because putting it back is the next step.

```sh
bunx wrangler deploy
```

**Time:** — (deploy)

### D3 · Verify secret mode

```sh
curl -s https://api.handbill.dev/v1/health
# {"ok":true,"mode":"secret","zone":"handbill.dev"}

curl -s -o /dev/null -w '%{http_code}\n' "https://<hosted hash>.handbill.dev/"   # 200
curl -s -o /dev/null -w '%{http_code}\n' "https://<pre-0.3 hash>.handbill.dev/"  # 200
curl -si "https://<hosted hash>.handbill.dev/" | grep -i cache-control
# cache-control: public, max-age=31536000, immutable

# The body is required: without one the payload fails to decode and the answer is
# 400, from validation, never reaching the `AuthSecret.mint` that produces the 404.
# The token is junk on purpose — in secret mode `mint` fails before anything is sent
# to GitHub. Do not run this line in accounts mode, where the same curl forwards it.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.handbill.dev/v1/keys \
  -H 'content-type: application/json' -d '{"githubToken":"drill-not-a-real-token"}'   # 404

# PUBLISH_TOKEN is not an `hb_` key, so the CLI refuses to send it anywhere the
# caller did not name — the endpoint is not optional on these two lines.
export HANDBILL_ENDPOINT=https://api.handbill.dev
HANDBILL_TOKEN=<a hosted key>   handbill list    # rejects the token, non-zero
HANDBILL_TOKEN=<PUBLISH_TOKEN>  handbill list    # the operator's own pages, and only those
```

**Expected, and what each line is for.**

- Health says `secret`. That is the whole switch.
- **Both pages still serve, with the same headers.** Serving never consulted accounts; this is the invariant the kill switch exists to protect, and the only result in this scenario that would be a release-blocker.
- `POST /v1/keys` is `404`, not `401`: with no accounts, the feature is absent rather than empty. `handbill login` against it says the endpoint does not run accounts.
- A hosted key gets the token rejected. Expected, and the cost of the window.
- The operator's listing shows `owner = self` pages only. Strangers' pages are invisible in `list` while still being served — and `handbill remove` cannot touch them either, because ownership is read from R2. `handbill admin takedown` still works: `ADMIN_TOKEN` is not part of accounts.

**Result:** —

### D4 · Restore

Uncomment the `ACCOUNTS` binding with the id from D1, then:

```sh
bunx wrangler deploy
curl -s https://api.handbill.dev/v1/health                       # mode: accounts
HANDBILL_TOKEN=<the same hosted key> handbill list               # works, same pages as D1
bunx wrangler kv key get --remote --namespace-id "$NS" "q:<owner>:bytes"  # the number from D1
git diff wrangler.jsonc                                          # identical to D1
```

**Expected.** A key minted before the flip authorises after it, the listing is unchanged, and the counter is the number you wrote down. Unbinding a namespace does not touch what is in it — that is why the kill switch is cheap.

**Result:** —
**Time:** — (D2 deploy → D4 verified: the true cost of the kill switch)

**If this fails:** `bunx wrangler deployments list` then `bunx wrangler rollback` puts the previous version back without needing the config file to be right. Then open an issue — and if the failure was pages *not* serving in D3, it is a release-blocker, not an issue for later.

---

## Aftercare — the first week

Watch these; none of them page you, so they only exist if someone looks.

- **Quota counters.** `bunx wrangler kv key list --remote --namespace-id "$NS" --prefix "q:"` — how many accounts are counting at all, and whether any `bytes` counter is near 250 MB. A `bytes` value with no matching `i:` entries is the drift WAF.md §4 resets.
- **KV writes against the plan's ceiling.** A hosted publish costs three writes, minting a key two. WAF.md's table has the arithmetic; the free plan's ~1,000 writes a day is ~330 publishes.
- **Web Analytics** on `handbill.dev` — whether anyone read the hosted page before installing, and where they arrived from.
- **npm downloads** via the metrics branch, for whether the release moved anything.
- **`abuse@handbill.dev`** — check it even when it is empty, weekly. B2 is the only proof it works, and it was true once, on one day.

Findings become issues. That is the rule for the drill and it stays the rule afterwards.

This file was written before 0.3.0 shipped, so the roadmap row and the PRD's status line still say *releasing*; [RELEASING.md](RELEASING.md) is where flipping them belongs, at the `bump`.
