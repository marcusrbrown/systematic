---
title: "fix(skills): admit a lane hazard into a plan only if it bites at the current pin"
type: fix
status: active
date: 2026-11-27
---

# fix(skills): admit a lane hazard into a plan only if it bites at the current pin

## Overview

The minimal change is a short admission rule at the four places where planning and review fold lane output into a plan. A hazard enters the plan only if it occurs at the current pin, given the backstops that already exist. A declined hazard is recorded with the backstop that covers it. A contract test pins the rule at each site.

## Problem Frame

`docs/solutions/workflow-issues/admit-a-research-hazard-only-if-it-bites-at-the-pin-2026-11-27.md` records the failure. For a two-behavior change, every lane's hazard was folded in, and the plan reached 477 lines with CI and harness edits. Each skill has a rule nearby, but none of them asks whether a hazard occurs at the pin:

- ce:plan's 3.7 handles only out-of-scope tangential work.
- The document-review tie-break defaults an executable fix to Apply.
- deepen-plan and ce:plan auto deepening allow risk expansion "where justified" without saying what justifies it.

## Requirements Trace

- R1. ce:plan states the minimal change in one or two sentences before Phase 1 research.
- R2. ce:plan applies the admission test when it consolidates research (1.4) and flow findings (1.5).
- R3. ce:plan's auto deepening and deepen-plan apply the same test as the meaning of "where justified".
- R4. In document-review, a finding whose fix adds a mitigation (a new mechanism, unit, requirement or test) defaults to Apply only if it passes the test, whatever its autofix class. Otherwise it defaults to Skip and names the backstop. Mechanical fixes such as wrong counts or stale references are not hazards and stay as they are.
- R5. A declined hazard appears in the plan's Risks table, with the backstop as its mitigation.
- R6. A contract test pins the rule and its placement at every site.

## Scope Boundaries

- No change to ce:review, ce:brainstorm, lfg or slfg, or how lanes are dispatched.
- No scoring, counters or new phases. The rule is instruction text only.
- 3.7 Anti-Expansion stays as it is. It still covers tangential work, and the new rule covers hazards inside the scope.

## Context & Research

### Relevant Code and Patterns

- `skills/ce-plan/SKILL.md`: Phase 0.7 ends before `### Phase 1: Gather Context`. Section `1.4 Consolidate Research` is a "Summarize:" list. Section `1.5` ends with "Add only the flow details that materially improve the plan".
- `skills/ce-plan/references/deepening-workflow.md`: in `5.3.7 Synthesize and Update the Plan`, the interactive branch integrates only accepted findings. Auto mode has no matching gate. The `Allowed changes:` item is "Expand system-wide impact, risks, or rollout treatment where justified".
- `skills/deepen-plan/SKILL.md`: the same `Allowed changes:` item, in `### Phase 5`.
- `skills/document-review/references/synthesis-and-presentation.md`: in `3.5b Deterministic Recommended-Action Tie-Break`, when personas say nothing on action, a finding with a `suggested_fix` gets `Apply`.
- `tests/unit/metacogs-wiring-contract.test.ts` is the pattern to follow: exact text constants, a `once()` helper that asserts exactly one occurrence, and an `ordered()` helper that asserts placement against named anchors. It already pins the metacogs clarifiers in `deepening-workflow.md` and deepen-plan Phase 5. New text must not land between the conflict bullets and those clarifiers.

### Institutional Learnings

- `docs/solutions/workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md`: delete unrequested machinery rather than harden it.
- `docs/solutions/best-practices/wire-an-optional-companion-skill-into-a-workflow-skill-2026-11-16.md`: pinning a short sentence verbatim is right when the sentence is the feature. A text pin does not prove the agent complies.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`: a body-only edit leaves the registry unchanged.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "skills/ce-plan, skills/deepen-plan, skills/document-review, agents/document-review/scope-guardian-reviewer.md",
  "freshness": { "vcs_reference": "a75c237f15e275b920a429ebef6962a7e16f7903" },
  "budget": { "max_search_passes": 3, "max_candidate_inspections": 10, "exhausted": false },
  "candidates": [
    {
      "path_or_symbol": "skills/ce-plan/SKILL.md#3.7 Anti-Expansion",
      "description": "routes known tangential work outside the confirmed scope to Deferred to Separate Tasks",
      "disposition": "insufficient",
      "insufficiency_reason": "A neighbouring rule that stays unchanged; it covers out-of-scope work, not hazards inside the scope."
    },
    {
      "path_or_symbol": "skills/ce-plan/SKILL.md#1.4 Consolidate Research and 1.5 Flow and Edge-Case Analysis",
      "description": "the points where lane output is folded in, with no admission test",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/ce-plan/references/deepening-workflow.md#5.3.7 Allowed changes",
      "description": "auto mode integrates findings; 'where justified' is undefined",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/deepen-plan/SKILL.md#Phase 5 Allowed changes",
      "description": "the same undefined 'where justified'",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/document-review/references/synthesis-and-presentation.md#3.5b tie-break",
      "description": "a finding with an executable suggested_fix defaults to Apply when personas are silent",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "agents/document-review/scope-guardian-reviewer.md",
      "description": "challenges complexity against stated goals after the draft exists",
      "disposition": "insufficient",
      "insufficiency_reason": "Post-hoc and goal-anchored; it does not test whether a hazard occurs at the pin or name a covering backstop."
    }
  ]
}
```

## Key Technical Decisions

- **One sentence, the same at every site:** "Admit a hazard only if it bites at the current pin and no existing backstop covers it; otherwise decline it and name the backstop." Each site may add one site-specific clause after it. The contract test pins this sentence exactly, once per site, by slicing each site's section with `ordered()`, so ce:plan's two sites (1.4 and 1.5) are counted separately.
- **A declined hazard goes in the Risks table.** The row is the hazard, and its mitigation is the named backstop. It does not go under Deferred to Separate Tasks, which is for work someone will do later. A covered hazard needs no later work.
- **document-review applies the test at the start of 3.5b, before action selection.** It covers every finding whose fix adds a mitigation, including `gated_auto` and `manual` findings that would otherwise map to Apply. A failing finding goes to Skip with its backstop named, and it never reaches the silent `safe_auto` path. The order Skip > Defer > Apply and the no-fix downgrade are unchanged for findings that pass.
- **The user's choices take precedence.** In interactive deepening and document-review walkthroughs, an explicit user acceptance overrides the default.
- **Upstream divergence.** All three skills are already marked as derived in `ATTRIBUTIONS.md`. No pin or attribution edit is needed. A future upstream refresh must re-apply this rule on top of upstream's diff.

## Implementation Units

- [ ] **Unit 1: Rule text at the four sites**

**Goal:** Add the admission rule where lane output enters a plan.

**Requirements:** R1-R5

**Dependencies:** None

**Files:**

- Modify: `skills/ce-plan/SKILL.md`, `skills/ce-plan/references/deepening-workflow.md`, `skills/deepen-plan/SKILL.md`, `skills/document-review/references/synthesis-and-presentation.md`
- Test: `tests/unit/hazard-admission-contract.test.ts`

**Approach:**

- **ce:plan:** add one sentence just before `### Phase 1` that states the minimal change. Add the rule as the closing item of 1.4 and of 1.5.
- **Deepening workflow and deepen-plan:** extend the "where justified" item with the test. In 5.3.7, give auto mode the same gate that interactive mode gets from the user.
- **document-review:** apply the test at the start of 3.5b, before the persona-to-action mapping, to findings whose fix adds a mitigation.
- Keep each addition to one or two sentences. Do not use harness-specific names or strings that content-integrity bans.

**Execution note:** Write the contract test first.

**Patterns to follow:** `tests/unit/metacogs-wiring-contract.test.ts` (`once`, `ordered`).

**Test scenarios:**

- Happy path: the exact rule sentence appears once in each site's section: ce:plan 1.4, ce:plan 1.5, deepening-workflow 5.3.7, deepen-plan Phase 5, and document-review 3.5b ahead of the persona-to-action mapping.
- Happy path: ce:plan has the minimal-change sentence between the end of Phase 0.7 and `### Phase 1`.
- Edge case: the existing metacogs contract assertions still hold, because the new text sits outside the regions those assertions check.
- Error path: the rule text contains no string banned by content-integrity.

**Verification:**

- The new contract test and `tests/unit/metacogs-wiring-contract.test.ts` pass.
- `bun scripts/content-integrity.ts` is clean.
- `bun run claude-code:build` succeeds.
- `bun run surfaces:affected --run` and then `bun run surfaces:drift` show no generated diff.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A text pin does not prove an agent follows the rule. | Accepted. The behaviour shows up in the next real plans, and adding an eval would be the machinery this rule exists to prevent. |
| The rule could suppress a real hazard. | It declines only when a named backstop covers the hazard, and that backstop sits in the Risks table where a reviewer can check it. |

## Sources & References

- Learning: `docs/solutions/workflow-issues/admit-a-research-hazard-only-if-it-bites-at-the-pin-2026-11-27.md`
- Related PRs: #1547
- Related past work: `docs/plans/2026-06-04-002-feat-merge-upstream-brainstorm-plan-plan.md`, recorded as completed. It added the 3.7 anti-expansion rule for tangential work. This plan adds the in-scope hazard test.
