# apps/web

Astro + Starlight documentation site for handbill.

## TypeScript version

This package pins TypeScript 6.0.3 while the workspace root uses 7.0.2. TypeScript 7 cannot be used here yet because `astro check` relies on TypeScript's programmatic API, which TS 7's native compiler does not expose. Track progress at github.com/withastro/roadmap/discussions/1321.
