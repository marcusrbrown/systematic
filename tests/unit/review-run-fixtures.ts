import {
  MAX_FINDINGS,
  ReviewArtifactSchema,
} from '../../src/lib/review-artifact-schema.js'
import {
  type ApplyReviewAdjudicationResult,
  applyReviewAdjudication,
  type FinalizeReviewInput,
  type FinalizeReviewResult,
  finalizeReview,
  type PrepareOutput,
  type PrepareReviewCandidatesResult,
  prepareReviewCandidates,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'
import { FinalizeOutputSchema } from '../../src/lib/review-pipeline-contract.js'

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

// --- end-to-end pipeline fixtures -------------------------------------------

export interface PipelineFindingSpec {
  readonly file: string
  readonly line?: number
  readonly severity?: 'P0' | 'P1' | 'P2' | 'P3'
  readonly owner?: 'downstream-resolver' | 'review-fixer' | 'release'
  readonly requiresVerification?: boolean
  readonly title?: string
  /** Replaces the default impact text, to size a finding. */
  readonly whyItMatters?: string
  /** Replaces the default evidence entries, to size a finding. */
  readonly evidence?: readonly string[]
}

export interface PipelineReviewerSpec {
  readonly reviewer: string
  readonly findings: readonly PipelineFindingSpec[]
  readonly residualRisks?: readonly string[]
  readonly testingGaps?: readonly string[]
}

/**
 * One reviewer's raw `SubAgentReturn`, as the persona would emit it. Findings
 * default to a gated, low-severity, verification-free shape so a run only
 * produces validator requests when a spec asks for them.
 */
export function buildScreenReturn(spec: PipelineReviewerSpec): JsonObject {
  return {
    reviewer: spec.reviewer,
    findings: spec.findings.map((finding, index) => ({
      title: finding.title ?? `Example issue ${spec.reviewer} ${index}`,
      severity: finding.severity ?? 'P3',
      file: finding.file,
      line: finding.line ?? index + 1,
      why_it_matters:
        finding.whyItMatters ??
        'The example path can fail during normal execution.',
      autofix_class: 'manual',
      owner: finding.owner ?? 'downstream-resolver',
      requires_verification: finding.requiresVerification ?? false,
      confidence: 0.85,
      evidence: finding.evidence ?? [
        `${finding.file}:1 demonstrates the failure path.`,
      ],
      pre_existing: false,
      suggested_fix: 'Handle the failure before continuing.',
    })),
    residual_risks: [...(spec.residualRisks ?? [])],
    testing_gaps: [...(spec.testingGaps ?? [])],
  }
}

type Decisions = Parameters<typeof applyReviewAdjudication>[0]['decisions']

/** Declines every candidate-group member as its own singleton. */
export function declineEveryGroupMember(prepared: PrepareOutput): Decisions {
  return prepared.candidate_groups.flatMap((group) =>
    group.members.map((member) => ({
      decision_id: `declined-${member.input_id}`,
      disposition: 'declined' as const,
      input_finding_id: member.input_id,
      declined_reason: 'The reviewers did not describe the same problem.',
    })),
  )
}

/** Merges every candidate group into one finding. */
export function mergeEveryGroup(prepared: PrepareOutput): Decisions {
  return prepared.candidate_groups.map((group, index) => ({
    decision_id: `merged-${index}`,
    disposition: 'merged' as const,
    input_finding_ids: group.members.map((member) => member.input_id),
    title: `Merged issue ${index}`,
    why_it_matters: 'Several reviewers described the same failure.',
    evidence: [`${group.file}:1 demonstrates the failure path.`],
    line: group.members[0]?.line ?? 1,
  }))
}

export interface RunPipelineOptions {
  readonly reviewers: readonly PipelineReviewerSpec[]
  readonly mode?: 'interactive' | 'report-only'
  /** Adjudication for the prepared candidate groups. Defaults to declining
   * every group member, so a run with groups still satisfies the partition. */
  readonly decide?: (prepared: PrepareOutput) => Decisions
  /** Validator outcome for the n-th request. Defaults to `true`. */
  readonly validatorOutcome?: (
    index: number,
  ) => 'true' | 'false' | 'failed' | 'unavailable'
  /** Distinct facts attached to every declined decision. */
  readonly factsPerDecision?: number
}

export interface PipelineRun {
  readonly prepare: PrepareReviewCandidatesResult
  readonly merge?: ApplyReviewAdjudicationResult
  readonly finalize?: FinalizeReviewResult
  /** The finalize result after `ReviewArtifactSchema` and
   * `FinalizeOutputSchema` parsed it, when the run reached a writing result. */
  readonly parsed?: { readonly artifactOk: boolean; readonly outputOk: boolean }
}

/**
 * Drives the real chain: screen, prepare, adjudicate (merge), finalize, then
 * the artifact and finalize-output schemas. Stops at the first rejection and
 * returns every phase result reached so far.
 */
export function runPipeline(options: RunPipelineOptions): PipelineRun {
  const dispatches = options.reviewers.map((spec) => ({
    persona: spec.reviewer,
    dispatch_outcome: 'findings' as const,
  }))
  const screenResults = options.reviewers.map((spec) => ({
    reviewer: spec.reviewer,
    result: screenReviewReturn({
      raw_return: JSON.stringify(buildScreenReturn(spec)),
      expected_reviewer: spec.reviewer,
      invoking_harness: 'opencode',
    }),
  }))

  const prepare = prepareReviewCandidates({
    raw_input: {
      screen_results: screenResults,
      selected_dispatches: dispatches,
    },
  })
  if (!prepare.ok) return { prepare }

  const decide = options.decide ?? declineEveryGroupMember
  const decisions = decide(prepare.value).map((decision) =>
    options.factsPerDecision !== undefined &&
    decision.disposition === 'declined'
      ? {
          ...decision,
          disagreement_facts: Array.from(
            { length: options.factsPerDecision },
            (_, index) => `Fact ${decision.decision_id} ${index}.`,
          ),
        }
      : decision,
  )
  const merge = applyReviewAdjudication({
    prepared: prepare.value,
    decisions,
  })
  if (!merge.ok) return { prepare, merge }

  const outcome = options.validatorOutcome ?? (() => 'true' as const)
  const lifecycle = merge.value.validator_requests.map((request, index) => {
    const kind = outcome(index)
    return {
      finding_id: request.finding_id,
      result:
        kind === 'true'
          ? { outcome: 'true' as const }
          : { outcome: kind, reason: `Validator ${kind} for ${index}.` },
    }
  })

  const finalizeInput: FinalizeReviewInput = {
    merge: merge.value,
    prepared: prepare.value,
    screen_results: screenResults,
    dispatch_records: dispatches,
    validator_lifecycle_results: lifecycle,
    plan_assessment: { verdict: 'All requirements met.', results: [] },
    parent_run_metadata: {
      run_id: 'run-scale',
      mode: options.mode ?? 'interactive',
      harness: 'opencode',
      branch: 'main',
      head_sha: 'a'.repeat(40),
      selected_dispatches: dispatches,
      timestamps: {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:05:00.000Z',
      },
      validation: { status: 'not_attempted', reason: 'no autofix applied' },
      applied_fixes: [],
    },
  }
  const finalize = finalizeReview(finalizeInput)
  if (!finalize.ok) return { prepare, merge, finalize }

  const outputOk = FinalizeOutputSchema.safeParse(finalize.value).success
  const artifactOk =
    finalize.value.kind === 'writing'
      ? ReviewArtifactSchema.safeParse(finalize.value.artifact).success
      : true
  return { prepare, merge, finalize, parsed: { artifactOk, outputOk } }
}
