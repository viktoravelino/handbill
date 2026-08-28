# Security

## Threat model, in three sentences

A published page is public to anyone holding its link; the link is unguessable (48 bits of content hash) and served with `noindex`, but it is not secret and it is not encrypted. Writing — publishing and unpublishing — requires the bearer token, which only the deployment's operator holds; a missing or wrong token fails closed. The Worker serves bytes exactly as stored and never executes them, but a page is a full HTML document on its own origin, so it can run its own scripts against its own origin and nothing else.

## What handbill protects

- Nobody can publish, list, or delete without the token.
- A link cannot be forged: the server recomputes the hash of the bytes it receives and rejects a mismatch.
- Pages are isolated from each other and from the API by hostname (one origin per document).
- Pages are not indexed (`X-Robots-Tag: noindex, nofollow`) and never change once published (`Cache-Control: immutable`).

## What it does not protect

- Anyone with a link can read the page and share the link. There is no reader authentication and no private mode.
- The operator can read every page in the bucket.
- A page's own JavaScript is the page author's responsibility.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (_Security_ → _Report a vulnerability_). Please do not open a public issue for security problems. You will get an acknowledgement within a few days; fixes ship as a patch release of the affected package.

## Supported versions

The latest `0.x` release only.
