import { z } from 'zod'

const MAX_REVIEWER_LENGTH = 64
const MAX_RUN_ID_LENGTH = 64
const MAX_BRANCH_LENGTH = 256
const MAX_INPUT_ID_LENGTH = 128
const MAX_REASON_LENGTH = 2048
const MAX_FINDINGS = 32
const MAX_PERSONAS = 64

export const REVIEW_ARTIFACT_CUSTOM_MESSAGES = [
  'severity count must match rejected finding count',
  'filtered findings require a validation reason',
  'risk-critical dispatches require a non-empty selection surface',
  'satisfied risk coverage requires a citing input finding ID',
  'unsatisfied risk coverage must not cite an input finding ID',
  'passed validation must not include a reason; non-passed validation requires a reason',
] as const

const boundedText = (maxLength: number) =>
  z.string().min(1).max(maxLength).regex(/\S/)

export const DispatchOutcomeSchema = z.enum([
  'findings',
  'empty',
  'malformed',
  'never_returned',
  'validation_unavailable',
] as const)

// A rejected-payload summary requires at least one rejected finding, so it has
// no meaning for an outcome where no payload was returned or enumerated:
// `never_returned` and `validation_unavailable` can never carry one. `empty`
// is intentionally accepted only for backward compatibility with schema_version
// 1 artifacts, which permitted it; it is not a semantically valid rejected-summary
// outcome and the prose contract still forbids it.
const RejectedSummaryDispatchOutcomeSchema = DispatchOutcomeSchema.exclude([
  'never_returned',
  'validation_unavailable',
])

export const DispositionSchema = z.enum([
  'surviving',
  'merged',
  'suppressed',
  'filtered',
  'rejected',
] as const)

const AdmittedDispositionSchema = DispositionSchema.exclude(['rejected'])

export const HarnessSchema = z.enum(['opencode', 'pi', 'claude-code'] as const)

export const RepoRelativePathSchema = boundedText(256).regex(
  /^(?!\/)(?![A-Za-z]:[\\/])(?!\\).+/,
)

const ReviewerSchema = boundedText(MAX_REVIEWER_LENGTH)
const BranchSchema = z.string().max(MAX_BRANCH_LENGTH)
const HeadShaSchema = z.string().regex(/^[0-9a-f]{40}$/)
const CompletedAtSchema = z.iso.datetime({ offset: false })
const ReasonSchema = boundedText(MAX_REASON_LENGTH)
const RISK_CRITICAL_PERSONAS = [
  'security',
  'data-migrations',
  'api-contract',
  'reliability',
  'performance',
] as const
const RiskCriticalPersonaSchema = z.enum(RISK_CRITICAL_PERSONAS)
const FindingTitleSchema = boundedText(256)
const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3', 'unknown'] as const)
const FindingSeveritySchema = SeveritySchema.exclude(['unknown'])
const AutofixClassSchema = z.enum([
  'safe_auto',
  'gated_auto',
  'manual',
  'advisory',
] as const)
const OwnerSchema = z.enum([
  'review-fixer',
  'downstream-resolver',
  'human',
  'release',
] as const)

const BoundedEvidenceStringSchema = boundedText(500).regex(
  /^(?!\/)(?![A-Za-z]:[\\/])(?!\\).+/,
)

const OverflowEvidenceSchema = z
  .object({
    overflow: z.literal(true),
    excerpt: BoundedEvidenceStringSchema,
  })
  .strict()

const EvidenceSchema = z
  .array(z.union([BoundedEvidenceStringSchema, OverflowEvidenceSchema]))
  .min(1)
  .max(5)

const AdmittedInputFindingSchema = z
  .object({
    record_type: z.literal('admitted'),
    input_id: boundedText(MAX_INPUT_ID_LENGTH),
    reviewer: ReviewerSchema,
    confidence: z.number().min(0).max(1),
    disposition: AdmittedDispositionSchema,
    reason: ReasonSchema,
  })
  .strict()

const RejectedInputFindingSchema = z
  .object({
    record_type: z.literal('rejected_summary'),
    reviewer: ReviewerSchema,
    dispatch_outcome: RejectedSummaryDispatchOutcomeSchema,
    rejected_finding_count: z.number().int().positive().max(MAX_FINDINGS),
    rejected_severities: z.array(SeveritySchema).max(MAX_FINDINGS),
    disposition: DispositionSchema.extract(['rejected']),
    reason: ReasonSchema,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.rejected_severities.length !== row.rejected_finding_count) {
      ctx.addIssue({
        code: 'custom',
        path: ['rejected_severities'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[0],
      })
    }
  })

export const InputFindingSchema = z.discriminatedUnion('record_type', [
  AdmittedInputFindingSchema,
  RejectedInputFindingSchema,
])

const ProvenanceSchema = z
  .object({
    fingerprint: boundedText(512),
    submitters: z.array(ReviewerSchema).max(MAX_PERSONAS),
    agreement_credit: z.array(ReviewerSchema).max(MAX_PERSONAS),
  })
  .strict()

const SynthesizedFindingFieldsSchema = z
  .object({
    title: FindingTitleSchema,
    severity: FindingSeveritySchema,
    file: RepoRelativePathSchema,
    line: z.number().int().positive(),
    why_it_matters: boundedText(2048),
    autofix_class: AutofixClassSchema,
    owner: OwnerSchema,
    requires_verification: z.boolean(),
    confidence: z.number().min(0).max(1),
    evidence: EvidenceSchema,
    pre_existing: z.boolean(),
    suggested_fix: z.string().max(2048).nullable().optional(),
    validated: z.boolean().optional(),
    validation_reason: ReasonSchema.optional(),
    input_finding_ids: z
      .array(boundedText(MAX_INPUT_ID_LENGTH))
      .min(1)
      .max(MAX_FINDINGS),
    provenance: ProvenanceSchema,
  })
  .strict()

type SynthesizedFindingFields = z.infer<typeof SynthesizedFindingFieldsSchema>

type SynthesizedFinding = Omit<
  SynthesizedFindingFields,
  'validated' | 'validation_reason'
> &
  (
    | {
        validated: false
        validation_reason: string
      }
    | {
        validated?: true
        validation_reason?: string
      }
  )

const SynthesizedFindingSchema = SynthesizedFindingFieldsSchema.superRefine(
  (finding, ctx) => {
    if (
      finding.validated === false &&
      finding.validation_reason === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['validation_reason'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[1],
      })
    }
  },
) as z.ZodType<SynthesizedFinding, SynthesizedFindingFields>

const DispatchSchema = z
  .object({
    persona: ReviewerSchema,
    dispatch_outcome: DispatchOutcomeSchema,
    input_finding_count: z.number().int().nonnegative().max(MAX_FINDINGS),
    rejection_reason: ReasonSchema.optional(),
    selection_surface: z
      .array(RepoRelativePathSchema)
      .max(MAX_FINDINGS)
      .optional(),
    selection_reason: ReasonSchema.optional(),
  })
  .strict()
  .superRefine((dispatch, ctx) => {
    if (
      (RISK_CRITICAL_PERSONAS as readonly string[]).includes(
        dispatch.persona,
      ) &&
      (!dispatch.selection_surface || dispatch.selection_surface.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['selection_surface'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[2],
      })
    }
  })

const DispositionCountsSchema = z
  .object({
    surviving: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FINDINGS * MAX_PERSONAS),
    merged: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FINDINGS * MAX_PERSONAS),
    suppressed: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FINDINGS * MAX_PERSONAS),
    filtered: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FINDINGS * MAX_PERSONAS),
    rejected: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FINDINGS * MAX_PERSONAS),
  })
  .strict()

const CoverageSchema = z
  .object({
    reviewers: z.number().int().nonnegative().max(MAX_PERSONAS).optional(),
    validators: z.number().int().nonnegative().max(MAX_PERSONAS).optional(),
    residual_risks: z.array(ReasonSchema).max(MAX_PERSONAS),
    testing_gaps: z.array(ReasonSchema).max(MAX_PERSONAS),
    failed_reviewers: z.array(ReviewerSchema).max(MAX_PERSONAS),
    validator_failures: z.array(ReasonSchema).max(MAX_PERSONAS),
    intent_uncertainty: z.array(ReasonSchema).max(MAX_PERSONAS),
  })
  .strict()

const DeclinedMergeSchema = z
  .object({
    file: RepoRelativePathSchema,
    input_finding_ids: z
      .array(boundedText(MAX_INPUT_ID_LENGTH))
      .min(2)
      .max(MAX_FINDINGS),
    reason: ReasonSchema,
  })
  .strict()

const ValidationSchema = z
  .object({
    status: z.enum([
      'passed',
      'failed',
      'unavailable',
      'not_attempted',
    ] as const),
    reason: ReasonSchema.optional(),
  })
  .strict()
  .superRefine((validation, ctx) => {
    if (validation.status === 'passed' && validation.reason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[5],
      })
    }

    if (validation.status !== 'passed' && validation.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[5],
      })
    }
  })

const RiskCoverageSchema = z
  .object({
    persona: RiskCriticalPersonaSchema,
    satisfied: z.boolean(),
    input_finding_id: boundedText(MAX_INPUT_ID_LENGTH).optional(),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    if (coverage.satisfied && coverage.input_finding_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['input_finding_id'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[3],
      })
    }

    if (!coverage.satisfied && coverage.input_finding_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['input_finding_id'],
        message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[4],
      })
    }
  })

export const ReviewArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: boundedText(MAX_RUN_ID_LENGTH),
    branch: BranchSchema,
    head_sha: HeadShaSchema,
    mode: z.enum(['interactive', 'autofix', 'headless'] as const),
    harness: HarnessSchema,
    run_status: z.enum([
      'in_progress',
      'completed',
      'degraded',
      'abnormal',
    ] as const),
    verdict: boundedText(256),
    completed_at: CompletedAtSchema,
    dispatches: z.array(DispatchSchema).max(MAX_PERSONAS),
    input_findings: z
      .array(InputFindingSchema)
      .max(MAX_FINDINGS * MAX_PERSONAS),
    findings: z.array(SynthesizedFindingSchema).max(MAX_FINDINGS),
    declined_merges: z.array(DeclinedMergeSchema).max(MAX_FINDINGS).optional(),
    risk_coverage: z.array(RiskCoverageSchema).max(MAX_PERSONAS).optional(),
    disposition_counts: DispositionCountsSchema,
    applied_fixes: z.array(ReasonSchema).max(MAX_FINDINGS),
    residual_actionable_work: z.array(ReasonSchema).max(MAX_FINDINGS),
    advisory_outputs: z.array(ReasonSchema).max(MAX_FINDINGS),
    coverage: CoverageSchema,
    validation: ValidationSchema.optional(),
  })
  .strict()

export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>

// --- Raw reviewer return and parent-persisted record contracts --------------
//
// These schemas are the executable source for the `ce:review`
// `subAgentReturn` and `parentRecord` JSON Schema contracts. Descriptions are
// attached to dedicated schema instances so prompt-facing metadata is preserved
// without changing the aggregate `ReviewArtifactSchema` projection.

const MAX_RAW_RISK_LENGTH = 1024
const RAW_FINDINGS_LIST_DESCRIPTION =
  'List of code review findings. Empty array if no issues found.'

const RawReviewerSchema = ReviewerSchema.describe(
  "Persona name that produced this output (e.g., 'correctness', 'security')",
)
const RawHarnessSchema = HarnessSchema.describe(
  'Harness that produced the artifact; populated by the parent orchestrator',
)
const RawDispatchOutcomeSchema = DispatchOutcomeSchema.describe(
  'What a persona returned: findings, empty, malformed, or never returned',
)
const RawDispositionSchema = DispositionSchema.describe(
  'What happened to an input finding: surviving, merged, suppressed, filtered, or rejected',
)

const RawResidualRisksSchema = z
  .array(z.string().max(MAX_RAW_RISK_LENGTH))
  .max(MAX_PERSONAS)
  .describe('Risks the reviewer noticed but could not confirm as findings')
const RawTestingGapsSchema = z
  .array(z.string().max(MAX_RAW_RISK_LENGTH))
  .max(MAX_PERSONAS)
  .describe('Missing test coverage the reviewer identified')

const RawEvidenceStringSchema = BoundedEvidenceStringSchema.describe(
  'Bounded code-grounded evidence; absolute POSIX, drive-letter, and UNC paths are rejected',
)
const RawOverflowExcerptSchema = BoundedEvidenceStringSchema.describe(
  'Bounded excerpt retained when evidence must be shortened',
)
const RawOverflowEvidenceSchema = z
  .object({
    overflow: z
      .literal(true)
      .describe(
        'Explicit marker that the complete evidence did not fit in one bounded entry',
      ),
    excerpt: RawOverflowExcerptSchema,
  })
  .strict()
const RawEvidenceSchema = z
  .array(z.union([RawEvidenceStringSchema, RawOverflowEvidenceSchema]))
  .min(1)
  .max(5)
  .describe(
    'Code-grounded evidence. At least 1 and at most 5 bounded entries; split evidence across entries or use an explicit overflow marker rather than silently truncating it.',
  )

const RawFindingFieldsSchema = z
  .object({
    title: FindingTitleSchema.describe(
      'Short, specific issue title. 10 words or fewer.',
    ),
    severity: FindingSeveritySchema.describe('Issue severity level'),
    file: RepoRelativePathSchema.describe(
      'Relative file path from repository root; absolute POSIX, drive-letter, and UNC paths are rejected',
    ),
    // Integer >= 1 without Zod's implicit safe-integer maximum, which the
    // committed raw/parent contract does not impose. `multipleOf(1)` enforces
    // the integer constraint at the JSON Schema boundary.
    line: z
      .number()
      .min(1)
      .multipleOf(1)
      .describe('Primary line number of the issue'),
    why_it_matters: boundedText(2048).describe(
      "Non-empty impact and failure mode -- not 'what is wrong' but 'what breaks'",
    ),
    autofix_class: AutofixClassSchema.describe(
      "Reviewer's conservative recommendation for how this issue should be handled after synthesis",
    ),
    owner: OwnerSchema.describe(
      'Who should own the next action for this finding after synthesis',
    ),
    requires_verification: z
      .boolean()
      .describe(
        'Whether any fix for this finding must be re-verified with targeted tests or a follow-up review pass',
      ),
    suggested_fix: z
      .string()
      .max(2048)
      .nullable()
      .optional()
      .describe(
        'Concrete minimal fix. Omit or null if no good fix is obvious -- a bad suggestion is worse than none.',
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('Reviewer confidence in this finding, calibrated per persona'),
    evidence: RawEvidenceSchema,
    pre_existing: z
      .boolean()
      .describe(
        'True if this issue exists in unchanged code unrelated to the current diff',
      ),
  })
  .strict()

/** A single finding as returned by a reviewer persona. */
export const SubAgentFindingSchema = RawFindingFieldsSchema

/** A finding after the parent adds its disposition; parent-owned. */
export const ParentFindingSchema = RawFindingFieldsSchema.extend({
  disposition: RawDispositionSchema,
}).strict()

/** The raw return contract a reviewer persona must satisfy. */
export const SubAgentReturnSchema = z
  .object({
    reviewer: RawReviewerSchema,
    findings: z
      .array(SubAgentFindingSchema)
      .max(MAX_FINDINGS)
      .describe(RAW_FINDINGS_LIST_DESCRIPTION),
    residual_risks: RawResidualRisksSchema,
    testing_gaps: RawTestingGapsSchema,
  })
  .strict()

/** The parent-persisted record contract; adds harness and dispatch outcome. */
export const ParentRecordSchema = z
  .object({
    reviewer: RawReviewerSchema,
    harness: RawHarnessSchema,
    dispatch_outcome: RawDispatchOutcomeSchema,
    findings: z
      .array(ParentFindingSchema)
      .max(MAX_FINDINGS)
      .describe(RAW_FINDINGS_LIST_DESCRIPTION),
    residual_risks: RawResidualRisksSchema,
    testing_gaps: RawTestingGapsSchema,
  })
  .strict()
