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
  type PipelineRoute,
  PrepareInputSchema,
  PrepareOutputSchema,
  ROUTE_REFUSAL_TABLE,
  ScreenOutputSchema,
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
