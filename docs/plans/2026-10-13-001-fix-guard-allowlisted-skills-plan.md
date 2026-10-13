---
title: "fix: Only allowlisted skills activate a workflow guard epoch"
type: fix
status: active
date: 2026-10-13
---

# fix: Only allowlisted skills activate a workflow guard epoch

## Overview

The OpenCode workflow guard treats any skill it doesn't recognise as `ce:work`. So loading `ce:review`, `ce:brainstorm`, `todos`, or any user skill starts a work epoch that needs implementation and verification evidence. Mid-epoch, the same load starts a new unit or is rejected as a family conflict. After this change, only the allowlisted skills activate an epoch. Loading any other skill through the skill tools leaves guard state unchanged.

## Problem Frame

`normalizeSkill` in `src/lib/opencode-workflow-guard.ts` ends with a `ce-work` fallback, so no name is ever left unrecognised. The core already ignores names outside its family table (`familyForSkill` in `src/lib/workflow-guard.ts`). It never sees an unknown name, because the adapter has already rewritten it. The 2026-07-25 guard plan says unrelated skill loads do nothing, which this fallback contradicts. No document explains why the fallback exists (#1096).

Consequences today:
- A session that only produces reports shows `waiting / missing-evidence` for work it will never do.
- `lfg` runs `ce:review` after `ce:work`, which reopens a unit that then needs fresh evidence.
- Every load of a skill outside the allowlist mid-epoch re-emits the epoch and unit progression markers.

## Vocabulary

- **Allowlisted name:** a `name` argument to the `skill` or `systematic_skill` tool that the adapter maps to a canonical guard skill:

  | Name | Canonical guard skill | Family |
  |---|---|---|
  | `ce:work`, `systematic:ce:work` | `ce-work` | work |
  | `git-commit`, `systematic:git-commit` | `git-commit` | shipping |
  | `git-commit-push-pr`, `systematic:git-commit-push-pr` | `git-commit-push-pr` | shipping |

  The canonical guard skill is the internal key used by the policy and family tables. It is not a skill name the model loads.
- **Other skill load:** any other bounded string name passed to either tool.

## Requirements Trace

- R1. Skill activation logic is a no-op for an *other skill load*. It does not activate an epoch, start a unit, emit progression markers, record seed deferrals, or change the runtime policy. This holds in every guard state (inactive, waiting, protected, rejected, unavailable) and mid-epoch in either family. Session recovery, which runs on every hook before any skill logic, is unchanged.
- R2. Every allowlisted name keeps today's activation, through both tools and at any output size. The resulting unit carries that skill's required operations.
- R3. A name that matches an inherited object property, such as `constructor`, `toString` or `__proto__`, is an other skill load.
- R4. ARCHITECTURE.md and the 32 KB activation solution doc describe allowlist-only activation and its limits.

## Scope Boundaries

- No frontmatter or config way for a skill to declare itself guarded. The allowlist stays in trusted source.
- No new epoch family for review or planning skills.
- No marker, receipt, or protocol version change. Markers carry no skill name.
- No change to the core guard (`src/lib/workflow-guard.ts`).
- No change to how the before- and after-hooks of a skill call are paired. A call whose two hooks map to *different allowlisted names* still fails closed as `call-lifecycle-mismatch`, as today. An other skill load never binds a call.
- No change to `skills/using-systematic/SKILL.md`. Its text, "load a guarded skill to begin", is still accurate, and editing it would churn the bootstrap byte pin.

### Deferred to Separate Tasks

- Skill names that don't resolve, in `skills/ce-work/references/shipping-workflow.md` (`ce-commit`, `ce-commit-push-pr`, `ce-code-review`, `feature-video`) and `skills/ce-brainstorm/references/handoff.md` (`ce-work`). These go in a separate PR with a shipping-path integration test, because fixing them turns on a shipping epoch on `ce:work`'s normal path for the first time.
- Operation observation without an epoch, where a failed snapshot can still disable an inactive session: #1105.
- Snapshot false-cleans and read races: #1099.

## Context & Research

### Relevant Code and Patterns

- `src/lib/opencode-workflow-guard.ts`:
  - `normalizeSkill`: the alias table plus the fallback. This is the one-line bug.
  - `TRUSTED_SKILL_POLICIES` and `trustedSkillPolicy`: the required operations for each canonical guard skill. The default (`MANDATORY_REQUIRED_OPERATIONS`) still serves the initial `'unknown'` runtime policy.
  - `prepareSkill`: returns before `bindCall` and before `pendingSkills` when the name normalizes to undefined.
  - `finishSkill`: returns quietly when it finds no pending entry, and only reaches activation for a pending allowlisted call.
- `src/lib/workflow-guard.ts` `familyForSkill`: the core's copy of the allowlist. `activate` returns `ignored` for anything else.
- `src/lib/skill-resolver.ts` `resolveSkill`: exact-match on frontmatter names after it strips `systematic:`. So `systematic:ce:work` loads the real skill, and case or whitespace variants load nothing.
- Existing fallback pin: `tests/unit/opencode-workflow-guard.test.ts` around lines 1472-1479, "falls back to the mandatory floor for unknown guarded skills" (`ce:brainstorm`).
- Existing integration pin: `tests/integration/skill-delivery.test.ts` scenario (f), around lines 731-822. It loads `ce:plan` (63 KB) and expects an epoch marker. The header comment (around lines 31-33) and the `CE_PLAN` comment (around lines 299-300) describe that.

### Institutional Learnings

- `docs/solutions/integration-issues/workflow-guard-skipped-skills-over-32kb-2026-09-26.md`: successful activation must not depend on output size. Its test case stops activating under this change.
- `docs/solutions/best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md`: assert at the adapter boundary that an unknown skill causes no side effects.
- `docs/solutions/best-practices/verify-a-no-change-claim-against-the-consumer-2026-09-08.md`: a "no change" claim needs a test that fails under the old semantics.
- No solution doc explains the `ce-work` fallback.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/, tests/, skills/, docs/, ARCHITECTURE.md",
  "freshness": {
    "vcs_reference": "20c20283"
  },
  "budget": {
    "max_search_passes": 12,
    "max_candidate_inspections": 20,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:normalizeSkill",
      "description": "Maps skill tool args to canonical guard skills via an alias table, then falls back to ce-work for every other name.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:TRUSTED_SKILL_POLICIES",
      "description": "Required operations per canonical guard skill.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts:familyForSkill",
      "description": "Core skill-to-family table; activation is ignored for any other name.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts:prepareSkill/finishSkill",
      "description": "Skill call lifecycle; already a no-op when the name normalizes to undefined.",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Keep the hardcoded allowlist and remove the fallback.** The core already enforces the same set, and trust stays in source (user decision).
- **An other skill load mid-epoch is a no-op, not a unit boundary.** This drops today's "an unknown skill after a completed unit starts a new unit" (user decision).
- **No sealing for other skill loads.** They never bind a call or record a pending entry. Binding them would add fail-closed paths (a callID reused across calls, abandonment by the transform mid-call) and unbounded state, and would buy no guarantee. A plugin rewriting `args.name` between hooks remains a documented limit (user decision after review).
- **Own-key lookup.** The alias table becomes the allowlist gate, so inherited properties must not match.
- **Behaviour assertions instead of a drift test.** The alias and policy tables are module-private. A test that reads them would be circular. Unit 1 instead asserts each allowlisted name's family and literal required operations through guard status, and each test is written to fail when the code is mutated.

## Open Questions

### Resolved During Planning

- Does an other skill load avoid side effects once its name normalizes to undefined? Yes. `prepareSkill` returns before binding, `finishSkill` returns when it finds no pending entry, and nothing else reaches activation.
- Does recovery need a marker change? No. Markers carry the family, IDs, required operations and scopes, never a skill name.
- What happens to an epoch an older build started from `ce:review`? It restores to `waiting`. Only real receipts can complete it, so a report-only session stays `waiting` until it ends. A new session starts clean, because markers live in the session transcript. Documented as an upgrade note.
- Do Pi or Claude Code have their own mapping? No. Neither registers a guard.

### Deferred to Implementation

- Whether the per-name required-operation assertions live in the existing activation tests or in a new `describe.each`.

## Implementation Units

- [ ] **Unit 1: Allowlist-only normalization**

**Goal:** Only allowlisted names activate. Every other skill load is a no-op.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- `normalizeSkill` returns a canonical guard skill only for an own-key match in the alias table. The alias table gains `systematic:ce:work`. Every other bounded string returns undefined. Invalid args behave as they do today.
- `prepareSkill` and `finishSkill` are unchanged.

**Execution note:** Test-first. The replaced fallback test and the new no-op tests must fail on today's code.

**Patterns to follow:**
- The existing activation tests for `ce:work` and `git-commit-push-pr` in the same file.

**Test scenarios:**
- Happy path: `ce:brainstorm` and `ce:review` in an inactive session leave status `inactive / no-active-epoch`. Assert no epoch, no progression markers, no seed deferrals, and an unchanged runtime policy. This replaces the fallback pin.
- Happy path: each of the six allowlisted names, through `skill` and `systematic_skill`, activates the expected family. The unit's `requiredOperations` equal that skill's literal list.
- Edge case: an other skill load mid-`work` epoch with a completed unit starts no new unit and emits no markers. Status before equals status after.
- Edge case: an other skill load during an active shipping epoch causes no family conflict and emits no markers.
- Edge case: an other skill load in protected, waiting, rejected and unavailable states leaves state and cause unchanged.
- Edge case: skill names `constructor`, `toString` and `__proto__` activate nothing.
- Edge case: an allowlisted load whose output exceeds 32 KB still activates.
- Edge case: a session that only loads `ce:review` and then calls `systematic_workflow_start` is rejected with `no-active-epoch` and stays `inactive`.
- Regression: a before-hook naming `ce:work` and an after-hook naming `git-commit` for the same callID still record `call-lifecycle-mismatch`.

**Verification:**
- The guard and workflow-guard unit suites pass.
- Restoring the fallback by hand fails the no-op tests. Deleting a policy row by hand fails the required-operations assertion for that name.

- [ ] **Unit 2: Integration coverage for activation size and other skill loads**

**Goal:** Keep the real-host proof that a large allowlisted load activates, and add a real-host proof that a large other skill load does not.

**Requirements:** R1, R2

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/integration/skill-delivery.test.ts`

**Approach:**
- Retarget scenario (f) to `ce:work`, padded past 32 KB with filler in the skill tool's `arguments` (`ce:work` substitutes `$ARGUMENTS` once). The guard's after-hook sees the host preview, which stays above 32 KB.
- Add a negative scenario: loading `ce:plan` produces no epoch marker, and status stays `inactive`.
- Update the header comment and the `CE_PLAN` comment to match.
- Integration runs use the mandatory PID-diff reaping shape.

**Test scenarios:**
- Integration: a padded `ce:work` load over 32 KB produces an `epoch` `started` marker on the pinned host.
- Integration: a `ce:plan` load produces no epoch marker, and status reads `inactive`.

**Verification:**
- The skill-delivery suite passes on the pinned host, and no opencode processes are left behind.

- [ ] **Unit 3: Documentation**

**Goal:** The docs match allowlist-only activation and its limits.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `docs/solutions/integration-issues/workflow-guard-skipped-skills-over-32kb-2026-09-26.md`

**Approach:**
- `ARCHITECTURE.md`:
  - The hook bullet says activation happens in the tool after-hook, and only for allowlisted skills.
  - The receipt-backed guard paragraph names the three skills.
  - Under known limits:
    - activation covers skill-tool loads only, not reading a skill file directly or running a slash command;
    - an older registration loaded alongside still maps unknown skills to `ce-work`, so the merged prompt marker shows the most restrictive state, `waiting`, while it is loaded;
    - a plugin that rewrites `args.name` between hooks can suppress activation.
- Solution doc: the test now pads an allowlisted skill, and only allowlisted loads activate.

**Test scenarios:**
- Test expectation: none -- documentation only.

**Verification:**
- Content-integrity and markdownlint are clean.

## System-Wide Impact

- **Interaction graph:** Only the skill-tool before- and after-hooks change. The operation, transform and event hooks are unchanged.
- **API surface parity:** Pi and Claude Code have no guard.
- **Unchanged invariants:**
  - Marker protocol v2.
  - Receipts.
  - Required operations for allowlisted skills.
  - The core family table.
  - Pairing of allowlisted skill calls.
- **Behaviour users may notice:**
  - `resolve-pr-feedback`, `test-driven-development`, `reproduce-bug`, `ce:review` and other skills no longer start a guarded epoch.
  - `lfg`'s `ce:review` step no longer reopens a unit.
  - The PR description says so.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A workflow that relied on an unknown skill to start enforcement loses it | Only the three allowlisted workflows were designed to be guarded, as the 2026-07-25 plan specified. Called out in the PR. |
| An older registration loaded alongside keeps the fallback | Documented limit. The merged marker shows `waiting` until the old build is removed. |
| An epoch from a pre-upgrade `ce:review` lingers as `waiting` | It lasts only for the rest of that session. A new session starts clean. Upgrade note in the PR. |
| A user skill named `git-commit` activates shipping | Same as today. The allowlist is narrower than the fallback it replaces. |
| A failed snapshot can still disable an inactive session | Out of scope, tracked in #1105. |

## Sources & References

- Issue: #1096
- Follow-ups: #1105, #1099. #1106 tracks the separate PR for skill names that don't resolve.
- Prior plan: `docs/plans/2026-07-25-001-feat-receipt-backed-workflow-guard-plan.md`. It specifies that unrelated skill loads do nothing.
