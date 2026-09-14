import { z } from 'zod'
import {
  DispatchOutcomeSchema,
  DispositionSchema,
  HarnessSchema,
  MAX_FINDINGS,
  MAX_INPUT_ID_LENGTH,
  MAX_PERSONAS,
  MAX_REASON_LENGTH,
  ParentFindingSchema,
  ProvenanceSchema,
  RepoRelativePathSchema,
  ReviewArtifactSchema,
  SeveritySchema,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'

// --- Shared leaves -----------------------------------------------------
//
// These are new concepts introduced by the pipeline (stable input IDs,
// pipeline-local reasons) rather than restatements of existing artifact
// leaves, so they get their own bounded schemas built from the promoted
// numeric bounds in `review-artifact-schema.ts`. Everything else below
// (reviewer identity, finding fields, dispatch outcome, disposition,
// harness, file paths) is reused directly from that module's exported
// schemas rather than re-declared here.

const boundedText = (maxLength: number) =>
  z.string().min(1).max(maxLength).regex(/\S/)

const PipelineInputIdSchema = boundedText(MAX_INPUT_ID_LENGTH)
const PipelineReasonSchema = boundedText(MAX_REASON_LENGTH)

const RejectedSummaryDispatchOutcomeSchema = DispatchOutcomeSchema.exclude([
  'validation_unavailable',
])

const AdmittedScreenDispositionSchema = DispositionSchema.exclude(['rejected'])

// --- Screen envelope -----------------------------------------------------
//
// Input: one raw reviewer payload plus the parent-supplied expected reviewer
// and invoking harness. Output: dispatch outcome, admitted parent findings
// carrying stable input IDs, a safe rejected summary, residual risks, and
// testing gaps.

export const ScreenInputSchema = z
  .object({
    raw_return: SubAgentReturnSchema,
    expected_reviewer: SubAgentReturnSchema.shape.reviewer,
    invoking_harness: HarnessSchema,
  })
  .strict()

const AdmittedScreenFindingSchema = ParentFindingSchema.extend({
  input_id: PipelineInputIdSchema,
  disposition: AdmittedScreenDispositionSchema,
}).strict()

export const ScreenRejectedSummarySchema = z
  .object({
    dispatch_outcome: RejectedSummaryDispatchOutcomeSchema,
    rejected_finding_count: z.number().int().positive().max(MAX_FINDINGS),
    rejected_severities: z.array(SeveritySchema).max(MAX_FINDINGS),
    reason: PipelineReasonSchema,
  })
  .strict()
  .superRefine((summary, ctx) => {
    if (summary.rejected_severities.length !== summary.rejected_finding_count) {
      ctx.addIssue({
        code: 'custom',
        path: ['rejected_severities'],
        message: 'severity count must match rejected finding count',
      })
    }
  })

export const ScreenOutputSchema = z
  .object({
    dispatch_outcome: DispatchOutcomeSchema,
    admitted_findings: z.array(AdmittedScreenFindingSchema).max(MAX_FINDINGS),
    rejected_summary: ScreenRejectedSummarySchema.optional(),
    residual_risks: SubAgentReturnSchema.shape.residual_risks,
    testing_gaps: SubAgentReturnSchema.shape.testing_gaps,
  })
  .strict()

// --- Prepare envelope ------------------------------------------------------
//
// Input: all screen results for the selected personas plus the dispatch
// metadata the parent selected them under. Output: confidence dispositions,
// the exact selection-surface coverage union, stable singletons, and
// candidate groups awaiting merge adjudication.

const ScreenResultSchema = z
  .object({
    reviewer: SubAgentReturnSchema.shape.reviewer,
    result: ScreenOutputSchema,
  })
  .strict()

const SelectedDispatchSchema = z
  .object({
    persona: SubAgentReturnSchema.shape.reviewer,
    dispatch_outcome: DispatchOutcomeSchema,
    selection_surface: z
      .array(RepoRelativePathSchema)
      .max(MAX_FINDINGS)
      .optional(),
    selection_reason: PipelineReasonSchema.optional(),
  })
  .strict()

export const PrepareInputSchema = z
  .object({
    screen_results: z.array(ScreenResultSchema).max(MAX_PERSONAS),
    selected_dispatches: z.array(SelectedDispatchSchema).max(MAX_PERSONAS),
  })
  .strict()

const ConfidenceDispositionSchema = z
  .object({
    input_id: PipelineInputIdSchema,
    disposition: DispositionSchema.extract(['surviving', 'suppressed']),
    confidence: ParentFindingSchema.shape.confidence,
    reason: PipelineReasonSchema.optional(),
  })
  .strict()

// A member carries its stable input ID and the line its original finding
// reported, together, so a downstream consumer can verify member ordering
// (line, then stable input ID) and check a merge decision's representative
// line against real group data. The member's file is intentionally omitted:
// it is redundant against the group-level `file` every member was grouped
// under, and this schema's own construction (see `groupCandidates` in
// `review-pipeline.ts`) makes a member/group file mismatch structurally
// unrepresentable. Reuses the canonical line leaf (`ParentFindingSchema`'s
// `line`, sourced from `review-artifact-schema.ts`) rather than restating
// its bounds.
const CandidateGroupMemberSchema = z
  .object({
    input_id: PipelineInputIdSchema,
    line: ParentFindingSchema.shape.line,
  })
  .strict()

const CandidateGroupSchema = z
  .object({
    file: RepoRelativePathSchema,
    members: z.array(CandidateGroupMemberSchema).min(2).max(MAX_FINDINGS),
  })
  .strict()

// A surviving admitted finding carries its stable input ID and the reviewer
// that supplied it alongside the finding's own fields, reused wholesale from
// `ParentFindingSchema` rather than restated. This is what lets the merge
// phase derive a merged finding's severity, `pre_existing`, and conservative
// route from real contributing-input data, and its submitters from the
// reviewers that supplied them, instead of re-deriving from nothing.
//
// Only survivors of the confidence gate ever appear here. The gate runs
// before grouping precisely so a suppressed finding can never re-enter the
// pipeline; carrying a suppressed finding's body forward here would invite
// exactly that. A suppressed input keeps only its existing
// `confidence_dispositions` ledger entry.
const SurvivingAdmittedFindingSchema = ParentFindingSchema.extend({
  input_id: PipelineInputIdSchema,
  reviewer: SubAgentReturnSchema.shape.reviewer,
}).strict()

export const PrepareOutputSchema = z
  .object({
    confidence_dispositions: z
      .array(ConfidenceDispositionSchema)
      .max(MAX_FINDINGS * MAX_PERSONAS),
    coverage_union: z
      .array(RepoRelativePathSchema)
      .max(MAX_FINDINGS * MAX_PERSONAS),
    singletons: z.array(PipelineInputIdSchema).max(MAX_FINDINGS * MAX_PERSONAS),
    candidate_groups: z.array(CandidateGroupSchema).max(MAX_FINDINGS),
    surviving_findings: z
      .array(SurvivingAdmittedFindingSchema)
      .max(MAX_FINDINGS * MAX_PERSONAS),
  })
  .strict()

// --- Aggregate stdin byte cap ----------------------------------------------
//
// `prepare` reads every selected persona's screen result from stdin in one
// aggregate payload, so its bound must scale with the same shape maxima the
// contract above already enforces rather than an arbitrary convenience value.

// Conservative per-finding serialized-byte assumption: the largest bounded
// string fields on one `ParentFindingSchema` entry (title <= 256,
// why_it_matters <= 2048, evidence <= 5 * 500, suggested_fix <= 2048) plus
// headroom for JSON key names, quoting, and multi-byte UTF-8 escaping.
export const PER_FINDING_BYTE_ASSUMPTION = 8_192

// Fixed headroom for JSON structural overhead (array/object braces, commas,
// and the envelope's non-finding fields) that scales with dispatch count
// rather than finding count.
export const AGGREGATE_BYTE_CAP_HEADROOM = 65_536

// Worst case: every selected persona (MAX_PERSONAS) contributes up to
// MAX_FINDINGS admitted findings, each at most PER_FINDING_BYTE_ASSUMPTION
// bytes serialized, plus AGGREGATE_BYTE_CAP_HEADROOM for structural overhead.
export const AGGREGATE_STDIN_BYTE_CAP =
  MAX_PERSONAS * MAX_FINDINGS * PER_FINDING_BYTE_ASSUMPTION +
  AGGREGATE_BYTE_CAP_HEADROOM

// --- Route refusal table ----------------------------------------------------
//
// A route transition may only narrow (make the outcome more conservative),
// never widen (make it more autonomous/less verified), and some pairs are
// simply incomparable branches that never transition into one another. This
// table is authored data -- not derived from enum declaration order or a
// string sort -- because neither of those orderings reflects the intended
// conservatism direction for these fields.

const AutofixClassRouteSchema = ParentFindingSchema.shape.autofix_class
const OwnerRouteSchema = ParentFindingSchema.shape.owner

type AutofixClass = z.infer<typeof AutofixClassRouteSchema>
type Owner = z.infer<typeof OwnerRouteSchema>

// autofix_class: safe_auto is the most autonomous starting point and may
// narrow all the way to advisory (no fix applied at all, the most
// conservative outcome). Each subsequent stage may only narrow further along
// the same chain; advisory is terminal.
const AUTOFIX_CLASS_NARROWS_TO: Record<AutofixClass, readonly AutofixClass[]> =
  {
    safe_auto: ['safe_auto', 'gated_auto', 'manual', 'advisory'],
    gated_auto: ['gated_auto', 'manual', 'advisory'],
    manual: ['manual', 'advisory'],
    advisory: ['advisory'],
  }

// owner: review-fixer is the most autonomous starting point and may narrow to
// any other owner. downstream-resolver and human are incomparable parallel
// escalation branches -- neither subsumes the other -- so a transition
// between them is refused even though both narrow away from review-fixer.
// release is terminal: once the release process gates a finding, ownership
// cannot widen back to an earlier stage.
const OWNER_NARROWS_TO: Record<Owner, readonly Owner[]> = {
  'review-fixer': ['review-fixer', 'downstream-resolver', 'human', 'release'],
  'downstream-resolver': ['downstream-resolver', 'release'],
  human: ['human', 'release'],
  release: ['release'],
}

// requires_verification: false may narrow to true (requiring verification is
// more conservative); true may never widen back to false.
const REQUIRES_VERIFICATION_NARROWS_TO: Record<
  'false' | 'true',
  readonly ('false' | 'true')[]
> = {
  false: ['false', 'true'],
  true: ['true'],
}

export const ROUTE_REFUSAL_TABLE = {
  autofix_class: AUTOFIX_CLASS_NARROWS_TO,
  owner: OWNER_NARROWS_TO,
  requires_verification: REQUIRES_VERIFICATION_NARROWS_TO,
} as const

export interface PipelineRoute {
  autofix_class: AutofixClass
  owner: Owner
  requires_verification: boolean
}

/**
 * A route transition is allowed only when every field independently narrows
 * (or stays the same); any widening or incomparable field refuses the whole
 * transition.
 */
export const isRouteTransitionAllowed = (
  from: PipelineRoute,
  to: PipelineRoute,
): boolean => {
  const autofixAllowed = ROUTE_REFUSAL_TABLE.autofix_class[
    from.autofix_class
  ].includes(to.autofix_class)
  const ownerAllowed = ROUTE_REFUSAL_TABLE.owner[from.owner].includes(to.owner)
  const fromVerification = from.requires_verification ? 'true' : 'false'
  const toVerification = to.requires_verification ? 'true' : 'false'
  const verificationAllowed =
    ROUTE_REFUSAL_TABLE.requires_verification[fromVerification].includes(
      toVerification,
    )

  return autofixAllowed && ownerAllowed && verificationAllowed
}

// --- Merge envelope ---------------------------------------------------------
//
// Input: the prepared state from `prepare`, plus a model-authored
// adjudication envelope. The adjudication envelope expresses a partition:
// every eligible candidate input ID lands in exactly one merge group or as
// exactly one declined singleton. Which input IDs are actually eligible is
// the phase implementation's job, not this contract -- here we only enforce
// structural shape: unknown keys rejected, decision IDs unique, no input ID
// claimed by two decisions, and every decision carries a disposition via a
// discriminated union (not an optional flag that could be left unset).

const AgreementCreditSchema = SubAgentReturnSchema.shape.reviewer

const DisagreementFactsSchema = z.array(PipelineReasonSchema).max(MAX_FINDINGS)

// A model-proposed narrower route. Reuses the same canonical leaf schemas
// `deriveRouteMeet`'s inputs are built from (`AutofixClassRouteSchema`,
// `OwnerRouteSchema`, and `ParentFindingSchema`'s `requires_verification`)
// rather than restating their enums here. Pairing with
// `route_narrowing_reason` is enforced below in
// `AdjudicationEnvelopeSchema`'s `superRefine`, not per-field here, so both
// decision schemas stay plain `ZodObject`s usable inside
// `z.discriminatedUnion`.
const ProposedRouteSchema = z
  .object({
    autofix_class: AutofixClassRouteSchema,
    owner: OwnerRouteSchema,
    requires_verification: ParentFindingSchema.shape.requires_verification,
  })
  .strict()

const MergedDecisionSchema = z
  .object({
    decision_id: PipelineInputIdSchema,
    disposition: z.literal('merged'),
    input_finding_ids: z.array(PipelineInputIdSchema).min(2).max(MAX_FINDINGS),
    title: ParentFindingSchema.shape.title,
    why_it_matters: ParentFindingSchema.shape.why_it_matters,
    evidence: ParentFindingSchema.shape.evidence,
    suggested_fix: ParentFindingSchema.shape.suggested_fix,
    line: ParentFindingSchema.shape.line,
    disagreement_facts: DisagreementFactsSchema.optional(),
    eligible_agreement_credit: z
      .array(AgreementCreditSchema)
      .max(MAX_PERSONAS)
      .optional(),
    proposed_route: ProposedRouteSchema.optional(),
    route_narrowing_reason: PipelineReasonSchema.optional(),
  })
  .strict()

const DeclinedDecisionSchema = z
  .object({
    decision_id: PipelineInputIdSchema,
    disposition: z.literal('declined'),
    input_finding_id: PipelineInputIdSchema,
    declined_reason: PipelineReasonSchema,
    disagreement_facts: DisagreementFactsSchema.optional(),
    proposed_route: ProposedRouteSchema.optional(),
    route_narrowing_reason: PipelineReasonSchema.optional(),
  })
  .strict()

const MergeDecisionSchema = z.discriminatedUnion('disposition', [
  MergedDecisionSchema,
  DeclinedDecisionSchema,
])

export const AdjudicationEnvelopeSchema = z
  .object({
    decisions: z.array(MergeDecisionSchema).max(MAX_FINDINGS),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const seenDecisionIds = new Set<string>()
    const seenInputIds = new Set<string>()

    envelope.decisions.forEach((decision, decisionIndex) => {
      if (seenDecisionIds.has(decision.decision_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['decisions', decisionIndex, 'decision_id'],
          message: 'duplicate decision ID',
        })
      }
      seenDecisionIds.add(decision.decision_id)

      if (decision.proposed_route && !decision.route_narrowing_reason) {
        ctx.addIssue({
          code: 'custom',
          path: ['decisions', decisionIndex, 'route_narrowing_reason'],
          message:
            'route_narrowing_reason is required when proposed_route is present',
        })
      }

      if (decision.disposition === 'merged') {
        decision.input_finding_ids.forEach((inputId, inputIndex) => {
          if (seenInputIds.has(inputId)) {
            ctx.addIssue({
              code: 'custom',
              path: [
                'decisions',
                decisionIndex,
                'input_finding_ids',
                inputIndex,
              ],
              message: 'input finding ID already claimed by another decision',
            })
          }
          seenInputIds.add(inputId)
        })
        return
      }

      if (seenInputIds.has(decision.input_finding_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['decisions', decisionIndex, 'input_finding_id'],
          message: 'input finding ID already claimed by another decision',
        })
      }
      seenInputIds.add(decision.input_finding_id)
    })
  })

export const MergeInputSchema = z
  .object({
    prepared: PrepareOutputSchema,
    adjudication: AdjudicationEnvelopeSchema,
  })
  .strict()

const ValidatorRequestSchema = z
  .object({
    finding_id: PipelineInputIdSchema,
    file: RepoRelativePathSchema,
    line: ParentFindingSchema.shape.line,
  })
  .strict()

const MergedFindingSchema = z
  .object({
    finding_id: PipelineInputIdSchema,
    file: RepoRelativePathSchema,
    title: ParentFindingSchema.shape.title,
    why_it_matters: ParentFindingSchema.shape.why_it_matters,
    line: ParentFindingSchema.shape.line,
    autofix_class: ParentFindingSchema.shape.autofix_class,
    owner: ParentFindingSchema.shape.owner,
    requires_verification: ParentFindingSchema.shape.requires_verification,
    evidence: ParentFindingSchema.shape.evidence,
    suggested_fix: ParentFindingSchema.shape.suggested_fix,
    input_finding_ids: z.array(PipelineInputIdSchema).min(1).max(MAX_FINDINGS),
    agreement_credit: z
      .array(AgreementCreditSchema)
      .max(MAX_PERSONAS)
      .optional(),
    severity: ParentFindingSchema.shape.severity,
    confidence: ParentFindingSchema.shape.confidence,
    pre_existing: ParentFindingSchema.shape.pre_existing,
    fingerprint: ProvenanceSchema.shape.fingerprint,
    submitters: ProvenanceSchema.shape.submitters,
  })
  .strict()

export const MergeOutputSchema = z
  .object({
    merged_findings: z.array(MergedFindingSchema).max(MAX_FINDINGS),
    validator_requests: z.array(ValidatorRequestSchema).max(MAX_FINDINGS),
    disagreement_facts: DisagreementFactsSchema,
  })
  .strict()

// --- Finalize envelope -------------------------------------------------------
//
// Input: the merge phase's output state, the dispatch records available to
// the parent, per-finding validator lifecycle results, a model-authored
// plan-assessment envelope, and a closed set of parent-captured run
// metadata. Output: a discriminated union between a writing-mode result
// (the full persisted `ReviewArtifactSchema` artifact plus a report
// projection) and a report-only result (the same report projection alone,
// with no artifact wrapper and none of the artifact's persistence-only
// fields).

// A validator lifecycle result distinguishes four states -- validated true,
// validated false, a failure/timeout non-answer, and an unavailable
// non-answer -- as four mutually exclusive branches of one discriminated
// union. This makes it structurally impossible for either non-answer branch
// to also assert `outcome: 'true'`: the discriminant is a single field, so a
// value can only ever satisfy one branch's shape, never two at once.
export const ValidatorLifecycleResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('true') }).strict(),
  z
    .object({ outcome: z.literal('false'), reason: PipelineReasonSchema })
    .strict(),
  z
    .object({ outcome: z.literal('failed'), reason: PipelineReasonSchema })
    .strict(),
  z
    .object({
      outcome: z.literal('unavailable'),
      reason: PipelineReasonSchema,
    })
    .strict(),
])

const ValidatorLifecycleRecordSchema = z
  .object({
    finding_id: PipelineInputIdSchema,
    result: ValidatorLifecycleResultSchema,
  })
  .strict()

export const ValidatorLifecycleResultsSchema = z
  .array(ValidatorLifecycleRecordSchema)
  .max(MAX_FINDINGS)

// A model-proposed plan-assessment result: an unrouted classification plus
// a description. Kept structurally distinct from `routePlanAssessment`'s
// `PlanAssessmentResult` TypeScript type (which this schema's inferred type
// must match) because the model authors JSON, not a TypeScript value.
const PlanAssessmentResultSchema = z
  .object({
    kind: z.enum(['explicit_unmet_requirement', 'inferred_gap'] as const),
    description: PipelineReasonSchema,
  })
  .strict()

// `run_status`, `residual_actionable_work`, and `advisory_outputs` are
// deliberately absent: those are pre-routed outputs `routePlanAssessment`
// derives from `results`, not fields a model may author directly (KTD12).
export const PlanAssessmentEnvelopeSchema = z
  .object({
    verdict: ReviewArtifactSchema.shape.verdict,
    results: z.array(PlanAssessmentResultSchema).max(MAX_FINDINGS),
  })
  .strict()

// The pipeline's parent-run mode is a superset of the artifact's persisted
// `mode` enum: it additionally accepts `report-only` for a run that never
// writes an artifact. The artifact's own `mode` enum stays untouched.
const ParentRunModeSchema = z.enum([
  ...ReviewArtifactSchema.shape.mode.options,
  'report-only',
] as const)

export const ParentRunMetadataSchema = z
  .object({
    run_id: ReviewArtifactSchema.shape.run_id,
    mode: ParentRunModeSchema,
    harness: ReviewArtifactSchema.shape.harness,
    branch: ReviewArtifactSchema.shape.branch,
    head_sha: ReviewArtifactSchema.shape.head_sha,
    selected_dispatches: z.array(SelectedDispatchSchema).max(MAX_PERSONAS),
    timestamps: z
      .object({
        started_at: ReviewArtifactSchema.shape.completed_at,
        completed_at: ReviewArtifactSchema.shape.completed_at,
      })
      .strict(),
    validation: ReviewArtifactSchema.shape.validation.unwrap(),
    applied_fixes: ReviewArtifactSchema.shape.applied_fixes,
  })
  .strict()

export const FinalizeInputSchema = z
  .object({
    merge: MergeOutputSchema,
    // Reused wholesale from the earlier phases rather than restated: `finalize`
    // re-derives the ledger, rejected weights, coverage notes, and reviewer
    // ownership from this carried state (KTD19), never from anything the
    // model authors.
    prepared: PrepareOutputSchema,
    screen_results: PrepareInputSchema.shape.screen_results,
    dispatch_records: z.array(SelectedDispatchSchema).max(MAX_PERSONAS),
    validator_lifecycle_results: ValidatorLifecycleResultsSchema,
    plan_assessment: PlanAssessmentEnvelopeSchema,
    parent_run_metadata: ParentRunMetadataSchema,
  })
  .strict()

// One admitted raw input's final disposition on the report wire. Mirrors
// `finalizeReviewDispositions`'s `FinalizedInputDisposition` TypeScript
// shape; not an artifact leaf, since the persisted artifact only carries the
// coarser `input_findings` ledger, not this per-input disposition detail.
const FinalizedInputDispositionSchema = z
  .object({
    input_id: PipelineInputIdSchema,
    disposition: DispositionSchema.extract([
      'suppressed',
      'filtered',
      'merged',
      'surviving',
    ]),
    reason: PipelineReasonSchema.optional(),
  })
  .strict()

// One finding placed in an action queue or reported as pre-existing.
// Mirrors `finalizeReviewDispositions`'s `QueuedFinding` / `PreExistingFinding`
// TypeScript shapes, which are structurally identical.
const ReportQueueEntrySchema = z
  .object({
    finding_id: PipelineInputIdSchema,
    unconfirmed: z.boolean(),
  })
  .strict()

const ReportQueuesSchema = z
  .object({
    fixer: z.array(ReportQueueEntrySchema).max(MAX_FINDINGS),
    residual: z.array(ReportQueueEntrySchema).max(MAX_FINDINGS),
    report_only: z.array(ReportQueueEntrySchema).max(MAX_FINDINGS),
  })
  .strict()

const ReportProjectionSchema = z
  .object({
    verdict: ReviewArtifactSchema.shape.verdict,
    findings: ReviewArtifactSchema.shape.findings,
    applied_fixes: ReviewArtifactSchema.shape.applied_fixes,
    residual_actionable_work:
      ReviewArtifactSchema.shape.residual_actionable_work,
    advisory_outputs: ReviewArtifactSchema.shape.advisory_outputs,
    coverage: ReviewArtifactSchema.shape.coverage,
    input_dispositions: z
      .array(FinalizedInputDispositionSchema)
      .max(MAX_FINDINGS * MAX_PERSONAS),
    disposition_counts: ReviewArtifactSchema.shape.disposition_counts,
    queues: ReportQueuesSchema,
    pre_existing_findings: z.array(ReportQueueEntrySchema).max(MAX_FINDINGS),
    risk_coverage: ReviewArtifactSchema.shape.risk_coverage,
  })
  .strict()

export const FinalizeOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('writing'),
      artifact: ReviewArtifactSchema,
      report: ReportProjectionSchema,
    })
    .strict(),
  ReportProjectionSchema.extend({ kind: z.literal('report_only') }).strict(),
])
