---
title: "fix: Do not receipt a verification that overlapped another local call"
type: fix
status: active
date: 2026-10-16
---

# fix: Do not receipt a verification that overlapped another local call

## Overview

A verification receipt says a verification command ran against a stable tree. Today the guard mints one whenever the verification call's own after-hook succeeds. It never checks whether another local call in the same session ran while that call was in flight, so parallel tool calls can produce a misleading receipt (#1131, reproduced by Fro Bot at the adapter boundary):

1. A `bun test` starts at worktree digest D0.
2. A parallel write changes the tree to D1.
3. The tree is restored to D0.
4. The test's after-hook observes D0, and the guard mints a verification receipt.

Part of the test run read D1.

This plan tracks local calls per session and seals a verification that overlapped any of them. Nothing is minted, the guard stays available, and the agent reruns verification alone.

**Terms.**

- *Local call*: a `write`, `edit`, `apply_patch` or `bash` call, as `isLocalOperationTool` defines it.
- *Call key*: `digestCall(ledger, host.callID)`. It is derived from the call ID only, never from arguments.
- *Overlap window* of a verification V: from the first statement of V's `prepareOperation` to V's admission check.
- *Overlap*: either another local call was in flight when V's window opened, or another local before-hook ran during V's window. Calls that run unobserved still count. That covers calls skipped by the observation gate, by a block on the effective target, or by a timeout.
- *Seal*: the existing `sealAndIgnore`. The call is sealed as abandoned, nothing is minted, and a duplicate after-hook stays silent.

## Problem Frame

Verification admission runs in `completeOperationObservation` in `src/lib/opencode-workflow-guard.ts`. It passes through `receipt-classifier.ts` `validateVerification`, which checks only workspace identity, and then into core `observeOperation`. None of these know about other calls in the session. Endpoint digests can't solve this either: a write that is later reverted leaves the before and after digests equal. Verification receipts do not check digest stability, so this overlap check is the only same-session guard on them.

Host behaviour (OpenCode v1.19.0, `anomalyco/opencode` 733b2c62) that the design relies on or works around:

- The host awaits `tool.execute.before` before the tool runs (`packages/opencode/src/session/tools.ts`).
- `tool.execute.after` runs only when the tool succeeds. A tool that throws, is denied, or is interrupted never reaches it, and the host has no cleanup hook.
- The next request, and its system transform, can start while a tool from the previous step is still running. Cleanup waits 250 ms, then marks the tool interrupted, and whether the tool actually stops depends on the tool.
- Call IDs come from the model. The host neither generates them nor rejects duplicates.

## Requirements Trace

- R1. Each session runtime keeps a monotonic local-call sequence and a map of in-flight local calls keyed by call key.
  - Every local `prepareOperation` begins, before the observation gate, by incrementing the sequence. Duplicates of the same call key increment it too.
  - When the call key is not already in the map, the call adds itself and, in the same synchronous step, captures `sequenceAtStart` (read after its own increment) and whether any other call was in flight.
  - A before-hook whose host input can't be parsed increments the sequence when its session can be identified.
- R2. The in-flight entry is removed:
  - at the top of `finishOperation`, after `recoverFromHost` and using the same call key;
  - in the runtime `before()` catch, before either rethrow, when a local tool is rejected.

  `abandonPending` clears the map at the request boundary. The sequence is never reset.
- R3. In `completeOperationObservation`, after the final ownership check and before `observeClassifiedOperation`, with no await between them: if the final operation is `verification` and either another call was in flight at the start of V's window or the sequence has moved since `sequenceAtStart`, the call is sealed with `sealAndIgnore`. The guard is not marked unavailable, and the gate writes no block.
- R4. Everything else is unchanged:
  - non-verification operations;
  - the observation-gate skips, block skips and clears, timeout skips and seals, and push sealing;
  - rollup, and the completion and status readbacks.
- R5. A verification run alone afterwards mints normally.
- R6. Docs and guidance:
  - ARCHITECTURE.md and the using-systematic guard sentence, plus its bootstrap pin, state the rule, its strictness and the residuals.
  - The guidance says: "a verification that overlapped another local call is not receipted; rerun it alone, in a later request if a call in this one failed or is still running."
  - The transient-timeout solution doc qualifies its attestation line.
  - The snapshot-limits doc drops #1131 from its open list.

## Scope Boundaries

- Only verification is gated. Commit and implementation receipts are unchanged. Commit carries no verification evidence: classification is single-valued, and `validateCommit` checks closure.
- The rule is strict. Every overlapping local call counts, read-only bash and other verifications included. So `bun test` running next to `rg` or `git status` is sealed. This fails closed, and the cost is a rerun.
- Duplicate call keys seal every verification in flight, including a duplicated verification. A duplicate means a second execution.
- An overlapped verification still runs its after-hook up to the gate, so a clean after-snapshot can still clear an existing block. That is the existing ordering.
- There is no new status field. A sealed verification that is still required shows up in `missingOperations`.
- **Residuals, documented only:**
  - writers outside the session, and other sessions;
  - child `task` sessions writing the parent tree, since rollup mints a child's verification with no overlap check;
  - tools not tracked as local calls (MCP tools, `multiedit`, formatters);
  - detached background processes started by a local call that has finished;
  - a tool that ignores abort and keeps running into the next request, because the boundary clears its entry;
  - cross-target over-sealing, where a write in one worktree seals a verification in another;
  - an entry left by a tool that threw, was denied or was interrupted, or by a late duplicate before-hook. These over-seal verifications in the same request until the next request boundary.

## Context & Research

### Relevant Code and Patterns

All in `src/lib/opencode-workflow-guard.ts`:

- `createSessionRuntime` owns `pendingOperations`, `skippedOperations` and `abandonedOperations`. The new state lives here too.
- Runtime `before()` calls `recoverFromHost` and then `prepareHostCall` → `prepareOperation`, so the ledger is ready when `prepareOperation` starts.
  - In `prepareOperation`, the local-tool check comes first. Then: the observation gate (`operationObservationApplies`), `currentInitiator`, `argsFingerprint`, `bindCall` (whose `'duplicate'` result returns early), target derivation, `takeBeforeSnapshot`, `remoteIntentForOperation`, and finally `pendingOperations.set`.
  - The runtime `before()` catch rethrows in two places.
- `after()` → `parseHostAfter` → `recoverFromHost` → `finishOperation` → `takeOperationToFinish` → `takePendingOperation` → `completeOperationObservation`.
  - `completeOperationObservation` holds the ownership checks, `captureAfterOperation` with the block settle, `classifyLocalObservation`, the remote capture, the final `ownsOperation`, and `observeClassifiedOperation`.
  - The `after()` catch marks the guard unavailable (`hook-threw`).
- `sealAndIgnore` is the seal primitive. `abandonPending` runs at the request boundary (the system transform).

### Institutional Learnings

- `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`: capture in the same synchronous step that starts the work, keep the counter monotonic, and stop the whole commit when it moves.
- `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`: a skipped call still runs and must be counted.
- `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`: keep this check separate from the block.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: every check needs a test that fails when the check is removed. A check that no test can reach is either dropped or kept with a stated reason.
- `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md`: correlate calls by `callID`, never by their arguments.

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

- **Capture at the very top of `prepareOperation`.** The pending record is written only after the before-hook's awaits, so a writer that starts and finishes during those awaits would be missed if the capture happened there. The host awaits each before-hook before running its tool. That means a writer's tool cannot run until its own before-hook has incremented the sequence.
- **Both a sequence and an in-flight map are needed.** The map catches a writer that was already running when V's window opened. The sequence catches one that began during V's window, including one that finished and was reverted. Neither check alone covers both cases.
- **Every before-hook increments the sequence; only the map add is deduplicated.** A duplicate call key from the model is a second execution, so it must seal a verification that is in flight. Deduplicating the map keeps one entry for each key, so a removal clears it.
- **Remove the entry at the top of `finishOperation`.** At that point the tool has already returned, and the ledger is ready after `recoverFromHost`. A call whose after-hook never runs is cleared at the request boundary, because the host offers no cleanup hook.
- **Clear at the boundary, never keep entries forever.** Keeping entries would let one denied write seal every later verification in the session. Clearing costs coverage of a tool that ignores abort, which is a documented residual.
- **Gate after the final ownership check.** Only the after-hook knows a call is a verification, and only after classification. A lost call is still handled as lost first. No await sits between the gate and admission.
- **Strict.** Exempting commands that look read-only would mean trusting kinds the classifier does not model.
- **No plan labels in code.** Requirement IDs, unit numbers and issue numbers never appear in identifiers or test names.

## Open Questions

### Resolved During Planning

- What gets gated: verification only.
- Strict or refined rule: strict.
- New status field: no.
- Child tasks and rollup: documented residual, with no follow-up issue.
- Commit path: unaffected.
- Boundary clearing: kept.
- Duplicates: they count.

### Deferred to Implementation

- Where the captured start facts live: on `PendingOperation`, or in a side map keyed by call key. A skipped call never mints, so it needs only the counter and the map entry.
- Exact helper names. Keep Biome complexity at 15 or below.
- How to identify the session for an unparseable before-hook. If the session can't be identified, that input is a residual.
- Whether a local before-hook can be rejected by a throw without marking the guard unavailable. If no such path exists, drop the catch removal under the mutation-decision rule.

## Implementation Units

- [ ] **Unit 1: Track local calls and seal an overlapped verification**

**Goal:** A verification that overlapped another local call mints nothing.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add the sequence and the map to `createSessionRuntime`.
- At the top of `prepareOperation` for a local tool, compute the call key and increment the sequence. If the key is new, add it and capture the start facts.
- Carry the start facts to the pending record.
- Increment the sequence for an unparseable before-hook.
- Remove the entry at the top of `finishOperation` and in the runtime `before()` catch.
- In `abandonPending`, clear the map but never reset the sequence.
- Gate as R3 describes.
- Rewrite "a block set on the parent while a call to another worktree is in flight…" so its linked call is a non-verification call that still pins the unit, keeping the test's intent. Use a `write` with `filePath` under `target.linkedRoot`, driven with raw hooks as the test already does. If a write does not pin the unit, use a non-verification bash command that does.

**Execution note:** Test-first. The overlap scenarios need raw interleaved hooks, `sequenceObserver` and `deferredStep`. `observeOperationTool` runs hooks one after another and cannot create overlap. A block-skipped call needs the linked-target fixture (`targetAdapter`).

**Test scenarios:**
- Sealed: nothing minted, the guard is not `unavailable`, and a duplicate after-hook stays silent.
  - A local call is in flight when V's window opens.
  - A local call's before-hook runs after V's `prepareOperation` begins but before V's pending record is written. Hold V's before-snapshot with a deferred step.
  - A local call starts and finishes during V's window, and the tree is restored before V's after-hook. This is the reported reproduction.
  - A bash call overlaps V.
  - A call skipped by a timeout during V's window.
  - A call skipped by a block on the effective target during V's window.
  - Two parallel verifications: both are sealed.
  - Two before-hooks with the same call key: both verifications are sealed.
  - An unparseable before-hook during V's window.
- Mints:
  - a lone verification;
  - a sealed verification followed by a lone rerun in a later request;
  - a local call that finished before V's window opened.
- Edge case: a non-verification call overlapped by another local call still mints its own receipt.
- Edge case: a sealed verification's clean after-snapshot still clears an existing block.
- Edge case: a call denied or interrupted in one request, whose after-hook never runs, seals a verification later in that request. A verification in the next request mints, because the boundary cleared the entry.
- Edge case: if a local before-hook can be rejected by a throw without making the guard unavailable, a later lone verification in the same request mints.
- Integration: a sealed required verification appears in `missingOperations`.
- Integration: restore cases.
  - If the overlapping call's after-hook observed D1, the earlier verification receipt is stale and needs a rerun.
  - If no change was observed, the sealed verification mints nothing and earlier receipts are unchanged.
- Mutation:
  - Removing the sequence comparison fails the during-window tests.
  - Removing the in-flight-at-start check fails the in-flight test.
  - Incrementing only for new call keys fails the duplicate-key test.

**Verification:** The whole guard test file passes, `tests/integration` passes, and each mutation fails the tests named above.

- [ ] **Unit 2: Docs, guidance and bootstrap pin**

**Goal:** Readers and agents learn the rule and its residuals.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `ARCHITECTURE.md`, `skills/using-systematic/SKILL.md`, `tests/unit/bootstrap.test.ts`, `tests/unit/__snapshots__/bootstrap.test.ts.snap`, `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`, `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`

**Approach:**
- ARCHITECTURE.md: in the attestation and parallel-call paragraphs, add the overlap rule, its strictness, the fact that verification receipts do not check digest stability, and the residuals listed in Scope Boundaries.
- SKILL.md: add the R6 clause and regenerate the bootstrap pin.
- Transient-timeout doc: limit the "later observed write plus verification attests the final state" line to work outside the overlap window.
- Snapshot-limits doc: remove #1131 from its open list.

**Test scenarios:**
- Happy path: the bootstrap byte pin and the snapshot pass.

**Verification:** markdownlint, content-integrity and the bootstrap tests pass.

## System-Wide Impact

- **Interaction graph:** the `before()` and `after()` hooks for local tools, `prepareOperation`, `finishOperation`, `completeOperationObservation` and `abandonPending`. Rollup, status and completion are unchanged.
- **Error propagation:** sealing a verification is not a failure. Guard state, causes and markers are unchanged.
- **State lifecycle risks:** a leftover entry can over-seal until the next request boundary. The sequence is runtime state and is lost on restart. That is harmless, because pending calls do not survive a restart either.
- **Unchanged invariants:**
  - receipt and marker protocol versions;
  - revision binding and staleness;
  - every existing skip, seal and block path;
  - non-verification receipts.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A writer during the before-hook's awaits is missed | Capture at the top of `prepareOperation`; the deferred before-snapshot test (Unit 1) |
| Duplicate call keys mint twice | Every before-hook increments the sequence; the duplicate-key test (Unit 1) |
| Over-sealing slows agents | Strict by design; guidance says to rerun alone or in a later request (Unit 2) |
| A leftover entry over-seals | Early removal and the boundary clear; the denied-call test (Unit 1) |
| A tool outlives its request | Documented residual (Unit 2) |
| Child tasks write during a parent verification | Documented residual (Unit 2) |

## Sources & References

- Issue #1131, with Fro Bot's triage. Related: #1084, #1124, #1105.
- Related code: `src/lib/opencode-workflow-guard.ts`, `src/lib/receipt-classifier.ts`, `src/lib/workflow-guard.ts`.
- Host source: `anomalyco/opencode` v1.19.0, `packages/opencode/src/session/tools.ts`, `processor.ts`, `llm/request.ts`.
