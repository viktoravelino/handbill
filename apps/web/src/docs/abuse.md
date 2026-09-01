**[abuse@handbill.dev](mailto:abuse@handbill.dev)** — one person reads it.

Use it for a page published on `handbill.dev`: phishing, malware, spam, doxxing, harassment, or material that is not the publisher's to have published. [Terms and acceptable use](/docs/terms/) is the full list. A security flaw in handbill itself is not an abuse report — use GitHub's private vulnerability reporting, as [Security](/docs/security/) describes. A self-hosted deployment on someone else's domain is not this address either; that is between you and whoever runs it.

## What to include

1. **The URL, in full** — `https://<twelve hex characters>.handbill.dev`. Without it there is nothing to act on: pages are addressed by the hash of their bytes and cannot be searched for by their content.
2. **What is wrong with it**, in a sentence or two. "Impersonates a bank's login page" is enough. If you are the person or company being impersonated, or you own material that was copied, say so.
3. **How to reach you**, if you want to hear back.

A screenshot helps and is never required. Do not send credentials, and do not attach the malware.

## What happens then

The honest version: this is one person's service, not a trust-and-safety department. There is no rota, no ticket number, and no promise measured in hours.

- Reports are read as they arrive, in practice within a day.
- Once a report has been seen and the page is clearly abusive, taking it down is **seconds** — one command — and it happens before any reply is written.
- You get a reply if you left a way to reach you. It says what happened to the page, not what was decided about the publisher.
- Whether the publisher's keys are revoked as well is a separate decision, and not one reported back to you.

Two things not to expect:

- **A copy already downloaded is out of reach.** Pages are served `Cache-Control: immutable`, so a reader who already fetched one keeps it. Takedown means new requests 404 and the caches the operator controls are purged. That is the whole of the promise.
- **No tombstone.** A page that has been taken down answers exactly like a URL that never existed. Nothing anywhere says a page was removed.

Legal orders and requests from law enforcement go to the same address, and reach the same one person.
