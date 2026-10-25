---
title: Inferring the main work-tree root from the git common dir breaks on separate git dirs, --base HEAD and list
date: 2026-10-25
category: logic-errors
module: skills
problem_type: logic_error
component: tooling
symptoms:
  - "create wrote .worktrees/ beside a separate git dir whose core.worktree pointed elsewhere"
  - "create wrote .worktrees/ beside the git dir of a plain git init --separate-git-dir checkout"
  - "--base HEAD from a linked worktree started at the main checkout's HEAD"
  - "list marked two checkouts as current"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [git-worktree, git-common-dir, core-worktree, separate-git-dir, shell, macos-bash-3-2]
---

# Inferring the main work-tree root from the git common dir breaks on separate git dirs, --base HEAD and list

## Problem

The `git-worktree` script places each worktree at `<main root>/.worktrees/<branch>`. It infers the main root as the parent of `git rev-parse --git-common-dir`, so a run from inside a linked worktree still lands at the main checkout. That inference was wrong in two layouts, and two other places assumed the main checkout was the caller's checkout. PR review found all four. Two of them wrote outside the checkout.

## Symptoms

1. **`core.worktree` elsewhere.** The metadata is at `storage/.git` and `core.worktree` points at the real checkout. `create` wrote `storage/.worktrees/` outside the checkout.
2. **Plain `--separate-git-dir`.** `git init --separate-git-dir=storage/.git checkout` does not set `core.worktree`. `create` run from the checkout still wrote into `storage`.
3. **`--base HEAD` from a linked worktree.** The new worktree started at the main checkout's HEAD and dropped the caller's commits.
4. **Two current checkouts.** Run from a linked worktree, `list` printed `current=yes` for that worktree and also for the main checkout.

## What Didn't Work

- **Trusting the `.git` basename.** The refusal for separate git dirs whose basename isn't `.git` (`skills/git-worktree/scripts/worktree-manager.sh:68-70`) is necessary but not sufficient. A directory literally named `.git` can still belong to a work tree somewhere else.
- **Checking `--show-toplevel` from the inferred root only.** That catches the `core.worktree` case. In the plain `--separate-git-dir` layout, git run from `storage` reports `storage` as its own toplevel, so the check passes.
- **Telling that layout apart from a linked worktree.** Git itself treats `storage` as the main worktree. `git worktree list` reports it whether it is run from the checkout, from a linked worktree, or from `storage`. A run from a linked worktree in that layout can't be distinguished, so it stays unsupported, as the script's comment records (`skills/git-worktree/scripts/worktree-manager.sh:83-87`). No heuristics were added.

## Solution

The excerpts are from `skills/git-worktree/scripts/worktree-manager.sh` as shipped in #1220.

**1. The inferred root must be its own work tree.** This check runs before anything is written (`skills/git-worktree/scripts/worktree-manager.sh:75-81`):

```bash
  root=$(dirname "$common")
  toplevel=$(git -C "$root" rev-parse --show-toplevel 2> /dev/null) || toplevel=""
  toplevel=$(cd "$toplevel" 2> /dev/null && pwd -P) || toplevel=""
  if [ "$toplevel" != "$root" ] ||
    [ "$(git -C "$root" rev-parse --is-bare-repository 2> /dev/null)" = "true" ]; then
    die 3 unsupported-layout "$root is not the work tree of $common; there is no main work tree to place .worktrees in"
  fi
```

**2. From the main checkout, the caller's own work tree must be that root.** When the caller's `--absolute-git-dir` equals the common dir, the caller is in the main checkout and not in a linked worktree (`skills/git-worktree/scripts/worktree-manager.sh:88-95`):

```bash
  gitdir=$(git rev-parse --absolute-git-dir 2> /dev/null) && gitdir=$(cd "$gitdir" 2> /dev/null && pwd -P) || gitdir=""
  if [ "$gitdir" = "$common" ]; then
    toplevel=$(git rev-parse --show-toplevel 2> /dev/null) || toplevel=""
    toplevel=$(cd "$toplevel" 2> /dev/null && pwd -P) || toplevel=""
    if [ "$toplevel" != "$root" ]; then
      die 3 unsupported-layout "your work tree ${toplevel:-(none)} is not $root, which holds the git directory $common"
    fi
  fi
```

**3. Resolve `--base` in the caller's checkout and pass the commit.** If `--base` is resolved with `git -C` pointed at the main root, `HEAD` means the main checkout's HEAD. The script resolves the ref with no `-C`, keeps the result in `base_commit`, and passes that to `git worktree add` (`skills/git-worktree/scripts/worktree-manager.sh:364-384`):

```bash
    # Resolved in the caller's checkout, so HEAD means the caller's HEAD.
    base_commit=$(git rev-parse --verify --quiet "$base_arg^{commit}" 2> /dev/null) ||
      die 3 base-unresolved "--base $base_arg does not resolve locally; fetch it first"
```

Without `--base`, the script fetches and uses `origin/<default>`, which names the same commit in every checkout.

**4. Only the innermost checkout is current.** Every linked worktree under `.worktrees/` sits inside the main root. So `list` keeps the longest entry in `WT_PATHS` that contains `pwd -P`, tracking it in `best_len` (`skills/git-worktree/scripts/worktree-manager.sh:430-438`).

## Why This Works

The root is inferred, not observed. Each fix replaces an assumption with a question git can answer:

- Is the inferred root its own work tree?
- When the caller is in the main checkout, is the caller's work tree that root?
- Which commit does this ref name in the caller's checkout?
- Which registered worktree most closely contains the caller?

Every `unsupported-layout` refusal exits 3 before the first write, so an unsupported layout never leaves a stray `.worktrees/` behind.

## Prevention

- **Assert "writes nothing", not just the exit code.** Both split layouts use `createDetachedDotGitRepo(coreWorktree)` (`tests/unit/git-worktree-fixtures.ts:181-202`), and both tests compare directory listings. The plain `--separate-git-dir` test, `refuses a separate .git directory without core.worktree and writes nothing`, also compares the branch list (`tests/unit/git-worktree-manager.test.ts:108-120`):

  ```ts
  const { work, storage } = createDetachedDotGitRepo()
  // ...
  expect(result.status).toBe(3)
  // ...
  expect(fs.existsSync(path.join(storage, '.worktrees'))).toBe(false)
  expect(fs.existsSync(path.join(work, '.worktrees'))).toBe(false)
  expect(git(work, ['branch', '--list'])).toBe(branches)
  ```

  Its `core.worktree` counterpart is at `tests/unit/git-worktree-manager.test.ts:97-106`.
- **Test context-sensitive refs from a linked worktree.** `resolves --base in the caller's checkout, not the main checkout` commits in a linked worktree, then checks that `create x --base HEAD` starts from that commit (`tests/unit/git-worktree-manager.test.ts:286-298`). `marks only the innermost checkout as current` covers `list` (`tests/unit/git-worktree-manager.test.ts:416-426`).
- **Strip only the variables that locate a repository.** The script unsets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE` and `GIT_PREFIX` (`skills/git-worktree/scripts/worktree-manager.sh:22-25`), so a stray one can't redirect it. Transport and config variables such as `GIT_SSH_COMMAND` belong to the caller. A script that fetches needs them, so it keeps them.
- **Run the suites under stock macOS bash.** The script's header comment rules out bash 4 features and `set -u` (`skills/git-worktree/scripts/worktree-manager.sh:13-15`). The fixtures' `run` uses `TEST_BASH` (`tests/unit/git-worktree-fixtures.ts:230-233`), so `TEST_BASH=/bin/bash` runs the same tests on bash 3.2.

## Related Issues

- #1220, the refresh where review found these bugs.
- [Size a skill refresh to the ask](../workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md), the change these bugs were found in.
