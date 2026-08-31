/**
 * The docs section: one page per markdown file the repository already has, so
 * the site and GitHub cannot disagree. `path` is the file, relative to the
 * repository root; `slug` is where it is served, `/docs/<slug>/`. Two of the
 * files are the site's own: `api.md` is written here, and `cli.md` is generated
 * from `handbill --help` by scripts/cli-reference.ts before every build.
 * `description` becomes the page's meta description — its search snippet.
 */
export const docs = [
  {
    slug: "self-hosting",
    title: "Self-hosting",
    path: "docs/SELF-HOSTING.md",
    description:
      "Run handbill on your own Cloudflare account: one Worker, one R2 bucket, two DNS records. About ten minutes; free tier for personal use."
  },
  {
    slug: "cli",
    title: "CLI reference",
    path: "apps/web/src/generated/cli.md",
    description:
      "Every handbill command's --help, generated from the CLI at build time. Success prints exactly one line — the URL — or one JSON object with --json."
  },
  {
    slug: "api",
    title: "HTTP API",
    path: "apps/web/src/docs/api.md",
    description:
      "The handbill HTTP API at api.<zone>/v1: health, an OpenAPI 3.1 document generated from the contract, and token-guarded publish, list, and remove."
  },
  {
    slug: "skill",
    title: "Agent skill",
    path: "skills/handbill/SKILL.md",
    description:
      "An agent skill that teaches Claude and other coding agents to publish a self-contained HTML or markdown page to an unguessable URL with the handbill CLI."
  },
  {
    slug: "security",
    title: "Security",
    path: "SECURITY.md",
    description:
      "handbill's threat model in three sentences: unguessable noindex links, a bearer token that fails closed, per-page origins — and what living names trade away."
  },
  {
    slug: "releasing",
    title: "Releasing",
    path: "docs/RELEASING.md",
    description:
      "How the handbill CLI ships to npm from CI with trusted publishing and provenance. The Worker deploys from a checkout, not a release."
  }
] as const

export type Doc = (typeof docs)[number]

/** Where a repository file is served on the site, if it is: the README is the landing page. */
export const routeFor = (path: string): string | undefined => {
  if (path === "README.md") return "/"
  const doc = docs.find((entry) => entry.path === path)
  return doc && `/docs/${doc.slug}/`
}

/** The sidebar every docs page shows: the pages above, in that order. */
export const sidebar = [
  {
    label: "Docs",
    items: docs.map(({ title, slug }) => ({ label: title, link: `/docs/${slug}/` }))
  }
]
