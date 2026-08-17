# Code Review Output Template

Use this **exact format** when presenting synthesized review findings. Findings are grouped by severity, not by reviewer.

**IMPORTANT:** Use pipe-delimited markdown tables (`| col | col |`). Do NOT use ASCII box-drawing characters.

## Example

```markdown
## Code Review Results

**Scope:** merge-base with the review base branch -> working tree (14 files, 342 lines)
**Intent:** Add order export endpoint with CSV and JSON format support
**Mode:** autofix

**Reviewers:** correctness, testing, maintainability, security, api-contract
- **Harness:** opencode
- security -- new public endpoint accepts user-provided format parameter
- api-contract -- new /api/orders/export route with response schema

### P0 -- Critical

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `orders_controller.rb:42` | User-supplied ID in account lookup without ownership check | security | 0.92 | `gated_auto -> downstream-resolver` |

### P1 -- High

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 2 | `export_service.rb:87` | Loads all orders into memory -- unbounded for large accounts | performance | 0.85 | `safe_auto -> review-fixer` |
| 3 | `export_service.rb:91` | No pagination -- response size grows linearly with order count | api-contract, performance | 0.80 | `manual -> downstream-resolver` |

### P2 -- Moderate

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 4 | `export_service.rb:45` | Missing error handling for CSV serialization failure | correctness | 0.75 | `safe_auto -> review-fixer` |

### P3 -- Low

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 5 | `export_helper.rb:12` | Format detection could use early return instead of nested conditional | maintainability | 0.70 | `advisory -> human` |

### Applied Fixes

- `safe_auto`: Added bounded export pagination guard and CSV serialization failure test coverage in this run

### Residual Actionable Work

| # | File | Issue | Route | Next Step |
|---|------|-------|-------|-----------|
| 1 | `orders_controller.rb:42` | Ownership check missing on export lookup | `gated_auto -> downstream-resolver` | Create residual todo and require explicit approval before behavior change |
| 2 | `export_service.rb:91` | Pagination contract needs a broader API decision | `manual -> downstream-resolver` | Create residual todo with contract and client impact details |

### Pre-existing Issues

| # | File | Issue | Reviewer |
|---|------|-------|----------|
| 1 | `orders_controller.rb:12` | Broad rescue masking failed permission check | correctness |

### Filtered (not validated)

| # | File | Issue | Reviewer | Confidence | Validator reason |
|---|------|-------|----------|------------|-----------------|
| 1 | `orders_controller.rb:55` | Rate limit bypass via header spoofing | security | 0.72 | The `X-Forwarded-For` header is already stripped by the load balancer before reaching the application, so the cited bypass path does not exist in this deployment. |

### Learnings & Past Solutions

- [Known Pattern] `docs/solutions/export-pagination.md` -- previous export pagination fix applies to this endpoint

### Agent-Native Gaps

- New export endpoint has no CLI/agent equivalent -- agent users cannot trigger exports

### Schema Drift Check

- Clean: schema.rb changes match the migrations in scope

### Deployment Notes

- Pre-deploy: capture baseline row counts before enabling the export backfill
- Verify: `SELECT COUNT(*) FROM exports WHERE status IS NULL;` should stay at `0`
- Rollback: keep the old export path available until the backfill has been validated

### Coverage

- Suppressed: 2 findings below 0.60 confidence
- Residual risks: No rate limiting on export endpoint
- Testing gaps: No test for concurrent export requests

---

> **Verdict:** Ready with fixes
>
> **Reasoning:** 1 critical auth bypass must be fixed. The memory/pagination issues (P1) should be addressed for production safety.
>
> **Fix order:** P0 auth bypass -> P1 memory/pagination -> P2 error handling if straightforward
```

## Anti-patterns

Do NOT produce output like this. The following is wrong:

```markdown
Findings

Sev: P1
File: foo.go:42
Issue: Some problem description
Reviewer(s): adversarial
Confidence: 0.85
Route: advisory -> human
────────────────────────────────────────
Sev: P2
File: bar.go:99
Issue: Another problem
```

This fails because: no pipe-delimited tables, no severity-grouped `###` headers, uses box-drawing horizontal rules, no numbered findings, no `## Code Review Results` title, and the verdict is not in a blockquote. Always use the table format from the example above.

## Formatting Rules

- **Pipe-delimited markdown tables** for findings -- never ASCII box-drawing characters or per-finding horizontal-rule separators between entries (the report-level `---` before the verdict is still required)
- **Severity-grouped sections** -- `### P0 -- Critical`, `### P1 -- High`, `### P2 -- Moderate`, `### P3 -- Low`. Omit empty severity levels.
- **Always include file:line location** for code review issues
- **Reviewer column** shows which persona(s) submitted the issue. Multiple reviewers indicate independent submissions, not merely agreement credit. The machine-readable synthesis artifact keeps `submitters` separate from `agreement_credit`; do not infer submission from an agreement boost or from the display column alone.
- **Confidence column** shows the finding's confidence score
- **Route column** shows the synthesized handling decision as ``<autofix_class> -> <owner>``.
- **Header includes** scope, intent, and reviewer team with per-conditional justifications
- **Mode line** -- include `interactive`, `autofix`, `report-only`, or `headless`
- **Applied Fixes section** -- include only when a fix phase ran in this review invocation
- **Residual Actionable Work section** -- include only when unresolved actionable findings were handed off for later work
- **Pre-existing section** -- separate table, no confidence column (these are informational)
- **Filtered (not validated) section** -- findings where Stage 5b returned `validated: false`. Rendered as a pipe-delimited table with columns `#`, `File`, `Issue`, `Reviewer`, `Confidence`, `Validator reason`. These findings are surfaced for human review, not removed. Omit this section when Stage 5b produced no filtered findings.
- **Learnings & Past Solutions section** -- results from learnings-researcher, with links to docs/solutions/ files
- **Agent-Native Gaps section** -- results from agent-native-reviewer. Omit if no gaps found.
- **Deployment Notes section** -- key checklist items from deployment-verification-agent. Omit if the agent did not run.
- **Coverage section** -- suppressed count with original confidences, residual risks, testing gaps, failed reviewers, and disposition reconciliation
- **Summary uses blockquotes** for verdict, reasoning, and fix order
- **Horizontal rule** (`---`) separates findings from verdict
- **`###` headers** for each section -- never plain text headers

## Headless Mode Format

In `mode:headless`, replace the interactive pipe-delimited table report with a structured text envelope. The headless format is defined in the `### Headless output format` section of SKILL.md. Key differences from the interactive format:

- **No pipe-delimited tables.** Findings use `[severity][autofix_class -> owner] File: <file:line> -- <title>` line format with indented Why/Evidence/Suggested fix lines.
- **Findings grouped by autofix_class** (gated-auto, manual, advisory) instead of severity. Within each group, findings are sorted by severity.
- **Verdict in header** (top of output) instead of bottom, so programmatic callers get it first.
- **`Artifact:` line** in metadata header gives callers the path to `review-summary.json`, the full run artifact with provenance, dispatch outcomes, and disposition reconciliation.
- **`[needs-verification]` marker** on findings where `requires_verification: true`.
- **Evidence lines** included per finding.
- **"Filtered (not validated)" section** included when Stage 5b produced findings with `validated: false`. Uses `[severity][autofix_class -> owner] File: <file:line> -- <title>` format with an indented `Validator reason:` line. These findings are surfaced for human review, not removed.
- **Completion signal:** "Review complete" as the final line.

## Synthesis Artifact Contract

For interactive, autofix, and headless runs, the parent writes `.context/systematic/ce-review/<run-id>/review-summary.json` even when every selected persona returns `empty` and no finding survives. `mode:report-only` is the deliberate no-write exception.

The artifact must preserve the following distinctions:

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

- `dispatch_outcome` records what a persona returned: `findings`, `empty`, `malformed`, or `never_returned`. A rejection reason is preserved as the exact safe validation reason, naming persona and field without echoing the offending value.
- `disposition` records what happened to each input finding: `surviving`, `merged`, `suppressed`, `filtered`, or `rejected`. Every safely enumerable input has exactly one disposition and stated reason; the disposition counts must equal the input-finding count.
- `submitters` contains only personas with an input finding in the merged fingerprint group. `agreement_credit` contains only personas credited by the cross-reviewer agreement boost without an input finding in that group. A persona returning zero findings never appears in `submitters`.
- `filtered` findings remain available for human review with the validator's stated reason, but are not part of the surviving/actioned set. A suppressed finding retains its original confidence, including the P0 exception for confidence `0.50` or higher.
- The parent initializes the artifact as `in_progress` before dispatch. A completed run becomes `completed` or `degraded`; an interrupted or failed run is `abnormal` with its stated termination reason. An unfinished `in_progress` artifact is evidence of an abnormal run, not evidence of a clean run.
