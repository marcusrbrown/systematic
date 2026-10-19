---
title: "fix: Isolate operation timeouts and rejected pushes to the one call instead of disabling the guard"
type: fix
status: superseded
date: 2026-10-15
superseded_by: docs/solutions/best-practices/workflow-guard-removed-2026-10-19.md
superseded_date: 2026-10-19
---

> **Superseded (2026-10-19):** the workflow guard this plan describes was removed ([#1153](https://github.com/marcusrbrown/systematic/issues/1153)); see [the decision note](../solutions/best-practices/workflow-guard-removed-2026-10-19.md). The body below is preserved as history.

# fix: Isolate operation timeouts and rejected pushes to the one call instead of disabling the guard

## Overview

A transient failure inside one guarded operation still makes the workflow guard `unavailable` for the whole session. Two examples:

- a typed `command-timeout` in a hook or in child rollup;
- a push that did not advance its upstream.

`unavailable` is terminal: enforcement stops for the rest of the session. This plan isolates those failures to the one call. That call mints no evidence. The session and any unrelated evidence are left alone. Untyped failures, identity failures, malformed output, classifier and parser failures, and thrown exceptions stay fatal.

**Terms.**

- *Skip*: the before-hook adds the call to `skippedOperations`. The call runs unobserved, and its after-hook stays silent.
- *Seal*: in the after-hook, an observed pending call is sealed as abandoned. Nothing is minted, and duplicate after-hooks stay silent.
- *Halt*: a child rollup pass returns before minting anything. The child is not recorded as rolled up.
- *Typed timeout*: an observer or validation result whose reason is `command-timeout`. In code this means `isProbeTimeout` or `read.status === 'timeout'`. It is never inferred from a cause.
- *Definite failure*: any non-timeout validation or derivation failure, including a spanning root.

## Problem Frame

The OpenCode adapter (`src/lib/opencode-workflow-guard.ts`) calls `markUnavailable` for each of these failures:

- In the before-hook: a snapshot timeout, a target-derivation or validation timeout, and a timeout on the other-target lookup or block-clear path.
- In the after-hook: a validation timeout, a local after-snapshot timeout, or a remote after-read timeout.
- In child rollup: a timeout during target validation, registration lookup, or snapshot.
- A push whose after-read is `remote-not-advanced`, meaning the upstream differs from `HEAD`. A normal non-fast-forward rejection produces this.

The timeout type is lost in three places:

- target derivation, whose result only knows `target-unavailable`;
- `parentObserverRegistration`, which returns `undefined` on any validation error;
- the child registration miss that follows from that.

Once the type is lost, a timeout can't be told apart from an identity failure.

**Attestation model.** The guard binds every receipt to the worktree and repository revision. It attests the final state: implementation, then verification and commit after the last change. It does not attest that each individual write was observed. That is already the case for:

- calls skipped while blocked (#1124);
- calls in inactive sessions (#1105);
- tools the classifier doesn't recognize;
- pushes the classifier rejects as destructive.

A skipped or sealed call fits that model. Its tree change is picked up by the next readback, which marks older receipts stale. Final-state receipts then cover it. Making the call fatal instead would switch enforcement off for the whole session.

## Requirements Trace

**Before-hook**

- R1. A typed timeout at any of the five before-hook sites skips the call. The sites are: the local snapshot, target derivation, post-derivation validation, the other-target effective lookup, and the other-target clear snapshot. The guard is not marked unavailable. No snapshot block is set, cleared or changed, and the block version is not bumped.

**After-hook and push**

- R2. A typed timeout in after-hook target validation, the local after-snapshot, or the remote after-read seals the call. The ownership check runs first: a call whose ownership was lost keeps today's lost-operation handling.
- R3. For a push, these seal the call:
  - an after-read of `remote-not-advanced`, whatever the before-read was;
  - an after-read of `missing-resource`, but only when the before-read was also `missing-resource`.

  These stay fatal: output-limit, missing-field and invalid-JSON results, throws, and `missing-resource` after an `available` before-read. The rule applies only when both the pending classification and the final classification are `push`.

**Child rollup**

- R4. A typed timeout in child target validation, the registration lookup, or the child snapshot halts the rollup pass.

**Typing**

- R5. Derivation and registration lookups carry a typed timeout, and an identity failure is never classified as a timeout. When results are merged, a definite failure beats a timeout. Only all-timeout results, or a timeout mixed with clean candidates, yield a timeout. A throw stays fatal.
- R6. The shared registration typing has one intended side effect. A parent-registration timeout becomes retryable in status refresh (reported as unconfirmed), in completion (`readback-timeout`), and in the block-clear control. Seeding stays fatal, but its cause becomes `command-timeout` instead of an empty cause.

**Stays fatal**

- R7. These stay fatal for the session:
  - throws from validation or capture;
  - `canonicalParentTargetRoot` failures;
  - target-digest mismatch;
  - malformed output;
  - classifier and parser failures;
  - rollup identity and lineage checks;
  - any non-timeout after-hook rejection not covered by R3.

**Docs and guidance**

- R8. Update ARCHITECTURE.md, the two solution docs that call these timeouts fatal, the using-systematic guidance and its bootstrap pin. Cover the new behaviour and the attestation model. The guidance must say that a skipped or sealed call has already run. After a timeout, the agent checks the worktree state, and re-runs the call only if its effect is missing. After a push rejection, the agent checks the remote state, then fixes the cause and retries. For a first push, that means `git push -u`.

## Scope Boundaries

- No new status field. `missingOperations` at completion catches a lost call only when its operation has no receipt at all. If an operation already has a receipt, a later skipped call of the same operation leaves no trace beyond the stale-on-readback rule.
- No retry of a timed-out remote after-read. A push that really happened but whose after-read timed out stays unreceipted.
- No new mechanism to attest every write, such as an "unattested digest" marker.

### Deferred to Separate Tasks

- Seed timeouts and the classifier race: #1083.
- First-push absence and remote-evidence proofs: #1081.
- Worktree registry refresh: #740.
- Snapshot correctness and restart anchors: #1099, #1126.
- Rollup re-validating the same target for every receipt, which multiplies the odds of a timeout: note only.

## Context & Research

### Relevant Code and Patterns

In `src/lib/opencode-workflow-guard.ts`:

- **Before-hook.** `prepareOperation`, `takeBeforeSnapshot`, `readBeforeSnapshot` and `blockOrFailBeforeSnapshot` already return `{kind:'skip'}` for the blocking reasons. `prepareOperation` adds the call to `skippedOperations` on a skip. `clearBlockForOtherTarget` sends lookup and clear failures to `markUnavailable`. `clearSnapshotBlock` already returns `{status:'timeout'}` before it changes any state. Every timeout site runs after `bindCall`. A site that doesn't add the call to `skippedOperations` produces `call-lifecycle-mismatch` in the after-hook.
- **Derivation.**
  - `sharedTargetRoot` returns on the first `unavailable`, so precedence needs a full scan.
  - `deriveDirectoryTarget` and `deriveApplyPatchTarget` drop the reason.
  - `targetResultFromValidation` and the catch in `validationForCandidate` map every failure to `target-unavailable`.
- **Registration lookups.** `parentObserverRegistration` and `operationObserverRegistration` return `undefined` on error. They have two callers: `resolveEffectiveObserver`, which also serves status, completion, pinned revalidation and the block-clear control, and rollup.
- **After-hook.**
  - `afterTargetFailure`, `captureAfterOperation`, `captureRemoteAfter` and `remoteFailureReason` lose the timeout type.
  - In `completeOperationObservation`, the blocked branch seals with `sealOperation(…, true)` and returns `{status:'ignored'}`. This is the pattern to mirror.
- **Rollup.**
  - `rollupForegroundTask`, `readChildSnapshot`, `blockOrFailChildSnapshot` and `rolledUpChildren`.
  - Phase 1 reads and validates without minting. Phase 2 mints without reading.
- **Shared helpers.** `readSnapshot` (ok/timeout/fatal), `isProbeTimeout`, `probeFailureReason`.

In `src/lib/opencode-operation-observer.ts`:

- `validateRegisteredWorktree` is synchronous. It runs several `git rev-parse` calls and returns a verdict only after all of them, so a timeout always means no verdict yet.
- The push after-phase readback returns `remote-not-advanced` when the upstream differs from `HEAD`.

In `src/lib/receipt-classifier.ts`:

- `classifySafePushCommand` accepts non-destructive pushes with up to two positional arguments, including refspecs. It rejects force, delete, mirror and prune pushes, so those are never observed.

### Test fixtures

All in `tests/unit/opencode-workflow-guard.test.ts`.

- **`sequenceObserver`.** Its validator always returns `ok`. The pinned fixture's `timeoutOn.validation` only counts the linked root. Registration timeouts need a validator that times out on the Nth call for a given root. The validator is synchronous, so a "held" registration timeout can't be built.
- **Push activation.** Activation seeds `push:before`, and the before-hook can retry a timed-out before-read. A push row with a timed-out before-read therefore needs scripted values for the seed, the before-read and the retry.
- **Child rollup.** `childMarkers` mints exactly one receipt, and `queueRollupSnapshots` queues one snapshot. A mid-batch timeout needs a helper that mints two or more child receipts.
- **Tests to flip.**
  - The before-snapshot `command-timeout` test.
  - The validation-timeout row.
  - The `command-timeout` row of the while-blocked other-target table.
  - The after-snapshot `command-timeout` test.
  - The remote after-read timeout row.
  - The `command-timeout` row of a `test.each` over `[command-timeout, target-unavailable]`. Split that test so only the timeout row flips.
  - The `command-timeout` rows of the after-hook fatal-reason tables, including the child-rollup `FATAL_AFTER_REASONS` table (in the rollup unit).

### Institutional Learnings

- `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`: skipped calls mint nothing and causes stay typed. Its statements that hook timeouts are fatal go stale.
- `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`: timeout branches must not write the block or bump the version.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: every new branch needs a test that reaches it, plus a mutation proof.
- `docs/solutions/integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`: an unvalidated target must never be admitted.
- `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`: rollup identity and lineage mismatches stay fatal.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-workflow-guard.ts and tests/unit/opencode-workflow-guard.test.ts, with read-only reference to src/lib/opencode-operation-observer.ts and src/lib/receipt-classifier.ts",
  "freshness": { "vcs_reference": "b5eea14b" },
  "budget": { "max_search_passes": 8, "max_candidate_inspections": 25, "exhausted": false },
  "candidates": [
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:readSnapshot", "description": "ok/timeout/fatal ProbeRead of an observer snapshot; isProbeTimeout maps command-timeout to timeout", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:skippedOperations", "description": "Set of call digests the observation gate skipped; silent after-hook; moved to abandonedOperations by abandonPending", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:sealOperation", "description": "Seals a pending operation's tool and argsFingerprint so replays stay silent with checks intact", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:completeOperationObservation", "description": "Ordered after-hook pipeline; returns ignored on blocked and lost-ownership paths", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:setSnapshotBlock", "description": "Per-unit snapshot block for blocking observer reasons", "disposition": "insufficient", "insufficiency_reason": "Sets a block, which timeouts must not do" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:targetResultFromValidation", "description": "Maps RegisteredWorktreeValidationResult to an available target or target-unavailable", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:parentObserverRegistration", "description": "Pins the parent observer registration when its worktree validates; returns undefined on any error", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:readChildSnapshot", "description": "Child target snapshot read with halt outcome; blocking reasons block, others mark unavailable", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:rolledUpChildren", "description": "Set of minted child rollup keys; a child is added only when a receipt is minted", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:captureRemoteAfter", "description": "Remote after-read that rejects operation observation on an unavailable remote result", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:finishReadbackTimeout", "description": "Completion readback timeout that rejects the attempt retryably", "disposition": "insufficient", "insufficiency_reason": "Completion-scoped rejection, not an operation-hook skip" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:recordSeedDeferral", "description": "Per-operation activation seed deferral for remote command-timeout", "disposition": "insufficient", "insufficiency_reason": "Activation seeding only; no per-call skip" },
    { "path_or_symbol": "src/lib/opencode-operation-observer.ts:validateRegisteredWorktree", "description": "Registered-worktree check returning ok or error with reasonCode; command-timeout preserved", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-operation-observer.ts:readPushRemoteSnapshot", "description": "Push upstream readback; remote-not-advanced only in the after phase", "disposition": "reuse" }
  ]
}
```

## Key Technical Decisions

- **Skip or seal, never block.** A timeout never sets, clears or changes the snapshot block and never bumps its version. Drift made during a skipped call is applied by the next status or completion readback. Those readbacks treat their own timeouts as retryable today: completion returns `readback-timeout`, and status refresh reports the readback as unconfirmed.
- **Typed variants, not cause sniffing.** The skip or seal decision is made where the observer result is read. By the time `finishOperation` sees a cause, it is too late.
- **Derivation precedence.** A definite failure beats a timeout. A throw inside `validationForCandidate` stays `target-unavailable`.
- **Shared registration typing.** Use a `ProbeRead` or an equivalent union (see Deferred). The side effects on status, completion and block clear are accepted as R6.
- **Push sealing is no weaker than today's unobserved pushes.**
  - Sealing mints nothing. A push with an explicit refspec that leaves the tracked upstream behind is sealed, and so stays unreceipted. Force and delete pushes are already never observed.
  - `missing-resource` can't tell an absent upstream apart from other git failures, so it seals only when the before-read was also missing.
  - The rule checks both the pending and the final classification, because the classifier runs again in the after-hook.
- **Rollup halts the whole phase-1 pass.** Every local receipt in a batch shares one target. Retrying needs a new `task` call that resumes the child. Otherwise the operation shows up as missing at completion if it has no other receipt.
- **One skip helper in the before-hook**, shared by all five sites.
- **No plan labels in code.** Requirement IDs, unit numbers and issue numbers never appear in code identifiers or test names. Tests describe behaviour.

## Open Questions

### Resolved During Planning

- Skip vs. block on timeout: skip or seal.
- Tracked-branch and refspec push rejection: seal.
- Status visibility: no new field. Guidance covers it.
- Registration typing side effects: accepted.
- Remote after-read retry: none.
- Attestation of every write: out of scope. The model is documented.

### Deferred to Implementation

- Exact shape of the typed registration result: `ProbeRead` or a local union, whichever keeps Biome complexity at or below 15.
- Whether the rollup halt is a new `ChildSnapshotOutcome` kind or a separate return path.

## Implementation Units

- [x] **Unit 1: Type timeouts in target derivation**

**Goal:** Derivation results carry a typed timeout with failure-first precedence. Behaviour does not change: callers still treat the timeout as fatal until Unit 3.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Widen the derivation result type with `command-timeout`, set from `isProbeTimeout` in `targetResultFromValidation`.
- Make `sharedTargetRoot` scan every candidate, and keep reasons in `deriveDirectoryTarget` and `deriveApplyPatchTarget`.

**Execution note:** Test-first.

**Test scenarios:**
- Happy path: one candidate whose validation times out yields a timeout result.
- Edge case: every candidate times out, with several candidates. The result is a timeout.
- Edge case: one candidate times out and another fails identity. The result is the identity failure.
- Edge case: one candidate times out and another is clean. The result is a timeout.
- Edge case: a spanning root plus a timeout yields the spanning failure.
- Error path: a validator throw yields `target-unavailable`.

**Verification:** The guard suites pass unchanged.

- [x] **Unit 2: Type timeouts in registration lookups**

**Goal:** `parentObserverRegistration` and `operationObserverRegistration` return ok, timeout or fatal. Their consumers apply R6.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Only `isProbeTimeout(validation)` maps to timeout. A throw or any non-ok result is fatal.
- `resolveEffectiveObserver` passes the timeout to its existing timeout-handling consumers.
- Seeding records a typed cause.
- The rollup caller keeps its fatal behaviour until Unit 6.

**Execution note:** Test-first. Before writing the new tests, run the guard suites after the type change to catch any seed or clear assertion that pins the old cause.

**Test scenarios:**
- Integration: a parent-registration timeout during a status refresh is reported as unconfirmed, and the guard is not `unavailable`.
- Integration: a parent-registration timeout during completion is a retryable `readback-timeout`.
- Integration: a parent-registration timeout in the block-clear control returns `timeout`.
- Error path: a parent-registration timeout at seed time stays fatal with a `command-timeout` cause.
- Error path: a validator throw, or an identity error, stays fatal everywhere.

**Verification:** The new tests pass. Existing tests change only where R6 requires it.

- [x] **Unit 3: Skip the call on a before-hook timeout**

**Goal:** Every before-hook timeout site skips the call.

**Requirements:** R1, R7

**Dependencies:** Units 1, 2

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- One helper, used at the local snapshot, derivation, post-derivation validation, other-target lookup and other-target clear snapshot sites.
- On a typed timeout the helper returns skip and adds the call to `skippedOperations`.
- No `markUnavailable`, no block write, no `observeReadback`.
- Implement the two block-adjacent sites (local snapshot, other-target clear) in a separate commit from the derivation and validation sites.

**Execution note:** Test-first. Flip the before-hook tests listed under Test fixtures.

**Patterns to follow:** the blocking-reason skip in `blockOrFailBeforeSnapshot`.

**Test scenarios:**
- Happy path, one test per site:
  - the guard is not `unavailable`;
  - no receipt is minted;
  - the after-hook is silent, with no `call-lifecycle-mismatch`;
  - a later clean call is observed normally.
- Edge case: a timeout while blocked leaves the block, its reason and its version unchanged.
- Integration, drift still caught: an observed write mints a receipt, then a write is skipped by a timeout. Completion is rejected with `stale-receipt`. Make sure the timeout hits the before-hook snapshot and not completion revalidation.
- Integration, attestation model pinned: an observed write, then a write skipped by a timeout, then a status refresh, then an observed write and verification. Completion succeeds. This pins the documented behaviour.
- Error path, stays fatal: a throw, `target-unavailable`, `command-failed`, a target-digest mismatch, a `canonicalParentTargetRoot` failure.

**Verification:** No before-hook path calls `markUnavailable` for a typed timeout. Mutation proof: removing the skip at a site fails that site's test.

- [x] **Unit 4: Seal the call on an after-hook timeout**

**Goal:** After-hook timeouts seal the one call.

**Requirements:** R2, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add a `timeout` variant to `afterTargetFailure`, `captureAfterOperation` and `captureRemoteAfter`.
- `completeOperationObservation` seals as abandoned and returns `ignored`. It does this after the ownership check, the same way as the blocked branch.

**Execution note:** Test-first. Flip the after-hook tests listed under Test fixtures, except the child-rollup table.

**Test scenarios:**
- Happy path: a timeout in after-hook validation, the local after-snapshot, or the remote after-read. Nothing is minted, the session stays available, a duplicate after-hook is silent, and unrelated receipts are unchanged.
- Edge case: a call whose ownership was lost (the unit was redeclared) keeps today's lost-operation handling.
- Error path, stays fatal: a classifier rejection, malformed output, a throw from `observeClassifiedOperation`.

**Verification:** No after-hook path calls `markUnavailable` for a typed timeout.

- [x] **Unit 5: Seal a push that did not advance**

**Goal:** The R3 push rule.

**Requirements:** R3, R7

**Dependencies:** Unit 4

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:** Apply the rule in `captureRemoteAfter` or `completeOperationObservation`, only when both the pending and the final classification are `push`.

**Execution note:** Test-first. Script the seed, the before-read, and the retry values for every row.

**Test scenarios:**
- Happy path, sealed:
  - before `available`, after `remote-not-advanced` (a tracked-branch rejection);
  - before `missing-resource`, after `remote-not-advanced`, `missing-resource` or timeout;
  - before-read timed out (and its retry too), after `remote-not-advanced`.
- Error path, stays fatal:
  - before `available`, after `missing-resource`;
  - after output-limit, missing-field or invalid-JSON;
  - a throw;
  - a non-push operation with `remote-not-advanced`.
- Edge case: the before-hook classified the call as a push but the after-hook did not, or the reverse. The rule does not apply.
- Integration: a sealed push, then a second push that advances the upstream. The guard stays available, and the second push is recorded the way the existing remote-revision rules handle an upstream that moved since activation. Pin the exact outcome after reading the current behaviour.

**Verification:** Mutation proof: removing the rule fails the tracked-branch rejection test.

- [x] **Unit 6: Halt the rollup pass on a child timeout**

**Goal:** A child-rollup timeout halts without minting, and the child can be retried.

**Requirements:** R4, R7

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- In phase 1, a typed timeout in child target validation, the registration lookup or the child snapshot returns before minting.
- No block clear is committed, and nothing is added to `rolledUpChildren`.

**Execution note:** Test-first. Add a fixture helper that mints two or more child receipts. Flip the `command-timeout` row of the child-rollup fatal-reason table.

**Test scenarios:**
- Happy path: a child target-validation timeout. No receipts are minted, the guard is available, and the child is not recorded as rolled up.
- Happy path: a child snapshot timeout mid-batch. No receipt is minted for any child.
- Happy path: a child registration-lookup timeout halts the pass.
- Integration: a halted rollup, then the same child resumed through a new task call. The rollup mints.
- Edge case: a timeout while blocked leaves the block unchanged.
- Error path, stays fatal: an identity mismatch, a lineage mismatch, a throw, a non-timeout validation error.

**Verification:** No rollup path calls `markUnavailable` for a typed timeout.

- [x] **Unit 7: Docs, guidance and bootstrap pin**

**Goal:** Readers and agents learn the new behaviour and the attestation model.

**Requirements:** R8

**Dependencies:** Units 3–6

**Files:**
- Modify: `ARCHITECTURE.md`, `skills/using-systematic/SKILL.md`, `tests/unit/bootstrap.test.ts`, `tests/unit/__snapshots__/bootstrap.test.ts.snap`, `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`, `docs/solutions/logic-errors/operation-observer-false-clean-worktree-2026-10-15.md`

**Approach:**
- Replace the statements that hook and rollup timeouts are fatal.
- Document:
  - the attestation model;
  - push sealing;
  - the unreceipted-push residual;
  - the rollup residual (lost child evidence shows only if the operation has no other receipt);
  - that `missingOperations` catches a lost call only when the operation has no receipt.
- Add one guidance clause with explicit branches, per R8.
- Regenerate the bootstrap pins.

**Test scenarios:**
- Happy path: the bootstrap byte pin and the snapshot pass after regeneration.

**Verification:** markdownlint, content-integrity and the bootstrap tests pass. No doc still says that hook or rollup timeouts make the guard unavailable.

## System-Wide Impact

- **Interaction graph:**
  - The before-hook, after-hook and rollup.
  - The consumers of `resolveEffectiveObserver`: status, completion, pinned revalidation and block clear.
  - The seed cause.
- **Error propagation:** typed timeouts and R3 pushes skip, seal or halt a single call. Everything else keeps today's fatal path and its first cause.
- **State lifecycle risks:**
  - Skipped, sealed and halted calls leave no receipt.
  - A push that really happened but whose after-read timed out stays unreceipted.
  - A lost call is caught at completion only if its operation has no other receipt.
- **Unchanged invariants:**
  - No receipt from an unvalidated target or a failed read.
  - The snapshot block and its version fence.
  - Marker and receipt protocol versions.
  - Completion and status readback semantics, apart from R6.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A skip site is missed, causing `call-lifecycle-mismatch` | One helper, plus one test per site (Unit 3) |
| A timeout is misclassified, hiding an identity failure | Precedence tests and throw-stays-fatal tests (Units 1, 2) |
| Drift during a skipped call is never applied | Drift-still-caught integration test (Unit 3) |
| A skipped write is followed by an observed write | Accepted attestation model; pinned by a test (Unit 3); documented (Unit 7) |
| Agent re-runs a call that already ran | Guidance: check state first, re-run only if the effect is missing (Unit 7) |
| A push really happened but its after-read timed out | Doc-only residual (Unit 7) |
| Rollup retry rarely happens in production | Doc-only residual (Unit 7) |

## Sources & References

- Issue #1084. Related: #1080, #1081, #1083, #1105, #1124, #740.
- Related code: `src/lib/opencode-workflow-guard.ts`, `src/lib/opencode-operation-observer.ts`, `src/lib/receipt-classifier.ts`.
