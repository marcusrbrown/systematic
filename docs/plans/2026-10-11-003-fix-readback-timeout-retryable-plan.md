---
title: "fix: Keep a readback timeout from disabling the workflow guard"
type: fix
status: active
date: 2026-10-11
---

# fix: Keep a readback timeout from disabling the workflow guard

## Overview

After an operation has succeeded, a typed `command-timeout` during a readback no longer disables the session.

- **On a status refresh**, the probe that timed out is skipped and reported as unconfirmed.
- **At completion**, that attempt is rejected with a new retryable reason, and nothing is consumed. A failure that isn't a timeout is still fatal for the session.
- **Every fatal readback transition** now records a typed cause and can be replayed.

## Problem Frame

Issue #1080. Once an operation is satisfied, the guard re-reads local and remote state in two places: on every `systematic_workflow_status` call, and at unit completion. Any result that isn't `available` marks the session `unavailable`, and an unavailable session never recovers. That includes the observer's typed `command-timeout`, which fires after 5 seconds. So one slow `git` or `gh` call after a successful push disables the guard for the rest of the session.

Fro Bot's triage on #1080 reproduced this at `e50bb35` in both observe and protected mode:

- A status-refresh timeout makes the session `unavailable / guard-unavailable`.
- A completion timeout returns `unavailable / finalization-failed`. It leaves the unit active and consumes nothing, but it still disables the session.
- A healthy readback afterward does not restore protection.
- The recorded cause reports `timedOut: false`.

Two more defects sit on the same paths:

- The fatal completion path can't be replayed. A duplicate after-hook writes nothing, and the host's raw pending output survives.
- Completion's fatal transitions record no cause at all.

These paths were split into #1084: timeouts in an operation's before-hook and after-hook, an initial push that doesn't advance, live target validation in the operation path, and child rollup.

## Requirements Trace

- R1. A `command-timeout` on a status-refresh probe skips that probe, and the session state and existing receipts are unchanged.
  - A remote timeout skips only that operation, and the other remote probes still run.
  - A timeout in the local snapshot, the pinned worktree lookup, or the pinned snapshot skips every remote probe.
- R2. A skipped probe applies no readback and advances no identity. Confirmed drift from other probes still marks receipts stale, and a skip never clears existing staleness.
- R3. Status output reports skipped probes in a bounded diagnostic made only of enum values. It is computed fresh on each call and emitted in any state. It never enters markers, receipts, digests, or tool metadata.
- R4. A `command-timeout` at any completion readback stage rejects that attempt with a new retryable reason code and its own title. The stages are the initial and final parent snapshots, the pinned initial lookup, revalidation and final snapshot, and remote readbacks.
  - Nothing is consumed, the unit stays active, and the session is not marked unavailable.
  - A duplicate after-hook for that call replays the result.
  - A new call ID prepares fresh.
  - The retryable result is written and replayed only while the guard is `protected` or `waiting`:
    - If the session is `unavailable`, the attempt takes the fatal path, and a replay returns `finalization-failed`.
    - If the guard is `rejected`, the attempt returns the core's blocking reason and does not mark the session unavailable.
- R5. Exactly two shapes count as a timeout:
  - an observer snapshot with `status: 'unavailable'` and `reasonCode: 'command-timeout'`;
  - a worktree-registration lookup with `status: 'error'` and `reasonCode: 'command-timeout'`.
  
  Everything else keeps today's fatal path: throws, `undefined`, mismatches, drift, malformed output, `missing-resource`, `remote-command-failed`, and every other lookup error.
- R6. After a fatal completion readback, a duplicate after-hook replays `unavailable / finalization-failed`.
- R7. When a status-refresh or completion readback failure moves the session into `unavailable`, a bounded cause is recorded at that transition. It carries the observer reason code, when there is one, and a correct `timedOut`.
  - A session that is already unavailable keeps its first cause, or stays without one.
  - A retryable timeout never sets `firstUnavailableCause`.
- R8. The `using-systematic` guard rule says the new reason is retryable: retry completion at most twice, then report to the user. It also says operations listed in `unconfirmedReadbacks` are unverified until a later status call confirms them.

## Scope Boundaries

- No in-session recovery from `unavailable`.
- No internal retry inside completion or status refresh.
- No consecutive-timeout cap. The retry bound is skill guidance only.
- No latency budget beyond the local and pinned skip. Each remote probe runs at most once per refresh. With a degraded remote, a status call can take the local snapshot plus one 5-second timeout per satisfied remote operation. That cost is accepted.
- Observer classification is unchanged. `missing-resource` still covers both absence and some gh failures (#1081).
- After a timed-out completion, replaying the before-hook with the same call ID keeps throwing `abandoned-transition` in protected mode. This is documented, not changed.
- The same replay gap in `abandonPending` is left as is.
- No cause is backfilled into a session that went unavailable without one.
- No receipt, readback, or marker protocol version change.

### Deferred to Separate Tasks

- #1084: timeouts in an operation's before-hook and after-hook, an initial push that doesn't advance, typed timeouts through live target validation in the operation path, and child rollup.
- #1081: proving remote absence and binding remote identity.
- #1083: the core classifier race and hidden seed timeouts.
- #740: refreshing the observer's worktree registry.

## Context & Research

### Relevant Code and Patterns

Paths without a directory are in `src/lib/opencode-workflow-guard.ts` (the adapter). Core paths are in `src/lib/workflow-guard.ts`.

**Status refresh** (`refreshReadback`, `refreshRemoteReadbacks`):
- Local failures call `markUnavailable(OBSERVER_READBACK_FAILED_CAUSE)` and discard the reason code.
- The remote loop returns `false` at the first entry that isn't available. Later probes, and any drift they would show, never run.
- Every status call runs a refresh.

**Completion** (`completionReadbacks`, `completionRemoteReadbacks`):
- Thirteen sites in `completionReadbacks` return a bare `{status: 'unavailable'}`, and `completionRemoteReadbacks` has two `return undefined` sites.
- `finishComplete` routes all of them through `finishUnavailableReadback`. That calls `abandonComplete(remember=true)`, then `markUnavailable()` with no cause, then writes `finalization-failed`.

**Effective observer lookup** (`effectiveOperationObserver`):
- It drops `validateRegisteredWorktree`'s typed result and returns `undefined`.
- `validateRegisteredWorktree` returns `ok`, or `error` with a reason code. A timed-out `rev-parse` gives `error / command-timeout`.
- Status refresh calls the lookup before any snapshot. The pinned completion path calls it twice.

**Terminal replay** (`TerminalComplete`, `terminalCompletes`, `replayTerminalComplete`, `writeTerminalReplay`):
- A recorded non-success outcome is replayed for the same call digest. `title` is stored so the replay matches.
- `replayTerminalComplete` returns a stored entry before it checks guard state.
- `finishMismatchedTarget` abandons with `remember=true`, records a terminal entry, and writes `invalid-transition`. A target mismatch is already replayable.
- `abandonComplete` on its own records only `abandonedCompletes`, so replaying that state writes nothing.
- `terminalCompletes` lives in memory.

**Core:**
- `prepareForCall` replays `abandoned-transition` only for the same call digest. A new call ID prepares fresh.
- Consumption happens in `finalizeTransition`, so an abandoned attempt consumes nothing.
- A repairable global evidence issue projects as `state: 'rejected'` (`projectGlobalIssue`), and `transitionDecision` refuses every transition while one is set.
- Markers are built from the core `status()` (`currentMarkerSource` in the adapter).

**Staleness:**
- Staleness changes only through `observeRevision`, `applyRevisionChanges`, and `markStaleReceipts`. A skipped observation changes nothing.
- `clearRecoveredResourceStale` clears staleness only on a matching confirmed readback.

**Causes:**
- `OBSERVER_READBACK_FAILED_CAUSE` is a frozen constant with `timedOut: false`, shared by every refresh failure.
- `GuardUnavailableCause` and `recordUnavailable` already carry `timedOut` and `reasonCode`.
- `recordUnavailable` records a cause only when `setMode` reports a change.

**Status diagnostic pattern:** `seedDeferrals`, from #1005. It contains only enum values, `statusForTool` emits it in any state, and it is excluded from markers and receipts.

**Observer** (`src/lib/opencode-operation-observer.ts`):
- Both runners map `ETIMEDOUT` to `timedOut`. Command wrappers emit `command-timeout`.
- Remote readers keep `command-timeout`. Only `remote-command-failed` collapses to `missing-resource`.
- A remote snapshot starts with the same `rev-parse --show-toplevel`, so a local timeout predicts remote timeouts.

**Tests** (`tests/unit/opencode-workflow-guard.test.ts`):
- `sequenceObserver` is ordered by one shared snapshot counter. A timeout at index N depends on every earlier call. Use a targeted failure wrapper instead, such as `countingObserver` or the `failing` flag in the refresh-cause describe.
- The refresh-cause describe pins `{site: 'refresh-readback', kind: 'observer-readback-failed', timedOut: false}` with `toEqual` for its `target-unavailable` and `throws` cases. Both move with the per-site cause change.
- The interleaved-digest completion test pins `finalization-failed` and stays fatal.

### Institutional Learnings

- `docs/solutions/integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`: completion readbacks stay on the pinned worktree observer. Target and workspace mismatches are fatal.
- `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`: one unconfirmed read must not discard valid evidence. Lineage and replay violations stay fail-closed.
- `docs/solutions/workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md`: an unavailable state doesn't name its cause, so record the earliest failure precisely.
- `docs/solutions/workflow-issues/real-host-ci-catches-what-offline-gates-cannot-2026-09-06.md`: pair host-free regressions with real-host evidence. A timeout can't be injected on the real host, so the dogfood suite only checks for regressions.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-workflow-guard.ts, src/lib/workflow-guard.ts, src/lib/opencode-operation-observer.ts (receipt-backed workflow guard)",
  "freshness": {
    "vcs_reference": "92dabb6"
  },
  "budget": {
    "max_search_passes": 12,
    "max_candidate_inspections": 22,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:refreshReadback / refreshRemoteReadbacks",
      "description": "Status-time observer readback that marks the session unavailable on any local or remote result that isn't available, and discards the reason code.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:completionReadbacks / completionRemoteReadbacks / finishUnavailableReadback",
      "description": "Completion-time readbacks that collapse every observer result to unavailable or undefined, then abandon with finalization-failed and an uncaused markUnavailable.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:TerminalComplete / terminalCompletes / replayTerminalComplete / writeTerminalReplay",
      "description": "Replays a recorded non-success completion outcome for the same call digest, with title and metadata fidelity.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:finishMismatchedTarget",
      "description": "Abandons with remember=true and records a paired terminal entry, so a replay reproduces the reason.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:abandonComplete / abandonedCompletes",
      "description": "Abandons the core transition and remembers the target without a terminal result, so a replay of this state writes nothing.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:seedDeferrals / statusForTool",
      "description": "Status-only, enum-only deferral list emitted in any state and excluded from markers, receipts and digests; scoped to seeding.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:OBSERVER_READBACK_FAILED_CAUSE / GuardUnavailableCause / recordUnavailable",
      "description": "Bounded first-cause diagnostic with timedOut and reasonCode fields; the refresh-path constant hardcodes timedOut false.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:effectiveOperationObserver",
      "description": "Resolves the pinned worktree observer and drops validateRegisteredWorktree's typed failure.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:prepareForCall / replayPrepare / abandonTransition",
      "description": "Per-call-digest prepare with abandoned-transition replay for the same call and a fresh prepare for a new call.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:observeRevision / staleForChange / markStaleReceipts",
      "description": "Staleness changes only through an applied readback; a skipped observation is a no-op.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:unavailable / readRemotePullRequest / readCheckReadback / readRemoteGitValue / validateRegisteredWorktree",
      "description": "Preserve the command-timeout reason code through to the adapter, as an unavailable snapshot or an error lookup result.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:writeNoEpochBlockedResult / writeBlockedCompleteResult",
      "description": "Blocked-completion replay limited to the no-active-epoch reason.",
      "disposition": "insufficient",
      "insufficiency_reason": "Replay covers only no-active-epoch; other reasons write nothing."
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:classifyLocalObservation deferred status",
      "description": "Deferred status for commands that cannot be classified, not for probe timeouts.",
      "disposition": "insufficient",
      "insufficiency_reason": "Reusing it would conflate command classification with probe timeouts."
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:retryableEmptyHistory",
      "description": "Init-only retry flag for an empty history read.",
      "disposition": "insufficient",
      "insufficiency_reason": "Applies only to initialization history reads and has no diagnostic output."
    }
  ]
}
```

## Key Technical Decisions

- **Receipts stay valid but unconfirmed on a status timeout.** The alternative was marking them stale until a clean read, which turns a slow probe into redone work. It also buys nothing, because completion always takes its own fresh readbacks before finalizing.
- **Completion rejects immediately, with no internal retry.** The agent retries with a new call ID. This adds no probe latency and needs no new state.
- **A timed-out completion is `rejected`, not `unavailable`.** The `using-systematic` rule treats `unavailable` as terminal. A new reason code, `readback-timeout`, with its own title, tells the agent that a retry is valid.
- **One shared classifier decides what counts as a timeout.** Refresh and completion both use it, and it accepts exactly the two shapes in R5. Each completion stage returns `ok`, `timeout`, or `fatal`. The first stage that isn't `ok` ends the attempt. An earlier timeout can mask later drift, which is safe because the next attempt re-reads everything.
- **Retryability is judged at write time and again at replay.** A status call can change the guard while a completion waits on a probe.
  - A retryable result is written only while the guard is `protected` or `waiting`.
  - If the session is `unavailable`, the fatal path runs.
  - If the guard is `rejected` because of a repairable global issue, the attempt returns the core's blocking reason without marking the session unavailable.
  - Replay applies the same check, so a dead session never replays "retryable".
- **The typed lookup sibling serves completion and status refresh.** It returns `ok`, `timeout`, or `invalid`, and the existing function stays as a wrapper. A missing registration or an identity mismatch stays fatal. Callers in the operation path belong to #1084.
- **A local or pinned timeout skips the remote probes.** Remote readback input needs the local identities, and the remote snapshot starts with the same command, so it would very likely time out too.
- **The probe diagnostic is returned by value from each refresh.**
  - Its name is `unconfirmedReadbacks`.
  - Each entry is `{probe, reasonCode}`, where `probe` is one of `local`, `pinned`, `push`, `pr-creation`, `check-readback`, `review-readback`.
  - Entries are in a fixed order, there are at most six, and they carry no paths, durations, or counters.
  - Returning it by value resets it on every call, so concurrent status calls can't share entries.
  - It stays separate from `seedDeferrals`, which is per-unit state owned by seeding. This one is a per-call value.
- **`readback-timeout` is never persisted to markers.** Markers are built from the core status, which a timed-out completion leaves unchanged, and `terminalCompletes` lives in memory. The timed-out tool part does carry the reason in guard metadata, but recovery in a session with an epoch restores from markers.
- **The fatal completion path becomes replayable in this PR.** Once the timeout branch replays and the fatal branch doesn't, the two disagree. The fix mirrors `finishMismatchedTarget`. A target mismatch keeps its existing `invalid-transition` path.
- **Causes are built per site and recorded only at the transition into `unavailable`.** Status refresh records a bounded `kind` plus the observer reason code. Completion gets a `complete-readback` cause site. `timedOut` is derived from the reason code instead of being hardcoded. Recording only at the transition (first-wins) means a later readback never misattributes an earlier failure.

## Open Questions

### Resolved During Planning

- Replay fix for the fatal path: included in this PR.
- Persistent timeouts: bounded by skill guidance (two retries, then report). No guard cap.
- Cause scope: status refresh and completion. First-wins, recorded at the transition, never backfilled.
- Latency: only the local and pinned skip. The worst case is accepted.
- Retryability: judged at write time and at replay against the current guard state.
- Guidance: `readback-timeout` is retryable twice, and listed unconfirmed operations are unverified.
- Persistence: `readback-timeout` never reaches a marker.

### Deferred to Implementation

- The exact `kind` values for status-refresh causes. They come from the existing failure sites: lookup failed, snapshot threw, target mismatch, remote readback failed.
- The snapshot call count per path, which decides where the targeted failure wrapper hooks in.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

| Path | Result | Outcome |
|---|---|---|
| Status, local snapshot, pinned lookup, or pinned snapshot | timeout (R5) | Skip it and every remote probe. The diagnostic lists `local` or `pinned`. State and receipts are unchanged. |
| Status, one remote operation | timeout | Skip that operation and continue with the rest. The diagnostic lists it. |
| Status, any probe | throw, readback identity mismatch, other reason, `missing-resource`, other lookup error | The session becomes `unavailable` with a typed per-site cause. The diagnostic still lists earlier skipped probes. |
| Completion, any readback stage | timeout, guard `protected` or `waiting` | Abandon and remember. Terminal entry `rejected / readback-timeout` with its own title. No `markUnavailable`. Replayable. |
| Completion, any readback stage | timeout, guard `rejected` | Return the core's blocking reason. No `markUnavailable`. |
| Completion, any readback stage | timeout, session `unavailable` | Fatal path. |
| Completion, any readback stage | throw, readback identity mismatch, drift, other reason, `undefined` | Fatal path: abandon and remember, terminal entry `unavailable / finalization-failed`, and `markUnavailable` with a `complete-readback` cause. Replayable. |
| Completion, target mismatch | not a readback | Unchanged: `finishMismatchedTarget`, `invalid-transition`. |
| Replay of `readback-timeout` | guard no longer `protected` or `waiting` | Replay the result that matches the current guard state, never "retryable". |

## Implementation Units

- [ ] **Unit 1: Status refresh skips timed-out probes**

**Goal:** A timeout during status refresh skips the probe and is reported. Every other refresh failure records a typed cause.

**Requirements:** R1, R2, R3, R5, R7

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add the shared timeout classifier for the two shapes in R5.
- Add the typed sibling of `effectiveOperationObserver` (`ok`, `timeout`, `invalid`).
- `refreshReadback` and `refreshRemoteReadbacks` return a typed outcome instead of a boolean. A timeout skips the probe. Any other failure stays fatal and builds its own cause.
- The remote loop continues past a timeout.
- `refreshReadback` returns the diagnostic list, and the status tool passes it to `statusForTool` next to `seedDeferrals`.
- Replace the frozen `OBSERVER_READBACK_FAILED_CAUSE` with a cause built at each site.

**Execution note:** Test-first. The first failing test is the triage reproduction: a timeout after a satisfied push, then a healthy read.

**Patterns to follow:**
- How `statusForTool` renders `seedDeferrals`.
- The deferral exclusion tests in the remote-seeding describe.
- A targeted failure wrapper (`countingObserver` style) rather than indexed `sequenceObserver` scripts.

**Test scenarios:**
- Happy path: push satisfied, then one `push:after` timeout on status. The state is not unavailable, the push receipt stays valid, and the diagnostic is `[{probe: 'push', reasonCode: 'command-timeout'}]`. A later status call with a healthy read has an empty diagnostic, and the receipt is still valid. Run in observe and protected mode.
- Happy path: one remote operation times out and another returns drift. The drifted operation's receipt goes stale, and the timed-out one stays valid.
- Edge case: the local snapshot times out. There is no `observeReadback` call, identities are unchanged, remote probes are not attempted, and the diagnostic is `[local]`.
- Edge case: the pinned worktree lookup times out (`error / command-timeout`). The diagnostic is `[pinned]`, the session is not unavailable, and remote probes are not attempted.
- Edge case: the pinned snapshot times out. The diagnostic is `[pinned]`, and the pinned target identity is not advanced.
- Edge case: local drift is applied, then a remote probe times out. Receipts staled by the drift stay stale.
- Edge case: a receipt recovered as stale, plus a timeout, stays stale. A matching healthy readback clears it.
- Edge case: every probe times out. The state is unchanged, and the diagnostic lists every attempted probe in fixed order.
- Edge case: with no epoch, refresh is skipped and the diagnostic is empty.
- Error path: a timeout, then a failure that isn't a timeout, in the same refresh. The session is unavailable with a typed cause, and the diagnostic still lists the skipped probe.
- Error path: each of these makes the session unavailable with a cause that carries the reason code when there is one, and `timedOut` false:
  - `missing-resource`
  - `remote-command-failed`
  - a throwing observer
  - a target mismatch
  - a pinned lookup that returns a missing registration
- Integration: the diagnostic never appears in markers, receipts, digests, or tool `metadata()`, and two status calls never share entries.

**Verification:**
- The triage reproduction passes in both modes.
- The `target-unavailable` and `throws` cases in the refresh-cause describe are updated deliberately and pass.
- No other refresh path changes.

- [ ] **Unit 2: Completion rejects a timed-out readback as retryable**

**Goal:** A completion readback timeout at any stage rejects that attempt with `readback-timeout`. The rejection can be replayed, and the guard state decides whether it is retryable.

**Requirements:** R4, R5

**Dependencies:** Unit 1, for the shared classifier and the typed lookup.

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Modify: `src/lib/workflow-guard.ts` (add `readback-timeout` to `WorkflowReasonCode`)
- Test: `tests/unit/opencode-workflow-guard.test.ts`
- Test: `tests/unit/workflow-guard.test.ts` (reason-code coverage, if the core enumerates codes)

**Approach:**
- `completionReadbacks` and `completionRemoteReadbacks` return a discriminated outcome per stage. The pinned lookups use the typed sibling.
- On `timeout`, `finishComplete` checks guard state:
  - `protected` or `waiting`: abandon with `remember=true`, record a `terminalCompletes` entry `{status: 'rejected', reasonCode: 'readback-timeout', title}`, skip `markUnavailable`, and write through the terminal writer.
  - `rejected`: return the core's blocking reason without `markUnavailable`.
  - `unavailable`: take the fatal path.
- `replayTerminalComplete` re-checks guard state for a stored `readback-timeout` entry and replays the result that matches the current state.
- Add `readback-timeout` to the adapter `REASON_CODES`.

**Execution note:** Test-first. Each stage gets its own failing case.

**Patterns to follow:**
- `finishMismatchedTarget`.
- The `failed-operation` terminal branch in `finalizeComplete`.
- `writeNoEpochBlockedResult`, for a terminal entry with a title.

**Test scenarios:**
- Happy path: one test per stage: initial parent snapshot, pinned initial lookup, pinned initial snapshot, remote, final parent, pinned revalidation lookup, pinned final snapshot. Each returns `rejected / readback-timeout` with the new title. Nothing is consumed, the unit stays active, and the state is not unavailable. Run in observe and protected mode.
- Happy path: after a timeout, a new completion call ID with healthy probes completes the unit and consumes receipts once.
- Edge case: a duplicate after-hook for the timed-out call replays an identical result (status, reason, title, metadata) and changes no session state.
- Edge case: a timeout, then a new call ID whose readbacks show drift. The first attempt applied nothing, and the second takes today's fatal path.
- Edge case: replaying the before-hook with the same call ID. Protected mode throws `abandoned-transition`. Observe mode records the call, and the after-hook replays the terminal entry.
- Error path: the session is marked unavailable while a completion probe is held, then the probe times out. The result is the fatal one.
- Error path: a repairable global evidence issue is set while a completion probe is held, then the probe times out. The result carries the core's blocking reason, not `readback-timeout`, and the session is not unavailable.
- Error path: a timeout, then a fatal status refresh, then a duplicate after-hook for the timed-out call. The replay is `unavailable / finalization-failed`.
- Error path: a missing worktree registration or an identity mismatch at the pinned lookup stays fatal.
- Integration: after a timed-out completion, no marker carries `readback-timeout`. A restart recovers the active unit from the earlier markers, and the session is not unavailable.

**Verification:**
- Every stage is covered.
- The existing `failed-operation` and `invalid-transition` replay tests pass unchanged.
- The interleaved-digest `finalization-failed` test is unchanged.

- [ ] **Unit 3: Fatal completion readbacks are replayable and have a cause**

**Goal:** A fatal completion readback records a terminal entry, and a `complete-readback` cause at the transition.

**Requirements:** R6, R7

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- `finishUnavailableReadback` records `{status: 'unavailable', reasonCode: 'finalization-failed'}` in `terminalCompletes`, alongside the abandon.
- It calls `markUnavailable` with a `complete-readback` cause that carries the stage's reason code, when there is one.
- Other `markUnavailable()` calls in completion that pass no cause gain one only where they are readback failures.

**Patterns to follow:**
- `finishMismatchedTarget`.
- The first-wins semantics of `recordUnavailable`.

**Test scenarios:**
- Happy path: a completion readback identity mismatch, then a duplicate after-hook. Both write `unavailable / finalization-failed`, and the raw pending output does not survive.
- Happy path: after a fatal completion readback, status reports `firstUnavailableCause` with site `complete-readback`.
- Edge case: a fatal readback after an earlier unavailable cause keeps the first cause. A fatal readback in a session already unavailable without a cause records none.
- Edge case: a completion target mismatch still writes `invalid-transition` through `finishMismatchedTarget`.
- Edge case: a timeout never sets `firstUnavailableCause`.

**Verification:**
- The fatal replay and cause tests pass.
- The set of completion failures that are fatal does not change.

- [ ] **Unit 4: Document the retryable reason**

**Goal:** Agents treat `readback-timeout` as retryable within a bound and treat unconfirmed readbacks as unverified. The architecture notes describe the new behavior.

**Requirements:** R8

**Dependencies:** Unit 2

**Files:**
- Modify: `skills/using-systematic/SKILL.md` (guard rule)
- Modify: the bootstrap snapshot fixture and its byte-length pin, wherever the bootstrap test keeps them
- Modify: `ARCHITECTURE.md` (the receipt-backed workflow guard paragraph)

**Approach:**
- The guard rule says:
  - a `rejected / readback-timeout` completion may be retried at most twice with a new call, then reported to the user;
  - operations listed in `unconfirmedReadbacks` are unverified until a later status call confirms them;
  - `unavailable` stays the only terminal state.
- ARCHITECTURE.md covers:
  - status skips and the diagnostic;
  - the retryable completion rejection and how retryability is judged;
  - fatal replay and causes;
  - the limits: no recovery from `unavailable`; an earlier timeout can mask later drift until the next attempt; replaying the before-hook with the same call ID; worst-case status latency with a degraded remote.

**Test expectation:** none beyond regenerating the bootstrap snapshot. This unit only changes guidance text.

**Verification:**
- The bootstrap snapshot test passes.
- The docs reference generation and registry drift checks are clean.
- Content integrity passes.

## System-Wide Impact

- **Interaction graph:** the status tool, the completion after-hook, terminal replay, and `statusForTool`. Operation hooks, seeding, and child rollup are untouched.
- **Error propagation:** a timeout stops at the adapter boundary as a skip or a retryable rejection. Every other failure travels the existing fatal path, now with a cause.
- **State lifecycle risks:**
  - A skipped probe must not partially apply.
  - The completion timeout branch must abandon and remember, so nothing is left pending.
  - Retryability is re-checked at write time and at replay.
- **API surface parity:** status output gains `unconfirmedReadbacks`, and completion results gain one reason code. No marker, receipt, or readback shape changes.
- **Integration coverage:** the real-host dogfood suite runs as a regression check. Timeouts are proven by unit tests, because the real host can't inject them.
- **Unchanged invariants:**
  - Completion still requires its own fresh confirming readbacks before it consumes anything.
  - A failure that isn't a timeout still disables the session.
  - `unavailable` is still terminal within a session.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A failure that isn't a timeout is classified as one, which would fail open | One classifier accepts only the two typed shapes in R5. Throws and `undefined` stay fatal. Tests cover every result that isn't a timeout. |
| Status looks healthy while nothing was verified | The diagnostic lists every skipped probe, the guard rule says those operations are unverified, and completion still re-reads everything. |
| A deterministic timeout makes completion loop | The skill bounds retries to two, then report. A guard cap is deliberately left out. |
| A retryable result for a transition the guard will keep refusing | Retryability is judged against the current guard state at write time and at replay. |
| Snapshot call counts shift fixture scripts | Use targeted failure wrappers, and count snapshot calls per path before writing tests. |

## Documentation / Operational Notes

- The release type is `fix` (patch).
- The PR body states the worst-case status latency with a degraded remote.
- Release notes say that a slow `git` or `gh` call after an operation no longer disables the guard, and that completion asks for a retry instead.

## Sources & References

- Related issues: #1080, #1084, #1005 (PR #1082), #1081, #1083, #740
- Fro Bot triage on #1080 (reproduction at `e50bb35`)
- Related code: `src/lib/opencode-workflow-guard.ts`, `src/lib/workflow-guard.ts`, `src/lib/opencode-operation-observer.ts`
