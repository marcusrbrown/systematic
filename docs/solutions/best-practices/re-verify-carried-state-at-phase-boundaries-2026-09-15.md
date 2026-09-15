---
title: Re-verify carried state at a phase boundary instead of trusting it
date: 2026-09-15
category: best-practices
module: ce-review
problem_type: design_pattern
component: tooling
severity: high
applies_when:
  - A later phase receives derived state from an earlier phase across an untrusted wire
  - A model, subprocess, or separate package authors part of the envelope a verifier consumes
  - Two derivations feed one reconciliation field, ledger, or count
  - A pipeline has report-only, dry-run, or export modes alongside a writing mode
  - A verifier's premise is that its input may be wrong
tags:
  - phase-boundary
  - derived-state
  - contract-enforcement
  - verifier-design
  - review-pipeline
  - integrity-gate
---

# Re-verify carried state at a phase boundary instead of trusting it

## Context

`ce:review` replaced prose-instructed synthesis with four pure phases — `screen`,
`prepare`, `merge`, `finalize` — in `src/lib/review-pipeline.ts`, bounded by strict Zod
contracts in `src/lib/review-pipeline-contract.ts` and shipped in the packaged Node
helper `skills/ce-review/scripts/validate-review.mjs`. The model still adjudicates
candidate groups, judges validator evidence, and assesses the plan; everything
mechanical is code.

The headline property was that a drifting or adversarial model could not launder a
decision across a phase boundary. The same defect class nonetheless appeared **five
separate times** in that exact seam, across three independent rounds of scrutiny.

Every bad envelope was schema-valid. `z.strict()` contracts and a clean typecheck
caught none of the five: shape was never the problem. One defect needed no adversarial
input at all — any run containing an unavailable reviewer emitted an artifact whose
counts disagreed with its own ledger.

## Guidance

1. **Carry every field a later phase must verify, verbatim.** A wire projection that
   drops derived fields forces the consumer to re-infer them from a narrower envelope,
   which is indistinguishable from accepting whatever it is told. Derive run-level
   aggregates in the consumer from carried evidence; do not re-derive per-item fields
   that the producer already computed.

2. **Never feed the field under test into its own verifier.** If a verifier passes a
   carried value in as the model-decision input and then checks self-consistency, it
   proves nothing — a tampered value plus a matching dependent value round-trips
   cleanly. Derive independently, then compare.

3. **Refuse a claim the shape cannot legitimately make.** Stronger than comparison:
   where a class of item can never legitimately carry a field, the verifier must
   decline to treat the carried value as a claim at all, rather than evaluate it.
   This turns a category of forgery into a structural impossibility instead of a
   check that has to be right every time.

4. **Join as exact set equality, in both directions.** Presence checks pass while
   completeness fails. Verifying that every validator request names a known finding
   does not detect a *deleted* request; verifying dispatch records one-directionally
   lets a duplicated persona mask a lost one. Missing, duplicate, and extra members
   must each fail, with distinguishable reasons.

5. **"By construction" is not an argument available to a verifier — about its input.**
   A verifier exists because its input is untrusted. A guard that skips its comparison
   when the corroborating record is absent — justified by a comment asserting the
   record is always present — is circular: absence is exactly what a fabricated
   identifier produces. Absent evidence is a rejection, not a no-op, and it deserves a
   reason distinct from "the values disagree".

   Note the boundary against rule 3, which looks like the opposite advice. A
   by-construction fact about *local producer code you control* is admissible when it
   is used to **refuse** a claim outright — that is strictly stronger than comparing
   it. The same reasoning about *carried input* is inadmissible when it is used to
   **skip** a comparison. Refusing is verification; skipping is trust.

6. **If two derivations must reconcile, enforce it at both ends and assert it.** Apply
   the same inclusion and exclusion rules to each derivation, then add a real
   assertion. A docstring claiming values "always sum ... verified by the caller" is
   not a verification when no caller verifies it.

7. **Run shared integrity gates before mode-specific early returns.** Compute the
   shared projections, gate them, then branch — otherwise a gate added later silently
   applies to one mode only.

## Why This Matters

The consequences are specific, not abstract. In this pipeline the gaps allowed:

- **A forged dedup identity.** The fingerprint was composed from the carried line, so
  a consistently retargeted line witnessed itself — and pointed a fixer at the wrong
  place in the file.
- **A laundered confidence boost.** A fabricated agreement credit naming any reviewer
  that merely returned made an inflated confidence self-consistent.
- **Misattributed ownership.** An unverified `reviewer` on a surviving finding
  propagated into provenance, the persisted ledger, and the cross-persona coverage
  test. Because the ledger itself carried the wrong owner, referential-integrity
  refinement on the artifact could not catch it.
- **An artifact that did not reconcile with itself.** Counts and ledger rows were
  derived over different row sets, so a consumer comparing them saw an unexplained
  discrepancy in a well-formed run.

A strict schema proves shape. It does not prove that a carried value was ever
witnessed by the phase that supposedly produced it.

## When to Apply

- Any staged pipeline where phase N emits derived state that phase N+1 must trust.
- Any handoff where a model, subprocess, or separate package authors part of the
  envelope — the producer can ignore instructions in a way a deterministic writer
  cannot.
- Any place one derivation builds a ledger and another derives counts or totals from
  nominally the same rows.
- Any workflow with report-only, dry-run, or export modes beside a writing mode.

## Examples

### A verifier that re-derives from the field under test

The carried-field verifier passed the carried credit in as its own decision input, and
never compared the derived credit against it. A fabricated credit plus a matching
`+0.10` confidence bump was self-consistent, so tampering with confidence *alone* was
caught while tampering with both was not.

The fix refuses the claim structurally, then compares:

```ts
function eligibleAgreementCreditClaim(
  finding: MergeOutput['merged_findings'][number],
): readonly string[] | undefined {
  return finding.input_finding_ids.length >= 2
    ? finding.agreement_credit
    : undefined
}
```

```ts
eligible_agreement_credit: eligibleAgreementCreditClaim(finding),
// ...
JSON.stringify(derivation.value.agreement_credit) !==
  JSON.stringify(finding.agreement_credit ?? [])
```

A singleton's claim is now re-derived from nothing, because `assembleSingletonFinding`
never sets credit — the forgery is impossible rather than merely detected.

Two caveats if you copy this shape. The guard is a runtime length check, not a type:
distinguishing a singleton from a merged group in the type system would make the
invalid state unrepresentable, but here that would ripple through the merge and
finalize schemas and both assembly paths, so it was priced as a refactor rather than
taken. And the `JSON.stringify` comparison is sound only because both arrays are
canonicalized as sorted strings; it becomes brittle the moment members stop being
strings or ordering stops being guaranteed.

### "By construction" inside a verifier

The survivor comparison ran only when the screened record existed, justified by a
comment that every survivor ID is mirrored into `confidence_dispositions` by
construction. A survivor citing an ID present in neither skipped verification entirely.

```ts
const screened = screenedByInputId.get(survivor.input_id)
if (screened === undefined) {
  return {
    path: formatReviewArtifactIssuePath([
      'prepared',
      'surviving_findings',
      index,
      'input_id',
    ]),
    reason: 'surviving finding references unscreened input',
  }
}
```

The distinct reason matters: a caller can tell "cites an input nobody screened" from
"fields disagree with what was screened".

### Reconciliation enforced, not narrated

`buildAdmittedLedgerRows` excluded `validation_unavailable` personas; the disposition
derivation counted every entry. The fix applies the exclusion at both ends *and*
asserts the result:

```ts
const dispositionAdmittedSum =
  dispositionCounts.surviving +
  dispositionCounts.merged +
  dispositionCounts.suppressed +
  dispositionCounts.filtered
if (dispositionAdmittedSum !== admittedLedgerRowCount) {
  return {
    ok: false,
    rejection: {
      path: formatReviewArtifactIssuePath(['disposition_counts']),
      reason:
        'disposition counts do not reconcile with the admitted input ledger',
    },
  }
}
```

### Gate before the mode branch

```ts
const riskCoverageSemantics = checkRiskCoverageSemantics({
  dispatches,
  findings,
  risk_coverage: riskCoverage,
})
if (!riskCoverageSemantics.ok) return riskCoverageSemantics

const report = buildReportProjection(/* ... */)
if (input.parent_run_metadata.mode === 'report-only') {
  return parseFinalizeOutput({ kind: 'report_only', ...report })
}
```

## How These Were Found

No single mechanism found them all, and each found defects the others missed:

- A **read-only architectural pass** reproduced six schema-valid defects with concrete
  envelopes, before any reviewer saw the code.
- **Running the pipeline on itself** surfaced nine validated findings against its own
  new code — including one that a fixture inconsistency had quietly masked.
- **Two rounds of automated PR review** found four more blocking issues, all landing in
  the same finalize-join seam the first two mechanisms had already examined.

That last point is the useful one. A seam that has already been reviewed is not a
cleared seam. When a boundary's entire purpose is to distrust its input, budget more
scrutiny than its line count suggests, and prefer adversarial envelopes over additional
happy-path coverage. Watch for inert checks while you are there: one guard fabricated
its own `route_narrowing_reason` placeholder and so could never fail.

## Related

- [An artifact contract with no validated write path has no conforming producers](./unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md) — the write-boundary counterpart: a contract nothing validates has no conforming producers.
- [Compiling the real schema proves it parses, not that it rejects](./schemas-need-adversarial-probes-not-just-compilation-2026-08-16.md) — why happy-path validation does not establish rejection semantics.
- [Behavior-first AJV contract verification for agent outputs](./behavior-first-ajv-contract-verification-2026-07-21.md) — verifying emitted objects at the consumer boundary.
- [Content-integrity gate should mirror runtime drop rules](./content-integrity-mirror-runtime-drop-rules-2026-05-17.md) — a gate checking a weaker shape than the runtime accepts creates false confidence.
- Issue #795, PR #984, released in v3.18.4.
