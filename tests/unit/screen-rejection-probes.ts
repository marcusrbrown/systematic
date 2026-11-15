// Probe table for `screen`: one row per kind of mistake a reviewer return can
// carry, with what `screen` must report for it. The table is shared by the
// in-process, subprocess and packaged-bundle suites, so every surface is held
// to the same expectations.

export const PROBE_REVIEWER = 'correctness'

const BASE_FINDING = {
  autofix_class: 'gated_auto',
  confidence: 0.85,
  evidence: ['src/example.ts:42 demonstrates the failure path.'],
  file: 'src/example.ts',
  line: 42,
  owner: 'downstream-resolver',
  pre_existing: false,
  requires_verification: true,
  severity: 'P1',
  suggested_fix: 'Handle the failure before continuing.',
  title: 'Example issue',
  why_it_matters: 'The example path can fail during normal execution.',
}

function finding(
  overrides: Readonly<Record<string, unknown>> = {},
  omit: readonly string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...BASE_FINDING, ...overrides }
  for (const key of omit) delete merged[key]
  return merged
}

function reviewerReturn(
  overrides: Readonly<Record<string, unknown>> = {},
  omit: readonly string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    findings: [finding()],
    residual_risks: [],
    reviewer: PROBE_REVIEWER,
    testing_gaps: [],
    ...overrides,
  }
  for (const key of omit) delete merged[key]
  return merged
}

const SEVERITIES = ['P0', 'P1', 'P2', 'P3']
const OWNERS = ['review-fixer', 'downstream-resolver', 'human', 'release']

export interface ProbeIssue {
  readonly path: string
  readonly code: string
  readonly allowed?: readonly string[]
}

export type ProbeExpectation =
  | { readonly kind: 'admitted' }
  | {
      readonly kind: 'rejected'
      readonly code: 'malformed_json' | 'identity_mismatch'
      /** Whether the helper produces a `rejected_summary` row. */
      readonly summaryRow: boolean
    }
  | {
      readonly kind: 'rejected'
      readonly code: 'schema_validation'
      /** The full issue count. */
      readonly issueCount: number
      /** The first projected issue. */
      readonly first: ProbeIssue
      readonly summaryRow: boolean
    }

export interface ScreenProbe {
  readonly name: string
  /** A decoded value, or the raw text for the cases that are not JSON. */
  readonly input: unknown
  readonly expected: ProbeExpectation
}

function schemaProbe(
  name: string,
  input: unknown,
  first: ProbeIssue,
  options: { readonly issueCount?: number; readonly summaryRow?: boolean } = {},
): ScreenProbe {
  return {
    expected: {
      code: 'schema_validation',
      first,
      issueCount: options.issueCount ?? 1,
      kind: 'rejected',
      summaryRow: options.summaryRow ?? true,
    },
    input,
    name,
  }
}

function malformedJsonProbe(name: string, input: string): ScreenProbe {
  return {
    expected: { code: 'malformed_json', kind: 'rejected', summaryRow: false },
    input,
    name,
  }
}

const VALID_TEXT = JSON.stringify(reviewerReturn())

export const SCREEN_PROBES: readonly ScreenProbe[] = [
  { expected: { kind: 'admitted' }, input: reviewerReturn(), name: 'valid' },
  {
    expected: { kind: 'admitted' },
    input: reviewerReturn({ findings: [finding({ suggested_fix: null })] }),
    name: 'suggested_fix null',
  },
  schemaProbe(
    'parent-record keys with one finding',
    reviewerReturn({ dispatch_outcome: 'findings', harness: 'opencode' }),
    { code: 'unrecognized_keys', path: '$' },
  ),
  schemaProbe(
    'parent-record keys with zero findings',
    reviewerReturn({
      dispatch_outcome: 'empty',
      findings: [],
      harness: 'opencode',
    }),
    { code: 'unrecognized_keys', path: '$' },
    { summaryRow: false },
  ),
  schemaProbe(
    'finding carries disposition',
    reviewerReturn({ findings: [finding({ disposition: 'surviving' })] }),
    { code: 'unrecognized_keys', path: 'findings.0' },
  ),
  schemaProbe(
    'owner outside the enum',
    reviewerReturn({ findings: [finding({ owner: 'author' })] }),
    { allowed: OWNERS, code: 'invalid_value', path: 'findings.0.owner' },
  ),
  schemaProbe(
    'owner and severity outside their enums',
    reviewerReturn({
      findings: [finding({ owner: 'human-reviewer', severity: 'P4' })],
    }),
    { allowed: SEVERITIES, code: 'invalid_value', path: 'findings.0.severity' },
    { issueCount: 2 },
  ),
  schemaProbe(
    'severity unknown',
    reviewerReturn({ findings: [finding({ severity: 'unknown' })] }),
    { allowed: SEVERITIES, code: 'invalid_value', path: 'findings.0.severity' },
  ),
  schemaProbe(
    'severity high',
    reviewerReturn({ findings: [finding({ severity: 'high' })] }),
    { allowed: SEVERITIES, code: 'invalid_value', path: 'findings.0.severity' },
  ),
  schemaProbe(
    'absolute file path',
    reviewerReturn({
      findings: [finding({ file: '/home/runner/work/repo/src/example.ts' })],
    }),
    { code: 'invalid_format', path: 'findings.0.file' },
  ),
  schemaProbe(
    'evidence entry starts with an absolute path',
    reviewerReturn({
      findings: [
        finding({ evidence: ['/home/runner/work/repo/a.ts:1 fails'] }),
      ],
    }),
    { code: 'invalid_format', path: 'findings.0.evidence.0' },
  ),
  schemaProbe(
    'six evidence entries',
    reviewerReturn({
      findings: [
        finding({ evidence: Array.from({ length: 6 }, () => 'a.ts:1') }),
      ],
    }),
    { code: 'too_big', path: 'findings.0.evidence' },
  ),
  schemaProbe(
    'evidence entry of 501 characters',
    reviewerReturn({ findings: [finding({ evidence: ['x'.repeat(501)] })] }),
    { code: 'too_big', path: 'findings.0.evidence.0' },
  ),
  schemaProbe(
    'evidence as a plain string',
    reviewerReturn({ findings: [finding({ evidence: 'a.ts:1 fails' })] }),
    { code: 'invalid_type', path: 'findings.0.evidence' },
    { issueCount: 2 },
  ),
  schemaProbe(
    'extra top-level key',
    reviewerReturn({ selection_surface: ['src/example.ts'] }),
    { code: 'unrecognized_keys', path: '$' },
  ),
  schemaProbe(
    'extra top-level key with empty findings',
    reviewerReturn({ findings: [], selection_surface: ['src/example.ts'] }),
    { code: 'unrecognized_keys', path: '$' },
    { summaryRow: false },
  ),
  schemaProbe(
    'residual_risks entries are objects',
    reviewerReturn({ residual_risks: [{ note: 'x' }] }),
    { code: 'invalid_type', path: 'residual_risks.0' },
  ),
  schemaProbe(
    'residual_risks entry of 1025 characters',
    reviewerReturn({ residual_risks: ['x'.repeat(1025)] }),
    { code: 'too_big', path: 'residual_risks.0' },
  ),
  schemaProbe(
    'confidence as a percentage',
    reviewerReturn({ findings: [finding({ confidence: 85 })] }),
    { code: 'too_big', path: 'findings.0.confidence' },
  ),
  schemaProbe(
    'line as a string',
    reviewerReturn({ findings: [finding({ line: '3' })] }),
    { code: 'invalid_type', path: 'findings.0.line' },
  ),
  schemaProbe(
    'line zero',
    reviewerReturn({ findings: [finding({ line: 0 })] }),
    { code: 'too_small', path: 'findings.0.line' },
  ),
  schemaProbe(
    'title of 257 characters',
    reviewerReturn({ findings: [finding({ title: 'x'.repeat(257) })] }),
    { code: 'too_big', path: 'findings.0.title' },
  ),
  schemaProbe(
    'why_it_matters missing',
    reviewerReturn({ findings: [finding({}, ['why_it_matters'])] }),
    { code: 'invalid_type', path: 'findings.0.why_it_matters' },
  ),
  schemaProbe(
    'suggested_fix of 2049 characters',
    reviewerReturn({
      findings: [finding({ suggested_fix: 'x'.repeat(2049) })],
    }),
    { code: 'too_big', path: 'findings.0.suggested_fix' },
  ),
  schemaProbe(
    'residual_risks missing',
    reviewerReturn({}, ['residual_risks']),
    { code: 'invalid_type', path: 'residual_risks' },
  ),
  schemaProbe(
    'findings missing',
    reviewerReturn({}, ['findings']),
    { code: 'invalid_type', path: 'findings' },
    { summaryRow: false },
  ),
  schemaProbe(
    'findings is an object',
    reviewerReturn({ findings: {} }),
    { code: 'invalid_type', path: 'findings' },
    { summaryRow: false },
  ),
  schemaProbe(
    'thirty-three findings',
    reviewerReturn({
      findings: Array.from({ length: 33 }, () => finding()),
    }),
    { code: 'too_big', path: 'findings' },
    { summaryRow: false },
  ),
  schemaProbe(
    'the payload is an array',
    [],
    { code: 'invalid_type', path: '$' },
    { summaryRow: false },
  ),
  {
    expected: {
      code: 'identity_mismatch',
      kind: 'rejected',
      summaryRow: true,
    },
    input: reviewerReturn({ reviewer: 'security' }),
    name: 'reviewer names another persona',
  },
  {
    expected: {
      code: 'identity_mismatch',
      kind: 'rejected',
      summaryRow: false,
    },
    input: reviewerReturn({ findings: [], reviewer: 'security' }),
    name: 'reviewer names another persona with empty findings',
  },
  malformedJsonProbe('code-fenced JSON', `\`\`\`json\n${VALID_TEXT}\n\`\`\``),
  malformedJsonProbe(
    'prose before the JSON',
    `Here is my review:\n${VALID_TEXT}`,
  ),
  malformedJsonProbe(
    'task_result wrapper',
    `<task_result>\n${VALID_TEXT}\n</task_result>`,
  ),
  malformedJsonProbe('trailing comma', VALID_TEXT.replace(/\}$/, ',}')),
  malformedJsonProbe(
    'truncated JSON',
    '{ "reviewer": "correctness", "findings": [',
  ),
]

/** The stdin bytes for a probe: raw text as given, any other value as JSON. */
export function probeStdin(probe: ScreenProbe): string {
  return typeof probe.input === 'string'
    ? probe.input
    : JSON.stringify(probe.input)
}
