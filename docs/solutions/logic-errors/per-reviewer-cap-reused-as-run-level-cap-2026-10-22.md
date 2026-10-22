---
title: A per-reviewer cap reused as a run-level cap made large ce:review runs die at merge
date: 2026-10-22
category: logic-errors
module: ce-review
problem_type: logic_error
component: tooling
symptoms:
  - "ce:review merge exited 1 with 'ce-review-validator: internal error in merge' once more than 32 findings survived prepare"
  - "A run that prepare accepted failed in a later phase, and the message named no field and no bound"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [ce-review, review-pipeline, zod, run-level-bounds, safeparse, capacity-testing, issue-1197]
---

# A per-reviewer cap reused as a run-level cap made large ce:review runs die at merge

## Problem

`MAX_FINDINGS` (32) caps the findings one reviewer may return, but the pipeline reused it for run-wide sets such as candidate groups, decisions, merged findings and the persisted findings. A run that `prepare` accepted could then fail at `merge` with a generic internal error ([#1197](https://github.com/marcusrbrown/systematic/issues/1197)).

## Symptoms

- `merge` exited 1 with `ce-review-validator: internal error in merge`.
- The message named the phase but no field or bound, so the parent could not tell an oversized run from a malformed envelope.
- Coverage lists had the same flaw at 64 (`MAX_PERSONAS`). A run with more than 64 validator failures, risks, gaps or disagreement facts failed at the last step.

## What Didn't Work

- **A single run-wide budget for disagreement facts.** One budget would reject runs that are within capacity. A run where every decision is declined carries one reason plus up to 32 facts per decision, which is 2048 × 33 = 67,584 entries at full capacity.
- **A scale test with a distinct file per finding.** The test at `tests/unit/ce-review-validator-routing.test.ts:1246-1377` gives every finding its own file and sends an empty adjudication. It proves byte headroom and 2048-entry survivor and merged sets, but builds no candidate groups, decisions, facts or validator requests.

## Solution

Run-level sets get their own constants in `src/lib/review-artifact-schema.ts:22-31`, next to the per-reviewer ones they derive from (`MAX_RUN_FINDINGS`, `MAX_DECISION_FACTS`, `MAX_RUN_DISAGREEMENT_FACTS`):

```ts
export const MAX_RUN_FINDINGS = MAX_FINDINGS * MAX_PERSONAS
export const MAX_DECISION_FACTS = MAX_FINDINGS
export const MAX_RUN_DISAGREEMENT_FACTS =
  MAX_RUN_FINDINGS * (MAX_DECISION_FACTS + 1)
```

Coverage lists read one table, `COVERAGE_BOUNDS` (`src/lib/review-artifact-schema.ts:36-44`). The runtime check `checkCoverageArrayBound` (`src/lib/review-pipeline.ts:4566-4576`) reads the same table, so the five runtime-checked fields cannot disagree with the schema. Facts get a per-decision schema and an aggregate schema (`DecisionFactsSchema` and `AggregateFactsSchema` at `src/lib/review-pipeline-contract.ts:327-332`).

Output parses return a typed rejection instead of throwing. In `parseMergeOutput` (`src/lib/review-pipeline.ts:2090-2100`):

```ts
const output = MergeOutputSchema.safeParse(candidate)
if (!output.success) {
  return {
    ok: false,
    rejection: schemaRejection(
      'merge output failed schema validation',
      output.error.issues,
    ),
  }
}
```

`schemaRejection` and `projectZodIssues` (`src/lib/review-artifact-path.ts:50-92`) keep at most 8 `{path, code}` pairs plus the total. The CLI prints up to 8 `path code` issues and `… and N more`, never issue messages or values. Malformed JSON prints `malformed JSON at $` in every phase, and the byte-cap rejection states the cap in bytes.

The `prepared` envelope the parent passes back to `merge` is untrusted input. `validatePreparedEcho` (`src/lib/review-pipeline.ts:968-981`) rejects a missing survivor, a survivor in no group or singleton, a singleton that is also a member, and any repeat, each by name and path.

Finalize rejects a screened finding with zero or several confidence dispositions (`checkScreenedFindingsHaveOneDisposition` at `src/lib/review-pipeline.ts:3106-3139`). Before #1205 nothing rejected a screened finding without a disposition. Blank risks and gaps are dropped before deduplication (`dedupeSortedNonBlankStrings` at `src/lib/review-pipeline.ts:4553-4559`).

## Why This Works

Each cap now follows the producer of the set it bounds. Per-reviewer limits still gate one reviewer's return. Run-level limits are the per-reviewer limit times the persona count, so no set that `prepare` admits can overflow a later phase. The facts aggregate is bounded by construction (decisions × (facts + 1)), so no policy budget can reject a run that is within capacity.

Volume is guarded by a different mechanism, the aggregate stdin byte cap of 16,842,752 bytes (`AGGREGATE_STDIN_BYTE_CAP` at `src/lib/review-pipeline-contract.ts:222-224`). At full capacity it is the limit that binds. Finalize input repeats survivor content across three full-payload fields, so at 2048 findings the average finding must stay under about 2.7 KB. A run of large findings stops at finalize with the named byte-cap message instead of an internal error.

## Prevention

- **Name what a cap bounds.** A constant that bounds one item's contribution must not cap the union of items. When a set can grow with the number of producers, derive its bound from the producer limit times the producer count, and give it its own name.
- **Probe each bound at the bound and one past it, at the exact path.** Build every probe from the exported constants, never from literals. Assert that the bound parses and that one past it yields `too_big` at that path. See the `RUN_LEVEL_PROBES` table driven at `tests/unit/review-pipeline-contract.test.ts:1618-1633` and the artifact equivalents in `tests/unit/review-artifact-schema.test.ts:2616-2670`. Probe a per-item bound separately from its aggregate.
- **Re-read the old "one past" pins when a bound moves.** Rewrite pins on run-level sets to the new constant. Keep the per-reviewer pins as they are.
- **Exercise every set at capacity.** The in-process run at `tests/unit/review-pipeline-merge.test.ts:1892-1980` builds shared-file candidate groups, merged and declined decisions with facts, and gated validator requests. Its expected counts come from local fixture constants, checked against `MAX_RUN_FINDINGS` and `MAX_RUN_DISAGREEMENT_FACTS`.
- **Assert byte headroom, not time.** The CLI scale test asserts that finalize stdin stays under half of `AGGREGATE_STDIN_BYTE_CAP` (`tests/unit/ce-review-validator-routing.test.ts:1363`) and that 2048 findings reach the merged set. It logs phase times without asserting them. Pair it with an oversized-finding case that expects the named byte-cap message (`tests/unit/ce-review-validator-routing.test.ts:1523-1599`).
- **Treat a carried envelope as untrusted.** Test each way the partition can break, and assert the reason and the path. The echo tests at `tests/unit/review-pipeline-merge.test.ts:1494-1578` use `expectNamedRejection` to cover a missing survivor, a repeated survivor and a repeated member.
- **Label unreachable defense in depth.** Branches that input bounds make unreachable get a comment, not a test. Test each reachable path at the layer that can reach it.

## Related Issues

- [#1197](https://github.com/marcusrbrown/systematic/issues/1197), fixed in [#1205](https://github.com/marcusrbrown/systematic/pull/1205).
- [Re-verify carried state at a phase boundary](../best-practices/re-verify-carried-state-at-phase-boundaries-2026-09-15.md): the echo checks above apply its rule to the `prepared` envelope.
- [Compiling the real schema proves it parses, not that it rejects](../best-practices/schemas-need-adversarial-probes-not-just-compilation-2026-08-16.md): the source of the bound and bound+1 probing.
- [An artifact contract with no validated write path has no conforming producers](../best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md)
- [A mutation that fails nothing needs a decision](../best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md)
