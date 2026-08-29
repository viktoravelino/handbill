import type { Link, Root, RootContent } from "mdast"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { routeFor } from "./docs"

const REPO = fileURLToPath(new URL("../../..", import.meta.url))
const GITHUB = "https://github.com/viktoravelino/handbill/blob/main/"

/** Every link in the tree, links inside links notwithstanding. */
const links = (node: Root | RootContent): ReadonlyArray<Link> =>
  node.type === "link" ? [node] : "children" in node ? node.children.flatMap(links) : []

/**
 * The markdown on this site was written to be read on GitHub. Two things differ
 * here: a page has its own title, so the file's `# heading` goes; and a
 * relative link — `docs/SELF-HOSTING.md`, `LICENSE` — has to point at the page
 * that serves that file, or at the file on GitHub when no page does. Absolute
 * URLs and `#anchors` pass through; heading ids are GitHub's, so anchors
 * survive the move.
 */
export const repoDocs = () => (tree: Root, file: { readonly path?: string | undefined }) => {
  const [first] = tree.children
  if (first?.type === "heading" && first.depth === 1) tree.children.shift()
  if (file.path === undefined) return
  for (const link of links(tree)) {
    if (/^[a-z][a-z0-9+.-]*:|^[#/]/iu.test(link.url)) continue
    const [target = "", anchor] = link.url.split("#")
    const path = relative(REPO, resolve(dirname(file.path), target))
    link.url = (routeFor(path) ?? GITHUB + path) + (anchor === undefined ? "" : `#${anchor}`)
  }
}
