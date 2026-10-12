---
title: "fix: Size the operation snapshot for real repositories and record why it fails"
type: fix
status: completed
date: 2026-10-12
---

# fix: Size the operation snapshot for real repositories and record why it fails

## Overview

Raise the operation observer's fixed snapshot limits to sizes that real repositories fit in. Hashing does not change. Every guard hook path that makes the guard unavailable records a bounded cause.

## Problem Frame

The guard hashes every tracked and untracked file on each operation, and the total is capped at 16 MiB. Once a repository grows past that cap, the first shell command after any skill load gets `file-output-limit` from the snapshot. The before-hook then calls `markUnavailable()` with no cause, and the guard stays unavailable for the rest of the session. This was reproduced on a real host with one plugin registration and with two (#1095). Raising the cap to 32 MiB made the same session report `waiting`. Fro Bot reviews of this repository already hit the cap, and status says only `unavailable`, with no `firstUnavailableCause`.

Two other caps sit close behind the byte cap. `maxFiles` is 4096. The 1 MiB command-output cap limits `ls-files --stage` to roughly 7k entries at typical path lengths.

Two broader designs were reviewed and rejected:
- **Git index identity.** Deriving clean-file identity from git's index failed review. Reproduced cases (a forged index, repo clean filters, assume-unchanged entries) made edited files read as unchanged.
- **Chunked reads.** Chunked reads with a 1 GiB cap and a time ceiling widened read-race windows. The ceiling also could not bound per-entry git spawns.

Both added surface that removing the cliff does not need.

## Requirements Trace

- R1. Repositories within the new limits get an available snapshot. This repository and its review checkouts are well inside them.
- R2. Worktree identity is unchanged: the same paths, the same facts, the same reads, the same digests.
- R3. Above the byte, file, or listing limit, the snapshot fails closed with the existing specific observer reason.
- R4. Remote readback bounds stay as tight as today.
- R5. Every guard hook transition to unavailable records a bounded cause. Where an observer or validation reason exists, the cause carries it. Status reports the cause, and the cause never carries free text.

## Scope Boundaries

- No change to how files are read or hashed, to the digest format, or to the trust model.
- No change to remote readback semantics, activation seeding, or completion readback.
- Receipt, marker, and readback protocols are unchanged.
- Non-git workspaces behave as today: they go unavailable on the first operation. They now record a cause (worktree validation fails first with `command-failed`).

### Deferred to Separate Tasks

These go to #1099:
- Existing false "unchanged" results: `core.ignorecase`, dirty submodules, ignored files, gitfile redirection, and repo filters in commit closure.
- Read races during a snapshot: overwritten or appended bytes, a symlink swap between lstat and read, and files created after the listing.
- An agent being able to push the worktree over a limit and make the guard unavailable on demand.

Other separate tasks:
- Unknown skills activating a `ce-work` epoch: #1096.
- Operation-hook timeout isolation and retries: #1084.
- Snapshot performance, such as an in-memory stat cache, with its own trust analysis.

## Context & Research

### Relevant Code and Patterns

- `src/lib/opencode-operation-observer.ts`:
  - `DEFAULT_LIMITS`: 1 MiB command output, 5 s command timeout, 4096 files, 16 MiB total.
  - `readWorktreeRevisionV2`: the listing and the `maxFiles` check.
  - `appendRegularFact` / `appendSymlinkFact`: the byte budget.
  - The remote parsers (`parsePullRequest`, `checkState`) reuse `maxFiles` as an item cap.
- `src/lib/opencode-workflow-guard.ts`:
  - `prepareOperation`: cause-less `markUnavailable()` sites.
  - `bindCall`: shared by skill, start, complete, and operation calls; conflict at about line 2831.
  - `takePendingOperation`: missing or mismatched pending call.
  - `captureAfterOperation`: five `undefined` returns.
  - `captureRemoteAfter`: swallows throws and reasons. `missing-resource` is a distinct status and must stay one.
  - `classifyLocalObservation`.
  - `observeClassifiedOperation`: swallows throws.
  - `completeOperationObservation` / `finishOperation`.
  - The `before`/`after` wrappers. They also cover skill, start, complete, task rollup, and recovery branches.
  - Adapter catches for `tool.execute.before`, `tool.execute.after`, `event`, and the transform.
  - Cause plumbing: `GuardUnavailableCause`, `observerReadbackFailedCause`, `recordUnavailable` (first cause wins).
- Tests:
  - `tests/unit/opencode-operation-observer.test.ts`: `createGitFixture` real repos; budget tests inject small limits; no test pins the defaults.
  - `tests/unit/opencode-workflow-guard.test.ts`: cause-table tests.

### Institutional Learnings

- `docs/solutions/integration-issues/workflow-guard-skipped-skills-over-32kb-2026-09-26.md`: put the size cap on the path whose evidence it bounds. Test both the large-success case and real overflow.
- `docs/solutions/workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md`: record the earliest specific cause. `unavailable` is a state, not a cause.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-operation-observer.ts, src/lib/opencode-workflow-guard.ts",
  "freshness": { "vcs_reference": "3763b5a" },
  "budget": { "max_search_passes": 14, "max_candidate_inspections": 26, "exhausted": false },
  "candidates": [
    { "path_or_symbol": "src/lib/opencode-operation-observer.ts:DEFAULT_LIMITS", "description": "Fixed byte, file, output, and timeout caps for local snapshots, also reused as the remote item cap.", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-operation-observer.ts:parsePullRequest/checkState", "description": "Remote readback parsers bounded by maxFiles.", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:GuardUnavailableCause/observerReadbackFailedCause", "description": "Bounded enum-only cause union and builder; lacks hook sites and operation kinds.", "disposition": "extend" },
    { "path_or_symbol": "src/lib/opencode-workflow-guard.ts:recordUnavailable", "description": "First-cause-wins recording on the transition to unavailable.", "disposition": "reuse" }
  ]
}
```

## Key Technical Decisions

- **Limits.** Total file bytes go to 128 MiB, files to 20,000, and command output to 8 MiB. 8 MiB covers about 50k listing entries at 150 bytes each. The values are deterministic, so the same tree always gets the same answer. They leave ample headroom for this repository (about 17 MB, 734 files). They keep the cost of each synchronous snapshot to a few seconds at the cap; measured warm, about 160 µs per file and about 1 s per GiB. Larger trees fail closed with a cause.
- **Separate remote item cap.** A new `maxRemoteItems` limit, defaulting to 4096, replaces the parsers' reuse of `maxFiles`, so raising the file cap does not loosen remote bounds.
- **Reads unchanged.** Whole-file reads and the existing pre-read size check stay as they are. Read-race hardening belongs to #1099.
- **Cause sites are hooks.** Sites are `tool-before`, `tool-after`, `event`, and `transform`. The existing activation and readback sites keep their names. Each site names where the transition happened, and the kind names why. `bindCall` takes its site from its caller.
- **Cause kinds.** New kinds: `operation-input-invalid`, `operation-target-mismatch`, `call-lifecycle-mismatch`, `operation-classifier-unavailable`, `operation-observation-rejected`, and `hook-threw`. Snapshot failures reuse `local-snapshot-error` and `local-snapshot-unavailable`, carrying the observer `reasonCode`.
- **Precedence.** An exception that a helper already turns into a typed result keeps that result's kind. `hook-threw` is used only by a hook's outermost catch, for exceptions nothing else classified.
- **Enum-only causes.** Causes carry only enum fields and `timedOut`. Never error messages, paths, or digests.

| Path | Site | Kind | reasonCode |
|---|---|---|---|
| Missing fingerprint; target not derivable; worktree validation throws; unregistered or mismatched worktree; parent root unresolvable | tool-before | operation-input-invalid | validation reason where one exists |
| Snapshot throws / returns unavailable | tool-before, tool-after | local-snapshot-error / local-snapshot-unavailable | observer reason |
| Target digest mismatch | tool-before, tool-after | operation-target-mismatch | — |
| `bindCall` conflict (any call kind); missing or mismatched pending operation | caller's site | call-lifecycle-mismatch | — |
| Host output cannot be parsed | tool-after | operation-input-invalid | — |
| Classifier missing, throws, or returns an unexpected category | tool-after | operation-classifier-unavailable | — |
| Remote-after unavailable; PR self-seed rejected; observe throws or returns unavailable | tool-after | operation-observation-rejected | remote or guard reason |
| Unclassified exception in a hook | tool-before, tool-after, event, transform | hook-threw | — |

## Open Questions

### Resolved During Planning

- Identity scheme and reads: unchanged (maintainer decision after two review rounds).
- Non-git workspaces: unchanged, plus a cause.
- Read races and on-demand unavailability: deferred to #1099 (maintainer decision).

### Deferred to Implementation

- Whether any existing cause-table test asserts the absence of a cause on a path that now records one. Update it to the new contract.

## Implementation Units

- [x] **Unit 1: Real-repository limits and a separate remote item cap**

**Goal:** Ordinary large repositories get an available snapshot, while remote bounds stay as they are.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Raise `DEFAULT_LIMITS` as decided.
- Add `maxRemoteItems` to the limits and the limits option, and point the remote parsers at it.

**Execution note:** Test-first. The large-fixture test fails on the old defaults.

**Patterns to follow:** existing `limits` injection; `createGitFixture`.

**Test scenarios:**
- Happy path: a fixture with more than 16 MiB of content and more than 4096 files yields an available snapshot under the default limits. Generate content into a few large files plus many small files to keep the fixture quick.
- Error path: an injected small byte limit returns `file-output-limit`. An injected small file count returns `file-limit`. An injected small output limit on the listing returns `command-output-limit`.
- Edge case: with `maxFiles` raised, a pull-request or checks payload over `maxRemoteItems` is still rejected with the existing remote item reason.

**Verification:** The existing observer suite passes unchanged except for tests that intentionally exercise the new defaults.

- [x] **Unit 2: Bounded causes for every guard hook transition to unavailable**

**Goal:** Status names where and why a hook made the guard unavailable.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Implement the site and kind table.
- The capture, remote-after, classifier, and observe helpers return typed failures instead of `undefined`. `missing-resource` stays distinct.
- `takePendingOperation` and `bindCall` record their own cause.
- The outermost catch of each hook records `hook-threw` for its site.

**Execution note:** Test-first. Each table row gets a failing assertion before its site changes.

**Patterns to follow:** `observerReadbackFailedCause`; existing cause-table tests; `recordUnavailable`.

**Test scenarios:**
- Error path: a before-hook snapshot returns `file-output-limit`. Status shows `firstUnavailableCause` `{site: tool-before, kind: local-snapshot-unavailable, reasonCode: file-output-limit}`.
- Error path: an after-hook snapshot returns unavailable, giving a `tool-after` cause. A thrown snapshot gives `local-snapshot-error`.
- Error path: a before-hook observer `command-timeout` records `timedOut: true`.
- Error path: one case per remaining table row asserts its site and kind. For `bindCall`, cover a skill call and an operation call, and check that each reports its own site.
- Edge case: an exception in the event and transform hooks records `hook-threw` with that site.
- Edge case: when a later operation also fails, the earlier cause is kept (first wins).
- Edge case: a non-git workspace's first operation records `tool-before` with `operation-input-invalid` and `command-failed` (worktree validation runs before the snapshot and fails first).
- Integration: a hook throws while a file with a secret-looking name exists. The serialized status contains only the allowlisted cause keys, and no path or message text.

**Verification:** No guard hook transitions to unavailable without a cause.

- [x] **Unit 3: Documentation**

**Goal:** Architecture docs state the limits and the hook causes.

**Requirements:** R1, R3, R5

**Dependencies:** Units 1-2

**Files:**
- Modify: `ARCHITECTURE.md` (observer entry and receipt-backed workflow guard paragraph)

**Approach:**
- State the limits, the fact that snapshots are synchronous, and the fail-closed reasons.
- List the cause sites and kinds.
- Link #1099 for the known false "unchanged" results and read races.

**Test expectation:** none -- documentation only.

**Verification:** `bun scripts/content-integrity.ts` passes, and the docs match the shipped behavior.

## System-Wide Impact

- **Interaction graph:** every local snapshot goes through the observer: operation hooks, status refresh, completion readbacks, and pinned-worktree observers. All of them get the new limits.
- **Error propagation:** observer and validation reasons reach `firstUnavailableCause`.
- **Performance:** snapshots of larger repositories take proportionally longer. The new caps bound that cost.
- **Unchanged invariants:** worktree identity and digests, file reads, remote readback bounds and semantics, protocols, and first-cause-wins.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Larger allowed trees make every operation slower | Caps are sized to keep the worst case at a few seconds. A performance cache is deferred. |
| Repositories above the new caps still go unavailable | They fail closed with a cause that names the limit. Larger-scale support is future work. |
| The wider byte window enlarges the read races already filed in #1099 | The window grows from about 16 MiB to 128 MiB of reads, and the races are tracked on #1099. |

## Documentation / Operational Notes

- Release note: the guard now works in repositories up to 128 MiB and 20,000 files. When it becomes unavailable, status explains why.

## Sources & References

- Related issues: #1095 (this fix), #1099, #1096, #1084.
- Evidence: Fro Bot runs 38276021556 and 38222121309.
- Related code: `src/lib/opencode-operation-observer.ts`, `src/lib/opencode-workflow-guard.ts`.
