---
title: "fix: Fence core operation observations against redeclaration and keep seed timeouts visible"
type: fix
status: active
date: 2026-10-17
---

# fix: Fence core operation observations against redeclaration and keep seed timeouts visible

## Overview

Two gaps in workflow-guard operation admission (#1083), both reproduced by Fro Bot's triage.

1. The core guard awaits the classifier inside `observeOperation` and then finalizes against the unit object it captured on entry. A same-ID redeclaration during that await mutates the unit in place, so the observation finalizes against a declaration it was never checked against. Fro Bot minted a verification receipt under a declaration that had changed to `[push]`.
2. When a pull-request-creation seed has already propagated the check and review baselines, a later check or review seed timeout records no deferral. Status does not explain the missing operation, and the before-read loses its one retry.

## Problem Frame

The adapter (`src/lib/opencode-workflow-guard.ts`) already fences its own awaits with `unitStartGeneration` and seals a lost operation with `sealAndIgnore`. The core (`src/lib/workflow-guard.ts`) has no equivalent, and the classifier await in `processOperation` is the one window the adapter cannot see. Unit completion during that await is likewise invisible to the adapter, because completion changes none of the adapter's initiator fields.

On the seed side, `recordSeedDeferral` returns early whenever the core holds any baseline for the operation. A propagated pull-request baseline is not the operation's own evidence, but it suppresses the deferral record, and the one-time before-read retry is keyed on that record. `bindDeferredBaseline` also clears a deferral unconditionally whenever a baseline exists, which hides a timeout recorded before propagation.

## Requirements Trace

- R1. An observation whose unit declaration changed, whose unit completed, or whose guard mode changed while the classifier was awaited mints nothing, records no issue or cause, and leaves the guard available. The adapter seals it and ignores the call.
- R2. The classifier-throw path applies the same fence before it writes anything.
- R3. An unchanged redeclaration (same IDs, same declaration) does not disturb an in-flight observation.
- R4. A seed timeout for an operation the unit did not declare is recorded even when a baseline was propagated from another operation, and the one-time before-read retry applies to it.
- R5. With a propagated baseline present, a deferral clears only when the operation's own before-read is `available`. Admission still rejects mismatched evidence, and propagated baselines are never overwritten.
- R6. Every new check fails a named test when removed.

## Scope Boundaries

- Remote-evidence redesign (#1081), cross-registration coordination (#1090), restart-proof anchors (#1126) and receipt hardening (#740) are out of scope.
- Resource identities moved by sibling readbacks during the classifier await are not fenced. That is pre-existing and stays a residual.
- Operations the unit declared keep today's behaviour: a declared baseline still exempts them from deferral.

## Context & Research

### Relevant Code and Patterns

- Core path: `observeOperation` → `processOperation` → `classifyPreparedOperation` (the only await) → `finalizeOperation`. A rejection that mints nothing already exists as `abandonPreparedOperation` + `markTerminalOperation` on the classifier-throw path.
- Redeclaration: `startActiveUnit` mutates `requiredOperations`, `declaredResourceOperations`, `resourceScopes` and `currentResourceIdentities` in place. An identical redeclaration returns `unit-active` before any mutation.
- Completion: the unit branch of `finalizePrepared`. Mode: `setMode`, reached from the adapter's `markUnavailable`.
- Adapter result mapping in `completeOperationObservation`: any non-accepted, non-`unavailable` result seals the call as abandoned and returns `ignored`.
- Seed: `recordSeedDeferral`, `bindDeferredBaseline`, `deferredSeedFor`, the one-time retry in the before-read, and `propagatePullRequestScope` in the core. The status `unit.requiredResourceOperations` lists declared resource operations, including runtime scopes and a declared `pr-creation`.
- Pattern: a monotonic, never-reset version captured before an await and compared after it, as in `snapshotBlockVersion` and `unitStartGeneration`.

### Institutional Learnings

- `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`: capture the fence synchronously before the await, and reject a stale result before any side effect. This doc lists #1083 as open.
- `docs/solutions/logic-errors/verification-overlap-mints-receipt-2026-10-17.md` and `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`: a lost or stale operation is sealed and ignored, with no cause and no `unavailable`.
- `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`: the seed fix stays deferral bookkeeping. Binding comes only from the operation's own before-read, and there are no compare-only readbacks.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: a check that no test can reach is removed or justified, never kept silently.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/workflow-guard.ts, src/lib/opencode-workflow-guard.ts, src/lib/receipt-ledger.ts, tests/unit/receipt-operations.test.ts, tests/unit/opencode-workflow-guard.test.ts, ARCHITECTURE.md guard section",
  "freshness": {
    "vcs_reference": "68baf740d501f373be8287756219f394f32a61fd"
  },
  "budget": {
    "max_search_passes": 6,
    "max_candidate_inspections": 12,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:unitStartGeneration, currentInitiator, ownsOperation, sealAndIgnore",
      "description": "Adapter-side monotonic declaration token and the seal-and-ignore path for a lost operation",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:snapshotBlockVersion",
      "description": "Monotonic never-reset version fence captured before an await",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:startActiveUnit, finalizePrepared, setMode",
      "description": "The reachable points that change what an in-flight observation was admitted against",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:processOperation, classifyPreparedOperation, finalizeOperation",
      "description": "Observation pipeline whose only await is the classifier",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:propagatePullRequestScope, hasResourceBaseline",
      "description": "Pull-request propagation of check and review baselines; behaviour kept",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:recordSeedDeferral, bindDeferredBaseline, deferredSeedFor",
      "description": "Per-unit seed deferral record, its clearing rules and the one-time retry",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/receipt-ledger.ts:prepareObservation, abandonObservation",
      "description": "Per-call observation lifecycle; abandon is the seal for a stale observation",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:overlappedAnotherLocalCall",
      "description": "Overlap gate for verification over local calls",
      "disposition": "insufficient",
      "insufficiency_reason": "Tracks local tool calls in flight, not unit declaration identity, so it cannot detect a same-ID redeclaration."
    },
    {
      "path_or_symbol": "tests/unit/receipt-operations.test.ts:createScenario, operationInput, bindOperation",
      "description": "Core fixture that accepts an injected classifier; a gated classifier fits it",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "tests/unit/opencode-workflow-guard.test.ts:sequenceObserver, deferralAdapter, statusParsed",
      "description": "Scripted seed and before-read observer with per-key remote results",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **A core declaration generation, not a refusal to redeclare.** Refusing a redeclaration while an observation is in flight would need in-flight tracking and a new start result the agent sees. The generation is captured and compared, as the version-fence doc prescribes.
- **Bump only where it is reachable.** Bump on a changed declaration in `startActiveUnit`, on unit completion in `finalizePrepared`, and on a mode change in `setMode`. Unit replacement, epoch completion, activation and recovery cannot happen while an observation is in flight: replacement and epoch completion require a completed unit, and activation and recovery require no live epoch. Bumps there would be mutants no test can kill.
- **Capture in `processOperation`.** It is shared by `observeOperation` and the trusted recovery path. The trusted path has no await, so it can never be stale.
- **The throw path checks inside the classifier's catch.** The catch records a unit issue before it returns, so a recheck after the await is too late. `classifyPreparedOperation` receives the captured generation and reports a stale result distinctly.
- **Stale result: `rejected` with a new `declaration-superseded` code.** The core abandons the observation and marks the call terminal, and writes nothing else. `unit-mismatch` would also work functionally, but its existing producer records an issue, and a same-ID redeclaration is not a unit mismatch. The new code is added to the core's reason-code union only. The adapter needs no change, because it seals any non-accepted result and returns `ignored`.
- **Seed gate exempts declared operations only.** `recordSeedDeferral` skips an operation only when the unit declared its resource scope (`requiredResourceOperations`). A propagated baseline no longer suppresses the record, and the retry follows the record without further change.
- **Bind with a baseline present clears on the operation's own `available` before-read.** Admission then rejects a mismatched resource as `resource-mismatch`, as it does today. The deferral stays on timeout, unavailable or missing reads. No new core accessor, and `observeReadback` is never called on this path, so a propagated baseline is never overwritten.

## Open Questions

### Resolved During Planning

- Stale observation outcome: sealed and ignored, guard available (confirmed).
- One PR for both parts, closing #1083 (confirmed).
- Bind rule, reason code and mode fence: as above (confirmed).

### Deferred to Implementation

- The exact shape of the stale signal from `classifyPreparedOperation`. It must stay distinguishable from "no classification", which still returns `guard-unavailable`.
- Whether the reason-code union feeds a schema, a status renderer or a docs list that also needs the new code. The implementer checks every consumer.

## Implementation Units

- [ ] **Unit 1: Fence core observations with a declaration generation**

**Goal:** An observation finalizes only against the declaration, unit state and mode it started with.

**Requirements:** R1, R2, R3, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/workflow-guard.ts`
- Test: `tests/unit/receipt-operations.test.ts`
- Test: `tests/unit/workflow-guard.test.ts` (only if the unit-completion helper lives there)

**Approach:**
- Add a monotonic, never-reset generation to the guard closure. Bump it on a changed declaration in `startActiveUnit`, unit completion in `finalizePrepared`, and a mode change in `setMode`. Each bump site gets a one-line comment. Note in one place why the other replacement sites cannot occur while an observation is in flight.
- Capture the generation at the top of `processOperation`. Compare it after the classifier await, before `finalizeOperation`, and inside the classifier catch before any write.
- On stale: abandon the prepared observation, mark the call terminal, and return `rejected` / `declaration-superseded`. Record no issue, no global issue and no cause.
- Add `declaration-superseded` to the core reason-code union and to any consumer the implementer finds.

**Execution note:** Implement test-first. Add the gated-classifier race test and confirm it is RED on the current core before changing the source.

**Patterns to follow:**
- `snapshotBlockVersion` and `unitStartGeneration` in `src/lib/opencode-workflow-guard.ts`.
- The existing classifier-throw handling in `classifyPreparedOperation` for abandon and terminal marking.

**Test scenarios:**
- Happy path: a gated classifier; redeclare the active unit with the same IDs and a changed declaration while it is suspended; release. The result is `rejected` / `declaration-superseded`, no receipt is minted, `satisfiedOperations` lacks the operation, and the guard is not `unavailable`.
- Happy path: a gated classifier with no redeclaration. The result is accepted and a receipt is minted (control).
- Edge case: an identical redeclaration (same IDs, same declaration) during the await returns `unit-active`, and the observation is still accepted.
- Edge case: the unit completes during the await. The observation mints nothing.
- Edge case: the guard mode changes during the await. The observation mints nothing.
- Error path: the classifier throws after a redeclaration. No unit issue or `guard-unavailable` is recorded on the new declaration, and the guard is not `unavailable`.
- Edge case: replaying the same call after a stale result returns the terminal `rejected-operation`, and nothing is minted.
- Edge case: after a stale seal, a later redeclaration returns `unit-active`, the same as after an accepted observation.
- Integration: through the adapter, a core `declaration-superseded` result is sealed as abandoned and the call is `ignored`, with no cause recorded.

**Verification:**
- The race test fails on the current core and passes after the change.
- Mutations each fail at least one named test: removing the post-await comparison; removing the in-catch comparison; removing each of the three bumps.

- [ ] **Unit 2: Keep seed timeouts visible when a baseline was propagated**

**Goal:** A seed timeout for an undeclared operation is recorded and retried even after pull-request propagation, and binding never hides it on a read that did not confirm the operation.

**Requirements:** R4, R5, R6

**Dependencies:** None (independent of Unit 1)

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- In `recordSeedDeferral`, replace the any-baseline early return with an exemption for operations the unit declared, read from the status unit's `requiredResourceOperations`.
- In `bindDeferredBaseline`, when the core already holds a baseline, clear the deferral only when the operation's own before-read is `available`. Keep it on any other read. Do not call `observeReadback` on this branch.
- Leave the retry, the initiator gate, propagation and admission unchanged.

**Execution note:** Implement test-first. Flip test g's expectation first and confirm it is RED.

**Patterns to follow:**
- The existing deferral tests built on `deferralAdapter`, `sequenceObserver` and `statusParsed`.

**Test scenarios:**
- Happy path: seed pull-request creation as available, then time out the check-readback seed. Status lists `{ operation: 'check-readback', reasonCode: 'command-timeout' }`. This flips the existing test g.
- Happy path: the same for review-readback.
- Edge case, reversed order: the check seed times out first, then the pull-request seed propagates. The deferral is still listed, a timed-out check before-read keeps it, and an `available` before-read for the same pull request clears it and is admitted.
- Error path: with the deferral and a propagated baseline present, an `available` before-read for a different pull request clears the deferral and admission rejects it as `resource-mismatch`. The propagated baseline is unchanged.
- Edge case: a timed-out before-read with a deferral over a propagated baseline is retried exactly once.
- Edge case: an operation the unit declared still records no deferral on a seed timeout (tests h and the snapshot-blocked declared-scope test stay green).
- Edge case: a snapshot-blocked seed for an undeclared operation with a propagated baseline records a `snapshot-blocked` deferral.

**Verification:**
- Test g flips and passes. The existing different-pull-request and same-pull-request tests stay green.
- Mutations each fail at least one named test: restoring the any-baseline early return; making the bind-time clear unconditional; dropping the retry's dependence on the deferral record.

- [ ] **Unit 3: Docs**

**Goal:** Docs describe the core fence and the seed rule as they now behave.

**Requirements:** R1, R4, R5

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `ARCHITECTURE.md` (guard section: one sentence on the core fence; the seeding paragraph for propagated baselines)
- Modify: `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md` (mark #1083 resolved, and add the core as an example)
- Modify: `docs/plans/2026-10-11-002-fix-remote-seeding-deferral-plan.md` (one superseded note where it records the baseline exemption)

**Approach:**
- State current behaviour plainly. Add no change-history narration.
- Name the residuals: resource identities moved by sibling readbacks during the await, and a stale seal leaving the unit non-pristine.

**Test expectation:** none (documentation only).

**Verification:**
- markdownlint and `bun scripts/content-integrity.ts` are clean.

## System-Wide Impact

- **Interaction graph:** the core fence affects every observation through `processOperation`. The adapter's mapping already seals any non-accepted result. The trusted recovery path has no await and is unaffected.
- **Error propagation:** a stale observation is a silent seal. It never reaches `markUnavailable`, and the core never throws on it.
- **State lifecycle risks:** a stale call is terminal in the ledger. A replay gets `rejected-operation`, and a rerun has a new call ID.
- **Unchanged invariants:** admission's resource comparison, pull-request propagation, the one-time retry bound, the declared-scope exemption, and the adapter's own ownership checks.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A missed bump site leaves a window | The flow analysis traced every unit and epoch replacement. The unreachable ones are documented, and the reachable ones are mutation-checked. |
| A redeclaration during a long verification now costs a rerun | Accepted. A changed declaration means the evidence was checked against a different declaration. |
| The new reason code reaches a consumer with an exhaustive switch | The implementer checks every consumer of the union, and typecheck catches exhaustiveness. |
| Clearing on any `available` read lets a mismatched read hide the earlier timeout | Admission still rejects the mismatch, and status shows `resource-mismatch` for that call. |

## Sources & References

- Issue: #1083 (with Fro Bot's triage). Related: #1082, #1005, #1081.
- Related code: `src/lib/workflow-guard.ts`, `src/lib/opencode-workflow-guard.ts`, `src/lib/receipt-ledger.ts`.
