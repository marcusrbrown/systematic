---
title: A propagated pull-request baseline hid seed timeouts
date: 2026-10-17
category: logic-errors
module: workflow-guard
problem_type: logic_error
component: development_workflow
symptoms:
  - "A check or review seed timeout after a pull-request seed recorded no seedDeferrals entry"
  - "The operation's one-time before-read retry never ran, because it is keyed on the deferral record"
  - "A check timeout recorded before the pull-request seed was cleared by the next before-read, whatever that read returned"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [workflow-guard, seed-deferral, propagated-baseline, pr-creation-seed, check-readback, review-readback, command-timeout, status-diagnostics]
---

# A propagated pull-request baseline hid seed timeouts

## Problem

When a unit starts, the OpenCode guard adapter (`src/lib/opencode-workflow-guard.ts`) seeds a baseline for each remote operation. A baseline is the expected remote resource identity for an operation, such as a pull request. A seed that times out is deferred: status lists it in `seedDeferrals`, and the operation's first before-read is retried once. A pull-request-creation seed also propagates a resource identity, with no revision baseline, to `check-readback` and `review-readback` (`propagatePullRequestScope` in `src/lib/workflow-guard.ts`). That propagated baseline suppressed the deferral record for those operations, so their timeouts disappeared from status and lost the retry (#1083, fixed in #1144). Terms such as unit, receipt and readback are defined in [the snapshot-limits doc](./worktree-snapshot-limits-disable-guard-2026-10-15.md).

## Symptoms

- Seed pull-request creation as available, then time out the check seed. Status showed no deferral for `check-readback`.
- Admission still needs the operation's own before-read to match the baseline, so a call failed with no recorded reason.
- In the reverse order, the check seed times out first and is deferred, and the pull-request seed then propagates. The next check before-read cleared the deferral even when that read had itself timed out.

## What Didn't Work

- **Treating any baseline as the operation's own.** `recordSeedDeferral` returned early on `hasResourceBaseline(operation)`. That is true for a declared resource scope, which really is the operation's baseline. It is also true for a baseline propagated from another operation's seed, which is not.
- **Clearing on any read when a baseline exists.** `bindDeferredBaseline` cleared the deferral whenever the core held a baseline, so a timed-out or missing read erased the record.
- **A match-only core accessor.** Clearing only when the before-read matches the propagated baseline needs a new core method. It also leaves a stale timeout in status for the rest of the unit, and adds an extra probe to every later timed-out read. Admission already rejects a mismatch, so it was not adopted.
- **Dropping the observer check from the clear.** Without it, a read from another registered worktree's observer would clear the parent's deferral.

## Solution

Skip the deferral only when the unit declared the operation's resource scope. `requiredResourceOperations` covers scopes the runtime policy or the agent declared:

```ts
// recordSeedDeferral
if (hasDeclaredResourceScope(operation)) return
```

When a baseline is already present, clear the deferral only on the operation's own `available` before-read from the seed's observer and target. Any other read keeps it. This branch never calls `observeReadback`, because the core overwrites resource identities unconditionally on a readback:

```ts
// bindDeferredBaseline (abbreviated: the initiator check and the deferred-record lookup are omitted)
if (requireGuard().hasResourceBaseline(operation)) {
  if (before?.status === 'available' && sameSeedObserver(deferred, observer)) {
    clearSeedDeferral(operation)
  }
  return
}
```

The retry needed no change. It is keyed on the deferral record, so it runs again once the record exists.

## Why This Works

A declared scope is the agent's statement of that operation's identity, which admission checks against the operation's own before-read. A propagated identity is another operation's.

The record is keyed on the declared scope. It clears only on the operation's own `available` read from the same observer and target. That read is not checked against the pull request identity, so the record can clear without the operation matching its own resource (first limit below).

Admission is unchanged. It compares the before-read's resource identity with the baseline, propagated or not, and compares the revision only when a revision baseline exists.

An operation with a declared scope records no deferral when its seed times out. Status shows nothing and the retry does not run. A call whose own before-read does not supply the identity still fails closed as `resource-mismatch`. The scope is agent input, so this applies to any scope the agent declares. It is the seeding rule in `ARCHITECTURE.md`: a diagnostics gap, not a bypass.

Limits, listed in `ARCHITECTURE.md` (Other residuals):

- An `available` before-read for a different pull request clears the deferral, and admission then rejects the call as `resource-mismatch`.
- The clear leaves the operation's revision baseline unset, so its first before-revision is not compared with the guard's last-known revision.
- A deferral recorded before the operation was declared stays until the operation's own `available` read or the end of the unit.
- Each changed redeclaration of a unit that has not yet recorded evidence reruns every remote seed. An unchanged redeclaration is rejected before any seed runs.

## Prevention

- Key bookkeeping on the operation's own evidence, not on a baseline another operation produced.
- Clear a diagnostic record only on the event it waits for, and check what that event proves. Here it is the operation's own `available` read from the same observer and target, which does not prove the pull request identity, so a different-PR read clears the record too.
- When a test pins "no record", check that it pins a design choice and not a hidden failure.
- Tests are in `tests/unit/opencode-workflow-guard.test.ts` under "remote seeding deferrals" (helpers `deferralAdapter`, `sequenceObserver`, `statusParsed`), including the nested block "a deferral over a propagated baseline". Making the clear unconditional fails three tests there: "a check seed that timed out before the pull request seed keeps its deferral…", "a before-read from another registered worktree observer does not clear the deferral", and "a timed-out before-read is retried exactly once while a deferral sits over the propagated baseline". The flipped test is "g: a check timeout after pr-creation seeded records a check deferral over the propagated baseline" (the `g:` is part of the real title).

## Related Issues

- #1083, fixed in #1144. The other half of #1083, a core observation finalized against a redeclared unit, is covered in [the version-fence doc](../best-practices/async-commit-aba-version-fence-2026-10-15.md).
- [Worktree snapshot limits turned workflow guard enforcement off](./worktree-snapshot-limits-disable-guard-2026-10-15.md): seed deferral for snapshot-blocked seeds.
- [Stop patching after the second review round](../workflow-issues/stop-patching-after-second-review-round-2026-10-15.md): the original seed-deferral scope (#1005).
- [Receipt guard missed worktree-targeted child operations](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md): observer and target identity, which the clear preserves.
