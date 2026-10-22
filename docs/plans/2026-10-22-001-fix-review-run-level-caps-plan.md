---
title: "fix: Let a ce:review run that prepare accepts finish past 32 surviving findings"
type: fix
status: active
date: 2026-10-22
---

# fix: Let a ce:review run that prepare accepts finish past 32 surviving findings

## Overview

The `ce:review` validator pipeline caps its run-level sets with `MAX_FINDINGS` (32). That constant is the per-reviewer admission bound. The coverage lists are capped with `MAX_PERSONAS` (64). A run with more than 32 surviving findings, or more than 32 declined decisions, fails at `merge`, and in a large file group it already fails at `prepare`. The CLI then prints only `ce-review-validator: internal error in <phase>`.

This plan gives run-level sets their own bounds, derived from what the upstream phase can actually emit. Prepare and merge stop throwing. Schema rejections report bounded `path code` lines. It also fixes blank risk and gap strings, which break finalize independently of any cap.

## Problem Frame

Issue #1197 shows the failure. A 10-reviewer review of a diff of about 14k lines prepared 51 surviving findings. Every candidate-group member was declined, and `merge` exited 1 with the generic internal error. The underlying error was a Zod `too_big` on `merged_findings` and `validator_requests`. The never-bypass rule forbids hand-assembling a merged set, so the run cannot produce a `review-summary.json`.

Oracle confirmed the root cause and reproduced it in memory:
- 32 singletons merge.
- 33 or 51 singletons throw.
- 34 survivors on one file throw in `prepare`.

Flow analysis found three more boundaries that break accepted runs:
- **Disagreement facts:** the aggregate overflows at 33 declined findings.
- **Coverage lists:** they grow with findings or reviewers but are capped at 64.
- **Blank risk and gap strings:** screen, prepare and merge accept them, but the artifact coverage schema rejects them.

## Requirements Trace

- **R1.** Any run within the run-level capacity completes through `prepare`, `merge`, validator reconciliation, `finalize` and artifact validation without a cap rejection. The capacity is 2048 surviving findings, the same as what `prepare` admits.
- **R2.** Per-reviewer bounds stay at 32 and persona bounds stay at 64 wherever the set really is per reviewer or per persona.
- **R3.** Each run-level bound is at least as large as the largest output of the upstream phase that feeds it, so no new boundary appears one phase later.
- **R4.** The aggregate of disagreement facts has a budget. A run that exceeds it gets a named rejection, not a schema throw.
- **R5.** Blank or whitespace-only reviewer risks and gaps never fail finalize.
- **R6.** `prepare` and `merge` never throw on output-schema failure. Every schema rejection prints a fixed context line, at most 8 `path code` lines, and an overflow count. It never prints a Zod message, input value, stack or issue object. `internal error` is reserved for faults that are not schema failures.
- **R7.** Committed generated surfaces match the source: the review-summary and review-pipeline JSON Schemas and `validate-review.mjs`. The Claude Code bin builds with the new contract.
- **R8.** The skill tells the orchestrator to dispatch validators in bounded batches. Validator failure semantics agree between `SKILL.md` and `validator-template.md`.

## Scope Boundaries

- No change to reviewer dispatch, screen admission, candidate grouping or merge adjudication logic, beyond the facts budget check.
- The 16 MiB aggregate stdin byte cap keeps its value. Only its message changes, to state the limit.
- The schema version stays 1. Old artifacts remain valid.
- Screen's rejection text is not changed. It is persisted into `rejected_summary.reason`, and per-reviewer bounds keep screen from overflowing.
- `findings-schema.json` does not change. It describes per-reviewer returns.

### Deferred to Separate Tasks

- **`declined_merges` has no producer.** `finalizeReview` never sets it, yet `skills/ce-review/references/synthesis-artifact-contract.md` tells the parent to write it, which never-bypass forbids. This predates #1197. This plan raises the cap at the schema level only.
- **File-based envelope assembly for very large runs.** The skill passes envelopes through a heredoc, so the model's output size limits practical run size well before 2048.

## Context & Research

### Relevant Code and Patterns

- `src/lib/review-artifact-schema.ts` declares `MAX_FINDINGS`, `MAX_PERSONAS`, `CoverageSchema` and `ReviewArtifactSchema`. The run-level product is already inlined for the ledger and dispositions.
- `src/lib/review-pipeline-contract.ts` holds the prepare, adjudication, merge, validator-lifecycle, plan-assessment, report-queue and finalize envelopes. `DisagreementFactsSchema` serves both one decision and the aggregate. It also defines `AGGREGATE_STDIN_BYTE_CAP`.
- `src/lib/review-pipeline.ts`:
  - `PrepareOutputSchema.parse` and `MergeOutputSchema.parse` are the two throwing output parses.
  - `applyReviewAdjudication` assembles facts, including every declined reason.
  - `validateAdjudication` is the domain-rejection site.
  - `buildReviewCoverage` and `checkCoverageArrayBound` hard-code `MAX_PERSONAS`.
  - Finalize already uses `safeParse` and returns `{path, reason}`.
- `src/lib/review-return-validator.ts` already projects bounded `path code` lines, using `MAX_PROJECTED_ISSUE_LINES` = 8.
- `src/ce-review-validator.ts`:
  - `runAggregateStdinSubcommand` prints only the first issue on one line.
  - The fallback goes through `formatInternalErrorMessage`.
  - The byte-cap messages are per phase.
- `src/claude-code-validator.ts` and the `validate-review-artifact` command in `src/cli.ts` print every issue, plus an authored custom message for `custom` codes.
- `src/lib/review-artifact-path.ts` already exists and is registered. The shared projector goes there.

### Institutional Learnings

- `docs/solutions/best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md`:
  - Zod is the source of truth.
  - Regenerate committed schemas behind the drift gate.
  - Project errors to `path` and `code` only.
  - Keep a runnable validator in the consumer bundle.
- `docs/solutions/best-practices/re-verify-carried-state-at-phase-boundaries-2026-09-15.md`: raising caps must not weaken re-derivation, exact set-equality joins, or fail-closed handling.
- `docs/solutions/best-practices/schemas-need-adversarial-probes-not-just-compilation-2026-08-16.md`: probe every changed collection at its bound and one past it, and assert the specific cause.
- `docs/solutions/best-practices/entry-point-scope-decides-what-a-plugin-bundle-can-ship-2026-08-24.md`: verify the emitted Claude Code bin from a foreign directory, with exit codes.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: a mutation that fails no test is a finding.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/review-*.ts, src/ce-review-validator.ts, src/claude-code-validator.ts, src/cli.ts artifact path, scripts/generate-*.ts, skills/ce-review, tests/unit review and validator suites",
  "freshness": {
    "vcs_reference": "b8dfb1a155da9a85ba4c73314bd8ff77148ad422"
  },
  "budget": {
    "max_search_passes": 5,
    "max_candidate_inspections": 12,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/review-artifact-schema.ts MAX_FINDINGS/MAX_PERSONAS",
      "description": "Per-reviewer and persona constants; the run-level product is already inlined for the ledger and dispositions",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "ReviewArtifactSchema, CoverageSchema, DeclinedMergeSchema, SynthesizedFindingFieldsSchema",
      "description": "Persisted run-level arrays still capped at 32 or 64",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/review-pipeline-contract.ts prepare/adjudication/merge/validator/plan-assessment/report-queue schemas",
      "description": "Wire contracts that reuse the per-reviewer cap for run-level sets",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "review-pipeline.ts buildReviewCoverage/checkCoverageArrayBound",
      "description": "Runtime coverage bound hard-coded to MAX_PERSONAS",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "review-pipeline.ts PrepareOutputSchema.parse and MergeOutputSchema.parse",
      "description": "The only throwing output-side schema parses that can overflow",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/ce-review-validator.ts runAggregateStdinSubcommand and formatInternalErrorMessage",
      "description": "First-issue input projection and the internal-error fallback",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/review-return-validator.ts validateReviewReturnValue / MAX_PROJECTED_ISSUE_LINES",
      "description": "Existing bounded multi-line path/code projection",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/claude-code-validator.ts and src/cli.ts validate-review-artifact",
      "description": "Artifact validators that print every issue",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "AGGREGATE_STDIN_BYTE_CAP + readBoundedStdin",
      "description": "Byte guard already named per phase",
      "disposition": "reuse"
    }
  ],
  "excluded_scopes": []
}
```

## Key Technical Decisions

- **Separate run-level bounds from per-reviewer ones.** `MAX_RUN_FINDINGS = MAX_FINDINGS × MAX_PERSONAS` (2048). This is what `prepare` already admits, so no new product policy is introduced. A smaller cutoff with early rejection was rejected: no measured basis supports it, and it would force legitimate reviews to restart.
- **Disagreement facts have two budgets.**
  - One decision keeps 32 (`MAX_DECISION_FACTS`).
  - The run aggregate is `MAX_RUN_DISAGREEMENT_FACTS = 2 × MAX_RUN_FINDINGS` (4096): one declined reason per decision plus one fact per input finding.
  - The budget is enforced as a named domain rejection in `validateAdjudication`, not with a Zod refinement. A custom issue would print only `custom` under the no-echo projection.
  - Merge output, finalize input and `coverage.intent_uncertainty` all use the aggregate constant.
  - A bound by construction (2048 × 33) was rejected, because it would advertise about 67k entries in published schemas.
- **Coverage bounds come from each producer.**
  - `validators` and `validator_failures` are 2048. The pipeline records exactly one lifecycle result per request.
  - `residual_risks` and `testing_gaps` are 4096, the deduped union of 64 reviewers × 64 entries.
  - `intent_uncertainty` is 4096, a verbatim copy of the facts aggregate.
  - `failed_reviewers` and `reviewers` stay 64.
  - One exported `COVERAGE_BOUNDS` object feeds both `CoverageSchema` and `checkCoverageArrayBound`, so the two cannot drift.
- **Plan-assessment results get their own budget.** `MAX_PLAN_ASSESSMENT_RESULTS` is 256. The model produces these results from the plan's requirements and units, independent of finding count. The artifact's `residual_actionable_work` and `advisory_outputs` derive only from these results, so they share the same constant.
- **Blank risks and gaps are dropped when finalize builds coverage.** A blank string carries no information, and the artifact's `ReasonSchema` already rejects it. Filtering at the producer is cheaper than loosening the persisted contract.
- **The error format depends on the rejection kind.**
  - A schema rejection prints `<context>: <reason>`, then at most 8 `path code` lines, then `… and N more` when truncated.
  - A domain rejection keeps `<reason> at <path>`.
  - Schema rejection results gain `issues` and `total`, while keeping their existing `reason` literal and `path`, so current `.reason` assertions hold.
  - One `projectZodIssues` lives in `src/lib/review-artifact-path.ts`, an existing module, so no new registration is needed.
- **Prepare and merge switch to `safeParse`.** The new reasons are `prepare output failed schema validation` and `merge output failed schema validation`. After this change those branches should be unreachable, so any hit is a named contract defect.
- **Artifact validators bound their output to 8 lines plus the existing total line.** They keep the authored `REVIEW_ARTIFACT_CUSTOM_MESSAGES`. Those messages are a closed set of author constants, not text derived from the payload, so they satisfy no-echo.
- **The byte cap stays and states its limit.** The message becomes `<phase> input exceeds the aggregate byte cap (16842752 bytes)`. Finalize carries about three copies of each finding, so a run with very large findings trips here first. That is the documented resource guard working as intended.
- **The schema version stays 1.** Widening cardinalities keeps old artifacts valid. Older external validators will reject larger new artifacts, and a doc note covers that.

## Open Questions

### Resolved During Planning

- **Run capacity.** 2048. The reasoning is in Key Technical Decisions.
- **Does `findings-schema.json` change?** No. It is the per-reviewer schema.
- **Does the Claude Code bin need a committed regeneration?** No. It builds into the gitignored `claude-code/` directory, so it is verified by building it.
- **Do registry, codemap or module-table gates fire?** No. Only file content changes, and no new `src/lib` module is added. The `src/lib/AGENTS.md` row for `review-artifact-schema.ts` still lists the new exported constants.
- **Do the existing `internal error in <phase>` tests change?** No. They force a fault in the output sink, which stays an internal error.

### Deferred to Implementation

- The exact names of the new rejection-result fields, and whether the issue list is typed as `readonly`.
- Where the running facts total is computed. It can be in `validateAdjudication`, or before assembly, as long as the path names the first decision that crosses the budget.
- The batch size for the max-scale test, which depends on the measured runtime.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

| Upstream output → downstream input | Bound after this change |
|---|---|
| screen (per reviewer) → prepare | 32 findings and 64 risks or gaps per reviewer, unchanged |
| prepare `surviving_findings` / candidate group `members` / `candidate_groups` → merge, finalize | `MAX_RUN_FINDINGS` |
| adjudication `decisions` and decision ids → merge | `MAX_RUN_FINDINGS` |
| facts: one decision | `MAX_DECISION_FACTS` (32) |
| facts: aggregate → merge output → finalize input → `coverage.intent_uncertainty` | `MAX_RUN_DISAGREEMENT_FACTS`, domain-checked at adjudication |
| `merged_findings`, `validator_requests`, finding `input_finding_ids`, lifecycle results → finalize | `MAX_RUN_FINDINGS` |
| lifecycle results → `coverage.validators`, `validator_failures` | `MAX_RUN_FINDINGS` |
| screen risks and gaps → `coverage.residual_risks`, `testing_gaps` | `COVERAGE_BOUNDS` (4096), blanks dropped |
| report queues, `pre_existing_findings` → report and artifact | `MAX_RUN_FINDINGS` |
| artifact `findings`, `declined_merges`, `applied_fixes` | `MAX_RUN_FINDINGS` |
| plan results → `residual_actionable_work`, `advisory_outputs` | `MAX_PLAN_ASSESSMENT_RESULTS` (256) |

After the change, `MAX_FINDINGS` remains only for:
- screen findings and rejected severities;
- the dispatch `input_finding_count` and `selection_surface`;
- raw and parent findings;
- the rejected-severity guard in `review-pipeline.ts`;
- one decision's facts.

A comment beside the constant lists these, so any new reuse stands out.

## Implementation Units

- [ ] **Unit 1: Run-level bounds in the contracts and artifact schema**

**Goal:** Every run-level array is bounded by a named run-level constant. Per-reviewer and persona bounds stay where they belong.

**Requirements:** R1, R2, R3, R7

**Dependencies:** None

**Files:**
- Modify: `src/lib/review-artifact-schema.ts`
- Modify: `src/lib/review-pipeline-contract.ts`
- Modify: `src/lib/AGENTS.md` (new exported constants in the `review-artifact-schema.ts` row)
- Regenerate: `skills/ce-review/references/review-summary-schema.json`, `skills/ce-review/references/review-pipeline-schema.json`, `skills/ce-review/scripts/validate-review.mjs`
- Create: `tests/unit/review-run-fixtures.ts`, a shared non-test fixture module for large runs and minimal artifacts
- Test: `tests/unit/review-artifact-schema.test.ts`, `tests/unit/review-pipeline-contract.test.ts`

**Approach:**
- Add `MAX_RUN_FINDINGS`, `MAX_DECISION_FACTS`, `MAX_RUN_DISAGREEMENT_FACTS`, `MAX_PLAN_ASSESSMENT_RESULTS` and `COVERAGE_BOUNDS` beside the existing constants. Replace the inlined `MAX_FINDINGS * MAX_PERSONAS` products with `MAX_RUN_FINDINGS`.
- Apply the bounds from the table above to the contract schemas and the artifact schema.
- Split `DisagreementFactsSchema` into a per-decision schema and an aggregate schema.
- Add the comment listing the legitimate remaining uses of `MAX_FINDINGS`.
- Rewrite the comment in the contract test that justifies the 32-decision cap. Decisions are bounded by candidate-group members, because every member must be cited.

**Execution note:** Write the boundary probes first. They must fail against the current caps.

**Patterns to follow:**
- The existing inlined run-level bounds on the ledger and dispositions in `review-artifact-schema.ts`.
- The existing per-reviewer 32/33 probes, which stay unchanged.

**Test scenarios:**
- Happy path: each changed contract array parses at its new bound. The arrays are `members`, `candidate_groups`, `decisions`, decision and merged-finding `input_finding_ids`, `merged_findings`, `validator_requests`, lifecycle results, the three report queues, `pre_existing_findings`, and plan results at 256.
- Edge case: each changed contract array rejects at bound+1 with `too_big` at its exact path.
- Happy path / edge case: each changed artifact array (`findings`, `declined_merges`, `applied_fixes`, `residual_actionable_work`, `advisory_outputs`, and both `input_finding_ids`) parses at its bound and rejects at bound+1 with the exact path. Artifact `findings` probes use the fixture module so that ledger referential integrity holds.
- Edge case: each coverage field parses at its `COVERAGE_BOUNDS` value and rejects at value+1. `validators` is a numeric maximum. `failed_reviewers` still rejects at 65.
- Edge case: one decision's facts parse at 32 and reject at 33.
- Regression: the per-reviewer probes still reject at 33, and the raw-return `residual_risks` probe still rejects at 65. The `selection_surface` and `risk_coverage` pins keep their values.
- Probes import the constants. They contain no literal 32, 2048 or 4096.

**Verification:**
- The probes fail before the change and pass after it.
- `review-schema:drift` and `ce-review-validator:drift` pass after `review-schema:generate` and `ce-review-validator:build`.
- `findings-schema.json` is byte-identical.

- [ ] **Unit 2: Pipeline behavior at run scale**

**Goal:** `prepare` and `merge` complete at run scale and never throw on output schema. The facts budget is a named rejection. Coverage uses the shared bounds and drops blank strings.

**Requirements:** R1, R3, R4, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/review-pipeline.ts`
- Regenerate: `skills/ce-review/scripts/validate-review.mjs`
- Test: `tests/unit/review-pipeline-prepare.test.ts`, `tests/unit/review-pipeline-merge.test.ts`, `tests/unit/review-pipeline-finalize.test.ts`, `tests/unit/review-run-fixtures.ts`

**Approach:**
- Replace the two throwing output parses with `safeParse`. Return typed rejections named `prepare output failed schema validation` and `merge output failed schema validation`, and include the issue list.
- In `validateAdjudication`, keep a running total of facts in decision order. A declined reason counts as one. Reject with `disagreement facts exceed run budget` at `decisions.N.disagreement_facts`, where N is the first decision that crosses the budget.
- `checkCoverageArrayBound` reads `COVERAGE_BOUNDS` and keeps its existing reason literal. `validators` stays out of the runtime table, because it equals the lifecycle-result bound. A test pins that equality.
- `buildReviewCoverage` drops blank and whitespace-only risks and gaps before deduping.

**Execution note:** Implement test-first. Start with the end-to-end chain at more than 32 survivors, which fails today at `merge`.

**Patterns to follow:**
- Finalize's existing `safeParse` and typed-rejection shape.
- The existing `AdjudicationRejectReason` vocabulary and its path conventions.
- The existing end-to-end finalize test that drives real adjudication output through `finalizeReview` and `ReviewArtifactSchema.parse`.

**Test scenarios:**
- Happy path: a run with 34 survivors in one file, from two reviewers, passes `prepare`.
- Happy path: 33 singletons merge, and so do 51.
- Integration: the real chain (screen, then `prepareReviewCandidates`, then `applyReviewAdjudication`, then `finalizeReview`, then `ReviewArtifactSchema.parse` and `FinalizeOutputSchema.parse`) completes for these runs:
  - more than 32 findings;
  - an all-declined group;
  - report-only mode with `release`-owned findings filling `queues.report_only`;
  - 65 to 200 validator requests, with more than 64 of them failed or unavailable;
  - a union of more than 64 distinct risks and more than 64 distinct gaps across two or more reviewers;
  - more than 64 distinct facts;
  - 40 plan results.
- Edge case: the aggregate facts total passes at exactly `MAX_RUN_DISAGREEMENT_FACTS`. At one more, it rejects with `disagreement facts exceed run budget` at the first decision that crosses the budget.
- Error path: a forced output-schema failure returns a rejection with issues and does not throw. Use an unparsed `prepared` with more survivors than `MAX_RUN_FINDINGS`, passed to `applyReviewAdjudication`.
- Edge case: blank and whitespace-only risks and gaps are absent from the artifact coverage, and the run completes.
- Edge case: the coverage runtime bound rejects at `COVERAGE_BOUNDS.residual_risks + 1` with `coverage array exceeds bound`. This replaces the pin on the literal 65.
- Edge case: `COVERAGE_BOUNDS.validators` is at least the lifecycle-result bound.
- Integration (scale): a run of 64 reviewers × 32 findings with realistic payloads completes. The test records finalize input bytes, which must stay under `AGGREGATE_STDIN_BYTE_CAP`, and runtime.

**Verification:**
- Every listed scenario passes.
- Removing the running-total check makes the aggregate-budget test fail.
- Removing the blank filter makes the blank-risk test fail.
- `ce-review-validator:drift` passes.

- [ ] **Unit 3: Bounded `path code` error projection**

**Goal:** Every validator subcommand reports schema rejections as a fixed line plus bounded `path code` lines. The artifact validators bound their output too. The byte-cap message states its limit.

**Requirements:** R6, R7

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/review-artifact-path.ts` (shared `projectZodIssues`)
- Modify: `src/lib/review-return-validator.ts` (use the shared projector)
- Modify: `src/lib/review-pipeline.ts` (schema rejections carry issues: prepare input, finalize output and artifact)
- Modify: `src/ce-review-validator.ts`
- Modify: `src/claude-code-validator.ts`
- Modify: `src/cli.ts`
- Regenerate: `skills/ce-review/scripts/validate-review.mjs`
- Test: `tests/unit/ce-review-validator-routing.test.ts`, `tests/unit/ce-review-validator-packaging.test.ts`, `tests/unit/validate-review-artifact.test.ts`, `tests/unit/claude-code-validator.test.ts`, `tests/unit/review-return-validator.test.ts` (or wherever the return projection is tested)

**Approach:**
- `projectZodIssues(issues, max)` returns at most `max` `{path, code}` pairs plus the total. Its callers format the lines.
- Rejection rendering depends on the kind:
  - schema rejections print the context line, the `path code` lines and the overflow line;
  - domain rejections keep `<reason> at <path>`.
- Merge and finalize input rejections print all projected issues, not only the first.
- Both artifact validators print at most 8 issue lines plus the existing total line. They keep the authored custom message for `custom` codes.
- The three byte-cap messages interpolate `AGGREGATE_STDIN_BYTE_CAP`.
- `internal error in <phase>` stays only for non-schema faults.

**Execution note:** Add the canary test first. It must fail if any value or key text reaches stderr.

**Patterns to follow:**
- The existing bounded projection in `review-return-validator.ts`.
- `REVIEW_ARTIFACT_CUSTOM_MESSAGES` as the closed allowlist for authored text.

**Test scenarios:**
- Happy path: a merge output-schema rejection prints the context line and `merged_findings too_big`. It does not print `internal error`.
- Edge case: nine or more issues print exactly 8 `path code` lines plus `… and N more`.
- Error path (no-echo): a canary string in a field value and in an unknown key name never appears in stderr. Check prepare, merge, finalize and both artifact validators.
- Happy path: a domain rejection still prints `<reason> at <path>`.
- Regression: the exact-format input pins in the routing test are updated to the new multi-line form. Substring and packaging checks still pass.
- Regression: the forced sink fault still prints `internal error in <phase>`.
- Happy path: the byte-cap overflow prints the cap in bytes and exits 1.
- Integration: an artifact with 9 or more issues, validated through `systematic validate-review-artifact` and through the built Claude Code bin from a foreign directory, prints at most 8 issue lines plus the total. Each exits 1.

**Verification:**
- Every listed scenario passes.
- Dropping the line bound makes the 9-or-more-issues test fail.
- The Claude Code bin builds, and the foreign-directory check exits as expected.
- `ce-review-validator:drift` passes.

- [ ] **Unit 4: Skill guidance and docs**

**Goal:** The orchestrator dispatches validators in bounded batches. The validator failure semantics agree. The docs describe the new error shape and the limits.

**Requirements:** R8

**Dependencies:** Unit 3

**Files:**
- Modify: `skills/ce-review/SKILL.md` (Stage 5b validator dispatch)
- Modify: `skills/ce-review/references/validator-template.md` (batching line; failure fallback aligned with SKILL)
- Modify: `skills/ce-review/references/pipeline-invocation.md`. Add the exit-1 error shape. Add one never-bypass line: after a byte-cap exit, do not retry identical bytes, stop visibly.
- Modify: `HARNESSES.md` or `ARCHITECTURE.md`, only where they describe validator errors or limits. Add a note that older external validators reject artifacts larger than their caps.

**Approach:**
- SKILL wording: one validator subagent per request, dispatched in bounded batches sized to what the harness handles reliably. Each batch runs in parallel and must finish before the next. Every request needs a result, and a non-answer is recorded as `unavailable`.
- Remove the template's claim that a failed validator counts as `validated: true`. State the SKILL outcome instead: the finding stays unvalidated and a lifecycle failure is recorded.
- Use no batch number. It is harness policy.

**Test expectation:** None, because this changes guidance text only. The content-integrity and markdownlint gates cover the files.

**Verification:**
- The guidance in `SKILL.md` and `validator-template.md` agrees.
- Content-integrity is clean.
- Markdownlint is clean.
- `docs:build` succeeds if `HARNESSES.md` or the docs site sources change.

## System-Wide Impact

- **Interaction graph:**
  - The skill helper `validate-review.mjs` bundles the contract, schema and pipeline modules.
  - The Claude Code bin bundles the artifact schema through `claude-code-validator.ts`.
  - The `systematic validate-review-artifact` CLI shares the artifact schema.
- **Error propagation:** every schema failure becomes a typed rejection with a bounded projection. Only real faults reach the internal-error fallback.
- **API surface parity:** all three validator surfaces use one projector: the skill helper, the npm CLI and the Claude Code bin.
- **Unchanged invariants:**
  - Per-reviewer admission stays at 32.
  - The persona bound stays at 64.
  - The byte cap keeps its value.
  - Schema version stays 1.
  - Screen's persisted rejection text is unchanged.
  - Never-bypass is unchanged.
  - Exact set-equality joins between phases are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A cap is raised in a schema but a runtime check or a downstream schema still holds the old value | The cross-phase table in this plan, one shared constant per bound, and end-to-end tests through artifact validation |
| Larger artifacts are rejected by older external validators | A doc note. Schema version stays 1, so old artifacts remain valid. |
| Very large runs hit the byte cap at finalize | Documented as the resource guard. The message states the limit. The scale test records real sizes. |
| Generated surfaces drift | Each unit regenerates the artifacts it affects. The drift gates run in the final verification. |
| Projection leaks payload text | The canary test, run against every surface |

## Documentation / Operational Notes

- Release type: patch (`fix`). Large `ce:review` runs now finish, and validator errors name the failing fields.
- The cleanup skill labels review summaries over 1 MiB as `unknown` in its preview only. Deletion eligibility is unchanged, so no action is needed.

## Sources & References

- Related issue: #1197
- Analyses, kept locally: Oracle cap design, repo research and flow analysis, in `/tmp/plan1197/` (not in the repository)
- Related code: `src/lib/review-artifact-schema.ts`, `src/lib/review-pipeline-contract.ts`, `src/lib/review-pipeline.ts`, `src/ce-review-validator.ts`, `src/claude-code-validator.ts`, `src/cli.ts`
