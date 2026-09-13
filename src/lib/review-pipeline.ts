import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import {
  MAX_REASON_LENGTH,
  SubAgentReturnSchema,
} from './review-artifact-schema.js'
import { ScreenOutputSchema } from './review-pipeline-contract.js'
import { validateReviewReturnValue } from './review-return-validator.js'

/**
 * Pure, side-effect-free screening of one reviewer's raw `ce:review` return.
 *
 * Binds the parsed return to the parent-expected persona and screens every
 * string leaf against a caller-supplied environment snapshot so a secret
 * cannot ride a reviewer payload into a persisted artifact. Never reads
 * `process.env`, the filesystem, or the clock -- `env` is a parameter so
 * callers (and tests) control exactly what is screened against.
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

type PipelineRejectReason =
  | 'schema validation'
  | 'environment-value detection'
  | 'malformed JSON'

const JSON_ROOT_PATH = '$'

const SECRET_NAME_KEYWORDS = [
  'TOKEN',
  'SECRET',
  'KEY',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'AUTH',
  'SESSION',
  'COOKIE',
  'PRIVATE',
  '_PASS',
  '_PWD',
  'PASSPHRASE',
  '_SALT',
] as const

/** Values composed solely of digits, dots, dashes, or path separators never
 * qualify for length-based value matching, however long they are. */
const NUMERIC_OR_PATH_ONLY = /^[0-9.\-/\\]+$/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether one environment value is eligible for embedded-value matching:
 * either long and not purely numeric/path-shaped, or any length when the
 * variable's name signals a secret by a pinned case-insensitive substring.
 */
function isValueQualifying(name: string, value: string): boolean {
  if (value.length === 0) return false

  const upperName = name.toUpperCase()
  if (SECRET_NAME_KEYWORDS.some((keyword) => upperName.includes(keyword))) {
    return true
  }

  if (value.length < 16) return false
  return !NUMERIC_OR_PATH_ONLY.test(value)
}

function buildStructuralPatterns(name: string): readonly RegExp[] {
  const escaped = escapeRegExp(name)
  return [
    new RegExp(`(?<![A-Za-z0-9_])\\$${escaped}(?![A-Za-z0-9_])`),
    new RegExp(`\\$\\{${escaped}\\}`),
    new RegExp(`process\\.env\\.${escaped}(?![A-Za-z0-9_])`),
    new RegExp(`os\\.environ\\[\\s*['"]?${escaped}['"]?\\s*\\]`),
    new RegExp(`(?<![A-Za-z0-9_])${escaped}=(?!=)`),
  ]
}

function hasStructuralEnvReference(
  leaf: string,
  envNames: readonly string[],
): boolean {
  return envNames.some((name) =>
    buildStructuralPatterns(name).some((pattern) => pattern.test(leaf)),
  )
}

function hasEnvValueMatch(
  leaf: string,
  env: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(env).some(
    ([name, value]) => isValueQualifying(name, value) && leaf.includes(value),
  )
}

function leafIsOffending(
  leaf: string,
  env: Readonly<Record<string, string>>,
  envNames: readonly string[],
): boolean {
  return (
    hasStructuralEnvReference(leaf, envNames) || hasEnvValueMatch(leaf, env)
  )
}

interface StringLeaf {
  readonly path: readonly (string | number)[]
  readonly value: string
}

function collectStringLeaves(
  value: unknown,
  path: readonly (string | number)[] = [],
): readonly StringLeaf[] {
  if (typeof value === 'string') {
    return [{ path, value }]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectStringLeaves(item, [...path, index]),
    )
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, val]) => collectStringLeaves(val, [...path, key]),
    )
  }
  return []
}

function findOffendingLeaf(
  value: unknown,
  path: readonly (string | number)[],
  env: Readonly<Record<string, string>>,
  envNames: readonly string[],
): StringLeaf | undefined {
  return collectStringLeaves(value, path).find((leaf) =>
    leafIsOffending(leaf.value, env, envNames),
  )
}

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
 * Admit one reviewer's raw return, bind it to the parent-expected persona,
 * and screen every string leaf against `env` so a secret cannot ride a
 * reviewer payload into a persisted artifact.
 *
 * Rejection granularity: an offending string inside one finding drops only
 * that finding (siblings, addressed by their ORIGINAL index, continue);
 * an offending string outside any finding (the reviewer identity or the
 * top-level `residual_risks`/`testing_gaps` arrays) rejects the whole
 * payload.
 */
export function screenReviewReturn(
  input: ScreenReviewReturnInput,
  env: Readonly<Record<string, string>>,
): ScreenOutput {
  const persona = input.expected_reviewer
  const envNames = Object.keys(env)

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

  const outsideOffense =
    findOffendingLeaf(raw.reviewer, ['reviewer'], env, envNames) ??
    findOffendingLeaf(raw.residual_risks, ['residual_risks'], env, envNames) ??
    findOffendingLeaf(raw.testing_gaps, ['testing_gaps'], env, envNames)

  if (outsideOffense) {
    return wholePayloadRejection(
      persona,
      outsideOffense.path,
      'environment-value detection',
      raw.findings.length,
    )
  }

  const admittedFindings: ScreenOutput['admitted_findings'] = []
  const diagnostics: string[] = []

  raw.findings.forEach((finding, originalIndex) => {
    const offense = findOffendingLeaf(
      finding,
      ['findings', originalIndex],
      env,
      envNames,
    )
    if (offense) {
      diagnostics.push(
        formatDiagnostic(persona, offense.path, 'environment-value detection'),
      )
      return
    }

    admittedFindings.push({
      ...finding,
      disposition: 'surviving',
      input_id: `${persona}#${originalIndex}`,
    })
  })

  const dispatchOutcome = raw.findings.length === 0 ? 'empty' : 'findings'

  return ScreenOutputSchema.parse({
    admitted_findings: admittedFindings,
    dispatch_outcome: dispatchOutcome,
    ...(diagnostics.length > 0
      ? {
          rejected_summary: {
            dispatch_outcome: dispatchOutcome,
            reason: truncateReason(diagnostics.join('; ')),
            rejected_finding_count: diagnostics.length,
          },
        }
      : {}),
    residual_risks: raw.residual_risks,
    testing_gaps: raw.testing_gaps,
  })
}
