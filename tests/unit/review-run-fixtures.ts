import { MAX_FINDINGS } from '../../src/lib/review-artifact-schema.js'

type JsonObject = Record<string, unknown>

export interface MinimalArtifactOptions {
  /** How many synthesized findings the artifact carries. */
  readonly findings: number
}

// Ledger rows stay under the per-run product so a probe one past the findings
// bound still has a legal ledger: extra findings cite existing rows.
const LEDGER_ROWS_PER_REVIEWER = MAX_FINDINGS

/**
 * A schema-valid artifact with `findings` synthesized findings whose
 * referential integrity holds: every cited input ID resolves to an admitted
 * ledger row, and every provenance submitter is the reviewer of a cited row.
 * Reviewer names avoid the risk-critical personas, so no selection surface is
 * required. Findings beyond the ledger size cite existing rows.
 */
export function buildMinimalArtifact(
  options: MinimalArtifactOptions,
): JsonObject {
  const { findings } = options
  const reviewerCount = Math.max(
    1,
    Math.min(64, Math.ceil(findings / LEDGER_ROWS_PER_REVIEWER)),
  )
  const ledgerSize = Math.min(
    findings,
    reviewerCount * LEDGER_ROWS_PER_REVIEWER,
  )
  const reviewerOf = (row: number): string =>
    `reviewer-${Math.floor(row / LEDGER_ROWS_PER_REVIEWER)}`
  const inputIdOf = (row: number): string => `${reviewerOf(row)}#${row}`

  const inputFindings = Array.from({ length: ledgerSize }, (_, row) => ({
    record_type: 'admitted',
    input_id: inputIdOf(row),
    reviewer: reviewerOf(row),
    confidence: 0.85,
    disposition: 'surviving',
    reason: 'The finding passed the confidence gate.',
  }))

  const dispatches = Array.from({ length: reviewerCount }, (_, index) => ({
    persona: `reviewer-${index}`,
    dispatch_outcome: 'findings',
    input_finding_count: Math.min(
      LEDGER_ROWS_PER_REVIEWER,
      ledgerSize - index * LEDGER_ROWS_PER_REVIEWER,
    ),
  }))

  const synthesized = Array.from({ length: findings }, (_, index) => {
    const row = index % Math.max(1, ledgerSize)
    return {
      title: `Example issue ${index}`,
      severity: 'P2',
      file: 'src/example.ts',
      line: index + 1,
      why_it_matters: 'The example path can fail during normal execution.',
      autofix_class: 'manual',
      owner: 'downstream-resolver',
      requires_verification: false,
      confidence: 0.85,
      evidence: ['src/example.ts:1 demonstrates the failure path.'],
      pre_existing: false,
      suggested_fix: 'Handle the failure before continuing.',
      validated: true,
      input_finding_ids: [inputIdOf(row)],
      provenance: {
        fingerprint: `src/example.ts|${index}`,
        submitters: [reviewerOf(row)],
        agreement_credit: [],
      },
    }
  })

  return {
    schema_version: 1,
    run_id: '20260821-000000-example',
    mode: 'interactive',
    harness: 'opencode',
    run_status: 'completed',
    verdict: 'Ready to merge',
    branch: 'fix/example',
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    completed_at: '2026-08-21T00:00:00Z',
    dispatches,
    input_findings: inputFindings,
    findings: synthesized,
    disposition_counts: {
      surviving: ledgerSize,
      merged: 0,
      suppressed: 0,
      filtered: 0,
      rejected: 0,
    },
    applied_fixes: [],
    residual_actionable_work: [],
    advisory_outputs: [],
    coverage: {
      reviewers: reviewerCount,
      residual_risks: [],
      testing_gaps: [],
      failed_reviewers: [],
      validator_failures: [],
      intent_uncertainty: [],
    },
  }
}
