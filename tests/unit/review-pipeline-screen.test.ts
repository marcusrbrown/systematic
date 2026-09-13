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

describe('screenReviewReturn', () => {
  test('admits a conforming return', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: makeReturn(),
    })

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.admitted_findings[0]?.input_id).toBe('correctness#0')
    expect(result.admitted_findings[0]?.disposition).toBe('surviving')
    expect(result.rejected_summary).toBeUndefined()
  })

  test('admits an empty return with no findings', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: makeReturn({ findings: [] }),
    })

    expect(result.dispatch_outcome).toBe('empty')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a malformed-JSON raw return', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: '{not json',
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.rejected_summary?.reason).toContain('malformed JSON')
    expect(result.residual_risks).toEqual([])
    expect(result.testing_gaps).toEqual([])
  })

  test('rejects a return that fails schema validation', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: { findings: [], reviewer: 'correctness' }, // missing required arrays
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.reason).toContain('schema validation')
  })

  test('rejects a reviewer-identity mismatch', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'security',
      raw_return: makeReturn({ reviewer: 'correctness' }),
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.reason).toContain('schema validation')
    expect(result.rejected_summary?.reason).toContain('field reviewer')
  })

  test('admission is byte-identical regardless of the process environment', () => {
    const raw = makeReturn({
      findings: [
        makeFinding({
          severity: 'P1',
          why_it_matters:
            'process.env.API_KEY is logged in plaintext at startup.',
        }),
      ],
    })

    const input = { expected_reviewer: 'correctness', raw_return: raw }
    const baseline = screenReviewReturn(input)

    const originalEnv = { ...process.env }
    try {
      process.env.KEYTIMEOUT = '1'
      process.env.SECURITYSESSIONID = '186b1'
      process.env.HIGH_ENTROPY_TOKEN = 'q7Z3xR9mK2pL8vN4wJ6tH1sF5dG0cB3yA'

      const polluted = screenReviewReturn(input)
      expect(polluted).toEqual(baseline)
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
      }
      Object.assign(process.env, originalEnv)
    }
  })

  test('admits a finding whose evidence legitimately quotes process.env.API_KEY', () => {
    const raw = makeReturn({
      findings: [
        makeFinding({
          evidence: [
            'src/config.ts:12 reads process.env.API_KEY without validation.',
          ],
          why_it_matters:
            'process.env.API_KEY is read directly instead of through the secrets manager.',
        }),
      ],
    })

    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: raw,
    })

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.rejected_summary).toBeUndefined()
  })

  test('admits a finding containing the digit 1', () => {
    const raw = makeReturn({
      findings: [
        makeFinding({
          severity: 'P1',
          why_it_matters: 'This is finding number 1 of 1 in this batch.',
        }),
      ],
    })

    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: raw,
    })

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.rejected_summary).toBeUndefined()
  })
})
