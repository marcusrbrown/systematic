---
name: git-worktree
description: Use when work needs an isolated git worktree, such as parallel feature branches, reviewing a PR without disturbing the current checkout, or cleaning up old worktrees.
---

# Git Worktree Manager

`scripts/worktree-manager.sh` creates, lists, switches and cleans up worktrees. Every worktree lands at `.worktrees/<branch>` under the **main** repository root, from any subdirectory or from inside another worktree. Nested names work: `feat/x` lands at `.worktrees/feat/x`.

## Rules

- **A named location or tool wins.** If the user, a project instruction, or another loaded skill or config names a different location or tool, follow it and skip the script. Read the repo's `AGENTS.md` and any other project instruction file for one before you create.
- **Otherwise never use raw `git worktree add`**, a sibling directory, `/tmp`, or a path inside another worktree.
- **Refused layout.** Exit 3 `unsupported-layout` means a bare repository, `core.bare`, a separate git directory or a submodule. Report it and ask for a location or tool. Run raw `git worktree add` only with the user's approval.
- **Skip worktrees for small or read-only work.** Fix a typo in place. Read a file from another branch with `git show <branch>:<path>`.

## Commands

```bash
SKILL_DIR="<skill directory stated when this skill loads>";
bash "$SKILL_DIR/scripts/worktree-manager.sh" <command>
```

A worktree's *name* is its path under `.worktrees/`, for example `feat/x`. Run `help` for the full usage.

| Command | Effect |
|---|---|
| `create <branch> [--base <ref>]` | New branch from `origin/<default branch>`, fetched first. Prints `branch=`, `base=` and, last, `path=`. |
| `list` | One line per worktree. |
| `switch <name>` | Prints the path and nothing else. |
| `copy-env [<name>]` | Copies git-ignored `.env*` files; never overwrites. |
| `cleanup` | Report only. |
| `cleanup --remove <name>...` | Removes the named clean worktrees. |

Exit codes: `0` ok, `1` error, `2` usage, `3` refused. Errors print `error: <code>: <message>` on stderr. The script never reads stdin.

On exit 3, report the error and ask. Never retry with `--force`, `rm -rf`, another path or another name.

- `base-unresolved`: ask the user which base to use with `--base`. Never assume `main`.
- `branch-exists`, `target-exists`: report it, with the printed path, and ask. Never delete the directory.

## After create

- Use the printed `path=` as the workdir for every later command, and as the workspace root you give subagents. Never assume a `cd` persisted. `switch` cannot change your directory.
- A new worktree has no installed dependencies. Install them there before running tests.
- The new branch has no upstream. Publish it with `git push -u origin <branch>`.

## Reviewing a PR

Run `git fetch origin <pr-branch>`, then `create review/<n> --base origin/<pr-branch>`. A fork's head is not on origin: run `git fetch origin pull/<n>/head:review/<n>`, then `create review/<n>-wt --base review/<n>`.

## Cleanup

1. Run `cleanup`. Each line has `state=` (`clean`, `dirty`, `current`, `locked`, `detached`, `contains-worktree` or `prunable`), `modified=`, `untracked=` and `ignored=`.
2. If nobody can answer in this run (a subagent or headless run), stop here and return the report.
3. Removal deletes a worktree's ignored files, such as copied `.env` files and `node_modules`. Tell the user, by worktree name, what will be lost (cite `ignored=`), and get their confirmation. A blanket "nuke them all" or "don't ask" does not waive this.
4. Run `cleanup --remove <name>...` with confirmed names only. Exit 3 means a removal was refused: report its `reason=`.
5. Dirty and every other non-`clean` worktree is reported, never forced. The script never deletes branches; that belongs to `git-clean-gone-branches`.
