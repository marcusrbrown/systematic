# Synthesis Artifact Contract

This is the canonical prose definition of the parent-owned
`.context/systematic/ce-review/<run-id>/review-summary.json` synthesis artifact.
The executable field vocabulary and bounds remain defined by
[`findings-schema.json`](./findings-schema.json).

## Scope and lifecycle

For interactive, autofix, and headless runs, the parent writes
`review-summary.json` even when every selected persona returns `empty` and no
finding survives. `mode:report-only` is the deliberate no-write exception.

The parent initializes the artifact as `in_progress` before dispatch, with all
selected personas initialized as `never_returned`, and updates each dispatch
entry as returns arrive. A completed run becomes `completed` or `degraded`. An
interrupted or failed run becomes `abnormal` with its stated termination
reason. An unfinished `in_progress` artifact is evidence of an abnormal run,
not evidence of a clean run. Never infer a clean run from an absent artifact.

The artifact is parent-owned. Per-agent full-detail JSON files are written
only for findings admitted after the parent completes schema and
environment-value validation. A finding rejected by environment-value
detection is not persisted; other findings from the same return may proceed.
A payload rejected at top level, or a rejected or never-returned persona,
does not produce a per-agent file. If a later confidence or validation stage
changes an input disposition, the parent updates the record and synthesis
ledger before finalizing the artifact.

## Required distinctions and reconciliation

The artifact must preserve these distinctions:

```json
{
  "run_id": "<run-id>",
  "schema_version": 1,
  "mode": "<interactive | autofix | headless>",
  "harness": "<opencode | pi | claude-code>",
  "run_status": "<in_progress | completed | degraded | abnormal>",
  "dispatches": [
    {
      "persona": "correctness",
      "dispatch_outcome": "findings",
      "input_finding_count": 2
    },
    {
      "persona": "testing",
      "dispatch_outcome": "findings",
      "input_finding_count": 1
    },
    {
      "persona": "kieran-typescript",
      "dispatch_outcome": "malformed",
      "input_finding_count": 2,
      "rejection_reason": "Rejected persona kieran-typescript return: field findings[0].evidence failed schema validation."
    }
  ],
  "input_findings": [
    {
      "input_id": "correctness#1",
      "reviewer": "correctness",
      "confidence": 0.55,
      "disposition": "suppressed",
      "reason": "confidence 0.55 is below the 0.60 gate"
    },
    {
      "reviewer": "kieran-typescript",
      "dispatch_outcome": "malformed",
      "rejected_finding_count": 2,
      "rejected_severities": ["P2", "P3"],
      "disposition": "rejected",
      "reason": "Rejected persona kieran-typescript return: field findings[0].evidence failed schema validation."
    }
  ],
  "findings": [
    {
      "title": "<merged finding>",
      "input_finding_ids": ["correctness#2", "testing#1"],
      "provenance": {
        "fingerprint": "<normalize(file) + line_bucket(line, +/-3) + normalize(title)>",
        "submitters": ["correctness", "testing"],
        "agreement_credit": []
      }
    }
  ],
  "disposition_counts": {
    "surviving": 0,
    "merged": 2,
    "suppressed": 1,
    "filtered": 0,
    "rejected": 2
  }
}
```

- `dispatches` has an entry for every selected persona. `dispatch_outcome`
  records what a persona returned: `findings`, `empty`, `malformed`, or
  `never_returned`. A rejection reason is the exact safe validation reason,
  naming persona and field without echoing the offending value. Dispatch
  outcome is separate from finding disposition.
- `input_findings` is the authoritative parent-owned ledger. Before the
  confidence gate, every admitted finding receives an `input_id` of
  `<reviewer>#<1-based finding index>`. Every admitted input has exactly one
  final `disposition`: `surviving`, `merged`, `suppressed`, or `filtered`, plus
  a reason. A rejected payload is represented by one summary ledger entry,
  carrying the persona name, its `dispatch_outcome`, the
  `rejected_finding_count` of findings not admitted, `disposition: "rejected"`,
  `rejected_severities`, a list of the severities of the findings not
  admitted as parsed from the payload, and the exact safe rejection message.
  When a rejected finding's severity is absent, malformed, or not a valid
  severity value, record it as `unknown`. Severity is metadata; recording it
  never includes the offending value. Do not enumerate rejected findings or
  assign them input IDs. A finding-level environment rejection uses the same
  summary entry while admitted findings from that return continue normally.
  Disposition counts are weighted by `rejected_finding_count` for that summary
  entry, so their sum equals the total number of findings observed, not the
  number of ledger rows. A malformed JSON return with no safely enumerable
  finding has zero ledger entries, not a fabricated finding. Never include the
  offending value in a rejection reason.
- Synthesized and filtered findings retain their original fields plus
  `input_finding_ids` and provenance. Provenance contains the exact dedup
  fingerprint `normalize(file) + line_bucket(line, +/-3) + normalize(title)`,
  `submitters`, and `agreement_credit` arrays.
- `submitters` contains only personas with an input finding in the merged
  fingerprint group. `agreement_credit` contains only personas credited by the
  cross-reviewer agreement boost without an input finding in that group. A
  persona returning zero findings never appears in `submitters`; do not infer
  submission from the report's Reviewer column.
- A `filtered` finding remains available for human review with the validator's
  stated reason, but is not part of the surviving/actioned set. Every input ID
  contributing to a finding with `validated: false` receives disposition
  `filtered` with the validator's exact one-sentence reason; it is not
  `suppressed`, `rejected`, or silently excluded. A suppressed finding retains
  its original confidence, including the P0 exception for confidence `0.50`
  or higher.

The artifact also includes applied fixes, residual actionable work,
advisory-only outputs, coverage data, and the harness value. Alongside the
findings, the parent writes `metadata.json` with the run ID, branch and HEAD
captured at dispatch time, harness, verdict, and completion timestamp. The
branch and HEAD are captured before autofixes land; metadata is written after
the verdict is finalized. Existing artifacts without this additive metadata
remain valid, with downstream consumers falling back to file mtime.

Validation and persistence remain parent-side: no per-agent record or finding
is written or merged until that finding passes schema and environment-value
validation. Rejected findings are recorded through the single rejected-payload
ledger summary; admitted findings from the same return remain eligible for
synthesis. Rejected or malformed persona returns do not fail the whole review;
the review degrades while conforming returns continue through synthesis. Only
an orchestration or storage failure that prevents the parent from producing the
required run artifact is run-fatal.

## Environment-value validation

The parent recursively inspects every string leaf without logging the raw
return or any matched value. Structural environment detectors remain
unbounded and unchanged: `$NAME`, `${NAME}`, `process.env.NAME`,
`os.environ[...]`, and `NAME=value` assignments using a known environment
variable name are shape-based checks.

Value-based matching uses only non-empty runtime environment values that are
at least 16 characters long and are not composed solely of digits, dots,
dashes, or path-separator characters (forward slash or backslash). A
value is also eligible regardless of length when
its variable name contains one of `TOKEN`, `SECRET`, `KEY`, `PASSWORD`,
`PASSWD`, `CREDENTIAL`, `AUTH`, `SESSION`, `COOKIE`, `PRIVATE`, `_PASS`,
`_PWD`, `PASSPHRASE`, or `_SALT`, matched as a case-insensitive substring.
Entries containing an underscore are matched against the variable name as
written; the underscore is deliberate and prevents matching benign names that
merely contain the bare word. Values that satisfy neither condition are not
matched. A match is an exact or embedded match.

If the offending string is inside one finding, drop that finding and record it
through the rejected-payload summary entry; the remaining findings continue
through validation and synthesis. If the offending string is outside any
finding, reject the whole payload. Every rejection uses only the persona name,
JSON path, and a fixed reason (`schema validation`, `environment-value
detection`, or `malformed JSON`):
`Rejected persona <name> return: field <JSON path> failed <reason>.` Never
echo the matched value.

## Artifact validation

The parent writes `schema_version: 1` into `review-summary.json` before
validating it. This ordering makes the artifact validatable at all: without
`schema_version`, the validator reports the legacy status (exit 3) rather than
a real validation result.

After writing `review-summary.json`, the parent runs
`systematic validate-review-artifact <path>` against it. A nonzero exit means
the run is not complete. The [executable schema](./review-summary-schema.json)
is generated from a Zod source and is the machine-checkable form of the shape
described here.

On validation failure, the parent repairs the artifact and re-runs the
validator. It does not report a verdict over an artifact that failed
validation, and it does not delete the artifact to escape the check. A failing
artifact is evidence and stays on disk; an absent artifact is never evidence
of a clean run.

This is enforcement by visible failure, not by containment. An agent that
never runs the command can still finalize an artifact, but produces no evidence
in either direction. That is why the command exists as an independently
runnable check rather than as a self-validation instruction, and why its result
belongs in the run record.

`mode:report-only` writes no artifact and therefore performs no validation.

## Historical corpus exclusion

Artifacts without `schema_version` predate this contract, are excluded from
quantitative analysis, and no legacy reader will be written. The validator
backs this exclusion with its exit 3 legacy status rather than leaving it as
a prose-only decision. Across 26 run directories, 7 synthesis artifacts were
written under two different filenames (`review-summary.json` and
`summary.json`); no two shared a shape. A parser would need seven special
cases to recover data that still could not answer cross-reviewer agreement
questions, because 19 of the 26 runs had no synthesis artifact to reconcile
against at all.

## Risk-aware degraded verdict

The risk-critical surfaces are `security`, `data-migrations`, `api-contract`,
`reliability`, and `performance`. They are the conditional personas selected
specifically for the matching diff shape in Stage 3. If one of those selected
personas has `dispatch_outcome: "malformed"` or
`dispatch_outcome: "never_returned"`, the review verdict must not be clean:
it is blocking unless another persona covered the same surface and returned
validated evidence for it. For this rule, validated evidence means at least
one finding from that other persona's return passed complete schema and
environment-value validation and is relevant to the same surface. A coverage
note alone cannot satisfy this rule; the verdict must reflect the missing
risk-critical evidence.

Finding-level rejection is keyed by the severities in
`rejected_severities`. A selected risk-critical persona whose rejected
findings include any `P0`, `P1`, or `unknown` severity is treated exactly as a
rejected persona for this verdict rule: blocking unless another persona
covered the same surface with validated evidence. A selected risk-critical
persona whose rejected findings are only `P2` or `P3` does not block on that
basis alone; record it in the Coverage section instead. Unknown severity is
treated as blocking as deliberate fail-closed behavior because the parent
could not determine what was lost. Admitted findings and verdict blocking
are independent: surviving findings from the same return continue through
synthesis normally. Partial return is not partial coverage when the lost
part was critical.
