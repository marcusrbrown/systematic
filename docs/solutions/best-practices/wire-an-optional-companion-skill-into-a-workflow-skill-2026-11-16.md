---
title: Wire an optional companion skill into a workflow skill with a parent-only, fail-open, named, test-pinned sentence
date: 2026-11-16
category: best-practices
module: ce-skills
problem_type: best_practice
component: development_workflow
severity: medium
symptoms:
  - "A deepening conflict loaded the companion skill under the wrong namespace, as `systematic:synthesis`"
  - "A planning decision rested on an unchecked claim and the agent filed it as resolved"
  - "Prose scenarios showed skills firing that a real-host run did not load"
applies_when:
  - "A Systematic workflow skill should use a skill from another plugin when it is installed"
  - "The companion skill must stay out of subagents and out of unattended modes"
  - "Choosing how to test a skill-text edit that points at another skill"
tags:
  - skills
  - metacogs
  - companion-skill
  - fail-open
  - contract-test
  - writing-skills
  - scenario-testing
related_components:
  - testing_framework
---

# Wire an optional companion skill into a workflow skill with a parent-only, fail-open, named, test-pinned sentence

## Context

`ce:plan` and `ce:review` now use the `counterfactual` and `synthesis` skills from the separate metacogs plugin at the decision points where they fit (#1430). Without metacogs installed, both workflows behave as before. The change is one sentence or short paragraph in each of four skill files, plus a contract test. The pattern behind those sentences is reusable for any optional companion skill.

## Guidance

1. **Say it in the parent agent only.** Each sentence ends the scope at the parent: "in the parent agent only, never in a dispatched sub-agent" (`skills/ce-plan/SKILL.md:354`), "never in a reviewer or validator sub-agent" (`skills/ce-review/SKILL.md:611`). Reviewer, validator and persona templates stay free of the skill names, and a contract test asserts that (`tests/unit/metacogs-wiring-contract.test.ts:195`).

2. **Fail open.** Every sentence ends "If the skill is not available, continue unchanged." (`skills/ce-plan/SKILL.md:354`, `skills/ce-review/SKILL.md:611`, `skills/ce-plan/references/deepening-workflow.md:197`, `skills/deepen-plan/SKILL.md:335`). The precedent is `skills/lfg/SKILL.md:11`: "If not available or it fails, skip and continue".

3. **Gate by mode where the workflow can run unattended.** The `ce:review` sentence loads `synthesis` only "if it is available and the mode is interactive or autofix (never headless or report-only)" (`skills/ce-review/SKILL.md:611`). Headless ends in a fixed envelope (`skills/ce-review/SKILL.md:104`) and report-only never externalizes work (`skills/ce-review/SKILL.md:83`), so a loaded method has nowhere to go. The `ce:plan` sentence has no carve-out on purpose: in a pipeline run the flip test goes into the plan as an assumption or open question, "with or without a user to ask" (`skills/ce-plan/SKILL.md:354`). Decide per point whether the method still produces something the workflow can carry when no one is there. The contract test pins both choices (`tests/unit/metacogs-wiring-contract.test.ts:81` and `tests/unit/metacogs-wiring-contract.test.ts:171`).

4. **Name the other plugin and the bare skill name.** Say the skill "comes from the separate metacogs plugin and is not a Systematic skill", and tell the agent to load it "by that bare name through the host's skill-loading mechanism". Without that, an agent loaded `systematic:synthesis` in a prose scenario at the `deepen-plan` conflict rule. The `ce:review` sentence also says the skill is "not this stage's merge" (`skills/ce-review/SKILL.md:611`), because the stage has its own synthesis and merge steps with the same words.

5. **Say what is not a trigger.** `ce:plan`: "Do not load it when the claim is already checked or the answer is mechanical" (`skills/ce-plan/SKILL.md:354`). `ce:review`: "Rewording of one defect is not a disagreement" (`skills/ce-review/SKILL.md:611`). Test controls for each: an already-verified claim, a one-grep lookup, complementary findings, and two reviewers wording one defect differently.

6. **Pin the sentence, its placement and its clauses with a contract test.** The test checks each inserted text appears exactly once, sits in the right section and order, carries the mode clause, says the skill is not a Systematic skill, is parent-only and fails open, and adds no harness-specific tool names. It failed before the skill edits and passes after, and mutating the text, its placement or its mode limits fails it (#1430). This differs from the advice to pin rules, not wording, in [Size a skill refresh to the ask](../workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md). Here the sentence is the whole feature, four short insertions, so pinning it verbatim is cheap. For a large skill, pin the rules instead.

7. **Test wording with prose scenarios, and treat them as weaker evidence of behavior.** Fresh subagents given the skill text and a scenario are the right tool for wording, namespace and mode carve-outs (`writing-skills` RED/GREEN). They show the instructions are read as intended. Two caveats apply. How salient a skill is in a scenario can differ from real-host behavior: each scenario lists both skill descriptions up front, and three cells already fired before the edit. And the real-host replay did not establish the planning trigger. #1430 states that real-host runs of the planning trigger and of the autofix path were not covered. The replay results are in [Size a skill refresh to the ask](../workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md).

## Why This Matters

A loose "use the other skill when useful" sentence has three failure modes. The agent loads the skill in a subagent that cannot use it, loads it under the wrong namespace and fails, or loads it in a mode that cannot carry its output. Each clause above closes one of them, and each has a test.

## When to Apply

- A workflow skill should call a skill that another plugin ships, at a decision point that needs a parent agent, such as an adjudication or a claim check.
- Do not apply it to a decision whose outcome a helper computes, the user decides, or a rule fixes. #1430 reviewed other `ce:*` decision points and left those alone.

## Related

- [An eval of a multi-agent workflow must run the real system](an-eval-of-a-multi-agent-workflow-must-run-the-real-system-2026-11-16.md) covers the real-host campaign that measured these sentences and what went wrong with it.
- [Size a skill refresh to the ask](../workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md) records why this ended as a small skill edit and not a measurement campaign.
- `skills/writing-skills/SKILL.md` is the RED/GREEN workflow the scenarios follow.
