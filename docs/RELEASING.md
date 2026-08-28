# Releasing

The CLI is the only published artifact (`handbill` on npm). The Worker is deployed from a checkout, not released.

## Every release

1. Bump the version in **both** `apps/cli/package.json` and the `version` literal in `apps/cli/src/cli.ts`, on a branch, through a PR.
2. After it merges, tag `main` and push the tag:
   ```sh
   git checkout main && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. The `Release` workflow runs: typecheck, lint, test, checks the tag matches the package version, builds `dist/cli.js`, publishes to npm with provenance, and creates the GitHub release with generated notes.

The workflow refuses a tag whose version does not match `apps/cli/package.json`.

## One-time setup before the first release

- **The repository must be public.** npm provenance links the package to the public source and the public workflow run; it cannot be generated for a private repo.
- **npm credentials for the workflow**, one of:
  - `NPM_TOKEN` repository secret: on npmjs.com create a *Granular Access Token* with *Read and write* on packages, allowed to *bypass 2FA*, and add it with `gh secret set NPM_TOKEN -R viktoravelino/handbill`.
  - Trusted publishing (no token): available once the package exists on npm. Package settings → *Trusted Publisher* → GitHub Actions, repository `viktoravelino/handbill`, workflow `release.yml`. Then remove `NPM_TOKEN`.
- The package name `handbill` must be free on npm at publish time (it was on 2026-08-28).

## If a release fails

The tag already exists; fix the cause on `main`, delete the tag locally and remotely (`git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0`), and tag again. npm does not allow republishing a version that already went out — bump to the next patch instead.
