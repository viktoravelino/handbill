#!/usr/bin/env bash
# Decides what the Release workflow publishes, as GITHUB_OUTPUT lines on stdout:
#
#   version=…    the version to build and publish
#   dist_tag=…   latest | next | nightly
#   release=…    true when a GitHub release should be created
#   skip=true    (nightly only) main has not moved since the last nightly; publish nothing
#
# A tag push (GITHUB_EVENT_NAME=push) is a release: the tag must match apps/cli/package.json,
# prereleases go to `next`. Anything else is a nightly: the next patch of the current version,
# the UTC date and time, and the commit, e.g. 0.1.2-nightly.202608290500.g86df0a5 — the time so
# two nightlies from one day sort by age, the `g` (git-describe style) because a short sha that
# is all digits with a leading zero would be an invalid semver numeric identifier bare. The
# nightly version is set in the CI checkout only and never committed; scripts/release.sh bump
# stays the one thing that edits a version in git.
#
# Runs locally too — with no GITHUB_EVENT_NAME it takes the nightly path:
#   scripts/release-version.sh
#   GITHUB_EVENT_NAME=push GITHUB_REF_NAME=v0.1.1 scripts/release-version.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="$ROOT/apps/cli/package.json"
die() { echo "release-version: $*" >&2; exit 1; }

pkg=$(node -p "require('$PKG').version")

if [[ ${GITHUB_EVENT_NAME:-} == push ]]; then
  ref=${GITHUB_REF_NAME:-}
  [[ $ref == v* ]] || die "expected a v* tag, got '$ref'"
  [[ ${ref#v} == "$pkg" ]] || die "tag $ref does not match apps/cli version $pkg"
  tag=latest; [[ $pkg == *-* ]] && tag=next
  echo "version=$pkg"
  echo "dist_tag=$tag"
  echo "release=true"
  exit 0
fi

commit=g$(git -C "$ROOT" rev-parse --short=7 HEAD)
last=$(npm view handbill@nightly version 2>/dev/null || true)
if [[ -n $last && $last == *".$commit" ]]; then
  echo "handbill@nightly is already $last; main has not moved" >&2
  echo "skip=true"
  exit 0
fi

IFS=. read -r major minor patch <<<"${pkg%%-*}"
echo "version=$major.$minor.$((patch + 1))-nightly.$(date -u +%Y%m%d%H%M).$commit"
echo "dist_tag=nightly"
echo "release=false"
