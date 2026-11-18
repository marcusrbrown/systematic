---
title: Pin the review scope once, hand children values instead of a diff, and fingerprint the content
date: 2026-11-16
category: best-practices
module: ce-review
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "A parent agent fans out reviewers that read the same checkout and later synthesizes their findings"
  - "The checkout can change while the children run: a dirty working tree, a moving base branch, or another process"
  - "A staleness check compares the head commit or per-file line counts"
  - "A diff is pasted into every child prompt, or every child recomputes it"
tags: [ce-review, scope, fingerprint, stale-result, git-diff, worktree, fan-out, fail-closed]
---

# Pin the review scope once, hand children values instead of a diff, and fingerprint the content

## Context

Before [#1424](https://github.com/marcusrbrown/systematic/pull/1424), `ce:review` pasted one diff into every reviewer prompt, and reviewers re-ran the same diff commands: `git diff HEAD^1 HEAD -- <paths>` appeared six times in run 43696270506 (fro-bot/.github#4251) and `git diff origin/main` three times in run 43666639689 (fro-bot/agent#2217). The scope could also be wrong or moving: a reviewer in the wrong checkout, or a base branch that gained a commit mid-review, produced false findings ([the incidents](../workflow-issues/verify-reviewer-findings-against-the-real-checkout-2026-09-20.md)). The first fix detected a changed working tree by re-checking manifest line counts, and a review of #1424 showed that this misses an edit that keeps every count the same (`docs/plans/2026-11-15-002-feat-proportional-unattended-ce-review-plan.md:563`). A probe confirmed it.

## Guidance

### Pin four values once, and pass values instead of a diff

After the base resolves, the parent pins the scope: the checkout path, the base SHA, the head, and a manifest with one entry per changed path (`skills/ce-review/SKILL.md:329-352`, `Pin the scope`). The parent writes no diff file, and no whole-range diff crosses a prompt.

- **Base SHA, not a ref.** `BASE_SHA=$(git rev-parse --verify "${BASE}^{commit}")` fixes the base, so a base that moves later cannot change what the review means (`skills/ce-review/SKILL.md:334`, `BASE_SHA`).
- **Head is `working tree` when the checkout is dirty**, and the commit otherwise. The commit is recorded either way (`skills/ce-review/SKILL.md:337`, `HEAD_PIN`).
- **Checkout path.** Every child runs `git -C <checkout_path>` against it, so a reviewer launched from another directory still reads the intended tree.
- **Manifest.** The path, status (`A`, `M`, `D`, `R`, `T`), rename source and line counts. It names every changed path, so no diff is needed to know what changed.
- **Children read one path at a time.** `git -C <checkout_path> diff -U10 <base_sha> <head> -- <path>` reads a diff and `git -C <checkout_path> show <base_sha>:<path>` reads old source. A range-wide diff or log is not permitted (`skills/ce-review/references/diff-scope.md:7-17`). Finding validators receive the same pin, so a validator checks a cited path against the same tree (`skills/ce-review/SKILL.md:618`).

### Fingerprint the content, not the counts

The pin prints `FINGERPRINT`, the output of `git diff --binary --no-ext-diff --no-textconv <base_sha> | git hash-object --stdin` (`skills/ce-review/SKILL.md:340`). Stage 6 recomputes it before `finalize` and compares it with the pinned value, along with the head commit and the head kind (`skills/ce-review/SKILL.md:630-639`).

Line counts and the head commit pass after some edits. Tests pin three cases, each with the head commit, the dirty state and the line counts unchanged: a same-count edit to an already-edited line, a binary file replaced by other bytes of the same size, and a mode change (`tests/unit/ce-review-diff-handoff-contract.test.ts:764-826`).

The fingerprint covers tracked content, binary and mode changes. It does not cover untracked files, so those stay outside the scope and are listed for the user (`skills/ce-review/SKILL.md:356`, `UNTRACKED`).

### Fail closed on what the pin cannot represent

`git diff --name-status <base>` reports an unmerged path as `M`, so a status filter alone lets it through. On git 2.56.0, a conflicted merge printed `M f` from `git diff --name-status -M <base>`, while `git ls-files --unmerged` listed three stages for the same path. The pin therefore also requires `git ls-files --unmerged` to be empty (`skills/ce-review/SKILL.md:339`), and a test builds a real conflicted merge to prove it (`tests/unit/ce-review-diff-handoff-contract.test.ts:841-872`).

If the base, the head or the manifest cannot be produced, the scope is not pinned. The run ends visibly incomplete before any dispatch and never claims full coverage (`skills/ce-review/SKILL.md:352`).

### Make a stale result terminal

A moved head is one terminal path, not a banner on a normal report. A stale run does not call `finalize`, applies no fix, writes no `review-summary.json` and no todo files, asks no question, and renders no findings or verdict. It prints the stale reason with the pinned and current head, and says what was withheld (`skills/ce-review/SKILL.md:641-648`). The re-check runs before any fix, so the parent's own fixes are not a moved head. A display-only flag would leave later stages free to persist an artifact and a verdict for code that no longer exists.

## Related

- [Reviewer findings need verification against the checkout the code lives in](../workflow-issues/verify-reviewer-findings-against-the-real-checkout-2026-09-20.md): the failures this pin removes at the source, and why verifying findings stays necessary.
- [Unattended ce:review cost follows the prompt contract, not the diff](../workflow-issues/unattended-ce-review-cost-follows-the-prompt-contract-2026-11-16.md): the cost side of the same change set.
- [A reviewer schema rooted at the parent record required fields that the screen rejects](../logic-errors/reviewer-return-schema-root-required-parent-only-fields-2026-11-16.md): the same contract-first fix applied to the reviewer's output.
- [Re-verify carried state at a phase boundary instead of trusting it](./re-verify-carried-state-at-phase-boundaries-2026-09-15.md): the general rule the Stage 6 re-check follows.
