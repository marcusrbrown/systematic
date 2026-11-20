---
title: "Ticks and decisions bound to a candidate id settled reopened candidates; a reopen counter was the wrong replacement, so bind them to a content-derived revision"
date: 2026-11-20
category: logic-errors
module: ce-connect
problem_type: logic_error
component: tooling
symptoms:
  - "A box ticked on an earlier report could settle a candidate that had since reopened on changed evidence, so the reopened candidate would go unreviewed"
  - "A `decide` made from an older digest could succeed after the candidate's evidence changed"
  - "A report row's text could come from an older stored proposal, so what a person read need not describe the evidence its box would settle"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [ce-connect, revision, ledger, report-ticks, cache-rollback, content-addressing, one-source, review-churn]
---

# Ticks and decisions bound to a candidate id settled reopened candidates; a reopen counter was the wrong replacement, so bind them to a content-derived revision

## Problem

A person settles a `ce:connect` candidate by ticking a box on the scheduled report or by running `decide` from the digest. Both were bound to the candidate id. The id is the same across a reopen, because it leaves out fingerprints and evidence on purpose (`src/lib/connect-state.ts:860-881`, `candidateIdentity`). A decision made for one set of evidence could therefore settle a candidate that reopened on different evidence, and nobody would have reviewed that evidence. This was found in review. It was not observed in use.

## Symptoms

These are what the binding allowed. Review found them; none was observed in use.

- A ticked **Rejected** box carried forward by id could settle the reopened candidate on the next run.
- A `decide` from an older digest could succeed against changed evidence. The only guard was whether the entry was still open (`onlyIfOpen`).
- The report took a row's text by id from "this run, else stored", and its boxes by id alone. The text on screen was not tied to the content the box would settle.

## What Didn't Work

**A reopen counter.** The first design bound ticks and decisions to an incrementing per-entry number. It never shipped, and no reopen generation counter remains. It failed because one number could name different evidence. A failed ledger write left a predicted number in the digest, and a decision made from it would pass the check against evidence the reviewer had not seen. A cache rollback restored an older ledger, and a later reopen could reuse a number an earlier reopen had already carried onto a tick. Selecting report fields by candidate id had the same flaw: it mixed the text, revision and Fetch link of different proposals.

## Solution

The binding is now a revision derived from content. `revisionOfParts` hashes the source, target-evidence and recorded-evidence fingerprints, each with its path (and role or project), under a version tag (`src/lib/connect-state.ts:1467-1483`):

```ts
createHash('sha256').update(JSON.stringify([
  'connect-revision-v1',
  sources.map((x) => [x.role, x.path, x.fingerprint]),
  targetEvidence.map((x) => [x.path, x.fingerprint]),
  evidence.map((x) => [x.project, x.path, x.fingerprint]),
])).digest('hex').slice(0, 12)
```

- **Equal content gives an equal revision.** No failed write or rollback can make one revision name two contents, so the special cases for them are gone. Going back to the first content gives the first revision (`tests/unit/connect-state.test.ts:2407-2417`).
- **The digest shows the revision before the ledger write.** `revisionOfCandidate` computes it from the candidate itself (`src/ce-connect-helper.ts:1758`). A decision from a run whose write failed is refused while the ledger holds other evidence, and accepted if identical evidence commits later.
- **Re-citing evidence recomputes it.** `withEvidence` drops the stored revision and hashes the new evidence, so a decision from the earlier digest is refused (`src/lib/connect-state.ts:1438-1449`).
- **`decide` refuses a stale revision under the ledger lock** as `stale-revision` (`src/lib/connect-state.ts:2456-2466`, `refusalOf`). The skill tells the model to send the value from the digest's `Revision:` line, never its own, and not to retry on a refusal (`skills/ce-connect/SKILL.md:209-213`).
- **The box marker carries the revision** as `:r<12 hex>` (`src/lib/connect-ci.ts:112-120`, `decisionLine`). A tick is recorded only when its revision equals the entry's (`src/lib/connect-ci.ts:1683-1687`, `judge`). A box with no revision is skipped as `unversioned`, and one with another revision as `stale`.
- **One bundle per proposal.** The text, the revision and the run and attempt that hold the evidence travel together. `mergedPayloads` keeps whichever of this run's bundle and the stored one has the ledger's revision (`src/lib/connect-ci.ts:1277-1309`). `rowsOf` makes a row only from a bundle with that revision, and counts every other entry as unverified (`src/lib/connect-ci.ts:1326-1351`).

## Why This Works

A counter names an event, and events can be lost, repeated or rolled back. A content hash names the thing the reviewer looked at, so the check "is this still what they saw?" has no history to get wrong. The bundle applies the same rule to the report: parts of one displayed item come from one source, so a row cannot show one proposal's text beside another's boxes. Old and unversioned text cannot match any revision, so it is non-actionable by construction instead of by a heuristic.

The binding is only as strong as its caller. `refusalOf` checks a revision only when the request carries one (`src/lib/connect-state.ts:2456-2466`), so the skill text that says "always send `revision`" is part of the control.

## Prevention

- **Test the failure sequence, not the counter.** Fail one proposal's ledger write, then commit the same evidence and assert the first digest's decision applies. Commit different evidence and assert it is refused and the candidate stays open (`tests/unit/ce-connect-helper-ops.test.ts:4427-4436`, `tests/unit/ce-connect-helper-ops.test.ts:4438-4454`).
- **Test the rollback.** Tick revision A, roll the cache back, publish revision B in A's place, and assert the tick is neither carried nor recorded (`tests/unit/connect-workflow.test.ts:3379-3403`).
- **Seed text from before revisions** and text whose artifact holds other evidence, and assert the row has no boxes and no Fetch line (`tests/unit/connect-ci.test.ts:2764-2790`, `tests/unit/connect-ci.test.ts:2839-2868`).
- **Pin the paths the main tests skip.** Test identical-content paths separately (`tests/unit/connect-import.test.ts:1834-1864`), require the skill to send the displayed revision (`tests/unit/connect-skill-contract.test.ts:617-653`), and verify that ledger rewrites keep history fields (`tests/unit/connect-state.test.ts:1467-1509`). Each is pinned by a named test.

## Related

- [Run state for a model-invoked helper](../best-practices/run-state-for-a-model-invoked-helper-2026-11-09.md): the ledger identity and reopen rules this binding sits on.
- [The already-recorded check ran before the ledger could reopen a connection](already-recorded-check-ran-before-ledger-reopen-2026-11-09.md): the sibling reopen defect.
- [Re-verify carried state at a phase boundary](../best-practices/re-verify-carried-state-at-phase-boundaries-2026-09-15.md): the general rule that carried state must be reconciled, not trusted.
- [A report carrier is not the renderer the workflow pins](../integration-issues/report-carrier-ran-ahead-of-the-pinned-renderer-2026-11-20.md): the rollout of this report format.
- [Rows nobody can act on starved the report's size cap](report-rows-nobody-can-act-on-starved-the-size-cap-2026-11-20.md): the queue and budget lesson from the same change.
