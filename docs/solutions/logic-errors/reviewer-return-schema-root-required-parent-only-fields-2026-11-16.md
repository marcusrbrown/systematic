---
title: A reviewer schema rooted at the parent record required fields that the screen rejects
date: 2026-11-16
category: logic-errors
module: ce-review
problem_type: logic_error
component: tooling
symptoms:
  - "The schema in a reviewer's prompt required fields that `screen` rejects"
  - "An exit 1 from `screen` printed one line that named only the first failing path"
  - "The parent dispatched improvised subagents named like `Correct review schema fields` to repair a rejected return"
  - "A review of one pull request ran 21 dispatches and 10 `screen` calls in 713 seconds"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [ce-review, json-schema, reviewer-return, screen, rejection-report, generated-schema, repair-loop]
---

# A reviewer schema rooted at the parent record required fields that the screen rejects

## Problem

`ce:review` inlined `skills/ce-review/references/findings-schema.json` into every reviewer prompt. Its root `$ref` points at the parent's record, not at the payload a reviewer returns. The two shapes disagree: the parent record requires fields that the reviewer payload must not carry, and `screen` rejects any payload that carries them. A reviewer that followed the schema root literally was rejected, and one that followed the prose rule passed, so the prompt and the validator disagreed. Rejected returns met a one-line diagnostic and no defined recovery, so the parent dispatched repair subagents, and unattended reviews paid for each round trip.

## Symptoms

- A return that carried a parent-owned field got `dispatch_outcome: "malformed"`, although the schema in the prompt listed that field as required. `screen` closes the reviewer return to unknown keys (`skills/ce-review/references/findings-schema.json:350-351`, `additionalProperties`). The parent record requires `harness` and `dispatch_outcome` (`skills/ce-review/references/findings-schema.json:406-413`). A parent finding requires `disposition` (`skills/ce-review/references/findings-schema.json:297-309`).
- Exit 1 from `screen` wrote one stderr line, the persisted rejection reason. That reason names the first failing path only, for example `findings.0.severity`. The reason is built from the first projected issue (`src/lib/review-pipeline.ts:258-265`, `wholePayloadRejection`).
- The parent dispatched follow-up agents to repair returns, for example `Correct review schema owner` in run 43651124812 (fro-bot/agent#2213, first review). The logs hold titles but no tool output, so they do not show which keys were rejected.
- Run 43651124812 was the slowest of 25 sampled runs: 713 s of agent time, 21 dispatches (13 initial and 8 follow-up) and 10 `screen` calls. Across the sample, 29 of 200 dispatches (14%) were follow-ups, which were validators or schema repairs. The sample predates the fix, and no after-change sample was taken.

## What Didn't Work

- **Prose next to the schema.** The reviewer template already said that the parent adds `harness`, `dispatch_outcome` and `disposition` and that the reviewer must not invent them (the rule is in the template at [`6132c285`](https://github.com/marcusrbrown/systematic/blob/6132c285/skills/ce-review/references/subagent-template.md), the commit before the fix). The schema in the same prompt required those fields. A reviewer could not satisfy both.
- **A one-line, first-path rejection.** The parent saw one fault per `screen` call, and had no sanctioned way to act on it.

## Solution

The fix shipped in [#1422](https://github.com/marcusrbrown/systematic/pull/1422), as four parts. Together they give the reviewer one contract that the validator enforces, and one recovery path for a rejection.

1. **A reviewer-rooted view of the schema, generated from the same source.** `generateReviewerReturnSchemaContent` re-roots the generated findings document at the reviewer return and keeps only the definitions that root reaches (`scripts/generate-review-artifact-schema.ts:217-255`). The committed view roots at `subAgentReturn` (`skills/ce-review/references/reviewer-return-schema.json:5`). It is registered as a generated surface, so a drift gate covers it (`scripts/lib/generated-surfaces.ts:128`). `findings-schema.json` keeps its parent-record root (`skills/ce-review/references/findings-schema.json:5`, `parentRecord`) because it also describes the records the parent persists. The reviewer template's `{schema}` slot now takes the view (`skills/ce-review/references/subagent-template.md:139`). Tests check that the view carries no parent-owned record or field and that its definitions match the full schema byte for byte (`tests/unit/generate-review-artifact-schema.test.ts:189-224`). Because the view is derived from the Zod source that `screen` parses with, the two cannot drift without a gate failing.
2. **A populated example the screen admits.** The template carries one `<example-return>` payload (`skills/ce-review/references/subagent-template.md:35-63`) and says the payload is exactly the reviewer return shape, with the parent-owned fields rejected (`skills/ce-review/references/subagent-template.md:29`). A test extracts that example and runs it through the packaged `screen`; it must exit 0 and admit one finding (`tests/unit/ce-review-reviewer-contract.test.ts:122-129`, `packagedScreen`). A schema states what is allowed, and the example shows one return that passes. Other tests check that `screen` rejects a payload that carries any parent-owned field (`tests/unit/ce-review-reviewer-contract.test.ts:213-244`).
3. **A bounded report on every rejection.** Exit 1 now prints one JSON object that holds the helper's own malformed result and a `rejection` report (`src/ce-review-validator.ts:255-262`, `formatScreenRejectionOutput`). A schema rejection lists every fault in one pass: the full `issue_count`, at most eight `{path, code}` entries, the allowed values for a closed set, and how many entries were left out (`src/lib/review-pipeline.ts:187-204`, `ScreenRejectionReport`). The report holds no payload value, no unrecognized key name and no issue message, so it is safe to quote back to the reviewer (`skills/ce-review/references/pipeline-invocation.md:138-182`). A probe table pins each rejection case (`tests/unit/screen-rejection-probes.ts`).
4. **One same-session re-ask, and no repair agents.** After the first exit 1 the parent may resume the same reviewer session once, quoting the `rejection` report and the return contract. A second exit 1 is final. The parent never edits a rejected payload and never dispatches a correction, repair or replacement agent (`skills/ce-review/SKILL.md:574-593`). Each persona ends with one terminal result (`skills/ce-review/references/pipeline-invocation.md:200-238`). The cap of two returns and two screens bounds what a bad reviewer can cost, and a defined recovery removes the reason for the parent to invent one.

## Related Issues

- [Unattended ce:review cost follows the prompt contract, not the diff](../workflow-issues/unattended-ce-review-cost-follows-the-prompt-contract-2026-11-16.md): the cost data for these runs, and the other causes of review cost.
- [Pin the review scope once and fingerprint it](../best-practices/pin-the-review-scope-once-and-fingerprint-it-2026-11-16.md): the sibling change in the same release, applied to the reviewer's input instead of its output.
- [An artifact contract with no validated write path has no conforming producers](../best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md): the earlier rule that a producer-side contract needs a validated write path.
- [A per-reviewer cap reused as a run-level cap made large ce:review runs die at merge](./per-reviewer-cap-reused-as-run-level-cap-2026-10-22.md): another definition used at the wrong layer of the same pipeline.
- Implementation plan: [`docs/plans/2026-11-15-002-feat-proportional-unattended-ce-review-plan.md`](../../plans/2026-11-15-002-feat-proportional-unattended-ce-review-plan.md).
