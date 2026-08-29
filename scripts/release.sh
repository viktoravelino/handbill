#!/usr/bin/env bash
# Releases the CLI in two moves, because main only takes PRs and the tag must land after them:
#
#   scripts/release.sh bump <version>   branch from main, set the version in apps/cli/package.json
#                                       and bun.lock, run the checks, commit, push, open the PR;
#                                       a -dev version (0.2.0-dev) names the release main is heading
#                                       toward, so nightlies carry it, and cannot be tagged
#   scripts/release.sh tag              after that PR merged: tag main as v<version> and push the
#                                       tag; the Release workflow publishes to npm and creates the
#                                       GitHub release
#
# DRY_RUN=1 (or true/yes) runs the checks and the build but prints the branch / commit / push /
# PR / tag steps instead of doing them, and leaves the tree as it found it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="$ROOT/apps/cli/package.json"
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
case ${DRY_RUN:-0} in 1 | true | yes) DRY=1 ;; *) DRY=0 ;; esac
run() { if [[ $DRY == 1 ]]; then echo "dry-run: $*"; else "$@"; fi; }
die() { echo "release: $*" >&2; exit 1; }

current_version() { node -p "require('$PKG').version"; }

require_clean_main() {
  [[ $(git -C "$ROOT" branch --show-current) == main ]] || die "run this from main"
  [[ -z $(git -C "$ROOT" status --porcelain) ]] || die "the working tree is not clean"
  git -C "$ROOT" fetch -q origin main
  [[ $(git -C "$ROOT" rev-parse HEAD) == $(git -C "$ROOT" rev-parse origin/main) ]] || die "main is not up to date with origin; git pull first"
}

bump() {
  local v=${1:-}; [[ -n $v ]] || die "usage: release.sh bump <version>"
  [[ $v =~ $SEMVER ]] || die "$v is not a semver version"
  require_clean_main
  [[ $v != $(current_version) ]] || die "apps/cli is already $v"
  git -C "$ROOT" rev-parse -q --verify "refs/tags/v$v" >/dev/null && die "tag v$v already exists"

  if [[ $DRY == 1 ]]; then
    # The version edits below are only there for the checks and the build. Put main back
    # however the script exits — a failing check must not leave a dirty tree behind.
    trap 'git -C "$ROOT" checkout -q -- apps/cli/package.json bun.lock; echo "dry-run: restored apps/cli/package.json and bun.lock; nothing was committed"' EXIT
  fi
  run git -C "$ROOT" checkout -q -b "release/$v"
  (cd "$ROOT/apps/cli" && npm pkg set version="$v")
  # bun does not rewrite a workspace's own version on install; set the lockfile entry directly.
  perl -0pi -e 's/("apps\/cli": \{\s*"name": "handbill",\s*"version": )"[^"]+"/$1"'"$v"'"/' "$ROOT/bun.lock"
  V="$v" perl -0ne 'exit(/"apps\/cli": \{\s*"name": "handbill",\s*"version": "\Q$ENV{V}\E"/ ? 0 : 1)' "$ROOT/bun.lock" \
    || die "could not set the apps/cli version in bun.lock"

  (cd "$ROOT" && bun install --frozen-lockfile >/dev/null && bun run typecheck && bun run lint && bun test >/dev/null)
  (cd "$ROOT" && bun run --cwd apps/cli build >/dev/null && node apps/cli/dist/cli.js --version)

  run git -C "$ROOT" add apps/cli/package.json bun.lock
  run git -C "$ROOT" commit -q -m "cli: $v"
  run git -C "$ROOT" push -q -u origin "release/$v"
  local body="/tmp/release-$v.md"
  printf 'Version bump to %s. Merge, then run `scripts/release.sh tag` to publish.\n' "$v" > "$body"
  run gh pr create --head "release/$v" --title "cli: $v" --body-file "$body"
}

tag() {
  require_clean_main
  local v; v=$(current_version); local t="v$v"
  [[ $v != *-dev ]] || die "$v is a development version; bump to the release version first"
  git -C "$ROOT" rev-parse -q --verify "refs/tags/$t" >/dev/null && die "$t already exists locally"
  [[ -z $(git -C "$ROOT" ls-remote --tags origin "refs/tags/$t") ]] || die "$t already exists on origin"
  npm view "handbill@$v" version >/dev/null 2>&1 && die "handbill@$v is already on npm; bump first"

  run git -C "$ROOT" tag "$t"
  run git -C "$ROOT" push -q origin "$t"
  if [[ $DRY == 1 ]]; then
    echo "dry-run: $t would be pushed and the Release workflow would publish handbill@$v"
  else
    echo "tagged $t — the Release workflow is publishing handbill@$v:"
    echo "  gh run list --workflow release.yml --limit 1"
  fi
}

case ${1:-} in
  bump) bump "${2:-}" ;;
  tag)  tag ;;
  *)    sed -n '2,10p' "$0"; exit 2 ;;
esac
