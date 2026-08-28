# Releasing

The CLI is the only published artifact (`handbill` on npm). The Worker is deployed from a checkout, not released.

Publishing from CI uses npm **trusted publishing** (OIDC): no npm token anywhere, and provenance is attached automatically. Granular access tokens that bypass 2FA are deprecated and lose publishing rights in early 2027, so they are not used here.

## One-time setup

1. **The repository is public.** Provenance links the package to the public source and workflow run.
2. **Publish the first version by hand.** npm only lets you configure a trusted publisher on a package that already exists, so the very first version is published locally with your own account and 2FA:
   ```sh
   npm login                      # browser + 2FA
   bun install
   bun --cwd apps/cli run build
   cd apps/cli && npm publish --access public
   ```
   This version has no provenance attestation; every later one will.
3. **Configure the trusted publisher.** npmjs.com → the `handbill` package → *Settings* → *Trusted Publisher* → GitHub Actions:
   - Organization or user: `viktoravelino`
   - Repository: `handbill`
   - Workflow filename: `release.yml` (exact, case-sensitive)
   - Environment: leave empty
   - Allowed actions: `npm publish`
4. **Tag the version you just published** so the GitHub release exists too. The workflow sees it is already on npm, skips the publish, and creates the release:
   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```

## Every later release

1. Bump the version in **both** `apps/cli/package.json` and the `version` literal in `apps/cli/src/cli.ts`, on a branch, through a PR.
2. After it merges:
   ```sh
   git checkout main && git pull
   git tag v0.1.1
   git push origin v0.1.1
   ```
3. The `Release` workflow runs: typecheck, lint, test, tag-vs-version guard, build, `npm publish` via OIDC, GitHub release with generated notes.

The workflow refuses a tag whose version does not match `apps/cli/package.json`, and skips the publish step if that version is already on npm.

## If a release fails

- Before the publish step: fix on `main`, delete the tag locally and remotely (`git tag -d v0.1.1 && git push origin :refs/tags/v0.1.1`), tag again.
- After the publish step (for example the GitHub release step): do not re-tag; re-run the workflow — the publish is skipped and the release gets created — or `gh release create v0.1.1 --generate-notes`.
- npm never allows republishing a version; a fix after a successful publish is the next patch version.

## Why not staged publishing

npm's staged publishing (`npm stage publish` in CI, a human approves with 2FA) is the other supported path. With a single maintainer who is also the one pushing the tag, the tag is the approval; revisit if more people gain release rights.
