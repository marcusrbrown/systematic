---
title: "fix: Fence core operation observations against redeclaration and keep seed timeouts visible"
type: fix
status: active
date: 2026-10-17
---

# fix: Fence core operation observations against redeclaration and keep seed timeouts visible

## Overview

This plan fixes two gaps in workflow-guard operation admission (#1083). Fro Bot's triage reproduced both.

1. The core guard awaits the classifier inside `observeOperation`, then finalizes against the unit object it captured on entry. A same-ID redeclaration during that await mutates the unit in place. The observation then finalizes against a declaration it was never checked against. Fro Bot got a verification receipt minted under a declaration that had changed to `[push]`.
2. A pull-request-creation seed can propagate resource baselines to check and review. If it has, a later check or review seed timeout records no deferral. Status gives no reason the operation is missing, and its before-read loses its one retry.

## Terms

- **Changed redeclaration:** a start of the active unit for which `startActiveUnit` does not return `unit-active`. An identical redeclaration returns `unit-active` and changes nothing.
- **Stale observation:** one whose captured generation no longer matches the core's generation after the classifier await. `declaration-superseded` is the reason code it returns.
- **Resource baseline:** the expected resource identity for an operation. It comes from the unit's declared resource scope, from earlier evidence, or from pull-request propagation. `currentResourceIdentities` names only the core field that holds the non-declared ones.
- **Declared resource scope:** an operation listed in the status unit's `requiredResourceOperations`. This includes scopes supplied by the runtime policy, and `pr-creation` when it is declared.

## Problem Frame

The adapter (`src/lib/opencode-workflow-guard.ts`) fences its own awaits with `unitStartGeneration`. It seals a lost operation with `sealAndIgnore`, and it checks ownership synchronously before calling the core. The core (`src/lib/workflow-guard.ts`) has no equivalent. Its classifier await in `processOperation` is the one window the adapter cannot see. Unit completion and mode changes during that await are also invisible to the adapter, because neither changes the adapter's initiator fields.

On the seed side, `recordSeedDeferral` returns early whenever the core holds any resource baseline for the operation. A propagated baseline is not the operation's own evidence, yet it suppresses the deferral record. The one-time before-read retry is keyed on that record. `bindDeferredBaseline` also clears a deferral whenever a baseline exists, so a timeout recorded before propagation is hidden too.

## Requirements Trace

- R1. A stale observation (changed redeclaration, unit completion or mode change during the classifier await) mints nothing and records no issue or cause. It returns `rejected` / `declaration-superseded` and is terminal for its call. The stale result does not itself make the guard unavailable. The adapter seals it as abandoned and ignores the call.
- R2. The classifier-throw path applies the same fence before it writes anything.
- R3. An identical redeclaration does not disturb an in-flight observation.
- R4. A seed timeout for an operation without a declared resource scope is recorded even when a baseline was propagated from another operation. The one-time before-read retry applies to it.
- R5. When a baseline is present, a deferral clears only on the operation's own `available` before-read from the same observer and target as the seed. Binding never overwrites a propagated baseline. Admission still compares resource identity.
- R6. Removing any new check fails a named test.

## Scope Boundaries

- Out of scope: remote-evidence redesign (#1081), cross-registration coordination (#1090), restart-proof anchors (#1126) and receipt hardening (#740).
- Operations with a declared resource scope keep today's behaviour. A seed timeout for one still records no deferral and gets no retry. Propagation never writes a declared operation, so the declared-and-propagated case cannot occur.
- Residuals. These are not fenced and are documented in Unit 3:
  - Sibling calls that move resource identities or write unit evidence during the classifier await (pre-existing).
  - A seed read after a changed redeclaration can replace a propagated identity (pre-existing; the seed path calls `observeReadback`).
  - On the bind-clear branch, the operation's revision baseline stays unset, so its first before-revision is unchecked (pre-existing).
  - An `available` before-read for a different pull request clears the deferral. Admission then rejects that call as `resource-mismatch`. The timeout record is gone, and an accepted receipt later clears the issue.
  - A deferral recorded before the operation was declared stays until the operation's own `available` read or the end of the unit.
  - A stale seal marks the call terminal, so later changed redeclarations of that unit return `unit-active`. Accepted and rejected observations already do the same.

## Context & Research

### Relevant Code and Patterns

- Core path: `observeOperation` → `processOperation` → `classifyPreparedOperation` (the only await) → `finalizeOperation`. The classifier-throw handling already abandons the prepared observation and marks the call terminal before it records a unit issue.
- Changed redeclaration: `startActiveUnit` mutates `requiredOperations`, `declaredResourceOperations`, `resourceScopes` and `currentResourceIdentities` in place. Declarations only grow.
- Completion is the unit branch of `finalizePrepared`. Mode changes go through `setMode`, which the adapter reaches from `markUnavailable` via `recordUnavailable`. A same-mode call returns early.
- The adapter checks `ownsOperation` synchronously before `observeClassifiedOperation`. Its result mapping seals any result that is neither accepted nor `unavailable` as abandoned, and returns `ignored`.
- Seed: `recordSeedDeferral`, `bindDeferredBaseline` with its initiator gate and `sameSeedObserver` check, `deferredSeedFor`, the one-time retry in the before-read, and `propagatePullRequestScope` in the core. `startFreshUnit` runs before the seeds, so the status unit is current at record time.
- Pattern: a monotonic, never-reset version, captured before an await and compared after it, as in `snapshotBlockVersion` and `unitStartGeneration`.

### Institutional Learnings

- `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`: capture synchronously before the await, and reject a stale result before any side effect. It still lists #1083 as open.
- `docs/solutions/logic-errors/verification-overlap-mints-receipt-2026-10-17.md` and `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`: a lost or stale operation is sealed and ignored, with no cause and no `unavailable`.
- `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`: the seed fix stays deferral bookkeeping. Binding comes only from the operation's own before-read, with no compare-only readbacks.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: a check no test can reach is removed or justified.

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

- **Use a core declaration generation instead of refusing to redeclare.** Refusing would need in-flight tracking and a new start result that the agent sees. The generation is captured and compared, as the version-fence doc prescribes.
- **Bump only where it can happen.** The generation bumps on a changed redeclaration in `startActiveUnit`, on unit completion in `finalizePrepared`, and in `setMode` after the mode actually changes (never on a same-mode call). No other replacement can happen while an observation is in flight:
  - Unit replacement needs a non-active unit, and an in-flight observation needs an active one, so completion has already bumped.
  - Epoch completion requires a completed unit.
  - `activate` requires a completed or absent epoch.
  - `restore` requires no epoch.
  A comment at the `startActiveUnit` bump states this.
- **Capture in `processOperation`.** Both `observeOperation` and the trusted recovery path go through it. The trusted path skips the classifier and has no await, so it cannot go stale.
- **Signal staleness with a discriminated classifier outcome.** `classifyPreparedOperation` receives the captured generation and returns one of three outcomes: classified, stale or unclassified. Its catch checks the generation before any write. An unclassified outcome keeps today's `guard-unavailable` mapping. `processOperation` also compares after the await, before `finalizeOperation`. The no-classifier branch writes synchronously before the call yields, so its writes cannot land after a redeclaration.
- **A stale result is `rejected` with a new `declaration-superseded` code.** The core abandons the observation, marks the call terminal, and writes nothing else. `unit-mismatch` would also work functionally, but its existing producer records an issue, and a same-ID redeclaration is not a unit mismatch. Consumers of the core reason-code union to update:
  - the union itself in `src/lib/workflow-guard.ts`;
  - `issueKind`;
  - `repairFor` / `eligibleRepairKinds`.
  The last two are non-exhaustive, so typecheck will not flag them. The adapter's `REASON_CODES` does not need it, because it gates only `isWorkflowGuardBlockedError`, which this path never throws. No schema, docs list or marker carries the union.
- **The seed gate exempts declared resource scopes only.** `recordSeedDeferral` skips an operation only when it has a declared resource scope. A propagated baseline no longer suppresses the record, and the retry follows the record with no further change.
- **When a baseline is present, binding clears on the operation's own `available` before-read from the seed's observer and target.** In every other case the deferral stays. No new core accessor is needed, and `observeReadback` is never called on this branch. Clearing on a match only was considered: it needs a new core accessor, and it leaves a stale timeout in status for the rest of the unit. Its benefit is diagnostic, because admission gates the evidence either way.

## Open Questions

### Resolved During Planning

- Stale observation outcome: it is sealed and ignored, with no cause (confirmed).
- Both parts ship in one PR, which closes #1083 (confirmed).
- The bind rule, the new reason code and the mode fence are as above (confirmed).

### Deferred to Implementation

- Exact names for the classifier outcome variants.

## Implementation Units

- [ ] **Unit 1: Fence core observations with a declaration generation**

**Goal:** an observation finalizes only if its unit's declaration, its unit's completion state and the guard mode are unchanged since it started.

**Requirements:** R1, R2, R3, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/workflow-guard.ts`
- Test: `tests/unit/receipt-operations.test.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts` (one adapter integration scenario)

**Approach:**
- Add a monotonic generation to the guard closure that is never reset. Bump it at the three sites above.
- Capture it at the top of `processOperation`. Compare it inside the classifier catch before any write, and again after the await before `finalizeOperation`.
- When stale: abandon the prepared observation, mark the call terminal, and return `rejected` / `declaration-superseded`. Record nothing else.
- Add the reason code to the consumers listed in Key Technical Decisions.

**Execution note:** implement test-first. Each discriminating scenario below must fail on the current core before the source changes.

**Patterns to follow:**
- `snapshotBlockVersion` and `unitStartGeneration` in `src/lib/opencode-workflow-guard.ts`.
- The existing abandon-and-terminal handling in `classifyPreparedOperation`.
- Core scenarios use `createScenario` with a gated wrapper over `createReceiptClassifier`. Completion during the await needs `implementation` minted, verification context and after-readbacks that include the worktree revision, and coherent final readbacks. Follow the existing completion scenarios in this file.

**Test scenarios:**
- Happy path (discriminating): suspend a gated classifier, make a changed redeclaration with the same IDs, then release. The result is `rejected` / `declaration-superseded`, the receipt count is unchanged, `satisfiedOperations` lacks the operation, and the guard is not `unavailable`. Today this is accepted and mints.
- Edge case (discriminating): the unit completes during the await, so the observation mints nothing. Today it is accepted.
- Edge case (discriminating): `setMode` changes the mode during the await, so the observation mints nothing. Assert the receipt count and the result, and that the mode is the one the test set. Today it is accepted and mints.
- Error path (discriminating): the classifier throws after a changed redeclaration. No unit issue or `guard-unavailable` is recorded on the new declaration, and the result is `declaration-superseded`. Today the new declaration records `guard-unavailable`.
- Edge case (discriminating): a same-mode `setMode` during the await leaves the observation accepted. A bump placed before the early return fails this.
- Control: a gated classifier with no redeclaration is accepted and mints.
- Control: an identical redeclaration during the await returns `unit-active`, and the observation is accepted.
- Control: replaying the same call after a stale result returns the terminal `rejected-operation`.
- Control: after a stale seal, a changed redeclaration returns `unit-active`, the same as after an accepted observation.
- Integration: a call-counting gate on the classifier the adapter and core share holds the core's second classification. A changed redeclaration through the adapter during that hold leaves the call `ignored`, with no receipt and no cause.

**Verification:**
- Each discriminating scenario fails before the change and passes after it.
- Each of these mutations fails at least one discriminating scenario: removing the post-await compare, removing the in-catch compare, removing the `startActiveUnit` bump, removing the completion bump, removing the `setMode` bump, and moving the `setMode` bump before its early return.
- `bun run typecheck:all` passes.

- [ ] **Unit 2: Keep seed timeouts visible when a baseline was propagated**

**Goal:** a seed timeout for an operation without a declared resource scope is recorded and retried after pull-request propagation. Binding does not hide it on a read that did not answer for the operation.

**Requirements:** R4, R5, R6

**Dependencies:** none. It is independent of Unit 1.

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- In `recordSeedDeferral`, replace the any-baseline early return with an exemption for declared resource scopes, read from the status unit.
- In `bindDeferredBaseline`'s baseline-present branch, clear the deferral only when the operation's own before-read is `available` and `sameSeedObserver` holds. Otherwise keep it. Never call `observeReadback` on this branch.
- Leave the retry, the initiator gate, propagation and admission unchanged.

**Execution note:** implement test-first, and flip the existing pull-request-then-check test before changing the source.

**Patterns to follow:**
- The existing deferral tests that use `deferralAdapter`, `sequenceObserver` and `statusParsed`.

**Test scenarios:**
- Happy path (flip): change 'g: a check timeout after pr-creation seeded records no check deferral' so that status lists `{ operation: 'check-readback', reasonCode: 'command-timeout' }`. Rename it to describe the new behaviour.
- Happy path: the same case for review-readback.
- Edge case (discriminating, reversed order): the check seed times out first, then the pull-request seed propagates. The deferral is listed, and a timed-out check before-read keeps it. Then an `available` before-read for the same pull request clears it and is admitted. Today the timed-out read clears it. This is the scenario that fails when the bind-time clear is made unconditional.
- Edge case (discriminating): a deferral sits over a propagated baseline and its before-read comes from a different observer or target. The deferral stays.
- Edge case (discriminating): a timed-out before-read with a deferral over a propagated baseline is retried exactly once.
- Edge case (discriminating, negative): a timed-out before-read with no deferral gets exactly one read. Use a declared operation, or an undeclared one before propagation. This fails an always-retry mutation.
- Residual pin: with a deferral and a propagated baseline present, an `available` before-read for a different pull request clears the deferral. Admission rejects it as `resource-mismatch`, and the propagated baseline is unchanged.
- Control: 'a different PR cannot overwrite the propagated baseline or mint evidence' and 'the same PR is still admitted and the obsolete deferral is cleared' stay green for check and review.
- Control: 'h: a timeout for an operation whose resource the unit declared…' and 'a scope whose baseline the unit declares is not deferred when the seed is blocked' stay green.
- Edge case: a snapshot-blocked seed for an undeclared operation with a propagated baseline records a `snapshot-blocked` deferral.

**Verification:**
- The flipped test passes. Every listed control stays green.
- Each of these mutations fails at least one discriminating scenario: restoring the any-baseline early return, making the bind-time clear unconditional, dropping `sameSeedObserver` from the clear, and making the retry ignore the deferral record.

- [ ] **Unit 3: Docs**

**Goal:** the docs describe the core fence and the seed rule as they now behave.

**Requirements:** R1, R4, R5

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `ARCHITECTURE.md`, in the guard section. Add one sentence on the core fence and its stale result. Update the seeding paragraph for propagated baselines, and list the residuals from Scope Boundaries.
- Modify: `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`. Mark #1083 resolved and add the core as an example.
- Modify: `docs/plans/2026-10-11-002-fix-remote-seeding-deferral-plan.md`. Add one superseded note where it records the baseline exemption.

**Approach:**
- State current behaviour plainly, with no change-history narration.

**Test expectation:** none, because this unit is documentation only.

**Verification:**
- markdownlint and `bun scripts/content-integrity.ts` are clean.

## System-Wide Impact

- **Interaction graph:** the core fence affects every observation that goes through `processOperation`. The adapter's mapping already seals any non-accepted result. The trusted recovery path has no await.
- **Error propagation:** a stale observation is a silent seal. It never reaches `markUnavailable`, and the core never throws on it.
- **State lifecycle risks:** a stale call is terminal in the ledger. A replay gets `rejected-operation`, and a rerun has a new call ID.
- **Unchanged invariants:** these all stay as they are:
  - admission's resource comparison;
  - pull-request propagation;
  - the one-time retry bound;
  - the declared-scope exemption;
  - the adapter's own ownership checks.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A missed bump site leaves a window open | The reachable sites are mutation-checked. The comment at the `startActiveUnit` bump states the chain that makes the others unreachable: replacement needs a non-active unit, epoch completion needs a completed unit, activation needs a completed or absent epoch, and restore needs no epoch. |
| A changed redeclaration during a long verification now costs a rerun | Accepted. Declarations only grow, so a unit can bump only a finite number of times. |
| A stale seal leaves the unit non-pristine | This is the same class as accepted and rejected observations today. It is documented as a residual. |
| The new reason code is missing from a non-exhaustive consumer | Unit 1 names every consumer, and the discriminating tests assert the code. |
| Clearing on a mismatched `available` read hides the earlier timeout | Admission still rejects the mismatch, and the residual is pinned by a test and documented. |

## Sources & References

- Issue: #1083 (with Fro Bot's triage). Related: #1082, #1005, #1081.
- Related code: `src/lib/workflow-guard.ts`, `src/lib/opencode-workflow-guard.ts`, `src/lib/receipt-ledger.ts`.
