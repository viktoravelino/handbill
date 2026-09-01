A deployment describes itself. The API lives at `https://api.<zone>`, versioned under `/v1`, and three routes need no token:

- **`/v1/health`** — `{"ok":true,"mode":"secret","zone":"<zone>"}`; what `handbill doctor` probes.
- **`/v1/openapi.json`** — the OpenAPI 3.1 document, generated from the contract the Worker implements and the CLI is built from, so it cannot describe an API the deployment does not serve. Point a client generator at it, or read it and write the calls by hand. On the maintainer's deployment: [api.handbill.dev/v1/openapi.json](https://api.handbill.dev/v1/openapi.json).
- **`/docs`** — at the host root, not under `/v1`: the same document rendered as a browsable reference, [api.handbill.dev/docs](https://api.handbill.dev/docs).

Everything else takes `Authorization: Bearer <token>`:

| Call                        | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `PUT /v1/pages/<hash>`      | Publish. The body is the HTML; the server recomputes the hash and rejects a mismatch.      |
| `GET /v1/pages`             | Everything published, newest first.                                                        |
| `DELETE /v1/pages/<hash>`   | Unpublish. Idempotent.                                                                     |
| `PUT /v1/aliases/<name>`    | Point a name at a page (body `{"hash":"…"}`). Only with the `ALIASES` binding.             |
| `GET /v1/aliases`           | Every alias and the hash it points at. A key listing, so a fresh name can lag by a minute. |
| `GET /v1/aliases/<name>`    | What one name points at, read by key rather than out of that listing. 404 when unset.      |
| `DELETE /v1/aliases/<name>` | The name stops answering; the page stays.                                                  |
| `DELETE /v1/keys/current`   | Revoke the key in the request's own header. Idempotent. Only with the `ACCOUNTS` binding.  |

One route is neither public nor bearer-authed: **`POST /v1/keys`** takes `{"githubToken":"…"}`, verifies it with GitHub, and returns a key to use as the bearer token from then on — shown once, stored only as its SHA-256. It exists only on a deployment with the `ACCOUNTS` binding, which is also what makes `/v1/health` report `"mode":"accounts"`; without it the key routes answer 404 and one shared `PUBLISH_TOKEN` is the token.

Two things the `ACCOUNTS` binding changes are worth stating plainly. **Revocation is idempotent but not instant:** `DELETE /v1/keys/current` returns 204 whether the key was live, already revoked, or never existed, and it revokes only the key in that request's own header — but the key keeps working for up to a minute afterwards, because key records are read through KV's edge cache (the same ~60s window the alias listing has). **Aliases are operator-only in accounts mode:** with keys in play, every `/v1/aliases` route except the owner-filtered listing answers a normal key with 404, so hosted users get hash URLs and only the operator's own token manages names.

Errors are JSON with a `_tag`: `HashMismatch` (400), `Unauthorized` (401), `NotFound` (404), `TooLarge` (413). The contract is versioned under `/v1` and does not break inside a major version; published links never change.
