import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import {
  MAX_REASON_LENGTH,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'
import { ScreenOutputSchema } from './review-pipeline-contract.js'
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
  path: readonly (string | number)[] | string,
  reason: PipelineRejectReason,
): string {
  const jsonPath =
    typeof path === 'string' ? path : formatReviewArtifactIssuePath(path)
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
  path: readonly (string | number)[] | string,
  reason: PipelineRejectReason,
  knownFindingsCount: number,
): ScreenOutput {
  return ScreenOutputSchema.parse({
    admitted_findings: [],
    dispatch_outcome: 'malformed',
    rejected_summary: {
      dispatch_outcome: 'malformed',
      reason: truncateReason(formatDiagnostic(persona, path, reason)),
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
    const path = validation.issues[0]?.path ?? JSON_ROOT_PATH
    return wholePayloadRejection(persona, path, 'schema validation', 0)
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
