/**
 * The whole design of a rendered markdown page, inlined into every document the
 * CLI produces. A published page makes no request of its own — no font, no
 * script, no stylesheet — so this is the only styling it will ever get.
 * `color-scheme` plus one media query is what makes it readable in both themes;
 * everything else reads the variables those two set.
 */
export const stylesheet = `*,::before,::after{box-sizing:border-box}
:root{color-scheme:light dark;--bg:#fdfdfc;--fg:#22201d;--muted:#6b665f;--rule:#e5e1da;--soft:#f4f1ec;--link:#0b5cad}
@media(prefers-color-scheme:dark){:root{--bg:#191817;--fg:#e8e5e0;--muted:#a09a92;--rule:#332f2b;--soft:#232120;--link:#8ab6f0}}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-wrap:pretty}
main{max-width:44rem;margin:0 auto;padding:3rem 1.25rem 6rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2.5rem 0 1rem;text-wrap:balance}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.5rem;padding-bottom:.3rem;border-bottom:1px solid var(--rule)}
h3{font-size:1.25rem}
h4,h5,h6{font-size:1rem}
p,ul,ol,blockquote,pre,table,figure{margin:0 0 1.25rem}
a{color:var(--link)}
ul,ol{padding-left:1.5rem}
li{margin:.25rem 0}
li::marker{color:var(--muted)}
blockquote{padding-left:1rem;border-left:3px solid var(--rule);color:var(--muted)}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
code{background:var(--soft);padding:.15em .35em;border-radius:4px}
pre{background:var(--soft);padding:1rem;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0}
hr{height:1px;margin:2.5rem 0;background:var(--rule);border:0}
table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow-x:auto}
th,td{padding:.5rem .75rem;border:1px solid var(--rule);text-align:left}
thead th{background:var(--soft)}
img{max-width:100%;height:auto}
li:has(>input[type=checkbox]){list-style:none;margin-left:-1.15rem}
input[type=checkbox]{margin-right:.4em}
@media print{body{background:#fff;color:#000}main{max-width:none;padding:0}}`
