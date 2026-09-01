Publishing on `handbill.dev` needs a GitHub account and nothing else — no Cloudflare account, no DNS records, no token to mint by hand.

```sh
npm i -g handbill
handbill login
handbill plan.html
# https://a3f9c1d4e2b8.handbill.dev
```

Free, and by publishing here you accept the [terms and acceptable use](/docs/terms/) — short, and blunt about what the operator can see.

## How login works

`handbill login` prints a short code and opens `github.com/login/device`, where you approve the "handbill CLI" GitHub App. The CLI exchanges GitHub's answer for a handbill key exactly once, writes the key to `~/.config/handbill/config.json` with mode `0600`, and throws GitHub's token away. The key is what publishes from then on; the server keeps only its SHA-256, so a dump of the store mints nothing. `handbill logout` revokes it and deletes it again.

**What handbill learns about you is your numeric GitHub id.** That is the entire account — `gh:4242`, which is what every page you publish is filed under. Not your username (ids survive renames), not your email, not your repositories, no password anywhere. There is no browser session and no cookie on this domain: signing in happens in your terminal, and the site you are reading has no login at all.

GitHub is a dependency of signing in and of nothing else. If GitHub is down you cannot mint a new key; publishing, reading and unpublishing carry on.

## What you get

One tier, `free`, per account:

| Limit         | Value                         |
| ------------- | ----------------------------- |
| Pages per day | 25, resetting at UTC midnight |
| Stored bytes  | 250 MB                        |
| Per page      | 5 MB                          |

Past either of the first two, publishing answers `429 QuotaExceeded` naming the limit, what it allows, and — for the daily one — when it resets. They are ceilings rather than exact counts: a burst of publishes at once can slip a little past before the counter catches up, never short of it. Unpublishing gives the stored bytes back; it does not refund the day's page count. A paid tier that raises these numbers is planned, with no pricing to quote yet, and nothing on the read path will ever ask whether a page's owner is paying.

## How it differs from self-hosting

|                       | Hosted                                              | Self-hosted                             |
| --------------------- | --------------------------------------------------- | --------------------------------------- |
| Where a page lives    | `<hash>.handbill.dev`                               | your own zone                           |
| Setup                 | `handbill login`                                    | one Worker, one bucket, two DNS records |
| Limits                | the table above                                     | your Cloudflare bill                    |
| Who can read a page   | anyone with the link, and whoever runs handbill.dev | anyone with the link, and you           |
| Living names          | not available                                       | yours, opt-in                           |
| Who can remove a page | you, or the operator on an abuse report             | you                                     |

Living names are operator-only here on purpose: a word on a shared domain is a word someone else wants, and `login.handbill.dev` in a stranger's hands is a phishing kit. Hosted publishing is hash URLs, full stop — [set up your own zone](/docs/self-hosting/#living-names-optional) if you want names.

Everything else is identical, because it is the same code: same CLI, same `/v1` contract, same immutable `noindex` headers on the served page. The hosted deployment is this repository's Worker with its KV namespaces bound — `ACCOUNTS` for keys, the page index and the counters, and `ALIASES`, which is separate and is why the operator has names here when you do not — and moving between hosted and your own is one line in `~/.config/handbill/config.json`:

```json
{ "endpoint": "https://api.yourdomain.dev", "token": "…" }
```

**Self-hosting stays the first-class path.** Hosted mode exists so you can hand someone a page two minutes after installing the CLI, not to become the place your links have to live. Links on a domain you own outlive whoever is running this one — the [self-hosting guide](/docs/self-hosting/) is about ten minutes, once.

Something wrong with a page here? [Report it](/docs/abuse/).
