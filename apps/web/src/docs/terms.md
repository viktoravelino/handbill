**Effective 2026-09-15.** These terms cover the hosted service at `handbill.dev`: publishing through `handbill login` and the keys it mints. They do not cover the software, which is MIT-licensed — a deployment on your own Cloudflare account is yours alone, and nothing on this page reaches it. [Self-hosting](/docs/self-hosting/) is and stays the first-class path.

"The operator" below is one person. They run this service on their own Cloudflare account and read `abuse@handbill.dev` themselves. To publish here you need a GitHub account and enough years to enter an agreement where you live; `handbill login` is where you accept these terms.

## What you may not publish

Do not publish, or link to from a page you publish:

- **Child sexual abuse material.** Removed and reported — to the authorities and to GitHub — with every key revoked and no notice to you.
- **Malware** — droppers, exploit kits, ransomware notes, anything whose purpose is to compromise the reader.
- **Phishing**: a page that impersonates a person, a company or a login screen to collect credentials, payment details or one-time codes. An unguessable URL with free HTTPS on a plausible domain is exactly what a phisher wants, so this is the abuse this service expects and the fastest takedown here.
- **Doxxing** — someone's address, phone number, government id or private material, published to expose or intimidate them.
- **Spam infrastructure**: redirect hops, cloaked landing pages, SEO doorways, affiliate and scam funnels, pages published in bulk to be linked from mail nobody asked for.
- **Harassment**: content that threatens a person or incites violence against a person or a group.
- Anything **illegal** where you are or where the operator is, and anything you have no right to publish — someone else's copyrighted work, someone else's secrets.

Two things this list is not. It is not a taste test: a rough draft, an unpopular argument, an ugly page are all fine — this is a place to hand someone a document. And it is not exhaustive: the operator may take down anything that makes the service a liability to keep running, and will tell you what it was if you ask.

## What happens when you do

Two acts, deliberately separate:

- **Takedown.** The page stops being served within seconds and its URL 404s exactly like a hash that was never published — no tombstone, no notice owed to you beforehand.
- **Revocation.** That key stops working, so it publishes nothing further. Pages published with it before then keep serving until they are taken down too.

A mistaken publish gets the first and not the second. Repeat or deliberate abuse gets both, against every page you have published and every key you hold. For anything criminal the pages go first and the explanation comes later, if at all.

**What the operator cannot do is lock you out**, and it would be dishonest of this page to imply otherwise. Minting a key is open to any GitHub account by design, so nothing stops you signing in again and holding a working key a minute later — and nothing stops the operator revoking that one too, and the next. Enforcement here is a loop rather than a door: it makes abusing this service tedious and unrewarding, not impossible. The account itself can only be taken away by GitHub, which is where a persistent abuser gets reported.

One honest limit: takedown stops the service serving the page. Pages are served `immutable`, so a reader who already fetched one keeps their copy, and the operator cannot reach it. Caches the operator controls are purged; caches they do not control are not.

## Your pages are yours

You are responsible for what you publish. You keep whatever rights you had in it; the operator claims no ownership and takes only what serving requires — storing those bytes and sending them to whoever has the link.

**What you publish is served as given.** Nothing is rewritten, sanitised or scanned, and a markdown file is rendered to HTML by the CLI on your machine before anything is uploaded, raw HTML in it passed through as written. A page is a full HTML document that runs in the reader's browser with everything a web page can do, so its scripts, forms and requests are yours and so is any harm they do.

A link is unguessable, not private. Anyone holding it can read the page and pass it on; `X-Robots-Tag: noindex` keeps it out of search engines that honour the header and does nothing else. Do not put behind a handbill URL anything that would hurt you if a stranger opened it. [Security](/docs/security/) is the longer version of that paragraph.

## What the operator can see

All of it, plainly:

- **Every page you publish** — the bytes, the title, the size, the time it went up. Nothing is stored in a form the operator cannot read.
- **Your GitHub numeric id** (`gh:4242`), which is the whole of your account here. Not your username, email or repositories.
- **Your quota counters**: pages published today, bytes stored.
- **Cloudflare's logs and analytics** for the service, as any Cloudflare customer has for their own.

Deliberately not kept: no reader logs of the operator's own, no reader IP addresses in the service's storage, no accounts for readers, and no scanning of what you publish. Pages are looked at when someone reports one, not before.

## What is promised, and what is not

- **Published links never change.** For as long as the service runs, a hash URL serves the same bytes. Takedown is the only thing that kills a link.
- **Best effort, no SLA.** One person, no uptime guarantee, no support commitment, no backups you can call on — and paying for the bigger limits buys none of those either. The file on your disk is the original — keep it.
- **The service may end**, and its links die with it. That is the honest failure mode of hosting on someone else's domain, and the reason self-hosting stays first-class: the same CLI against your own Worker gives you links nobody else can switch off.
- **Quotas and features may change**, including the numbers on the [hosted page](/docs/hosted/) and the price on the [pricing page](/docs/pricing/). Publishing here stays free at the free limits, and nothing already published starts costing money retroactively. A price change applies from your next renewal, never to a period already paid for.
- **No warranty.** The service is provided as is. As far as the law allows, the operator is not liable for damage arising from using it or from being unable to use it.

## Payments

The free tier is the service; paying buys more of it and nothing else. What that means, in order:

- **Who you pay.** [Polar](https://polar.sh) is the merchant of record. The checkout runs on their domain, the charge appears under their name, and handbill never sees a card number — the operator sees that an account is paid for and the id of the subscription that says so, and that is the whole of it. Polar's own terms and privacy policy cover what they hold.
- **What it buys.** $8 a month, or $80 a year, raises this account's limits to 250 pages a day and 5 GB stored, instead of 25 and 250 MB. Nothing else changes: not the per-page limit, not the links, not what is served or how, and nothing on the read path ever asks whether a page's owner is paying.
- **Renewal.** The subscription renews automatically at the price you signed up at until you cancel it. Cancel any time from Polar's customer portal — the operator does not need to be told — and paid access runs to the end of the period you have already paid for.
- **Lapse.** At that point paid access ends and the account returns to the free limits. Nothing is deleted and no link stops working, however far over the free ceiling your pages add up to. If more is stored than the free limit allows, publishing is refused until you remove pages below it: the next publish answers `429 QuotaExceeded` saying exactly that, and `handbill remove` frees the bytes. The daily count is 25 again from the next UTC midnight. A card that stops working ends the same way.
- **Refunds.** Polar's policy, from Polar's dashboard — refunds are not something the operator processes in code. A refunded period lapses the account the same way a cancellation does.
- **Taxes.** Polar collects and remits whatever sales tax or VAT is owed where you are, and their receipt is the document for it.
- **Paying does not buy immunity.** Everything in "What you may not publish" applies to a paid account exactly as it does to a free one: a paying account is taken down and revoked on the same terms, and is not refunded for it.
- **Billing mistakes.** The operator can move an account between tiers by hand, and will, to fix one — a webhook that never arrived, a charge that should not have gone through. It is a correction, not a negotiation: nothing else about payment happens outside Polar.

[Pricing](/docs/pricing/) is the same thing in numbers.

## Ending it

You can leave whenever: `handbill remove` each page, then `handbill logout`, which revokes the key and deletes it from your machine. What survives is the revoked key record — your GitHub numeric id, when the key was made and when it was revoked, the tier it was on and when that tier last changed, and, if you ever paid for the account, the id of the subscription that paid for it — plus the pointer that lets the operator find it and a stored-bytes counter reading zero. The revocation stays on the books deliberately; none of it is anything you did not already read in this page. Pages you leave up keep serving.

The operator can revoke your keys and take your pages down at any time, and will say why unless saying so would get in the way of a criminal investigation.

## Reporting a page

`abuse@handbill.dev`. [How to write the report](/docs/abuse/), including copyright complaints, which go to the same address. Security flaws in handbill itself are not abuse reports — use GitHub's private vulnerability reporting, as [Security](/docs/security/) describes.

## Governing law

The operator is an individual, not a company, and these terms are governed by the law of the place they live in; a dispute neither an email nor a takedown can settle belongs to the courts there. Where your own country gives you consumer rights you cannot sign away, this clause does not take them.

## Changes to these terms

This page is the terms. When they change, this page changes and the effective date at the top moves with it; there is no notification list. The page is a file in a public repository (`apps/web/src/docs/terms.md`), so every edit it has ever had is on the record. Publishing after a change means you accept it; if you do not, `handbill logout` and take your pages with you.
