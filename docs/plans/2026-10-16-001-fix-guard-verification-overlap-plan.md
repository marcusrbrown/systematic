---
title: "fix: Do not receipt a verification that overlapped another local call"
type: fix
status: active
date: 2026-10-16
---

# fix: Do not receipt a verification that overlapped another local call

## Overview

A verification receipt says a verification command ran against a stable tree. Today the guard mints one whenever the verification call's own after-hook succeeds. It never checks whether another local operation in the same session ran while the call was in flight. With parallel tool calls this allows a misleading receipt, a case Fro Bot reproduced at the adapter boundary (#1131):

1. A `bun test` starts at worktree digest D0.
2. A parallel write changes the tree to D1.
3. The tree is restored to D0.
4. The test's after-hook observes D0, and the guard mints a verification receipt.

Part of the test run read D1.

This plan tracks local operations per session. A verification that overlapped any other local call is sealed: nothing is minted, the guard stays available, and the agent reruns verification alone.

**Terms.**

- *Local call*: a `write`, `edit`, `apply_patch` or `bash` call, as defined by `isLocalOperationTool`.
- *Overlap*: another local call was in flight when the verification's before-hook began, or another local call's before-hook began while the verification was in flight. Calls that were skipped, blocked, timed out, or made in an inactive session all count, because they still run.
- *Seal*: the existing `sealAndIgnore`. The call is sealed as abandoned, nothing is minted, and a duplicate after-hook stays silent.

## Problem Frame

Verification admission runs in `completeOperationObservation` in `src/lib/opencode-workflow-guard.ts`. It goes through `receipt-classifier.ts` `validateVerification`, which checks workspace identity only, and then into core `observeOperation`. None of these know about other calls in the session.

Endpoint digests can't solve this either: a write that is reverted produces identical before and after digests. The existing serial test that mints verification across differing digests stays valid.

## Requirements Trace

- R1. Each session runtime keeps a monotonic local-call sequence and a map of in-flight local calls keyed by call digest. The first statement of `prepareOperation` for a local tool, before the observation gate, adds the call and increments the sequence. This happens only when the digest is new, so a duplicate before-hook neither double-counts nor seals itself. In the same synchronous step, the call captures `sequenceAtStart` (read after its own increment) and whether any other call was in flight.
- R2. The in-flight entry is removed:
  - in `after()` right after the host input is parsed, before any await;
  - in the `before()` catch for a local tool;
  - by `abandonPending`, which clears the map.
  The sequence is never reset.
- R3. In `completeOperationObservation`, beside the final ownership check, after classification and the last await and before admission, the call is sealed with `sealAndIgnore` if both of these hold:
  - the final operation is `verification`;
  - another call was in flight at start, or the sequence has moved since `sequenceAtStart`.
  The guard is not marked unavailable, and no block is written by the gate.
- R4. Non-verification operations are unaffected, as is every existing path: #1105 skips, #1124 block skips and clears, #1084 timeout skips and seals, push sealing, rollup, completion and status readbacks.
- R5. A verification run alone afterwards mints normally.
- R6. Docs and guidance:
  - ARCHITECTURE.md;
  - the using-systematic guard sentence, plus its bootstrap pin;
  - the transient-timeout and snapshot-limits solution docs.
  They state the rule, that over-sealing is strict, and the residuals. Guidance tells the agent that a verification which overlapped another local call is not receipted, and to rerun it alone.

## Scope Boundaries

- Only verification is gated. Commit and implementation receipts are unchanged. Commit carries no verification evidence: classification is single-valued, and `validateCommit` checks closure.
- The rule is strict. Every overlapping local call counts, including read-only bash and other verifications, so `bun test` running beside `rg` or `git status` is sealed. This fails closed, and the cost is a rerun.
- No new status field. A required verification that was sealed shows up in `missingOperations`.
- **Residuals, documented only:**
  - writers outside the session, other sessions, and child `task` sessions writing the parent tree (rollup mints a child's verification without an overlap check);
  - tools that are not tracked as local operations (MCP tools, formatters);
  - cross-target over-sealing, where a write in one worktree seals a verification in another;
  - an entry left in flight by a tool whose after-hook never fires (denied or errored), which can over-seal a parallel verification until the next request boundary.

## Context & Research

### Relevant Code and Patterns

All in `src/lib/opencode-workflow-guard.ts`:

- `createSessionRuntime` owns `pendingOperations`, `skippedOperations` and `abandonedOperations`. The new state lives here too.
- `prepareOperation`:
  - The local-tool check comes first, then the #1105 gate `operationObservationApplies`, `currentInitiator`, `argsFingerprint`, `bindCall`, target derivation, `takeBeforeSnapshot` and `remoteIntentForOperation`.
  - `pendingOperations.set` happens only after those awaits, so the overlap capture must happen before them.
- `before()` and its catch; `after()` → `parseHostAfter` → `recoverFromHost` → `finishOperation` → `takeOperationToFinish` → `takePendingOperation` → `completeOperationObservation`.
- `completeOperationObservation`: this function contains the ownership checks, `captureAfterOperation`, `classifyLocalObservation`, the remote capture, the final `ownsOperation`, and `observeClassifiedOperation`. `sealAndIgnore` is the seal primitive.
- `abandonPending` runs at the system transform (the request boundary).
- `PendingOperation` gets the captured overlap facts.

### Institutional Learnings

- `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`: capture in the same synchronous step as the work starting, use a monotonic counter, and stop the whole commit on change.
- `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`: skipped calls still run and must be counted. Its attestation lines hold only outside the overlap window.
- `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`: keep this separate from the block.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: both the sequence check and the in-flight check need a test that fails when they are removed.
- `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md`:
  - correlate calls by `sessionID` + `callID`, never by arguments;
  - the after-hook runs only when the tool returned.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib (opencode-workflow-guard.ts, workflow-guard.ts, receipt-classifier.ts) at e97c59f7",
  "freshness": { "vcs_reference": "e97c59f7" },
  "budget": { "max_search_passes": 16, "max_candidate_inspections": 30, "exhausted": false },
  "candidates": [
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:sealOperation, sealAndIgnore", "description": "Seals a call as abandoned and returns ignored: nothing minted, no unavailable mark, duplicate after-hook silent.", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:operationObservationApplies", "description": "Observation gate; skipped calls go to skippedOperations. The overlap counter must sit above it.", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:pendingOperations, takePendingOperation", "description": "Per-call pending record set after the before-hook awaits and deleted before admission; cannot serve as the in-flight set.", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:skippedOperations, abandonedOperations, abandonPending", "description": "Records skipped and abandoned calls; abandonPending clears them at the request boundary and must clear in-flight entries too.", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:unitStartGeneration, currentInitiator, ownsOperation", "description": "Unit-level ownership; orthogonal to a session-level call sequence.", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:snapshotBlockVersion", "description": "Version fence for the snapshot block; capture-before-await pattern reusable, field not.", "disposition": "insufficient", "insufficiency_reason": "Bumps only on snapshot-block and unit-start changes, so it cannot observe local call start or finish." },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:createSessionRuntime", "description": "Per-session runtime owning the call bookkeeping; child sessions get separate runtimes.", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:rollupForegroundTask, observeTrustedRecoveredOperation", "description": "Child rollup mints child receipts with verification accepted through a trusted path.", "disposition": "insufficient", "insufficiency_reason": "No overlap check; documented as a residual in this plan." },
    { "path_or_symbol": "src/lib/receipt-classifier.ts:validateVerification", "description": "Checks workspace identity only for verification.", "disposition": "insufficient", "insufficiency_reason": "Receives one observation and cannot know about concurrent calls." },
    { "path_or_symbol": "src/lib/workflow-guard.ts:processOperation, finalizeOperation", "description": "Core admission and minting; holds no per-session call history.", "disposition": "reuse" }
  ]
}
```

## Key Technical Decisions

- **Capture at the very top of `prepareOperation`.** The pending record is written after the before-hook's awaits. A writer that starts and finishes during those awaits would be missed if the capture happened there. Before-hooks run their synchronous prefix in order, so a writer's tool cannot run until its own before-hook has counted it.
- **The sequence and the in-flight map are both needed.** The map catches a writer that was already pending when the verification began. The sequence catches one that began, and maybe finished and was reverted, during the verification. Neither one alone covers both.
- **Gate at admission, not earlier.** Only the after-hook knows a call is a verification, and only after classification. The gate sits after the last await so that no writer can slip in between the check and the mint.
- **Strict.** Exempting read-only commands would mean trusting command kinds the classifier doesn't model. Exempting verification-intent calls would help little, because plain `rg`, `cat` and `git diff` still count.
- **Remove an entry early on the after-hook path.** A throw after parsing must not leave the entry behind. An entry left by a tool whose after-hook never runs is cleared at the request boundary.
- **No plan labels in code.** Requirement IDs, unit numbers and issue numbers never appear in code identifiers or test names.

## Open Questions

### Resolved During Planning

- Gate verification only: yes.
- Strict or refined: strict.
- New status field: no.
- Child tasks and rollup: documented as a residual. No follow-up issue.
- Commit path: unaffected.

### Deferred to Implementation

- Whether the overlap facts live on `PendingOperation` or in a side map keyed by digest. Skipped calls never mint, so they need the counter and map entry but not the captured facts.
- Exact helper names, as long as Biome complexity stays at 15 or below.

## Implementation Units

- [ ] **Unit 1: Local-call sequence and in-flight tracking**

**Goal:** Count every local call and track which ones are in flight. No behaviour changes yet.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add the sequence and the map to `createSessionRuntime`.
- At the top of `prepareOperation` for a local tool, compute the call digest. If it is new, add it, increment, and capture the start facts. Carry those facts through to the pending record.
- Remove the entry in `after()` right after parsing, and in the `before()` catch for local tools.
- `abandonPending` clears the map but never resets the sequence.
- Expose nothing new on the public interface. Tests observe the effect through Unit 2.

**Execution note:** Test-first, through Unit 2's behaviour. This unit and Unit 2 may land as one commit if splitting them makes the RED tests impossible to write.

**Test scenarios:**
- Edge case: a duplicate before-hook for the same call increments nothing, and its verification still mints when run alone.
- Edge case: a call skipped by the observation gate (inactive session) still counts. A verification overlapping it in an active session is sealed.

**Verification:** The guard suites pass unchanged.

- [ ] **Unit 2: Seal an overlapped verification**

**Goal:** A verification that overlapped another local call mints nothing.

**Requirements:** R3, R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Beside the final `ownsOperation` check in `completeOperationObservation`, check the condition in R3 when `finalObservation.operation` is `verification`.
- If it holds, call `sealAndIgnore`.
- The earlier after-hook steps (snapshot, block settle) run unchanged.

**Execution note:** Test-first. Rewrite the test "a block set on the parent while a call to another worktree is in flight…" so its linked call is a non-verification write that pins the worktree. That keeps the test's original intent, and the new overlap tests cover sealing.

**Test scenarios:**
- Happy path, sealed (nothing minted, guard not `unavailable`, duplicate after-hook silent):
  - write B starts before verification A and is still in flight at A's start;
  - write B starts and finishes during A, with the tree restored before A's after-hook (the issue's reproduction);
  - a bash writer during A;
  - a skipped writer during A, either blocked or timed out;
  - two parallel verifications, both sealed.
- Happy path, still mints:
  - a lone verification;
  - a sealed verification followed by a lone rerun;
  - a writer that finished before A started.
- Edge case: a non-verification call overlapped by a writer still mints its own receipt, for example implementation.
- Edge case: a sealed verification's clean after-snapshot still clears a #1124 block.
- Edge case: an after-hook that throws after parsing leaves no in-flight entry, so a later lone verification mints.
- Edge case: a transform mid-call clears the map. A verification that starts after the boundary is not sealed by the earlier call.
- Integration:
  - Overlap does not leave earlier receipts invalid when the tree is restored and the restore was never observed.
  - When the writer's after-hook observed D1, the earlier verification is stale and needs a rerun.
- Mutation:
  - removing the sequence comparison fails the during-A tests;
  - removing the in-flight check fails the started-before-A test;
  - incrementing on a duplicate before-hook fails the duplicate test.

**Verification:** The whole guard test file and `tests/integration` pass, and the mutation proofs fail the named tests.

- [ ] **Unit 3: Docs, guidance and bootstrap pin**

**Goal:** Readers and agents learn the rule and its residuals.

**Requirements:** R6

**Dependencies:** Unit 2

**Files:**
- Modify: `ARCHITECTURE.md`, `skills/using-systematic/SKILL.md`, `tests/unit/bootstrap.test.ts`, `tests/unit/__snapshots__/bootstrap.test.ts.snap`, `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`, `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`

**Approach:**
- ARCHITECTURE.md: in the attestation and parallel-call paragraphs, add the overlap rule, strictness, and the residuals listed in Scope Boundaries.
- SKILL.md: add one clause: "a verification that overlapped another local call is not receipted; rerun it alone." Regenerate the bootstrap pin.
- Transient-timeout doc: qualify the "later observed write plus verification attests the final state" line so it applies only outside the overlap window.
- Snapshot-limits doc: drop #1131 from its open list.

**Test scenarios:**
- Happy path: the bootstrap byte pin and snapshot pass.

**Verification:** markdownlint, content-integrity and bootstrap tests pass.

## System-Wide Impact

- **Interaction graph:** the `before()`/`after()` hooks for local tools, `prepareOperation`, `completeOperationObservation` and `abandonPending`. Rollup, status and completion are unchanged.
- **Error propagation:** a sealed verification is not a failure. The guard state, causes and markers are unchanged.
- **State lifecycle risks:**
  - An entry left in flight by a tool whose after-hook never fires can over-seal until the request boundary.
  - The sequence is runtime state, so a restart drops it. That is harmless, because pending calls do not survive a restart either.
- **Unchanged invariants:** receipt and marker protocol versions, revision binding and staleness, every existing skip, seal and block path, and non-verification receipts.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A writer during the before-hook's awaits is missed | Capture at the top of `prepareOperation` (Unit 1), with a during-A test (Unit 2) |
| Duplicate before-hook seals itself | Increment only on a new digest, with a test and mutation (Unit 2) |
| Over-sealing slows agents | Strict by design; guidance says rerun alone (Unit 3) |
| Leaked entry over-seals | Early removal in `after()` and in the `before()` catch, plus boundary clear, with a throw test (Unit 2) |
| Child tasks write during a parent verification | Documented residual (Unit 3) |

## Sources & References

- Issue #1131 (with Fro Bot triage). Related: #1084, #1124, #1105.
- Related code: `src/lib/opencode-workflow-guard.ts`, `src/lib/receipt-classifier.ts`, `src/lib/workflow-guard.ts`.
