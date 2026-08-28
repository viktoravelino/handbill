#!/usr/bin/env bash
# Sets the board column of every issue a pull request closes, from the PR's
# review state on its current head commit:
#   any human "changes requested"              → In Review
#   a human approval of the head commit        → Ready to Merge
#   anything else (no review yet, only Copilot) → In Review
# Copilot's review is informational here: it never approves, and GitHub does not
# run workflows for its review events, so the maintainer's approval is the signal.
#
#   reconcile.sh <pr-number>...   specific PRs
#   reconcile.sh                  every open PR
set -euo pipefail

REPO=${REPO:-viktoravelino/handbill}
HERE=$(cd "$(dirname "$0")" && pwd)

target_for() { # <pr> → review|ready
  local pr=$1 head reviews
  head=$(gh api "repos/$REPO/pulls/$pr" --jq .head.sha)
  reviews=$(gh api "repos/$REPO/pulls/$pr/reviews?per_page=100")

  # Latest review per human (jq's group_by needs the input sorted by the key):
  # a "changes requested" stands until that reviewer re-reviews.
  if jq -e '[.[] | select(.user.type != "Bot")] | sort_by(.user.login) | group_by(.user.login) | map(max_by(.submitted_at)) | any(.state == "CHANGES_REQUESTED")' <<<"$reviews" >/dev/null; then
    echo review; return
  fi
  if jq -e --arg head "$head" '[.[] | select(.user.type != "Bot" and .state == "APPROVED" and .commit_id == $head)] | length > 0' <<<"$reviews" >/dev/null; then
    echo ready; return
  fi
  echo review
}

issues_for() { # <pr> → issue numbers the PR closes
  local owner=${REPO%/*} name=${REPO#*/}
  gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$p){ closingIssuesReferences(first:20){ nodes{ number } } } } }' \
    -f o="$owner" -f n="$name" -F p="$1" --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[].number'
}

prs=("$@")
[[ ${#prs[@]} -gt 0 ]] || mapfile -t prs < <(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[] | select(.draft | not) | .number')
board=$("$HERE/board.sh" show)   # one board read per run, not one per issue

for pr in "${prs[@]}"; do
  issues=$(issues_for "$pr")
  [[ -n $issues ]] || { echo "PR #$pr closes no issues"; continue; }
  target=$(target_for "$pr")
  for issue in $issues; do
    current=$(awk -F'\t' -v n="#$issue" '$2 == n { print $1 }' <<<"$board")
    want=$([[ $target == ready ]] && echo "Ready to Merge" || echo "In Review")
    if [[ $current == "$want" ]]; then echo "PR #$pr → #$issue already $want"; else "$HERE/board.sh" "$target" "$issue"; fi
  done
done
