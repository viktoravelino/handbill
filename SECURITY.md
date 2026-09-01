# Security

## Threat model, in three sentences

A published page is public to anyone holding its link; the link is unguessable (48 bits of content hash) and served with `noindex`, but it is not secret: TLS protects it in transit, and nothing else does — anyone with the link, and the operator of the deployment, can read the page. There is no end-to-end encryption and no reader authentication. Writing — publishing and unpublishing — requires the bearer token, which only the deployment's operator holds; a missing or wrong token fails closed. The Worker serves bytes exactly as stored and never executes them, but a page is a full HTML document that runs in the reader's browser with everything any web page can do — call remote servers, load remote code, show whatever it likes — so publish only pages you trust; what the per-page origin guarantees is that a page cannot read another page's storage, cookies, or content, nor the API's. Living names (`plan.<zone>`, optional, off until a KV binding exists) trade the unguessable link for a guessable one: a name is a word anyone who knows your zone can try, and the page behind it changes when you re-point it, so put behind a name only what you would not mind a stranger reading.

## What handbill protects

- Nobody can publish, list, or delete without the token.
- A link cannot be forged: the server recomputes the hash of the bytes it receives and rejects a mismatch.
- Pages are isolated from each other and from the API by hostname (one origin per document).
- Pages are not indexed (`X-Robots-Tag: noindex, nofollow`) and never change once published (`Cache-Control: immutable`).

## What it does not protect

- Anyone with a link can read the page and share the link. There is no reader authentication and no private mode.
- An alias is enumerable. `<name>.<zone>` answers for any name you have set, so a stranger can find aliased pages by guessing; hash links stay unguessable. Aliases are opt-in and documented as such in [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).
- The operator can read every page in the bucket. On the hosted deployment that operator is the maintainer, and [the terms](https://handbill.dev/docs/terms/) enumerate what they can see and what is deliberately not kept.
- A page's own JavaScript is the page author's responsibility. Origin isolation stops it reading other pages and the API; it does not stop it making cross-origin requests or phishing the reader.

## How this repository is configured

Relevant if you are reading the source to decide whether to trust the package or the hosted deployment:

- Secret scanning and push protection are on, so a credential cannot be pushed here without being blocked at the point of push.
- Dependabot alerts and security updates are on; version updates arrive monthly under `.github/dependabot.yml`.
- `main` takes only pull requests, squash-merged from an up-to-date branch with CI green: typecheck, lint, test, and the Worker size budget.
- `v*` tags cannot be deleted or moved once pushed. A published npm version can never be replaced, so the tag it was built from stays put too.
- Releases publish through npm trusted publishing (OIDC), so no npm token exists in this repository to leak, and every release after 0.1.0 carries provenance.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (_Security_ → _Report a vulnerability_). Please do not open a public issue for security problems. You will get an acknowledgement within a few days; fixes ship as a patch release of the affected package.

## Reporting a page

A flaw in handbill is not the same thing as a page someone published with it. To report a page on `handbill.dev` — phishing, malware, spam, doxxing — mail `abuse@handbill.dev` with the URL and what is wrong with it: [how the report is handled](https://handbill.dev/docs/abuse/). Pages on someone else's deployment are that operator's to remove.

## Supported versions

The latest `0.x` release only.
