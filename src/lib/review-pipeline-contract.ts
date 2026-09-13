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
