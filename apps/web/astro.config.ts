import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import { summary } from "./src/docs"
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
      description: summary,
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/viktoravelino/handbill" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/handbill" }
      ],
      customCss: ["./src/styles.css"],
      // The only component override: Starlight's footer, plus a row of site-wide
      // links (terms, abuse, security) that has to be on every page.
      components: { Footer: "./src/components/Footer.astro" },
      // Cloudflare Web Analytics and a self-hosted Umami, side by side, on this
      // site only — never on published pages. The Cloudflare token and the Umami
      // website id are public identifiers, not secrets. Umami's data-domains makes
      // the tracker send only from handbill.dev, so local and preview builds stay
      // silent. data-exclude-hash keeps every fragment out of what Umami records,
      // which is what guarantees the `#key=` of the account page's URL is never
      // reported, whatever order its scripts run in; data-do-not-track honours the
      // browser's Do Not Track setting. The og:image is public/og.png, rendered
      // once by hand; scrapers need an absolute URL.
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
          tag: "script",
          attrs: {
            defer: true,
            src: "https://analytics.vkav.dev/script.js",
            "data-website-id": "f1ed741f-310f-463a-af48-10626612c3c4",
            "data-domains": "handbill.dev",
            "data-exclude-hash": "true",
            "data-do-not-track": "true"
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
