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
  RepoRelativePathSchema,
  ReviewArtifactSchema,
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
    reason: PipelineReasonSchema,
  })
  .strict()

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
    reason: PipelineReasonSchema.optional(),
  })
  .strict()

const CandidateGroupSchema = z
  .object({
    file: RepoRelativePathSchema,
    input_finding_ids: z.array(PipelineInputIdSchema).min(2).max(MAX_FINDINGS),
  })
  .strict()

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

export const PlanAssessmentEnvelopeSchema = z
  .object({
    verdict: ReviewArtifactSchema.shape.verdict,
    run_status: ReviewArtifactSchema.shape.run_status,
    residual_actionable_work:
      ReviewArtifactSchema.shape.residual_actionable_work,
    advisory_outputs: ReviewArtifactSchema.shape.advisory_outputs,
  })
  .strict()

export const ParentRunMetadataSchema = z
  .object({
    run_id: ReviewArtifactSchema.shape.run_id,
    mode: ReviewArtifactSchema.shape.mode,
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
    dispatch_records: z.array(SelectedDispatchSchema).max(MAX_PERSONAS),
    validator_lifecycle_results: ValidatorLifecycleResultsSchema,
    plan_assessment: PlanAssessmentEnvelopeSchema,
    parent_run_metadata: ParentRunMetadataSchema,
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
