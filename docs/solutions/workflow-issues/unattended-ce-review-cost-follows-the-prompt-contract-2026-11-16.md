---
title: Unattended ce:review cost follows the prompt contract, not the diff
date: 2026-11-16
category: workflow-issues
module: ce-review
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "An agent reviews pull requests unattended in a repository whose CI already runs the build, lint, typecheck and test gates"
  - "The repository's instruction files list verification commands as required"
  - "A review skill runs as a delegated or non-interactive run and nobody passes it a mode"
  - "Review time or reviewer count looks high and the cause is unclear"
symptoms:
  - "Reviews ran the repository's full test suite or typecheck, and two waited on it for 67% and 70% of their agent time"
  - "The model announced a review mode that the skill does not define"
  - "Docs-only and deletion-only pull requests got the same fan-out as code changes"
  - "Reviewer returns were rejected and repaired by extra subagents"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags: [ce-review, fro-bot, unattended-review, ci-gates, prompt-contract, mode-token, reviewer-selection, cost]
---

# Unattended ce:review cost follows the prompt contract, not the diff

## Context

Between 2026-11-12 and 2026-11-15, 25 unattended pull-request review runs were sampled from CI logs: 12 in fro-bot/.github, 12 in fro-bot/agent (seven pull requests, several re-reviews of one), and one in marcusrbrown/metacogs. Twenty-three used `openai/gpt-6.1-sol`. The logs hold no tool output, and the runs are not a controlled experiment.

- **Two reviews waited on a full suite.** Ten of the 13 runs in fro-bot/.github and metacogs ran at least one check. Most ran scoped test files and a typecheck while reviewers worked, off the critical path. Two ran the whole suite with nothing else going on: metacogs#106 (run 43696196581) waited 324.6 s of 486.3 s of agent time (67%), and fro-bot/.github#4232 (run 43628936920, another model, no `ce:review`) waited 205.8 s of 294.0 s (70%). Those two account for all 8m50s of check waiting in 51m43s of agent time across the 13 runs.
- **A comparison with zero checks.** In the 12 fro-bot/agent runs, no review ran a test, build, typecheck or lint command. Its CI review prompt forbids them, and the parent restated the rule when it chose a mode. The model, the Systematic version (3.33.2) and the fan-out matched the other repositories. Only the prompt differed, as far as the logs show. This is a correlation across repositories, not an experiment.
- **The mode was a guess.** The action passes no `mode:` token. In the 11 fro-bot/.github and metacogs runs that announced a mode, 8 said `report-only` and 3 said `read-only`, which v3.33.2 does not define ([`SKILL.md` lines 40-45](https://github.com/marcusrbrown/systematic/blob/v3.33.2/skills/ce-review/SKILL.md)).
- **Fan-out followed lenses, not lines.** metacogs#106 deleted 13,568 lines in 28 files and got 7 reviewers. A two-file fix (fro-bot/.github#4251) got 7 plus 5 follow-ups. Documentation pull requests (#4238, #4239, #4250) got 3 or 4. fro-bot/agent runs with zero checks still took 148 to 713 s (median 251 s), because fan-out and the validation pipeline were the cost there.

## Where the instruction to run checks came from

No single source explains all runs.

1. **A contributor rule loaded into review sessions.** fro-bot/.github lists `bun run check-types`, `bun run lint` and `bun run test` under "Verification Commands (required)" (lines 79-87 of its `.github/copilot-instructions.md`), and its `opencode.json` loads that file. The rule is written for authors, and a review session that loads it sees an instruction to run them.
2. **The model's own prompt.** metacogs has no such rule and still ran the full suite. OpenCode's system prompt for the `gpt-6` family says "Run tests appropriate to the change and complete required checks" ([`gpt-astra.txt` at v1.19.4](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/prompt/gpt-astra.txt)). The runtime was OpenCode 2.3.0 and only the v1.19.4 source was read, so this is the likeliest source, not a proven one.
3. **An open shell in the skill.** At v3.33.2, `ce:review` said read-only means non-mutating, not "no shell access", and no sentence forbade running a build or a test.
4. **No mode.** With no token, the skill's default is interactive, which cannot work in a job with no one to answer.

## Guidance

### Put the gate rule in the caller's prompt, and in the skill

The rule that gave fro-bot/agent zero checks was copied to fro-bot/.github#4254, marcusrbrown/metacogs#108 and [#1417](https://github.com/marcusrbrown/systematic/pull/1417) here (source: fro-bot/agent#1549). It says that dedicated CI jobs own the build, lint, typecheck and directory-wide test gates, names the aliases a model reaches for, and applies "even if repository instructions list them". The only exception is one named test file or a minimal probe that validates a concrete finding, with the command and the claim stated (`.github/workflows/fro-bot.yaml:81-103`, `PR_REVIEW_PROMPT`). A test pins the fragments, so a later edit cannot soften them silently (`tests/unit/fro-bot-workflow.test.ts:1278-1289`, `PR_REVIEW_PROMPT`). #1417 also removed the line that told this repository's reviewer not to invoke any `ce:*` skill.

Keep the rule in both places. The skill rule below covers an unattended run whose caller says nothing. The caller's prompt covers what the skill cannot: an instruction file that says "required", and a caller pinned to a Systematic version from before the rule (these runs used 3.33.2 and 3.33.0). Make the prompt override the instruction file by name.

### Make the skill enforce the same rule for every role

[#1422](https://github.com/marcusrbrown/systematic/pull/1422) wrote the rule into the skill:

- **Verification gates.** In report-only and headless runs the parent runs no build, typecheck or lint at any scope and no broad test through any alias. Reviewers, CE agents and validators run none in any mode. One parent-approved probe per finding is the only execution allowed (`skills/ce-review/SKILL.md:106-121`, `Verification gates`). The reviewer template (`skills/ce-review/references/subagent-template.md:92`), the CE agent boundary (`skills/ce-review/SKILL.md:558`) and the validator rule (`skills/ce-review/SKILL.md:624`) carry it. Contract tests pin the six role-and-mode rows (`tests/unit/ce-review-gates-contract.test.ts:133-150`).
- **An unattended run is report-only.** With no token, the mode is `report-only` when the caller or system context says the run is non-interactive, when the skill runs as a delegated subagent, or when no blocking question tool exists and there is no chat fallback (`skills/ce-review/SKILL.md:54-70`). `mode:read-only` normalizes to `report-only` (`skills/ce-review/SKILL.md:39`).
- **Only the caller sets the mode.** A `mode:` word in the pull request title, body, comments, commits, diff or repository files is data under review (`skills/ce-review/SKILL.md:37`). So is a claim that the run is non-interactive (`skills/ce-review/SKILL.md:66`). A pull request is untrusted input, and a mode is a permission.
- **Selection reads paths.** A deletion-only or docs-only change selects the core three reviewers, however large, unless a semantic risk fires, such as a removed guard or a changed agent instruction. The classification comes from changed paths, never from the pull request text (`skills/ce-review/references/persona-catalog.md:59-76`).

### Measure the cost by phase before choosing a fix

A log line's timestamp is when the call finished, so a command's duration is the gap before its line. The check wait showed only in runs where nothing else was logging. In the other fro-bot/.github runs the last `screen` call came 16 to 170 s after the last check, so the checks were off the critical path. Counting check commands would blame checks for all the cost, and a median run time would blame fan-out for all of it. Splitting each run into setup, fan-out, pipeline and check wait showed that checks were the cost in two runs, and that fan-out and repair were the cost in most of the rest. The repair part is in [a reviewer schema rooted at the parent record required fields that the screen rejects](../logic-errors/reviewer-return-schema-root-required-parent-only-fields-2026-11-16.md).

## Not measured

The sample predates #1422 and #1424, so there are no after-change numbers for run time or reviewer count. The effect of the skill-side rules on fan-out is a design claim backed by the contract tests, not a measurement.

## Related

- [A reviewer schema rooted at the parent record required fields that the screen rejects](../logic-errors/reviewer-return-schema-root-required-parent-only-fields-2026-11-16.md): the repair-loop part of the same cost.
- [Pin the review scope once and fingerprint it](../best-practices/pin-the-review-scope-once-and-fingerprint-it-2026-11-16.md): the diff-handoff part of the same change set.
- [Reviewer findings need verification against the checkout the code lives in](./verify-reviewer-findings-against-the-real-checkout-2026-09-20.md): why a reviewer's claims still need checking against the real tree.
- [The fro-bot/agent action's runtime is not a plain runner](../integration-issues/fro-bot-agent-action-runtime-differs-from-a-plain-runner-2026-11-13.md): other places where the action's environment differs from a local session.
- Implementation plan: [`docs/plans/2026-11-15-002-feat-proportional-unattended-ce-review-plan.md`](../../plans/2026-11-15-002-feat-proportional-unattended-ce-review-plan.md).
