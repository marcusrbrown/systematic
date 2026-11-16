---
title: Size a skill refresh to the ask; cut unrequested machinery instead of hardening it
date: 2026-10-25
last_updated: 2026-11-16
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
  - "The ask is a skill edit, and the plan reaches for measurement machinery to justify it"
tags: [skill-refresh, writing-skills, scope-creep, overbuilt, git-worktree, review-findings, pressure-testing, measurement, trigger-frequency]
---

# Size a skill refresh to the ask; cut unrequested machinery instead of hardening it

## Context

The ask was narrow. Agents were creating git worktrees in arbitrary places instead of `.worktrees/`, and the `git-worktree` skill's `.gitignore` update was not idempotent. The skill needed a refresh with `writing-skills`, plus a bootstrap instruction saying where worktrees go.

The first attempt grew the helper script from about 500 to about 1,780 lines. It added a fetch watchdog with signal traps and rollback, `--existing`, `--protect`, a force-removing `--include-dirty`, and nested cleanup. Thousands of test lines came with it to cover the new hang and signal paths. Verifying the prose skill would have meant about 135 isolated model runs, and those stalled on quota limits. The work was stopped as overbuilt relative to the ask, before anything was pushed.

**The same shape recurred with a measurement campaign.** A hand-off asked whether the installed `counterfactual` and `synthesis` methods fire at `ce:plan` and `ce:review` decision points, "following the writing-skills TDD discipline", with skill text only where a method missed. The work built instruments instead: a history-count tool in metacogs (metacogs#100, +12,782 lines, fixes in #103 at +899/−113, removed in #106 at −13,568), a replay A/B on load counts (metacogs#109, closed, +12,377/−157) and a quality A/B in Systematic that a screen stopped before its paid arm ran. What shipped was #1430: eight added lines across four skill files, plus a 219-line contract test, written with `writing-skills` RED/GREEN and in-session subagent scenarios. See [Wire an optional companion skill into a workflow skill](../best-practices/wire-an-optional-companion-skill-into-a-workflow-skill-2026-11-16.md).

## Guidance

1. **Write the ask as requirements, then list what you will not build.** The shipped plan's out-of-scope list (`docs/plans/2026-10-25-001-fix-git-worktree-refresh-plan.md:74-85`) names every mechanism the first attempt built. Check new work against a list like that before adding it.
2. **Read review findings on unrequested code as a signal to delete it.** When a finding lands on a mechanism the ask never needed, removing the mechanism is usually the right fix. Hardening it is not. More surface produces more findings, and more findings produce more fixes.
3. **Restart from the original, not from the overgrown branch.** Carry over the parts that fit the ask by applying their diff. Here those were the bootstrap rule, the harness wiring and the pointers from other skills. Rebuild the rest from main with only the fixes the ask needs.
4. **Pressure-test a skill with the subagents you already have.** `writing-skills` needs baseline failures and evidence that the rewrite fixes them. It does not need repeated isolated model runs. Here, one subagent pass was enough to find a real gap (see Examples).
5. **Pin the rules an agent must read, not the wording.** The header comment of the shipped contract test says it pins "the safety and routing rules an agent must keep reading from the skill, not its wording" (`tests/unit/git-worktree-skills-contract.test.ts:6-7`). Contract tests that pin whole sentences make every editorial change expensive, and they don't test whether an agent follows the rule.
6. **Identify the decision before you measure.** A skill edit uses `writing-skills`. A measurement needs a named decision it will change. The replay A/B kept the review sentence and rejected the plan sentence, and the plan sentence shipped anyway (see Examples), so the measurement did not decide what shipped. Search for an existing eval harness before building one ([An eval of a multi-agent workflow must run the real system](../best-practices/an-eval-of-a-multi-agent-workflow-must-run-the-real-system-2026-11-16.md)).
7. **Screen how often the trigger fires before running a paid campaign.** If the situation a sentence targets rarely arises, a quality A/B buys a predictable null. The screen ran 12 fixtures in two arms on `anthropic/claude-sonnet-5-5`, 24 natural `ce:review` runs in autofix mode. `skill-loads.json` in those runs records 14 `todos` loads and no `synthesis` or `counterfactual` load. Zero loads is not evidence that the trigger never arose, because a missed invocation leaves the same record. Trigger frequency has to come from reviewed transcripts or independently labelled decision points. The screen's own hand count of reviewer disagreements (0 strict, 7 one-level) and its roughly $220 campaign projection were not recorded in a file. [Eval fixtures need headroom](https://github.com/marcusrbrown/metacogs/blob/main/docs/solutions/best-practices/eval-fixture-headroom-baseline-screen-before-skill-arm-2026-10-29.md) (metacogs) makes the same argument for fixtures.

## Why This Matters

The extra machinery added bugs of its own. An independent review of the first attempt reproduced two:

- The ignore check probed one path, `.worktrees/<name>/x`. A root `.gitignore` containing `x` made `create` skip writing the self-ignore, so the main checkout then showed `?? .worktrees/`.
- Rollback after a failed create deleted the shared `.worktrees/.gitignore` while a concurrent create still depended on it.

The rebuild removes both causes:

- `ensure_ignore_file` writes `.worktrees/.gitignore` only when it is missing and never deletes it (`skills/git-worktree/scripts/worktree-manager.sh:308-320`).
- After `git worktree add`, the script stores `git status --porcelain -- .worktrees` in `status_out` and fails if it isn't empty, instead of probing a path (`skills/git-worktree/scripts/worktree-manager.sh:387-391`).
- The script has no rollback. A failed check leaves the new worktree in place, and the error says so.

## When to Apply

- A narrow refresh of an existing skill or script has a plan with more units than the ask has sentences.
- Review rounds keep finding bugs in code nobody asked for.
- Verifying a prose skill would take hours of model runs, or the plan for a skill edit contains a measurement tool, replay harness or paid A/B.

## Examples

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

**What the closed replay A/B showed.** The metacogs#109 branch (`feat/systematic-reflection-baseline`, its `evals/spikes/systematic-reflection/README.md`) is the only record of these results. The runs used `openai/gpt-6-luna` at N=3 on a real host and spent $5.22 of a $10 cap. "Loaded" means a completed `synthesis` or `counterfactual` load through the host skill tool.

| Point | Baseline | With the sentence |
|---|---|---|
| `ce:review` adjudication, tuning fixture | loaded 0 of 3 | 3 of 3 |
| `ce:review` adjudication, second twin set | 0 of 3 | 2 of 3 |
| `ce:plan` unchecked claim, tuning fixture | 0 of 3 | 0 of 3, not kept |

The first held-out read of the review sentence ended as a null, because a 300-second limit cut off five of six treatment attempts (see the eval doc in Related). PR #1430 shipped the `ce:plan` sentence anyway, on a prose scenario that missed before and loaded `counterfactual` after. Its "Not covered" section says real-host runs of the planning trigger were not done.

Review of the small branch found the bugs recorded in [Inferring the main work-tree root from the git common dir](../logic-errors/infer-main-worktree-root-from-git-common-dir-2026-10-25.md).

## Related

- [Stop patching after a second review round breaks the first round's fixes; cut scope instead](stop-patching-after-second-review-round-2026-10-15.md) makes the same move: cut instead of patch. There, review rounds on a plan trigger it. This doc applies it from the start, by sizing the work against the original ask.
- [Wire an optional companion skill into a workflow skill](../best-practices/wire-an-optional-companion-skill-into-a-workflow-skill-2026-11-16.md) is the pattern #1430 shipped.
- [An eval of a multi-agent workflow must run the real system](../best-practices/an-eval-of-a-multi-agent-workflow-must-run-the-real-system-2026-11-16.md) covers what the measurement got wrong when it did run.
- `skills/writing-skills/SKILL.md` is the skill-authoring workflow.
