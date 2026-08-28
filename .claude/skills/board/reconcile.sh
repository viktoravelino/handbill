#!/usr/bin/env bash
# Sets the board column of every issue a pull request closes, from the PR's
# review state on its current head commit:
#   any human "changes requested"            → In Review
#   human approval, or a clean Copilot review → Ready to Merge
#   anything else (no review yet, findings)  → In Review
# A Copilot review is clean when it is on the head commit, has no inline
# comments, and its summary does not say "Changes recommended" (Copilot's body
# is never empty; that header is how it flags findings, including suppressed ones).
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

  # Latest review per human, on any commit: a "changes requested" stands until they re-review.
  if jq -e '[.[] | select(.user.type != "Bot")] | group_by(.user.login) | map(max_by(.submitted_at)) | any(.state == "CHANGES_REQUESTED")' <<<"$reviews" >/dev/null; then
    echo review; return
  fi
  if jq -e --arg head "$head" '[.[] | select(.user.type != "Bot" and .state == "APPROVED" and .commit_id == $head)] | length > 0' <<<"$reviews" >/dev/null; then
    echo ready; return
  fi

  local copilot id body comments
  copilot=$(jq -c --arg head "$head" '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" and .commit_id == $head)] | max_by(.submitted_at) // empty' <<<"$reviews")
  [[ -n $copilot ]] || { echo review; return; }
  id=$(jq -r .id <<<"$copilot"); body=$(jq -r '.body // ""' <<<"$copilot")
  comments=$(gh api "repos/$REPO/pulls/$pr/reviews/$id/comments" --jq length)
  if [[ $comments == 0 ]] && ! grep -qi "changes recommended" <<<"$body"; then echo ready; else echo review; fi
}

issues_for() { # <pr> → issue numbers the PR closes
  local owner=${REPO%/*} name=${REPO#*/}
  gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$p){ closingIssuesReferences(first:20){ nodes{ number } } } } }' \
    -f o="$owner" -f n="$name" -F p="$1" --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[].number'
}

prs=("$@")
[[ ${#prs[@]} -gt 0 ]] || mapfile -t prs < <(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[] | select(.draft | not) | .number')

for pr in "${prs[@]}"; do
  issues=$(issues_for "$pr")
  [[ -n $issues ]] || { echo "PR #$pr closes no issues"; continue; }
  target=$(target_for "$pr")
  for issue in $issues; do
    current=$("$HERE/board.sh" show | awk -F'\t' -v n="#$issue" '$2 == n { print $1 }')
    want=$([[ $target == ready ]] && echo "Ready to Merge" || echo "In Review")
    if [[ $current == "$want" ]]; then echo "PR #$pr → #$issue already $want"; else "$HERE/board.sh" "$target" "$issue"; fi
  done
done
