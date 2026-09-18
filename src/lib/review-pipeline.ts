import path from 'node:path'
import type { z } from 'zod'
import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import type { HarnessSchema } from './review-artifact-schema.js'
import {
  MAX_FINDINGS,
  MAX_PERSONAS,
  MAX_REASON_LENGTH,
  ReviewArtifactSchema,
  RISK_CRITICAL_PERSONAS,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'
import {
  type AdjudicationEnvelopeSchema,
  AGGREGATE_STDIN_BYTE_CAP,
  type FinalizeInputSchema,
  FinalizeOutputSchema,
  isRouteTransitionAllowed,
  MergeOutputSchema,
  type PipelineRoute,
  type PlanAssessmentEnvelopeSchema,
  PrepareInputSchema,
  PrepareOutputSchema,
  ROUTE_REFUSAL_TABLE,
  ScreenOutputSchema,
  type ValidatorLifecycleResultsSchema,
} from './review-pipeline-contract.js'
import { validateReviewReturnValue } from './review-return-validator.js'

/**
 * Normalizes a repo-relative path for grouping, sorting, and any later
 * surface comparison. Collapses `\`-style separators to `/`, then applies
 * POSIX lexical normalization (redundant slashes, `.` segments, and a
 * leading `./`). Never touches the filesystem or the process environment --
 * this is a pure string transform.
 */
export function normalizeRepoRelativePath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll('\\', '/'))
}

/**
 * Pure, side-effect-free admission of one reviewer's raw `ce:review` return.
 *
 * Binds the parsed return to the parent-expected persona and validates its
 * structure. Never reads `process.env`, the filesystem, or the clock --
 * admission depends only on the payload itself.
 *
 * Reuses `validateReviewReturnValue` from `review-return-validator.ts` for
 * the underlying `SubAgentReturnSchema` structural check rather than
 * re-validating shape by hand.
 */

export type ScreenOutput = ReturnType<typeof ScreenOutputSchema.parse>

/** Raw screen input. `raw_return` is intentionally `unknown`: a reviewer's
 * return may arrive as an unparsed JSON string (a raw subprocess payload) or
 * as an already-decoded value; this is the boundary that admits it. */
export interface ScreenReviewReturnInput {
  readonly raw_return: unknown
  readonly expected_reviewer: string
  readonly invoking_harness: z.infer<typeof HarnessSchema>
}

type PipelineRejectReason = 'schema validation' | 'malformed JSON'

const JSON_ROOT_PATH = '$'

const RECOGNIZED_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const
type RecognizedSeverity = (typeof RECOGNIZED_SEVERITIES)[number]
type RejectedSeverity = RecognizedSeverity | 'unknown'

function classifyRejectedSeverity(value: unknown): RejectedSeverity {
  return typeof value === 'string' &&
    (RECOGNIZED_SEVERITIES as readonly string[]).includes(value)
    ? (value as RecognizedSeverity)
    : 'unknown'
}

/**
 * Extracts each finding's severity from a whole-payload rejection's raw JSON
 * value, without trusting any of it: only a recognizable `P0`-`P3` string is
 * copied through, and any other value -- malformed, wrong type, or absent --
 * becomes `unknown` rather than being forwarded verbatim onto the wire.
 * Returns `undefined` when the payload's finding count cannot even be
 * determined (not an object, or no array-typed `findings` property) or
 * exceeds `MAX_FINDINGS` (too many to represent in a bounded
 * `rejected_summary`) -- the "unknowable count" case KTD21 requires to carry
 * no rejected-summary row at all, distinct from a determined count of zero
 * (also no row, but for a different reason: see `wholePayloadRejection`).
 */
function extractRejectedSeverities(
  rawValue: unknown,
): readonly RejectedSeverity[] | undefined {
  if (typeof rawValue !== 'object' || rawValue === null) return undefined
  const findings = (rawValue as Record<string, unknown>).findings
  if (!Array.isArray(findings)) return undefined
  if (findings.length > MAX_FINDINGS) return undefined
  return findings.map((finding) =>
    typeof finding === 'object' && finding !== null
      ? classifyRejectedSeverity((finding as Record<string, unknown>).severity)
      : 'unknown',
  )
}

function formatDiagnostic(
  persona: string,
  fieldPath: readonly (string | number)[] | string,
  reason: PipelineRejectReason,
): string {
  const jsonPath =
    typeof fieldPath === 'string'
      ? fieldPath
      : formatReviewArtifactIssuePath(fieldPath)
  return `Rejected persona ${persona} return: field ${jsonPath} failed ${reason}.`
}

function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason
  return reason.slice(0, MAX_REASON_LENGTH)
}

function parseRawReturn(
  rawReturn: unknown,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (typeof rawReturn !== 'string') return { ok: true, value: rawReturn }
  try {
    return { ok: true, value: JSON.parse(rawReturn) as unknown }
  } catch {
    return { ok: false }
  }
}

/**
 * Builds a whole-payload rejection's `ScreenOutput`. Per KTD21, a
 * rejected-summary row requires a positive finding count with a real
 * meaning: when the rejected findings' severities cannot be determined at
 * all (unparseable JSON) or the determined count is zero (an
 * identity-mismatched empty return), no `rejected_summary` is emitted at
 * all -- the count is never coerced from zero to one, and no reason text
 * escapes into the output for that case.
 */
function wholePayloadRejection(
  persona: string,
  fieldPath: readonly (string | number)[] | string,
  reason: PipelineRejectReason,
  rejectedSeverities: readonly RejectedSeverity[] | undefined,
  harness: z.infer<typeof HarnessSchema>,
): ScreenOutput {
  const rejectedFindingCount = rejectedSeverities?.length ?? 0

  return ScreenOutputSchema.parse({
    admitted_findings: [],
    dispatch_outcome: 'malformed',
    ...(rejectedFindingCount > 0
      ? {
          rejected_summary: {
            dispatch_outcome: 'malformed',
            reason: truncateReason(
              formatDiagnostic(persona, fieldPath, reason),
            ),
            rejected_finding_count: rejectedFindingCount,
            rejected_severities: rejectedSeverities,
          },
        }
      : {}),
    residual_risks: [],
    testing_gaps: [],
    harness,
  })
}

/**
 * Admit one reviewer's raw return and bind it to the parent-expected
 * persona.
 *
 * Rejection is whole-payload only: a schema-invalid return, a reviewer
 * identity mismatch, or malformed JSON rejects everything. Findings that
 * pass structural validation are admitted with a stable
 * `<reviewer>#<original-index>` input ID derived from their position in the
 * original payload.
 */
export function screenReviewReturn(
  input: ScreenReviewReturnInput,
): ScreenOutput {
  const persona = input.expected_reviewer
  const harness = input.invoking_harness

  const parsed = parseRawReturn(input.raw_return)
  if (!parsed.ok) {
    return wholePayloadRejection(
      persona,
      JSON_ROOT_PATH,
      'malformed JSON',
      undefined,
      harness,
    )
  }

  const validation = validateReviewReturnValue(parsed.value)
  if (!validation.ok) {
    const fieldPath = validation.issues[0]?.path ?? JSON_ROOT_PATH
    return wholePayloadRejection(
      persona,
      fieldPath,
      'schema validation',
      extractRejectedSeverities(parsed.value),
      harness,
    )
  }

  const raw = SubAgentReturnSchema.parse(parsed.value)

  if (raw.reviewer !== persona) {
    return wholePayloadRejection(
      persona,
      'reviewer',
      'schema validation',
      raw.findings.map((finding) => finding.severity),
      harness,
    )
  }

  const admittedFindings: ScreenOutput['admitted_findings'] = raw.findings.map(
    (finding, originalIndex) => ({
      ...finding,
      disposition: 'surviving',
      input_id: `${persona}#${originalIndex}`,
    }),
  )

  const dispatchOutcome = raw.findings.length === 0 ? 'empty' : 'findings'

  return ScreenOutputSchema.parse({
    admitted_findings: admittedFindings,
    dispatch_outcome: dispatchOutcome,
    residual_risks: raw.residual_risks,
    testing_gaps: raw.testing_gaps,
    harness,
  })
}

// --- prepare phase ----------------------------------------------------------
//
// Pure, side-effect-free formation of candidate groups for model
// adjudication. Consumes every selected persona's screen result plus the
// dispatch metadata the parent selected them under, applies the confidence
// gate, and groups surviving findings that may warrant a merge decision.
// This phase never merges: two findings on the same file (even the same
// line) form a candidate pair, never an automatic duplicate. Never reads
// `process.env`, the filesystem, or the clock.

export type PrepareOutput = ReturnType<typeof PrepareOutputSchema.parse>
type PrepareInputValue = ReturnType<typeof PrepareInputSchema.parse>
type PrepareScreenResult = PrepareInputValue['screen_results'][number]
type PrepareAdmittedFinding =
  PrepareScreenResult['result']['admitted_findings'][number]

/** Raw prepare input. `raw_input` is intentionally `unknown`: the aggregate
 * payload may arrive as an unparsed JSON string (a raw stdin payload) or as
 * an already-decoded value; this is the boundary that admits it. */
export interface PrepareReviewCandidatesInput {
  readonly raw_input: unknown
}

type PrepareRejectReason =
  | 'aggregate payload exceeds byte cap'
  | 'malformed JSON'
  | 'schema validation'
  | 'duplicate persona outcome'
  | 'duplicate input id'
  | 'unselected persona screen result'
  | 'missing screen result for selected dispatch'

/** One bounded, payload-safe rejection diagnostic: a fixed reason code and a
 * safe JSON path only. Never payload content, never exception text. */
export interface PrepareRejection {
  readonly path: string
  readonly reason: PrepareRejectReason
}

export type PrepareReviewCandidatesResult =
  | { readonly ok: true; readonly value: PrepareOutput }
  | { readonly ok: false; readonly rejection: PrepareRejection }

// A P0 finding survives the confidence gate at a lower floor than every
// other severity; both floors are fixed and independent of input order.
const STANDARD_CONFIDENCE_FLOOR = 0.6
const P0_CONFIDENCE_FLOOR = 0.5
const CONFIDENCE_GATE_SUPPRESSED_REASON = 'confidence below gate threshold'

function rejectPrepare(
  path: string,
  reason: PrepareRejectReason,
): { readonly ok: false; readonly rejection: PrepareRejection } {
  return { ok: false, rejection: { path, reason } }
}

/**
 * Total order over strings that never depends on locale or platform ICU
 * data, so sort output stays byte-identical across environments.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Estimates the serialized byte length of the raw prepare payload before any
 * parsing is attempted, so an oversized aggregate is rejected without paying
 * the cost of parsing it. Strings are measured directly; already-decoded
 * values are measured via their JSON serialization. Non-serializable values
 * (e.g. containing a `BigInt` or a circular reference) fall through to
 * schema validation instead of a byte-cap verdict.
 */
function payloadByteLength(rawInput: unknown): number | undefined {
  if (typeof rawInput === 'string') return Buffer.byteLength(rawInput, 'utf8')
  try {
    return Buffer.byteLength(JSON.stringify(rawInput), 'utf8')
  } catch {
    return undefined
  }
}

interface PrepareSurvivor {
  readonly inputId: string
  readonly persona: string
  readonly normalizedFile: string
  readonly line: number
}

function survivesConfidenceGate(finding: PrepareAdmittedFinding): boolean {
  if (finding.confidence >= STANDARD_CONFIDENCE_FLOOR) return true
  return finding.severity === 'P0' && finding.confidence >= P0_CONFIDENCE_FLOOR
}

/**
 * Structural cross-referencing beyond what the schema alone can express:
 * duplicate personas, duplicate input IDs, and the selected-dispatch /
 * screen-result correspondence. Returns the first violation found, or
 * `undefined` when the input is structurally sound.
 */
function validatePrepareStructure(
  screenResults: readonly PrepareScreenResult[],
  selectedDispatches: readonly PrepareInputValue['selected_dispatches'][number][],
): { readonly path: string; readonly reason: PrepareRejectReason } | undefined {
  const seenPersonas = new Set<string>()
  for (const [index, entry] of screenResults.entries()) {
    if (seenPersonas.has(entry.reviewer)) {
      return {
        path: formatReviewArtifactIssuePath([
          'screen_results',
          index,
          'reviewer',
        ]),
        reason: 'duplicate persona outcome',
      }
    }
    seenPersonas.add(entry.reviewer)
  }

  const seenInputIds = new Set<string>()
  for (const [screenIndex, entry] of screenResults.entries()) {
    for (const [
      findingIndex,
      finding,
    ] of entry.result.admitted_findings.entries()) {
      if (seenInputIds.has(finding.input_id)) {
        return {
          path: formatReviewArtifactIssuePath([
            'screen_results',
            screenIndex,
            'result',
            'admitted_findings',
            findingIndex,
            'input_id',
          ]),
          reason: 'duplicate input id',
        }
      }
      seenInputIds.add(finding.input_id)
    }
  }

  const selectedPersonas = new Set(
    selectedDispatches.map((dispatch) => dispatch.persona),
  )
  for (const [index, entry] of screenResults.entries()) {
    if (!selectedPersonas.has(entry.reviewer)) {
      return {
        path: formatReviewArtifactIssuePath([
          'screen_results',
          index,
          'reviewer',
        ]),
        reason: 'unselected persona screen result',
      }
    }
  }

  const screenedPersonas = new Set(screenResults.map((entry) => entry.reviewer))
  for (const [index, dispatch] of selectedDispatches.entries()) {
    if (!screenedPersonas.has(dispatch.persona)) {
      return {
        path: formatReviewArtifactIssuePath([
          'selected_dispatches',
          index,
          'persona',
        ]),
        reason: 'missing screen result for selected dispatch',
      }
    }
  }

  return undefined
}

/**
 * Applies the confidence gate to every admitted finding across the selected
 * personas' screen results. Returns the full disposition ledger (sorted for
 * determinism) plus the survivors carried forward into candidate grouping.
 */
function applyConfidenceGate(screenResults: readonly PrepareScreenResult[]): {
  readonly confidenceDispositions: PrepareOutput['confidence_dispositions']
  readonly survivors: readonly PrepareSurvivor[]
  readonly survivingFindings: PrepareOutput['surviving_findings']
} {
  const confidenceDispositions: PrepareOutput['confidence_dispositions'] = []
  const survivors: PrepareSurvivor[] = []
  const survivingFindings: PrepareOutput['surviving_findings'] = []

  for (const entry of screenResults) {
    for (const finding of entry.result.admitted_findings) {
      if (survivesConfidenceGate(finding)) {
        confidenceDispositions.push({
          input_id: finding.input_id,
          disposition: 'surviving',
          confidence: finding.confidence,
        })
        survivors.push({
          inputId: finding.input_id,
          persona: entry.reviewer,
          normalizedFile: normalizeRepoRelativePath(finding.file),
          line: finding.line,
        })
        survivingFindings.push({
          ...finding,
          reviewer: entry.reviewer,
        })
      } else {
        confidenceDispositions.push({
          input_id: finding.input_id,
          disposition: 'suppressed',
          confidence: finding.confidence,
          reason: CONFIDENCE_GATE_SUPPRESSED_REASON,
        })
      }
    }
  }

  confidenceDispositions.sort((a, b) => compareStrings(a.input_id, b.input_id))
  survivingFindings.sort((a, b) => compareStrings(a.input_id, b.input_id))
  return { confidenceDispositions, survivors, survivingFindings }
}

/**
 * Exact-string union of every selected persona's selection surface. No
 * normalization here -- two entries differing only in normalizable form are
 * kept distinct, matching the contract's exact-string requirement.
 */
function computeCoverageUnion(
  selectedDispatches: readonly PrepareInputValue['selected_dispatches'][number][],
): readonly string[] {
  const coverageSet = new Set<string>()
  for (const dispatch of selectedDispatches) {
    for (const surface of dispatch.selection_surface ?? []) {
      coverageSet.add(surface)
    }
  }
  return [...coverageSet].sort(compareStrings)
}

/**
 * Groups surviving findings by normalized file path. A group forms only
 * when at least two distinct personas are represented on that file;
 * everything else falls back to a singleton. Never merges -- group members
 * are only sorted (by line, then stable input ID) for the model to
 * adjudicate.
 */
function groupCandidates(survivors: readonly PrepareSurvivor[]): {
  readonly candidateGroups: PrepareOutput['candidate_groups']
  readonly singletonIds: readonly string[]
} {
  const groupsByFile = new Map<string, PrepareSurvivor[]>()
  for (const survivor of survivors) {
    const bucket = groupsByFile.get(survivor.normalizedFile)
    if (bucket) {
      bucket.push(survivor)
    } else {
      groupsByFile.set(survivor.normalizedFile, [survivor])
    }
  }

  const candidateGroups: PrepareOutput['candidate_groups'] = []
  const singletonIds: string[] = []

  for (const [file, members] of groupsByFile) {
    const distinctPersonas = new Set(members.map((member) => member.persona))
    if (distinctPersonas.size >= 2) {
      const sortedMembers = [...members].sort((a, b) => {
        if (a.line !== b.line) return a.line - b.line
        return compareStrings(a.inputId, b.inputId)
      })
      candidateGroups.push({
        file,
        members: sortedMembers.map((member) => ({
          input_id: member.inputId,
          line: member.line,
        })),
      })
    } else {
      for (const member of members) {
        singletonIds.push(member.inputId)
      }
    }
  }

  candidateGroups.sort((a, b) => compareStrings(a.file, b.file))
  singletonIds.sort(compareStrings)
  return { candidateGroups, singletonIds }
}

/**
 * Consumes every selected persona's screen result plus the dispatch metadata
 * the parent selected them under, applies the confidence gate, and forms
 * candidate groups for the model to adjudicate.
 *
 * Rejection is whole-payload only, with a fixed reason code and a safe JSON
 * path -- never payload content or exception text. Every count in the
 * output is recomputed from the admitted arrays themselves; no count
 * supplied by the input is trusted.
 */
export function prepareReviewCandidates(
  input: PrepareReviewCandidatesInput,
): PrepareReviewCandidatesResult {
  const byteLength = payloadByteLength(input.raw_input)
  if (byteLength !== undefined && byteLength > AGGREGATE_STDIN_BYTE_CAP) {
    return rejectPrepare(JSON_ROOT_PATH, 'aggregate payload exceeds byte cap')
  }

  const parsed = parseRawReturn(input.raw_input)
  if (!parsed.ok) {
    return rejectPrepare(JSON_ROOT_PATH, 'malformed JSON')
  }

  const validation = PrepareInputSchema.safeParse(parsed.value)
  if (!validation.success) {
    const issue = validation.error.issues[0]
    const issuePath = issue
      ? formatReviewArtifactIssuePath(issue.path)
      : JSON_ROOT_PATH
    return rejectPrepare(issuePath, 'schema validation')
  }

  const {
    screen_results: screenResults,
    selected_dispatches: selectedDispatches,
  } = validation.data

  const structuralViolation = validatePrepareStructure(
    screenResults,
    selectedDispatches,
  )
  if (structuralViolation) {
    return rejectPrepare(structuralViolation.path, structuralViolation.reason)
  }

  const { confidenceDispositions, survivors, survivingFindings } =
    applyConfidenceGate(screenResults)
  const coverageUnion = computeCoverageUnion(selectedDispatches)
  const { candidateGroups, singletonIds } = groupCandidates(survivors)

  const output = PrepareOutputSchema.parse({
    candidate_groups: candidateGroups,
    confidence_dispositions: confidenceDispositions,
    coverage_union: coverageUnion,
    singletons: singletonIds,
    surviving_findings: survivingFindings,
  })

  return { ok: true, value: output }
}

// --- merge phase: adjudication validation -----------------------------------
//
// Pure, side-effect-free validation of the model-authored adjudication
// envelope against the prepared candidate state. This checks only that the
// decisions form a valid *partition* over the eligible candidate set --
// every eligible input ID lands in exactly one merge group or as exactly one
// declined singleton. It never computes merged-finding fields (severity,
// confidence, provenance, routing); that is a later derivation step's job.
// Never reads `process.env`, the filesystem, or the clock.

/** One candidate group exactly as `prepareReviewCandidates` emits it on the
 * wire: the file every member was grouped under, plus each member's stable
 * input ID and line. `validateAdjudication` consumes this real shape
 * directly rather than a bespoke stand-in -- a member's file is never
 * tracked separately because it is always the group's file. */
type CandidateGroup = PrepareOutput['candidate_groups'][number]

type AdjudicationDecisions = z.infer<
  typeof AdjudicationEnvelopeSchema
>['decisions']
type MergeDecision = AdjudicationDecisions[number]
type MergedMergeDecision = Extract<MergeDecision, { disposition: 'merged' }>
type DeclinedMergeDecision = Extract<MergeDecision, { disposition: 'declined' }>

/** One validated merge group: the model's merge decision plus the file its
 * members were grouped under, so a later derivation step does not need to
 * re-scan the candidate groups to recover it. */
export interface ValidatedMergedGroup {
  readonly decision: MergedMergeDecision
  readonly file: string
}

/** One validated declined singleton: the model's decline decision plus the
 * file its input finding was grouped under. */
export interface ValidatedDeclinedSingleton {
  readonly decision: DeclinedMergeDecision
  readonly file: string
}

/** The validated partition: every eligible candidate accounted for, plus the
 * true singletons passed through untouched. Sorted by `decision_id` /
 * input ID so the result is byte-identical regardless of input decision
 * order. */
export interface ValidatedAdjudication {
  readonly merged: readonly ValidatedMergedGroup[]
  readonly declined: readonly ValidatedDeclinedSingleton[]
  readonly singletons: readonly string[]
}

type AdjudicationRejectReason =
  | 'unknown input id'
  | 'suppressed input id'
  | 'duplicate input id citation'
  | 'omitted eligible input id'
  | 'cross-group input id citation'
  | 'representative line mismatch'
  | 'unexpected decisions for empty candidate set'
  | 'duplicate merged group decision id'
  | 'duplicate declined decision id'
  | 'duplicate passthrough singleton input id'
  | 'declined decision id collides with merged group decision id'
  | 'declined decision id collides with passthrough singleton input id'
  | 'passthrough singleton input id collides with merged group decision id'

/** One bounded, payload-safe rejection diagnostic: a fixed reason code and a
 * safe JSON path only. Never payload content, never a finding title, never
 * exception text. */
export interface AdjudicationRejection {
  readonly path: string
  readonly reason: AdjudicationRejectReason
}

export type ValidateAdjudicationResult =
  | { readonly ok: true; readonly value: ValidatedAdjudication }
  | { readonly ok: false; readonly rejection: AdjudicationRejection }

function rejectAdjudication(
  path: string,
  reason: AdjudicationRejectReason,
): { readonly ok: false; readonly rejection: AdjudicationRejection } {
  return { ok: false, rejection: { path, reason } }
}

function citedInputIds(decision: MergeDecision): readonly string[] {
  return decision.disposition === 'merged'
    ? decision.input_finding_ids
    : [decision.input_finding_id]
}

function citationPath(
  decision: MergeDecision,
  decisionIndex: number,
  citedIndex: number,
): string {
  return decision.disposition === 'merged'
    ? formatReviewArtifactIssuePath([
        'decisions',
        decisionIndex,
        'input_finding_ids',
        citedIndex,
      ])
    : formatReviewArtifactIssuePath([
        'decisions',
        decisionIndex,
        'input_finding_id',
      ])
}

interface CandidateIndex {
  readonly groupIndexByInputId: ReadonlyMap<string, number>
}

function buildCandidateIndex(
  candidateGroups: readonly CandidateGroup[],
): CandidateIndex {
  const groupIndexByInputId = new Map<string, number>()
  candidateGroups.forEach((group, groupIndex) => {
    for (const member of group.members) {
      groupIndexByInputId.set(member.input_id, groupIndex)
    }
  })
  return { groupIndexByInputId }
}

function buildSuppressedSet(
  confidenceDispositions: PrepareOutput['confidence_dispositions'],
): ReadonlySet<string> {
  const suppressed = new Set<string>()
  for (const disposition of confidenceDispositions) {
    if (disposition.disposition === 'suppressed') {
      suppressed.add(disposition.input_id)
    }
  }
  return suppressed
}

/**
 * Checks every cited input ID, in decision order, for: citing a suppressed
 * ID, citing an ID that is not an eligible candidate-group member at all,
 * and citing an ID already claimed by an earlier decision. Returns the first
 * violation found, or `undefined` when every citation is sound.
 */
function validateCitations(
  decisions: AdjudicationDecisions,
  index: CandidateIndex,
  suppressed: ReadonlySet<string>,
): AdjudicationRejection | undefined {
  const seen = new Set<string>()
  for (const [decisionIndex, decision] of decisions.entries()) {
    for (const [citedIndex, inputId] of citedInputIds(decision).entries()) {
      const path = citationPath(decision, decisionIndex, citedIndex)
      if (suppressed.has(inputId)) {
        return { path, reason: 'suppressed input id' }
      }
      if (!index.groupIndexByInputId.has(inputId)) {
        return { path, reason: 'unknown input id' }
      }
      if (seen.has(inputId)) {
        return { path, reason: 'duplicate input id citation' }
      }
      seen.add(inputId)
    }
  }
  return undefined
}

/**
 * Every eligible candidate-group member must be cited by exactly one
 * decision. `validateCitations` already rejects double-citation; this
 * catches the opposite failure -- an eligible member cited by no decision at
 * all. The diagnostic path points at the omitted member's location in the
 * prepared candidate groups, since no decision references it.
 */
function validateNoOmissions(
  candidateGroups: readonly CandidateGroup[],
  citedIds: ReadonlySet<string>,
): AdjudicationRejection | undefined {
  for (const [groupIndex, group] of candidateGroups.entries()) {
    for (const [memberIndex, member] of group.members.entries()) {
      if (!citedIds.has(member.input_id)) {
        return {
          path: formatReviewArtifactIssuePath([
            'candidate_groups',
            groupIndex,
            'members',
            memberIndex,
            'input_id',
          ]),
          reason: 'omitted eligible input id',
        }
      }
    }
  }
  return undefined
}

function collectCitedIds(
  decisions: AdjudicationDecisions,
): ReadonlySet<string> {
  const cited = new Set<string>()
  for (const decision of decisions) {
    for (const inputId of citedInputIds(decision)) cited.add(inputId)
  }
  return cited
}

/**
 * Validates one merged decision's internal consistency: every cited member
 * must belong to the same candidate group (never a cross-group merge the
 * model invented), and the decision's representative `line` must be one of
 * the group members' lines. A member/group file mismatch is not checked
 * here -- the real envelope only tracks `file` at the group level, so it is
 * structurally impossible for a member to disagree with its own group.
 */
function validateMergedDecisionConsistency(
  decision: MergedMergeDecision,
  decisionIndex: number,
  index: CandidateIndex,
  candidateGroups: readonly CandidateGroup[],
): AdjudicationRejection | undefined {
  const ids = decision.input_finding_ids
  const firstId = ids[0]
  if (firstId === undefined) return undefined
  const expectedGroupIndex = index.groupIndexByInputId.get(firstId)
  if (expectedGroupIndex === undefined) return undefined

  for (const [citedIndex, inputId] of ids.entries()) {
    const groupIndex = index.groupIndexByInputId.get(inputId)
    if (groupIndex !== expectedGroupIndex) {
      return {
        path: formatReviewArtifactIssuePath([
          'decisions',
          decisionIndex,
          'input_finding_ids',
          citedIndex,
        ]),
        reason: 'cross-group input id citation',
      }
    }
  }

  const group = candidateGroups[expectedGroupIndex]
  if (group && !group.members.some((member) => member.line === decision.line)) {
    return {
      path: formatReviewArtifactIssuePath(['decisions', decisionIndex, 'line']),
      reason: 'representative line mismatch',
    }
  }
  return undefined
}

/**
 * Validates every merged decision's group/line consistency, in decision
 * order. Returns the first violation found, or `undefined` when every
 * merged decision is sound.
 */
function validateMergedDecisions(
  decisions: AdjudicationDecisions,
  index: CandidateIndex,
  candidateGroups: readonly CandidateGroup[],
): AdjudicationRejection | undefined {
  for (const [decisionIndex, decision] of decisions.entries()) {
    if (decision.disposition !== 'merged') continue
    const violation = validateMergedDecisionConsistency(
      decision,
      decisionIndex,
      index,
      candidateGroups,
    )
    if (violation) return violation
  }
  return undefined
}

function resolveDecisionFile(
  decision: MergeDecision,
  index: CandidateIndex,
  candidateGroups: readonly CandidateGroup[],
): string | undefined {
  const firstId = citedInputIds(decision)[0]
  if (firstId === undefined) return undefined
  const groupIndex = index.groupIndexByInputId.get(firstId)
  if (groupIndex === undefined) return undefined
  return candidateGroups[groupIndex]?.file
}

/**
 * Builds the validated, sorted partition once every check has passed: one
 * entry per merge group and one per declined singleton, each carrying the
 * file its input findings were grouped under, plus the true singletons
 * passed through untouched. Sorting by ID makes the result byte-identical
 * regardless of the input decision order.
 */
function buildValidatedPartition(
  decisions: AdjudicationDecisions,
  index: CandidateIndex,
  candidateGroups: readonly CandidateGroup[],
  singletons: readonly string[],
): ValidatedAdjudication {
  const merged: ValidatedMergedGroup[] = []
  const declined: ValidatedDeclinedSingleton[] = []

  for (const decision of decisions) {
    const file = resolveDecisionFile(decision, index, candidateGroups) ?? ''
    if (decision.disposition === 'merged') {
      merged.push({ decision, file })
    } else {
      declined.push({ decision, file })
    }
  }

  merged.sort((a, b) =>
    compareStrings(a.decision.decision_id, b.decision.decision_id),
  )
  declined.sort((a, b) =>
    compareStrings(a.decision.decision_id, b.decision.decision_id),
  )

  return {
    merged,
    declined,
    singletons: [...singletons].sort(compareStrings),
  }
}

/**
 * Validates that the model's adjudication decisions form a valid partition
 * over `prepared`'s eligible candidate set: every eligible input ID (one
 * that appears in a candidate group) is cited by exactly one decision --
 * either inside a merge group or as a declined singleton. Never repairs a
 * malformed partition; any violation rejects the whole envelope with no
 * partial output, since a repaired partition would silently invent a merge
 * decision the model never made.
 *
 * A decision set is required to be empty when there are no candidate groups
 * (a legitimate, non-error state); a non-empty decision set against zero
 * candidates is rejected. This function never computes merged-finding
 * fields (severity, confidence, provenance, routing) -- only structural
 * partition validity.
 */
export function validateAdjudication(
  prepared: PrepareOutput,
  decisions: AdjudicationDecisions,
): ValidateAdjudicationResult {
  if (prepared.candidate_groups.length === 0) {
    if (decisions.length > 0) {
      return rejectAdjudication(
        formatReviewArtifactIssuePath(['decisions']),
        'unexpected decisions for empty candidate set',
      )
    }
    return {
      ok: true,
      value: buildValidatedPartition(
        decisions,
        buildCandidateIndex([]),
        [],
        prepared.singletons,
      ),
    }
  }

  const index = buildCandidateIndex(prepared.candidate_groups)
  const suppressed = buildSuppressedSet(prepared.confidence_dispositions)

  const citationViolation = validateCitations(decisions, index, suppressed)
  if (citationViolation) {
    return { ok: false, rejection: citationViolation }
  }

  const citedIds = collectCitedIds(decisions)
  const omissionViolation = validateNoOmissions(
    prepared.candidate_groups,
    citedIds,
  )
  if (omissionViolation) {
    return { ok: false, rejection: omissionViolation }
  }

  const mergedViolation = validateMergedDecisions(
    decisions,
    index,
    prepared.candidate_groups,
  )
  if (mergedViolation) {
    return { ok: false, rejection: mergedViolation }
  }

  return {
    ok: true,
    value: buildValidatedPartition(
      decisions,
      index,
      prepared.candidate_groups,
      prepared.singletons,
    ),
  }
}

// --- merge phase: single merged-finding field derivation --------------------
//
// Pure, side-effect-free derivation of one merged finding's mechanical
// fields from its contributing surviving findings plus the model's decision
// fields for that one group. Assumes the caller already validated the
// partition via `validateAdjudication` -- this never re-validates group
// membership. Never trusts a model-supplied value for severity, submitters,
// confidence, `pre_existing`, fingerprint, or route directly: every one of
// those is recomputed from the contributing inputs, with the model only
// permitted to narrow the derived route (never widen it, via
// `isRouteTransitionAllowed`) and to claim additional agreement credit
// (never inventing a reviewer who never returned, or double-counting an
// existing submitter). Never reads `process.env`, the filesystem, or the
// clock.

type SurvivingFinding = PrepareOutput['surviving_findings'][number]

/** A candidate group always has at least two members
 * (`CandidateGroupSchema.members` is `.min(2)`), so the contributing set for
 * one merge decision is a non-empty tuple by construction rather than a
 * plain array that would need a defensive empty check on every derivation
 * below. */
export type MergeContributingFindings = readonly [
  SurvivingFinding,
  SurvivingFinding,
  ...SurvivingFinding[],
]

/** The model-owned fields for one merge decision that this derivation
 * consumes: the representative line it picked (already checked by
 * `validateAdjudication` against the group's real member lines), any
 * additional reviewers it claims agreed, and an optional narrower route with
 * the reason narrowing requires. */
export interface MergedFindingModelDecision {
  readonly line: number
  readonly eligible_agreement_credit?: readonly string[]
  readonly proposed_route?: PipelineRoute
  readonly route_narrowing_reason?: string
}

export interface DeriveMergedFindingInput {
  readonly contributing: MergeContributingFindings
  readonly decision: MergedFindingModelDecision
  /** Every reviewer whose `SubAgentReturn` was actually admitted for this
   * run -- the eligibility set agreement credit is checked against. */
  readonly returned_reviewers: readonly string[]
}

export interface DerivedMergedFindingFields {
  readonly severity: SurvivingFinding['severity']
  readonly submitters: readonly string[]
  readonly confidence: number
  readonly agreement_credit: readonly string[]
  readonly pre_existing: boolean
  readonly fingerprint: string
  readonly route: PipelineRoute
  /** Whether `route` actually differs from the route meet computed over
   * `contributing` -- true only for a genuine narrowing, never merely
   * because the model supplied a `proposed_route`. Assembly uses this,
   * rather than presence of a proposal, to decide whether
   * `route_narrowing_reason` belongs on the wire. */
  readonly route_differs_from_meet: boolean
}

type MergedFindingRejectReason =
  | 'route widening'
  | 'route narrowing missing reason'
  | 'duplicate agreement credit reviewer'
  | 'agreement credit reviewer already a submitter'
  | 'agreement credit reviewer did not return'

/** One bounded, payload-safe rejection diagnostic: a fixed reason code and a
 * safe JSON path only. Never payload content, never a finding title, never
 * exception text. */
export interface MergedFindingRejection {
  readonly path: string
  readonly reason: MergedFindingRejectReason
}

export type DeriveMergedFindingResult =
  | { readonly ok: true; readonly value: DerivedMergedFindingFields }
  | { readonly ok: false; readonly rejection: MergedFindingRejection }

function rejectMergedFinding(
  path: string,
  reason: MergedFindingRejectReason,
): { readonly ok: false; readonly rejection: MergedFindingRejection } {
  return { ok: false, rejection: { path, reason } }
}

const SEVERITY_RANK: Record<SurvivingFinding['severity'], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
}

/** The highest severity (`P0` outranks `P1` outranks `P2` outranks `P3`)
 * among the contributing inputs -- never the first or last one, and never a
 * model-supplied value. */
function deriveSeverity(
  contributing: MergeContributingFindings,
): SurvivingFinding['severity'] {
  return contributing.reduce<SurvivingFinding['severity']>(
    (highest, finding) =>
      SEVERITY_RANK[finding.severity] < SEVERITY_RANK[highest]
        ? finding.severity
        : highest,
    contributing[0].severity,
  )
}

/** The distinct reviewers of the contributing inputs, sorted for
 * deterministic output. */
function deriveSubmitters(
  contributing: MergeContributingFindings,
): readonly string[] {
  return [...new Set(contributing.map((finding) => finding.reviewer))].sort(
    compareStrings,
  )
}

/**
 * Validates the model's claimed agreement credit: each claimed reviewer
 * must be distinct from every other claimed reviewer, must not already be a
 * submitter, and must appear in the set of reviewers that actually
 * returned. Returns the credited reviewers (sorted) or the first violation
 * found, in claim order.
 */
function deriveAgreementCredit(
  claimed: readonly string[] | undefined,
  submitters: ReadonlySet<string>,
  returnedReviewers: ReadonlySet<string>,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly rejection: MergedFindingRejection } {
  if (!claimed || claimed.length === 0) return { ok: true, value: [] }

  const credited = new Set<string>()
  for (const [index, reviewer] of claimed.entries()) {
    const path = formatReviewArtifactIssuePath([
      'eligible_agreement_credit',
      index,
    ])
    if (credited.has(reviewer)) {
      return rejectMergedFinding(path, 'duplicate agreement credit reviewer')
    }
    if (submitters.has(reviewer)) {
      return rejectMergedFinding(
        path,
        'agreement credit reviewer already a submitter',
      )
    }
    if (!returnedReviewers.has(reviewer)) {
      return rejectMergedFinding(
        path,
        'agreement credit reviewer did not return',
      )
    }
    credited.add(reviewer)
  }

  return { ok: true, value: [...credited].sort(compareStrings) }
}

const CONFIDENCE_AGREEMENT_BOOST = 0.1
const MAX_CONFIDENCE = 1

/**
 * The highest confidence among the contributing inputs, boosted by
 * `CONFIDENCE_AGREEMENT_BOOST` when submitters plus eligible agreement
 * credit together represent at least two distinct reviewers, capped at
 * `MAX_CONFIDENCE`. Rounded to avoid floating-point artifacts from the
 * addition. A single-reviewer finding never gets the boost.
 */
function deriveConfidence(
  contributing: MergeContributingFindings,
  distinctReviewerCount: number,
): number {
  const highest = contributing.reduce(
    (max, finding) => Math.max(max, finding.confidence),
    contributing[0].confidence,
  )
  if (distinctReviewerCount < 2) return highest
  const boosted = Math.round((highest + CONFIDENCE_AGREEMENT_BOOST) * 100) / 100
  return Math.min(MAX_CONFIDENCE, boosted)
}

/** `true` only when every contributing input is pre-existing; mixed
 * evidence is actionable (`false`). */
function derivePreExisting(contributing: MergeContributingFindings): boolean {
  return contributing.every((finding) => finding.pre_existing)
}

/** A stable fingerprint derived from the normalized file path, the
 * representative line, and the severity -- identical inputs always produce
 * an identical fingerprint. */
function deriveFingerprint(
  normalizedFile: string,
  representativeLine: number,
  severity: SurvivingFinding['severity'],
): string {
  return `${normalizedFile}:${representativeLine}:${severity}`
}

/**
 * The most permissive value, per the authored narrows-to table, that every
 * contributing value can reach by narrowing. Never derives its own
 * ordering: a candidate is valid only when every contributing value's table
 * entry lists it, and the chosen candidate is the one whose own table entry
 * lists every other valid candidate (the top of the valid subset).
 */
function meetOverNarrowsTo<Value extends string>(
  narrowsTo: Record<Value, readonly Value[]>,
  values: readonly Value[],
): Value | undefined {
  const domain = Object.keys(narrowsTo) as Value[]
  const validCandidates = domain.filter((candidate) =>
    values.every((value) => narrowsTo[value].includes(candidate)),
  )
  return validCandidates.find((candidate) =>
    validCandidates.every((other) => narrowsTo[candidate].includes(other)),
  )
}

/** Whether two routes are field-by-field identical. Shared by `deriveRoute`
 * (to detect an identity proposal) and `mergedFindingRouteNarrowed` (to
 * detect a carried route that diverges from the meet), so the two never
 * drift into separately hand-rolled comparisons. */
function routesEqual(a: PipelineRoute, b: PipelineRoute): boolean {
  return (
    a.autofix_class === b.autofix_class &&
    a.owner === b.owner &&
    a.requires_verification === b.requires_verification
  )
}

/** The route meet: the most permissive `{autofix_class, owner,
 * requires_verification}` that every contributing input permits, computed
 * per field from the exported `ROUTE_REFUSAL_TABLE` rather than a
 * hand-derived ordering. The `?? ` fallbacks are unreachable in practice --
 * each field's table always includes a terminal value reachable from every
 * other value -- but keep this total without a non-null assertion. */
function deriveRouteMeet(
  contributing: MergeContributingFindings,
): PipelineRoute {
  const autofixClasses = contributing.map((finding) => finding.autofix_class)
  const owners = contributing.map((finding) => finding.owner)
  const verifications = contributing.map((finding) =>
    finding.requires_verification ? ('true' as const) : ('false' as const),
  )

  return {
    autofix_class:
      meetOverNarrowsTo(ROUTE_REFUSAL_TABLE.autofix_class, autofixClasses) ??
      'advisory',
    owner: meetOverNarrowsTo(ROUTE_REFUSAL_TABLE.owner, owners) ?? 'release',
    requires_verification:
      (meetOverNarrowsTo(
        ROUTE_REFUSAL_TABLE.requires_verification,
        verifications,
      ) ?? 'true') === 'true',
  }
}

/**
 * Computes the route meet, then applies the model's proposed narrowing (if
 * any). A proposed route with no reason is rejected; a proposed route that
 * `isRouteTransitionAllowed` refuses from the meet (a widening or
 * incomparable transition) is rejected as `'route widening'`. The ok result
 * also reports `differsFromMeet` -- whether the resolved route is actually
 * distinct from the meet computed here -- so assembly can decide whether
 * `route_narrowing_reason` belongs on the wire without recomputing the meet
 * a second time. A `proposed_route` identical to the meet (an identity
 * "narrowing") is accepted like any other valid transition; the model
 * cannot see `ROUTE_REFUSAL_TABLE` and so cannot know in advance that its
 * proposal was already the meet.
 */
function deriveRoute(
  contributing: MergeContributingFindings,
  decision: MergedFindingModelDecision,
):
  | {
      readonly ok: true
      readonly value: PipelineRoute
      readonly differsFromMeet: boolean
    }
  | { readonly ok: false; readonly rejection: MergedFindingRejection } {
  const meet = deriveRouteMeet(contributing)
  if (!decision.proposed_route) {
    return { ok: true, value: meet, differsFromMeet: false }
  }

  if (!decision.route_narrowing_reason) {
    return rejectMergedFinding(
      formatReviewArtifactIssuePath(['route_narrowing_reason']),
      'route narrowing missing reason',
    )
  }

  if (!isRouteTransitionAllowed(meet, decision.proposed_route)) {
    return rejectMergedFinding(
      formatReviewArtifactIssuePath(['proposed_route']),
      'route widening',
    )
  }

  return {
    ok: true,
    value: decision.proposed_route,
    differsFromMeet: !routesEqual(meet, decision.proposed_route),
  }
}

/**
 * Derives one merged finding's mechanical fields -- severity, submitters,
 * confidence, agreement credit, `pre_existing`, fingerprint, and route --
 * from its contributing surviving findings plus the model's decision fields
 * for that group. Assumes `validateAdjudication` already confirmed the
 * partition; never re-validates group membership. Rejection is
 * whole-decision only: an invalid agreement-credit claim or a route
 * widening attempt rejects the whole derivation with a fixed reason code
 * and a safe JSON path, never payload content.
 */
export function deriveMergedFindingFields(
  input: DeriveMergedFindingInput,
): DeriveMergedFindingResult {
  const submitters = deriveSubmitters(input.contributing)
  const submitterSet = new Set(submitters)
  const returnedReviewerSet = new Set(input.returned_reviewers)

  const agreementCreditResult = deriveAgreementCredit(
    input.decision.eligible_agreement_credit,
    submitterSet,
    returnedReviewerSet,
  )
  if (!agreementCreditResult.ok) return agreementCreditResult

  const routeResult = deriveRoute(input.contributing, input.decision)
  if (!routeResult.ok) return routeResult

  const severity = deriveSeverity(input.contributing)
  const distinctReviewerCount =
    submitters.length + agreementCreditResult.value.length
  const confidence = deriveConfidence(input.contributing, distinctReviewerCount)
  const preExisting = derivePreExisting(input.contributing)
  const normalizedFile = normalizeRepoRelativePath(input.contributing[0].file)
  const fingerprint = deriveFingerprint(
    normalizedFile,
    input.decision.line,
    severity,
  )

  return {
    ok: true,
    value: {
      severity,
      submitters,
      confidence,
      agreement_credit: agreementCreditResult.value,
      pre_existing: preExisting,
      fingerprint,
      route: routeResult.value,
      route_differs_from_meet: routeResult.differsFromMeet,
    },
  }
}

// --- merge phase: adjudication application -----------------------------------
//
// Pure, side-effect-free assembly of the full merge phase: validates the
// adjudication partition, derives every merged finding's mechanical fields,
// emits the validator request set, sorts everything stably, and returns a
// `MergeOutputSchema`-conforming result. This is assembly only -- the two
// hard parts (`validateAdjudication`, `deriveMergedFindingFields`) already
// exist above and are never re-derived here. Never reads `process.env`, the
// filesystem, or the clock.

export type MergeOutput = ReturnType<typeof MergeOutputSchema.parse>

/** Raw application input: the prepared candidate state plus the model's
 * adjudication decisions, matching `MergeInputSchema`'s two fields exactly. */
export interface ApplyReviewAdjudicationInput {
  readonly prepared: PrepareOutput
  readonly decisions: AdjudicationDecisions
}

export type ApplyReviewAdjudicationResult =
  | { readonly ok: true; readonly value: MergeOutput }
  | {
      readonly ok: false
      readonly rejection: AdjudicationRejection | MergedFindingRejection
    }

/** Parses the persona prefix out of a stable `<persona>#<index>` input ID --
 * the exact convention `screenReviewReturn` mints every input ID under. Used
 * only where a reviewer identity is otherwise unavailable (a suppressed
 * confidence disposition carries no `reviewer` field of its own). */
function reviewerFromInputId(inputId: string): string {
  const separatorIndex = inputId.indexOf('#')
  return separatorIndex === -1 ? inputId : inputId.slice(0, separatorIndex)
}

/**
 * Every reviewer whose `SubAgentReturn` contributed at least one admitted
 * finding to this run -- the eligibility set `deriveMergedFindingFields`
 * checks claimed agreement credit against. Surviving findings already carry
 * their reviewer directly; a suppressed finding does not, so its reviewer is
 * recovered from its stable input ID instead.
 */
function deriveReturnedReviewers(prepared: PrepareOutput): readonly string[] {
  const reviewers = new Set<string>()
  for (const finding of prepared.surviving_findings) {
    reviewers.add(finding.reviewer)
  }
  for (const disposition of prepared.confidence_dispositions) {
    if (disposition.disposition === 'suppressed') {
      reviewers.add(reviewerFromInputId(disposition.input_id))
    }
  }
  return [...reviewers]
}

function buildSurvivingFindingIndex(
  prepared: PrepareOutput,
): ReadonlyMap<string, SurvivingFinding> {
  return new Map(
    prepared.surviving_findings.map((finding) => [finding.input_id, finding]),
  )
}

/** Resolves one stable input ID to its surviving finding. Unreachable in
 * practice: `validateAdjudication` only accepts input IDs that are real
 * candidate-group members, and every candidate-group member originates from
 * `prepared.surviving_findings` in `prepareReviewCandidates` -- the two are
 * always constructed from the same survivor set. Throws rather than
 * returning a bounded rejection because a lookup miss here is a pipeline
 * data-integrity violation, not a malformed model decision. */
function requireSurvivingFinding(
  index: ReadonlyMap<string, SurvivingFinding>,
  inputId: string,
): SurvivingFinding {
  const finding = index.get(inputId)
  if (!finding) {
    throw new Error(
      `applyReviewAdjudication: no surviving finding for input ID ${inputId}`,
    )
  }
  return finding
}

/** Narrows a findings array to the non-empty tuple `deriveMergedFindingFields`
 * requires. Unreachable in practice: every caller supplies either a
 * validated merge group (`MergedDecisionSchema.input_finding_ids` is
 * `.min(2)`, already enforced when `decisions` was parsed) or a duplicated
 * singleton finding -- both always yield >= 2 entries. */
function toContributingTuple(
  findings: readonly SurvivingFinding[],
): MergeContributingFindings {
  const [first, second, ...rest] = findings
  if (!first || !second) {
    throw new Error(
      'applyReviewAdjudication: contributing findings require at least two entries',
    )
  }
  return [first, second, ...rest]
}

/** One assembled merged finding carrying every field `MergedFindingSchema`
 * exposes on the wire, including the mechanically-derived fields
 * (`severity`, `confidence`, `pre_existing`, `fingerprint`, `submitters`)
 * that `deriveMergedFindingFields` produces and `toMergedFindingWireShape`
 * carries through untouched, never recomputed downstream (KTD19). */
interface MergedFindingAssembly {
  readonly finding_id: string
  readonly file: string
  readonly title: string
  readonly why_it_matters: string
  readonly line: number
  readonly evidence: SurvivingFinding['evidence']
  readonly suggested_fix: SurvivingFinding['suggested_fix']
  readonly input_finding_ids: readonly string[]
  readonly agreement_credit?: readonly string[]
  readonly severity: SurvivingFinding['severity']
  readonly confidence: number
  readonly pre_existing: boolean
  readonly fingerprint: string
  readonly submitters: readonly string[]
  readonly autofix_class: PipelineRoute['autofix_class']
  readonly owner: PipelineRoute['owner']
  readonly requires_verification: boolean
  readonly route_narrowing_reason?: string
}

type AssembleFindingResult =
  | { readonly ok: true; readonly value: MergedFindingAssembly }
  | { readonly ok: false; readonly rejection: MergedFindingRejection }

function assemblyFromDerivation(
  base: {
    readonly finding_id: string
    readonly file: string
    readonly title: string
    readonly why_it_matters: string
    readonly line: number
    readonly evidence: SurvivingFinding['evidence']
    readonly suggested_fix: SurvivingFinding['suggested_fix']
    readonly input_finding_ids: readonly string[]
    readonly route_narrowing_reason?: string
  },
  derived: DerivedMergedFindingFields,
): MergedFindingAssembly {
  return {
    ...base,
    agreement_credit:
      derived.agreement_credit.length > 0
        ? derived.agreement_credit
        : undefined,
    severity: derived.severity,
    confidence: derived.confidence,
    pre_existing: derived.pre_existing,
    fingerprint: derived.fingerprint,
    submitters: derived.submitters,
    autofix_class: derived.route.autofix_class,
    owner: derived.route.owner,
    requires_verification: derived.route.requires_verification,
  }
}

/** Assembles one merged group's finding: resolves its contributing survivors
 * by stable input ID (sorted, so contributor order never depends on
 * decision-citation order), derives its mechanical fields, and carries the
 * model-owned narrative fields (title, why-it-matters, evidence, suggested
 * fix, representative line) through untouched. */
function assembleMergedGroupFinding(
  group: ValidatedMergedGroup,
  survivingIndex: ReadonlyMap<string, SurvivingFinding>,
  returnedReviewers: readonly string[],
): AssembleFindingResult {
  const decision = group.decision
  const sortedInputIds = [...decision.input_finding_ids].sort(compareStrings)
  const contributing = toContributingTuple(
    sortedInputIds.map((inputId) =>
      requireSurvivingFinding(survivingIndex, inputId),
    ),
  )

  const derived = deriveMergedFindingFields({
    contributing,
    decision: {
      line: decision.line,
      eligible_agreement_credit: decision.eligible_agreement_credit,
      proposed_route: decision.proposed_route,
      route_narrowing_reason: decision.route_narrowing_reason,
    },
    returned_reviewers: returnedReviewers,
  })
  if (!derived.ok) return derived

  return {
    ok: true,
    value: assemblyFromDerivation(
      {
        finding_id: decision.decision_id,
        file: group.file,
        title: decision.title,
        why_it_matters: decision.why_it_matters,
        line: decision.line,
        evidence: decision.evidence,
        suggested_fix: decision.suggested_fix,
        input_finding_ids: sortedInputIds,
        route_narrowing_reason: derived.value.route_differs_from_meet
          ? decision.route_narrowing_reason
          : undefined,
      },
      derived.value,
    ),
  }
}

/** Assembles one singleton finding -- either a model-declined candidate or a
 * true passthrough singleton that was never grouped. Both have exactly one
 * contributing finding, so it is duplicated to satisfy
 * `deriveMergedFindingFields`'s non-empty-tuple contract; every derivation
 * in that function is idempotent under duplication (max/every/distinct-set
 * operations), so the result is identical to a hypothetical single-input
 * derivation. The model-owned narrative fields (title, why-it-matters,
 * evidence, suggested fix) are carried through from the finding itself,
 * since a singleton decision never states its own. */
function assembleSingletonFinding(
  findingId: string,
  finding: SurvivingFinding,
  decisionFields: {
    readonly proposed_route?: PipelineRoute
    readonly route_narrowing_reason?: string
  },
  returnedReviewers: readonly string[],
): AssembleFindingResult {
  const contributing: MergeContributingFindings = [finding, finding]

  const derived = deriveMergedFindingFields({
    contributing,
    decision: {
      line: finding.line,
      proposed_route: decisionFields.proposed_route,
      route_narrowing_reason: decisionFields.route_narrowing_reason,
    },
    returned_reviewers: returnedReviewers,
  })
  if (!derived.ok) return derived

  return {
    ok: true,
    value: assemblyFromDerivation(
      {
        finding_id: findingId,
        file: normalizeRepoRelativePath(finding.file),
        title: finding.title,
        why_it_matters: finding.why_it_matters,
        line: finding.line,
        evidence: finding.evidence,
        suggested_fix: finding.suggested_fix,
        input_finding_ids: [finding.input_id],
        route_narrowing_reason: derived.value.route_differs_from_meet
          ? decisionFields.route_narrowing_reason
          : undefined,
      },
      derived.value,
    ),
  }
}

/** The subset of a merged finding's fields the canonical order sorts by.
 * Deliberately narrower than `MergedFindingAssembly`: both the merge
 * phase's in-progress assembly and the finalize phase's `ReconciledFinding`
 * (the same fields, already on the wire) satisfy this shape, so one
 * comparator serves both without either phase re-deriving order from a
 * different field set. */
interface MergedFindingOrderKey {
  readonly finding_id: string
  readonly file: string
  readonly severity: SurvivingFinding['severity']
  readonly confidence: number
  readonly fingerprint: string
  readonly line: number
}

/**
 * Total order over assembled findings: severity (`P0` first), then
 * confidence descending, then normalized file path, then line, then
 * fingerprint, then the stable input finding ID as a final tiebreak. Every
 * field is either mechanically derived or a stable input, so this order
 * never depends on decision or candidate-group iteration order.
 *
 * The finding-ID tiebreak is necessary, not redundant with fingerprint:
 * `deriveFingerprint` computes its value purely from normalized file, line,
 * and severity, so two distinct findings that already tie on all of
 * severity/confidence/path/line also tie on fingerprint by construction.
 * Without a further key, that case would leave relative order undefined
 * (not total); `finding_id` is unique per assembly and breaks that tie
 * deterministically.
 *
 * Reused by the risk-coverage phase's `deriveCoverageForLostPersona` to
 * order lost-persona citation candidates -- never a second, divergent
 * ordering.
 */
function compareMergedFindingAssembly(
  a: MergedFindingOrderKey,
  b: MergedFindingOrderKey,
): number {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (severityDelta !== 0) return severityDelta
  if (a.confidence !== b.confidence) return b.confidence - a.confidence
  const pathDelta = compareStrings(a.file, b.file)
  if (pathDelta !== 0) return pathDelta
  if (a.line !== b.line) return a.line - b.line
  const fingerprintDelta = compareStrings(a.fingerprint, b.fingerprint)
  if (fingerprintDelta !== 0) return fingerprintDelta
  return compareStrings(a.finding_id, b.finding_id)
}

/** The subset of a merged finding's fields `requiresValidatorRequest` reads.
 * Deliberately narrower than `MergedFindingAssembly`: the merge phase's
 * in-progress assembly and the finalize phase's wire-shape merged finding
 * (the same two fields, already on the wire) both satisfy this shape. */
interface ValidatorRequestEligibility {
  readonly severity: SurvivingFinding['severity']
  readonly requires_verification: boolean
}

/** The validator request set is purely mechanical: exactly every merged
 * finding that is `P0` or `P1`, plus every merged finding with
 * `requires_verification: true`. Never model-influenced beyond the route
 * `requires_verification` value `deriveMergedFindingFields` already
 * computed. */
function requiresValidatorRequest(
  assembly: ValidatorRequestEligibility,
): boolean {
  return (
    assembly.severity === 'P0' ||
    assembly.severity === 'P1' ||
    assembly.requires_verification
  )
}

function toMergedFindingWireShape(
  assembly: MergedFindingAssembly,
): MergeOutput['merged_findings'][number] {
  return {
    finding_id: assembly.finding_id,
    file: assembly.file,
    title: assembly.title,
    why_it_matters: assembly.why_it_matters,
    line: assembly.line,
    autofix_class: assembly.autofix_class,
    owner: assembly.owner,
    requires_verification: assembly.requires_verification,
    evidence: assembly.evidence,
    suggested_fix: assembly.suggested_fix,
    input_finding_ids: [...assembly.input_finding_ids],
    severity: assembly.severity,
    confidence: assembly.confidence,
    pre_existing: assembly.pre_existing,
    fingerprint: assembly.fingerprint,
    submitters: [...assembly.submitters],
    ...(assembly.agreement_credit
      ? { agreement_credit: [...assembly.agreement_credit] }
      : {}),
    ...(assembly.route_narrowing_reason !== undefined
      ? { route_narrowing_reason: assembly.route_narrowing_reason }
      : {}),
  }
}

/** Which of the three assembly sources produced one assembled finding's
 * `finding_id`: a merge group's model-chosen `decision_id`, a declined
 * singleton's model-chosen `decision_id`, or a passthrough singleton's
 * carried-through `input_id`. Tracked only to name a collision's origin in
 * `checkNoDuplicateAssembledFindingIds`'s rejection reason -- never exposed
 * on `MergedFindingAssembly` itself. */
type MergeAssemblyOrigin =
  | 'merged group'
  | 'declined decision'
  | 'passthrough singleton'

interface MergeAssemblyOriginEntry {
  readonly finding_id: string
  readonly origin: MergeAssemblyOrigin
}

function mergeFindingIdCollisionReason(
  first: MergeAssemblyOrigin,
  second: MergeAssemblyOrigin,
): AdjudicationRejectReason {
  if (first === second) {
    if (first === 'merged group') return 'duplicate merged group decision id'
    if (first === 'declined decision') return 'duplicate declined decision id'
    return 'duplicate passthrough singleton input id'
  }
  const pair = [first, second].sort(compareStrings).join('|')
  if (pair === 'declined decision|merged group') {
    return 'declined decision id collides with merged group decision id'
  }
  if (pair === 'declined decision|passthrough singleton') {
    return 'declined decision id collides with passthrough singleton input id'
  }
  return 'passthrough singleton input id collides with merged group decision id'
}

/** Rejects a `finding_id` collision between any two of the three assembly
 * sources (merge group, declined singleton, passthrough singleton) before
 * `MergeOutputSchema.parse` -- so a colliding ID fails closed at merge
 * rather than surviving an entire validator dispatch round to be caught
 * only by finalize's `checkNoDuplicateMergedFindingIds`. Never namespaces
 * or rewrites a colliding ID; a collision is always a hard rejection. */
function checkNoDuplicateAssembledFindingIds(
  origins: readonly MergeAssemblyOriginEntry[],
): AdjudicationRejection | undefined {
  const seen = new Map<string, MergeAssemblyOrigin>()
  for (const [index, entry] of origins.entries()) {
    const priorOrigin = seen.get(entry.finding_id)
    if (priorOrigin !== undefined) {
      return {
        path: formatReviewArtifactIssuePath([
          'merge_assembly',
          index,
          'finding_id',
        ]),
        reason: mergeFindingIdCollisionReason(priorOrigin, entry.origin),
      }
    }
    seen.set(entry.finding_id, entry.origin)
  }
  return undefined
}

/**
 * The top-level merge phase: validates the adjudication partition, derives
 * every merged finding (one per merge group, one per declined singleton, one
 * per passthrough singleton) via `deriveMergedFindingFields`, emits the
 * mechanical validator request set, sorts everything stably, and parses the
 * assembled result through `MergeOutputSchema` before returning success.
 *
 * Rejection is whole-phase only: a partition violation from
 * `validateAdjudication` or a field-derivation violation from
 * `deriveMergedFindingFields` (for any single group or singleton) aborts
 * immediately with no partial output -- this function never accumulates
 * merged findings past the first rejection, and never calls
 * `MergeOutputSchema.parse` until every finding derived successfully. A
 * `finding_id` collision across the three assembly sources -- a merge
 * group's or declined singleton's model-chosen `decision_id`, or a
 * passthrough singleton's carried-through `input_id` -- also rejects before
 * parsing (`checkNoDuplicateAssembledFindingIds`), never silently
 * namespaced or rewritten.
 *
 * The top-level `disagreement_facts` collects every decision's own
 * `disagreement_facts`, plus every declined decision's `declined_reason` --
 * the "why these were not merged" narrative that has no dedicated field on
 * `MergedFindingSchema` itself.
 */
export function applyReviewAdjudication(
  input: ApplyReviewAdjudicationInput,
): ApplyReviewAdjudicationResult {
  const validated = validateAdjudication(input.prepared, input.decisions)
  if (!validated.ok) return validated

  const survivingIndex = buildSurvivingFindingIndex(input.prepared)
  const returnedReviewers = deriveReturnedReviewers(input.prepared)

  const assemblies: MergedFindingAssembly[] = []
  const assemblyOrigins: MergeAssemblyOriginEntry[] = []
  const disagreementFacts: string[] = []

  for (const group of validated.value.merged) {
    const result = assembleMergedGroupFinding(
      group,
      survivingIndex,
      returnedReviewers,
    )
    if (!result.ok) return result
    assemblies.push(result.value)
    assemblyOrigins.push({
      finding_id: result.value.finding_id,
      origin: 'merged group',
    })
    if (group.decision.disagreement_facts) {
      disagreementFacts.push(...group.decision.disagreement_facts)
    }
  }

  for (const singleton of validated.value.declined) {
    const finding = requireSurvivingFinding(
      survivingIndex,
      singleton.decision.input_finding_id,
    )
    const result = assembleSingletonFinding(
      singleton.decision.decision_id,
      finding,
      {
        proposed_route: singleton.decision.proposed_route,
        route_narrowing_reason: singleton.decision.route_narrowing_reason,
      },
      returnedReviewers,
    )
    if (!result.ok) return result
    assemblies.push(result.value)
    assemblyOrigins.push({
      finding_id: result.value.finding_id,
      origin: 'declined decision',
    })
    disagreementFacts.push(singleton.decision.declined_reason)
    if (singleton.decision.disagreement_facts) {
      disagreementFacts.push(...singleton.decision.disagreement_facts)
    }
  }

  for (const inputId of validated.value.singletons) {
    const finding = requireSurvivingFinding(survivingIndex, inputId)
    const result = assembleSingletonFinding(
      inputId,
      finding,
      {},
      returnedReviewers,
    )
    if (!result.ok) return result
    assemblies.push(result.value)
    assemblyOrigins.push({
      finding_id: result.value.finding_id,
      origin: 'passthrough singleton',
    })
  }

  const collision = checkNoDuplicateAssembledFindingIds(assemblyOrigins)
  if (collision) return { ok: false, rejection: collision }

  assemblies.sort(compareMergedFindingAssembly)
  disagreementFacts.sort(compareStrings)

  const mergedFindings = assemblies.map(toMergedFindingWireShape)
  const validatorRequests = assemblies
    .filter(requiresValidatorRequest)
    .map((assembly) => ({
      finding_id: assembly.finding_id,
      file: assembly.file,
      line: assembly.line,
    }))

  return {
    ok: true,
    value: MergeOutputSchema.parse({
      merged_findings: mergedFindings,
      validator_requests: validatorRequests,
      disagreement_facts: disagreementFacts,
    }),
  }
}

// --- finalize phase: validator lifecycle reconciliation ---------------------
//
// Pure, side-effect-free reconciliation of finding-validator lifecycle
// results against the merge phase's validator request set. This is a
// finalize-phase step: it only settles each merged finding's validation
// state (validated / filtered / uncertain) and records lifecycle failures
// for a later slice to surface. It never builds action queues, disposition
// counts, risk coverage, plan-assessment routing, or the final artifact --
// those are separate slices. Never reads `process.env`, the filesystem, or
// the clock.

type ValidatorLifecycleResults = z.infer<typeof ValidatorLifecycleResultsSchema>
type ValidatorLifecycleRecord = ValidatorLifecycleResults[number]
type ValidatorLifecycleResult = ValidatorLifecycleRecord['result']

/** One merged finding carrying its reconciled validation state. `validated`
 * is `true` when a validator confirmed the finding, `false` when a
 * validator disproved it, and *absent* -- never coerced to either boolean
 * -- both when the finding was never requested for validation and when its
 * validator run failed or was unavailable. A consumer distinguishes those
 * two absent cases by cross-referencing `lifecycle_failures`: a finding_id
 * present there was requested but left uncertain by a `failed` or
 * `unavailable` outcome; a finding_id absent from both `lifecycle_failures`
 * and carrying no `validated` field was never requested at all. */
export type ReconciledFinding = MergeOutput['merged_findings'][number] & {
  readonly validated?: boolean
  /** The disproving validator's own reason, carried onto the finding only
   * when `validated` is `false` -- satisfies the artifact's
   * `validation_reason` requirement at source instead of losing the reason
   * on the way from the lifecycle result to the reconciled finding. Absent
   * whenever `validated` is not `false`. */
  readonly validation_reason?: string
}

/** One recorded validator lifecycle failure: a requested finding whose
 * validator run ended in uncertainty (`failed` or `unavailable`) rather
 * than a definite answer. The `outcome` discriminant distinguishes a
 * timeout/error from a validator that was never reachable at all. */
export interface ValidatorLifecycleFailure {
  readonly finding_id: string
  readonly outcome: 'failed' | 'unavailable'
  readonly reason: string
}

export interface ReconcileValidatorResultsOutput {
  readonly findings: readonly ReconciledFinding[]
  readonly filtered_finding_ids: readonly string[]
  readonly filtered_input_ids: readonly string[]
  readonly lifecycle_failures: readonly ValidatorLifecycleFailure[]
  readonly degraded: boolean
}

type ReconcileValidatorResultsRejectReason =
  | 'missing validator result'
  | 'duplicate validator result'
  | 'unrequested validator result'

/** One bounded, payload-safe rejection diagnostic: a fixed reason code and a
 * safe JSON path only. Never payload content, never a finding title. */
export interface ReconcileValidatorResultsRejection {
  readonly path: string
  readonly reason: ReconcileValidatorResultsRejectReason
}

export interface ReconcileValidatorResultsInput {
  readonly merge: MergeOutput
  readonly validator_lifecycle_results: ValidatorLifecycleResults
}

export type ReconcileValidatorResultsResult =
  | { readonly ok: true; readonly value: ReconcileValidatorResultsOutput }
  | {
      readonly ok: false
      readonly rejection: ReconcileValidatorResultsRejection
    }

function rejectReconcile(
  path: string,
  reason: ReconcileValidatorResultsRejectReason,
): {
  readonly ok: false
  readonly rejection: ReconcileValidatorResultsRejection
} {
  return { ok: false, rejection: { path, reason } }
}

/**
 * Indexes the lifecycle results by finding ID, rejecting a duplicate result
 * for the same finding ID or a result for a finding ID absent from the
 * request set. Returns the first violation found, in result order.
 */
function indexLifecycleResults(
  results: ValidatorLifecycleResults,
  requestedIds: ReadonlySet<string>,
):
  | {
      readonly ok: true
      readonly value: ReadonlyMap<string, ValidatorLifecycleResult>
    }
  | {
      readonly ok: false
      readonly rejection: ReconcileValidatorResultsRejection
    } {
  const resultsByFindingId = new Map<string, ValidatorLifecycleResult>()
  for (const [index, record] of results.entries()) {
    const path = formatReviewArtifactIssuePath([
      'validator_lifecycle_results',
      index,
      'finding_id',
    ])
    if (resultsByFindingId.has(record.finding_id)) {
      return rejectReconcile(path, 'duplicate validator result')
    }
    if (!requestedIds.has(record.finding_id)) {
      return rejectReconcile(path, 'unrequested validator result')
    }
    resultsByFindingId.set(record.finding_id, record.result)
  }
  return { ok: true, value: resultsByFindingId }
}

/**
 * Every requested finding ID must have a corresponding lifecycle result.
 * Returns the first missing request, in request order.
 */
function validateNoMissingResults(
  validatorRequests: MergeOutput['validator_requests'],
  resultsByFindingId: ReadonlyMap<string, ValidatorLifecycleResult>,
): ReconcileValidatorResultsRejection | undefined {
  for (const [index, request] of validatorRequests.entries()) {
    if (!resultsByFindingId.has(request.finding_id)) {
      return {
        path: formatReviewArtifactIssuePath([
          'validator_requests',
          index,
          'finding_id',
        ]),
        reason: 'missing validator result',
      }
    }
  }
  return undefined
}

interface ClassifiedFinding {
  readonly finding: ReconciledFinding
  readonly filtered: boolean
  readonly failure?: ValidatorLifecycleFailure
}

/**
 * Classifies one merged finding against its lifecycle result (if any):
 * `true` validates it, `false` filters it, `failed`/`unavailable` leave it
 * actionable but uncertain and record a lifecycle failure, and no result at
 * all (never requested) leaves it untouched.
 */
function classifyFinding(
  finding: MergeOutput['merged_findings'][number],
  result: ValidatorLifecycleResult | undefined,
): ClassifiedFinding {
  if (!result) return { finding: { ...finding }, filtered: false }

  if (result.outcome === 'true') {
    return { finding: { ...finding, validated: true }, filtered: false }
  }

  if (result.outcome === 'false') {
    return {
      finding: {
        ...finding,
        validated: false,
        validation_reason: result.reason,
      },
      filtered: true,
    }
  }

  return {
    finding: { ...finding },
    filtered: false,
    failure: {
      finding_id: finding.finding_id,
      outcome: result.outcome,
      reason: result.reason,
    },
  }
}

/**
 * Reconciles the finding-validator lifecycle results against the merge
 * output's validator request set, classifying every merged finding as
 * validated, filtered, or left uncertain (see `ReconciledFinding` for the
 * full state table). Rejection is whole-payload only: a missing result, a
 * duplicate result, or a result for a finding that was never requested
 * rejects everything, with a fixed reason code and a safe JSON path -- never
 * payload content or a finding title.
 *
 * This reconciles validator results only -- it never builds action queues,
 * disposition counts, risk coverage, plan-assessment routing, or the final
 * artifact; those are separate slices. Never reads `process.env`, the
 * filesystem, or the clock.
 */
export function reconcileValidatorResults(
  input: ReconcileValidatorResultsInput,
): ReconcileValidatorResultsResult {
  const requestedIds = new Set(
    input.merge.validator_requests.map((request) => request.finding_id),
  )

  const indexed = indexLifecycleResults(
    input.validator_lifecycle_results,
    requestedIds,
  )
  if (!indexed.ok) return indexed

  const missingViolation = validateNoMissingResults(
    input.merge.validator_requests,
    indexed.value,
  )
  if (missingViolation) return { ok: false, rejection: missingViolation }

  const findings: ReconciledFinding[] = []
  const filteredFindingIds = new Set<string>()
  const filteredInputIds = new Set<string>()
  const lifecycleFailures: ValidatorLifecycleFailure[] = []

  for (const finding of input.merge.merged_findings) {
    const classified = classifyFinding(
      finding,
      indexed.value.get(finding.finding_id),
    )
    findings.push(classified.finding)
    if (classified.filtered) {
      filteredFindingIds.add(finding.finding_id)
      for (const inputId of finding.input_finding_ids) {
        filteredInputIds.add(inputId)
      }
    }
    if (classified.failure) lifecycleFailures.push(classified.failure)
  }

  lifecycleFailures.sort((a, b) => compareStrings(a.finding_id, b.finding_id))

  return {
    ok: true,
    value: {
      findings,
      filtered_finding_ids: [...filteredFindingIds].sort(compareStrings),
      filtered_input_ids: [...filteredInputIds].sort(compareStrings),
      lifecycle_failures: lifecycleFailures,
      degraded: lifecycleFailures.length > 0,
    },
  }
}

// --- finalize context phase: cross-phase join validation and loss/rejection
// derivation ------------------------------------------------------------------
//
// Everything the finalize phase and the risk-coverage phase need but cannot
// derive from their own trusted-input assumptions: `rejected_payloads` and
// `lost_risk_critical_personas`. Per KTD19, every carried field on the merge
// wire is a trust input, not proof -- this phase re-runs
// `deriveMergedFindingFields` over the carried survivors as a verifier and
// rejects any carried field that diverges. It also validates that
// `dispatch_records`, `parent_run_metadata.selected_dispatches`, and
// `screen_results` form an exact one-to-one join before deriving anything,
// so a caller can never omit a loss or disagree with ledger counts by
// mismatching the envelope. Never reads `process.env`, the filesystem, or
// the clock.

export type FinalizeInputValue = ReturnType<typeof FinalizeInputSchema.parse>
type FinalizeScreenResults = FinalizeInputValue['screen_results']
type FinalizeScreenResult = FinalizeScreenResults[number]
type FinalizeDispatchRecords = FinalizeInputValue['dispatch_records']
type FinalizeDispatchRecord = FinalizeDispatchRecords[number]
type FinalizeParentRunMetadata = FinalizeInputValue['parent_run_metadata']

export interface DeriveFinalizeContextInput {
  readonly merge: MergeOutput
  readonly prepared: PrepareOutput
  readonly screen_results: FinalizeScreenResults
  readonly dispatch_records: FinalizeDispatchRecords
  readonly parent_run_metadata: Pick<
    FinalizeParentRunMetadata,
    'selected_dispatches' | 'validation'
  >
}

export interface FinalizeContext {
  readonly rejected_payloads: readonly RejectedPayloadWeight[]
  readonly lost_risk_critical_personas: readonly LostRiskCriticalPersona[]
}

type FinalizeContextRejectReason =
  | 'duplicate merged finding ID'
  | 'merged finding references unknown survivor'
  | 'survivor missing from merge inputs'
  | 'survivor claimed by multiple merged findings'
  | 'validator request references unknown merged finding'
  | 'dispatch record mismatch'
  | 'duplicate selection surface entry'
  | 'screen result missing for selected persona'
  | 'unexpected screen result for persona'
  | 'screen result outcome does not match dispatch record'
  | 'merged finding fields diverge from derivation'
  | 'merged finding route narrowing reason mismatch'
  | 'confidence disposition references unscreened finding'
  | 'merged finding cites input from unavailable reviewer'
  | 'merged finding submitter not a cited reviewer'
  | 'merged finding agreement credit overlaps submitters'
  | 'surviving finding diverges from its screened finding'
  | 'surviving finding references unscreened input'
  | 'duplicate confidence disposition'
  | 'validation must be not_attempted at finalize'

export interface FinalizeContextRejection {
  readonly path: string
  readonly reason: FinalizeContextRejectReason
}

export type DeriveFinalizeContextResult =
  | { readonly ok: true; readonly value: FinalizeContext }
  | { readonly ok: false; readonly rejection: FinalizeContextRejection }

function rejectFinalizeContext(
  path: string,
  reason: FinalizeContextRejectReason,
): { readonly ok: false; readonly rejection: FinalizeContextRejection } {
  return { ok: false, rejection: { path, reason } }
}

type FinalizeContextCheckResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly rejection: FinalizeContextRejection }

/** Normalizes a `selection_surface` for order-insensitive comparison: each
 * entry through `normalizeRepoRelativePath`, then sorted. `undefined` stays
 * `undefined` here -- its one caller, `dispatchRecordsEqual`, applies `?? []`
 * on both sides before comparing, so an absent surface and an explicitly
 * empty one compare equal there (both mean "no surface"), deliberately. */
function normalizeSelectionSurface(
  surface: readonly string[] | undefined,
): readonly string[] | undefined {
  if (surface === undefined) return undefined
  return [...surface].map(normalizeRepoRelativePath).sort(compareStrings)
}

/** Whether a `selection_surface` contains a duplicate entry once normalized
 * -- checked before comparison so a duplicate is always its own rejection
 * rather than a silent dedup. */
function selectionSurfaceHasDuplicates(
  surface: readonly string[] | undefined,
): boolean {
  if (surface === undefined) return false
  const normalized = surface.map(normalizeRepoRelativePath)
  return new Set(normalized).size !== normalized.length
}

function dispatchRecordsEqual(
  a: FinalizeDispatchRecord,
  b: FinalizeDispatchRecord,
): boolean {
  return (
    a.persona === b.persona &&
    a.dispatch_outcome === b.dispatch_outcome &&
    JSON.stringify(normalizeSelectionSurface(a.selection_surface) ?? []) ===
      JSON.stringify(normalizeSelectionSurface(b.selection_surface) ?? []) &&
    a.selection_reason === b.selection_reason
  )
}

const FINALIZE_CONTEXT_LOSS_DISPATCH_OUTCOMES = new Set<string>([
  'malformed',
  'never_returned',
  'validation_unavailable',
])
const FINALIZE_CONTEXT_LOSS_SEVERITIES = new Set<string>([
  'P0',
  'P1',
  'unknown',
])

/** Rejects a duplicate `finding_id` in `merge.merged_findings` -- every later
 * step indexes by `finding_id`, so a duplicate would silently shadow one of
 * the two rows. Returns the full ID set on success, reused to validate
 * `validator_requests` below without a second pass. */
function checkNoDuplicateMergedFindingIds(
  mergedFindings: MergeOutput['merged_findings'],
): FinalizeContextCheckResult<ReadonlySet<string>> {
  const seenFindingIds = new Set<string>()
  for (const [index, finding] of mergedFindings.entries()) {
    if (seenFindingIds.has(finding.finding_id)) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath([
          'merge',
          'merged_findings',
          index,
          'finding_id',
        ]),
        'duplicate merged finding ID',
      )
    }
    seenFindingIds.add(finding.finding_id)
  }
  return { ok: true, value: seenFindingIds }
}

/** Checks that survivors partition exactly into merged-finding inputs: every
 * merged finding's input IDs must resolve to a real survivor, and every
 * survivor must be covered by some merged finding. Also builds the
 * per-finding contributing tuple the KTD19 verifier reuses, so survivors are
 * resolved only once. */
function checkSurvivorPartition(
  mergedFindings: MergeOutput['merged_findings'],
  survivingFindings: PrepareOutput['surviving_findings'],
  survivingIndex: ReadonlyMap<string, SurvivingFinding>,
): FinalizeContextCheckResult<
  ReadonlyMap<string, readonly SurvivingFinding[]>
> {
  const coveredInputIds = new Set<string>()
  const contributingByFindingId = new Map<string, readonly SurvivingFinding[]>()

  for (const [findingIndex, finding] of mergedFindings.entries()) {
    const sortedIds = [...finding.input_finding_ids].sort(compareStrings)
    const resolved: SurvivingFinding[] = []
    for (const [idIndex, inputId] of sortedIds.entries()) {
      const survivor = survivingIndex.get(inputId)
      if (!survivor) {
        return rejectFinalizeContext(
          formatReviewArtifactIssuePath([
            'merge',
            'merged_findings',
            findingIndex,
            'input_finding_ids',
            idIndex,
          ]),
          'merged finding references unknown survivor',
        )
      }
      if (coveredInputIds.has(inputId)) {
        return rejectFinalizeContext(
          formatReviewArtifactIssuePath([
            'merge',
            'merged_findings',
            findingIndex,
            'input_finding_ids',
            idIndex,
          ]),
          'survivor claimed by multiple merged findings',
        )
      }
      resolved.push(survivor)
      coveredInputIds.add(inputId)
    }
    contributingByFindingId.set(finding.finding_id, resolved)
  }

  for (const [survivorIndex, survivor] of survivingFindings.entries()) {
    if (!coveredInputIds.has(survivor.input_id)) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath([
          'prepared',
          'surviving_findings',
          survivorIndex,
          'input_id',
        ]),
        'survivor missing from merge inputs',
      )
    }
  }

  return { ok: true, value: contributingByFindingId }
}

/** Whether one validator request is anything other than an exact match for
 * its merged finding: an unknown finding ID, a finding that mechanically
 * doesn't require a validator request, or a carried `file`/`line` that
 * disagrees with the finding's own. */
function validatorRequestMismatches(
  request: MergeOutput['validator_requests'][number],
  findingById: ReadonlyMap<string, MergeOutput['merged_findings'][number]>,
  expectedFindingIds: ReadonlySet<string>,
): boolean {
  const finding = findingById.get(request.finding_id)
  return (
    !finding ||
    !expectedFindingIds.has(request.finding_id) ||
    request.file !== finding.file ||
    request.line !== finding.line
  )
}

/** The validator request set must equal exactly the mechanical set
 * `requiresValidatorRequest` computes over `merge.merged_findings` -- no
 * missing, extra, duplicate, or mismatched `file`/`line` request. A request
 * for an unknown finding ID is a data-integrity violation, not a malformed
 * model decision. */
function checkValidatorRequestsResolve(
  validatorRequests: MergeOutput['validator_requests'],
  mergedFindings: MergeOutput['merged_findings'],
): FinalizeContextRejection | undefined {
  const findingById = new Map(
    mergedFindings.map((finding) => [finding.finding_id, finding] as const),
  )
  const expectedFindingIds = new Set(
    mergedFindings
      .filter((finding) => requiresValidatorRequest(finding))
      .map((finding) => finding.finding_id),
  )

  const seenFindingIds = new Set<string>()
  for (const [index, request] of validatorRequests.entries()) {
    const path = formatReviewArtifactIssuePath([
      'merge',
      'validator_requests',
      index,
      'finding_id',
    ])
    if (
      seenFindingIds.has(request.finding_id) ||
      validatorRequestMismatches(request, findingById, expectedFindingIds)
    ) {
      return {
        path,
        reason: 'validator request references unknown merged finding',
      }
    }
    seenFindingIds.add(request.finding_id)
  }

  if (seenFindingIds.size !== expectedFindingIds.size) {
    return {
      path: formatReviewArtifactIssuePath(['merge', 'validator_requests']),
      reason: 'validator request references unknown merged finding',
    }
  }

  return undefined
}

/** The exact one-to-one join: `dispatch_records` and
 * `parent_run_metadata.selected_dispatches` must agree on every persona's
 * `(dispatch_outcome, selection_surface)`, with no missing, duplicate, or
 * extra entry on either side. Returns the selected-dispatch index by
 * persona, reused by the screen-results join below. */
function checkDispatchRecordsJoin(
  dispatchRecords: FinalizeDispatchRecords,
  selectedDispatches: FinalizeDispatchRecords,
): FinalizeContextCheckResult<ReadonlyMap<string, FinalizeDispatchRecord>> {
  if (dispatchRecords.length !== selectedDispatches.length) {
    return rejectFinalizeContext(
      formatReviewArtifactIssuePath(['dispatch_records']),
      'dispatch record mismatch',
    )
  }

  const selectedByPersona = new Map(
    selectedDispatches.map((dispatch) => [dispatch.persona, dispatch] as const),
  )
  if (selectedByPersona.size !== selectedDispatches.length) {
    return rejectFinalizeContext(
      formatReviewArtifactIssuePath([
        'parent_run_metadata',
        'selected_dispatches',
      ]),
      'dispatch record mismatch',
    )
  }

  const seenPersonas = new Set<string>()
  for (const [index, record] of dispatchRecords.entries()) {
    const selected = selectedByPersona.get(record.persona)
    if (seenPersonas.has(record.persona) || !selected) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath(['dispatch_records', index]),
        'dispatch record mismatch',
      )
    }
    if (
      selectionSurfaceHasDuplicates(record.selection_surface) ||
      selectionSurfaceHasDuplicates(selected.selection_surface)
    ) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath([
          'dispatch_records',
          index,
          'selection_surface',
        ]),
        'duplicate selection surface entry',
      )
    }
    if (!dispatchRecordsEqual(record, selected)) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath(['dispatch_records', index]),
        'dispatch record mismatch',
      )
    }
    seenPersonas.add(record.persona)
  }

  return { ok: true, value: selectedByPersona }
}

/** Dispatch outcomes for which the corresponding helper never ran, so no
 * screen result exists for the persona by definition. */
const SCREEN_RESULT_EXEMPT_DISPATCH_OUTCOMES = new Set<string>([
  'validation_unavailable',
  'never_returned',
])

/** `screen_results` must contain exactly one result per selected persona,
 * none extra -- except a persona whose dispatch outcome exempts it (its
 * helper never ran, so it has no screen result by definition). If a screen
 * result IS present for an exempt persona, it still joins 1:1 and its own
 * `dispatch_outcome` must agree with the dispatch record's. */
function checkScreenResultsJoin(
  screenResults: FinalizeScreenResults,
  dispatchRecords: FinalizeDispatchRecords,
  selectedByPersona: ReadonlyMap<string, FinalizeDispatchRecord>,
): FinalizeContextCheckResult<ReadonlyMap<string, FinalizeScreenResult>> {
  const screenByReviewer = new Map<string, FinalizeScreenResult>()
  for (const [index, result] of screenResults.entries()) {
    if (
      screenByReviewer.has(result.reviewer) ||
      !selectedByPersona.has(result.reviewer)
    ) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath(['screen_results', index, 'reviewer']),
        'unexpected screen result for persona',
      )
    }
    screenByReviewer.set(result.reviewer, result)
  }

  for (const [index, record] of dispatchRecords.entries()) {
    const screenResult = screenByReviewer.get(record.persona)
    if (!screenResult) {
      if (SCREEN_RESULT_EXEMPT_DISPATCH_OUTCOMES.has(record.dispatch_outcome)) {
        continue
      }
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath(['dispatch_records', index, 'persona']),
        'screen result missing for selected persona',
      )
    }
    if (screenResult.result.dispatch_outcome !== record.dispatch_outcome) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath([
          'dispatch_records',
          index,
          'dispatch_outcome',
        ]),
        'screen result outcome does not match dispatch record',
      )
    }
  }

  return { ok: true, value: screenByReviewer }
}

/** Whether one merged finding's carried fields diverge from a fresh
 * `deriveMergedFindingFields` re-derivation over its carried survivors,
 * using the finding's own route and agreement-credit fields as the model
 * decision. Compares file, line, severity, confidence, pre_existing,
 * fingerprint, submitters, agreement credit, and route -- the KTD19
 * verifier's exact field list. */
/** Whether the merged finding's carried `file` disagrees with any
 * contributing survivor's file, compared as repo-relative paths after
 * `normalizeRepoRelativePath`. */
function mergedFindingFileDiverges(
  finding: MergeOutput['merged_findings'][number],
  contributingSurvivors: readonly SurvivingFinding[],
): boolean {
  const normalizedFindingFile = normalizeRepoRelativePath(finding.file)
  return contributingSurvivors.some(
    (survivor) =>
      normalizeRepoRelativePath(survivor.file) !== normalizedFindingFile,
  )
}

/** Whether the merged finding's carried `line` disagrees with every
 * contributing survivor's line -- the finalize-phase counterpart to
 * `validateMergedDecisionConsistency`'s merge-phase rule that the
 * representative line must be one of the group members' real lines. Without
 * this, a tampered `line` can recompute `fingerprint` from itself and pass
 * every other check unwitnessed. */
function mergedFindingLineDiverges(
  finding: MergeOutput['merged_findings'][number],
  contributingSurvivors: readonly SurvivingFinding[],
): boolean {
  return !contributingSurvivors.some(
    (survivor) => survivor.line === finding.line,
  )
}

/** The `eligible_agreement_credit` claim to re-derive against. Only a real
 * merge group (two or more `input_finding_ids`) can legitimately claim
 * agreement credit -- `assembleSingletonFinding` never sets it, by
 * construction. Feeding a single-input finding's own carried
 * `agreement_credit` back in as its claim would let a credit that could
 * never have been legitimately produced roundtrip as self-consistent, so a
 * single-input finding's claim is always re-derived from nothing. */
function eligibleAgreementCreditClaim(
  finding: MergeOutput['merged_findings'][number],
): readonly string[] | undefined {
  return finding.input_finding_ids.length >= 2
    ? finding.agreement_credit
    : undefined
}

/** Whether a merged finding's carried route differs from the route meet
 * over its contributing survivors -- field-by-field, via the shared
 * `routesEqual` helper. Despite the name, this is direction-agnostic: a
 * carried route that *widens* also reports `true` here. Callers that care
 * about direction (a genuine narrowing vs. a widening) must additionally
 * consult `isRouteTransitionAllowed` or a re-derivation, as
 * `mergedFindingDivergesFromDerivation` does. */
function mergedFindingRouteNarrowed(
  finding: MergeOutput['merged_findings'][number],
  meet: PipelineRoute,
): boolean {
  return !routesEqual(
    {
      autofix_class: finding.autofix_class,
      owner: finding.owner,
      requires_verification: finding.requires_verification,
    },
    meet,
  )
}

/** KTD19 verifier: the carried `route_narrowing_reason` and the carried
 * route must agree. A route strictly narrower than the meet over
 * contributing survivors requires a reason (the merge-phase `deriveRoute`
 * rule, now checked against the real carried reason instead of a fabricated
 * one); a route equal to the meet must not carry one -- a reason with no
 * narrowing is a false provenance claim. */
function mergedFindingRouteReasonMismatch(
  finding: MergeOutput['merged_findings'][number],
  meet: PipelineRoute,
): boolean {
  return mergedFindingRouteNarrowed(finding, meet)
    ? finding.route_narrowing_reason === undefined
    : finding.route_narrowing_reason !== undefined
}

interface MergedFindingDivergenceContext {
  readonly finding: MergeOutput['merged_findings'][number]
  readonly resolved: readonly SurvivingFinding[]
  readonly contributing: MergeContributingFindings
  readonly meet: PipelineRoute
  readonly returnedReviewers: readonly string[]
}

function mergedFindingDivergesFromDerivation(
  context: MergedFindingDivergenceContext,
): boolean {
  const { finding, resolved, contributing, meet, returnedReviewers } = context
  const narrowed = mergedFindingRouteNarrowed(finding, meet)

  const derivation = deriveMergedFindingFields({
    contributing,
    decision: {
      line: finding.line,
      eligible_agreement_credit: eligibleAgreementCreditClaim(finding),
      proposed_route: narrowed
        ? {
            autofix_class: finding.autofix_class,
            owner: finding.owner,
            requires_verification: finding.requires_verification,
          }
        : undefined,
      route_narrowing_reason: finding.route_narrowing_reason,
    },
    returned_reviewers: returnedReviewers,
  })

  return (
    mergedFindingFileDiverges(finding, resolved) ||
    mergedFindingLineDiverges(finding, resolved) ||
    !derivation.ok ||
    derivation.value.severity !== finding.severity ||
    derivation.value.confidence !== finding.confidence ||
    derivation.value.pre_existing !== finding.pre_existing ||
    derivation.value.fingerprint !== finding.fingerprint ||
    JSON.stringify(derivation.value.submitters) !==
      JSON.stringify(finding.submitters) ||
    JSON.stringify(derivation.value.agreement_credit) !==
      JSON.stringify(finding.agreement_credit ?? []) ||
    derivation.value.route.autofix_class !== finding.autofix_class ||
    derivation.value.route.owner !== finding.owner ||
    derivation.value.route.requires_verification !==
      finding.requires_verification
  )
}

/** KTD19 verifier: re-runs `deriveMergedFindingFields` over every merged
 * finding's carried survivors and rejects the first one whose carried
 * fields diverge from the fresh derivation. The divergence check runs
 * before the narrowing/reason pairing check: `mergedFindingRouteNarrowed`
 * only means "differs from the meet", not "narrows", so a carried route
 * that *widens* with no reason would otherwise surface the less precise
 * pairing-mismatch diagnostic instead of the more accurate
 * divergence-from-derivation one (divergence re-derives the route and
 * catches a widening attempt directly via `isRouteTransitionAllowed`). */
function checkMergedFindingsMatchDerivation(
  mergedFindings: MergeOutput['merged_findings'],
  contributingByFindingId: ReadonlyMap<string, readonly SurvivingFinding[]>,
  returnedReviewers: readonly string[],
): FinalizeContextRejection | undefined {
  for (const [index, finding] of mergedFindings.entries()) {
    const resolved = contributingByFindingId.get(finding.finding_id) ?? []
    const contributing = toContributingTuple(
      resolved.length >= 2 ? resolved : [...resolved, ...resolved],
    )
    const meet = deriveRouteMeet(contributing)

    if (
      mergedFindingDivergesFromDerivation({
        finding,
        resolved,
        contributing,
        meet,
        returnedReviewers,
      })
    ) {
      return {
        path: formatReviewArtifactIssuePath([
          'merge',
          'merged_findings',
          index,
        ]),
        reason: 'merged finding fields diverge from derivation',
      }
    }

    if (mergedFindingRouteReasonMismatch(finding, meet)) {
      return {
        path: formatReviewArtifactIssuePath([
          'merge',
          'merged_findings',
          index,
          'route_narrowing_reason',
        ]),
        reason: 'merged finding route narrowing reason mismatch',
      }
    }
  }
  return undefined
}

/** Rejects a `prepared.confidence_dispositions` array containing more than
 * one entry for the same input ID. A duplicate silently double-counts in
 * `computeDispositionCounts` and produces two identical ledger rows in
 * `buildAdmittedLedgerRows` -- writing mode currently only catches this
 * late, via `ReviewArtifactSchema`'s generic `input_findings` referential
 * check, and report-only mode does not catch it at all. This check names
 * the real cause in both modes. */
function checkNoDuplicateConfidenceDispositions(
  confidenceDispositions: PrepareOutput['confidence_dispositions'],
): FinalizeContextRejection | undefined {
  const seen = new Set<string>()
  for (const [index, entry] of confidenceDispositions.entries()) {
    if (seen.has(entry.input_id)) {
      return {
        path: formatReviewArtifactIssuePath([
          'prepared',
          'confidence_dispositions',
          index,
          'input_id',
        ]),
        reason: 'duplicate confidence disposition',
      }
    }
    seen.add(entry.input_id)
  }
  return undefined
}

/** Every `prepared.confidence_dispositions` entry must resolve to exactly one
 * screened finding across `screen_results[].result.admitted_findings`,
 * matched by input ID. Screen is the only phase that mints an input ID from
 * a real reviewer payload; a disposition with no matching screened finding
 * (or more than one, which would mean a duplicate mint) names evidence that
 * was never actually screened and must never be admitted to the ledger.
 * Every `prepared.surviving_findings` entry must also resolve to a screened
 * finding by input ID, and carry the same `reviewer`, `confidence`, `file`,
 * `line`, and `severity` as that screened finding -- `prepare` only ever
 * narrows a screened finding down to a survivor, so a survivor whose input
 * ID resolves to no screened finding at all is not narrowed from anything
 * real (a fabricated input ID, never mirrored into `confidence_dispositions`
 * either), and a survivor whose fields disagree with what was screened was
 * laundered after screening. Both would otherwise go undetected: every
 * downstream ownership decision (`deriveSubmitters`,
 * `findUnavailableCitedReviewer`, `buildAdmittedReviewerIndex`,
 * `deriveRiskCoverage`'s cross-persona test) trusts the survivor's carried
 * fields rather than re-resolving them. */
function checkConfidenceDispositionsResolveScreenedFindings(
  prepared: Pick<
    PrepareOutput,
    'confidence_dispositions' | 'surviving_findings'
  >,
  screenResults: FinalizeScreenResults,
): FinalizeContextRejection | undefined {
  const screenedCounts = new Map<string, number>()
  const screenedByInputId = new Map<
    string,
    {
      readonly reviewer: string
      readonly confidence: number
      readonly file: string
      readonly line: number
      readonly severity: SurvivingFinding['severity']
    }
  >()
  for (const result of screenResults) {
    for (const finding of result.result.admitted_findings) {
      screenedCounts.set(
        finding.input_id,
        (screenedCounts.get(finding.input_id) ?? 0) + 1,
      )
      screenedByInputId.set(finding.input_id, {
        reviewer: result.reviewer,
        confidence: finding.confidence,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
      })
    }
  }

  for (const [
    index,
    disposition,
  ] of prepared.confidence_dispositions.entries()) {
    if (screenedCounts.get(disposition.input_id) !== 1) {
      return {
        path: formatReviewArtifactIssuePath([
          'prepared',
          'confidence_dispositions',
          index,
          'input_id',
        ]),
        reason: 'confidence disposition references unscreened finding',
      }
    }
  }

  for (const [index, survivor] of prepared.surviving_findings.entries()) {
    // The confidence-dispositions loop above only rejects an input ID that
    // appears IN `confidence_dispositions` without resolving to exactly one
    // screened finding -- it says nothing about a survivor whose input ID
    // was never mirrored into `confidence_dispositions` at all. That
    // mirroring is a property of an honest producer, not something this
    // function can assume of untrusted carried state, so `screened` must be
    // checked directly here rather than relied on to have resolved already.
    const screened = screenedByInputId.get(survivor.input_id)
    if (screened === undefined) {
      return {
        path: formatReviewArtifactIssuePath([
          'prepared',
          'surviving_findings',
          index,
          'input_id',
        ]),
        reason: 'surviving finding references unscreened input',
      }
    }
    if (
      screened.reviewer !== survivor.reviewer ||
      screened.confidence !== survivor.confidence ||
      normalizeRepoRelativePath(screened.file) !==
        normalizeRepoRelativePath(survivor.file) ||
      screened.line !== survivor.line ||
      screened.severity !== survivor.severity
    ) {
      return {
        path: formatReviewArtifactIssuePath([
          'prepared',
          'surviving_findings',
          index,
        ]),
        reason: 'surviving finding diverges from its screened finding',
      }
    }
  }

  return undefined
}

/** Whether one merged finding cites an input whose reviewer was withheld
 * (`validation_unavailable`). Returns the cited reviewers alongside so the
 * caller can reuse them for the submitters check without re-walking
 * `input_finding_ids`. Resolution to a real survivor is already enforced by
 * `checkSurvivorPartition`, which runs before this check. */
function findUnavailableCitedReviewer(
  finding: MergeOutput['merged_findings'][number],
  findingIndex: number,
  survivingIndex: ReadonlyMap<string, SurvivingFinding>,
  dispatchByPersona: ReadonlyMap<string, FinalizeDispatchRecord>,
): {
  readonly citedReviewers: ReadonlySet<string>
  readonly rejection?: FinalizeContextRejection
} {
  const citedReviewers = new Set<string>()

  for (const [idIndex, inputId] of finding.input_finding_ids.entries()) {
    const survivor = survivingIndex.get(inputId)
    if (!survivor) continue
    citedReviewers.add(survivor.reviewer)

    if (
      dispatchByPersona.get(survivor.reviewer)?.dispatch_outcome ===
      'validation_unavailable'
    ) {
      return {
        citedReviewers,
        rejection: {
          path: formatReviewArtifactIssuePath([
            'merge',
            'merged_findings',
            findingIndex,
            'input_finding_ids',
            idIndex,
          ]),
          reason: 'merged finding cites input from unavailable reviewer',
        },
      }
    }
  }

  return { citedReviewers }
}

/** Whether one merged finding's `submitters` claim a reviewer that never
 * contributed a cited input. */
function findUnsupportedSubmitter(
  finding: MergeOutput['merged_findings'][number],
  findingIndex: number,
  citedReviewers: ReadonlySet<string>,
): FinalizeContextRejection | undefined {
  for (const [submitterIndex, submitter] of finding.submitters.entries()) {
    if (!citedReviewers.has(submitter)) {
      return {
        path: formatReviewArtifactIssuePath([
          'merge',
          'merged_findings',
          findingIndex,
          'submitters',
          submitterIndex,
        ]),
        reason: 'merged finding submitter not a cited reviewer',
      }
    }
  }
  return undefined
}

/** Whether one merged finding's `agreement_credit` (when present) overlaps
 * its own `submitters`. */
function findOverlappingAgreementCredit(
  finding: MergeOutput['merged_findings'][number],
  findingIndex: number,
): FinalizeContextRejection | undefined {
  const submitterSet = new Set(finding.submitters)
  const agreementCredit = finding.agreement_credit ?? []
  for (const [creditIndex, credit] of agreementCredit.entries()) {
    if (submitterSet.has(credit)) {
      return {
        path: formatReviewArtifactIssuePath([
          'merge',
          'merged_findings',
          findingIndex,
          'agreement_credit',
          creditIndex,
        ]),
        reason: 'merged finding agreement credit overlaps submitters',
      }
    }
  }
  return undefined
}

/** Cross-reference checks a writing-mode artifact would otherwise only get
 * from `ReviewArtifactSchema.parse`'s `superRefine`: report-only mode never
 * builds a `ReviewArtifactSchema` value, so it would skip them entirely
 * unless they run here instead, protecting both output kinds identically.
 * Checks, per merged finding: every cited input's reviewer was not withheld
 * (`validation_unavailable`); every `submitters` entry is the reviewer of at
 * least one cited input; and `agreement_credit` (when present) never
 * overlaps `submitters`. */
function checkMergedFindingProvenance(
  mergedFindings: MergeOutput['merged_findings'],
  survivingIndex: ReadonlyMap<string, SurvivingFinding>,
  dispatchByPersona: ReadonlyMap<string, FinalizeDispatchRecord>,
): FinalizeContextRejection | undefined {
  for (const [findingIndex, finding] of mergedFindings.entries()) {
    const unavailable = findUnavailableCitedReviewer(
      finding,
      findingIndex,
      survivingIndex,
      dispatchByPersona,
    )
    if (unavailable.rejection) return unavailable.rejection

    const unsupportedSubmitter = findUnsupportedSubmitter(
      finding,
      findingIndex,
      unavailable.citedReviewers,
    )
    if (unsupportedSubmitter) return unsupportedSubmitter

    const overlappingCredit = findOverlappingAgreementCredit(
      finding,
      findingIndex,
    )
    if (overlappingCredit) return overlappingCredit
  }
  return undefined
}

/** Rejected-payload weights: every screen result carrying a rejected summary
 * contributes its recorded count; a rejection with no summary weighs zero
 * (KTD21), so it contributes nothing rather than a fabricated entry. Sorted
 * by reviewer for deterministic output. */
function deriveRejectedPayloadWeights(
  screenResults: FinalizeScreenResults,
): readonly RejectedPayloadWeight[] {
  const sorted = [...screenResults].sort((a, b) =>
    compareStrings(a.reviewer, b.reviewer),
  )
  const weights: RejectedPayloadWeight[] = []
  for (const result of sorted) {
    const summary = result.result.rejected_summary
    if (summary) {
      weights.push({ rejected_finding_count: summary.rejected_finding_count })
    }
  }
  return weights
}

/** Lost risk-critical personas: a selected risk-critical persona is lost
 * when its dispatch outcome is malformed, never returned, or unavailable,
 * or when its screen result's rejected summary carries a P0, P1, or unknown
 * severity. A P2/P3-only partial rejection is not a loss. Sorted by persona
 * for deterministic output. */
function deriveLostRiskCriticalPersonas(
  dispatchRecords: FinalizeDispatchRecords,
  screenByReviewer: ReadonlyMap<string, FinalizeScreenResult>,
): readonly LostRiskCriticalPersona[] {
  const riskCriticalPersonas = new Set<string>(RISK_CRITICAL_PERSONAS)
  const lostPersonas: LostRiskCriticalPersona[] = []

  for (const record of dispatchRecords) {
    if (!riskCriticalPersonas.has(record.persona)) continue

    const selectionSurface = record.selection_surface ?? []

    if (FINALIZE_CONTEXT_LOSS_DISPATCH_OUTCOMES.has(record.dispatch_outcome)) {
      lostPersonas.push({
        persona: record.persona,
        selection_surface: selectionSurface,
      })
      continue
    }

    const rejectedSeverities =
      screenByReviewer.get(record.persona)?.result.rejected_summary
        ?.rejected_severities ?? []
    if (
      rejectedSeverities.some((severity) =>
        FINALIZE_CONTEXT_LOSS_SEVERITIES.has(severity),
      )
    ) {
      lostPersonas.push({
        persona: record.persona,
        selection_surface: selectionSurface,
      })
    }
  }

  return [...lostPersonas].sort((a, b) => compareStrings(a.persona, b.persona))
}

/**
 * Validates the finalize envelope's cross-phase joins and derives the two
 * inputs only finalize can compute: rejected-payload weights (from screen
 * summaries) and lost risk-critical personas (from the loss rules in
 * `synthesis-artifact-contract.md`). Rejection is whole-envelope only, with
 * a fixed reason and a safe JSON path, never payload content -- and always
 * happens before any derivation runs.
 */
export function deriveFinalizeContext(
  input: DeriveFinalizeContextInput,
): DeriveFinalizeContextResult {
  // The persisted artifact is built before the artifact self-validation step
  // can run, so `not_attempted` is the only truthful value finalize can carry
  // through. Checked before any other branch so report-only and writing
  // agree; the parent's post-write artifact-validation step is the only
  // writer of the final status, reported in the rendered Coverage section
  // rather than rewritten into the artifact.
  if (input.parent_run_metadata.validation.status !== 'not_attempted') {
    return rejectFinalizeContext(
      formatReviewArtifactIssuePath([
        'parent_run_metadata',
        'validation',
        'status',
      ]),
      'validation must be not_attempted at finalize',
    )
  }

  const findingIds = checkNoDuplicateMergedFindingIds(
    input.merge.merged_findings,
  )
  if (!findingIds.ok) return findingIds

  const survivingIndex = buildSurvivingFindingIndex(input.prepared)
  const partition = checkSurvivorPartition(
    input.merge.merged_findings,
    input.prepared.surviving_findings,
    survivingIndex,
  )
  if (!partition.ok) return partition

  const requestViolation = checkValidatorRequestsResolve(
    input.merge.validator_requests,
    input.merge.merged_findings,
  )
  if (requestViolation) return { ok: false, rejection: requestViolation }

  const dispatchJoin = checkDispatchRecordsJoin(
    input.dispatch_records,
    input.parent_run_metadata.selected_dispatches,
  )
  if (!dispatchJoin.ok) return dispatchJoin

  const screenJoin = checkScreenResultsJoin(
    input.screen_results,
    input.dispatch_records,
    dispatchJoin.value,
  )
  if (!screenJoin.ok) return screenJoin

  const returnedReviewers = deriveReturnedReviewers(input.prepared)
  const derivationViolation = checkMergedFindingsMatchDerivation(
    input.merge.merged_findings,
    partition.value,
    returnedReviewers,
  )
  if (derivationViolation) return { ok: false, rejection: derivationViolation }

  const duplicateDispositionViolation = checkNoDuplicateConfidenceDispositions(
    input.prepared.confidence_dispositions,
  )
  if (duplicateDispositionViolation) {
    return { ok: false, rejection: duplicateDispositionViolation }
  }

  const dispositionJoinViolation =
    checkConfidenceDispositionsResolveScreenedFindings(
      input.prepared,
      input.screen_results,
    )
  if (dispositionJoinViolation) {
    return { ok: false, rejection: dispositionJoinViolation }
  }

  const provenanceViolation = checkMergedFindingProvenance(
    input.merge.merged_findings,
    survivingIndex,
    dispatchJoin.value,
  )
  if (provenanceViolation) return { ok: false, rejection: provenanceViolation }

  return {
    ok: true,
    value: {
      rejected_payloads: deriveRejectedPayloadWeights(input.screen_results),
      lost_risk_critical_personas: deriveLostRiskCriticalPersonas(
        input.dispatch_records,
        screenJoin.value,
      ),
    },
  }
}

// --- finalize phase: dispositions, counts, and action queues ----------------
//
// Pure, side-effect-free derivation of every admitted input's final
// disposition, the weighted disposition counts, and the action queues that
// partition surviving actionable findings by owner. Consumes only
// `reconcileValidatorResults`'s output, the `prepare`-phase ledger, and the
// rejected-payload weights the screen phase already recorded -- every
// disposition, count, and queue placement is derived from that admitted
// state, never from anything a model supplied. This is dispositions, counts,
// and queues only: risk coverage, plan-assessment routing, and final
// artifact assembly are separate slices. Never reads `process.env`, the
// filesystem, or the clock.

/** The final disposition of one admitted raw input: suppressed by the
 * confidence gate, filtered by a disproven validation, folded into a
 * synthesized (multi-input) finding, or surviving as its own finding.
 * Mutually exclusive and exhaustive over every entry in
 * `PrepareOutput['confidence_dispositions']` -- a rejected input never
 * reaches this vocabulary at all, since whole-payload rejection happens
 * before the `prepare` phase and is counted separately (see
 * `FinalDispositionCounts.rejected`). */
export type FinalInputDisposition =
  | 'suppressed'
  | 'filtered'
  | 'merged'
  | 'surviving'

/** One admitted raw input's final disposition. `reason` carries the
 * confidence-gate suppression reason when present; every other disposition
 * has no reason of its own to report here. */
export interface FinalizedInputDisposition {
  readonly input_id: string
  readonly disposition: FinalInputDisposition
  readonly reason?: string
}

/** One rejected reviewer payload's weight for the disposition-count total:
 * the number of findings a whole-payload rejection discarded, exactly as
 * `screenReviewReturn` recorded it in `ScreenRejectedSummarySchema`. A
 * rejected payload contributes one weighted entry here, never one row per
 * discarded finding -- so the disposition-count total stays anchored to
 * findings actually observed rather than to ledger row count. */
export interface RejectedPayloadWeight {
  readonly rejected_finding_count: number
}

/** Every admitted-plus-rejected disposition count, weighted by findings
 * observed rather than by ledger rows. `rejected` sums every
 * `RejectedPayloadWeight.rejected_finding_count`; the other four fields each
 * count one `FinalizedInputDisposition` entry, excluding any entry owned by
 * a `validation_unavailable` persona -- the same exclusion
 * `buildAdmittedLedgerRows` applies to the ledger, so the four admitted-
 * weight fields always sum to the admitted row count in the ledger
 * `finalizeReview` builds alongside it. That invariant is asserted by
 * `checkDispositionCountsReconcileLedger` in `finalizeReview`, not left
 * aspirational. */
export interface FinalDispositionCounts {
  readonly surviving: number
  readonly merged: number
  readonly suppressed: number
  readonly filtered: number
  readonly rejected: number
}

/** Where one actionable, surviving finding routes to: a fixer can take it
 * directly (`owner: 'review-fixer'`), it needs a human or a downstream
 * resolver (`owner: 'downstream-resolver' | 'human'`), or it is terminal and
 * report-only (`owner: 'release'`). Derived solely from the finding's own
 * mechanically-computed `owner` field -- never from anything a model
 * proposed beyond the narrowing `deriveMergedFindingFields` already
 * validated. */
export type FindingActionRoute = 'fixer' | 'residual' | 'report_only'

/** One finding placed in an action queue, or reported via `new_findings` /
 * `pre_existing_findings` outside any queue. A finding whose validator run
 * failed or was unavailable (present in `reconciled.lifecycle_failures`) is
 * excluded from every action queue entirely -- nobody disproved it, but
 * nobody confirmed it either, so `partitionFindings` will not auto-action
 * it. It still surfaces through `new_findings` (or `pre_existing_findings`)
 * with `unconfirmed: true`, and `reconcileValidatorResults`'s degraded
 * validator lifecycle keeps the run from reaching a clean verdict
 * (`deriveVerdict`'s `validator lifecycle degraded` blocking reason). As a
 * consequence, `unconfirmed` is always `false` on every entry actually
 * placed in `queues.fixer` / `queues.residual` / `queues.report_only` --
 * see `partitionFindings`'s `an unconfirmed finding never enters an action
 * queue` test. */
export interface QueuedFinding {
  readonly finding_id: string
  readonly unconfirmed: boolean
}

/** One reported finding that is not in any action queue because it predates
 * the current change: every one of its contributing raw inputs was already
 * `pre_existing`. Still reported, but not the same actionable class as a
 * newly introduced finding. */
export interface PreExistingFinding {
  readonly finding_id: string
  readonly unconfirmed: boolean
}

export interface FinalizeReviewDispositionsInput {
  readonly prepared: PrepareOutput
  readonly reconciled: ReconcileValidatorResultsOutput
  readonly rejected_payloads: readonly RejectedPayloadWeight[]
  readonly screen_results: FinalizeScreenResults
  readonly dispatch_records: FinalizeDispatchRecords
}

export interface FinalizeReviewDispositionsOutput {
  readonly input_dispositions: readonly FinalizedInputDisposition[]
  readonly disposition_counts: FinalDispositionCounts
  readonly pre_existing_findings: readonly PreExistingFinding[]
  readonly new_findings: readonly QueuedFinding[]
  readonly queues: {
    readonly fixer: readonly QueuedFinding[]
    readonly residual: readonly QueuedFinding[]
    readonly report_only: readonly QueuedFinding[]
  }
}

type FinalizeReviewDispositionsRejectReason =
  'survivor missing from merged findings'

export interface FinalizeReviewDispositionsRejection {
  readonly path: string
  readonly reason: FinalizeReviewDispositionsRejectReason
}

export type FinalizeReviewDispositionsResult =
  | { readonly ok: true; readonly value: FinalizeReviewDispositionsOutput }
  | {
      readonly ok: false
      readonly rejection: FinalizeReviewDispositionsRejection
    }

type DeriveInputDispositionsResult =
  | { readonly ok: true; readonly value: readonly FinalizedInputDisposition[] }
  | {
      readonly ok: false
      readonly rejection: FinalizeReviewDispositionsRejection
    }

/**
 * Derives every admitted raw input's final disposition from the state the
 * earlier phases already established: `prepared.confidence_dispositions`
 * for suppression, `reconciled.filtered_input_ids` for a disproven
 * validation, and, for everything else, whether the input's synthesized
 * finding (looked up via its `input_finding_ids`) carries more than one
 * contributing input (`merged`) or exactly one (`surviving`). Every input
 * finds its finding by construction: `applyReviewAdjudication` places every
 * confidence-gate survivor into exactly one merge group or singleton -- a
 * surviving disposition whose finding cannot be found is a data-integrity
 * violation between the carried `prepared` and `reconciled` state, and
 * rejects rather than silently defaulting to `surviving`. An entry whose
 * owning reviewer (resolved via `reviewerIndex`) belongs to
 * `unavailablePersonas` is skipped entirely -- withheld evidence is neither
 * admitted nor rejected (KTD21), the same exclusion `buildAdmittedLedgerRows`
 * applies to the ledger, so this list and the ledger always describe the
 * same row set.
 */
function deriveInputDispositions(
  prepared: PrepareOutput,
  reconciled: ReconcileValidatorResultsOutput,
  reviewerIndex: ReadonlyMap<string, string>,
  unavailablePersonas: ReadonlySet<string>,
): DeriveInputDispositionsResult {
  const filteredInputIds = new Set(reconciled.filtered_input_ids)
  const findingByInputId = new Map<string, ReconciledFinding>()
  for (const finding of reconciled.findings) {
    for (const inputId of finding.input_finding_ids) {
      findingByInputId.set(inputId, finding)
    }
  }

  const dispositions: FinalizedInputDisposition[] = []
  for (const [index, entry] of prepared.confidence_dispositions.entries()) {
    const reviewer = reviewerIndex.get(entry.input_id)
    if (reviewer !== undefined && unavailablePersonas.has(reviewer)) continue
    if (entry.disposition === 'suppressed') {
      dispositions.push({
        input_id: entry.input_id,
        disposition: 'suppressed',
        reason: entry.reason,
      })
      continue
    }
    if (filteredInputIds.has(entry.input_id)) {
      dispositions.push({ input_id: entry.input_id, disposition: 'filtered' })
      continue
    }
    const finding = findingByInputId.get(entry.input_id)
    if (finding === undefined) {
      return {
        ok: false,
        rejection: {
          path: formatReviewArtifactIssuePath([
            'prepared',
            'confidence_dispositions',
            index,
            'input_id',
          ]),
          reason: 'survivor missing from merged findings',
        },
      }
    }
    const isMerged = finding.input_finding_ids.length > 1
    dispositions.push({
      input_id: entry.input_id,
      disposition: isMerged ? 'merged' : 'surviving',
    })
  }

  return {
    ok: true,
    value: [...dispositions].sort((a, b) =>
      compareStrings(a.input_id, b.input_id),
    ),
  }
}

/**
 * Sums each disposition's weight: one per admitted input for the first four
 * fields, and the rejected-payload weights (never one per discarded
 * finding) for `rejected`.
 */
function computeDispositionCounts(
  inputDispositions: readonly FinalizedInputDisposition[],
  rejectedPayloads: readonly RejectedPayloadWeight[],
): FinalDispositionCounts {
  let surviving = 0
  let merged = 0
  let suppressed = 0
  let filtered = 0

  for (const entry of inputDispositions) {
    if (entry.disposition === 'surviving') surviving += 1
    else if (entry.disposition === 'merged') merged += 1
    else if (entry.disposition === 'suppressed') suppressed += 1
    else filtered += 1
  }

  const rejected = rejectedPayloads.reduce(
    (total, payload) => total + payload.rejected_finding_count,
    0,
  )

  return { surviving, merged, suppressed, filtered, rejected }
}

/** The action queue one finding's mechanically-derived `owner` routes to. */
function routeForOwner(
  owner: MergeOutput['merged_findings'][number]['owner'],
): FindingActionRoute {
  if (owner === 'review-fixer') return 'fixer'
  if (owner === 'release') return 'report_only'
  return 'residual'
}

interface PartitionedFindings {
  readonly preExistingFindings: readonly PreExistingFinding[]
  readonly newFindings: readonly QueuedFinding[]
  readonly queues: FinalizeReviewDispositionsOutput['queues']
}

/**
 * Partitions every non-filtered reconciled finding into the pre-existing
 * report list or exactly one action queue. A finding filtered by a `false`
 * validation is excluded entirely -- it enters no queue and is not reported
 * here. Pre-existing status reads the finding's own carried `pre_existing`
 * field (KTD19-verified upstream) rather than recomputing it from
 * `prepared.surviving_findings`. `unconfirmed` marks a finding whose
 * validator run failed or was unavailable (present in
 * `reconciled.lifecycle_failures`); such a finding is still reported --
 * pre-existing or new -- but excluded from every action queue, since
 * nobody confirmed it actionable either way.
 */
function partitionFindings(
  reconciled: ReconcileValidatorResultsOutput,
): PartitionedFindings {
  const filteredFindingIds = new Set(reconciled.filtered_finding_ids)
  const unconfirmedFindingIds = new Set(
    reconciled.lifecycle_failures.map((failure) => failure.finding_id),
  )

  const preExistingFindings: PreExistingFinding[] = []
  const newFindings: QueuedFinding[] = []
  const fixer: QueuedFinding[] = []
  const residual: QueuedFinding[] = []
  const reportOnly: QueuedFinding[] = []

  for (const finding of reconciled.findings) {
    if (filteredFindingIds.has(finding.finding_id)) continue

    const unconfirmed = unconfirmedFindingIds.has(finding.finding_id)
    const entry: QueuedFinding = { finding_id: finding.finding_id, unconfirmed }

    if (finding.pre_existing) {
      preExistingFindings.push(entry)
      continue
    }

    newFindings.push(entry)
    if (unconfirmed) continue

    const route = routeForOwner(finding.owner)
    if (route === 'fixer') fixer.push(entry)
    else if (route === 'residual') residual.push(entry)
    else reportOnly.push(entry)
  }

  const byFindingId = (a: QueuedFinding, b: QueuedFinding) =>
    compareStrings(a.finding_id, b.finding_id)

  return {
    preExistingFindings: [...preExistingFindings].sort(byFindingId),
    newFindings: [...newFindings].sort(byFindingId),
    queues: {
      fixer: [...fixer].sort(byFindingId),
      residual: [...residual].sort(byFindingId),
      report_only: [...reportOnly].sort(byFindingId),
    },
  }
}

/**
 * The finalize-phase dispositions, counts, and action-queue step: derives
 * every admitted input's final disposition, the weighted disposition
 * counts (including the rejected-payload weight), the pre-existing/new
 * finding split, and the three mutually exclusive, collectively exhaustive
 * action queues (`fixer`, `residual`, `report_only`) that partition every
 * surviving actionable finding by its mechanically-derived `owner`.
 *
 * Every list is sorted by a stable key (`input_id` or `finding_id`), so
 * identical input in a different order always produces byte-identical
 * output. This step never builds risk coverage, plan-assessment routing, or
 * the final artifact -- those are separate slices. Never reads
 * `process.env`, the filesystem, or the clock.
 */
export function finalizeReviewDispositions(
  input: FinalizeReviewDispositionsInput,
): FinalizeReviewDispositionsResult {
  const reviewerIndex = buildAdmittedReviewerIndex(
    input.prepared,
    input.screen_results,
  )
  const unavailablePersonas = buildValidationUnavailablePersonas(
    input.dispatch_records,
  )
  const inputDispositionsResult = deriveInputDispositions(
    input.prepared,
    input.reconciled,
    reviewerIndex,
    unavailablePersonas,
  )
  if (!inputDispositionsResult.ok) return inputDispositionsResult

  const dispositionCounts = computeDispositionCounts(
    inputDispositionsResult.value,
    input.rejected_payloads,
  )
  const { preExistingFindings, newFindings, queues } = partitionFindings(
    input.reconciled,
  )

  return {
    ok: true,
    value: {
      input_dispositions: inputDispositionsResult.value,
      disposition_counts: dispositionCounts,
      pre_existing_findings: preExistingFindings,
      new_findings: newFindings,
      queues,
    },
  }
}

// --- risk coverage phase: replacement evidence for a lost persona -----------
//
// A review selects certain risk-critical personas because they cover
// risk-critical surfaces. When one of those personas is lost -- its return
// was malformed, it never returned, or its validator was unavailable -- the
// surface it was selected for went unreviewed unless a *different* persona
// independently produced eligible evidence on that same surface. Identifying
// which personas are risk-critical and lost is a routing concern owned by a
// separate slice; this phase is already handed exactly that set.

/** One risk-critical persona whose dispatch was lost, paired with the
 * selection surface it was recorded as covering. */
export interface LostRiskCriticalPersona {
  readonly persona: string
  readonly selection_surface: readonly string[]
}

export interface DeriveRiskCoverageInput {
  readonly lost_risk_critical_personas: readonly LostRiskCriticalPersona[]
  readonly prepared: PrepareOutput
  readonly reconciled: ReconcileValidatorResultsOutput
}

/** One lost persona's coverage verdict. `finding_id` and `input_finding_id`
 * are present only when `satisfied` is `true`: `finding_id` names the
 * reconciled finding whose evidence covers the lost surface, and
 * `input_finding_id` names the specific admitted input row -- owned by a
 * different persona than the lost one -- that finding cites as its cross-
 * persona evidence. */
export interface RiskCoverageDerivation {
  readonly persona: string
  readonly satisfied: boolean
  readonly finding_id?: string
  readonly input_finding_id?: string
}

/** Maps every surviving input's stable ID to the reviewer that submitted it,
 * so a reconciled finding's contributing personas can be recovered from its
 * `input_finding_ids`. */
function buildSurvivingReviewerIndex(
  prepared: PrepareOutput,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const finding of prepared.surviving_findings) {
    index.set(finding.input_id, finding.reviewer)
  }
  return index
}

/** Finding IDs that were requested for validation and left uncertain by a
 * `failed` or `unavailable` outcome -- present in `lifecycle_failures`. A
 * finding absent from this set and carrying no `validated` field was never
 * requested at all. */
function buildRequestedUncertainFindingIds(
  reconciled: ReconcileValidatorResultsOutput,
): ReadonlySet<string> {
  return new Set(
    reconciled.lifecycle_failures.map((failure) => failure.finding_id),
  )
}

/** The distinct reviewers whose surviving input findings contributed to this
 * reconciled finding. */
function findingOwners(
  finding: ReconciledFinding,
  survivingReviewerIndex: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const owners = new Set<string>()
  for (const inputId of finding.input_finding_ids) {
    const reviewer = survivingReviewerIndex.get(inputId)
    if (reviewer !== undefined) owners.add(reviewer)
  }
  return owners
}

/** A finding inside the validation band (requested for validation) is
 * eligible only after an explicit `true` result; a `failed`/`unavailable`
 * validator leaves it uncertain, never eligible. A finding outside the band
 * (never requested) is eligible without one. */
function isValidationBandEligible(
  finding: ReconciledFinding,
  requestedUncertainFindingIds: ReadonlySet<string>,
): boolean {
  if (finding.validated === true) return true
  if (finding.validated === false) return false
  return !requestedUncertainFindingIds.has(finding.finding_id)
}

/** Whether one reconciled finding can stand in for a lost risk-critical
 * persona's coverage: cross-persona, on the lost persona's recorded
 * surface, not filtered by a disproving validation, and validation-band
 * eligible. */
function isEligibleRiskCoverageCandidate(
  finding: ReconciledFinding,
  lostPersona: string,
  normalizedSurface: ReadonlySet<string>,
  survivingReviewerIndex: ReadonlyMap<string, string>,
  requestedUncertainFindingIds: ReadonlySet<string>,
): boolean {
  // Not filtered: a finding disproven by a `false` validation covers nothing.
  if (finding.validated === false) return false

  // On-surface: compare through the same normalization surfaces were grouped
  // under, so this can never disagree with candidate grouping.
  if (!normalizedSurface.has(normalizeRepoRelativePath(finding.file))) {
    return false
  }

  // Cross-persona: the lost persona cannot cover its own surface with its
  // own surviving evidence.
  const owners = findingOwners(finding, survivingReviewerIndex)
  const hasCrossPersonaOwner = [...owners].some(
    (owner) => owner !== lostPersona,
  )
  if (!hasCrossPersonaOwner) return false

  return isValidationBandEligible(finding, requestedUncertainFindingIds)
}

/** The lowest (lexicographically) admitted input ID among `finding`'s
 * `input_finding_ids` whose reviewer -- resolved via `survivingReviewerIndex`
 * ledger evidence, never by parsing the ID -- differs from `lostPersona`.
 * `undefined` when no contributing input has cross-persona ownership: the
 * finding is not a valid citation for this persona, regardless of what
 * `isEligibleRiskCoverageCandidate` already concluded from its aggregate
 * owner set. */
function citedInputIdForLostPersona(
  finding: ReconciledFinding,
  lostPersona: string,
  survivingReviewerIndex: ReadonlyMap<string, string>,
): string | undefined {
  const crossPersonaInputIds = finding.input_finding_ids.filter((inputId) => {
    const reviewer = survivingReviewerIndex.get(inputId)
    return reviewer !== undefined && reviewer !== lostPersona
  })
  if (crossPersonaInputIds.length === 0) return undefined
  return [...crossPersonaInputIds].sort(compareStrings)[0]
}

/** Derives one lost risk-critical persona's coverage verdict. Eligible
 * candidates are ordered by the canonical merged-finding order (severity,
 * confidence, normalized path, line, fingerprint, then finding ID) -- the
 * same total order the merge phase already established via
 * `compareMergedFindingAssembly` -- so the citation is deterministic,
 * unaffected by input permutation, and never keyed on the model-owned
 * `finding_id` alone. A candidate that cannot resolve a cross-persona
 * admitted input ID from ledger evidence is skipped rather than cited:
 * missing ownership never yields a satisfied citation. */
function deriveCoverageForLostPersona(
  lostPersona: LostRiskCriticalPersona,
  reconciled: ReconcileValidatorResultsOutput,
  survivingReviewerIndex: ReadonlyMap<string, string>,
  requestedUncertainFindingIds: ReadonlySet<string>,
): RiskCoverageDerivation {
  const normalizedSurface = new Set(
    lostPersona.selection_surface.map(normalizeRepoRelativePath),
  )

  const eligible = reconciled.findings
    .filter((finding) =>
      isEligibleRiskCoverageCandidate(
        finding,
        lostPersona.persona,
        normalizedSurface,
        survivingReviewerIndex,
        requestedUncertainFindingIds,
      ),
    )
    .sort(compareMergedFindingAssembly)

  for (const candidate of eligible) {
    const citedInputId = citedInputIdForLostPersona(
      candidate,
      lostPersona.persona,
      survivingReviewerIndex,
    )
    if (citedInputId !== undefined) {
      return {
        persona: lostPersona.persona,
        satisfied: true,
        finding_id: candidate.finding_id,
        input_finding_id: citedInputId,
      }
    }
  }

  return { persona: lostPersona.persona, satisfied: false }
}

/**
 * Derives risk-critical replacement coverage for every lost risk-critical
 * persona: whether a *different* persona's validated, on-surface evidence
 * independently covers the surface the lost persona was selected for. This
 * step never identifies which personas are risk-critical or lost, never
 * builds plan-assessment routing, and never assembles the final artifact --
 * those are separate slices. Never reads `process.env`, the filesystem, or
 * the clock.
 */
export function deriveRiskCoverage(
  input: DeriveRiskCoverageInput,
): readonly RiskCoverageDerivation[] {
  const survivingReviewerIndex = buildSurvivingReviewerIndex(input.prepared)
  const requestedUncertainFindingIds = buildRequestedUncertainFindingIds(
    input.reconciled,
  )

  return input.lost_risk_critical_personas
    .map((lostPersona) =>
      deriveCoverageForLostPersona(
        lostPersona,
        input.reconciled,
        survivingReviewerIndex,
        requestedUncertainFindingIds,
      ),
    )
    .sort((a, b) => compareStrings(a.persona, b.persona))
}

// --- plan-assessment routing phase -------------------------------------------
//
// Routes the model's plan-assessment results -- its judgment on whether a
// plan's stated requirements were actually met by the work -- into the
// correct output channels. Nobody reviewed a line of code to produce these
// results: they carry no persona, no evidence, and no input ledger row, so
// they are a deliberately distinct shape from a reviewer's admitted finding
// and this phase never writes one into that collection. Identifying lost
// personas, risk coverage, and the final artifact assembly are separate
// slices; this phase only routes. Never reads `process.env`, the
// filesystem, or the clock.

/** One plan-assessment result the model produced while checking the plan's
 * stated requirements against the work. `explicit_unmet_requirement` is a
 * requirement the plan stated outright and the work demonstrably did not
 * meet -- residual actionable work that gates the verdict.
 * `inferred_gap` is something the model suspects is missing but the plan
 * never stated outright -- advisory output only, and never gates the
 * verdict by itself. Deliberately carries no persona, no evidence, and no
 * input ID: unlike a reviewer's finding, nobody reviewed a line of code to
 * produce it, so it must never be mistaken for one. */
export type PlanAssessmentResult = z.infer<
  typeof PlanAssessmentEnvelopeSchema
>['results'][number]

export interface RoutePlanAssessmentInput {
  /** Every plan-assessment result the model returned. Empty when the run
   * had no plan to assess against -- never fabricated, and never a reason
   * to silently relax the verdict gate. */
  readonly results: readonly PlanAssessmentResult[]
}

export interface RoutedPlanAssessment {
  readonly residual_actionable_work: readonly string[]
  readonly advisory_outputs: readonly string[]
  readonly gated_by_explicit_unmet_requirement: boolean
}

/**
 * Routes plan-assessment results into their two output channels: explicit
 * unmet requirements become residual actionable work and gate the verdict;
 * inferred gaps become advisory-only output and never gate the verdict on
 * their own. A run with no plan assessment (`results` empty) produces empty
 * output on both channels and an ungated verdict -- never fabricated
 * entries, never a silently relaxed gate. `PlanAssessmentResult` has no
 * persona or input-ID field to carry, so a plan-assessment result can never
 * be attributed to a reviewer or cross-referenced against the input ledger
 * by construction, and this function never touches a findings collection.
 * Output is sorted for determinism, so identical input in a different order
 * always produces byte-identical output.
 */
export function routePlanAssessment(
  input: RoutePlanAssessmentInput,
): RoutedPlanAssessment {
  const residualActionableWork: string[] = []
  const advisoryOutputs: string[] = []

  for (const result of input.results) {
    if (result.kind === 'explicit_unmet_requirement') {
      residualActionableWork.push(result.description)
    } else {
      advisoryOutputs.push(result.description)
    }
  }

  residualActionableWork.sort(compareStrings)
  advisoryOutputs.sort(compareStrings)

  return {
    residual_actionable_work: residualActionableWork,
    advisory_outputs: advisoryOutputs,
    gated_by_explicit_unmet_requirement: residualActionableWork.length > 0,
  }
}

// --- verdict composition phase -----------------------------------------------
//
// Composes the four phase steps above in order and derives the run's
// verdict. Never re-derives anything a phase step already computed -- this
// is pure composition plus a verdict rollup over state each step already
// produced. Never reads `process.env`, the filesystem, or the clock.

export interface RunReviewPipelineInput {
  readonly merge: MergeOutput
  readonly validator_lifecycle_results: ValidatorLifecycleResults
  readonly prepared: PrepareOutput
  readonly rejected_payloads: readonly RejectedPayloadWeight[]
  readonly lost_risk_critical_personas: readonly LostRiskCriticalPersona[]
  readonly plan_assessment: RoutePlanAssessmentInput
  readonly screen_results: FinalizeScreenResults
  readonly dispatch_records: FinalizeDispatchRecords
}

/** One fact that withheld a clean verdict. Each `kind` is a distinct,
 * independently-triggered block -- never collapsed into a shared shape --
 * so a reader can always tell which of the three gating conditions fired
 * and, within `explicit_unmet_plan_requirement` and
 * `unsatisfied_risk_coverage`, which specific requirement or persona is
 * responsible. */
export type VerdictBlockingReason =
  | {
      readonly kind: 'explicit_unmet_plan_requirement'
      readonly description: string
    }
  | {
      readonly kind: 'unsatisfied_risk_coverage'
      readonly persona: string
    }
  | {
      readonly kind: 'degraded_validator_lifecycle'
      readonly finding_id: string
      readonly outcome: 'failed' | 'unavailable'
    }

export interface ReviewRunVerdict {
  readonly clean: boolean
  readonly blocking_reasons: readonly VerdictBlockingReason[]
}

export interface RunReviewPipelineOutput {
  readonly reconciled: ReconcileValidatorResultsOutput
  readonly finalized: FinalizeReviewDispositionsOutput
  readonly risk_coverage: readonly RiskCoverageDerivation[]
  readonly plan_assessment: RoutedPlanAssessment
  readonly verdict: ReviewRunVerdict
}

export type RunReviewPipelineResult =
  | { readonly ok: true; readonly value: RunReviewPipelineOutput }
  | {
      readonly ok: false
      readonly rejection:
        | ReconcileValidatorResultsRejection
        | FinalizeReviewDispositionsRejection
    }

/**
 * Derives the run's verdict from state the phase steps already computed.
 * Three conditions block a clean verdict, each independently and each
 * surfaced as its own `VerdictBlockingReason` entry rather than collapsed
 * into a single boolean or string: an explicit unmet plan requirement (one
 * entry per `routePlanAssessment`'s `residual_actionable_work` item), an
 * unsatisfied risk-critical coverage for a lost persona (one entry per
 * unsatisfied `deriveRiskCoverage` result), and a degraded validator
 * lifecycle -- a validator that never answered (one entry per
 * `reconcileValidatorResults`'s `lifecycle_failures` item). Every source
 * list is already stably sorted by its producing step, so concatenating
 * them in this fixed order keeps `blocking_reasons` byte-identical under
 * permuted input.
 */
function deriveVerdict(
  planAssessment: RoutedPlanAssessment,
  riskCoverage: readonly RiskCoverageDerivation[],
  reconciled: ReconcileValidatorResultsOutput,
): ReviewRunVerdict {
  const blockingReasons: VerdictBlockingReason[] = []

  for (const description of planAssessment.residual_actionable_work) {
    blockingReasons.push({
      kind: 'explicit_unmet_plan_requirement',
      description,
    })
  }

  for (const coverage of riskCoverage) {
    if (!coverage.satisfied) {
      blockingReasons.push({
        kind: 'unsatisfied_risk_coverage',
        persona: coverage.persona,
      })
    }
  }

  for (const failure of reconciled.lifecycle_failures) {
    blockingReasons.push({
      kind: 'degraded_validator_lifecycle',
      finding_id: failure.finding_id,
      outcome: failure.outcome,
    })
  }

  return {
    clean: blockingReasons.length === 0,
    blocking_reasons: blockingReasons,
  }
}

/**
 * Runs the full synthesis pipeline's finalize-and-verdict slice: calls
 * `reconcileValidatorResults`, `finalizeReviewDispositions`,
 * `deriveRiskCoverage`, and `routePlanAssessment` in order, then derives the
 * run's verdict from their already-computed output. Never re-derives
 * anything those four steps compute -- this is composition, not a fifth
 * derivation. A rejection from `reconcileValidatorResults` aborts the whole
 * run and is returned unchanged, with no partial output from the later
 * steps. This step never builds the final artifact or the
 * writing/report-only discriminated output -- that is a separate slice.
 * Never reads `process.env`, the filesystem, or the clock.
 */
export function runReviewPipeline(
  input: RunReviewPipelineInput,
): RunReviewPipelineResult {
  const reconciled = reconcileValidatorResults({
    merge: input.merge,
    validator_lifecycle_results: input.validator_lifecycle_results,
  })
  if (!reconciled.ok) return reconciled

  const finalized = finalizeReviewDispositions({
    prepared: input.prepared,
    reconciled: reconciled.value,
    rejected_payloads: input.rejected_payloads,
    screen_results: input.screen_results,
    dispatch_records: input.dispatch_records,
  })
  if (!finalized.ok) return finalized

  const riskCoverage = deriveRiskCoverage({
    lost_risk_critical_personas: input.lost_risk_critical_personas,
    prepared: input.prepared,
    reconciled: reconciled.value,
  })

  const planAssessment = routePlanAssessment(input.plan_assessment)

  const verdict = deriveVerdict(planAssessment, riskCoverage, reconciled.value)

  return {
    ok: true,
    value: {
      reconciled: reconciled.value,
      finalized: finalized.value,
      risk_coverage: riskCoverage,
      plan_assessment: planAssessment,
      verdict,
    },
  }
}

// --- input ledger phase: artifact ledger rows for every input finding -------
//
// Projects the run's admitted and rejected input findings into the artifact's
// ledger shape: one admitted row per `prepared.confidence_dispositions` entry
// (its final disposition and a required reason), plus one rejected-summary
// row per screen result that actually carries a rejected summary. Per KTD21
// an unknowable rejected count produces no row at all, and a persona whose
// dispatch outcome is `validation_unavailable` contributes no row of either
// kind -- unavailable evidence is neither admitted nor rejected. Never reads
// `process.env`, the filesystem, or the clock.

type BuildInputLedgerScreenResult = FinalizeScreenResults[number]
type BuildInputLedgerRejectedSummary = NonNullable<
  BuildInputLedgerScreenResult['result']['rejected_summary']
>

/** One admitted raw input's ledger row: its owning reviewer, the confidence
 * the reviewer reported, its final disposition, and a required reason --
 * the confidence-gate reason for `suppressed`, the disproving validator's
 * reason for `filtered`, and a fixed phrase for `surviving`/`merged`. */
export interface AdmittedInputLedgerRow {
  readonly record_type: 'admitted'
  readonly input_id: string
  readonly reviewer: string
  readonly confidence: number
  readonly disposition: FinalInputDisposition
  readonly reason: string
}

/** One whole-payload rejection's ledger row. Only emitted when the screen
 * result actually carried a `rejected_summary` -- an unknowable rejected
 * count (KTD21) produces no row at all. */
export interface RejectedInputLedgerRow {
  readonly record_type: 'rejected_summary'
  readonly reviewer: string
  readonly dispatch_outcome: BuildInputLedgerRejectedSummary['dispatch_outcome']
  readonly rejected_finding_count: number
  readonly rejected_severities: BuildInputLedgerRejectedSummary['rejected_severities']
  readonly disposition: 'rejected'
  readonly reason: string
}

export type InputLedgerRow = AdmittedInputLedgerRow | RejectedInputLedgerRow

export interface BuildInputLedgerInput {
  readonly prepared: PrepareOutput
  readonly screen_results: FinalizeScreenResults
  readonly dispatch_records: FinalizeDispatchRecords
  readonly finalized: FinalizeReviewDispositionsOutput
  readonly reconciled: ReconcileValidatorResultsOutput
}

const LEDGER_ADMITTED_REASON =
  'This input finding passed synthesis and was carried into the run.'
const LEDGER_FILTERED_FALLBACK_REASON =
  'A validator disproved the synthesized finding this input contributed to.'

/** Maps every admitted input ID to its owning reviewer: primarily from
 * `prepared.surviving_findings`, which already carries the reviewer
 * directly, and for suppressed inputs (absent from that list) from the
 * screen result that admitted it. */
function buildAdmittedReviewerIndex(
  prepared: PrepareOutput,
  screenResults: FinalizeScreenResults,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const finding of prepared.surviving_findings) {
    index.set(finding.input_id, finding.reviewer)
  }
  for (const result of screenResults) {
    for (const finding of result.result.admitted_findings) {
      if (!index.has(finding.input_id)) {
        index.set(finding.input_id, result.reviewer)
      }
    }
  }
  return index
}

/** Maps a suppressed input ID to the confidence-gate reason
 * `prepared.confidence_dispositions` recorded for it. */
function buildConfidenceReasonIndex(
  prepared: PrepareOutput,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const entry of prepared.confidence_dispositions) {
    if (entry.disposition === 'suppressed' && entry.reason !== undefined) {
      index.set(entry.input_id, entry.reason)
    }
  }
  return index
}

/** Maps a filtered input ID to the disproving validator's reason, read off
 * the reconciled finding it contributed to (`validated: false` always
 * carries `validation_reason`, per `classifyFinding`). */
function buildFilteredReasonIndex(
  reconciled: ReconcileValidatorResultsOutput,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const finding of reconciled.findings) {
    if (
      finding.validated !== false ||
      finding.validation_reason === undefined
    ) {
      continue
    }
    for (const inputId of finding.input_finding_ids) {
      index.set(inputId, finding.validation_reason)
    }
  }
  return index
}

/** The set of personas whose dispatch outcome is `validation_unavailable`:
 * withheld evidence that contributes no ledger row of either kind. */
function buildValidationUnavailablePersonas(
  dispatchRecords: FinalizeDispatchRecords,
): ReadonlySet<string> {
  return new Set(
    dispatchRecords
      .filter((record) => record.dispatch_outcome === 'validation_unavailable')
      .map((record) => record.persona),
  )
}

function admittedLedgerReason(
  inputId: string,
  disposition: FinalInputDisposition,
  confidenceReasons: ReadonlyMap<string, string>,
  filteredReasons: ReadonlyMap<string, string>,
): string {
  if (disposition === 'suppressed') {
    return confidenceReasons.get(inputId) ?? CONFIDENCE_GATE_SUPPRESSED_REASON
  }
  if (disposition === 'filtered') {
    return filteredReasons.get(inputId) ?? LEDGER_FILTERED_FALLBACK_REASON
  }
  return LEDGER_ADMITTED_REASON
}

function buildAdmittedLedgerRows(
  input: BuildInputLedgerInput,
  unavailablePersonas: ReadonlySet<string>,
): readonly AdmittedInputLedgerRow[] {
  const reviewerIndex = buildAdmittedReviewerIndex(
    input.prepared,
    input.screen_results,
  )
  const dispositionIndex = new Map(
    input.finalized.input_dispositions.map((entry) => [entry.input_id, entry]),
  )
  const confidenceReasons = buildConfidenceReasonIndex(input.prepared)
  const filteredReasons = buildFilteredReasonIndex(input.reconciled)

  const rows: AdmittedInputLedgerRow[] = []
  for (const entry of input.prepared.confidence_dispositions) {
    const reviewer = reviewerIndex.get(entry.input_id)
    if (reviewer === undefined) {
      // Unreachable: `deriveFinalizeContext` rejects any confidence
      // disposition that does not resolve to exactly one screened finding
      // before `buildInputLedger` ever runs, so every entry here is backed
      // by either a surviving finding or a screen result.
      throw new Error(
        'buildInputLedger: confidence disposition has no resolvable reviewer',
      )
    }
    if (unavailablePersonas.has(reviewer)) continue

    const finalDisposition = dispositionIndex.get(entry.input_id)?.disposition
    if (finalDisposition === undefined) continue

    rows.push({
      record_type: 'admitted',
      input_id: entry.input_id,
      reviewer,
      confidence: entry.confidence,
      disposition: finalDisposition,
      reason: admittedLedgerReason(
        entry.input_id,
        finalDisposition,
        confidenceReasons,
        filteredReasons,
      ),
    })
  }
  return [...rows].sort((a, b) => compareStrings(a.input_id, b.input_id))
}

function buildRejectedLedgerRows(
  screenResults: FinalizeScreenResults,
  unavailablePersonas: ReadonlySet<string>,
): readonly RejectedInputLedgerRow[] {
  const rows: RejectedInputLedgerRow[] = []
  for (const result of screenResults) {
    if (unavailablePersonas.has(result.reviewer)) continue
    const summary = result.result.rejected_summary
    if (!summary) continue
    rows.push({
      record_type: 'rejected_summary',
      reviewer: result.reviewer,
      dispatch_outcome: summary.dispatch_outcome,
      rejected_finding_count: summary.rejected_finding_count,
      rejected_severities: summary.rejected_severities,
      disposition: 'rejected',
      reason: summary.reason,
    })
  }
  return [...rows].sort((a, b) => compareStrings(a.reviewer, b.reviewer))
}

/**
 * Builds the artifact's input-finding ledger: one admitted row per
 * `prepared.confidence_dispositions` entry, sorted by input ID, followed by
 * one rejected-summary row per screen result that carried a
 * `rejected_summary`, sorted by reviewer. A `validation_unavailable`
 * persona contributes no row of either kind, and a rejection with no
 * summary (KTD21) contributes no row at all -- never a fabricated count.
 * Never reads `process.env`, the filesystem, or the clock.
 */
export function buildInputLedger(
  input: BuildInputLedgerInput,
): readonly InputLedgerRow[] {
  const unavailablePersonas = buildValidationUnavailablePersonas(
    input.dispatch_records,
  )
  return [
    ...buildAdmittedLedgerRows(input, unavailablePersonas),
    ...buildRejectedLedgerRows(input.screen_results, unavailablePersonas),
  ]
}

// --- review coverage phase: aggregated reviewer and validator coverage ------
//
// Aggregates every screen result's residual risks and testing gaps, the
// personas whose dispatch failed outright, the reasons a requested
// validator never answered, and the merge phase's disagreement facts into
// the artifact's `coverage` shape. Every array is bounded at `MAX_PERSONAS`;
// a union that would exceed the bound rejects with a fixed reason rather
// than silently truncating. Never reads `process.env`, the filesystem, or
// the clock.

export interface BuildReviewCoverageInput {
  readonly dispatch_records: FinalizeDispatchRecords
  readonly validator_lifecycle_results: ValidatorLifecycleResults
  readonly screen_results: FinalizeScreenResults
  readonly reconciled: ReconcileValidatorResultsOutput
  readonly merge: MergeOutput
}

export interface ReviewCoverageSummary {
  readonly reviewers: number
  readonly validators: number
  readonly residual_risks: readonly string[]
  readonly testing_gaps: readonly string[]
  readonly failed_reviewers: readonly string[]
  readonly validator_failures: readonly string[]
  readonly intent_uncertainty: readonly string[]
}

type BuildReviewCoverageRejectReason = 'coverage array exceeds bound'

export interface BuildReviewCoverageRejection {
  readonly path: string
  readonly reason: BuildReviewCoverageRejectReason
}

export type BuildReviewCoverageResult =
  | { readonly ok: true; readonly value: ReviewCoverageSummary }
  | { readonly ok: false; readonly rejection: BuildReviewCoverageRejection }

function dedupeSortedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings)
}

function checkCoverageArrayBound(
  field: string,
  values: readonly string[],
): BuildReviewCoverageRejection | undefined {
  if (values.length <= MAX_PERSONAS) return undefined
  return {
    path: formatReviewArtifactIssuePath(['coverage', field]),
    reason: 'coverage array exceeds bound',
  }
}

/**
 * Aggregates screen-phase and validator-phase evidence into the artifact's
 * `coverage` shape: deduped, sorted unions of residual risks and testing
 * gaps; the personas whose dispatch outcome was `malformed`,
 * `never_returned`, or `validation_unavailable`; the disproving reasons for
 * every requested validator that never answered; and the merge phase's
 * disagreement facts, carried through unchanged. Every array is checked
 * against `MAX_PERSONAS` before assembly -- an overflow rejects rather than
 * silently truncating. Never reads `process.env`, the filesystem, or the
 * clock.
 */
export function buildReviewCoverage(
  input: BuildReviewCoverageInput,
): BuildReviewCoverageResult {
  const residualRisks = dedupeSortedStrings(
    input.screen_results.flatMap((result) => result.result.residual_risks),
  )
  const testingGaps = dedupeSortedStrings(
    input.screen_results.flatMap((result) => result.result.testing_gaps),
  )
  const failedReviewers = dedupeSortedStrings(
    input.dispatch_records
      .filter((record) =>
        FINALIZE_CONTEXT_LOSS_DISPATCH_OUTCOMES.has(record.dispatch_outcome),
      )
      .map((record) => record.persona),
  )
  const validatorFailures = input.reconciled.lifecycle_failures.map(
    (failure) => failure.reason,
  )
  const intentUncertainty = [...input.merge.disagreement_facts]

  const bounded: readonly (readonly [string, readonly string[]])[] = [
    ['residual_risks', residualRisks],
    ['testing_gaps', testingGaps],
    ['failed_reviewers', failedReviewers],
    ['validator_failures', validatorFailures],
    ['intent_uncertainty', intentUncertainty],
  ]
  for (const [field, values] of bounded) {
    const violation = checkCoverageArrayBound(field, values)
    if (violation) return { ok: false, rejection: violation }
  }

  return {
    ok: true,
    value: {
      reviewers: input.dispatch_records.length,
      validators: input.validator_lifecycle_results.length,
      residual_risks: residualRisks,
      testing_gaps: testingGaps,
      failed_reviewers: failedReviewers,
      validator_failures: validatorFailures,
      intent_uncertainty: intentUncertainty,
    },
  }
}

// --- synthesized finding projection phase ------------------------------------
//
// Projects every reconciled finding into the artifact's synthesized-finding
// shape: nests `fingerprint`, `submitters`, and `agreement_credit` under
// `provenance`, carries `validated`/`validation_reason` through unchanged,
// and strips the flat, helper-only `finding_id` so the result parses
// strictly against `SynthesizedFindingSchema`. Never reads `process.env`,
// the filesystem, or the clock.

export interface SynthesizedFindingProvenanceProjection {
  readonly fingerprint: string
  readonly submitters: readonly string[]
  readonly agreement_credit: readonly string[]
}

export interface SynthesizedFindingProjection {
  readonly title: string
  readonly severity: ReconciledFinding['severity']
  readonly file: string
  readonly line: number
  readonly why_it_matters: string
  readonly autofix_class: ReconciledFinding['autofix_class']
  readonly owner: ReconciledFinding['owner']
  readonly requires_verification: boolean
  readonly confidence: number
  readonly evidence: ReconciledFinding['evidence']
  readonly pre_existing: boolean
  readonly suggested_fix?: ReconciledFinding['suggested_fix']
  readonly validated?: boolean
  readonly validation_reason?: string
  readonly route_narrowing_reason?: string
  readonly input_finding_ids: readonly string[]
  readonly provenance: SynthesizedFindingProvenanceProjection
}

export interface ProjectSynthesizedFindingsInput {
  readonly findings: readonly ReconciledFinding[]
}

function projectOneSynthesizedFinding(
  finding: ReconciledFinding,
): SynthesizedFindingProjection {
  return {
    title: finding.title,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    why_it_matters: finding.why_it_matters,
    autofix_class: finding.autofix_class,
    owner: finding.owner,
    requires_verification: finding.requires_verification,
    confidence: finding.confidence,
    evidence: finding.evidence,
    pre_existing: finding.pre_existing,
    ...(finding.suggested_fix !== undefined
      ? { suggested_fix: finding.suggested_fix }
      : {}),
    ...(finding.validated !== undefined
      ? { validated: finding.validated }
      : {}),
    ...(finding.validation_reason !== undefined
      ? { validation_reason: finding.validation_reason }
      : {}),
    ...(finding.route_narrowing_reason !== undefined
      ? { route_narrowing_reason: finding.route_narrowing_reason }
      : {}),
    input_finding_ids: finding.input_finding_ids,
    provenance: {
      fingerprint: finding.fingerprint,
      submitters: finding.submitters,
      agreement_credit: finding.agreement_credit ?? [],
    },
  }
}

/**
 * Projects every reconciled finding into the artifact's synthesized-finding
 * shape, in the reconciled order. Nests `fingerprint`, `submitters`, and
 * `agreement_credit` under `provenance` (absent `agreement_credit` projects
 * to an empty list, never omitted), carries `validated`/`validation_reason`
 * through unchanged, and never emits the flat, helper-only `finding_id`.
 * This is projection only -- it never re-validates referential integrity
 * against the input ledger; `ReviewArtifactSchema.parse` is the actual
 * enforcement point for that. Never reads `process.env`, the filesystem, or
 * the clock.
 */
export function projectSynthesizedFindings(
  input: ProjectSynthesizedFindingsInput,
): readonly SynthesizedFindingProjection[] {
  return input.findings.map((finding) => projectOneSynthesizedFinding(finding))
}

// --- finalizeReview composition phase ----------------------------------------
//
// Composes every phase above into the finalize envelope's discriminated
// output: `deriveFinalizeContext`, then `runReviewPipeline`, then the input
// ledger, review coverage, and synthesized-finding projections, then the
// shared report projection both output kinds carry. A `report-only` run
// returns that projection with no artifact wrapper; every other mode builds
// the full `ReviewArtifactSchema` artifact and parses it before returning,
// so a schema violation surfaces as a rejection with no partial output
// rather than a malformed persisted artifact. `run_status` corrects KTD20's
// gap: any dispatch outcome of `malformed`, `never_returned`, or
// `validation_unavailable`, any lost risk-critical persona, or any
// validator-lifecycle degradation forces `degraded`, not only a
// risk-critical loss. The artifact's `verdict` narrative mirrors that same
// gate rather than trusting the model's plan-assessment narrative to know
// about it. Never reads `process.env`, the filesystem, or the clock.

export type FinalizeReviewInput = FinalizeInputValue

type FinalizeOutputValue = ReturnType<typeof FinalizeOutputSchema.parse>

type FinalizeReviewRejection =
  | FinalizeContextRejection
  | ReconcileValidatorResultsRejection
  | FinalizeReviewDispositionsRejection
  | BuildReviewCoverageRejection
  | RiskCoverageSemanticsRejection
  | DispositionLedgerReconciliationRejection
  | {
      readonly path: string
      readonly reason: 'artifact failed schema validation'
    }
  | {
      readonly path: string
      readonly reason: 'finalize output failed schema validation'
    }

export type FinalizeReviewResult =
  | { readonly ok: true; readonly value: FinalizeOutputValue }
  | { readonly ok: false; readonly rejection: FinalizeReviewRejection }

const ARTIFACT_NON_CLEAN_VERDICT =
  'Review did not reach a clean verdict; see blocking reasons and coverage for detail.'

/** `run_status` degrades on any of: a validator-lifecycle degradation, a
 * lost risk-critical persona, or any reviewer whose dispatch outcome was
 * `malformed`, `never_returned`, or `validation_unavailable` -- corrects
 * KTD20's gap, where only a risk-critical loss forced degraded status. */
function deriveArtifactRunStatus(
  reconciledDegraded: boolean,
  dispatchRecords: FinalizeDispatchRecords,
  lostRiskCriticalPersonas: readonly LostRiskCriticalPersona[],
): 'completed' | 'degraded' {
  if (reconciledDegraded) return 'degraded'
  if (lostRiskCriticalPersonas.length > 0) return 'degraded'
  const hasFailedReviewer = dispatchRecords.some((record) =>
    FINALIZE_CONTEXT_LOSS_DISPATCH_OUTCOMES.has(record.dispatch_outcome),
  )
  return hasFailedReviewer ? 'degraded' : 'completed'
}

/** The artifact's `verdict` narrative: the plan-assessment verdict text only
 * when the run's own verdict is clean and `run_status` is `completed`;
 * otherwise the fixed non-clean phrase. Never lets a model-authored
 * narrative claim a clean run when either gate blocks it. */
function deriveArtifactVerdictText(
  planAssessmentVerdict: string,
  runVerdict: ReviewRunVerdict,
  runStatus: 'completed' | 'degraded',
): string {
  if (runVerdict.clean && runStatus === 'completed') {
    return planAssessmentVerdict
  }
  return ARTIFACT_NON_CLEAN_VERDICT
}

function buildScreenResultIndex(
  screenResults: FinalizeScreenResults,
): ReadonlyMap<string, FinalizeScreenResult> {
  const index = new Map<string, FinalizeScreenResult>()
  for (const result of screenResults) {
    index.set(result.reviewer, result)
  }
  return index
}

interface ArtifactDispatchEntry {
  readonly persona: string
  readonly dispatch_outcome: FinalizeDispatchRecord['dispatch_outcome']
  readonly input_finding_count: number
  readonly rejection_reason?: string
  readonly selection_surface?: readonly string[]
  readonly selection_reason?: string
}

function buildDispatchEntry(
  record: FinalizeDispatchRecord,
  screenByReviewer: ReadonlyMap<string, FinalizeScreenResult>,
): ArtifactDispatchEntry {
  const screenResult = screenByReviewer.get(record.persona)
  const inputFindingCount =
    record.dispatch_outcome === 'validation_unavailable'
      ? 0
      : (screenResult?.result.admitted_findings.length ?? 0)
  const rejectionReason = screenResult?.result.rejected_summary?.reason
  const selectionSurface = record.selection_surface
  const selectionReason = record.selection_reason

  return {
    persona: record.persona,
    dispatch_outcome: record.dispatch_outcome,
    input_finding_count: inputFindingCount,
    ...(rejectionReason !== undefined
      ? { rejection_reason: rejectionReason }
      : {}),
    ...(selectionSurface !== undefined && selectionSurface.length > 0
      ? { selection_surface: selectionSurface }
      : {}),
    ...(selectionReason !== undefined
      ? { selection_reason: selectionReason }
      : {}),
  }
}

function buildArtifactDispatches(
  dispatchRecords: FinalizeDispatchRecords,
  screenByReviewer: ReadonlyMap<string, FinalizeScreenResult>,
): readonly ArtifactDispatchEntry[] {
  return [...dispatchRecords]
    .map((record) => buildDispatchEntry(record, screenByReviewer))
    .sort((a, b) => compareStrings(a.persona, b.persona))
}

interface ArtifactRiskCoverageEntry {
  readonly persona: string
  readonly satisfied: boolean
  readonly input_finding_id?: string
}

interface RiskCoverageSemanticsInput {
  readonly dispatches: readonly ArtifactDispatchEntry[]
  readonly findings: readonly SynthesizedFindingProjection[]
  readonly risk_coverage?: readonly ArtifactRiskCoverageEntry[]
}

interface RiskCoverageSemanticsRejection {
  readonly path: string
  readonly reason: 'satisfied risk coverage must cite a validated finding on the lost persona selection surface'
}

type RiskCoverageSemanticsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: RiskCoverageSemanticsRejection }

/**
 * Defensive pipeline-side assertion that every satisfied risk-coverage entry
 * cites a validated finding on the lost persona's recorded selection
 * surface. `deriveRiskCoverage` already guarantees this at derivation time
 * -- `isEligibleRiskCoverageCandidate` enforces the on-surface rule and
 * `isValidationBandEligible` enforces the validation-band rule before a
 * candidate can ever be cited -- so this check restates that guarantee at
 * the pipeline boundary rather than deriving it independently, protecting
 * against a future regression in artifact assembly. Surfaces compare
 * through `normalizeRepoRelativePath` so alternate spellings (mixed
 * separators, dot segments) of the same surface entry still match. This is
 * the pipeline-owned counterpart to `ReviewArtifactSchema`'s structural
 * `risk_coverage` refinement, which only checks referential integrity.
 * Never reads `process.env`, the filesystem, or the clock.
 */
export function checkRiskCoverageSemantics(
  artifactCandidate: RiskCoverageSemanticsInput,
): RiskCoverageSemanticsResult {
  const coverage = artifactCandidate.risk_coverage
  if (coverage === undefined) return { ok: true }

  for (const [coverageIndex, entry] of coverage.entries()) {
    if (!entry.satisfied || entry.input_finding_id === undefined) continue
    const citedId = entry.input_finding_id

    const dispatch = artifactCandidate.dispatches.find(
      (record) => record.persona === entry.persona,
    )
    const normalizedSurface = new Set(
      (dispatch?.selection_surface ?? []).map(normalizeRepoRelativePath),
    )

    const covered = artifactCandidate.findings.some((finding) => {
      if (!finding.input_finding_ids.includes(citedId)) return false
      const inValidationBand =
        finding.severity === 'P0' ||
        finding.severity === 'P1' ||
        finding.requires_verification
      const validationSatisfied = inValidationBand
        ? finding.validated === true
        : finding.validated !== false
      if (!validationSatisfied) return false
      return normalizedSurface.has(normalizeRepoRelativePath(finding.file))
    })

    if (!covered) {
      return {
        ok: false,
        rejection: {
          path: formatReviewArtifactIssuePath([
            'risk_coverage',
            coverageIndex,
            'input_finding_id',
          ]),
          reason:
            'satisfied risk coverage must cite a validated finding on the lost persona selection surface',
        },
      }
    }
  }

  return { ok: true }
}

interface DispositionLedgerReconciliationRejection {
  readonly path: string
  readonly reason: 'disposition counts do not reconcile with the admitted input ledger'
}

type DispositionLedgerReconciliationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly rejection: DispositionLedgerReconciliationRejection
    }

/**
 * Defensive pipeline-side assertion that `disposition_counts`' four
 * admitted-weight fields (`surviving` + `merged` + `suppressed` +
 * `filtered`) sum to the number of `record_type: 'admitted'` rows in the
 * independently-derived input ledger -- the documented invariant on
 * `FinalDispositionCounts` ("the five fields always sum to the total
 * findings observed"), restated here as the actual verifier instead of left
 * aspirational. `disposition_counts` (via `deriveInputDispositions`) and
 * the ledger (via `buildAdmittedLedgerRows`) both exclude
 * `validation_unavailable` personas by construction, so this should never
 * trip in a correctly wired pipeline; it exists to catch a future
 * regression that lets the two derivations drift apart, the same role
 * `checkRiskCoverageSemantics` plays for risk coverage. Never reads
 * `process.env`, the filesystem, or the clock.
 */
export function checkDispositionCountsReconcileLedger(
  dispositionCounts: FinalDispositionCounts,
  ledger: readonly InputLedgerRow[],
): DispositionLedgerReconciliationResult {
  const admittedLedgerRowCount = ledger.filter(
    (row) => row.record_type === 'admitted',
  ).length
  const dispositionAdmittedSum =
    dispositionCounts.surviving +
    dispositionCounts.merged +
    dispositionCounts.suppressed +
    dispositionCounts.filtered

  if (dispositionAdmittedSum !== admittedLedgerRowCount) {
    return {
      ok: false,
      rejection: {
        path: formatReviewArtifactIssuePath(['disposition_counts']),
        reason:
          'disposition counts do not reconcile with the admitted input ledger',
      },
    }
  }
  return { ok: true }
}

/** Strips `finding_id` (a helper-only field with no artifact leaf) from
 * every risk-coverage derivation and omits the field entirely when there is
 * no lost risk-critical persona to report -- never an empty array. */
function projectRiskCoverage(
  riskCoverage: readonly RiskCoverageDerivation[],
): readonly ArtifactRiskCoverageEntry[] | undefined {
  if (riskCoverage.length === 0) return undefined
  return riskCoverage.map((entry) => ({
    persona: entry.persona,
    satisfied: entry.satisfied,
    ...(entry.input_finding_id !== undefined
      ? { input_finding_id: entry.input_finding_id }
      : {}),
  }))
}

function buildReportProjection(
  verdictText: string,
  findings: readonly SynthesizedFindingProjection[],
  appliedFixes: readonly string[],
  pipelineOutput: RunReviewPipelineOutput,
  coverage: ReviewCoverageSummary,
  riskCoverage: readonly ArtifactRiskCoverageEntry[] | undefined,
) {
  return {
    verdict: verdictText,
    findings,
    applied_fixes: appliedFixes,
    residual_actionable_work:
      pipelineOutput.plan_assessment.residual_actionable_work,
    advisory_outputs: pipelineOutput.plan_assessment.advisory_outputs,
    coverage,
    input_dispositions: pipelineOutput.finalized.input_dispositions,
    disposition_counts: pipelineOutput.finalized.disposition_counts,
    queues: pipelineOutput.finalized.queues,
    pre_existing_findings: pipelineOutput.finalized.pre_existing_findings,
    ...(riskCoverage !== undefined ? { risk_coverage: riskCoverage } : {}),
  }
}

function parseFinalizeOutput(output: unknown): FinalizeReviewResult {
  const parsed = FinalizeOutputSchema.safeParse(output)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      rejection: {
        path: issue
          ? formatReviewArtifactIssuePath(issue.path)
          : JSON_ROOT_PATH,
        reason: 'finalize output failed schema validation',
      },
    }
  }
  return { ok: true, value: parsed.data }
}

/**
 * Runs the full finalize envelope: `deriveFinalizeContext`, then
 * `runReviewPipeline`, then the input ledger, review coverage, and
 * synthesized-finding projections, then assembles the report projection
 * both output kinds share. A `report-only` run returns that projection
 * directly; every other mode also builds and parses the full
 * `ReviewArtifactSchema` artifact, returning a rejection with the failing
 * Zod path (never the message or input) and no partial output if it fails
 * to parse. The whole result is parsed through `FinalizeOutputSchema`
 * before returning. Any rejection from any step aborts the run with no
 * partial output. Never reads `process.env`, the filesystem, or the clock.
 */
export function finalizeReview(
  input: FinalizeReviewInput,
): FinalizeReviewResult {
  const context = deriveFinalizeContext({
    merge: input.merge,
    prepared: input.prepared,
    screen_results: input.screen_results,
    dispatch_records: input.dispatch_records,
    parent_run_metadata: {
      selected_dispatches: input.parent_run_metadata.selected_dispatches,
      validation: input.parent_run_metadata.validation,
    },
  })
  if (!context.ok) return context

  const pipeline = runReviewPipeline({
    merge: input.merge,
    validator_lifecycle_results: input.validator_lifecycle_results,
    prepared: input.prepared,
    rejected_payloads: context.value.rejected_payloads,
    lost_risk_critical_personas: context.value.lost_risk_critical_personas,
    plan_assessment: input.plan_assessment,
    screen_results: input.screen_results,
    dispatch_records: input.dispatch_records,
  })
  if (!pipeline.ok) return pipeline

  const coverage = buildReviewCoverage({
    dispatch_records: input.dispatch_records,
    validator_lifecycle_results: input.validator_lifecycle_results,
    screen_results: input.screen_results,
    reconciled: pipeline.value.reconciled,
    merge: input.merge,
  })
  if (!coverage.ok) return coverage

  const findings = projectSynthesizedFindings({
    findings: pipeline.value.reconciled.findings,
  })

  const runStatus = deriveArtifactRunStatus(
    pipeline.value.reconciled.degraded,
    input.dispatch_records,
    context.value.lost_risk_critical_personas,
  )
  const verdictText = deriveArtifactVerdictText(
    input.plan_assessment.verdict,
    pipeline.value.verdict,
    runStatus,
  )

  // Dispatches, the projected risk-coverage entries, and the semantic gate
  // all run before the report-only/writing branch so both output kinds are
  // built from, and validated against, the same data: report-only carries
  // `risk_coverage` in its projection too, so it must pass the identical
  // gate rather than skipping it via an early return.
  const screenByReviewer = buildScreenResultIndex(input.screen_results)
  const dispatches = buildArtifactDispatches(
    input.dispatch_records,
    screenByReviewer,
  )
  const riskCoverage = projectRiskCoverage(pipeline.value.risk_coverage)

  const riskCoverageSemantics = checkRiskCoverageSemantics({
    dispatches,
    findings,
    risk_coverage: riskCoverage,
  })
  if (!riskCoverageSemantics.ok) return riskCoverageSemantics

  const report = buildReportProjection(
    verdictText,
    findings,
    input.parent_run_metadata.applied_fixes,
    pipeline.value,
    coverage.value,
    riskCoverage,
  )

  if (input.parent_run_metadata.mode === 'report-only') {
    return parseFinalizeOutput({ kind: 'report_only', ...report })
  }

  const ledger = buildInputLedger({
    prepared: input.prepared,
    screen_results: input.screen_results,
    dispatch_records: input.dispatch_records,
    finalized: pipeline.value.finalized,
    reconciled: pipeline.value.reconciled,
  })

  const dispositionReconciliation = checkDispositionCountsReconcileLedger(
    pipeline.value.finalized.disposition_counts,
    ledger,
  )
  if (!dispositionReconciliation.ok) return dispositionReconciliation

  const artifact = {
    schema_version: 1 as const,
    run_id: input.parent_run_metadata.run_id,
    branch: input.parent_run_metadata.branch,
    head_sha: input.parent_run_metadata.head_sha,
    mode: input.parent_run_metadata.mode,
    harness: input.parent_run_metadata.harness,
    run_status: runStatus,
    verdict: verdictText,
    completed_at: input.parent_run_metadata.timestamps.completed_at,
    dispatches,
    input_findings: ledger,
    findings,
    disposition_counts: pipeline.value.finalized.disposition_counts,
    applied_fixes: input.parent_run_metadata.applied_fixes,
    residual_actionable_work:
      pipeline.value.plan_assessment.residual_actionable_work,
    advisory_outputs: pipeline.value.plan_assessment.advisory_outputs,
    coverage: coverage.value,
    validation: input.parent_run_metadata.validation,
    ...(riskCoverage !== undefined ? { risk_coverage: riskCoverage } : {}),
  }

  const parsedArtifact = ReviewArtifactSchema.safeParse(artifact)
  if (!parsedArtifact.success) {
    const issue = parsedArtifact.error.issues[0]
    return {
      ok: false,
      rejection: {
        path: issue
          ? formatReviewArtifactIssuePath(issue.path)
          : JSON_ROOT_PATH,
        reason: 'artifact failed schema validation',
      },
    }
  }

  return parseFinalizeOutput({
    kind: 'writing',
    artifact: parsedArtifact.data,
    report,
  })
}
