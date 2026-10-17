---
title: A transient command timeout turned the workflow guard unavailable for the whole session
date: 2026-10-15
category: logic-errors
module: workflow-guard
problem_type: logic_error
component: development_workflow
symptoms:
  - "A command timeout from the operation observer marked the guard unavailable, a terminal state for the rest of the session"
  - "A timed-out registered-worktree validation was classified like an identity failure"
  - "A push whose after-read showed the upstream had not advanced, including a normal non-fast-forward rejection, marked the guard unavailable"
  - "The timeout type was dropped at three lookup points, so a timeout could not be told apart from a fatal failure"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [workflow-guard, command-timeout, guard-unavailable, timeout-classification, operation-observer, push-receipts, rollup-halt, attestation]
---

# A transient command timeout turned the workflow guard unavailable for the whole session

## Problem

In the OpenCode guard adapter (`src/lib/opencode-workflow-guard.ts`), a transient failure inside one guarded operation made the workflow guard `unavailable` for the rest of the session. `unavailable` is terminal, so enforcement stopped until the session ended. Terms such as unit, receipt, readback and effective target are defined in [the snapshot-limits doc](./worktree-snapshot-limits-disable-guard-2026-10-15.md). Two failures did this: a typed `command-timeout` in an operation hook or in child rollup, and a push whose upstream did not advance (#1084, fixed in #1138).

## Symptoms

- A typed `command-timeout` from the observer, or from a registered-worktree validation, reached `markUnavailable`. It did so from:
  - the before-hook: local snapshot, target derivation, post-derivation validation, and the other-target lookup and clear;
  - the after-hook: target validation, local after-snapshot, remote after-read;
  - phase 1 of child rollup: registration lookup, target validation, child snapshot.
- A push whose after-read was `remote-not-advanced` was fatal. That covers a normal non-fast-forward rejection.
- The timeout type was lost in three places: the target-derivation result knew only `target-unavailable`, and `parentObserverRegistration` returned `undefined` on any error, as did the child registration miss built on it. In each case a timeout looked like an identity failure.

## What Didn't Work

- **Keeping local timeouts fatal.** Skipping a timed-out write lets a later observed write attest a state the skipped write produced. Keeping the call fatal instead turns enforcement off for the whole session, and the model already accepts this gap (see Why This Works).
- **Guidance to re-run any call that returned no receipt.** Every skipped or sealed call has already run, so re-running a push or an edit applies it twice. The guidance says to check state first.
- **Sealing only an initial push.** The common failure is a rejection on a tracked branch: the before-read is `available` and the after-read is `remote-not-advanced`. Initial-push-only sealing left that case fatal.
- **Sealing `missing-resource` only when the before-read was missing.** A before-read that timed out, followed by a `missing-resource` after-read, stayed fatal. That broke the rule that a typed timeout affects only the one call (see Solution).
- **Returning early on an `apply_patch` workdir timeout.** The patch's file targets were never checked, so a definite failure such as an absolute `.git/config` target was hidden behind the timeout and skipped.

## Solution

Timeouts are typed from end to end. `TimedOutRead` is the `timeout` arm of `ProbeFailure`. A timeout is recognised only by `isProbeTimeout`, `read.status === 'timeout'`, or a derivation `reasonCode` of `command-timeout`, never inferred from a cause. A typed timeout affects only the one call, except in child rollup, where it halts that rollup pass:

| Where | Outcome |
|---|---|
| Before-hook (snapshot, derivation, validation, other-target lookup and clear) | **Skip.** The call goes into `skippedOperations` and runs unobserved, and its after-hook is silent |
| After-hook (validation, local snapshot, remote read) | **Seal.** `sealAndIgnore` seals the call as abandoned and returns `ignored`, after the ownership check |
| Child rollup phase 1 (registration, validation, snapshot) | **Halt.** Nothing is minted, no block clear is committed, and the child is not marked rolled up, so a later task call can retry it |

A timeout itself never writes, clears or bumps the snapshot block. A clean snapshot of the effective target, taken earlier in the same call, may already have cleared it, and that clear stays. Throws, identity and target mismatches, malformed output, classifier and parser failures, and rollup identity and lineage checks stay fatal. Snapshot-blocking reasons block the unit instead (see the snapshot-limits doc), and an unadvanced push is sealed (below).

**A definite failure wins over a timeout.** `sharedTargetRoot` scans every candidate before deciding:

```ts
// src/lib/opencode-workflow-guard.ts (header comment and declarations omitted)
for (const target of targets) {
  if (target.status === 'available') roots.push(target.targetRoot)
  else if (target.reasonCode === 'command-timeout') timedOut = true
  else definiteFailure = true
}
const targetRoot = roots[0]
const spans = targetRoot !== undefined && roots.some((r) => r !== targetRoot)
if (definiteFailure || spans) return unavailableOperationTarget()
if (timedOut) return timedOutOperationTarget()
```

`deriveApplyPatchTarget` keeps the resolved workdir path even when its validation times out. It derives every file target against that path and adds the workdir timeout as one more verdict. A validator that throws stays `target-unavailable`.

**A push that did not advance is sealed** when both the before-hook and the after-hook classified the call as a push:

```ts
// settleUnadvancedRemote (comments omitted)
const bothPush =
  pending.remoteOperation === 'push' && finalOperation === 'push'
const before = pending.remoteBefore
const sealed =
  bothPush &&
  (unadvanced.reasonCode === 'remote-not-advanced' ||
    before?.status === 'missing-resource' ||
    isProbeTimeout(before))
if (sealed) return sealAndIgnore(callDigest, pending)
sealOperation(callDigest, pending, true)
return afterFailure('operation-observation-rejected', unadvanced.reasonCode)
```

These stay fatal: an `available` before-read followed by a `missing-resource` after-read, output-limit and malformed remote results, and PR creation.

**Registration lookups** now return ok, timeout or fatal. As a result, a parent-registration timeout is retryable in a status refresh (reported as unconfirmed), in completion (`readback-timeout`) and in the block clear. At seed time a registration timeout stays fatal, with a typed `command-timeout` cause. A remote seed read that times out is deferred instead (#1005).

**Guidance** in `skills/using-systematic/SKILL.md`:
- A skipped or sealed call has already run. Check the worktree for a local call, or remote state for a push or PR creation, and rerun only if its effect is missing.
- After a rejected push, never force-push or delete a remote ref without the user's approval.

## Why This Works

Receipts are bound to a worktree and repository revision, so the guard attests the final state of what the observer digests, not every write. Ignored content is outside that digest (#1126). That was already true for calls skipped while blocked, inactive sessions, tools the classifier does not recognise, and destructive pushes, which are never observed. A skipped or sealed call fits the same model. The next readback marks older receipts stale, and later observed work attests the final state. The exception is a verification that overlapped another local call: it is sealed, so it must be rerun alone (see [the verification-overlap doc](./verification-overlap-mints-receipt-2026-10-17.md)).

Two tests in `tests/unit/opencode-workflow-guard.test.ts` pin this. In one, a later observed write and its verification attest the final state after a skipped write, and completion succeeds. In the other, a skipped write followed by completion is rejected as `stale-receipt`. Fully attesting every write would need a new mechanism, an unattested-digest marker, and that is out of scope.

Residuals, documented in `ARCHITECTURE.md`:
- `missingOperations` reports a lost call only when its operation has no receipt at all.
- A push that landed but whose after-read timed out has no receipt. Later pushes in that unit are rejected as `resource-mismatch` until the unit is redeclared.
- The evidence a halted child rollup did not mint shows up only when the operation has no other receipt.
- A snapshot that always times out keeps completion in a retryable `readback-timeout`. The way out is to fix the tree or have the user disable the guard.
- A skipped call is silent: no status field or counter records that it was skipped. Only a later stale receipt or missing operation shows it. It still counts toward the local call sequence, so it can seal an overlapping verification.
- The guard cannot tell an induced timeout from a transient one, so any call whose probe times out runs unobserved. Final-state attestation is what still holds.

## Prevention

- **Type every timeout as its own arm** at the point where the observer result is read. By the time a cause reaches `finishOperation`, it is too late to decide.
- **Aggregate before you decide.** When several verdicts combine, scan all of them and let a definite failure win. An early return on the first timeout hides the failures that come after it.
- **One write site per skip path.** Before-snapshot paths return `{ kind: 'skip' }` and `prepareOperation` records it. Derivation and validation record their own skip and return. A site that forgets causes `call-lifecycle-mismatch` in the after-hook.
- **Classify pushes in both hooks.** The classifier runs again in the after-hook, so a push rule must check both the pending and the final classification.
- **Test patterns** (`tests/unit/opencode-workflow-guard.test.ts`):
  - `validateRegisteredWorktree` is synchronous, so a timeout cannot be held open. Use helpers that time out on the Nth call, such as `timeoutPinnedValidationOnCall(n)` and `timeoutLocalSnapshotOnCall(n)`.
  - Script push before-reads as seed, before-read and retry. A single repeated value hides an available seed followed by a timed-out before-read.
  - Remove each skip, seal, halt and push clause in turn and confirm that the named tests fail.

## Related Issues

- #1084, #1138. Related: #1080 (status and completion readback timeouts).
- [Worktree snapshot limits turned workflow guard enforcement off for the session](./worktree-snapshot-limits-disable-guard-2026-10-15.md): the per-unit block for worktree-caused failures. This doc covers transient per-call failures.
- [An async read that commits on return must detect any change made while it waited](../best-practices/async-commit-aba-version-fence-2026-10-15.md): the timeout paths keep its ownership and version checks.
- [A mutation that fails nothing needs a decision](../best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md)
- [Receipt guard missed worktree-targeted child operations](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md): identity and registration failures still fail closed.
- [A verification that overlapped another local call could still mint a receipt](./verification-overlap-mints-receipt-2026-10-17.md): the overlap exception to final-state attestation.
