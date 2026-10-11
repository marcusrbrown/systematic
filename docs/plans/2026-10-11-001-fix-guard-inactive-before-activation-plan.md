---
title: "fix: Report the workflow guard as inactive before activation"
type: fix
status: active
date: 2026-10-11
---

# fix: Report the workflow guard as inactive before activation

## Overview

Add a distinct `inactive` guard state for sessions with no known epoch. The session's own status calls, and guard-owned no-epoch rejections, no longer count as unrecoverable history. Unavailable statuses raised during initialization carry a bounded cause. Every fail-closed path that guards real evidence stays closed.

## Problem Frame

Issue #1076. In headless CI runs (fro-bot), the guard reports `unavailable` in every run, although nothing disables it. Two defects in the OpenCode adapter cause this:

1. **Inactive is reported as unavailable.**
   - The first system-prompt transform recovers markers without allowing a fresh start. Empty history therefore publishes `unavailable`.
   - An initialized guard with no epoch projects `unavailable / no-active-epoch`.
   - The bootstrap rule in `skills/using-systematic/SKILL.md` treats `unavailable` as terminal. An agent that checks status first, as the bootstrap suggests, never uses the guard.
2. **A fresh session sticks.** The history check matches any guard tool part by name, ignoring call identity and state. It refuses fresh initialization in two cases:
   - the session's own in-flight status call, and later that call's completed part;
   - a start rejected because no epoch existed.

   Once refused, the session stays unavailable, even after a guarded skill loads. A restart doesn't help, because the parts persist.

Fro Bot reproduced both paths with in-memory adapter probes. Which branch the linked CI runs hit is unattributed, because unavailable statuses raised during initialization record no cause.

## Requirements Trace

- R1. A session with no recoverable epoch evidence reports `inactive / no-active-epoch`. This holds for event-first, transform-first, before-hook-first, and direct tool orderings.
- R2. Status-first, then a guarded skill load, reaches `waiting / missing-evidence` exactly as skill-first does.
- R3. Neither of these blocks fresh initialization, in-process or after a restart:
  - status calls;
  - completed start/complete calls carrying guard-owned `rejected / no-active-epoch` metadata.
- R4. These still fail closed:
  - malformed, ambiguous, or incompatible markers;
  - completed markerless control calls, and other completed markerless mutation calls;
  - prior-process pending, running, or error mutation calls;
  - failed or malformed initialization-path history reads. Child-rollup reads keep their HEAD contract; see Key Technical Decisions.
- R5. An `unavailable` raised from an initialization or recovery path carries a bounded, enum-only cause on status output. The cause:
  - never appears in markers, receipts, or digests;
  - is cleared on successful fresh publication or restoration.
- R6. Parallel guard calls in one message never discard a sibling's pending start or skill activation.
- R7. A status call in an epoch-less session never reaches observer readback, so an unhealthy observer can't disable it. When readback marks an epoch-bearing session unavailable, status output carries a bounded cause. The broader observer fix stays with #1005.
- R8. A completion request with no epoch returns a guard-owned `rejected / no-active-epoch` result in both observe and protected modes. It never returns the literal `unavailable`, never throws in the before-hook for this case, and never poisons the inactive state, including after a restart.
- R9. Agent guidance treats `inactive` as non-terminal and per-session. Only `unavailable` is terminal.
- R10. Valid foreign-only markers keep their current behavior: the session stays eligible for a fresh start.

## Scope Boundaries

- `inactive` means "no known or recoverable activation". It is not a historical guarantee of never having activated.
- No reset-to-inactive after an epoch ends. A completed epoch stays `protected / epoch-completed`.
- No detector that treats markerless guarded-skill or bash parts as guard history.
- No compatibility shim for older dual registrations meeting the new state; see Key Technical Decisions.
- No state-machine rewrite.
- Fail-closed test assertions, observer timeouts, and scenario serialization are not weakened. Assertions that pin the old `unavailable / no-active-epoch` tuple are updated.

### Deferred to Separate Tasks

- **#1005:** a transient remote-scope probe failure disables the guard for the whole session. Separate PR. This plan only adds cause plumbing that #1005 can reuse.
- **#740:** the observer worktree registry is captured once. Separate PR.
- Observer-failure handling for epoch-bearing sessions: goes with #1005. This plan only skips readback when there is no epoch, and records a readback cause otherwise.
- The synthetic uninitialized status reports `unavailable` even in `disabled` mode. This is minor and has no user impact today.

## Context & Research

### Relevant Code and Patterns

- **Core state union and projection** live in `src/lib/workflow-guard.ts`.
  - `WorkflowState` union; `projection()` holds the no-epoch branch.
  - `transitionDecision`, `finalizePrepared`, and `blockedByCurrentStatus`.
  - `activate`: there is no path from a completed epoch back to no epoch.
- **Adapter** (`src/lib/opencode-workflow-guard.ts`):
  - Recovery pipeline: `recoverFromHost` → `initializeSession` → `classifyMarkersFromParts` → `publishEmptyMarkers` / `publishFresh` / `publishUnavailable`. Retries are gated by `retryableEmptyHistory`.
  - `containsGuardHistory` is the identity-blind walker.
  - Marker state checks: `markerStatusRank`, `isWorkflowState`, and `parseMarkerSource`.
  - `buildMarker` publishes an aggregate unavailable when a marker is malformed.
  - Status path: `statusForTool`, `metadata()`, `readStatus()` → `abandonPending()`, and `refreshReadback`.
  - Pending maps (`pendingStarts`, `pendingSkills`, and siblings) are keyed by call digest.
  - `GuardUnavailableCause` and `markUnavailable(cause)` are the existing bounded first-cause diagnostic, currently for remote-scope seeding only.
  - The completion block in `prepareComplete` throws `WorkflowGuardBlockedError('no-active-epoch')` in protected mode.
- **Host history read:** `src/index.ts` `hostReadback.readSessionParts` maps an errored or non-array `session.messages` response to `[]`.
- **Hook data:** the transform receives only `sessionID`. `tool.execute.before`/`after` receive `{tool, sessionID, callID}`. A tool's `execute` context has `messageID` but no callID. The SDK `ToolPart` carries `callID` and `state.status ∈ {pending, running, completed, error}`.
- **Test harness**, `tests/unit/opencode-workflow-guard.test.ts`:
  - `createAdapter` with deterministic salt and registration;
  - `buildMarkersForRegistration`, `wrapMarkers`, `createPinnedRecoveryAdapter`;
  - synthetic tool parts in host history;
  - direct hook invocation with `{tool, sessionID, callID}`;
  - the live-request ordering probe at the completed-control fail-closed test is the template for status-first tests.
- **Real host:** `tests/integration/receipt-workflow-dogfood.test.ts` provides scripted calls per scenario and a `workflowGuardStatus` assertion. The fixture is `tests/integration/fixtures/receipt-workflow-host.ts`: it starts an exact OpenCode server and reaps by process group.

### Institutional Learnings

- `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`:
  - lineage, workspace, seed, and replay checks stay fail-closed;
  - an exact duplicate marker is idempotent, a conflicting replay is not;
  - restarting the process doesn't clear persisted history.
- `docs/solutions/integration-issues/workflow-guard-skipped-skills-over-32kb-2026-09-26.md`: test the successful-activation and marker-merge paths, not only rejection. Verify at the host tool-part boundary.
- `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md`: on the pinned host, plugin tools run execute → truncation → `tool.execute.after`. Correlate by `sessionID` + `callID`, not by arguments.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`: clean-start acceptance needs a fresh conversation. A resumed conversation replays persisted tool metadata, including an old `guard-unavailable`.
- `docs/solutions/workflow-issues/a-capability-that-works-has-not-named-its-cause-2026-08-24.md`: a reported state does not identify its cause. Record the cause at the transition.
- `docs/solutions/workflow-issues/real-host-ci-catches-what-offline-gates-cannot-2026-09-06.md`: keep host-free regression coverage alongside the pinned real-host test.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/workflow-guard.ts + src/lib/opencode-workflow-guard.ts (receipt-backed guard subtree), plus skills/using-systematic/SKILL.md guard text",
  "freshness": {
    "vcs_reference": "9fa0799"
  },
  "budget": {
    "max_search_passes": 12,
    "max_candidate_inspections": 20,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:projection",
      "description": "Epoch-less projection returns unavailable/no-active-epoch when no epoch exists; owns pre-activation status today, mislabeled as unavailable.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:publishEmptyMarkers",
      "description": "Splits empty host history into publishFresh (allowFresh and no guard tool parts) or retryable publishUnavailable; owns the empty-history branch.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:containsGuardHistory",
      "description": "Recursive walker matching guard tool names in any part, ignoring callID, state.status, and messageID; identity-blind.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:classifyMarkersFromParts",
      "description": "Classifies host parts into own, foreign-empty, or ambiguous; malformed or seedless markers fail closed. Must be preserved and must run before any exemption.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:pendingStarts/pendingCompletes/pendingSkills/pendingOperations",
      "description": "callDigest-keyed in-flight maps populated from the before-hook via prepareHostCall; abandoned wholesale by status reads and readback.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:GuardUnavailableCause/markUnavailable",
      "description": "Bounded first-cause diagnostic for remote-scope seeding failures, surfaced only on status tool output; shape reusable for initialization causes.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:statusForTool",
      "description": "Status renderer; emits firstUnavailableCause only when state is unavailable.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:isWorkflowState/markerStatusRank/parseMarkerSource",
      "description": "Validates and ranks the five marker states; an unknown state is rejected as malformed.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:recoverFromHost/initializeSession",
      "description": "Initialization and retry orchestration; allowFresh threaded through hooks, retryableEmptyHistory gates re-initialization.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/receipt-readback.ts:validateReceiptMarker",
      "description": "Authenticated receipt marker validation with progression state started or completed; does not carry WorkflowState, so no receipt or readback protocol change.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:activate",
      "description": "Creates an epoch from the no-epoch state; pre-activation activation already works when mode is protected.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:projectControl",
      "description": "Mode-level disabled or unavailable projection with reason guard-unavailable; must remain for real mode unavailability.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "skills/using-systematic/SKILL.md",
      "description": "Agent-facing rule treating guard unavailable as terminal for the unit; needs to distinguish inactive from unavailable.",
      "disposition": "extend"
    }
  ],
  "excluded_scopes": [
    {
      "scope": "#1005 remote-probe session disable",
      "reason": "Separate PR by confirmed scope."
    },
    {
      "scope": "#740 observer worktree registry",
      "reason": "Separate PR by confirmed scope."
    },
    {
      "scope": "src/pi.ts (Pi harness)",
      "reason": "No runtime guard is registered for Pi."
    }
  ]
}
```

## Key Technical Decisions

- **`inactive` is a new `WorkflowState`, reusing reason code `no-active-epoch`.** No new reason code is needed, and test churn stays limited to assertions on state.
- **No marker protocol version bump.** `inactive` is serialized into the system-prompt marker document. An older parser rejects an unknown state no matter what version the document carries, so a bump buys nothing. A mixed-version dual registration therefore fails closed (aggregate unavailable) until both registrations upgrade. This is documented, not shimmed. Receipts and readbacks don't carry `WorkflowState`, so their protocol versions don't change either.
- **History exemption works by rule, not by a runtime call-ID set.** A set of call IDs recorded by this process is empty after a restart. It can't heal sessions poisoned by an older build, and it risks false ownership when a provider reuses positional call IDs. The rule, in order:
  1. Classify and validate receipt markers first. No exemption may hide malformed, ambiguous, or incompatible evidence.
  2. Ignore `systematic_workflow_status` parts by name, in any state. A status call is neutral to the lifecycle once the next decision applies.
  3. Ignore a completed start or complete only when its structured, guard-owned metadata records `rejected / no-active-epoch`. Not generic rejection, and not output-text matching: a start rejected with `epoch-completed` proves a prior epoch existed.
  4. Ignore the current in-flight mutation call only when its host occurrence can be uniquely identified as the call now being prepared, before any mutation. Otherwise fail closed. Never exempt an earlier part because its call ID matches today's.
  5. Everything else stays closed: completed control, other completed markerless mutation calls, and prior-process pending/running/error mutation calls. Host part state is not an atomic record of whether the guard mutated state.
- **A status call stops having lifecycle side effects.**
  - Status reads and readback no longer abandon pending work wholesale. At HEAD a status call batched with a start clears the start's pending entry, and `finishStart` then marks the guard unavailable. Request-boundary cleanup stays in the transform.
  - The status tool runs readback before reading state. Readback returns early when there is no epoch, before any observer read or unavailable transition.
  - With an epoch, readback behavior is unchanged except that its unavailable transition gains a bounded cause.
- **Transform-first empty history is provisional.**
  - A transform with empty history publishes `inactive`, but the session stays retryable.
  - Only a successful allow-fresh recovery in a later before-hook or event confirms it.
  - Activation happens in a skill's after-hook, which a re-read always precedes, so no epoch forms while the state is provisional.
  - Re-initialization is serialized per session. At HEAD, a waiter that resumes after the first re-init reset the retry flag returns while the new init is still pending, and sees `guard-unavailable`. The waiter protocol: after awaiting promise P, a waiter checks whether P is still the current initialization promise, and re-awaits the newer one if not. Only the waiter that starts a re-init resets the retry state.
  - Only the provisional-inactive path (no non-exempt guard parts, `allowFresh=false`) is retryable. Markerless-guard-history `unavailable` is published non-retryable, so later hooks don't queue behind repeated history reads.
- **A failed history read is unavailable, not empty.**
  - The initialization path uses a strict host read that throws on an SDK error or non-array data.
  - The initialization catch publishes `unavailable` with a `history-read-failed` cause.
  - Child-rollup reads keep HEAD's exact contract: an SDK error or non-array data maps to `[]` (no rollup), and a thrown read still marks the parent unavailable.
- **No-epoch completion is a guard-owned rejected result in both modes.**
  - The status projection becomes `inactive`.
  - With no epoch there is nothing to enforce. Protected mode no longer throws in the before-hook for this case.
  - In both modes the tool completes and writes `workflowGuard` `rejected / no-active-epoch` metadata, which exemption rule 3 matches after a restart.
  - The blocked-completion record carries its reason, so other blocked reasons keep their current output.
  - The after-hook writer re-checks guard state at write time. It writes `rejected / no-active-epoch` only if there is still no epoch; otherwise it writes the current non-exempt reason. A same-batch skill activation can't produce a false exempt record.
  - The no-epoch result carries a rejected title, not the shared writer's "unavailable" title.
  - Impossible missing-epoch finalization stays fail-closed.
  - `blockedByCurrentStatus` returning `rejected` is valid operation-result semantics.
- **Initialization causes reuse `GuardUnavailableCause`.** It gains new site/kind values for the initialization, recovery, and readback paths: history read failed, markers malformed or incompatible, markers ambiguous, recovery rejected, markerless guard history, observer readback failed. Values are enum-only, `timedOut: false`, with no call IDs, tool names, or paths. The cause is cleared on successful fresh publication or restoration, not on unavailable retries.
- **Foreign-only valid markers keep HEAD behavior.** They still read as not-our-history (R10).

## Open Questions

### Resolved During Planning

- Should foreign-only valid markers fail closed? No; HEAD behavior is preserved, as Marcus confirmed.
- Does `inactive` guarantee the session never activated? No; it means no known activation, as Marcus confirmed. If markers are completely erased, a previously activated session can't be told apart from a fresh one. This is documented as residual risk. Ordinary host pruning sets `time.compacted` and keeps metadata, so pruning alone doesn't reach this case.
- Should `inactive` follow an ended epoch? No; core has no path back to no epoch.
- Would a marker version bump help older readers? No; see Key Technical Decisions.

### Deferred to Implementation

- How to uniquely identify the current in-flight mutation call: candidates are the call ID among nonterminal parts of the newest assistant message, or a correlation via `messageID`. The constraint is fixed: fail closed when the occurrence isn't unique. The mechanism depends on what the before-hook can observe.
- Exact names for the new cause site and kind values.
- Whether the old build's `rejected / guard-unavailable` start parts heal. Not promised: only the no-epoch rejection is exempt.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

| History (after marker classification) | allowFresh | Result |
|---|---|---|
| Read failed / non-array | any | `unavailable` + history-read-failed cause |
| Own valid markers | any | restore (existing) |
| Malformed / ambiguous / incompatible markers | any | `unavailable` + cause (existing closure, new cause) |
| Empty or foreign-only, no non-exempt guard parts | false (transform) | `inactive`, provisional (the only retryable row) |
| Empty or foreign-only, no non-exempt guard parts | true | `inactive`, confirmed |
| Non-exempt guard parts, no own markers | any | `unavailable` + markerless-guard-history cause, non-retryable |

Exempt guard parts: status in any state; completed start/complete with guard-owned `rejected / no-active-epoch`; the uniquely identified current in-flight call.

## Implementation Units

- [ ] **Unit 1: Core `inactive` state and no-epoch result semantics**

**Goal:** The core reports `inactive / no-active-epoch` for a session without an epoch, and no-epoch transitions return `rejected / no-active-epoch`.

**Requirements:** R1, R8

**Dependencies:** None

**Files:**
- Modify: `src/lib/workflow-guard.ts`
- Modify: `src/lib/opencode-workflow-guard.ts`: state validation, marker rank (exhaustive over `WorkflowState` via `satisfies`), the no-epoch completion before-hook, and the blocked-completion after-hook writer
- Test: `tests/unit/workflow-guard.test.ts`, `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add the state to the union. The no-epoch projection changes. Mode-level `disabled`/`unavailable` projections are unchanged.
- Rank `inactive` below every blocking state in the marker aggregate.
- No-epoch completion, in both modes, completes the tool with guard-owned `rejected / no-active-epoch` metadata and leaves the session inactive. Protected mode no longer throws in the before-hook for this case.

**Execution note:** Test-first. Update the existing tests that pin `unavailable / no-active-epoch` to the new tuple; don't delete them.

**Patterns to follow:** the existing `makeStatus`/`projection` branches; the `issueKind` and result unions.

**Test scenarios:**
- Happy path: a fresh guard without an epoch projects `inactive / no-active-epoch` in protected and observe modes.
- Happy path: activation from inactive creates an epoch → `waiting / missing-evidence`.
- Edge case: a completed epoch projects `protected / epoch-completed`, not `inactive`. A later activation starts a new epoch.
- Error path: completion with no epoch writes guard-owned `rejected / no-active-epoch` metadata in both observe and protected mode. Neither the title nor the output contains the literal `unavailable`. Status stays `inactive` afterwards.
- Edge case: a same-batch [guarded skill, complete] in a fresh session, where the skill's after-hook activates an epoch first. The complete is not recorded as `rejected / no-active-epoch`.
- Edge case: other blocked completion reasons keep their current behavior and output in both modes.
- Edge case: the marker aggregate ranks `inactive` below `waiting`, `rejected`, and `unavailable`. Mixed sources pick the blocking state.
- Edge case: `disabled` mode projects `disabled`, never `inactive`.

**Verification:** both unit suites pass, and the typecheck enforces exhaustive rank coverage.

- [ ] **Unit 2: Initialization cause plumbing**

**Goal:** Every `unavailable` published from an initialization or recovery path, or from observer readback, records a bounded cause that the status output shows.

**Requirements:** R5, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`: cause types, `publishUnavailable`, the readback unavailable transition, fresh/restore clearing, and `statusForTool`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- `publishUnavailable` takes a cause.
- Initialization causes commit through the same first-cause-wins point as `markUnavailable`, so the two paths can't disagree.
- The existing remote-seeding causes are unchanged.
- The cause is cleared only on successful fresh publication or restoration.

**Patterns to follow:** the existing `GuardUnavailableCause` shape and its remote-scope site values. Status output is the only surface.

**Test scenarios:**
- Happy path: each initialization branch that publishes `unavailable` (markerless guard history, malformed/ambiguous/incompatible markers, rejected recovery) shows its distinct cause on status.
- Happy path: an observer readback failure during an active epoch shows its readback cause on status.
- Edge case: a later successful fresh initialization clears a stale cause. A subsequent cause-less transition does not resurface it.
- Error path: the cause contains only enum values and `timedOut: false`. There are no call IDs, tool names, or paths.
- Integration: the cause is absent from tool metadata markers, receipts, and digests. Extend the existing assertion that metadata has no `firstUnavailableCause`.

**Verification:** status for each branch is distinguishable from its output alone.

- [ ] **Unit 3: Host history read fails closed**

**Goal:** A failed or malformed host history read can no longer look like empty history.

**Requirements:** R4, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `src/index.ts`: a strict host read for the initialization path; the existing child-facing read is unchanged
- Modify: `src/lib/opencode-workflow-guard.ts`: initialization uses the strict read, and its catch records the history-read-failed cause
- Test: `tests/unit/opencode-workflow-guard.test.ts`; `tests/unit/plugin.test.ts` if the wiring is reachable there

**Approach:** the strict read throws on an SDK `error` or non-array `data`. The existing initialization catch fails closed with the new cause. Child-rollup reads stay on the HEAD contract.

**Test scenarios:**
- Error path: a thrown read, `{data: undefined, error}`, and non-array data each yield `unavailable` with a history-read-failed cause, never `inactive`.
- Happy path: a successful empty array yields `inactive`.
- Edge case: during rollup, a child read returning an SDK error or non-array data rolls up nothing and leaves the parent unchanged. A thrown child read marks the parent unavailable, as at HEAD.

**Verification:** no initialization-path read maps a failed read to `[]`.

- [ ] **Unit 4: History exemption rule and provisional inactive**

**Goal:** Status calls and guard-owned no-epoch rejections stop blocking fresh initialization, while every evidence-bearing history stays closed.

**Requirements:** R1, R2, R3, R4, R10

**Dependencies:** Units 1-3

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`: the history check, empty-marker publication, and the recovery retry gate
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Apply the exemption rule from Key Technical Decisions, after marker classification.
- A transform with empty history publishes a provisional `inactive` and stays retryable. Only a successful allow-fresh recovery confirms it.
- Re-initialization follows the waiter protocol in Key Technical Decisions. Only the provisional path is retryable.

**Execution note:** Test-first. Start with adapter-boundary probes reproducing both #1076 paths (transform → status-first → skill activation, with empty and current-in-flight-status history) and watch them fail.

**Patterns to follow:** the live-request ordering probe in the existing completed-control fail-closed test; `createPinnedRecoveryAdapter` and `buildMarkersForRegistration` for restart fixtures.

**Test scenarios:**
- Happy path: event-first, transform-first, before-first, and direct tool on a fresh session all end `inactive / no-active-epoch`. The marker text is identical across passes.
- Happy path: status-first with the in-flight status part in history → `inactive`. A second status → `inactive`. Then a guarded skill load → `waiting / missing-evidence`.
- Happy path, restart: history with only completed markerless status parts → `inactive`.
- Happy path, restart: a completed start with guard-owned `rejected / no-active-epoch` → `inactive`.
- Happy path, restart: a no-epoch completion made in protected mode, and one made in observe mode, each → `inactive`.
- Edge case: a first in-flight start in a fresh session initializes fresh, then rejects with `no-active-epoch`. Subsequent status → `inactive`.
- Error path, restart: each of these → `unavailable` with the markerless-guard-history cause:
  - a completed markerless control part (the existing test stays green);
  - a completed start claiming `started` without a marker;
  - a completed start rejected with `epoch-completed`;
  - a completed complete without guard-owned `rejected / no-active-epoch` metadata;
  - a part missing `state.status`;
  - a prior-process running start.
- Error path: an earlier completed start sharing the current call's call ID stays closed.
- Error path: malformed, ambiguous, or incompatible markers stay closed even when every guard part is exempt.
- Edge case: valid foreign-only markers keep HEAD behavior.
- Integration: transform-first provisional `inactive` followed by a before-hook re-read that finds a late own marker restores from it rather than overwriting it.
- Integration (deterministic): transform-first provisional `inactive`, then two concurrent hooks. The host read is held on a deferred promise that resolves only after the second hook arrives. Neither hook observes `unavailable` or `guard-unavailable`.
- Integration: transform-first provisional `inactive`, then a guarded-skill after-hook and a bash before-hook in parallel. No epoch or receipt is lost across the confirming re-read.
- Edge case: after markerless-guard-history `unavailable`, later hooks do not trigger another history read.
- Integration: in observe mode the projection matches protected mode, with observe enforcement.

**Verification:** both #1076 reproductions now pass. Every pre-existing fail-closed recovery test passes unchanged, except tuple renames from Unit 1.

- [ ] **Unit 5: Status and readback without lifecycle side effects**

**Goal:** A status call can't discard sibling pending work or disable an epoch-less session.

**Requirements:** R6, R7

**Dependencies:** Unit 4

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`: `readStatus`/`refreshReadback` stop calling the wholesale abandon; transform keeps request-boundary cleanup; readback returns early without an epoch
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Patterns to follow:** existing pending-map tests; observer injection in `createAdapter`.

**Test scenarios:**
- Integration: parallel batches with sibling parts `pending`/`running` and concurrent before-hooks: status+start, status+guarded-skill, status+complete. Expect no `unavailable`, one stable ledger, and the skill activation is not lost.
- Edge case: a before-hook whose execute throws or aborts (no after-hook) leaves its pending entry. The next transform cleans it up, and the next status does not.
- Error path: status in an epoch-less session with a missing, unavailable, or throwing observer → still `inactive`. The guard is not disabled, and the observer is not called.
- Edge case: status during an active epoch with a failing observer keeps HEAD behavior and shows the readback cause.

**Verification:** no status-path call mutates the pending maps, and an epoch-less status never reaches the observer.

- [ ] **Unit 6: Agent guidance and architecture docs**

**Goal:** Agents treat `inactive` as non-terminal, and the docs describe the state, the causes, and the residual limits.

**Requirements:** R9

**Dependencies:** Units 1-5

**Files:**
- Modify: `skills/using-systematic/SKILL.md` (the guard-availability rule)
- Modify: `tests/unit/__snapshots__/bootstrap.test.ts.snap`, `tests/unit/bootstrap.test.ts`
- Modify: `ARCHITECTURE.md` (the receipt-backed workflow guard paragraph)

**Approach:**
- Rule text:
  - `inactive` means no guarded workflow is active in this session.
  - Load a guarded skill to begin.
  - Don't call start or complete without an epoch.
  - Only `unavailable` is terminal for the unit.
  - State is per session; a child session starts `inactive`.
- `ARCHITECTURE.md` covers:
  - the `inactive` state;
  - that initialization causes surface through the same status-only channel as `firstUnavailableCause`;
  - mixed-version dual registrations fail closed;
  - completely erased markers can't be distinguished from never-activated.
- Rebase awareness: PR #1078 edits a different `ARCHITECTURE.md` section.

**Test expectation:** the bootstrap snapshot and the inline assertion update to the new rule text.

**Verification:**
- Bootstrap tests pass.
- `bun scripts/content-integrity.ts` passes.
- `bun run docs:generate` leaves no unexpected generated drift.
- `bun run registry:drift` is clean (no `references/` files added or removed).

- [ ] **Unit 7: Real-host status-first verification**

**Goal:** Prove the fix on the pinned real OpenCode host: a fresh conversation, status-first, then a guarded skill.

**Requirements:** R1, R2

**Dependencies:** Units 1-5

**Files:**
- Modify: `tests/integration/receipt-workflow-dogfood.test.ts`: add a status-first scenario to the scripted calls and assert `workflowGuardStatus`

**Approach:** a fresh isolated conversation, reaped through the existing fixture's process-group stop. No `pkill`. Any local run reaps only PIDs that are new since a pre-run baseline, and verifies none remain.

**Test scenarios:**
- Integration: status-first reports `inactive`. After the guarded skill loads, status reports `waiting / missing-evidence`.

**Verification:**
- The scenario passes under the pinned host.
- The host-contract guard's expected-suite and pass-floor checks still hold in CI.
- No orphaned `opencode` processes remain after the run.

## System-Wide Impact

- **Interaction graph:**
  - the system-prompt transform;
  - `tool.execute.before`/`after` for guard and skill tools;
  - the `event` hook;
  - the four `systematic_workflow_*` tools;
  - the host readback in `src/index.ts`.
- **Error propagation:** history-read failures move from a silent `[]` to an `unavailable` with a cause.
- **State lifecycle risks:**
  - Provisional `inactive` must never allow activation without a confirming re-read.
  - The pending maps lose their status-path cleanup. Transform cleanup must still bound them.
- **API surface parity:**
  - Tool metadata `state` gains a value.
  - Downstream consumers reading `state === 'unavailable'` as "guard broken", such as the Fro Bot review footer, now see `inactive` for idle sessions. That is the intended fix.
- **Behavior change:** sessions the bug had silently left without enforcement now get protected-mode completion enforcement. Call this out in the PR and release notes.
- **Unchanged invariants:**
  - receipt and readback protocol versions;
  - integrity digests;
  - the `firstUnavailableCause` exclusion from markers and receipts;
  - fail-closed classification of malformed, ambiguous, or incompatible markers;
  - remote-scope seeding behavior (#1005).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| An exemption hides real lost evidence | Exemptions apply only after marker classification. Only lifecycle-neutral status calls and guard-owned no-epoch rejections are exempt. Restart fixtures pin every closed case. |
| Provisional `inactive` lets an epoch form without a re-read | Activation only occurs after a skill's after-hook re-read, and re-init is serialized per session. Tests cover a late own marker and parallel first-turn hooks. |
| Protected-mode no-epoch completion no longer throws | Nothing is enforceable without an epoch. The tool still refuses, with guard-owned rejected metadata, and other blocked reasons keep throwing. |
| Mixed-version dual registration shows aggregate `unavailable` | Documented. Upgrade both registrations together. |
| Removing status-path abandonment leaks pending entries | Transform cleanup retained; a test covers an aborted execute. |
| Pinned-host part semantics drift on an OpenCode bump | The real-host scenario in Unit 7 runs in the required host-contract job. |

## Documentation / Operational Notes

- The PR body and release notes state the restored completion enforcement, and that idle sessions now report `inactive`.
- Ship as a `fix:` title, a patch release.

## Sources & References

- Issue: #1076, including the Fro Bot triage comment with adapter-probe evidence
- Related: #1005, #740, #1004, #1049, PR #1078
- Related code: `src/lib/workflow-guard.ts`, `src/lib/opencode-workflow-guard.ts`, `src/index.ts`, `skills/using-systematic/SKILL.md`
