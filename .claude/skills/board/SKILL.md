---
name: board
description: Track handbill work on the GitHub Project board (project #8) — move an issue to In Progress when starting, back to Todo when parking, add new issues, check the board. Use at the start and end of any issue-driven work in this repo.
---

# Board

Work in this repo is one GitHub issue per milestone, tracked on https://github.com/users/viktoravelino/projects/8 with five columns: **Todo → In Progress → In Review → Ready to Merge → Done**. The helper resolves all ids at runtime; never hard-code project, field, or option ids.

```bash
.claude/skills/board/board.sh show          # what is where
.claude/skills/board/board.sh start 3       # you are starting issue #3
.claude/skills/board/board.sh review 3      # you just opened the PR for #3
.claude/skills/board/board.sh todo 3        # parking it / handing it back
.claude/skills/board/board.sh add 7         # a new issue you just created
```

## The loop

1. **Pick up an issue.** `gh issue view <n>` is the spec: tasks, acceptance criteria, "done when". Read `AGENTS.md` first if you have not.
2. **Move it:** `board.sh start <n>`. Then branch from `main`, named after the milestone: `m3-worker`, `m4-cli`.
3. **Comment when you begin** with the branch name and anything you decided to do differently from the issue: `gh issue comment <n> --body "..."`. Decisions live on the issue, not in chat.
4. **Tick the checklist as you go.** Edit the issue body (`gh issue edit <n> --body-file`) so the checkboxes reflect reality; a reviewer reads the issue before the diff.
5. **Open a PR with `Closes #<n>` in the body, then `board.sh review <n>`.** Copilot reviews every PR automatically and re-reviews each push. The `Board` workflow moves the issue to **Ready to Merge** when a Copilot review lands with no comments or a human approves, and back to **In Review** when there are comments or changes are requested. If Copilot left comments: address or answer each one, push, and wait for the next review. Do **not** run `board.sh ready` or `board.sh done` yourself — the automation and the merge are the source of truth. `main` only accepts squash merges via PR with the `typecheck`, `lint`, and `test` jobs green. **Never merge the PR yourself and never enable auto-merge** — opening it with green checks is the end of your job; the maintainer merges.
6. **Blocked or stopping?** `board.sh todo <n>` and a comment saying what is left. A card in In Progress means someone is actively on it.

## Creating issues

Every new issue goes on the board in the same step it is created, even though auto-add exists:

```bash
gh issue create --title "..." --milestone 0.2 --label cli --body-file /tmp/body.md
.claude/skills/board/board.sh add <new number>
```

Titles follow the milestone style (`M7 · …`) for planned work; plain sentences for bugs. Always set a milestone and one area label (`worker` `cli` `contract` `web` `skill` `docs`).

## If it fails

- `401`/`403` from `gh project` → the token lacks the scope: `gh auth refresh -s project` (interactive; ask the maintainer).
- "not on the board" → `board.sh add <n>` first.
