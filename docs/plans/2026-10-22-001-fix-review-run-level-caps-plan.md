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

The practical ceiling for orchestrator transport is lower than 2048. The skill re-emits `prepared`, and later the full `finalize` envelope, through a heredoc, so the model's output size binds first. The contract bound is a correctness ceiling and does not promise that a run that size is practical.

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

- **R1.** A run within the run-level capacity (2048 surviving findings, the same as what `prepare` admits) and within the aggregate stdin byte cap at each phase completes through `prepare`, `merge`, validator reconciliation, `finalize` and artifact validation. A byte-cap exit is a named rejection that states the cap.
- **R2.** Per-reviewer bounds stay at 32 and persona bounds stay at 64 wherever the set really is per reviewer or per persona.
- **R3.** Wherever an upstream bound exists, each run-level bound is at least as large as the largest output of the upstream phase that feeds it, so no new boundary appears one phase later.
- **R4.** The disagreement-facts aggregate is bounded by construction from the per-decision bound and the run capacity, so no run within capacity is rejected for facts.
- **R5.** Blank or whitespace-only reviewer risks and gaps never fail finalize.
- **R6.** `prepare` and `merge` never throw on output-schema failure, and `merge` never throws on a defect in its input data: a `prepared` echo that lacks a survivor the adjudication cites is a named rejection. Every schema rejection, including both artifact validators, has one output shape: a fixed context line, at most 8 `path code` lines, and `… and N more` when there are more. It never prints a Zod message, input value, stack or issue object. `internal error` is reserved for faults that are not schema failures.
- **R7.** Committed generated surfaces match the source: the review-summary and review-pipeline JSON Schemas and `validate-review.mjs`. The Claude Code bin builds with the new contract.
- **R8.** The skill tells the orchestrator to dispatch validators in bounded batches. Validator failure semantics and the validator return contract agree between `SKILL.md` and `validator-template.md`.
- **R9.** The byte-cap rejection states the cap in bytes (16842752) everywhere it is reported, and domain rejections keep `<reason> at <path>`.

## Scope Boundaries

- No change to reviewer dispatch, screen admission, candidate grouping or merge adjudication logic, beyond a named rejection for a `prepared` echo that lacks a cited survivor.
- The aggregate stdin byte cap keeps its value, 16842752 bytes (16 MiB + 64 KiB). Only its messages change, to state the limit. No projected-size check runs at prepare.
- The practical ceiling for orchestrator transport is lower than the 2048 contract capacity. The skill re-emits `prepared` and later the full `finalize` envelope through a heredoc, so model output size binds first. This plan does not change the transport.
- The schema version stays 1. Old artifacts remain valid.
- Screen is out of scope. Its stderr and its persisted `rejected_summary.reason` are unchanged, and per-reviewer bounds keep screen from overflowing.
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
  - `requireSurvivingFinding` (`:1431-1441`) throws when a cited input ID is missing from the `prepared` echo. The CLI maps that throw to `internal error in merge`.
  - `prepareReviewCandidates` rejects an oversized `raw_input` with the reason `aggregate payload exceeds byte cap` (around `:546-549`), a second place that reports the cap.
  - `buildReviewCoverage` and `checkCoverageArrayBound` hard-code `MAX_PERSONAS`.
  - Finalize already uses `safeParse` and returns `{path, reason}`.
- `src/lib/review-return-validator.ts` already projects bounded `path code` lines, using `MAX_PROJECTED_ISSUE_LINES` = 8.
- `src/ce-review-validator.ts`:
  - `runAggregateStdinSubcommand` prints only the first issue on one line.
  - The fallback goes through `formatInternalErrorMessage`.
  - The byte-cap messages are per phase.
- `src/claude-code-validator.ts` and the `validate-review-artifact` command in `src/cli.ts` print every issue, plus an authored custom message for `custom` codes, under `Review artifact validation failed: N issue(s)`.
- `tests/unit/ce-review-validator-packaging.test.ts` sets an explicit `60_000` test timeout on its real-execution tests (`:534`, `:585`). The scale test follows that precedent.
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
- **Disagreement facts are bounded by construction, with no budget check.**
  - One decision keeps `MAX_DECISION_FACTS`, a named alias equal to `MAX_FINDINGS` (32).
  - The run aggregate is `MAX_RUN_DISAGREEMENT_FACTS = MAX_RUN_FINDINGS × (MAX_DECISION_FACTS + 1)` (67,584). Merge emits at most one declined reason plus 32 facts per decision, and there are at most `MAX_RUN_FINDINGS` decisions.
  - Merge output `disagreement_facts`, finalize input and `coverage.intent_uncertainty` all use the aggregate constant.
  - The byte cap guards volume, since each fact is up to 2048 characters. A policy budget would reject the all-declined shape from #1197, and capping per-decision facts would drop disclosure the contract allows today. The cost is a large `maxItems` in the published schemas.
- **Coverage bounds come from each producer.**
  - `validators` and `validator_failures` are `MAX_RUN_FINDINGS`. The pipeline records exactly one lifecycle result per request.
  - `residual_risks` and `testing_gaps` are 4096, the deduped union of 64 reviewers × 64 entries.
  - `intent_uncertainty` is `MAX_RUN_DISAGREEMENT_FACTS`, a verbatim copy of the facts aggregate.
  - `failed_reviewers` and `reviewers` stay 64.
  - One exported `COVERAGE_BOUNDS` object feeds both `CoverageSchema` and the runtime `checkCoverageArrayBound` table, so the schema and the runtime check share the array bounds.
  - `validators` is a numeric maximum in the schema. Its `COVERAGE_BOUNDS` entry equals `MAX_RUN_FINDINGS`, and the runtime table excludes it because the lifecycle-results bound already enforces it. A test pins the equality.
- **Plan-assessment results use `MAX_RUN_FINDINGS`.** The model authors plan `results`, and nothing bounds them upstream, so the limit is stated and not derived. Plan `results`, artifact `residual_actionable_work` and artifact `advisory_outputs` all use it. Going over it produces a bounded `plan_assessment.results too_big` rejection.
- **Blank risks and gaps are dropped when finalize builds coverage.** A blank string carries no information, and the artifact's `ReasonSchema` already rejects it. Filtering at the producer is cheaper than loosening the persisted contract.
- **Every schema rejection has one output shape.**
  - Line 1 is a fixed context line, for example `<surface> failed schema validation`. Up to 8 `path code` lines follow, then `… and N more` when there are more.
  - Both artifact validators use the same shape. They keep the authored custom message for `custom` codes on that issue's line.
  - A domain rejection keeps `<reason> at <path>`.
  - Rejection types carry a projected `{path, code}` list plus a total, never raw `ZodIssue`, so no-echo holds at the type level. The `reason` literal and `path` stay, so current `.reason` assertions hold.
  - One `projectZodIssues` lives in `src/lib/review-artifact-path.ts`, an existing module, so no new registration is needed.
- **Prepare and merge switch to `safeParse`.** The new reasons are `prepare output failed schema validation` and `merge output failed schema validation`. After this change those branches should be unreachable, so any hit is a named contract defect.
- **Authored custom messages satisfy no-echo.** `REVIEW_ARTIFACT_CUSTOM_MESSAGES` is a closed set of author constants, not text derived from the payload.
- **Merge resolves every cited input ID before assembly.**
  - `validateAdjudication` resolves every candidate-group member and singleton input ID against `prepared.surviving_findings`.
  - A miss returns a named `AdjudicationRejection` with a path and the reason `prepared survivor missing for input id`, added to the `AdjudicationRejectReason` union. This mirrors finalize's `checkSurvivorPartition`.
  - `requireSurvivingFinding` stays as an invariant behind the check.
- **The byte cap stays and states its limit.**
  - The three CLI messages become `<phase> input exceeds the aggregate byte cap (16842752 bytes)`, and the library rejection in `prepareReviewCandidates` states the cap too.
  - Finalize carries about three copies of each finding, so a run with very large findings trips the cap first. That is the documented resource guard working as intended.
  - A projected-size check at prepare was rejected: it would be speculative arithmetic. The scale test records real envelope sizes instead.
- **The schema version stays 1.** Widening cardinalities keeps old artifacts valid. Older external validators will reject larger new artifacts, and a doc note covers that.

## Open Questions

### Resolved During Planning

- **Run capacity.** 2048. The reasoning is in Key Technical Decisions.
- **Does `findings-schema.json` change?** No. It is the per-reviewer schema.
- **Does the Claude Code bin need a committed regeneration?** No. It builds into the gitignored `claude-code/` directory, so it is verified by building it.
- **Do registry, codemap or module-table gates fire?** No. Only file content changes, and no new `src/lib` module is added. The `src/lib/AGENTS.md` row for `review-artifact-schema.ts` still lists the new exported constants.
- **Do the existing `internal error in <phase>` tests change?** No. They force a fault in the output sink, which stays an internal error.

### Deferred to Implementation

- The exact field names of the projected issue list and total on the rejection types, and whether the list is typed as `readonly`.
- The batch size for the scale test, which depends on the measured runtime.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

| Upstream output → downstream input | Bound after this change |
|---|---|
| screen (per reviewer) → prepare | 32 findings and 64 risks or gaps per reviewer, unchanged |
| prepare `surviving_findings` / candidate group `members` / `candidate_groups` → merge, finalize | `MAX_RUN_FINDINGS` |
| adjudication `decisions` and decision ids → merge | `MAX_RUN_FINDINGS` |
| facts: one decision | `MAX_DECISION_FACTS` (32) |
| facts: aggregate → merge output → finalize input → `coverage.intent_uncertainty` | `MAX_RUN_DISAGREEMENT_FACTS`, bounded by construction |
| `merged_findings`, `validator_requests`, finding `input_finding_ids`, lifecycle results → finalize | `MAX_RUN_FINDINGS` |
| lifecycle results → `coverage.validators`, `validator_failures` | `MAX_RUN_FINDINGS` |
| screen risks and gaps → `coverage.residual_risks`, `testing_gaps` | `COVERAGE_BOUNDS` (4096), blanks dropped |
| report queues, `pre_existing_findings` → report and artifact | `MAX_RUN_FINDINGS` |
| artifact `findings`, `declined_merges`, `applied_fixes` | `MAX_RUN_FINDINGS` |
| `parent_run_metadata.applied_fixes` (contract `ParentRunMetadataSchema`) | `MAX_RUN_FINDINGS` |
| artifact `declined_merges[].input_finding_ids` | `MAX_RUN_FINDINGS` |
| plan results → `residual_actionable_work`, `advisory_outputs` | `MAX_RUN_FINDINGS`, a stated limit |

After the change, `MAX_FINDINGS` remains only for:
- screen findings and rejected severities;
- the dispatch `input_finding_count` and `selection_surface`;
- raw and parent findings;
- the rejected-severity guard in `review-pipeline.ts`.

`MAX_DECISION_FACTS` is a named alias of `MAX_FINDINGS` for one decision's facts. A comment beside the constants lists these uses, so any new reuse stands out.

## Implementation Units

- [ ] **Unit 1: Run-level bounds in the contracts and artifact schema**

**Goal:** Every run-level array is bounded by a named run-level constant. Per-reviewer and persona bounds stay where they belong.

**Requirements:** R1, R2, R3, R4, R7

**Dependencies:** None

**Files:**
- Modify: `src/lib/review-artifact-schema.ts`
- Modify: `src/lib/review-pipeline-contract.ts`
- Modify: `src/lib/AGENTS.md` (new exported constants in the `review-artifact-schema.ts` row)
- Regenerate: `skills/ce-review/references/review-summary-schema.json`, `skills/ce-review/references/review-pipeline-schema.json`, `skills/ce-review/scripts/validate-review.mjs`
- Create: `tests/unit/review-run-fixtures.ts`, a shared non-test fixture module. Its exports are `buildScreenReturn`, `runPipeline` (screen, prepare, adjudicate, finalize) and `buildMinimalArtifact({ findings })`. Unit 2 uses them.
- Test: `tests/unit/review-artifact-schema.test.ts`, `tests/unit/review-pipeline-contract.test.ts`

**Approach:**
- Add `MAX_RUN_FINDINGS`, `MAX_DECISION_FACTS`, `MAX_RUN_DISAGREEMENT_FACTS` and `COVERAGE_BOUNDS` beside the existing constants. Replace the inlined `MAX_FINDINGS * MAX_PERSONAS` products with `MAX_RUN_FINDINGS`.
- Apply the bounds from the table above to the contract schemas and the artifact schema.
- Split `DisagreementFactsSchema` into a per-decision schema and an aggregate schema.
- Add the comment listing the legitimate remaining uses of `MAX_FINDINGS`, and the alias note on `MAX_DECISION_FACTS`.
- Unit 1 changes only the schema. `checkCoverageArrayBound` keeps its `MAX_PERSONAS` value until Unit 2, so the pinned finalize test stays green in Unit 1.
- Rewrite the comment in the contract test that justifies the 32-decision cap. Decisions are bounded by candidate-group members, because every member must be cited.

**Execution note:** Write the boundary probes first. They must fail against the current caps.

**Patterns to follow:**
- The existing inlined run-level bounds on the ledger and dispositions in `review-artifact-schema.ts`.
- The existing per-reviewer 32/33 probes, which stay unchanged.

**Test scenarios:**
- Happy path: each changed contract array parses at its new bound. The arrays are `members`, `candidate_groups`, `decisions`, decision and merged-finding `input_finding_ids`, `merged_findings`, `validator_requests`, lifecycle results, the three report queues, `pre_existing_findings`, `parent_run_metadata.applied_fixes` and plan results, all at `MAX_RUN_FINDINGS`.
- Edge case: each changed contract array rejects at bound+1 with `too_big` at its exact path.
- Happy path / edge case: each changed artifact array (`findings`, `declined_merges`, `declined_merges[].input_finding_ids`, `applied_fixes`, `residual_actionable_work`, `advisory_outputs`, and the finding `input_finding_ids`) parses at its bound and rejects at bound+1 with the exact path. Artifact `findings` probes use the fixture module so that ledger referential integrity holds.
- Edge case: each coverage field parses at its `COVERAGE_BOUNDS` value and rejects at value+1. `validators` is a numeric maximum. `failed_reviewers` still rejects at 65.
- Edge case: `COVERAGE_BOUNDS.validators` equals `MAX_RUN_FINDINGS`.
- Edge case: one decision's facts parse at `MAX_DECISION_FACTS` and reject at one more. The aggregate parses at `MAX_RUN_DISAGREEMENT_FACTS` and rejects at one more with `too_big` at its exact path in merge output, finalize input and `coverage.intent_uncertainty`. `MAX_RUN_DISAGREEMENT_FACTS` equals `MAX_RUN_FINDINGS × (MAX_DECISION_FACTS + 1)`.
- Regression: the per-reviewer probes still reject at 33, and the raw-return `residual_risks` probe still rejects at 65. The `selection_surface` and `risk_coverage` pins keep their values.
- Probes import the constants. They contain no literal 32, 2048, 4096 or 67584.

**Verification:**
- The probes fail before the change and pass after it.
- `review-schema:drift` and `ce-review-validator:drift` pass after `review-schema:generate` and `ce-review-validator:build`.
- `findings-schema.json` is byte-identical.

- [ ] **Unit 2: Pipeline behavior at run scale**

**Goal:** `prepare` and `merge` complete at run scale and never throw on output schema or on a `prepared` echo that lacks a cited survivor. Coverage uses the shared bounds and drops blank strings.

**Requirements:** R1, R3, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/review-pipeline.ts`
- Regenerate: `skills/ce-review/scripts/validate-review.mjs`
- Test: `tests/unit/review-pipeline-prepare.test.ts`, `tests/unit/review-pipeline-merge.test.ts`, `tests/unit/review-pipeline-finalize.test.ts`, using the helpers in `tests/unit/review-run-fixtures.ts`

**Approach:**
- Replace the two throwing output parses with `safeParse`. Return typed rejections named `prepare output failed schema validation` and `merge output failed schema validation`, and include the issue list.
- In `validateAdjudication`, resolve every candidate-group member and singleton input ID against `prepared.surviving_findings` before assembly. A miss returns a named `AdjudicationRejection` at the offending path with the reason `prepared survivor missing for input id`, added to the `AdjudicationRejectReason` union. `requireSurvivingFinding` stays as an invariant behind the check.
- `checkCoverageArrayBound` reads `COVERAGE_BOUNDS`, so the schema and the runtime check share one object, and keeps its existing reason literal. `validators` stays out of the runtime table, because the lifecycle-results bound already enforces it, and Unit 1's equality test pins it. Update the pinned finalize test (`tests/unit/review-pipeline-finalize.test.ts`, the `coverage array exceeds bound` case) to the exported bound + 1.
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
  - more than 64 distinct facts.
- Error path: a forced output-schema failure returns a rejection with projected issues and does not throw. Use an unparsed `prepared` with more survivors than `MAX_RUN_FINDINGS`, passed to `applyReviewAdjudication`.
- Error path: a merge input with a valid adjudication, where the parent's `prepared` echo drops one `surviving_findings` entry, returns the named `prepared survivor missing for input id` rejection and not an internal error. It mirrors finalize's `checkSurvivorPartition`.
- Edge case: blank and whitespace-only risks and gaps are absent from the artifact coverage, and the run completes.
- Edge case: the coverage runtime bound rejects at `COVERAGE_BOUNDS.residual_risks + 1` with `coverage array exceeds bound`. This replaces the pin on the literal 65.
- Integration (scale): a run of 64 reviewers × 32 findings with typical-size payloads completes. The test asserts completion and records the prepare, merge and finalize envelope byte sizes and the runtime. It sets an explicit `60_000` test timeout. A fixture's payload size never decides pass or fail.

**Verification:**
- Every listed scenario passes.
- Removing the survivor check makes the merge-echo test fail.
- Removing the blank filter makes the blank-risk test fail.
- `ce-review-validator:drift` passes.

- [ ] **Unit 3: Bounded `path code` error projection**

**Goal:** `prepare`, `merge`, `finalize`, the return validator, and both artifact validators report schema rejections as a fixed context line plus up to 8 `path code` lines and an overflow count. The byte-cap rejections state the cap.

**Requirements:** R6, R7, R9

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/review-artifact-path.ts` (shared `projectZodIssues`)
- Modify: `src/lib/review-return-validator.ts` (use the shared projector)
- Modify: `src/lib/review-pipeline.ts` (schema rejections carry projected issues: prepare input, finalize output and artifact; the byte-cap rejection states the cap)
- Modify: `src/ce-review-validator.ts`
- Modify: `src/claude-code-validator.ts`
- Modify: `src/cli.ts`
- Regenerate: `skills/ce-review/scripts/validate-review.mjs`
- Test: `tests/unit/ce-review-validator-routing.test.ts`, `tests/unit/ce-review-validator-packaging.test.ts`, `tests/unit/validate-review-artifact.test.ts`, `tests/unit/claude-code-validator.test.ts`, `tests/unit/review-return-validator.test.ts` (or wherever the return projection is tested)

**Approach:**
- `projectZodIssues(issues, max)` returns at most `max` `{path, code}` pairs plus the total. Its callers format the lines. Rejection types carry that projected list and total, never raw `ZodIssue`.
- Rejection rendering depends on the kind:
  - schema rejections print the fixed context line, up to 8 `path code` lines and `… and N more` when there are more;
  - domain rejections keep `<reason> at <path>`.
- Merge and finalize input rejections print up to 8 projected issues, not only the first.
- Both artifact validators use the same shape, replacing `Review artifact validation failed: N issue(s)` and the per-issue loop. They keep the authored custom message for `custom` codes on that issue's line.
- The three CLI byte-cap messages and the library duplicate in `review-pipeline.ts` (`aggregate payload exceeds byte cap`) state `AGGREGATE_STDIN_BYTE_CAP` in bytes.
- Screen is not touched. Its stderr and `rejected_summary.reason` stay as they are.
- `internal error in <phase>` stays only for non-schema faults.

**Execution note:** Add the canary test first. It must fail if any value or key text reaches stderr.

**Patterns to follow:**
- The existing bounded projection in `review-return-validator.ts`.
- `REVIEW_ARTIFACT_CUSTOM_MESSAGES` as the closed allowlist for authored text.

**Test scenarios:**
- Happy path: a merge output-schema rejection prints the context line and `merged_findings too_big`. It does not print `internal error`.
- Edge case: nine or more issues print exactly 8 `path code` lines plus `… and N more`, for the pipeline phases and for both artifact validators.
- Error path (no-echo): a canary string in a field value and in an unknown key name never appears in stderr. Check prepare, merge, finalize and both artifact validators.
- Happy path: a domain rejection still prints `<reason> at <path>`.
- Regression: the exact-format input pins in the routing test are updated to the new multi-line form. Substring and packaging checks still pass.
- Regression: the rejection-shape pins that assert `Object.keys(rejection)` equals `['path','reason']` are updated for schema rejections, starting with `tests/unit/review-pipeline-prepare.test.ts:586`. Grep `Object.keys(` on rejections in the prepare, merge and finalize tests. Domain rejections keep `['path','reason']`.
- Regression: the forced sink fault still prints `internal error in <phase>`.
- Happy path: the byte-cap overflow prints the cap in bytes (16842752) and exits 1, for `prepare`, `merge` and `finalize`. The library rejection in `prepareReviewCandidates` also states it.
- Integration: an artifact with 9 or more issues, validated through `systematic validate-review-artifact` and through the built Claude Code bin from a foreign directory, prints the context line, 8 `path code` lines and `… and N more`. Each exits 1.

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
- Modify: `skills/ce-review/references/validator-template.md` (batching line; return contract at `:94`; failure fallback at `:92-96`)
- Modify: `skills/ce-review/references/pipeline-invocation.md`. Add the exit-1 error shape. Add one never-bypass line: after a byte-cap exit, do not retry identical bytes, stop visibly. Add the note that older external validators reject artifacts larger than their caps.

**Approach:**
- SKILL wording: keep the phrase "one validator subagent per request" (`tests/unit/ce-review-acceptance-contract.test.ts:312` matches `/spawn one validator subagent in parallel/i`, so the new text still satisfies that pin). Dispatch in bounded batches sized to what the harness handles reliably. Each batch runs in parallel and must finish before the next. Every request needs a result, and a non-answer is recorded as `unavailable`.
- Rewrite the template's return contract at `:94` from `{validated, reason}` to the lifecycle shape `{outcome: 'true'|'false'|'failed'|'unavailable', reason?}`, mirroring `SKILL.md:524-527`. Outcome `true` carries no reason.
- Rewrite the failure fallback at `:92-96`. Remove the claim that a failed validator counts as `validated: true`. State the SKILL outcome instead: the finding stays unvalidated and a lifecycle failure is recorded.
- Use no batch number. It is harness policy.
- The older-validator note lives only in `pipeline-invocation.md`. `HARNESSES.md` and `ARCHITECTURE.md` mention the byte cap and the validator surface but do not describe validator array limits.

**Test expectation:** None, because this changes guidance text only. The content-integrity and markdownlint gates cover the files.

**Verification:**
- The guidance in `SKILL.md` and `validator-template.md` agrees, including the return contract.
- The acceptance-contract test passes.
- Content-integrity is clean.
- Markdownlint is clean.

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
| Very large runs hit the byte cap at finalize, or the model's output size binds before the contract capacity | Documented as the resource guard. The message states the limit. The scale test records real sizes. |
| Up to 2048 reviewer finding texts can now re-enter the parent context, where the effective limit was about 32 | The skill's handling of reviewer output as untrusted content and the never-bypass rule are unchanged. Large runs carry more untrusted text, and the rule applies at every size. |
| Generated surfaces drift | Each unit regenerates the artifacts it affects. The drift gates run in the final verification. |
| Projection leaks payload text | The canary test, run against every surface |

## Documentation / Operational Notes

- Release type: patch (`fix`). Large `ce:review` runs no longer stop at 32 findings, and validator errors name the failing fields.
- The cleanup skill labels review summaries over 1 MiB as `unknown` in its preview only. Deletion eligibility is unchanged, so no action is needed.

## Sources & References

- Related issue: #1197
- Analyses, kept locally: Oracle cap design, repo research and flow analysis, in `/tmp/plan1197/` (not in the repository)
- Related code: `src/lib/review-artifact-schema.ts`, `src/lib/review-pipeline-contract.ts`, `src/lib/review-pipeline.ts`, `src/ce-review-validator.ts`, `src/claude-code-validator.ts`, `src/cli.ts`
