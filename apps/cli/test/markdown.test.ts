import { describe, expect, test } from "bun:test"
import { isMarkdownFile, render } from "../src/markdown"
import { stylesheet } from "../src/stylesheet"

/** The `<title>` of a rendered page, as the Worker's `extractTitle` would read it. */
const titleOf = (html: string) => /<title>([\s\S]*?)<\/title>/u.exec(html)?.[1]

describe("isMarkdownFile", () => {
  test.each([
    ["notes.md", true],
    ["NOTES.MARKDOWN", true],
    ["plan.html", false],
    // Stdin says so with `--markdown`; there is no extension to go on.
    ["-", false]
  ])("%p is markdown: %p", (file, expected) => {
    expect(isMarkdownFile(file)).toBe(expected)
  })
})

describe("title", () => {
  test("comes from the first H1", () => {
    expect(titleOf(render("# Quarter plan\n\n# Later\n", "/tmp/notes.md"))).toBe("Quarter plan")
  })

  test("is the H1's text, not its markup", () => {
    expect(titleOf(render("# The **real** `plan`\n", "/tmp/notes.md"))).toBe("The real plan")
  })

  // The Worker decodes these five entities back, so the title it stores for
  // `handbill list` is the one the heading actually said.
  test("escapes what the Worker decodes", () => {
    expect(titleOf(render("# Plan & <review>\n", "/tmp/notes.md"))).toBe(
      "Plan &amp; &lt;review&gt;"
    )
  })

  test("falls back to the filename without its extension", () => {
    expect(titleOf(render("no heading here\n", "/tmp/Weekly notes.markdown"))).toBe("Weekly notes")
  })

  // An untitled document is a document with no `<title>`, which is what an HTML
  // file with none already means to the Worker and to `handbill list`.
  test("is absent for stdin with no H1", () => {
    expect(titleOf(render("no heading here\n", "-"))).toBeUndefined()
  })
})

/** The document with its stylesheet elided: the CSS is reviewed in `stylesheet.ts`, not in a snapshot. */
const shape = (html: string) => html.replace(stylesheet, "/* stylesheet */")

describe("render", () => {
  test("makes one self-contained page", () => {
    expect(
      shape(
        render(
          [
            "# Release plan",
            "",
            "Ship **on Friday**, see [the notes](https://example.dev).",
            "",
            "| Step | Owner |",
            "| ---- | ----- |",
            "| Cut  | Ada   |",
            "",
            "- [x] branch cut",
            "- [ ] tag",
            "",
            "```sh",
            "bun test",
            "```",
            "",
            "> Nothing ships on a Friday.",
            ""
          ].join("\n"),
          "/tmp/release.md"
        )
      )
    ).toMatchSnapshot()
  })

  test("asks nothing of the network", () => {
    const html = render("# Plan\n\ntext\n", "/tmp/notes.md")
    expect(html).toContain("prefers-color-scheme")
    expect(html).not.toContain("<link")
    expect(html).not.toContain("<script")
  })

  // The author is publishing their own document; stripping raw HTML would take
  // away the embeds markdown cannot express.
  test("passes raw HTML through", () => {
    expect(
      render("# Plan\n\n<details><summary>more</summary>hi</details>\n", "/tmp/n.md")
    ).toContain("<details><summary>more</summary>hi</details>")
  })
})
