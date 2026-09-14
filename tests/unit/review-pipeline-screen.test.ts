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

  test('rejects a malformed-JSON raw return with no rejected-summary row (KTD21: unknowable count)', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: '{not json',
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.admitted_findings).toHaveLength(0)
    // The finding count is genuinely unknowable for unparseable JSON, so no
    // rejected-summary row is created (never coerced from zero to one) and
    // no reason text escapes into the output.
    expect(result.rejected_summary).toBeUndefined()
    expect(result.residual_risks).toEqual([])
    expect(result.testing_gaps).toEqual([])
  })

  test('rejects a return that fails schema validation with zero known findings and no rejected-summary row', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: { findings: [], reviewer: 'correctness' }, // missing required arrays
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a return that fails schema validation and extracts mixed valid/invalid severities', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: {
        // Missing required residual_risks/testing_gaps arrays, so the whole
        // payload fails schema validation -- but its findings array is still
        // present, so severities are extracted defensively from it.
        findings: [
          makeFinding({ severity: 'P1' }),
          makeFinding({ severity: 'CRITICAL' }),
        ],
        reviewer: 'correctness',
      },
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.rejected_finding_count).toBe(2)
    expect(result.rejected_summary?.rejected_severities).toEqual([
      'P1',
      'unknown',
    ])
    // The offending 'CRITICAL' value itself never appears in the output.
    expect(JSON.stringify(result)).not.toContain('CRITICAL')
  })

  test('rejects a return that fails schema validation with every severity unrecognizable', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: {
        findings: [
          makeFinding({ severity: 'CRITICAL' }),
          makeFinding({ severity: 42 }),
        ],
        reviewer: 'correctness',
      },
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.rejected_finding_count).toBe(2)
    expect(result.rejected_summary?.rejected_severities).toEqual([
      'unknown',
      'unknown',
    ])
  })

  test('rejects a reviewer-identity mismatch and extracts the count and severities from valid findings', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'security',
      raw_return: makeReturn({ reviewer: 'correctness' }),
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.reason).toContain('schema validation')
    expect(result.rejected_summary?.reason).toContain('field reviewer')
    // makeReturn() defaults to one P1 finding, already schema-validated, so
    // the count and severity are exact -- not the old coerced-to-one value.
    expect(result.rejected_summary?.rejected_finding_count).toBe(1)
    expect(result.rejected_summary?.rejected_severities).toEqual(['P1'])
  })

  test('rejects an identity-mismatched empty return with no rejected-summary row (KTD21)', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'security',
      raw_return: makeReturn({ reviewer: 'correctness', findings: [] }),
    })

    expect(result.dispatch_outcome).toBe('malformed')
    // A determined count of zero still creates no rejected-summary row --
    // never coerced from zero to one.
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a return with more than MAX_FINDINGS findings with no rejected-summary row and does not throw', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: {
        // 33 findings, all valid shape except the last has an invalid
        // severity field, so the whole payload fails schema validation --
        // but the finding count exceeds MAX_FINDINGS (32), so it is
        // unrepresentable in a bounded rejected_summary.
        findings: [
          ...Array.from({ length: 32 }, () => makeFinding()),
          makeFinding({ severity: 'NOT_A_SEVERITY' }),
        ],
        residual_risks: [],
        reviewer: 'correctness',
      },
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.admitted_findings).toEqual([])
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a return with exactly MAX_FINDINGS findings and emits a rejected-summary row with the full count', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      raw_return: {
        // 32 findings, all valid shape but missing required top-level
        // residual_risks/testing_gaps arrays, so the whole payload fails
        // schema validation while staying at the MAX_FINDINGS bound.
        findings: Array.from({ length: 32 }, () => makeFinding()),
        reviewer: 'correctness',
      },
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary?.rejected_finding_count).toBe(32)
    expect(result.rejected_summary?.rejected_severities).toHaveLength(32)
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

  test('rejection with rejected-severity extraction is byte-identical regardless of the process environment', () => {
    const raw = {
      findings: [
        makeFinding({ severity: 'P1' }),
        makeFinding({ severity: 'BOGUS' }),
      ],
      reviewer: 'correctness',
    }

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
