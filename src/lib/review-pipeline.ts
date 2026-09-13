import path from 'node:path'
import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import {
  MAX_REASON_LENGTH,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'
import {
  AGGREGATE_STDIN_BYTE_CAP,
  PrepareInputSchema,
  PrepareOutputSchema,
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
} {
  const confidenceDispositions: PrepareOutput['confidence_dispositions'] = []
  const survivors: PrepareSurvivor[] = []

  for (const entry of screenResults) {
    for (const finding of entry.result.admitted_findings) {
      if (survivesConfidenceGate(finding)) {
        confidenceDispositions.push({
          input_id: finding.input_id,
          disposition: 'surviving',
        })
        survivors.push({
          inputId: finding.input_id,
          persona: entry.reviewer,
          normalizedFile: normalizeRepoRelativePath(finding.file),
          line: finding.line,
        })
      } else {
        confidenceDispositions.push({
          input_id: finding.input_id,
          disposition: 'suppressed',
          reason: CONFIDENCE_GATE_SUPPRESSED_REASON,
        })
      }
    }
  }

  confidenceDispositions.sort((a, b) => compareStrings(a.input_id, b.input_id))
  return { confidenceDispositions, survivors }
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
        input_finding_ids: sortedMembers.map((member) => member.inputId),
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

  const { confidenceDispositions, survivors } =
    applyConfidenceGate(screenResults)
  const coverageUnion = computeCoverageUnion(selectedDispatches)
  const { candidateGroups, singletonIds } = groupCandidates(survivors)

  const output = PrepareOutputSchema.parse({
    candidate_groups: candidateGroups,
    confidence_dispositions: confidenceDispositions,
    coverage_union: coverageUnion,
    singletons: singletonIds,
  })

  return { ok: true, value: output }
}
