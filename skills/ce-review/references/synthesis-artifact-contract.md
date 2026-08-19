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
only after the persona return passes full-schema and environment-value
validation. Rejected or never-returned personas do not produce per-agent
files. If a later confidence or validation stage changes an input disposition,
the parent updates the record and synthesis ledger before finalizing the
artifact.

## Required distinctions and reconciliation

The artifact must preserve these distinctions:

```json
{
  "run_id": "<run-id>",
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
      "persona": "kieran-typescript",
      "dispatch_outcome": "malformed",
      "input_finding_count": 1,
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
    "rejected": 0
  }
}
```

- `dispatches` has an entry for every selected persona. `dispatch_outcome`
  records what a persona returned: `findings`, `empty`, `malformed`, or
  `never_returned`. A rejection reason is the exact safe validation reason,
  naming persona and field without echoing the offending value. Dispatch
  outcome is separate from finding disposition.
- `input_findings` is the authoritative parent-owned ledger. Before the
  confidence gate, every safely enumerable finding receives an `input_id` of
  `<reviewer>#<1-based finding index>`. Every enumerated input has exactly one
  final `disposition`: `surviving`, `merged`, `suppressed`, `filtered`, or
  `rejected`, plus a reason. Disposition counts equal the input-finding count.
  If a rejected return has a safely enumerable `findings` array, assign IDs and
  record each enumerated input as `rejected`.
  A malformed JSON return with no safely enumerable finding has zero ledger
  entries, not a fabricated finding. A rejected payload's reason is the exact
  safe rejection message, not a bucket such as `invalid`; never include the
  offending value.
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
is written or merged until the complete persona payload passes schema and
environment-value validation. Rejected or malformed persona returns do not
fail the whole review; the review degrades while conforming returns continue
through synthesis. Only an orchestration or storage failure that prevents the
parent from producing the required run artifact is run-fatal.
