---
title: A mutation that fails nothing needs a decision
date: 2026-10-15
category: best-practices
module: workflow-guard
problem_type: best_practice
component: development_workflow
severity: low
applies_when:
  - "Adding a defensive check, fallback, or guard branch to test-first code"
  - "A requested mutation proof reports 0 failures"
  - "A safety check would need a new accessor, interface method or widened type"
tags: [mutation-testing, mutation-proof, test-first, unreachable-code, defense-in-depth, public-interface, workflow-guard]
---

> **Note (2026-10-19):** The guard examples below are historical: the workflow guard was removed ([#1153](https://github.com/marcusrbrown/systematic/issues/1153); see [the decision note](workflow-guard-removed-2026-10-19.md)). The lesson is general and still applies.

# A mutation that fails nothing needs a decision

## Context

Behaviour changes here are written test-first and ship with a mutation proof. The proof means breaking one check, naming the test that fails, restoring the file, and confirming the restore with `cmp`. During the recoverable snapshot block (#1124, #1134), several requested proofs came back with "0 failures":

- **Stale-set check on the finalize `stale-receipt` path.** A new public core accessor and an adapter check meant only receipts that core had marked stale were retryable. Forcing the check to true failed nothing, because the adapter never marks receipts stale by age alone. The accessor and the check were removed, which also took a method off the public `WorkflowGuard` interface.
- **Guard-state check on the same path.** Removing it also failed nothing. When the guard goes unavailable, core abandons the prepared transition, so finalize returns `abandoned-transition` and never `stale-receipt`. The check was removed. The branch now tests only the reason code, and mutating that fails 10 tests.
- **Explicit block reset on a new unit.** Removing it failed nothing, because reads already hide another unit's record. It was kept as memory hygiene, with a comment saying so.
- **Set-time effective-target check.** Removing it failed nothing once a read-time filter existed. Removing both checks fails 6 tests. It was kept deliberately as defence in depth, with the reason recorded.
- **A `workspace-mismatch` branch copied from a sibling path.** It is provably unreachable and stays to mirror the sibling path.
- **A session-ID guard on a test seam.** Its new test also passed on the old code. The test pins the contract.

## Guidance

- **Treat "0 failures" as a finding.** It is not a formality. Pick one of three outcomes:
  - **Remove** the check when it is unreachable now, and something else (another layer or another check) would catch the future case.
  - **Keep it on purpose** as defence in depth. Add a short comment or review note saying why, and name what does catch the case.
  - **Restructure** so a test can reach it.
- **Check reachability before adding a safety condition.** If it is reachable through public hooks, write the test that reaches it. If it is not, don't add it, or add it under "keep it on purpose".
- **Don't widen a public interface for an unreachable check.** An accessor added only to feed a dead branch is surface area with no behaviour behind it.
- **Pin the real path instead.** Example: after the guard goes unavailable mid-readback, finalize returns `abandoned-transition`, the guard stays unavailable, and the first cause is kept. That test protects behaviour. A test of the unreachable branch would protect nothing.
- **Re-run a reported mutation yourself before relying on it.**
- **Say so when a new test passes on pre-fix code.** Describe what it pins (a contract) instead of claiming it proves the fix.

## Why This Matters

A check that no test can fail looks like coverage, and it isn't. Each one makes the code harder to change, because the next reader has to work out whether it matters. Here, an unreachable check had already added a method to a public interface before anyone tested it. The mutation step caught it before merge.

## When to Apply

- You add a branch whose comment says "should never happen".
- A mutation proof reports 0 failures, or a test you expected to fail stays green.
- A safety check needs a new accessor, interface method or widened type.
- A diff adds such a branch with no test that reaches it.

This does not apply to pure refactors with no new branches, where existing tests already reach every path.

## Examples

The shipped branch is shown in [the snapshot-block doc](../logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md#solution): it tests only `reasonCode === 'stale-receipt'`.

Before the decision it looked like this (illustrative; the names are placeholders):

```ts
if (
  reasonCode === 'stale-receipt' &&
  guardState !== 'unavailable' &&      // unreachable: unavailable abandons first
  coreMarkedStale(blockingOperation)   // unreachable: no age-only staleness; new public accessor
) { /* ... */ }
```

Mutation proof:

```bash
cp src/lib/<file>.ts /tmp/<file>.orig.ts      # save the original
# change one condition to true/false, or delete one check
bun test tests/unit/<file>.test.ts            # record which named tests fail
cp /tmp/<file>.orig.ts src/lib/<file>.ts      # restore
cmp /tmp/<file>.orig.ts src/lib/<file>.ts && echo restored
```

If no test fails, decide whether to remove, keep on purpose, or restructure, before you commit.

## Related

- [Worktree snapshot limits turned workflow guard enforcement off for the session](../logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md): where these decisions were made.
- [The operation observer reported a changed worktree as unchanged or committed](../logic-errors/operation-observer-false-clean-worktree-2026-10-15.md): mutation-checking each fixture and finding tests that other checks mask.
- [Workflow guard digests collapsed long values, and large operation arguments disabled the guard](../logic-errors/workflow-guard-digest-collapse-long-identities-2026-10-14.md): a boundary test that could not isolate an encoding, and was dropped instead of kept as false coverage.
- [Plan Risks-table rows must enforce as discrete spec checks](../workflow-issues/risks-table-rows-must-enforce-as-spec-checks-2026-05-18.md).
- [An exemption must be predicated on the uncheckable condition](./exemption-predicates-must-name-the-uncheckable-condition-2026-08-18.md): testing an exemption from both sides with a mutation.
