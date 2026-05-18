---
title: Plan Risks-table rows must enforce as discrete spec checks, not informational notes
module: ce-plan / ce-work
date: 2026-05-18
problem_type: workflow_issue
component: development_workflow
severity: medium
tags:
  - planning
  - subagent-dispatch
  - test-coverage
  - plan-rigor
  - mitigation
applies_when:
  - Writing implementation plans where the Risks & Dependencies table lists a mitigation
  - Dispatching implementation work to a subagent (fixer / systematic-implementer)
  - Reviewing subagent output before commit
---

# Plan Risks-table rows must enforce as discrete spec checks, not informational notes

## Context

When a plan's Risks & Dependencies table identifies a concrete mitigation for a risk, that mitigation has to land as a discrete, enumerated spec check in the implementation unit. Otherwise the subagent reads the plan, follows the unit-level spec to the letter, and silently omits the mitigation — because the spec did not enumerate it.

This pattern surfaced on PR #405 (SUBAGENT-STOP / Instruction Priority sync). The plan's Risks & Dependencies table had a row that said in part:

> Add a behavioral assertion in Unit 1 that calls `applyBootstrapContent` against a representative `output.system` array and asserts the rendered post-injection string still has SUBAGENT-STOP before `<EXTREMELY-IMPORTANT>`. This catches injection-side reordering bugs that pre-injection tests would miss.

The implementation unit's test spec listed four assertions — all against `getBootstrapContent()` (pre-injection). The post-injection assertion against `applyBootstrapContent` was named in the Risks table mitigation column and not echoed into the Unit's enumerated test scenarios. The subagent landed exactly what the Unit spec described: four pre-injection tests. Fro Bot caught the gap on review with the verdict line *"The gap was identified during planning, accepted as a mitigation requirement, and then dropped during implementation."*

## Guidance

When writing a plan, treat the Risks & Dependencies table as **risk identification + mitigation framing**, not as a parallel spec surface. Every mitigation that involves new code or a new test MUST also appear as a discrete enumerated bullet under the relevant Implementation Unit's *Approach* or *Test Scenarios* section. The Risks-table cell tells the reader *why* the check exists; the Unit-spec bullet tells the implementer *what to write*.

Concretely:

1. After drafting the Risks table, scan each row's mitigation column for verbs like *"add a test"*, *"assert X"*, *"introduce a check"*, *"validate Y"*.
2. For each such mitigation, find the Implementation Unit whose unit-level spec must enforce it.
3. Add a discrete bullet to that Unit's test/scenario enumeration that paraphrases the mitigation. Do not assume the subagent will cross-reference the Risks table; the unit-level spec is the single source of truth for the implementer.
4. During orchestrator audit before commit, run a quick scan: for each mitigation verb in the Risks table, grep the diff for the corresponding code or test artifact. Missing artifacts mean the mitigation dropped.

## Why This Matters

Subagents (`@fixer`, `@systematic-implementer`) are deliberately given a narrow, focused brief. They are not asked to reason across the whole plan document — that's the orchestrator's job. The Risks table sits structurally outside the per-Unit specs. A subagent reading the Risks table at all is a bonus, not a guarantee. Plans optimized for subagent execution should put mitigations where the subagent will read them: in the Unit spec.

The cost of missing a mitigation depends on its purpose:

- **Low cost**: a defensive test that would have caught a hypothetical future regression. The PR still ships; the missing test gets added in a follow-up commit or the next PR cycle.
- **High cost**: a mitigation against a known-broken edge case. The PR ships a real bug. Fro Bot or a downstream consumer catches it.

PR #405 was the *low cost* shape — pre-injection tests + the prose change still delivered the feature correctly. The missing post-injection test was a defensive guard, not a fix. But Fro Bot's review explicitly framed it as a *blocking* finding because the plan had identified the mitigation, the implementation had silently dropped it, and that mismatch erodes plan-as-contract.

## When to Apply

- **Always** for plans dispatched to `@fixer` or `@systematic-implementer`. These subagents follow the Unit spec narrowly.
- **Always** for plans that have a Risks & Dependencies table with mitigations expressible as code or test artifacts.
- **Less critical** for plans executed inline by the orchestrator — though even then, an enumerated Unit-spec bullet beats a Risks-table reference because the orchestrator will be juggling multiple Units and TODO items, and the most-recently-read text wins attention.

## Examples

### Before — Risks row carries the mitigation alone

```markdown
## Implementation Unit 1 — Prose + mechanical tests

### Test Scenarios

(a) bootstrap content contains <SUBAGENT-STOP> marker
(b) bootstrap content contains ## Instruction Priority section
(c) <SUBAGENT-STOP> appears before <EXTREMELY-IMPORTANT> in bootstrap output
(d) ## Instruction Priority appears before ## How to Access Skills

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Future refactor reorders `applyBootstrapContent` assembly silently | Add a behavioral assertion in Unit 1 that calls `applyBootstrapContent` against a representative `output.system` array and asserts the rendered post-injection string still has SUBAGENT-STOP before `<EXTREMELY-IMPORTANT>`. |
```

The subagent reads Unit 1's four scenarios and lands four pre-injection tests. The post-injection assertion in the Risks row is invisible to the focused brief.

### After — mitigation enumerated in the Unit spec

```markdown
## Implementation Unit 1 — Prose + mechanical tests

### Test Scenarios

(a) bootstrap content contains <SUBAGENT-STOP> marker
(b) bootstrap content contains ## Instruction Priority section
(c) <SUBAGENT-STOP> appears before <EXTREMELY-IMPORTANT> in bootstrap output
(d) ## Instruction Priority appears before ## How to Access Skills
(e) post-injection: calling applyBootstrapContent against a representative output.system array,
    the rendered output.system[0] still has <SUBAGENT-STOP> before <EXTREMELY-IMPORTANT>

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Future refactor reorders `applyBootstrapContent` assembly silently | Test scenario (e) in Unit 1 catches injection-side reordering bugs that pre-injection tests would miss. |
```

The mitigation is now enumerated alongside the other unit-level scenarios. The Risks row remains as the *why* but defers the *what* to the Unit spec where the subagent will actually read it.

### Orchestrator audit pattern

Before committing subagent output:

```sh
# For each verb in the Risks table mitigation column...
grep -nE 'add a test|assert|introduce a check|validate' docs/plans/<plan>.md

# ...grep the diff for the corresponding artifact:
git diff --staged | grep -E 'test\(.*applyBootstrapContent|expect\(.*applyBootstrapContent'
```

If no matches, the mitigation dropped. Add the missing artifact inline before commit, or kick back to the subagent with the gap enumerated.
