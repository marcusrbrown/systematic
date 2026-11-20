---
title: "Report rows nobody can act on filled the oldest-first size cap, and the section that collapsed them was budgeted outside the verifier's cap"
date: 2026-11-20
category: logic-errors
module: ce-connect
problem_type: logic_error
component: tooling
symptoms:
  - "A backlog of open entries with no boxes filled the report's oldest-first size cap and would hide a newer candidate that could be settled"
  - "A section appended after the rows sat outside the renderer's budget, so a near-cap body plus that section could exceed the cap the workflow verifies (reasoned from the arithmetic, not observed)"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [ce-connect, report, size-cap, queue-starvation, budget, verifier, github-actions, test-pinning]
---

# Report rows nobody can act on filled the oldest-first size cap, and the section that collapsed them was budgeted outside the verifier's cap

## Problem

A `ce:connect` report lists open candidates oldest first and stops at a size cap, saying how many are hidden. Making old, unversioned entries non-actionable left them in that list as rows with no boxes. Nothing could be done with them, and they were older than everything else, so a large enough backlog would take the whole cap and the first candidate a person could settle would never appear. The fix lists only actionable rows and collapses the rest into a short section. That section was first appended outside the budget the rows were fitted to.

Both defects were found in review before the change merged. The starvation follows directly from an oldest-first cap over rows that cannot be acted on. The overflow is a conclusion from the arithmetic below. No run posted an over-cap body or was refused.

## Symptoms

- With enough boxless rows ahead of it, the backlog would hide a newer candidate with details, a `Fetch` line and boxes behind the "not shown" line on every run.
- A body filled to the renderer's cap, plus an appended section naming up to 20 ids, could be longer than the workflow accepts. The verify step would then refuse the report and nothing would post.

## What Didn't Work

**Keeping every open entry as a row.** The cap counts characters, not usefulness. Rows with no verified details have no boxes and no Fetch entry, but they still take space and they sort first.

**Fitting the rows, then appending the collapsed section.** Appending up to 20 ids after the 60,000-character renderer cap (`src/lib/connect-ci.ts:70-71`, `REPORT_MAX_CHARS`) could add about 1,360 characters, past the workflow's 60,500 cap (`.github/workflows/connect.yaml:48-50`, `REPORT_BODY_CAP`). The 500-character slack under that cap also has to hold the 133-character cache-save line (`.github/workflows/connect.yaml:837`). The verifier compares the final body to the cap (`.github/workflows/connect.yaml:948`).

## Solution

**List only what can be acted on.** `rowsOf` makes a row only for an entry with a bundle for its live revision. Every other open entry goes into an `unverified` list (`src/lib/connect-ci.ts:1326-1351`).

**Collapse the rest into one bounded section.** `unverifiedSection` counts the entries and names at most `MAX_UNVERIFIED_IDS` of them, 20, oldest first, then says how many more (`src/lib/connect-ci.ts:1179-1197`; `src/lib/connect-ci.ts:73-74`). It has no boxes, and the manifest does not hold its ids.

**Budget the section inside the cap.** `assembleReport` puts the section in the body, so every length check includes it (`src/lib/connect-ci.ts:1205-1240`). `fitReport` tries the full id list first and measures how many rows fit beside it. If the oldest row would not fit, it halves the list, down to the count alone (`src/lib/connect-ci.ts:1268-1282`):

```ts
for (let named = Math.min(MAX_UNVERIFIED_IDS, input.unverified.length); named > 0; named = Math.floor(named / 2)) {
  const shown = rowsThatFit(input, named)
  if (shown >= wanted) return { shown, named }
}
return { shown: rowsThatFit(input, 0), named: 0 }
```

The whole body stays at or under 60,000, so the workflow's one extra line fits in the 500 characters left under the verifier's cap.

## Why This Works

Budget the collapsed backlog and the actionable rows together, shrinking the id list until at least the oldest actionable row fits, and leave room under the downstream cap for anything appended later.

## Prevention

- **Seed the backlog that starves the queue.** An older backlog with no bundles, large enough to fill the report, then a newer candidate with one. Assert the newer one is shown in full with Fetch and boxes, and that the legacy ids appear only in the collapsed section (`tests/unit/connect-ci.test.ts:2917-2959`). Assert its tick is recorded on the next apply and the backlog stays open (`tests/unit/connect-ci.test.ts:2961-2979`).
- **Read the cap from the verifier, never restate it.** The test parses `REPORT_BODY_CAP` and extracts the cache-save line from the workflow text (`tests/unit/connect-ci.test.ts:250-265`). It asserts `REPORT_MAX_CHARS` plus that line is within the cap (`tests/unit/connect-ci.test.ts:3088-3096`). A tolerance written into the test can pass while the real verifier refuses.
- **Run the real verify step on a near-cap body.** Seed 25 entries without bundles and enough rows that the cap binds, append the cache-save line, and assert the verifier passes. Assert it refuses the same body once it is over the cap (`tests/unit/connect-workflow.test.ts:1782-1810`, `tests/unit/connect-workflow.test.ts:1812-1828`).
- **Test the shrink and the fallback.** The id list names fewer ids when twenty would push the first row out, and falls back to the count alone with the body still under the cap (`tests/unit/connect-ci.test.ts:3131-3146`, `tests/unit/connect-ci.test.ts:3148-3159`).
- **Whenever a section is appended to a bounded artifact,** list who else adds to it later, and budget against the final reader's limit.

## Related

- [Ticks and decisions bound to a candidate id settled reopened candidates](reopen-counter-reused-after-partial-failure-bind-decisions-to-a-content-revision-2026-11-20.md): why entries without a bundle for the live revision are not actionable.
- [A report carrier changed beside its renderer ran ahead of the renderer the workflow pins](../integration-issues/report-carrier-ran-ahead-of-the-pinned-renderer-2026-11-20.md): the rollout side of the same change.
- [A per-reviewer cap reused as a run-level cap made large ce:review runs die at merge](per-reviewer-cap-reused-as-run-level-cap-2026-10-22.md): another bound that was measured against the wrong limit.
- [Evaluate a model-driven tool with a pre-registered protocol](../best-practices/pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md): a different case of a bound that gave a misleading picture.
