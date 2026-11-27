---
title: Admit a research or review hazard into a plan only if it bites at the current pin, and name the backstop when you decline it
date: 2026-11-27
category: workflow-issues
module: ce-brainstorm-to-ship-pipeline
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A plan is growing past the size the request implies, or has more units than the feature has behaviours"
  - "Several research or review lanes each report a hazard the plan must handle"
  - "A proposed hazard fix adds a new mechanism where the system already has a gate covering the same window"
tags: [plan-scope, plan-proportionality, research-lanes, document-review, backstops, scope-creep, ce-plan, deepen-plan]
---

# Admit a research or review hazard into a plan only if it bites at the current pin, and name the backstop when you decline it

## Context

The ask in fro-bot/agent#2262 was to let a run resume a subagent it had dispatched itself. The first plan reached 477 lines and six units. It added a wire-capture unit with a stop rule, per-child execution numbers on every settle writer, a four-part reconcile settle, and a real-host test that needed a local-plugin harness change and a CI workflow edit.

Several research and review lanes produced it: past-work, repo research, spec-flow, an external plan reviewer and document-review personas. Each lane found a hazard and each was folded in. No one asked whether it bites at the pinned OpenCode version, given the backstops that already exist. The shipped change was two behavior changes (guard admission and the ledger reopen) plus supporting wiring and tests, from a 129-line plan.

The plan was rejected twice:

> "this feature does not require any changes other than mechanical, why would CI be updated?"
>
> "the ask is subagent resume, what is so large that it needs such extensive planning"

The scope concern was also put this way:

> "this happens often with Systematic workflows where the scope is blown out of proportion in relation to the feature being designed"

## Guidance

1. **State the minimal change first**, in one or two sentences, before any lane runs.
2. **Admit a hazard only if it bites at the current pin.** Ask whether it occurs at the targeted version, whether an existing gate already covers its window, and what the plan loses without it. Apply this where lane output is synthesized, not only at first draft.
3. **Name the backstop when you decline.** "Declined: the directory stability gate holds release while any session is active or an inbox item is queued" is a decision a reviewer can check. A silent omission is not.
4. **Treat lane count and plan size as a stop signal.** When either outruns the ask, stop and cut before folding in more.

### The skill gap

None of the skills asks whether a hazard bites at the current pin given the existing backstops:

- `skills/ce-plan/SKILL.md:41` (`4. Right-size the artifact`) sizes the artifact, not the set of hazards in it.
- `skills/ce-plan/SKILL.md:474` (`3.7 Anti-Expansion`) defers known but tangential work. A hazard inside the feature's own scope is not tangential.
- `skills/document-review/references/synthesis-and-presentation.md:108-111` defaults a finding with an executable `suggested_fix` to Apply when the personas are silent on action.
- `skills/deepen-plan/SKILL.md:349-354` lists allowed changes, including "Expand system-wide impact, risks, or rollout treatment where justified" (`:354`). The text does not say what justifies it.

Each rule is reasonable alone. Together, lanes add and the synthesis step has no reason to subtract.

## Why This Matters

Each hazard looks cheap alone, but the sum made the plan unreviewable and reached the repository's CI for a change called mechanical.

## When to Apply

A plan is bigger than the ask implies, or several lanes each report a must-handle hazard.

## Examples

What each extra item in the 477-line plan was, and what covered it. The record does not tie each hazard to one backstop, so this mapping is a judgement from the shipped design, except where noted.

- **Wire-capture unit with a stop rule.** Reading the upstream tool source at the two pinned versions gave the order of events (progress before prompt), so no capture was needed.
- **Per-child execution numbers on every settle writer.** A report notice on this OpenCode line carries only the child session id and state, so the numbers had nothing to match against. The directory stability gate holds release while any session is active or an inbox item is queued, and the parent is busy during an in-flight resume. The same gate was named as the backstop when a review finding about a stale reconcile snapshot was declined.
- **Four-part reconcile settle.** Same gate. Reconcile stayed as it was, and one affected case, a deeper entry whose resume call fails, got a stream-side settle.
- **Real-host test with a harness change and CI edit.** Replaced by a real-binary test in the existing plugin integration suite. No workflow changed.

## Related

Each is complementary and acts at a different point from this one.

- [Size a skill refresh to the ask](./size-a-skill-refresh-to-the-ask-2026-10-25.md): cuts unrequested machinery after it is built.
- [Truth reset: narrow initiatives outperform bundled ones](./truth-reset-scope-split-20260417.md): reviewer convergence on "overscoped" as a scope signal.
- [Stop patching after a second review round](./stop-patching-after-second-review-round-2026-10-15.md): cuts scope once fixes break each other.
- [Risks-table rows must enforce as spec checks](./risks-table-rows-must-enforce-as-spec-checks-2026-05-18.md): a row in the plan must be checked, while this doc says what earns the row.
- [Iterative Oracle plan review loop](./iterative-oracle-plan-review.md): holds the fix-each-finding step this rule qualifies.
