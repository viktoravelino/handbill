/**
 * The docs section: one page per markdown file the repository already has, so
 * the site and GitHub cannot disagree. `path` is the file, relative to the
 * repository root; `slug` is where it is served, `/docs/<slug>/`. Two of the
 * files are the site's own: `api.md` is written here, and `cli.md` is generated
 * from `handbill --help` by scripts/cli-reference.ts before every build.
 */
export const docs = [
  { slug: "self-hosting", title: "Self-hosting", path: "docs/SELF-HOSTING.md" },
  { slug: "cli", title: "CLI reference", path: "apps/web/src/generated/cli.md" },
  { slug: "api", title: "API", path: "apps/web/src/docs/api.md" },
  { slug: "skill", title: "Agent skill", path: "skills/handbill/SKILL.md" },
  { slug: "security", title: "Security", path: "SECURITY.md" },
  { slug: "releasing", title: "Releasing", path: "docs/RELEASING.md" }
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
