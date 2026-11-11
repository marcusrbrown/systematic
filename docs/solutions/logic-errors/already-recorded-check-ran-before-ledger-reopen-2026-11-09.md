---
title: The already-recorded check ran before the ledger could reopen a connection, so a changed source never resurfaced
date: 2026-11-09
category: logic-errors
module: ce-connect
problem_type: logic_error
component: tooling
symptoms:
  - "A connection that was promoted and whose source learning later changed was listed under `Connections already recorded` instead of reopening as `sources changed`"
  - "The refresh pointer to the promoted learning never appeared in the digest"
  - "A contradiction whose sources were all in the target project was accepted as a cross-project connection"
  - "A candidate lost to a file that changed during the run left the run `complete` and its rule counted as covered"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [ce-connect, ledger, dedup, suppression, ordering, change-detection, reopen, validation]
---

# The already-recorded check ran before the ledger could reopen a connection, so a changed source never resurfaced

## Problem

`ce:connect` suppresses a candidate that the target project already records, so a person is not shown the same lesson twice. The "already recorded" lookup ran before the step that detects a change, and ignored the fingerprint it was shown. A promoted connection whose source later changed was therefore reported as settled, and the one thing the reopen is for, a pointer to the learning that may now need a refresh, never reached the digest.

## Symptoms

- After a candidate was promoted (the target learning cites its source as `<project>:<path>@<fingerprint>`) and the source learning was edited, the next run listed the connection under `Connections already recorded` and nothing else.
- The ledger entry stayed `promoted` instead of reopening as `sources changed`, and the refresh pointer was missing.
- Neighbouring checks in the same pass had the same flavour (a validation that accepted too much, a drop that cost nothing): a contradiction with every source in the target project passed, and a candidate dropped because its cited file changed mid-run left the run `complete`.

## What Didn't Work

Suppressing on path alone bypasses the ledger's changed-source decision.

## Solution

Put the change signal in front of the shortcut. `classifyOne` still calls `findRecorded` first, because it is cheap and deterministic, but it now suppresses only when the ledger would not reopen the candidate for changed sources (`src/ce-connect-helper.ts:1394-1400` `reopensForChangedSources`; `src/ce-connect-helper.ts:1414-1456` `classifyOne`):

```ts
// Before (reconstructed from the order of the checks): a citation of the
// source by project name and path settled it, whatever fingerprint it carried.
const recorded = findRecorded(check.candidate, input.snapshot.provenance)
if (recorded !== undefined) { /* list as already recorded and stop */ }

// After: a changed source reopens first.
const recorded = findRecorded(check.candidate, input.snapshot.provenance)
if (recorded !== undefined && !reopensForChangedSources(record, input)) {
  /* list as already recorded and stop */
}
classifyAgainstLedger(check.candidate, record, input.ledger, result)
```

`reopensForChangedSources` asks `classifyCandidate` (`src/lib/connect-state.ts:1103-1157`) and answers true only for a reopen with the reason `sources changed`. A promoted entry then carries the destination as its refresh pointer.

The two neighbouring defects were fixed in the same pass:

- **A contradiction must span projects.** The shape check required two sources and the target among them, but not a second project. A candidate with two learnings from the target alone is now dropped as `same-project-contradiction` (`contradictionProblem`, `src/lib/connect-helper-core.ts:1049-1065`).
- **Lost evidence degrades the run.** A candidate dropped as `changed-since-begin` now adds the degrade reason `evidence-changed` and holds its rule back from the covered set, so the rule is offered again. A plain rejection stays non-degrading (`classifyOne`, `src/ce-connect-helper.ts:1414-1456`; `holdBack`, `src/ce-connect-helper.ts:1402-1412`).

## Why This Works

`findRecorded` answers "does the target cite this source?" by project name and path (`src/lib/connect-helper-core.ts:1291-1318`). That is the right question for a suppression, and the wrong one for a changed source, because the citation was written at the fingerprint the source had then. The ledger holds the only record of that fingerprint, so only the ledger can say whether the cited text still matches. Suppression is allowed to be a shortcut. It is not allowed to bypass the check that makes the shortcut safe.

## Prevention

- **Test the sequence, not the pieces.** `reopens a promoted connection when its source changed, and does not list it as already recorded` runs a candidate, records it with `decide` as promoted, commits a target learning that cites the old fingerprint, edits the source, runs again, and asserts that `recorded` is empty and the accepted entry has `standing: 'sources changed'` and the refresh pointer (`tests/unit/ce-connect-helper-ops.test.ts:1178-1245`).
- **Pair it with a negative control.** The same run with an unchanged source must still list the connection as already recorded, or the fix has turned suppression off.
- **Pin each drop reason.** `drops two distinct paths that are both in the target project` asserts `same-project-contradiction` (`tests/unit/connect-helper-core.test.ts:866-910`). The changed-evidence tests assert `evidence-changed`, the outcome `degraded`, that the lost rule is absent from the covered set while the others are recorded, and that a plain rejection leaves the run `complete` (`tests/unit/ce-connect-helper-ops.test.ts:1246-1320`).
- **Rule of thumb for any dedup or "already done" shortcut:** if a later step detects change, the shortcut has to consult that step's result, or run after it.

## Related Issues

- [Run state for a model-invoked helper](../best-practices/run-state-for-a-model-invoked-helper-2026-11-09.md): the ledger identity and reopen rules this check must defer to.
