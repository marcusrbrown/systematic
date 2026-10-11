---
title: "fix: Keep a transient remote probe failure from disabling the workflow guard"
type: fix
status: completed
date: 2026-10-11
---

# fix: Keep a transient remote probe failure from disabling the workflow guard

## Overview

When a guarded workflow activates and a remote probe times out, or push finds no upstream, only that operation's baseline is deferred. The guard is no longer disabled for the whole session. A deferred operation is admitted only on an available read taken right before it runs. PR creation stops treating a timed-out or otherwise `unavailable` before-read as proof that no PR existed. Auth and network failures still surface as `missing-resource` until #1081.

## Problem Frame

Issue #1005. Activating a guarded skill seeds a remote baseline for each required remote operation: push, PR creation, check readback, review readback. Any non-tolerated probe result marks the session `unavailable`, and the session never recovers. Two triggers reach this:

- **A transient probe failure.** A `git` or `gh` call that hits the observer's 5-second default timeout disables the guard.
  - CI Host Contract failures match this signature on [Sept 10](https://github.com/marcusrbrown/systematic/actions/runs/34543669825/job/103091572989) and [Sept 18](https://github.com/marcusrbrown/systematic/actions/runs/35405852057/job/105795347600).
  - No log captured the probe status, so a timeout is plausible but unproven.
- **A branch with no upstream.** `git-commit-push-pr` supports `git push -u origin HEAD`. Push seeding reads `@{upstream}`, which fails, and push `missing-resource` is fatal.

There is also a fail-open: when the PR-creation before-read isn't `available`, the guard seeds its baseline from the after-read, and the PR revision check accepts an undefined before. A timed-out before-read therefore admits a PR-creation receipt as if no PR had existed.

## Requirements Trace

- R1. At activation seeding, a remote probe `command-timeout`, or push `missing-resource`, defers that operation's baseline. The unit, the epoch and every other operation are unaffected, and the session is not marked unavailable.
- R2. Every other seeding failure stays fatal, with its existing bounded cause. Push `missing-resource` defers even though, until #1081, it can also hide an auth, network or spawn failure. A push deferred that way never admits.
- R3. A deferred operation stays required. A unit can't complete without its receipt.
- R4. A deferred operation leaves deferral only through its own before-read, which is retried once on a timeout.
  - An `available` before-read binds the baseline.
  - For PR creation, check and review, a `missing-resource` before-read takes the path the same result already takes when it comes from the seed.
  - For push, a `missing-resource` before-read binds nothing.
  - Any other result admits no receipt.
- R5. PR creation seeds from its after-read only when its before-read was `missing-resource`. A timeout or any other `unavailable` before-read never admits. The observer still reports some gh failures as `missing-resource`; that remaining gap is #1081.
- R6. Deferrals appear on status output through their own bounded, enum-only diagnostic, which never enters markers, receipts or digests.
- R7. The dogfood push scenario records push-status, including any `firstUnavailableCause`, before its assertions.

## Scope Boundaries

- No change to how the observer classifies results. `missing-resource` still lumps absence together with auth, network and spawn failures. See #1081.
- A first push still can't mint a receipt. It now fails closed without disabling the session.
- A local snapshot failure in an operation's before-hook still disables the session, as it already does for every operation (#1080).
- A deferred push binds to whatever upstream its before-read finds: the same identity a successful seed would have taken. Checking that it is the expected branch on the expected remote is #1081.
- Malformed or limit-exceeded gh output at seeding stays fatal (#1081).
- No changes to status-refresh, completion or after-hook readbacks. #1080 owns their transient failures; #1081 owns their drift handling.
- Protected mode doesn't block an operation whose before-read stays unavailable. The operation runs, no receipt is admitted, and retrying needs a new commit.
- No guard-wide recovery from `unavailable`, and no persistence of deferrals across a restart.
- No receipt, readback or marker protocol version change.
- Fail-closed test assertions aren't weakened. Observer timeouts, scenario serialization and sleeps are unchanged.

### Deferred to Separate Tasks

- Proving absence from positive signals, server-verified first push, remote and repository pins, fork exclusion, PR number and base binding, check exit-code mapping, and readback drift without rebinding baselines: #1081.
- Transient failures after an operation is satisfied: #1080.

## Context & Research

### Relevant Code and Patterns

- `src/lib/opencode-workflow-guard.ts`:
  - `seedRemoteScopes` stops at the first cause.
  - `seedRemoteScope` holds the tolerated/fatal table: push `missing-resource` and every `unavailable` are fatal.
  - Both are reached from `startFreshUnit` via skill activation and explicit start.
  - `prepareOperation` / `remoteIntentForOperation` store `remoteBefore`, but never feed the core.
  - `completeOperationObservation` holds the PR-creation unknown-before branch.
  - `recordUnavailable` / `markUnavailable` commit the first cause.
  - `statusForTool` renders status.
- `src/lib/workflow-guard.ts`:
  - `observeReadback` → `observeOperationResource` writes `currentResourceIdentities` unconditionally, and calls `propagatePullRequestScope` for PR creation.
  - `resourceBeforeReason` rejects a missing expected identity with `resource-mismatch`. That is the fail-closed behavior a deferred operation relies on until it is bound.
- Tests:
  - In `tests/unit/opencode-workflow-guard.test.ts`, the seeding cause table pins push timeout and push `missing-resource` as fatal. Both flip.
  - `sequenceObserver` is a per-key queue of remote results.
  - The PR-creation mint test accepts a `missing-resource` before. Keep it.
- `tests/integration/receipt-workflow-dogfood.test.ts`: the push scenario's push-status assertion.

### Institutional Learnings

- `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`: capture before-identities immediately before the readback, and keep stable identity mismatches fatal.
- `docs/solutions/integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`: anchor readbacks to the evidence's own target, and avoid canonical receipt-field changes.
- `docs/solutions/workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md`: record the earliest failure, not just the final state.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-operation-observer.ts + src/lib/opencode-workflow-guard.ts + src/lib/workflow-guard.ts (receipt-backed guard subtree)",
  "freshness": {
    "vcs_reference": "e50bb35"
  },
  "budget": {
    "max_search_passes": 14,
    "max_candidate_inspections": 24,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:seedRemoteScope",
      "description": "Per-operation seeding decision: tolerates missing-resource for pr-creation, check-readback, review-readback; treats push missing and any unavailable (including command-timeout) as fatal.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:seedRemoteScopes",
      "description": "Orders per-operation seeding and stops at the first cause; local snapshot failures are fatal. Needs a deferred outcome that continues per operation.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:recordUnavailable/markUnavailable",
      "description": "First-cause-wins commit of unavailable mode with a bounded GuardUnavailableCause. Reusable for cause recording; the timeout path must stop calling it.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:completeOperationObservation",
      "description": "Operation completion including the pr-creation unknown-before branch that seeds the PR identity from the after readback when remoteBefore is not available. Source of the absence-proof tautology.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:prepareOperation/remoteIntentForOperation",
      "description": "Before-hook capture of remote before snapshot into PendingOperation.remoteBefore. Snapshot is not fed to the core; a re-read path must add observeReadback.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:buildOperationObservation",
      "description": "Builds receipt context identities from remoteBefore only when available, and from the after identity for pr-creation.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:refreshRemoteReadbacks/completionRemoteReadbacks",
      "description": "Remote readbacks for satisfied operations at status refresh and completion; any non-available result marks unavailable. Same transient-failure class outside activation.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:progressionResourceScopes",
      "description": "Emits only core unit.resourceScopes digests for progression markers. Observed identities are not persisted, so restart recovery loses them.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:classifyLocalObservation/'deferred'",
      "description": "Existing deferred status for unclassified commands (category null). Different meaning from a probe deferral.",
      "disposition": "insufficient",
      "insufficiency_reason": "'deferred' here means an unclassifiable command, not a remote probe to retry; reusing it would conflate the two."
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:runRemoteCommand",
      "description": "Maps runner throw, timeout, output limit, and any non-zero exit to command-timeout, remote-command-output-limit, or remote-command-failed; discards exit code and stderr beyond size checks.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:readRemoteGitValue/readRemotePullRequest/readCheckReadback",
      "description": "Collapse every remote-command-failed into missing-resource, covering absence, auth, transport, and spawn failures.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:OperationObserverRemoteResult",
      "description": "Remote result union with available, missing-resource (no reason), and unavailable(reasonCode).",
      "disposition": "insufficient",
      "insufficiency_reason": "missing-resource carries no reasonCode, so absence cannot be distinguished from auth or transport failure at the type level."
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:defaultRemoteCommandRunner",
      "description": "spawnSync wrapper with timeout and env sanitization; returns status -1 on spawn failure. Reusable injection seam for remoteCommandRunner.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:prRevisionReason",
      "description": "Pr-creation revision check that passes when before is undefined and after is defined. Combined with unknown-before seeding, admits PR receipts without proven absence.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:resourceBeforeReason",
      "description": "Rejects with resource-mismatch when expected identity is missing or differs. Fail-closed for deferred or unseeded operations.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:observeOperationResource/propagatePullRequestScope",
      "description": "Stores observed identity per operation and propagates pr-creation identity to undeclared check and review scopes.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:startParsedUnit",
      "description": "Starts a unit, clears and sets currentResourceIdentities from declared policy scopes, and declares required operations. Owns the per-operation baseline lifecycle.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:recoveryResourceIdentities",
      "description": "Restart recovery; skips persisted scopes whose trusted identity is absent. Relevant to any deferred state that must survive restart.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/unit/opencode-workflow-guard.test.ts:seedRemoteScope cause table",
      "description": "Pins push command-timeout seeding as fatal with timedOut true and push missing-resource as fatal. The timeout case flips under the fix.",
      "disposition": "extend"
    }
  ],
  "excluded_scopes": [
    {
      "scope": "docs/plans/",
      "reason": "Excluded by the research instruction; not opened."
    },
    {
      "scope": "src/pi.ts and the Pi harness",
      "reason": "Pi has no runtime receipt guard, so no remote seeding path exists there."
    }
  ]
}
```

## Key Technical Decisions

- **Deferral lives in adapter runtime state, per operation.**
  - At seed, a remote `command-timeout`, or push `missing-resource`, puts the operation in a deferred set, unless the core already holds a baseline for it. That happens for a resource declared on the unit, or for a PR identity an earlier PR-creation seed propagated to check or review. Such an operation keeps that baseline, and its admission still needs an available before-read that matches it. The adapter asks through a small read-only core accessor.
  - Otherwise the core gets no readback for the deferred operation, so `resourceBeforeReason` keeps rejecting it until it is bound.
  - The deferred set is keyed by unit and cleared whenever a unit starts, matching the core's per-unit baselines.
  - The seed loop continues. Only fatal causes mark the session unavailable.
  - The deferred set isn't persisted, so no protocol versions change.
- **Only the operation's own before-read binds a deferred baseline.**
  - The before-read must come from the seed's own observer and target, and must be `available`.
  - It binds by calling `guard.observeReadback` with the resource baseline only. No repository or worktree identities are fed, because changing those stales every prior receipt. The readback names the deferred operation; without one, the core would overwrite every operation's baseline.
  - PR-creation identity is not propagated to check and review. That needs a narrow core option on `observeReadback`.
  - On a timeout the before-read is retried once, immediately.
  - For PR creation, check and review, a `missing-resource` before-read clears the deferral without binding, matching the tolerated seed path. PR creation then uses the narrowed self-seed.
  - The operation leaves the deferred set when it binds or clears.
- **No generation counter.** Seeding awaits each operation in turn, and a before-read binds only an operation whose seed already deferred, so the two can't race for one baseline. A before-hook that runs while its operation's seed is still in flight finds no deferral and binds nothing. That operation fails closed without a receipt.
- **The PR-creation self-seed is narrowed, not removed.**
  - The unknown-before branch runs only when the before was `missing-resource`. That keeps today's new-PR path and closes the timeout and `unavailable` hole. The `missing-resource` hole (gh failures the observer reports as missing) remains until #1081.
  - The after-identity context fallback is gated the same way.
- **The deferral diagnostic is separate.**
  - Status output gains a bounded list of deferred operations, each with its operation and the observer result that deferred it: `command-timeout`, or `missing-resource` for push. `missing-resource` can also hide auth or network failures until #1081.
  - It is separate from `firstUnavailableCause`, which renders only while the state is `unavailable`.

## Open Questions

### Resolved During Planning

- Scope: the narrow fix, with the remote-evidence design moved to #1081, as Marcus decided after two review rounds.
- Post-operation readback failures: tracked in #1080.

### Deferred to Implementation

- The exact name and shape of the diagnostic field.
- The shape of the core option that skips PR propagation on a before-read binding.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

| Seed probe result | Outcome |
|---|---|
| available | seeded (unchanged) |
| `missing-resource` for pr-creation, check or review | tolerated (unchanged) |
| `missing-resource` for push | deferred |
| `unavailable / command-timeout` (remote) | deferred |
| anything else | session `unavailable` with cause (unchanged) |

| Deferred op's before-read (one retry on timeout) | Result |
|---|---|
| available, same observer and target | binds the baseline; normal admission applies |
| `missing-resource` for PR creation, check or review | clears the deferral; same path as a tolerated seed (PR creation uses the narrowed self-seed) |
| anything else | no binding; the receipt is rejected and the unit projects `rejected / resource-mismatch`; the session stays available |

## Implementation Units

- [x] **Unit 1: Per-operation seeding deferral**

**Goal:** A remote seeding timeout, or a push with no upstream, defers that one operation instead of disabling the session.

**Requirements:** R1, R2, R3, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts` (`seedRemoteScopes`, `seedRemoteScope`, status rendering)
- Modify: `src/lib/workflow-guard.ts` (read-only accessor: does an operation already have a baseline)
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- `seedRemoteScope` returns seeded, deferred or fatal. The loop continues past a deferral.
- Deferred operations go in a per-unit set, cleared at unit start.
- Status shows the deferral diagnostic.

**Execution note:** Test-first. Two rows of the seeding cause table flip to deferred: push `missing-resource` and push `command-timeout`. The table's per-row `unavailable` assertion becomes a per-row expected outcome. Every other row is unchanged. With push `missing-resource` deferred, the `remote-scope-missing-resource` cause kind has no producer left, so remove it.

**Patterns to follow:** `recordUnavailable` first-cause-wins; `sequenceObserver` per-key results.

**Test scenarios:**
- Happy path: push times out while the other operations seed. The session isn't unavailable, the epoch and unit stay active, push stays required, and status lists the push deferral.
- Happy path: push `missing-resource` (no upstream) gives the same outcome, with reason `missing-resource`.
- Happy path: a timeout on check or review readback is deferred and the others still seed.
- Error path: every other existing fatal row in the cause table keeps its cause and still marks the session unavailable.
- Error path: a local snapshot timeout stays fatal.
- Edge case: the deferred operation never runs. Completing the unit is rejected for missing evidence.
- Edge case: the PR-creation seed is available, then the check seed times out → no check deferral. Check admission still needs an available before-read matching the propagated identity.
- Edge case: an operation whose resource was declared on the unit times out at seed → no deferral.
- Edge case: a deferral from one unit doesn't carry into the next; the next unit's seed starts clean.
- Integration: the deferral diagnostic is absent from markers, receipts and digests, extending the existing `firstUnavailableCause` exclusion tests.
- Integration: observe and protected mode give the same seeding outcome.

**Verification:** `markUnavailable` is never called for a remote seeding timeout or push `missing-resource`.

- [x] **Unit 2: Before-read binding with retry**

**Goal:** The operation's own available before-read binds a deferred baseline, and nothing else does.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts` (`prepareOperation`, `remoteIntentForOperation`)
- Modify: `src/lib/workflow-guard.ts` (an `observeReadback` option that skips PR propagation)
- Test: `tests/unit/opencode-workflow-guard.test.ts`, `tests/unit/workflow-guard.test.ts`

**Approach:**
- For a deferred operation, the before-hook reads with one retry on timeout.
- When the read is available and comes from the seed's own observer and target, it feeds the resource baseline, without propagation, and clears the deferral.

**Execution note:** Test-first.

**Patterns to follow:** the seed's existing `observeReadback` call shape, without repository and worktree identities.

**Test scenarios:**
- Happy path: deferred push, before-read available → baseline bound, push receipt admitted. Earlier `commit` and `implementation` receipts don't go stale.
- Happy path: before-read times out once, then succeeds → bound and admitted.
- Error path: before-read times out twice → the push runs, no receipt, the session isn't unavailable, push is still missing.
- Error path: a push before-read of `missing-resource` (still no upstream) → no binding, no receipt, the session isn't unavailable.
- Happy path: a deferred PR creation whose before-read is `missing-resource` → deferral cleared; after creation, the narrowed self-seed admits the receipt.
- Error path: a before-read from a different registered worktree's observer → doesn't bind.
- Edge case: a push before-hook that runs while the push seed is still in flight binds nothing. If the seed then defers, the push gets no receipt and the session isn't unavailable.
- Edge case: after a deferred push that never bound, the unit projects `rejected / resource-mismatch` and the session stays available.
- Integration: a PR-creation before-read binding doesn't change the check or review baselines.
- Integration: a push binding names its operation and leaves the PR-creation, check and review baselines unchanged.

**Verification:** a deferred operation is admitted only after an available before-read from its own target.

- [x] **Unit 3: Narrow the PR-creation self-seed**

**Goal:** A timed-out or failed before-read can't admit a PR-creation receipt.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts` (`buildOperationObservation`, `completeOperationObservation`)
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:** run the unknown-before seeding branch and the after-identity fallback only when `remoteBefore.status === 'missing-resource'`.

**Execution note:** Test-first. Start with the regression test for a timeout before-read.

**Test scenarios:**
- Error path: a PR-creation before-read of `unavailable / command-timeout`, of another `unavailable`, or absent (the read threw) → never admitted.
- Happy path: the existing PR-creation mint test with a `missing-resource` before still passes.
- Edge case: PR present before, failed create, head unchanged → `no-op-operation` (unchanged).

**Verification:** only a `missing-resource` before can seed PR creation from its after-read.

- [x] **Unit 4: Dogfood diagnostic**

**Goal:** A future push flake records its own cause.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `tests/integration/receipt-workflow-dogfood.test.ts`

**Approach:**
- Before the push scenario's assertions, log push-status state, `reasonCode` and `firstUnavailableCause`.
- No assertion changes.
- Process cleanup goes through the fixture's process-group stop. A local run kills only PIDs that appeared since a pre-run baseline, never with `pkill`.

**Test scenarios:**
- Integration: the existing push scenario passes, and the diagnostic line appears before its assertions.

**Verification:** the dogfood suite is green on the pinned host, and no `opencode` processes are left over.

- [x] **Unit 5: Architecture notes**

**Goal:** The guard paragraph describes seeding deferral and its limits.

**Requirements:** R6

**Dependencies:** Units 1-3

**Files:**
- Modify: `ARCHITECTURE.md` (receipt-backed workflow guard paragraph only)

**Approach:** state as current fact:
- a remote seeding timeout, or a push with no upstream, defers one operation;
- a deferred operation is admitted only on an available before-read;
- PR creation needs a `missing-resource` before;
- first push still can't mint (#1081);
- post-operation readback failures still disable the session (#1080).

**Test expectation:** none: documentation only.

**Verification:** `bun scripts/content-integrity.ts` passes.

## System-Wide Impact

- **Interaction graph:** skill activation and explicit start (via `startFreshUnit`); operation before-hooks; PR-creation completion; status rendering.
- **Error propagation:** a remote seeding timeout and push `missing-resource` move from session-wide `unavailable` to a per-operation deferral. Every other failure path is unchanged.
- **State lifecycle risks:** the deferred set is keyed by unit and cleared at each unit start. It is in memory only, so a restart fails closed.
- **API surface parity:** status output gains the deferral diagnostic. Tool metadata, markers and receipts are unchanged.
- **Behavior changes:**
  - Sessions no longer disable on a remote seeding timeout or a branch with no upstream.
  - PR-creation receipts admitted on a timed-out or otherwise `unavailable` before-read are now refused.
- **Unchanged invariants:**
  - Protocol versions, integrity digests, and identity derivation are unchanged.
  - Observer classification is unchanged.
  - Every other fatal seeding cause is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The before-hook now awaits a remote read, with one retry, for deferred operations | Only deferred operations pay this cost, bounded by the existing observer limits |
| A deferred push never binds, so the unit can't complete without a new commit | Fails closed; documented; the diagnostic shows why |
| `missing-resource` still hides auth or network failures for every remote operation; for push it now defers instead of disabling | Unchanged classification; a push deferred this way never admits; tracked in #1081 |

## Documentation / Operational Notes

- The PR body states both behavior changes, and links #1080 and #1081.
- Ship as a `fix:` title, a patch release.

## Sources & References

- Issue: #1005. Companions: #1080, #1081.
- CI evidence: [Sept 10 run](https://github.com/marcusrbrown/systematic/actions/runs/34543669825/job/103091572989), [Sept 18 run](https://github.com/marcusrbrown/systematic/actions/runs/35405852057/job/105795347600)
- Related code: `src/lib/opencode-workflow-guard.ts`, `src/lib/workflow-guard.ts`
