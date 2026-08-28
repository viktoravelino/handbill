# Security

## Threat model, in three sentences

A published page is public to anyone holding its link; the link is unguessable (48 bits of content hash) and served with `noindex`, but it is not secret and it is not encrypted. Writing — publishing and unpublishing — requires the bearer token, which only the deployment's operator holds; a missing or wrong token fails closed. The Worker serves bytes exactly as stored and never executes them, but a page is a full HTML document that runs in the reader's browser with everything any web page can do — call remote servers, load remote code, show whatever it likes — so publish only pages you trust; what the per-page origin guarantees is that a page cannot read another page's storage, cookies, or content, nor the API's.

## What handbill protects

- Nobody can publish, list, or delete without the token.
- A link cannot be forged: the server recomputes the hash of the bytes it receives and rejects a mismatch.
- Pages are isolated from each other and from the API by hostname (one origin per document).
- Pages are not indexed (`X-Robots-Tag: noindex, nofollow`) and never change once published (`Cache-Control: immutable`).

## What it does not protect

- Anyone with a link can read the page and share the link. There is no reader authentication and no private mode.
- The operator can read every page in the bucket.
- A page's own JavaScript is the page author's responsibility. Origin isolation stops it reading other pages and the API; it does not stop it making cross-origin requests or phishing the reader.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (_Security_ → _Report a vulnerability_). Please do not open a public issue for security problems. You will get an acknowledgement within a few days; fixes ship as a patch release of the affected package.

## Supported versions

The latest `0.x` release only.
