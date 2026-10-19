---
title: An async read that commits on return must detect any change made while it waited
date: 2026-10-15
last_updated: 2026-10-17
category: best-practices
module: workflow-guard
problem_type: design_pattern
component: development_workflow
severity: medium
applies_when:
  - "Hook or adapter code captures shared state, awaits an observer or remote probe, then commits a result"
  - "Other hooks or parallel tool calls can write the same shared record during that await"
  - "The commit has side effects beyond the primary write, such as probes or receipt invalidation"
symptoms:
  - "A stale readback was applied after a newer block or recovery had already run"
  - "A superseded seed deleted a deferral that a newer seed had recorded"
  - "A block set and cleared during an await went unnoticed, so obsolete evidence was applied"
  - "An operation observation finalized against a unit redeclared while its classifier ran"
root_cause: async_timing
resolution_type: code_fix
tags: [workflow-guard, aba-race, async-commit, monotonic-version, stale-readback, ownership-token, concurrency-race, deferred-observer-test]
status: superseded
superseded_by: docs/solutions/best-practices/workflow-guard-removed-2026-10-19.md
superseded_date: 2026-10-19
---

> **Superseded (2026-10-19):** the workflow guard this learning describes was removed ([#1153](https://github.com/marcusrbrown/systematic/issues/1153)); see [the decision note](workflow-guard-removed-2026-10-19.md). The pattern below, that a read which commits on return must detect any change made while it waited, still applies. The body below is preserved as history.

# An async read that commits on return must detect any change made while it waited

## Context

The OpenCode guard adapter (`src/lib/opencode-workflow-guard.ts`) runs hooks concurrently. OpenCode issues parallel tool calls. Each hook awaits an observer, either `snapshot()` or a remote probe, and then commits to shared session state. The bundled observer is synchronous today. The observer contract allows promises, though, and the unit tests drive races through deferred steps.

The [snapshot block](../logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md) (#1124, #1134) added a shared record that several hooks set and clear. These interleavings surfaced one at a time, and each fix covered only the case it named:

1. **A stale clear still applied its snapshot.** The status refresh correctly saw that its clear was stale. It then fell through anyway: it applied the obsolete readback and probed remotes. That could invalidate receipts that had just been rerun.
2. **A superseded seed deleted a newer deferral.** An older remote seed read was suspended across a same-unit redeclaration. When it returned `missing-resource`, it ran an unconditional `clearSeedDeferral`. That removed the `snapshot-blocked` deferral the newer seed had recorded.
3. **The read started with no block, and a block was set during the await.** The capture was `undefined` and the current record was defined.
4. **ABA.** The read started with no block. Another read set `file-limit`, and a clean read cleared it, all before the original snapshot returned. Capture and current state were both `undefined`, so the refresh applied obsolete evidence. A satisfied `verification` flipped to `stale-receipt`.

The general rule: any change during the await invalidates the read.

## Guidance

- **Capture in the same synchronous segment as the call that starts the await.** `readSnapshot` calls `observer.snapshot()` before its first `await`. So a capture taken just before `await readSnapshot(...)` sees exactly the state the read started from.
- **Fence with a monotonic version, not identity or presence.** Comparing the record object, or checking for `undefined`, misses set-then-clear. Give the shared state a counter that only goes up and is never reset, and bump it on every change.
- **Put the bump in one write helper.** Every set, clear and drop goes through it, so no writer can forget. Where a reset happens beside a separate bump (the unit start below), keep the two together and comment the pairing.
- **A stale result stops the whole commit.** That includes secondary effects such as remote probes. Report what was skipped, here as `unconfirmedReadbacks`, instead of silently skipping only the primary write.
- **Long-running reads that mutate shared bookkeeping carry an ownership token** (generation, initiator or version). Check the token right after the await and before every mutation, deletes included.
- **Check inside every catch that writes.** A check placed after the await runs too late for a catch that records an issue first.
- **Check staleness before any other outcome.** A stale read that also failed, or returned nothing, is stale first. Otherwise it reports a fault that belongs to the old state.
- **Bump after the state actually changes.** A bump placed before an early return for an unchanged value makes a no-op call supersede work in flight.
- **Bump at every change an in-flight read can observe, and nowhere else.** A bump at a site no in-flight read can reach is a check no test can fail ([a mutation that fails nothing](./a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md)); say in a comment why the other sites are unreachable.
- **Test the interleaving, then assert its consequences.** Hold a read open with a deferred observer step, mutate during it, then release. Assert what a user would see: receipts unchanged, no probe ran, the skip is reported. Asserting only that the block survived is not enough. Mutation-check the fence.

## Why This Matters

Each local fix closed one interleaving and left the next one open. One version fence covers all four cases. The cost of a miss is evidence integrity. An obsolete readback marks fresh receipts stale, or skips staleness that should apply. An overtaken probe can also turn a recoverable block into terminal `unavailable`.

## When to Apply

- An async function reads external or shared state, then writes shared state when it returns.
- The await can yield to hooks or tool calls that change the same state.
- The commit invalidates evidence, runs probes, or deletes bookkeeping.

Not needed when capture and commit sit in one synchronous segment with no await between them.

## Examples

The single write helper, and the reset paired with its own bump (`src/lib/opencode-workflow-guard.ts`):

```ts
function writeSnapshotBlock(record: SnapshotBlockRecord | undefined): void {
  snapshotBlockRecord = record
  snapshotBlockVersion += 1
}

// startFreshUnit: every successful start, including a same-unit redeclaration
if (result.status === 'started') {
  unitStartGeneration += 1
  snapshotBlockVersion += 1
  // ...also clears firstUnavailableCause, and on a different unitId resets the seed-deferral and block records
}
```

The status refresh captures the version in the same synchronous segment as the snapshot. It compares the version before it applies anything:

```ts
// refreshReadback
const blockCapture = captureSnapshotBlock()
const blockVersion = snapshotBlockVersion
const generation = unitStartGeneration
const read = await readSnapshot(effective.observer, effective.targetIdentity)

// applyRefreshSnapshot
if (snapshotBlockVersion !== blockVersion) return skipped()
```

On the seed path, the ownership check runs before anything is classified, applied or deleted (binding a deferred baseline later is gated by the operation's initiator instead):

```ts
// seedRemoteScope
const result = await readRemoteScope(reader, operation, 'before')
if (generation !== unitStartGeneration) return { kind: 'superseded' }

// seedEachRemoteScope (abbreviated)
if (outcome.kind === 'superseded') return undefined
if (outcome.kind === 'fatal') return outcome.cause
clearSeedDeferral(operation)
```

Why identity misses ABA. This is illustrative, not the shipped code:

```ts
// identity fence: capture undefined, set A, clear -> undefined === undefined, applies stale read
const overtaken = currentSnapshotBlock() !== captured
// version fence: 0 -> 1 -> 2, compare fails, read skipped
const overtaken = snapshotBlockVersion !== capturedVersion
```

The core applies a version fence to an operation observation that awaits its classifier (`src/lib/workflow-guard.ts`, #1083). It fences declaration changes only: a changed redeclaration, the unit's completion and a real mode change. Before the fix, a same-ID redeclaration during that await let the observation finalize against the new declaration, so a receipt could be minted under it. Sibling calls that move resource identities or write unit evidence during the same await are still not fenced (`ARCHITECTURE.md`, Other residuals).

A monotonic `declarationGeneration` is bumped by a changed redeclaration in `startActiveUnit`, by the unit's completion in `finalizePrepared`, and by a real mode change in `setMode`. The `setMode` bump sits after the same-mode early return. Unit replacement, epoch completion, activation and restore do not bump it: replacement and epoch completion need a completed unit, which already bumped, and activation and restore need a completed or absent epoch.

`processOperation` captures the generation before the await. `classifyPreparedOperation` compares it inside its catch, before it records anything, and reports `stale`. `settleClassifiedOperation` compares it first, before the no-verdict branch:

```ts
// settleClassifiedOperation
if (outcome.kind === 'stale' || generation !== declarationGeneration) {
  return supersedeOperation(parsed, input)
}
if (outcome.kind === 'unclassified') {
  return { status: 'rejected', reasonCode: 'guard-unavailable' }
}
return finalizeOperation(parsed, input, unit, outcome.classification)
```

`supersedeOperation` abandons the prepared observation, marks the call terminal, and returns `rejected` / `declaration-superseded`. Nothing is minted and no issue is recorded. The adapter seals that result and ignores the call. `unitStartGeneration` in the adapter cannot replace it: completion and mode changes do not touch it. The call is terminal, so the unit is no longer pristine: a later changed redeclaration of that unit returns `unit-active`, as after any accepted or rejected observation.

Tests in the `operation observations that outlive their declaration` describe block of `tests/unit/receipt-operations.test.ts` hold the classifier with a gate that signals when classification has started, change the declaration or mode while it is held, then release it as a verdict, a throw or no verdict. The superseding cases share a no-change control that is accepted and mints; the no-verdict case has its own no-change control, which reports `guard-unavailable`; a same-mode `setMode` control stays accepted.

Test outline. These are the deferred-step tests in `tests/unit/opencode-workflow-guard.test.ts`, such as "a status snapshot taken with no block, then a block set and cleared before it returns, applies no readback and probes no remote".

1. Mint real evidence at known revisions.
2. Start `refreshStatus` on a `deferredStep` snapshot of a revision no receipt was minted at. Wait until the step is consumed.
3. Set the block through a real blocked hook, then clear it with a clean status read.
4. Record the remote-call count, then release the held snapshot.
5. Assert the following:
   - `satisfiedOperations` is unchanged.
   - The remote-call count is unchanged.
   - `unconfirmedReadbacks` lists `local` and `push`.
   - The guard is not `unavailable`.
6. Mutate the version compare away. Both overtaken tests fail. Restore and `cmp`.

## Related

- [Worktree snapshot limits turned workflow guard enforcement off for the session](../logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md): the snapshot block this fence protects.
- [The operation observer reported a changed worktree as unchanged or committed](../logic-errors/operation-observer-false-clean-worktree-2026-10-15.md): the same "change during the read" concern inside one snapshot, solved there with a final re-check pass.
- [A mutation that fails nothing needs a decision](./a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md).
- [A verification that overlapped another local call could still mint a receipt](../logic-errors/verification-overlap-mints-receipt-2026-10-17.md): the same capture-before-await rule, applied to verification receipts, which describe a whole run.
- #1083, fixed in #1144: a classifier race on same-ID redeclaration, fenced by the core declaration generation above. The seed-side half is in [the propagated-baseline doc](../logic-errors/propagated-baseline-hid-seed-timeout-2026-10-17.md).
