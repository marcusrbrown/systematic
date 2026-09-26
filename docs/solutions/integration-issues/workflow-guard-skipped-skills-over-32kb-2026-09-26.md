---
title: Workflow guard silently skipped activation for skills over 32 KB
date: 2026-09-26
category: integration-issues
module: workflow-guard
problem_type: integration_issue
component: development_workflow
symptoms:
  - "Loading ce:plan (63 KB) or ce:review (71 KB) through systematic_skill never starts the guarded epoch or unit"
  - "No error or warning; activation is simply skipped"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [workflow-guard, skill-activation, output-cap, receipts, epoch]
---

# Workflow guard silently skipped activation for skills over 32 KB

## Problem

Skill loads larger than 32 KB never activated their guarded workflow. The skill loaded, but `systematic_workflow_status` showed no epoch, and the tool metadata had no progression markers.

## Symptoms

- `ce:plan` or `ce:review` loaded through `systematic_skill` never started a guarded epoch or unit.
- Nothing failed visibly, because the guard's after hook returns early rather than throwing.

## What Didn't Work

- A test hid the bug. `rejects host results beyond the bounded output limit` exercised the cap through the skill path, so it encoded "large skill load does not activate" as expected behavior.
- Restoring the full skill text after host truncation would not have fixed it either. OpenCode's truncated preview is about 51 KB, which is already over the cap.

## Solution

In `src/lib/opencode-workflow-guard.ts`, `finishSkill` returned early through `isSuccessfulAfter` → `parseHostOutput`. That function rejects any `output.output` longer than `MAX_HOST_OUTPUT_LENGTH = 32_768`. The cap exists to bound operation-receipt evidence; skill completion only needs a success signal.

```ts
// before
if (!isSuccessfulAfter(output)) return

// after
function parseHostOutput(output: unknown, options?: ParseHostOutputOptions): HostOutput | undefined {
  // ...
  const maxOutputLength = options?.maxOutputLength ?? MAX_HOST_OUTPUT_LENGTH
  // same title/status/metadata rules, length checked against maxOutputLength
}

function isSuccessfulSkillAfter(output: unknown): output is HostOutput {
  return parseHostOutput(output, { maxOutputLength: Number.POSITIVE_INFINITY }) !== undefined
}

if (!isSuccessfulSkillAfter(output)) return
```

Only `finishSkill` uses the uncapped check. `isSuccessfulAfter` (used by `finishStart` and `finalizeComplete`) and `completeOperationObservation` keep the 32 KB cap. The old test moved to the operation path, which is where the cap still applies.

## Why This Works

The cap and the success check were combined in one parser. Splitting the length limit into a parameter keeps every other rule for skill completion: the title bound, a string output, a present `metadata`, and rejection of `failure`, `cancelled`, or `error` status. Only the rule that never applied to skills is dropped.

## Prevention

- Put a size cap on the path whose evidence it bounds, not on a shared success check.
- Test the large-payload success path, not only the rejection path. Unit tests now cover: a 60 KB success activates and merges markers; a ~51 KB truncated preview activates; 60 KB with `status: 'error'` does not activate; an operation over the cap is still rejected.
- The real-host `tests/integration/skill-delivery.test.ts` loads `ce:plan` and asserts that the epoch progression marker is merged into the `systematic_skill` tool part's metadata.

## Related Issues

- #1029 (fix)
- [`plugin-tool-output-truncated-before-after-hook-2026-09-26.md`](plugin-tool-output-truncated-before-after-hook-2026-09-26.md): the truncation work that surfaced this
- [`delegated-receipt-rollup-live-state-recovery-2026-07-31.md`](delegated-receipt-rollup-live-state-recovery-2026-07-31.md), [`worktree-targeted-receipt-observation-2026-08-02.md`](worktree-targeted-receipt-observation-2026-08-02.md): other workflow-guard failure modes
