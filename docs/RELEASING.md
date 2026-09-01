# Releasing

The CLI is the only published artifact (`handbill` on npm). The Worker is deployed from a checkout, not released.

Publishing from CI uses npm **trusted publishing** (OIDC): no npm token anywhere, and provenance is attached automatically. Granular access tokens that bypass 2FA are deprecated and lose publishing rights in early 2027, so they are not used here.

## One-time setup

1. **The repository is public.** Provenance links the package to the public source and workflow run.
2. **Publish the first version by hand.** npm only lets you configure a trusted publisher on a package that already exists, so the very first version is published locally with your own account and 2FA:
   ```sh
   npm login                      # browser + 2FA
   bun install
   bun run --cwd apps/cli build
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

Two commands, with the maintainer's merge in between:

```sh
scripts/release.sh bump 0.1.2   # branch, set the version, run the checks, open the PR
# … merge the PR …
scripts/release.sh tag          # tag main as v0.1.2 and push it
```

`bump` refuses a release version while `CLIENT_ID` in `apps/cli/src/github.ts` is still the placeholder — a `handbill login` against an OAuth app that does not exist cannot work, and a release is the point past which that is no longer fixable in a branch. Create the app (GitHub → *Settings* → *Developer settings* → *OAuth Apps*, with **device flow enabled**) and set the constant; the client id is public and has no secret, so it belongs in the source. `-dev` versions are never published and are allowed to carry the placeholder.

`bump` is the only thing that edits a version: `apps/cli/package.json` is the source of truth (the CLI's `--version` reads it at build time) and the script mirrors it into the `apps/cli` entry of `bun.lock`, which bun does not rewrite on its own. `tag` refuses to run off `main`, with a dirty tree, behind origin, if the tag exists, if that version is already on npm, or if it is a `-dev` version. `DRY_RUN=1` in front of either command runs the checks and the build but prints the branch, commit, push, PR and tag steps instead of doing them, and leaves the tree as it found it.

When `main` starts carrying the next minor's features, say so with a `-dev` version, so nightlies name the release they lead up to instead of the next patch:

```sh
scripts/release.sh bump 0.2.0-dev   # main is heading toward 0.2.0; nightlies become 0.2.0-nightly.…
```

A `-dev` version is never published: `tag` and the workflow both refuse it, and the release is the same two commands as always (`bump 0.2.0`, merge, `tag`). Leaving `main` on a release version is fine too — nightlies then take the next patch, which is right while only fixes are landing.

The `Release` workflow then runs: `scripts/release-version.sh` (the tag-vs-version guard, and the dist-tag), typecheck, lint, test, build, `npm publish` via OIDC, GitHub release with generated notes.

The workflow refuses a tag whose version does not match `apps/cli/package.json`, and skips the publish step if that version is already on npm. A prerelease version (anything with a `-`, such as `0.2.0-rc.0`) is published under the `next` dist-tag and its GitHub release is marked as a prerelease, so `latest` and plain `npx handbill` are untouched. To rehearse the pipeline without a version at all, use the nightly dry run below.

## Nightly

The same workflow runs every day at 05:00 UTC and publishes `main` under the `nightly` dist-tag, so a merged feature is installable before it is released:

```sh
npx handbill@nightly --version   # <next>-nightly.202608290500.g86df0a5
npm i -g handbill@nightly
```

The version is the release `main` is heading toward — the `-dev` version of `apps/cli/package.json` without its suffix, or the next patch of a release version — then the UTC date and time, and the commit (`g` + short sha, as `git describe` writes it) — a prerelease, so `latest` and `next` are never touched and nothing resolves to a nightly unless asked for by tag. It is set in the CI checkout only; `main` keeps the real version and `bump` remains the only thing that edits it. When `main` has not moved since the last nightly (the commit is already in `handbill@nightly`'s version) the job publishes nothing. Nightlies get no GitHub release; the commit in the version is the changelog.

Run one by hand, or rehearse without publishing:

```sh
gh workflow run release.yml                   # publish a nightly now
gh workflow run release.yml -f dry_run=true   # build and `npm publish --dry-run` only
scripts/release-version.sh                    # locally: the version the next run would publish
```

A manual run publishes `main` only. Dispatching from another ref (`--ref my-branch`) is refused unless it is a dry run, so a branch cannot end up behind the `nightly` tag.

To pull a nightly back: `npm dist-tag rm handbill nightly` removes the tag, `npm deprecate handbill@<version> "<why>"` marks the version; npm does not allow unpublishing after 72 hours.

## If a release fails

- Before the publish step: fix on `main`, delete the tag locally and remotely (`git tag -d v0.1.1 && git push origin :refs/tags/v0.1.1`), tag again.
- After the publish step (for example the GitHub release step): do not re-tag; re-run the workflow — the publish is skipped and the release gets created — or `gh release create v0.1.1 --generate-notes`.
- npm never allows republishing a version; a fix after a successful publish is the next patch version.

## Why not staged publishing

npm's staged publishing (`npm stage publish` in CI, a human approves with 2FA) is the other supported path. With a single maintainer who is also the one pushing the tag, the tag is the approval; revisit if more people gain release rights. Nightlies publish with no human in the loop, which is fine for the same reason it is fine for `next`: they never touch `latest`.
