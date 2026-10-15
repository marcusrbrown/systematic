---
title: "fix: Isolate operation timeouts and rejected pushes to the one call instead of disabling the guard"
type: fix
status: active
date: 2026-10-15
---

# fix: Isolate operation timeouts and rejected pushes to the one call instead of disabling the guard

## Overview

A transient failure inside one guarded operation still makes the workflow guard `unavailable` for the whole session. Examples are a typed `command-timeout` in a hook or in child rollup, or a push that did not advance its upstream. `unavailable` is terminal. This plan makes those failures skip or seal that one call instead. The call mints no evidence, and the session and any unrelated evidence are untouched. Failures that are untyped, identity, malformed, classifier or parser failures, or thrown exceptions stay fatal.

**Terms.**
- *Skip*: the before-hook adds the call to `skippedOperations`. The call runs unobserved and its after-hook stays silent.
- *Seal*: an observed call that is pending is sealed as abandoned in the after-hook. Nothing is minted, and duplicate after-hooks stay silent.
- *Typed timeout*: an observer or validation result whose reason is `command-timeout`. In code this means `isProbeTimeout` or `read.status === 'timeout'`, never inferred from a cause.

## Problem Frame

The OpenCode adapter (`src/lib/opencode-workflow-guard.ts`) passes these failures to `markUnavailable`:
- a before-hook snapshot timeout, a target-derivation or validation timeout, and the other-target block-clear path;
- after-hook validation, after-snapshot and remote after-read timeouts;
- a child rollup target validation or snapshot timeout;
- a push whose after-read is `remote-not-advanced`, i.e. the upstream revision differs from `HEAD`. This happens on a normal non-fast-forward rejection.

The type information is lost in three places:
- target derivation, whose result only knows `target-unavailable`;
- `parentObserverRegistration`, which returns `undefined` on any validation error;
- the child registration miss that results from it.

Without the type, a timeout cannot be told apart from an identity failure.

## Requirements Trace

- R1. A typed timeout at any of the five before-hook sites skips the call. Those sites are the local snapshot, target derivation, post-derivation validation, the other-target effective lookup, and the other-target clear snapshot. The guard is not marked unavailable, no snapshot block is set, cleared or changed, and the block version is not bumped.
- R2. A typed timeout in after-hook target validation, the local after-snapshot, or the remote after-read seals the call as abandoned. Nothing is minted and the session is untouched. The ownership check runs first.
- R3. For `push`, an after-read of `remote-not-advanced` seals the call, whatever the before-read was. An after-read of `missing-resource` seals only when the before-read was also `missing-resource`. Other remote failures stay fatal: output limit, missing field, invalid JSON, and throws. So does `missing-resource` after an `available` before-read. Both the pending and the final classification must be `push`.
- R4. In a child rollup, a typed timeout in target validation or target snapshot skips the whole read pass. Nothing is minted, no block clear is committed, and the child is not recorded as rolled up, so it can be retried.
- R5. Derivation and registration lookups carry a typed timeout without misclassifying an identity failure. When a definite failure or spanning root is merged with a timeout, the failure wins. Only all-timeout, or timeout plus clean candidates, yields a timeout. A throw stays fatal.
- R6. These stay fatal for the session:
  - throws from validation or capture;
  - `canonicalParentTargetRoot` failures;
  - target-digest mismatch;
  - malformed output;
  - classifier and parser failures;
  - rollup identity checks;
  - non-timeout after-hook rejections not covered by R3.
- R7. Docs and guidance describe the new behaviour. ARCHITECTURE.md, the two solution docs that call these timeouts fatal, and the using-systematic guidance sentence are all updated, along with its bootstrap pin. The guidance says to re-run a call that returned no receipt after a timeout, and to check remote state, use `git push -u` or retry after a rejected push.

## Scope Boundaries

- No new status field. Evidence lost to a skip shows up at completion as `missingOperations`, which fails closed.
- No retry of a timed-out remote after-read. A push that really happened but whose after-read timed out stays unreceipted, the same exposure as a call skipped while blocked.
- No change to completion or status readbacks beyond what the shared registration typing implies. The parent-registration timeout becomes retryable there, which matches the #1080 intent.
- Seeding stays fatal. It gets a typed `command-timeout` cause in place of an empty one.

### Deferred to Separate Tasks

- Seed timeouts and the classifier race: #1083.
- First-push absence and remote-evidence proofs: #1081.
- Worktree registry refresh: #740.
- Snapshot correctness and restart anchors: #1099, #1126.
- Rollup re-validating the same target for every receipt (it multiplies timeout odds): note only.

## Context & Research

### Relevant Code and Patterns

`src/lib/opencode-workflow-guard.ts`:

- **Before-hook.** `prepareOperation`, `takeBeforeSnapshot`, `readBeforeSnapshot` and `blockOrFailBeforeSnapshot` already return `{kind:'skip'}` for snapshot-blocking reasons (#1124). `prepareOperation` adds `skippedOperations` on skip. `clearBlockForOtherTarget` routes a lookup or clear failure to `markUnavailable`. `clearSnapshotBlock` already returns `{status:'timeout'}` before any state change.
- **Derivation.** `deriveFileOperationTarget`, `deriveApplyPatchTarget`, `deriveDirectoryTarget`, `sharedTargetRoot`, `targetResultFromValidation` and `validationForCandidate`. The result type knows only `target-unavailable`.
- **Registration lookups.** `parentObserverRegistration` and `operationObserverRegistration` return `undefined` on error. They are used by `resolveEffectiveObserver` and by rollup.
- **After-hook.**
  - `afterTargetFailure`, `captureAfterOperation`, `captureRemoteAfter`, `remoteFailureReason` and `completeOperationObservation` live here.
  - The blocked branch seals with `sealOperation(…, true)` and returns `{status:'ignored'}`, which is the pattern to mirror.
  - `finishOperation` commits causes.
  - `takeOperationToFinish` checks `skippedOperations` first.
- **Rollup.** `rollupForegroundTask`, `readChildSnapshot`, `blockOrFailChildSnapshot`, `ChildSnapshotOutcome` and `rolledUpChildren`. Phase 1 reads and validates every receipt without minting. Phase 2 mints without reads.
- **Shared helpers.** `readSnapshot` (ok/timeout/fatal), `isProbeTimeout` and `probeFailureReason`.

`src/lib/opencode-operation-observer.ts`:
- `validateRegisteredWorktree` runs a single `git rev-parse` before it decides, so a timeout always means no verdict yet.
- Push readback in the after phase returns `remote-not-advanced` when the upstream differs from `HEAD`.

### Institutional Learnings

- `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`: skipped calls mint nothing and causes stay typed. Its lines describing hook timeouts as fatal go stale.
- `docs/solutions/best-practices/async-commit-aba-version-fence-2026-10-15.md`: timeout branches must not write the block or bump the version.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: every new branch needs a test that reaches it, and a mutation proof.
- `docs/solutions/integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`: an unvalidated target must never be admitted.
- `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`: rollup identity and lineage mismatches stay fatal, and only transient failures skip.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-workflow-guard.ts, src/lib/opencode-operation-observer.ts, tests/unit/opencode-workflow-guard.test.ts, tests/unit/opencode-operation-observer.test.ts",
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

- **Skip-only.** A timeout never sets, clears or changes the snapshot block and never bumps its version. Drift made during a skipped call is applied later, by the completion and status readbacks, which already treat their own timeouts as retryable.
- **Typed variants, not inferring from causes.** The decision to skip or seal is made where the observer result is read, from `read.status === 'timeout'` or `isProbeTimeout`. By the time `finishOperation` sees a cause, it is too late to decide.
- **Derivation precedence.** A definite failure, or a spanning root, beats a timeout when candidates are merged. A throw inside `validationForCandidate` stays `target-unavailable`, so it remains fatal.
- **Shared registration typing.** `parentObserverRegistration` and `operationObserverRegistration` return a `ProbeRead`-style result. This also makes a parent-registration timeout retryable in status, in completion, and in the block-clear control, which matches #1080. Seeding keeps its fatal path but gets a typed cause.
- **Push.** `remote-not-advanced` is a local fact: the upstream is not at `HEAD`. Sealing it mints nothing. `missing-resource` can't tell an absent upstream apart from other git failures, so it seals only when the before-read was also missing. The predicate checks both the pending and the final classification, because the classifier runs again in the after-hook.
- **Rollup skips the whole phase-1 pass.** Every local receipt in a batch shares one target, so skipping one child is the same as skipping the pass. In production, a retry needs a new `task` call to resume the child. Otherwise the loss shows up as `missingOperations` at completion.
- **One skip helper in the before-hook.** All five sites run after `bindCall`. Any site that doesn't add to `skippedOperations` causes `call-lifecycle-mismatch` in the after-hook.

## Open Questions

### Resolved During Planning

- Skip vs. block on timeout: skip-only.
- Tracked-branch push rejection: seal.
- Status visibility: no new field. Guidance carries it instead.
- Parent-registration typing side effects: accepted.
- Remote after-read retry: none.

### Deferred to Implementation

- Exact shape of the typed registration result: reuse `ProbeRead` or a local union, whichever keeps Biome complexity at or below 15.
- Whether to call the rollup skip a `skip` kind on `ChildSnapshotOutcome` or a separate return path.

## Implementation Units

- [ ] **Unit 1: Type timeouts in derivation and registration lookups**

**Goal:** Carry a typed timeout out of derivation and the two registration lookups, without changing behaviour yet.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Widen the derivation result to carry `command-timeout`, set from `isProbeTimeout` in `targetResultFromValidation`.
- Add merge precedence in `sharedTargetRoot` and the derive functions.
- Make `parentObserverRegistration` and `operationObserverRegistration` return ok, timeout, or fatal, and update their two callers.
- Callers keep today's fatal behaviour for now, except where `resolveEffectiveObserver` consumers already handle `timeout` (status, completion, block clear).
- Seeding gets a typed cause.

**Execution note:** Test-first.

**Test scenarios:**
- Happy path: a single candidate whose validation times out yields a timeout derivation result.
- Edge case: one candidate times out and another fails identity validation. The result is the identity failure.
- Edge case: one candidate times out and the other candidate is clean. The result is the timeout.
- Edge case: a spanning root plus a timeout gives the spanning failure.
- Error path: a validator throw gives `target-unavailable`, not a timeout.
- Integration: a parent-registration timeout during a status refresh is retryable and reported as unconfirmed, not `unavailable`.
- Integration: a parent-registration timeout at seed time stays fatal with a `command-timeout` cause.

**Verification:** The guard suites pass. Existing fatal-path tests are unchanged except where the shared typing intentionally makes status or completion retryable.

- [ ] **Unit 2: Skip the call on a before-hook timeout**

**Goal:** Every before-hook timeout site skips the call.

**Requirements:** R1, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add one helper used at all five sites: local snapshot, derivation, post-derivation validation, other-target lookup, and other-target clear snapshot.
- On a typed timeout it returns skip, and the call is added to `skippedOperations`.
- No `markUnavailable`, no block write, no `observeReadback`.

**Execution note:** Test-first. Flip the existing before-hook timeout tests (the before-snapshot `command-timeout` test, the validation-timeout row, and the while-blocked `command-timeout` row) to expect a skip. Keep throws and non-timeout reasons fatal.

**Patterns to follow:** the #1124 blocking-reason skip in `blockOrFailBeforeSnapshot`.

**Test scenarios:**
- Happy path, one test per site:
  - the guard is not `unavailable`;
  - no receipt is minted;
  - the after-hook is silent, with no `call-lifecycle-mismatch`;
  - a later clean call is observed normally.
- Edge case: a timeout while blocked leaves the block, its reason and its version unchanged.
- Integration: a timeout-skipped write to the pinned target, then completion. The completion is rejected with `stale-receipt` for the earlier receipt, which proves drift is still caught.
- Error path, stays fatal: throws, `target-unavailable`, `command-failed`, target-digest mismatch, `canonicalParentTargetRoot` failure.

**Verification:** No before-hook path calls `markUnavailable` for a typed timeout. Mutation proof: removing the skip at one site fails that site's test.

- [ ] **Unit 3: Seal the call on an after-hook timeout or a rejected push**

**Goal:** After-hook timeouts and push non-advance seal the one call.

**Requirements:** R2, R3, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add a `timeout` variant to the results of `afterTargetFailure`, `captureAfterOperation` and `captureRemoteAfter`.
- For `push`, add the R3 predicate.
- `completeOperationObservation` seals as abandoned and returns `ignored`, after the ownership check, mirroring the blocked branch.

**Execution note:** Test-first. Flip the after-snapshot `command-timeout` test, the remote after-read timeout row, and the `command-timeout` rows of the after-hook fatal-reason tables.

**Test scenarios:**
- Happy path: a timeout in each of after-hook validation, local after-snapshot and remote after-read. Nothing is minted, the session stays available, a duplicate after-hook is silent, and unrelated receipts are unchanged.
- Happy path, push matrix:
  - before `available` with after `remote-not-advanced`: sealed;
  - before `missing-resource` with after `remote-not-advanced`, `missing-resource` or timeout: sealed;
  - before timeout with after `remote-not-advanced`: sealed.
- Error path, stays fatal: before `available` with after `missing-resource`; output limit, missing field and invalid JSON after; throws; a non-push operation with `remote-not-advanced`.
- Edge case: the before-hook classified the call as push, but the after-hook did not (or the reverse). The R3 predicate does not apply.
- Integration: a sealed push, then a second push, then a status refresh. The guard stays available, and the second push's receipt outcome matches the remote state.
- Edge case: the call has lost ownership (the unit was redeclared). It is sealed as lost, not as a timeout.

**Verification:** No after-hook path calls `markUnavailable` for a typed timeout or for an R3 push. Mutation proof: removing the push predicate fails the tracked-branch test.

- [ ] **Unit 4: Skip the rollup pass on a child timeout**

**Goal:** A child rollup timeout skips without minting, and the child can be retried.

**Requirements:** R4, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- In phase 1, a typed timeout in child target validation, the registration lookup, or the child snapshot returns before minting.
- No block clear is committed, and nothing is added to `rolledUpChildren`.

**Execution note:** Test-first.

**Test scenarios:**
- Happy path: a child target-validation timeout. No receipts are minted, the guard is available, and the child is not recorded as rolled up.
- Happy path: a child snapshot timeout mid-batch. Nothing is minted for any child.
- Integration: a timed-out rollup, then the same child is resumed through a new task call. The rollup mints.
- Edge case: a timeout while blocked leaves the block unchanged.
- Error path, stays fatal: identity mismatch, lineage mismatch, throw, a non-timeout validation error.

**Verification:** No rollup path calls `markUnavailable` for a typed timeout.

- [ ] **Unit 5: Docs, guidance and bootstrap pin**

**Goal:** Readers and agents learn the new behaviour.

**Requirements:** R7

**Dependencies:** Units 2–4

**Files:**
- Modify: `ARCHITECTURE.md`, `skills/using-systematic/SKILL.md`, `tests/unit/bootstrap.test.ts`, `tests/unit/__snapshots__/bootstrap.test.ts.snap`, `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`, `docs/solutions/logic-errors/operation-observer-false-clean-worktree-2026-10-15.md`

**Approach:**
- Replace the statements that operation-hook and rollup timeouts are fatal.
- Document the push sealing and the unreceipted-push residual.
- Add one guidance clause: a call that returned no receipt after a timeout should be re-run; after a rejected push, check remote state and retry, or use `git push -u`.
- Regenerate the bootstrap pins.

**Test scenarios:**
- Happy path: the bootstrap byte pin and snapshot pass after regeneration.

**Verification:** markdownlint, content-integrity and the bootstrap tests pass. No doc still says that hook or rollup timeouts make the guard unavailable.

## System-Wide Impact

- **Interaction graph:**
  - Before-hook, after-hook and rollup in the adapter.
  - `resolveEffectiveObserver` consumers in status, completion and block clear, because of the shared registration typing.
  - The seed cause.
- **Error propagation:** typed timeouts and R3 pushes skip or seal one call. Everything else keeps today's fatal path and first cause.
- **State lifecycle risks:**
  - Skipped or sealed calls leave no receipt, and a real push whose after-read timed out stays unreceipted.
  - Evidence lost in rollup surfaces at completion as `missingOperations`.
- **Unchanged invariants:**
  - No receipt from an unvalidated target or a failed read.
  - The snapshot block and its version fence.
  - Marker and receipt protocol versions.
  - Completion and status readback semantics, apart from the parent-registration timeout becoming retryable.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A skip site is missed, causing `call-lifecycle-mismatch` | One helper, plus one test per site (Unit 2) |
| A timeout is misclassified, hiding an identity failure | Merge precedence plus throw-stays-fatal tests (Unit 1) |
| Drift during a skipped call is never applied | Pinned-target stale-receipt integration test (Unit 2) |
| Rejected push leaves the remote changed with no receipt | Guidance to check remote state, plus a push-then-push test (Unit 3); doc-only for the residual |
| Rollup retry rarely happens in production | Loss surfaces as `missingOperations` (fail-closed); documented |

## Sources & References

- Issue #1084; related #1080, #1081, #1083, #1124, #740.
- Related code: `src/lib/opencode-workflow-guard.ts`, `src/lib/opencode-operation-observer.ts`.
