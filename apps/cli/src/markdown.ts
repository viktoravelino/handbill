import { basename, extname } from "node:path"
import { Lexer, Parser, TextRenderer, type Token, type Tokens } from "marked"
import { stylesheet } from "./stylesheet"

const EXTENSIONS = new Set([".md", ".markdown"])

/**
 * Whether the publish argument names a markdown file. Standard input (`-`) has
 * no extension to read, so `--markdown` is the only way to say so for it.
 */
export const isMarkdownFile = (file: string): boolean => EXTENSIONS.has(extname(file).toLowerCase())

const ESCAPED: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}

/** Exactly the five entities the Worker's `extractTitle` decodes, so a title survives the round trip. */
const escape = (text: string): string => text.replaceAll(/[&<>"']/gu, (char) => ESCAPED[char]!)

const isTitleHeading = (token: Token): token is Tokens.Heading =>
  token.type === "heading" && token.depth === 1

/**
 * The heading's text without its inline markup: `# The **plan**` titles the page
 * "The plan", not "The \*\*plan\*\*". `TextRenderer` is marked's own renderer for
 * exactly this, so the rules stay marked's rather than a regex of ours.
 */
const headingText = (heading: Tokens.Heading): string =>
  new Parser().parseInline(heading.tokens, new TextRenderer()).trim()

/**
 * The page's title: the first H1, else the file's name without its extension.
 * Empty when neither exists — stdin with no heading — which is what an HTML
 * document with no `<title>` already means to `handbill list`.
 */
const documentTitle = (tokens: ReadonlyArray<Token>, file: string): string => {
  const heading = tokens.find((token) => isTitleHeading(token))
  if (heading !== undefined) return headingText(heading)
  return file === "-" ? "" : basename(file, extname(file))
}

/**
 * A markdown source rendered to one self-contained HTML document, ready to hash
 * and publish. Raw HTML in the source is passed through as written: the author
 * is publishing their own document, and stripping it would break the embeds
 * markdown cannot express.
 */
export const render = (source: string, file: string): string => {
  const tokens = new Lexer().lex(source)
  const title = documentTitle(tokens, file)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${title === "" ? "" : `<title>${escape(title)}</title>\n`}<style>
${stylesheet}
</style>
</head>
<body>
<main>
${new Parser().parse(tokens)}</main>
</body>
</html>
`
}
