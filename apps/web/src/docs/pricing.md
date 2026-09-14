Publishing on `handbill.dev` is free, and stays free. The paid tier buys one thing: more of it.

| Per account   | Free                          | Paid               |
| ------------- | ----------------------------- | ------------------ |
| Pages per day | 25, resetting at UTC midnight | 250                |
| Stored bytes  | 250 MB                        | 5 GB               |
| Per page      | 5 MB                          | 5 MB               |
| Price         | —                             | $8/month, $80/year |

$80 a year is ten months' price. There is no trial: a checkout that costs nothing is a checkout worth squatting, and the free tier is the trial — 25 pages a day is a lot of pages.

**The read side is identical: same links, same headers, same immutability.** Nothing on the path from a URL to a document ever asks whether the owner is paying, which is the whole reason a paid tier is safe to have here. A page published on the free tier and a page published on the paid one are the same object behind the same `<hash>.handbill.dev` hostname, cached for a year, `noindex`, and unchanged by anything that happens to the account afterwards.

## Upgrading

```sh
handbill account --upgrade
```

It prints a checkout URL for the account the key in hand belongs to — the session is created server-side with the owner taken from the key, so a URL can only ever pay for the account that asked for it. Add `--open` to open it in the browser. Pick monthly or yearly on the page itself; both plans are on it.

Payments are handled by **[Polar](https://polar.sh)**, the merchant of record: they take the payment, charge the tax where it is owed, and their name is what appears on the statement. handbill never sees a card number. The subscription is managed from Polar's own customer portal — that is also where it is cancelled.

The tier flips when Polar says it has: usually seconds after the payment, and `handbill account` is where you check.

## What happens if it lapses

A cancellation, or a card that stops working, puts the account back on the free limits at the end of the period that was paid for. Concretely:

- **Nothing is deleted, and no link breaks.** Every page you published keeps serving at the URL you handed out, however far over the free ceiling they add up to.
- **Publishing stops until you are under the free ceiling again.** With more than 250 MB stored, the next publish answers `429 QuotaExceeded` naming the limit — unpublishing something frees the bytes back, and so does upgrading again.
- **The daily count is unaffected by any of this**; it is 25 again from the next UTC midnight.

That order is deliberate. Lapsing is a billing event, not a reason to lose a page someone else is reading: the worst it can do is stop you adding to what is already there.

## Self-hosting

None of this applies to your own deployment. [Self-hosting](/docs/self-hosting/) is the same Worker with your own bucket, and it counts nothing — you pay Cloudflare directly, which for personal use is usually nothing at all. The hosted tiers exist so that publishing a page can cost you no account setup, not to become the place your links have to live.
