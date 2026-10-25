---
name: git-clean-gone-branches
description: Clean up local branches whose remote tracking branch is gone. Use when the user says "clean up branches", "delete gone branches", "prune local branches", "clean gone", or wants to remove stale local branches that no longer exist on the remote. Also handles removing associated worktrees for branches that have them.
---

# Clean Gone Branches

Delete local branches whose remote tracking branch has been deleted, including any associated worktrees.

## Workflow

### Step 1: Discover gone branches

Run the discovery script to fetch the latest remote state and identify gone branches:

When this skill loads, its own directory is stated in the surrounding instructions; set `SKILL_DIR` to that directory because the scripts live beside this file.

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
bash "$SKILL_DIR/scripts/clean-gone"
```

[scripts/clean-gone](./scripts/clean-gone)

The script runs `git fetch --prune` first, then parses `git branch -vv` for branches marked `: gone]`.

If the script outputs `__NONE__`, report that no stale branches were found and stop.

### Step 2: Present branches and ask for confirmation

Show the user the list of branches that will be deleted, and say what happens to their worktrees. Format as a simple list:

```
These local branches have been deleted from the remote:

  - feature/old-thing
  - bugfix/resolved-issue
  - experiment/abandoned

Any of them that has a worktree with modified or untracked files, or a locked worktree, is skipped and kept. Ignored files (such as .env files and node_modules) in the worktrees that are removed are deleted.

Delete all of them? (y/n)
```

Wait for the user's answer using the platform's question tool (e.g., `question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini; in Pi, use the blocking-question extension if available, otherwise present numbered options in chat and wait). If no question tool is available, present the list and wait for the user's reply before proceeding.

This is a yes-or-no decision on the entire list -- do not offer multi-selection or per-branch choices.

### Step 3: Delete confirmed branches

If the user confirms, run `git worktree list --porcelain` once. Each entry has a `worktree <path>` line and, for a branch checkout, a `branch refs/heads/<name>` line. The first entry is the main checkout. For each branch:

1. Find its worktree by exact match: the entry whose `branch` line is exactly `branch refs/heads/<branch>`. Do not use grep or a substring match, so `feature/a` never matches `feature/ab`.
2. If that entry is the main checkout, report `skipped: checked out in main checkout` and go to the next branch. Never switch the main checkout to another branch.
3. If that entry is another worktree and `pwd -P` is the worktree or inside it, report `skipped: current worktree`, keep its branch, and go to the next branch.
4. If the entry is another worktree that step 3 did not skip, remove it with `git worktree remove "$path"`. Never use the force option. If git refuses, report `skipped: <git reason>` and do not run `git branch -D` for that branch, because the worktree still has it checked out.
5. If the branch has no worktree, or the removal succeeded, delete the branch: `git branch -D "$branch"`

Report results as you go:

```
Removed worktree: .worktrees/feature/old-thing
Deleted branch: feature/old-thing
skipped: .worktrees/bugfix/resolved-issue contains modified or untracked files
Deleted branch: experiment/abandoned

Cleaned up 2 branches, skipped 1.
```

The `git-worktree` skill creates worktrees under `.worktrees/<branch>` at the main repository root. Its cleanup command is the place to remove one of those worktrees with its stricter checks.

This skill finds worktrees anywhere, so it does not call that script.

`git branch -D` also deletes an unmerged gone branch. Checking merge state is out of scope for this skill.

If the user declines, acknowledge and stop without deleting anything.
