A deployment describes itself. The API lives at `https://api.<zone>/v1`, and two routes there need no token:

- **`/v1/openapi.json`** — the OpenAPI 3.1 document, generated from the contract the Worker implements and the CLI is built from, so it cannot describe an API the deployment does not serve. Point a client generator at it, or read it and write the calls by hand. On the maintainer's deployment: [api.handbill.dev/v1/openapi.json](https://api.handbill.dev/v1/openapi.json).
- **`/docs`** — the same document rendered as a browsable reference: [api.handbill.dev/docs](https://api.handbill.dev/docs).

Everything else takes `Authorization: Bearer <token>`:

| Call                        | What it does                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `PUT /v1/pages/<hash>`      | Publish. The body is the HTML; the server recomputes the hash and rejects a mismatch. |
| `GET /v1/pages`             | Everything published, newest first.                                                   |
| `DELETE /v1/pages/<hash>`   | Unpublish. Idempotent.                                                                |
| `PUT /v1/aliases/<name>`    | Point a name at a page (body `{"hash":"…"}`). Only with the `ALIASES` binding.        |
| `GET /v1/aliases`           | Every alias and the hash it points at.                                                |
| `DELETE /v1/aliases/<name>` | The name stops answering; the page stays.                                             |
| `GET /v1/health`            | `{"ok":true,"mode":"secret","zone":"<zone>"}`, no token needed.                       |

Errors are JSON with a `_tag`: `HashMismatch` (400), `Unauthorized` (401), `NotFound` (404), `TooLarge` (413). The contract is versioned under `/v1` and does not break inside a major version; published links never change.
