---
title: "fix: Observe operations only while guarded work can use them"
type: fix
status: completed
date: 2026-10-13
---

# fix: Observe operations only while guarded work can use them

## Overview

The OpenCode workflow guard snapshots the worktree before and after every shell or edit call, in every session. Without an epoch, both snapshots are discarded: no receipt is minted and the core is never called. A failed snapshot still marks the guard `unavailable` for the rest of the session. Only three skills start an epoch, so most sessions now pay this cost for nothing. Some of them also lose the guard over a failure that protected nothing (#1105).

After this change, the guard observes an operation only when an epoch is active or an allowlisted skill call is still pending. Every other call skips observation entirely.

## Requirements Trace

- R1. Shell and edit calls take no snapshot, compute no fingerprint, and cannot change guard state in these cases:
  - no epoch is active and no allowlisted skill call is pending;
  - the guard state is `disabled` or `unavailable`;
  - the epoch has completed.
- R2. Observation is unchanged while the epoch's status is `active`, whatever the guard state (`waiting`, `rejected`, `protected`), and while an allowlisted skill call is pending.
- R3. A skipped call's after-hook is silent. It never records `call-lifecycle-mismatch`, never mints a receipt, and never changes state, even if an epoch has activated by then. This holds within one plugin process; after a restart the in-memory skip record is gone, as for every pending call today.
- R4. ARCHITECTURE.md states when operations are observed, and documents the one ordering limit.

## Scope Boundaries

- No core change (`src/lib/workflow-guard.ts`) and no new guard API.
- No change to child-session rollup, skill, start, complete, status or readback paths.
- Snapshot correctness and read races stay in #1099. Hook timeout isolation inside an active epoch stays in #1084.
- Arguments over the 8192-character fingerprint budget still make an active epoch's guard unavailable. That is #1113. This plan only removes the inactive-session case, because the gate runs before the fingerprint.
- Operations that begin before the unit and carry no initiator are not fenced here. With this change they occur only while a skill call is pending, where attaching them to the activating unit is the intended behavior.

## Context & Research

- `src/lib/opencode-workflow-guard.ts`:
  - `prepareOperation` (~3565): binds the call, derives and validates the target, takes the before snapshot, runs the remote before-read and `bindDeferredBaseline`, then stores a `PendingOperation`.
  - `finishOperation` (~5035) → `completeOperationObservation` (~4888): takes the after snapshot, then `buildOperationObservation` returns `undefined` without an epoch and unit, and the call is sealed as `ignored`.
  - `takePendingOperation` (~4647): a missing pending entry records `call-lifecycle-mismatch`, unless `isSealedOperationReplay` (~4631) matches first.
  - `sealOperation` (~4618) and `sealedOperations` already make a call's after-hook silent.
  - `pendingSkills` holds only allowlisted skill calls that are prepared but not finished. It is cleared at transform.
  - `observerReadbackApplies` (~3022) is the existing precedent for gating on epoch presence.
- `src/lib/opencode-operation-observer.ts` `snapshot()` is fully synchronous: about nine `spawnSync` calls plus file hashing, bounded by 20,000 files and 128 MiB. A call pays for two snapshots plus a worktree validation.
- Readbacks (`refreshReadback`, `completionReadbacks`) take their own fresh snapshots. They never use per-operation snapshots taken while inactive.
- The core accepts an operation that began before its unit. No rule rejects that, so today an operation that starts before any skill load and finishes after activation counts toward the new unit.
- `docs/solutions/workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md`: an active protected unit must stay fail-closed. Only the inactive path changes.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-workflow-guard.ts, src/lib/opencode-operation-observer.ts, src/lib/workflow-guard.ts, tests/unit/opencode-workflow-guard.test.ts",
  "freshness": {
    "vcs_reference": "5b39b97a"
  },
  "budget": {
    "max_search_passes": 14,
    "max_candidate_inspections": 12,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:prepareOperation",
      "description": "Per-call before-hook: target derivation, before snapshot, pending record.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:sealOperation",
      "description": "Marks a call digest so its after-hook replays silently.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:observerReadbackApplies",
      "description": "Epoch-presence predicate that gates status readbacks.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:pendingSkills",
      "description": "Allowlisted skill calls prepared but not yet finished.",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Gate on "epoch active or allowlisted skill pending".** Observe when the guard state is neither `disabled` nor `unavailable`, and either `epoch.status === 'active'` or `pendingSkills` is non-empty. Read state from the published guard after host recovery. Gating only on the epoch would break the case #1105 names: a commit that starts while a `ce:work` load is pending would have no pending record when it finishes, and the guard would go unavailable. Gating on the epoch merely existing would keep observing after it completes, because a completed epoch projects as `protected`.
- **Gate first, before any argument work.** The check runs at the top of `prepareOperation`, before the args fingerprint, call binding, target derivation or snapshots. A fingerprint can fail on large arguments (#1113), so the skip must not depend on one.
- **Record skips by call digest.** A skipped call's digest goes into a dedicated skip set. `finishOperation` checks that set first and returns silently. The sealed-call replay check needs a fingerprint, so it cannot serve skips. The after-hook never re-derives the decision from current state.
- **Parallel ordering.** With parallel tool calls, the outcome depends on which before-hook runs first.
  - Command first: the command is skipped and no longer counts. The unit reports missing evidence and the agent reruns it. That fails closed. Today such an operation attaches to a unit it predates.
  - Skill first: the skill call is pending, so the command is observed and attaches to the unit the skill activates. That is the intended behavior. A test pins it.

## Implementation Units

- [x] **Unit 1: Gate operation observation**

**Goal:** Shell and edit calls in sessions with no guarded work take no snapshot and cannot change guard state.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- At the top of `prepareOperation`, before the args fingerprint, skip observation unless the gate in Key Technical Decisions holds. Read the state from the published guard.
- A skipped call records its call digest in a skip set and returns. It does no fingerprinting, binding, target derivation, snapshot, remote read or pending record.
- `finishOperation` checks the skip set first. A skipped digest returns silently and leaves the set.

**Execution note:** Test-first. Hoist a snapshot-counting observer wrapper over the shared sequence observer in the test file.

**Patterns to follow:**
- The existing sealed-call replay tests, for silent after-hooks.
- `observeSkill` and `observeOperationTool` test helpers.

**Test scenarios:**
- Happy path: in an inactive session, a shell call and an edit call each take zero snapshots. Status stays `inactive / no-active-epoch` and no cause is recorded.
- Happy path: in an inactive session, an observer whose snapshot would fail (limit, timeout, error) is never called, and status stays `inactive`.
- Happy path: in an inactive session, a `write` with 9 KiB of content takes no snapshot, records no cause, and its after-hook is silent.
- Happy path: a `waiting` epoch observes as today. One before and one after snapshot are taken, and the receipt counts.
- Edge case: a commit whose before-hook runs while a `ce:work` skill call is pending is observed. After activation it counts toward the new unit. This is the #1105 constraint. Keep the existing pending-skill race test (~12602) green.
- Edge case: an operation skipped while inactive whose after-hook runs after an epoch activated is silent. There is no `call-lifecycle-mismatch`, no receipt, and the unit reports `waiting / missing-evidence`.
- Edge case: disabled mode takes no snapshot.
- Edge case: an unavailable guard takes no snapshot, and its first cause is unchanged.
- Edge case: an epoch-completed session takes no snapshot.
- Edge case: a session whose guard state is `rejected` with an active epoch still observes.
- Regression: with an active epoch, a missing pending entry for an operation that was not sealed still records `call-lifecycle-mismatch`.
- Rewrite: tests that run operations with no skill load and expect a cause or state change now load `ce:work` first, and each keeps the cause it pins. This covers:
  - the first-cause diagnostic block (~9084–9962), including the unfingerprintable-input case (~9246);
  - the hook-threw block (~10014–10363), including the secret-write case;
  - any direct bash-hook tests (~7363–8140) the run turns up.

**Verification:**
- The guard, workflow-guard and observer unit suites pass.
- Removing the gate by hand fails the inactive no-snapshot tests.

- [x] **Unit 2: Latency evidence and documentation**

**Goal:** Show the cost removed, and document when operations are observed.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Modify: `ARCHITECTURE.md`

**Approach:**
- Measure one shell call's before and after hooks in an inactive session, using the real observer on this repository, before and after Unit 1. Report snapshot time separately from total hook time, and state the repository's file count and size. Report the numbers in the PR. No benchmark is committed.
- In ARCHITECTURE.md's receipt-backed guard section, state that operations are observed only while an epoch is active or an allowlisted skill call is pending. Add the parallel-ordering behavior to the known limits.

**Test scenarios:**
- Test expectation: none -- measurement and documentation only.

**Verification:**
- Content-integrity and markdownlint are clean.
- The real-host receipt workflow suite still passes. Run it with PID-diff reaping.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A guarded flow relied on an operation that started before activation | Only the parallel command-first ordering loses its receipt. It fails closed, and the agent reruns the command. Documented. |
| The pending-skill check misses a non-allowlisted load | Non-allowlisted loads never start an epoch, so there is nothing to observe for. |
| Disabled mode loses observation | Disabled mode never used the result. |

## Sources & References

- Issue: #1105. Related: #1096, #1099, #1084, #1113.
