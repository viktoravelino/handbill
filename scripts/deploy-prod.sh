#!/usr/bin/env bash
# Deploys the Worker to production, gated on a release tag: HEAD must be exactly
# `v<version>` — matching apps/worker/package.json's version — and that tag must
# already be on origin/main, so a deploy always ships something the maintainer
# merged, never a branch in progress.
#
#   scripts/deploy-prod.sh [wrangler args…]   deploy HEAD, refusing a dirty tree,
#                                              an untagged commit, or an unmerged tag
#   scripts/deploy-prod.sh --force […]        skip every check above for a hotfix or
#                                              the kill-switch drill and nothing else;
#                                              VERSION is whatever
#                                              apps/worker/package.json says
#
# Extra arguments (for example --dry-run) pass straight through to `wrangler deploy`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKER="$ROOT/apps/worker"
WRANGLER="$WORKER/node_modules/.bin/wrangler"
die() { echo "deploy-prod: $*" >&2; exit 1; }

FORCE=0
ARGS=()
for arg in "$@"; do
  if [[ $arg == --force ]]; then
    FORCE=1
  else
    ARGS+=("$arg")
  fi
done

PKG_VERSION=$(node -p "require('$WORKER/package.json').version")

if [[ $FORCE == 1 ]]; then
  COMMIT=$(git -C "$ROOT" rev-parse --short HEAD)
  DIRTY=""
  [[ -z $(git -C "$ROOT" status --porcelain) ]] || DIRTY=", working tree dirty"
  echo "deploy-prod: --force: deploying $COMMIT (untagged$DIRTY) to production" >&2
  VERSION=$PKG_VERSION
else
  [[ -z $(git -C "$ROOT" status --porcelain) ]] || die "the working tree is not clean"
  TAG=$(git -C "$ROOT" describe --exact-match --tags HEAD 2>/dev/null) \
    || die "HEAD is not a release tag; check out a tag matching v[0-9]* or pass --force for a hotfix"
  [[ $TAG =~ ^v[0-9] ]] || die "HEAD's tag ($TAG) does not match v[0-9]*; check out a release tag or pass --force for a hotfix"
  git -C "$ROOT" fetch -q origin
  git -C "$ROOT" merge-base --is-ancestor HEAD origin/main \
    || die "$TAG is not reachable from origin/main; merge it first or pass --force for a hotfix"
  VERSION=${TAG#v}
  [[ $VERSION == "$PKG_VERSION" ]] || die "$TAG does not match apps/worker/package.json's version ($PKG_VERSION)"
fi

BUILD=$(git -C "$ROOT" rev-parse --short HEAD)

cd "$WORKER"
exec "$WRANGLER" deploy --config wrangler.production.jsonc \
  --var "VERSION:$VERSION" --var "BUILD:$BUILD" ${ARGS[@]+"${ARGS[@]}"}
