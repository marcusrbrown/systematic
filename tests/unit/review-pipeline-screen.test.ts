import { describe, expect, test } from 'bun:test'
import {
  rejectUnreadableScreenInput,
  screenReviewReturn,
  screenReviewReturnWithReport,
} from '../../src/lib/review-pipeline.js'
import { PROBE_REVIEWER, SCREEN_PROBES } from './screen-rejection-probes.js'

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
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
      raw_return: makeReturn({ findings: [] }),
    })

    expect(result.dispatch_outcome).toBe('empty')
    expect(result.admitted_findings).toHaveLength(0)
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a malformed-JSON raw return with no rejected-summary row (KTD21: unknowable count)', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
      raw_return: { findings: [], reviewer: 'correctness' }, // missing required arrays
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.rejected_summary).toBeUndefined()
  })

  test('rejects a return that fails schema validation and extracts mixed valid/invalid severities', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
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

    const input = {
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode' as const,
      raw_return: raw,
    }
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

    const input = {
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode' as const,
      raw_return: raw,
    }
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
      invoking_harness: 'opencode',
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
      invoking_harness: 'opencode',
      raw_return: raw,
    })

    expect(result.dispatch_outcome).toBe('findings')
    expect(result.admitted_findings).toHaveLength(1)
    expect(result.rejected_summary).toBeUndefined()
  })

  test.each(['opencode', 'pi', 'claude-code'] as const)(
    'echoes back the invoking harness %s on the result',
    (harness) => {
      const result = screenReviewReturn({
        expected_reviewer: 'correctness',
        invoking_harness: harness,
        raw_return: makeReturn(),
      })

      expect(result.harness).toBe(harness)
    },
  )

  test('echoes back the invoking harness on a whole-payload rejection', () => {
    const result = screenReviewReturn({
      expected_reviewer: 'correctness',
      invoking_harness: 'pi',
      raw_return: '{not json',
    })

    expect(result.dispatch_outcome).toBe('malformed')
    expect(result.harness).toBe('pi')
  })
})

// A planted value or key name must never reach a rejection report. Every
// string here is distinctive enough to be found by a substring search.
const PLANTED_KEY = 'zz_planted_key_name_91f3'
const PLANTED_VALUE = 'zz_planted_payload_value_77ab'

describe('screenReviewReturnWithReport', () => {
  test('reports every fault in one pass with its path, code and allowed values', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: makeReturn({
        findings: [makeFinding({ owner: 'author', severity: 'P4', line: 0 })],
      }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok) return
    expect(admission.rejection.code).toBe('schema_validation')
    if (admission.rejection.code !== 'schema_validation') return
    expect(admission.rejection.issue_count).toBe(3)
    expect(admission.rejection.omitted).toBe(0)
    expect(admission.rejection.issues).toEqual([
      {
        allowed: ['P0', 'P1', 'P2', 'P3'],
        code: 'invalid_value',
        path: 'findings.0.severity',
      },
      { code: 'too_small', path: 'findings.0.line' },
      {
        allowed: ['review-fixer', 'downstream-resolver', 'human', 'release'],
        code: 'invalid_value',
        path: 'findings.0.owner',
      },
    ])
  })

  test('caps the entries at eight and counts the rest as omitted', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: makeReturn({
        findings: Array.from({ length: 12 }, () =>
          makeFinding({ severity: 'high' }),
        ),
      }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok || admission.rejection.code !== 'schema_validation') return
    expect(admission.rejection.issue_count).toBe(12)
    expect(admission.rejection.issues).toHaveLength(8)
    expect(admission.rejection.omitted).toBe(4)
  })

  test('the rejected result is the same malformed result screenReviewReturn gives', () => {
    for (const probe of SCREEN_PROBES) {
      const input = {
        expected_reviewer: PROBE_REVIEWER,
        invoking_harness: 'opencode' as const,
        raw_return: probe.input,
      }
      const admission = screenReviewReturnWithReport(input)
      expect(admission.result, probe.name).toEqual(screenReviewReturn(input))
    }
  })

  describe.each(SCREEN_PROBES.map((probe) => [probe.name, probe] as const))(
    'probe: %s',
    (_name, probe) => {
      const admission = screenReviewReturnWithReport({
        expected_reviewer: PROBE_REVIEWER,
        invoking_harness: 'opencode',
        raw_return: probe.input,
      })

      test('is admitted or rejected as expected', () => {
        expect(admission.ok).toBe(probe.expected.kind === 'admitted')
      })

      test('reports the expected fixed code, count and first issue', () => {
        if (probe.expected.kind === 'admitted') return
        if (admission.ok) throw new Error('expected a rejection')
        expect(admission.rejection.code).toBe(probe.expected.code)
        if (probe.expected.code !== 'schema_validation') {
          // A fixed-code report carries the code and nothing else.
          expect(Object.keys(admission.rejection)).toEqual(['code'])
          return
        }
        if (admission.rejection.code !== 'schema_validation') {
          throw new Error('expected a schema_validation report')
        }
        expect(admission.rejection.issue_count).toBe(probe.expected.issueCount)
        expect(admission.rejection.issues[0]).toEqual(probe.expected.first)
      })

      test('produces a rejected summary only where the helper has a count', () => {
        if (probe.expected.kind === 'admitted') return
        expect(admission.result.rejected_summary !== undefined).toBe(
          probe.expected.summaryRow,
        )
      })
    },
  )

  test('a payload that is not an object reports the root path', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: '[1,2,3]',
    })

    expect(admission.ok).toBe(false)
    if (admission.ok || admission.rejection.code !== 'schema_validation') return
    expect(admission.rejection.issues).toEqual([
      { code: 'invalid_type', path: '$' },
    ])
  })

  test('an identity mismatch keeps the persisted reason and adds its code only to the report', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'security',
      invoking_harness: 'opencode',
      raw_return: makeReturn({ reviewer: 'correctness' }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok) return
    expect(admission.rejection).toEqual({ code: 'identity_mismatch' })
    expect(admission.result.rejected_summary?.reason).toBe(
      'Rejected persona security return: field reviewer failed schema validation.',
    )
    expect(JSON.stringify(admission.result)).not.toContain('identity_mismatch')
  })

  test('the persisted reason for a schema failure is unchanged', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: makeReturn({
        findings: [makeFinding({ severity: 'high' })],
      }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok) return
    expect(admission.result.rejected_summary?.reason).toBe(
      'Rejected persona correctness return: field findings.0.severity failed schema validation.',
    )
  })

  test('an admitted return has no rejection', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: makeReturn(),
    })

    expect(admission.ok).toBe(true)
    expect('rejection' in admission).toBe(false)
  })

  test('no report carries a planted key name, value or issue message', () => {
    const payloads: readonly unknown[] = [
      makeReturn({ [PLANTED_KEY]: PLANTED_VALUE }),
      makeReturn({
        findings: [makeFinding({ [PLANTED_KEY]: PLANTED_VALUE })],
      }),
      makeReturn({
        findings: [
          makeFinding({ owner: PLANTED_VALUE, severity: PLANTED_VALUE }),
        ],
      }),
      makeReturn({
        findings: [makeFinding({ file: `/${PLANTED_VALUE}`, title: 42 })],
        residual_risks: [{ [PLANTED_KEY]: PLANTED_VALUE }],
      }),
      makeReturn({ findings: [], [PLANTED_KEY]: PLANTED_VALUE }),
      makeReturn({ reviewer: PLANTED_VALUE }),
      { findings: PLANTED_VALUE, [PLANTED_KEY]: PLANTED_VALUE },
      `{ "${PLANTED_KEY}": "${PLANTED_VALUE}"`,
      `\`\`\`json\n{"${PLANTED_KEY}":"${PLANTED_VALUE}"}\n\`\`\``,
    ]

    for (const raw_return of payloads) {
      const admission = screenReviewReturnWithReport({
        expected_reviewer: 'correctness',
        invoking_harness: 'opencode',
        raw_return,
      })
      expect(admission.ok).toBe(false)
      if (admission.ok) continue
      const serialized = JSON.stringify(admission)
      expect(serialized).not.toContain(PLANTED_KEY)
      expect(serialized).not.toContain(PLANTED_VALUE)
    }
  })

  test('allowed values come only from the authored enums', () => {
    const admission = screenReviewReturnWithReport({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: makeReturn({
        findings: [
          makeFinding({
            autofix_class: PLANTED_VALUE,
            owner: PLANTED_VALUE,
            severity: PLANTED_VALUE,
          }),
        ],
      }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok || admission.rejection.code !== 'schema_validation') return
    const allowed = admission.rejection.issues.flatMap(
      (issue) => issue.allowed ?? [],
    )
    expect(allowed).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
      'safe_auto',
      'gated_auto',
      'manual',
      'advisory',
      'review-fixer',
      'downstream-resolver',
      'human',
      'release',
    ])
  })
})

describe('rejectUnreadableScreenInput', () => {
  test.each(['input_oversized', 'input_invalid_utf8'] as const)(
    '%s yields a malformed result with no rejected summary and a code-only report',
    (code) => {
      const admission = rejectUnreadableScreenInput({
        code,
        expected_reviewer: 'correctness',
        invoking_harness: 'pi',
      })

      expect(admission.ok).toBe(false)
      expect(admission.result.dispatch_outcome).toBe('malformed')
      expect(admission.result.harness).toBe('pi')
      expect(admission.result.rejected_summary).toBeUndefined()
      expect(admission.result.admitted_findings).toEqual([])
      expect(admission.rejection).toEqual({ code })
    },
  )
})
