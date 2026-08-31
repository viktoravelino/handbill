import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import { repoDocs } from "./src/remark"

/**
 * handbill.dev: a landing page and the docs, static, content only. Every page
 * is a markdown file the repository already has (README, docs/, the skill),
 * rendered through Starlight — see src/docs.ts for which, and src/remark.ts for
 * how a file written for GitHub reads on the site.
 */
export default defineConfig({
  site: "https://handbill.dev",
  redirects: { "/docs": "/docs/self-hosting/" },
  markdown: { processor: unified({ remarkPlugins: [repoDocs] }) },
  integrations: [
    starlight({
      title: "handbill",
      description:
        "Hand someone a page: one self-contained HTML file, or a markdown file, at an unguessable, immutable URL on a domain you own.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/viktoravelino/handbill" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/handbill" }
      ],
      customCss: ["./src/styles.css"],
      // Cloudflare Web Analytics, on this site only — never on published pages.
      // The token is the zone's public beacon token, not a secret. The og:image
      // is public/og.png, rendered once by hand; scrapers need an absolute URL.
      head: [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: "https://static.cloudflareinsights.com/beacon.min.js",
            "data-cf-beacon": '{"token": "807ccc184fed485aad2f4bda825554ea"}'
          }
        },
        {
          tag: "meta",
          attrs: { property: "og:image", content: "https://handbill.dev/og.png" }
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "handbill — Hand someone a page."
          }
        },
        {
          tag: "meta",
          attrs: { name: "twitter:image", content: "https://handbill.dev/og.png" }
        }
      ],
      // The sidebar comes from src/docs.ts on each docs page; there is no docs
      // collection to generate one from.
      pagination: false
    })
  ]
})
