import path from 'node:path'
import type { z } from 'zod'
import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import {
  MAX_REASON_LENGTH,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'
import {
  type AdjudicationEnvelopeSchema,
  AGGREGATE_STDIN_BYTE_CAP,
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

function wholePayloadRejection(
  persona: string,
  fieldPath: readonly (string | number)[] | string,
  reason: PipelineRejectReason,
  knownFindingsCount: number,
): ScreenOutput {
  return ScreenOutputSchema.parse({
    admitted_findings: [],
    dispatch_outcome: 'malformed',
    rejected_summary: {
      dispatch_outcome: 'malformed',
      reason: truncateReason(formatDiagnostic(persona, fieldPath, reason)),
      rejected_finding_count: Math.max(1, knownFindingsCount),
    },
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
    return wholePayloadRejection(persona, JSON_ROOT_PATH, 'malformed JSON', 0)
  }

  const validation = validateReviewReturnValue(parsed.value)
  if (!validation.ok) {
    const fieldPath = validation.issues[0]?.path ?? JSON_ROOT_PATH
    return wholePayloadRejection(persona, fieldPath, 'schema validation', 0)
  }

  const raw = SubAgentReturnSchema.parse(parsed.value)

  if (raw.reviewer !== persona) {
    return wholePayloadRejection(
      persona,
      'reviewer',
      'schema validation',
      raw.findings.length,
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
 * Normalizes a repo-relative path for grouping, sorting, and any later
 * surface comparison. Collapses `\`-style separators to `/`, then applies
 * POSIX lexical normalization (redundant slashes, `.` segments, and a
 * leading `./`). Never touches the filesystem or the process environment --
 * this is a pure string transform.
 *
 * Exported so every later phase that needs to compare surfaces uses this
 * exact function; divergent normalization between grouping and comparison
 * is a real bug class here.
 */
export function normalizeRepoRelativePath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll('\\', '/'))
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

/** One assembled merged finding carrying both the fields the wire
 * `MergedFindingSchema` exposes and the mechanical fields (`severity`,
 * `confidence`, `fingerprint`) that only drive sorting and validator-request
 * selection but never appear on the wire themselves. */
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
  readonly fingerprint: string
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
    fingerprint: derived.fingerprint,
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

/**
 * Total order over assembled findings: severity (`P0` first), then
 * confidence descending, then normalized file path, then line, then
 * fingerprint as the stable tiebreak. Every field is either mechanically
 * derived or a stable input, so this order never depends on decision or
 * candidate-group iteration order.
 */
function compareMergedFindingAssembly(
  a: MergedFindingAssembly,
  b: MergedFindingAssembly,
): number {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (severityDelta !== 0) return severityDelta
  if (a.confidence !== b.confidence) return b.confidence - a.confidence
  const pathDelta = compareStrings(a.file, b.file)
  if (pathDelta !== 0) return pathDelta
  if (a.line !== b.line) return a.line - b.line
  return compareStrings(a.fingerprint, b.fingerprint)
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
    return { finding: { ...finding, validated: false }, filtered: true }
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
