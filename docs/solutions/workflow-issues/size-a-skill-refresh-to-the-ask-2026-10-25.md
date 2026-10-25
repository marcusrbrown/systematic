---
title: Size a skill refresh to the ask; cut unrequested machinery instead of hardening it
date: 2026-10-25
category: workflow-issues
module: skill-authoring
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A skill or script refresh has a narrow ask, such as a placement rule or one idempotency fix"
  - "The draft grows hardening machinery nobody asked for, and review keeps finding bugs in it"
  - "A verification plan for a prose skill needs hours of repeated model runs"
  - "The overbuilt branch is unpushed, so restarting small is cheap"
tags: [skill-refresh, writing-skills, scope-creep, overbuilt, git-worktree, review-findings, pressure-testing]
---

# Size a skill refresh to the ask; cut unrequested machinery instead of hardening it

## Context

The ask was narrow. Agents were creating git worktrees in arbitrary places instead of `.worktrees/`, and the `git-worktree` skill's `.gitignore` update was not idempotent. The skill needed a refresh with `writing-skills`, plus a bootstrap instruction saying where worktrees go.

The first attempt grew the helper script from about 500 to about 1,780 lines. It added a fetch watchdog with signal traps and rollback, `--existing`, `--protect`, a force-removing `--include-dirty`, and nested cleanup. Thousands of test lines came with it to cover the new hang and signal paths. Verifying the prose skill would have meant about 135 isolated model runs, and those stalled on quota limits. The work was stopped as overbuilt relative to the ask, before anything was pushed.

## Guidance

1. **Write the ask as requirements, then list what you will not build.** The shipped plan's out-of-scope list (`docs/plans/2026-10-25-001-fix-git-worktree-refresh-plan.md:73-85`) names every mechanism the first attempt built. Check new work against a list like that before adding it.
2. **Read review findings on unrequested code as a signal to delete it.** When a finding lands on a mechanism the ask never needed, removing the mechanism is usually the right fix. Hardening it is not. More surface produces more findings, and more findings produce more fixes.
3. **Restart from the original, not from the overgrown branch.** Carry over the parts that fit the ask by applying their diff. Here those were the bootstrap rule, the harness wiring and the pointers from other skills. Rebuild the rest from main with only the fixes the ask needs.
4. **Pressure-test a skill with the subagents you already have.** `writing-skills` needs baseline failures and evidence that the rewrite fixes them. It does not need repeated isolated model runs. Here, one subagent pass was enough to find a real gap (see Examples). The pass covered the scenarios that failed at baseline, ran in scratch repositories against the new `SKILL.md`, and reported the commands it ran.
5. **Pin the rules an agent must read, not the wording.** The header comment of the shipped contract test says it pins "the safety and routing rules an agent must keep reading from the skill, not its wording" (`tests/unit/git-worktree-skills-contract.test.ts:6-7`). Contract tests that pin whole sentences make every editorial change expensive, and they don't test whether an agent follows the rule.

## Why This Matters

The extra machinery added bugs of its own. An independent review of the first attempt reproduced two:

- The ignore check probed one path, `.worktrees/<name>/x`. A root `.gitignore` containing `x` made `create` skip writing the self-ignore, so the main checkout then showed `?? .worktrees/`.
- Rollback after a failed create deleted the shared `.worktrees/.gitignore` while a concurrent create still depended on it.

The rebuild removes both causes:

- `ensure_ignore_file` writes `.worktrees/.gitignore` only when it is missing and never deletes it (`skills/git-worktree/scripts/worktree-manager.sh:308-320`).
- After `git worktree add`, the script stores `git status --porcelain -- .worktrees` in `status_out` and fails if it isn't empty, instead of probing a path (`skills/git-worktree/scripts/worktree-manager.sh:387-391`).
- The script has no rollback. A failed check leaves the new worktree in place, and the error says so.

## When to Apply

- A maintainer asks for a narrow refresh of an existing skill or script.
- A plan has more units than the ask has sentences.
- Review rounds keep finding bugs in code nobody asked for.
- Verifying a prose skill would take hours of model runs.

## Examples

**Abandoned.** See Context.

**Shipped in #1220.** A fresh branch from main:

| Surface | Size |
|---|---|
| Script (`skills/git-worktree/scripts/worktree-manager.sh`) | 677 lines, built from main's 500-line script |
| `skills/git-worktree/SKILL.md` | 58 lines |
| Behavior tests on real temporary repositories | about 700 lines, plus about 300 lines of fixtures |
| Contract test | 122 lines |
| Plan | 99 lines |

The bootstrap instruction is one paragraph, in `skills/using-systematic/references/worktree-placement.md`.

**One subagent pass found a real gap.** `create` branches with `--no-track` (`skills/git-worktree/scripts/worktree-manager.sh:384`), so the new branch had no upstream. The skill now tells agents to publish it with `git push -u origin <branch>`. The test `creates the branch without an upstream` pins the no-upstream behavior (`tests/unit/git-worktree-manager.test.ts:310-323`).

Review of the small branch found the bugs recorded in [Inferring the main work-tree root from the git common dir](../logic-errors/infer-main-worktree-root-from-git-common-dir-2026-10-25.md).

## Related

- [Stop patching after a second review round breaks the first round's fixes; cut scope instead](stop-patching-after-second-review-round-2026-10-15.md) makes the same move: cut instead of patch. There, review rounds on a plan trigger it. This doc applies it from the start, by sizing the work against the original ask.
- `skills/writing-skills/SKILL.md` is the skill-authoring workflow.
