import type { z } from 'zod'
import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import {
  MAX_FINDINGS,
  MAX_REASON_LENGTH,
  normalizeRepoRelativePath,
  RISK_CRITICAL_PERSONAS,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'
import {
  type AdjudicationEnvelopeSchema,
  AGGREGATE_STDIN_BYTE_CAP,
  type FinalizeInputSchema,
  isRouteTransitionAllowed,
  MergeOutputSchema,
  type PipelineRoute,
  PrepareInputSchema,
  PrepareOutputSchema,
  ROUTE_REFUSAL_TABLE,
  ScreenOutputSchema,
  type ValidatorLifecycleResultsSchema,
} from './review-pipeline-contract.js'
import { validateReviewReturnValue } from './review-return-validator.js'

// Re-exported for backward compatibility: every existing internal caller in
// this module still refers to `normalizeRepoRelativePath` by its own name,
// and any external importer of this module keeps working unchanged. The
// implementation itself lives in `review-artifact-schema.ts` so that
// module's own risk-coverage surface comparison can reuse it without an
// import cycle back into this one.
export { normalizeRepoRelativePath } from './review-artifact-schema.js'

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

  const parsed = parseRawReturn(input.raw_return)
  if (!parsed.ok) {
    return wholePayloadRejection(
      persona,
      JSON_ROOT_PATH,
      'malformed JSON',
      undefined,
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
    )
  }

  const raw = SubAgentReturnSchema.parse(parsed.value)

  if (raw.reviewer !== persona) {
    return wholePayloadRejection(
      persona,
      'reviewer',
      'schema validation',
      raw.findings.map((finding) => finding.severity),
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
 * incomparable transition) is rejected as `'route widening'`.
 */
function deriveRoute(
  contributing: MergeContributingFindings,
  decision: MergedFindingModelDecision,
):
  | { readonly ok: true; readonly value: PipelineRoute }
  | { readonly ok: false; readonly rejection: MergedFindingRejection } {
  const meet = deriveRouteMeet(contributing)
  if (!decision.proposed_route) return { ok: true, value: meet }

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

  return { ok: true, value: decision.proposed_route }
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

/** The validator request set is purely mechanical: exactly every merged
 * finding that is `P0` or `P1`, plus every merged finding with
 * `requires_verification: true`. Never model-influenced beyond the route
 * `requires_verification` value `deriveMergedFindingFields` already
 * computed. */
function requiresValidatorRequest(assembly: MergedFindingAssembly): boolean {
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
  }
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
 * `MergeOutputSchema.parse` until every finding derived successfully.
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
  const disagreementFacts: string[] = []

  for (const group of validated.value.merged) {
    const result = assembleMergedGroupFinding(
      group,
      survivingIndex,
      returnedReviewers,
    )
    if (!result.ok) return result
    assemblies.push(result.value)
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
  }

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

type FinalizeInputValue = ReturnType<typeof FinalizeInputSchema.parse>
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
    'selected_dispatches'
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
  | 'validator request references unknown merged finding'
  | 'dispatch record mismatch'
  | 'screen result missing for selected persona'
  | 'unexpected screen result for persona'
  | 'merged finding fields diverge from derivation'

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

function dispatchRecordsEqual(
  a: FinalizeDispatchRecord,
  b: FinalizeDispatchRecord,
): boolean {
  return (
    a.persona === b.persona &&
    a.dispatch_outcome === b.dispatch_outcome &&
    JSON.stringify(a.selection_surface ?? []) ===
      JSON.stringify(b.selection_surface ?? [])
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

/** Every validator request must correspond to a merged finding this envelope
 * actually produced -- a request for an unknown finding ID is a
 * data-integrity violation, not a malformed model decision. */
function checkValidatorRequestsResolve(
  validatorRequests: MergeOutput['validator_requests'],
  knownFindingIds: ReadonlySet<string>,
): FinalizeContextRejection | undefined {
  for (const [index, request] of validatorRequests.entries()) {
    if (!knownFindingIds.has(request.finding_id)) {
      return {
        path: formatReviewArtifactIssuePath([
          'merge',
          'validator_requests',
          index,
          'finding_id',
        ]),
        reason: 'validator request references unknown merged finding',
      }
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

  for (const [index, record] of dispatchRecords.entries()) {
    const selected = selectedByPersona.get(record.persona)
    if (!selected || !dispatchRecordsEqual(record, selected)) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath(['dispatch_records', index]),
        'dispatch record mismatch',
      )
    }
  }

  return { ok: true, value: selectedByPersona }
}

/** `screen_results` must contain exactly one result per selected persona,
 * none extra. */
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
    if (!screenByReviewer.has(record.persona)) {
      return rejectFinalizeContext(
        formatReviewArtifactIssuePath(['dispatch_records', index, 'persona']),
        'screen result missing for selected persona',
      )
    }
  }

  return { ok: true, value: screenByReviewer }
}

/** Whether one merged finding's carried fields diverge from a fresh
 * `deriveMergedFindingFields` re-derivation over its carried survivors,
 * using the finding's own route and agreement-credit fields as the model
 * decision. Compares severity, confidence, pre_existing, fingerprint,
 * submitters, and route -- the KTD19 verifier's exact field list. */
function mergedFindingDivergesFromDerivation(
  finding: MergeOutput['merged_findings'][number],
  contributingByFindingId: ReadonlyMap<string, readonly SurvivingFinding[]>,
  returnedReviewers: readonly string[],
): boolean {
  const resolved = contributingByFindingId.get(finding.finding_id) ?? []
  const contributing = toContributingTuple(
    resolved.length >= 2 ? resolved : [...resolved, ...resolved],
  )

  const derivation = deriveMergedFindingFields({
    contributing,
    decision: {
      line: finding.line,
      eligible_agreement_credit: finding.agreement_credit,
      proposed_route: {
        autofix_class: finding.autofix_class,
        owner: finding.owner,
        requires_verification: finding.requires_verification,
      },
      route_narrowing_reason: 'carried route verification',
    },
    returned_reviewers: returnedReviewers,
  })

  return (
    !derivation.ok ||
    derivation.value.severity !== finding.severity ||
    derivation.value.confidence !== finding.confidence ||
    derivation.value.pre_existing !== finding.pre_existing ||
    derivation.value.fingerprint !== finding.fingerprint ||
    JSON.stringify(derivation.value.submitters) !==
      JSON.stringify(finding.submitters) ||
    derivation.value.route.autofix_class !== finding.autofix_class ||
    derivation.value.route.owner !== finding.owner ||
    derivation.value.route.requires_verification !==
      finding.requires_verification
  )
}

/** KTD19 verifier: re-runs `deriveMergedFindingFields` over every merged
 * finding's carried survivors and rejects the first one whose carried
 * fields diverge from the fresh derivation. */
function checkMergedFindingsMatchDerivation(
  mergedFindings: MergeOutput['merged_findings'],
  contributingByFindingId: ReadonlyMap<string, readonly SurvivingFinding[]>,
  returnedReviewers: readonly string[],
): FinalizeContextRejection | undefined {
  for (const [index, finding] of mergedFindings.entries()) {
    if (
      mergedFindingDivergesFromDerivation(
        finding,
        contributingByFindingId,
        returnedReviewers,
      )
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
    findingIds.value,
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
 * count one `FinalizedInputDisposition` entry. The five fields always sum to
 * the total findings observed (admitted inputs plus rejected weight) --
 * verified by the caller, since this module never asserts its own output. */
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

/** One finding placed in an action queue. `unconfirmed` is `true` when the
 * finding's validator run failed or was unavailable -- nobody disproved it,
 * so it stays actionable, but a later slice needs to know it was never
 * confirmed either. */
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
 * rejects rather than silently defaulting to `surviving`.
 */
function deriveInputDispositions(
  prepared: PrepareOutput,
  reconciled: ReconcileValidatorResultsOutput,
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
  const inputDispositionsResult = deriveInputDispositions(
    input.prepared,
    input.reconciled,
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
export interface PlanAssessmentResult {
  readonly kind: 'explicit_unmet_requirement' | 'inferred_gap'
  readonly description: string
}

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
