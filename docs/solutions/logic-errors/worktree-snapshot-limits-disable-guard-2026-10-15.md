---
title: Worktree snapshot limits turned workflow guard enforcement off for the session
date: 2026-10-15
category: logic-errors
module: workflow-guard
problem_type: logic_error
component: development_workflow
symptoms:
  - "A local snapshot over the file, gitlink or output limits marked the guard unavailable, a terminal state for the rest of the session"
  - "One sparse file or a burst of submodules was enough to switch enforcement off for the whole session"
  - "A stale receipt first seen by the completion's own readback made finalize fail, which also marked the guard unavailable"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [workflow-guard, snapshot-block, worktree, operation-observer, guard-unavailable, stale-receipt, completion-readback]
---

# Worktree snapshot limits turned workflow guard enforcement off for the session

## Problem

The OpenCode guard adapter (`src/lib/opencode-workflow-guard.ts`) treated every failed local snapshot as fatal. Some of those failures come from the worktree itself, and an agent with a shell can cause them on purpose. `unavailable` is terminal, and the guidance allows the unguarded fallback only when the user authorizes it. So a worktree that crossed a snapshot limit switched enforcement off for the rest of the session (#1124, fixed in #1134).

**Terms.** A *unit* is one guarded workflow run, from start to complete. A *receipt* records an observed operation and the worktree revision it saw. A *readback* is a fresh snapshot compared against existing receipts. The *effective target* is the unit's pinned worktree, or the parent checkout when none is pinned.

## Symptoms

- These observer reasons reached `markUnavailable` from the before-hook, the after-hook, child rollup, remote seeding, status refresh and completion readback:
  - `file-limit` (over 20,000 files or 32 gitlinks)
  - `file-output-limit` (over 128 MiB of content, or a path that is too long)
  - `command-output-limit` (a local listing over 8 MiB)
  - `worktree-unstable` (the tree changed during the snapshot)
- A stale receipt that the completion's own readback found first made `finalizeTransition` return a non-success. The adapter then marked the guard unavailable with `transition-finalize-rejected`.

## What Didn't Work

- **A block that only clears.** Every natural way out was the same: shrink the tree with an unobserved operation, then complete. That completion's readback found the drift, finalize returned `stale-receipt`, and the guard went unavailable anyway. A retryable finalize `stale-receipt` therefore had to be part of the fix.
- **Refusing remote operations while blocked.** Remote intent comes from an async classifier that reads the command and runs after the snapshot, so a block can land during that await. The classifier fails open on a throw, and it only recognises plain `git push` and `gh pr create`. Anything else already goes unreceipted while unblocked, so refusal closed almost nothing.
- **Recording a parent-checkout failure on a pinned unit as a block on the worktree.** Status then named the wrong tree. A clean pinned snapshot cleared the block, and the next completion set it again.
- **Keeping a block whose target stopped being effective.** If a call in flight on a linked worktree was accepted and pinned the unit, every later clear compared against the old target and returned stale. The block could never clear.

## Solution

The adapter keeps a per-unit **snapshot block**: a runtime record of `{unitId, unitGeneration, targetIdentity, reasonCode}`.

- **Storage.** It is not part of core status, markers, receipts or digests, because core status feeds the marker digest. Status reports it as an enum-only `snapshotBlock: {reasonCode}` in any guard state while a block is set. A restart drops it, and the next snapshot sets it again if the tree is still broken.
- **What sets it.** Only a local snapshot of the unit's **effective target** can set the block. The effective target is the pinned worktree, or the parent checkout if there is none. A single rule covers every set site. A record whose target is no longer effective is dropped when read.

```ts
// src/lib/opencode-workflow-guard.ts (comments omitted)
function setSnapshotBlock(
  reasonCode: SnapshotBlockReason,
  targetIdentity: string,
  captured: SnapshotBlockSetCapture,
): boolean {
  const unitId = requireGuard().status().unit?.unitId
  if (
    !unitId ||
    !blockSetIsCurrent(captured) ||
    targetIdentity !== currentEffectiveTargetIdentity()
  ) {
    return false
  }
  writeSnapshotBlock({ unitId, unitGeneration: unitStartGeneration, targetIdentity, reasonCode })
  return true
}

function currentSnapshotBlock(): SnapshotBlockRecord | undefined {
  const record = snapshotBlockRecord
  if (!record) return undefined
  const status = requireGuard().status()
  if (record.unitId !== status.unit?.unitId) return undefined
  if (record.targetIdentity !== currentEffectiveTargetIdentity()) {
    writeSnapshotBlock(undefined)
    return undefined
  }
  return record
}
```

- **While blocked.** Every operation still runs, but skipped calls are not observed: the before-hook adds the call to `skippedOperations`, the after-hook stays silent, and no receipt is minted for that call. No tool call is refused; completion is rejected instead. A later clean snapshot of the effective target (a hook, a status refresh, completion, or a child-session rollup) mints normally and clears the block.
- **Clearing.** A clean snapshot of the effective target clears the block. The clear applies a local-only readback first, so anything changed while blocked marks its receipts stale before completion.
- **Seeding.** A blocking reason during remote seeding defers every remote scope that has no baseline as `snapshot-blocked`, through the existing seed-deferral record, and then sets the block. The baseline binds later from that operation's own clean before-read.
- **Completion.** A blocked readback, revision drift between completion snapshots, or a block found by a synchronous check just before finalize all return a retryable `rejected / snapshot-blocked`. The rejection has the same shape as the retryable `readback-timeout` rejection: the transition is abandoned and remembered, a terminal entry replays by call ID, and nothing is consumed. The output names the cause, so the agent can fix it even when status shows no block:

```json
{"status":"rejected","reasonCode":"snapshot-blocked","blockReason":"file-limit","blockTarget":"parent-checkout"}
```

  `blockTarget` appears only when the parent checkout of a pinned unit failed. No record is set in that case, because a clean pinned snapshot could never clear it.
- **Finalize staleness.** A finalize-time `stale-receipt` is now a retryable `rejected / stale-receipt`. It writes the terminal entry without `abandonComplete`, because core has already terminalized the transition. Core has also already marked the receipt stale, so a retry is rejected at prepare until fresh evidence exists. A unit whose receipts were minted under the previous worktree digest scheme now gets this retryable rejection at completion, where it used to leave the guard unavailable.

```ts
// finalizeComplete, after a non-success finalizeTransition result
if (reasonCode === 'stale-receipt') {
  finishStaleFinalize(callDigest, pending, output)
  return
}
markUnavailable(afterCause('transition-finalize-rejected', reasonCode))
```

- **What stays fatal.** These keep the `unavailable` path and its first cause:
  - `target-unavailable`
  - command failures
  - unreadable inputs
  - a failure that is not a typed timeout: a throw, a target-digest mismatch, malformed output, and a classifier or parser failure
  - pinned-lookup failures
  - remote-probe failures other than a typed timeout, which seals the one call, and a push whose upstream did not advance, which is sealed (see ARCHITECTURE.md)
  - a change of target identity or registration between completion snapshots
- **Guidance.** The guidance in `skills/using-systematic/SKILL.md` gives the recovery order: read `blockReason` or `snapshotBlock.reasonCode`, fix the cause, call status, rerun stale or missing operations, then complete. It also says:
  - Check remote state before redoing a push or PR.
  - Never delete or hide user files to get under a limit unless the user agrees.
  - If the same block reason remains after one fix, report it to the user.
  - The user-authorized way out is disabling the guard through `systematic_workflow_control`.

## Why This Works

The four reasons describe the tree, not the guard. Fixing the tree removes them. Treating them as terminal handed an agent the off switch. A block keeps the unit enforced. Unobserved operations earn no evidence, and completion cannot pass until a clean snapshot of the same target exists.

Applying the clearing readback, and making finalize staleness retryable, are what make recovery real. Without them, drift made while blocked surfaced first at finalize and took the old terminal path.

Recording only the effective target keeps the block and its clear in the same place. A block that no clear can match is a permanent lock.

## Residual Risks

- Remote side effects made while blocked (a push, a PR) leave no receipt and no status trace. The guidance tells the agent to check remote state before redoing them.
- A blocked snapshot of a target that is not the effective target skips the call without recording a block, so status does not show it.
- Block-and-fix cycles have no attempt cap. Completion rejections are retryable and consume nothing, and the one-fix escalation is the agent's judgment. Disabling the guard still needs the user's answer to an attestation question.
- A snapshot timeout no longer makes the guard unavailable. A before-hook timeout skips the call, an after-hook timeout seals it, a child-rollup timeout halts the pass, a status refresh reports the probe as unconfirmed, and completion rejects it as the retryable `readback-timeout`. The attestation model, the unreceipted-push residual and the rollup residual are in ARCHITECTURE.md and [the transient-timeout doc](./transient-timeout-disables-workflow-guard-2026-10-15.md) (#1084).
- Open: #1126 (ignore rules and other agent-written state can hide work from the snapshot).

## Prevention

- **Classify failures by who can fix them.** A failure the worktree causes, which the agent can repair, should block. Only a failure the guard cannot recover from should be `unavailable`. Review each new observer reason code for which side it falls on.
- **Make every retryable rejection non-consuming and replayable.** Use the shared `rejectCompletion` helper with an explicit `abandon` flag, a `terminalCompletes` entry, and no `markUnavailable`.
- **Keep runtime recovery state out of core status and markers.** Anything that enters the marker digest changes protocol output.
- **Tie a record to the thing that can clear it.** Store the target identity and unit generation. Refuse to set a record that no clear can match, and drop one that no longer matches on read.
- **Test recovery end to end.**
  1. Block.
  2. Shrink the tree with an unobserved operation.
  3. Call status. The block should clear and the receipts should go stale.
  4. Rerun.
  5. Complete. It should succeed.

  Pin each stays-fatal reason with its own test. For concurrency cases, see the test outline in [the async-commit doc](../best-practices/async-commit-aba-version-fence-2026-10-15.md).

## Related Issues

- #1124, #1134. #1084 (snapshot timeouts skip, seal or halt the one call instead of making the guard unavailable), #1126 (open: anchor observer roots and ignore rules so agent-written state cannot hide work).
- [The operation observer reported a changed worktree as unchanged or committed](./operation-observer-false-clean-worktree-2026-10-15.md): the snapshot reasons this fix classifies.
- [Workflow guard digests collapsed long values, and large operation arguments disabled the guard](./workflow-guard-digest-collapse-long-identities-2026-10-14.md): a separate oversized-input path that stays `operation-input-invalid`.
- [Receipt guard missed worktree-targeted child operations](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md): the effective-target and pinned-worktree rules.
- [An async read that commits on return must detect any change made while it waited](../best-practices/async-commit-aba-version-fence-2026-10-15.md): the overtaken-snapshot rule used by the clear.
- [A mutation that fails nothing needs a decision](../best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md): why the finalize branch checks only the reason code.
