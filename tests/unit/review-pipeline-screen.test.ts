import { describe, expect, test } from 'bun:test'
import { screenReviewReturn } from '../../src/lib/review-pipeline.js'

interface RawFindingOverrides {
  readonly [key: string]: unknown
}

function makeFinding(
  overrides: RawFindingOverrides = {},
): Record<string, unknown> {
  return {
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
    ...overrides,
  }
}

function makeReturn(
  overrides: RawFindingOverrides = {},
): Record<string, unknown> {
  return {
    findings: [makeFinding()],
    residual_risks: [],
    reviewer: 'correctness',
    testing_gaps: [],
    ...overrides,
  }
}

const EMPTY_ENV: Readonly<Record<string, string>> = {}

describe('screenReviewReturn', () => {
  test('admits a conforming return', () => {
    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: makeReturn() },
      EMPTY_ENV,
    )

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.admitted_findings[0]?.input_id).toBe('correctness#0')
    expect(result.admitted_findings[0]?.disposition).toBe('surviving')
    expect(result.rejected_summary).toBeUndefined()
  })

  test('admits an empty return with no findings', () => {
    const result = screenReviewReturn(
      {
        expected_reviewer: 'correctness',
        raw_return: makeReturn({ findings: [] }),
      },
      EMPTY_ENV,
    )

    expect(result.dispatch_outcome).toBe('empty')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a malformed-JSON raw return', () => {
    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: '{not json' },
      EMPTY_ENV,
    )

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.rejected_summary?.reason).toContain('malformed JSON')
    expect(result.residual_risks).toEqual([])
    expect(result.testing_gaps).toEqual([])
  })

  test('rejects a return that fails schema validation', () => {
    const result = screenReviewReturn(
      {
        expected_reviewer: 'correctness',
        raw_return: { findings: [], reviewer: 'correctness' }, // missing required arrays
      },
      EMPTY_ENV,
    )

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.reason).toContain('schema validation')
  })

  test('rejects a reviewer-identity mismatch', () => {
    const result = screenReviewReturn(
      {
        expected_reviewer: 'security',
        raw_return: makeReturn({ reviewer: 'correctness' }),
      },
      EMPTY_ENV,
    )

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.reason).toContain('schema validation')
    expect(result.rejected_summary?.reason).toContain('field reviewer')
  })

  test('drops one offending finding while clean siblings keep their original indices', () => {
    const env = { API_TOKEN: 'sk-live-abcdef1234567890' }
    const raw = makeReturn({
      findings: [
        makeFinding({ title: 'Finding zero' }),
        makeFinding({
          title: 'Finding one',
          why_it_matters: 'Leaks sk-live-abcdef1234567890 in a log line.',
        }),
        makeFinding({ title: 'Finding two' }),
      ],
    })

    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: raw },
      env,
    )

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(2)
    const ids = result.admitted_findings.map((finding) => finding.input_id)
    expect(ids).toEqual(['correctness#0', 'correctness#2'])
    expect(result.rejected_summary?.rejected_finding_count).toBe(1)
    expect(result.rejected_summary?.reason).toContain(
      'environment-value detection',
    )
  })

  test('rejects the whole payload when the match sits outside any finding', () => {
    const env = { API_TOKEN: 'sk-live-abcdef1234567890' }
    const raw = makeReturn({
      testing_gaps: ['No coverage for sk-live-abcdef1234567890 rotation.'],
    })

    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: raw },
      env,
    )

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.residual_risks).toEqual([])
    expect(result.testing_gaps).toEqual([])
    expect(result.rejected_summary?.reason).toContain(
      'environment-value detection',
    )
  })

  test('does not match a short common environment value (false-positive guard)', () => {
    const env = { NODE_ENV: 'production' }
    const raw = makeReturn({
      findings: [
        makeFinding({
          why_it_matters: 'This runs fine in production and in staging.',
        }),
      ],
    })

    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: raw },
      env,
    )

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.rejected_summary).toBeUndefined()
  })

  test('matches a secret-named variable below the 16-char threshold', () => {
    const env = { DB_PASSWORD: 'abc123' }
    const raw = makeReturn({
      findings: [
        makeFinding({
          why_it_matters: 'The config hardcodes abc123 as a fallback.',
        }),
      ],
    })

    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: raw },
      env,
    )

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.rejected_summary?.rejected_finding_count).toBe(1)
  })

  test('does not match a long value composed solely of digits/dots/dashes/slashes', () => {
    const env = { REQUEST_ID: '2026-09-12-000000000001-000000000002' }
    const raw = makeReturn({
      findings: [
        makeFinding({
          why_it_matters:
            'The trace for 2026-09-12-000000000001-000000000002 is missing.',
        }),
      ],
    })

    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: raw },
      env,
    )

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.rejected_summary).toBeUndefined()
  })

  describe('structural detectors', () => {
    const cases: readonly [string, string][] = [
      ['$NAME shape', 'Command runs with $SECRET_TOKEN set in the shell.'],
      [
        'dollar-brace-NAME shape',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${NAME} syntax is the structural detector shape under test; a template string would evaluate it away.
        'Command runs with ${SECRET_TOKEN} interpolated.',
      ],
      ['process.env.NAME shape', 'Reads process.env.SECRET_TOKEN at startup.'],
      ['os.environ[...] shape', "Reads os.environ['SECRET_TOKEN'] at startup."],
      ['NAME=value assignment shape', 'Sets SECRET_TOKEN=xyz in the script.'],
    ]

    for (const [label, whyItMatters] of cases) {
      test(`matches the ${label}`, () => {
        const env = { SECRET_TOKEN: 'unused-value-not-embedded' }
        const raw = makeReturn({
          findings: [makeFinding({ why_it_matters: whyItMatters })],
        })

        const result = screenReviewReturn(
          { expected_reviewer: 'correctness', raw_return: raw },
          env,
        )

        expect(result.admitted_findings).toHaveLength(0)
        expect(result.rejected_summary?.rejected_finding_count).toBe(1)
      })
    }
  })

  test('never echoes the matched value or the variable name in diagnostics', () => {
    const env = { MY_SUPER_SECRET_KEY: 'hunter2-hunter2-hunter2-value' }
    const raw = makeReturn({
      findings: [
        makeFinding({
          why_it_matters:
            'Leaks hunter2-hunter2-hunter2-value directly in the response body.',
        }),
      ],
    })

    const result = screenReviewReturn(
      { expected_reviewer: 'correctness', raw_return: raw },
      env,
    )

    const reason = result.rejected_summary?.reason ?? ''
    expect(reason.length).toBeGreaterThan(0)
    expect(reason).not.toContain('hunter2-hunter2-hunter2-value')
    expect(reason).not.toContain('MY_SUPER_SECRET_KEY')
  })
})
