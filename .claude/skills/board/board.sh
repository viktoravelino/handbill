#!/usr/bin/env bash
# Moves handbill issues across the GitHub Project board (project #8) from the CLI.
# Resolves project, field, and option ids by name at runtime, so nothing here goes stale.
#
#   board.sh show            list every card with its status
#   board.sh start  <issue>  → In Progress    (run when you begin work)
#   board.sh review <issue>  → In Review      (run right after opening the PR)
#   board.sh ready  <issue>  → Ready to Merge (set by the Board workflow when review is clean)
#   board.sh todo   <issue>  → Todo           (parked or handed back)
#   board.sh done   <issue>  → Done           (automatic on PR merge)
#   board.sh add   <issue>   put an issue on the board as Todo (new issues)
set -euo pipefail

OWNER=viktoravelino
PROJECT=8
REPO=viktoravelino/handbill

usage() { echo "usage: board.sh show | board.sh (start|review|ready|todo|done|add) <issue-number>" >&2; exit 2; }

project_id() { gh project view "$PROJECT" --owner "$OWNER" --format json --jq .id; }
field_id()   { gh project field-list "$PROJECT" --owner "$OWNER" --format json --jq '.fields[] | select(.name=="Status") | .id'; }
option_id()  { gh project field-list "$PROJECT" --owner "$OWNER" --format json --jq ".fields[] | select(.name==\"Status\") | .options[] | select(.name==\"$1\") | .id"; }
item_id()    { gh project item-list "$PROJECT" --owner "$OWNER" --limit 500 --format json --jq ".items[] | select(.content.number==$1) | .id"; }

set_status() { # <issue> <Todo|In Progress|Done>
  local item; item=$(item_id "$1")
  [[ -n $item ]] || { echo "issue #$1 is not on the board — run: board.sh add $1" >&2; exit 1; }
  gh project item-edit --project-id "$(project_id)" --id "$item" \
    --field-id "$(field_id)" --single-select-option-id "$(option_id "$2")" >/dev/null
  echo "#$1 → $2"
}

cmd=${1:-}; issue=${2:-}
case $cmd in
  show)  gh project item-list "$PROJECT" --owner "$OWNER" --limit 500 --format json \
           --jq '.items[] | "\(.status // "No status")\t\(if .content.type=="PullRequest" then "PR" else "#" end)\(.content.number)\t\(.title)"' | sort ;;
  start)  [[ -n $issue ]] || usage; set_status "$issue" "In Progress" ;;
  review) [[ -n $issue ]] || usage; set_status "$issue" "In Review" ;;
  ready)  [[ -n $issue ]] || usage; set_status "$issue" "Ready to Merge" ;;
  todo)  [[ -n $issue ]] || usage; set_status "$issue" "Todo" ;;
  done)  [[ -n $issue ]] || usage; set_status "$issue" "Done" ;;
  add)   [[ -n $issue ]] || usage
         gh project item-add "$PROJECT" --owner "$OWNER" --url "https://github.com/$REPO/issues/$issue" >/dev/null
         set_status "$issue" "Todo" ;;
  *)     usage ;;
esac
