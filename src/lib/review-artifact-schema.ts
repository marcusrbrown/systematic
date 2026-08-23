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
] as const

const boundedText = (maxLength: number) =>
  z.string().min(1).max(maxLength).regex(/\S/)

export const DispatchOutcomeSchema = z.enum([
  'findings',
  'empty',
  'malformed',
  'never_returned',
] as const)

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
    dispatch_outcome: DispatchOutcomeSchema,
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
  })
  .strict()

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
    disposition_counts: DispositionCountsSchema,
    applied_fixes: z.array(ReasonSchema).max(MAX_FINDINGS),
    residual_actionable_work: z.array(ReasonSchema).max(MAX_FINDINGS),
    advisory_outputs: z.array(ReasonSchema).max(MAX_FINDINGS),
    coverage: CoverageSchema,
  })
  .strict()

export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>
