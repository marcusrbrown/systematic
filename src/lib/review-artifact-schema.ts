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
  'validation_unavailable dispatches must record zero input findings',
  'a completed run must not contain validation_unavailable evidence',
  'a validation_unavailable persona must not have an input finding',
  'every synthesized input finding ID must resolve to an admitted ledger row',
  'every provenance submitter must be represented by a cited admitted ledger row',
  'satisfied risk coverage must cite an admitted ledger row',
  'duplicate admitted input finding IDs are not allowed',
  'every cited admitted reviewer must appear in provenance.submitters',
  'provenance.submitters must not contain duplicate reviewers',
  'provenance.agreement_credit must not contain duplicate reviewers',
  'provenance.agreement_credit must not overlap provenance.submitters',
  'provenance.agreement_credit requires an eligible returned persona with admitted evidence',
  'satisfied risk coverage must cite a validated finding on the lost persona selection surface',
] as const

const boundedText = (maxLength: number) =>
  z.string().min(1).max(maxLength).regex(/\S/)

// Final schema-version-1 line identity: a safe positive integer shared by the
// raw/parent and synthesized finding contracts. Keeping the bound on both sides
// preserves the published v1 behavior and ensures every admitted raw line is
// representable in the final artifact without distinct lexical citations
// collapsing past Number.MAX_SAFE_INTEGER.
const LineNumberSchema = z.number().int().positive()

export const DispatchOutcomeSchema = z.enum([
  'findings',
  'empty',
  'malformed',
  'never_returned',
  'validation_unavailable',
] as const)

// A rejected-payload summary requires at least one rejected finding, so it has
// no meaning for an outcome where no payload was returned or enumerated:
// `validation_unavailable` can never carry one. `never_returned` and `empty`
// are intentionally accepted only for backward compatibility with historical
// schema_version 1 artifacts, which permitted them; neither is a semantically
// valid rejected-summary outcome and the prose contract still forbids new
// writers from emitting them.
const RejectedSummaryDispatchOutcomeSchema = DispatchOutcomeSchema.exclude([
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
    line: LineNumberSchema,
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
  .superRefine((artifact, ctx) => {
    const unavailablePersonas = new Set(
      artifact.dispatches
        .filter(
          (dispatch) => dispatch.dispatch_outcome === 'validation_unavailable',
        )
        .map((dispatch) => dispatch.persona),
    )

    // Unavailable-specific lifecycle rules are the only checks gated on
    // withheld evidence. Referential integrity below applies to every artifact.
    if (unavailablePersonas.size > 0) {
      // Unavailable evidence can never finalize as a clean, completed run.
      if (artifact.run_status === 'completed') {
        ctx.addIssue({
          code: 'custom',
          path: ['run_status'],
          message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[7],
        })
      }

      artifact.dispatches.forEach((dispatch, index) => {
        if (
          dispatch.dispatch_outcome === 'validation_unavailable' &&
          dispatch.input_finding_count !== 0
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['dispatches', index, 'input_finding_count'],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[6],
          })
        }
      })

      artifact.input_findings.forEach((finding, index) => {
        // No ledger row of either record type may name a persona whose payload
        // was withheld: unavailable evidence is neither admitted nor rejected.
        if (unavailablePersonas.has(finding.reviewer)) {
          ctx.addIssue({
            code: 'custom',
            path: ['input_findings', index, 'reviewer'],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[8],
          })
        }
      })
    }

    // Global referential integrity: synthesized evidence must resolve back to
    // the admitted ledger regardless of whether any return was withheld. Build
    // the ownership map only after rejecting duplicate IDs so evidence
    // ownership never depends on row order.
    const admittedById = new Map<string, string>()
    artifact.input_findings.forEach((finding, index) => {
      if (finding.record_type !== 'admitted') {
        return
      }
      if (admittedById.has(finding.input_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['input_findings', index, 'input_id'],
          message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[12],
        })
        return
      }
      admittedById.set(finding.input_id, finding.reviewer)
    })

    const admittedReviewers = new Set(admittedById.values())
    const eligibleAgreementPersonas = new Set(
      artifact.dispatches
        .filter(
          (dispatch) =>
            dispatch.dispatch_outcome === 'findings' &&
            admittedReviewers.has(dispatch.persona),
        )
        .map((dispatch) => dispatch.persona),
    )

    artifact.findings.forEach((finding, findingIndex) => {
      const citedAdmittedReviewers = new Set<string>()
      finding.input_finding_ids.forEach((inputId, idIndex) => {
        const owner = admittedById.get(inputId)
        if (owner === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['findings', findingIndex, 'input_finding_ids', idIndex],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[9],
          })
          return
        }
        citedAdmittedReviewers.add(owner)
      })

      // Submitter set equality: reject unsupported, missing, and duplicate
      // entries against the reviewers implied by the cited admitted rows.
      const seenSubmitters = new Set<string>()
      finding.provenance.submitters.forEach((submitter, submitterIndex) => {
        if (seenSubmitters.has(submitter)) {
          ctx.addIssue({
            code: 'custom',
            path: [
              'findings',
              findingIndex,
              'provenance',
              'submitters',
              submitterIndex,
            ],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[14],
          })
        }
        seenSubmitters.add(submitter)

        if (!citedAdmittedReviewers.has(submitter)) {
          ctx.addIssue({
            code: 'custom',
            path: [
              'findings',
              findingIndex,
              'provenance',
              'submitters',
              submitterIndex,
            ],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[10],
          })
        }
      })

      for (const reviewer of citedAdmittedReviewers) {
        if (!seenSubmitters.has(reviewer)) {
          ctx.addIssue({
            code: 'custom',
            path: ['findings', findingIndex, 'provenance', 'submitters'],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[13],
          })
        }
      }

      // Agreement credit: unique, disjoint from submitters, and backed by an
      // eligible returned persona with admitted evidence. It need not cite a
      // row of its own -- the contract permits credit without an input finding
      // in the merge.
      const seenAgreementCredit = new Set<string>()
      finding.provenance.agreement_credit.forEach((credit, creditIndex) => {
        if (seenAgreementCredit.has(credit)) {
          ctx.addIssue({
            code: 'custom',
            path: [
              'findings',
              findingIndex,
              'provenance',
              'agreement_credit',
              creditIndex,
            ],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[15],
          })
        }
        seenAgreementCredit.add(credit)

        if (seenSubmitters.has(credit)) {
          ctx.addIssue({
            code: 'custom',
            path: [
              'findings',
              findingIndex,
              'provenance',
              'agreement_credit',
              creditIndex,
            ],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[16],
          })
        }

        if (!eligibleAgreementPersonas.has(credit)) {
          ctx.addIssue({
            code: 'custom',
            path: [
              'findings',
              findingIndex,
              'provenance',
              'agreement_credit',
              creditIndex,
            ],
            message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[17],
          })
        }
      })
    })

    artifact.risk_coverage?.forEach((coverage, coverageIndex) => {
      if (!coverage.satisfied) {
        return
      }
      const citedId = coverage.input_finding_id
      if (citedId === undefined) {
        return
      }

      const owner = admittedById.get(citedId)
      if (owner === undefined || unavailablePersonas.has(owner)) {
        ctx.addIssue({
          code: 'custom',
          path: ['risk_coverage', coverageIndex, 'input_finding_id'],
          message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[11],
        })
        return
      }

      // The citation must resolve to a validated synthesized finding whose file
      // belongs to the failed persona's recorded selection surface.
      const lostDispatch = artifact.dispatches.find(
        (dispatch) => dispatch.persona === coverage.persona,
      )
      const surface = lostDispatch?.selection_surface ?? []
      const covered = artifact.findings.some(
        (finding) =>
          finding.input_finding_ids.includes(citedId) &&
          finding.validated !== false &&
          surface.includes(finding.file),
      )
      if (!covered) {
        ctx.addIssue({
          code: 'custom',
          path: ['risk_coverage', coverageIndex, 'input_finding_id'],
          message: REVIEW_ARTIFACT_CUSTOM_MESSAGES[18],
        })
      }
    })
  })

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
    line: LineNumberSchema.describe('Primary line number of the issue'),
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
