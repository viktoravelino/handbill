import type { APIRoute } from "astro"
import { docs, summary } from "../docs"

/**
 * /llms.txt — the llmstxt.org map of this site for an agent that arrives at the
 * domain with nothing but the hostname. The page list comes from src/docs.ts,
 * the same array the sidebar and the docs routes come from, so it cannot drift;
 * every URL is absolute, because whoever fetched this file has nothing to
 * resolve a relative one against.
 */
export const GET: APIRoute = ({ site }) => {
  const url = (path: string) => new URL(path, site).href
  const body = `# handbill

> ${summary}

The URL is the content hash of the file, so a link is immutable and unguessable, and it lives on a Cloudflare Worker and an R2 bucket in your own account. The CLI is \`npm i -g handbill\`; it ships an agent skill so a coding agent can end a task with a link instead of a file.

## Docs

- [handbill](${url("/")}): The README — what it is, how to install it, and every command in one table, with a self-hosting walkthrough behind it.
${docs.map((doc) => `- [${doc.title}](${url(`/docs/${doc.slug}/`)}): ${doc.description}`).join("\n")}

## Optional

- [Source on GitHub](https://github.com/viktoravelino/handbill): The Worker, the CLI, and the markdown these pages are rendered from.
- [handbill on npm](https://www.npmjs.com/package/handbill): The published CLI.
`

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}
