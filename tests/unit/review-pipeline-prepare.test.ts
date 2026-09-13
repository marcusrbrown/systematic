import { describe, expect, test } from 'bun:test'
import { prepareReviewCandidates } from '../../src/lib/review-pipeline.js'
import { AGGREGATE_STDIN_BYTE_CAP } from '../../src/lib/review-pipeline-contract.js'

interface FindingOverrides {
  readonly [key: string]: unknown
}

function makeAdmittedFinding(
  overrides: FindingOverrides = {},
): Record<string, unknown> {
  return {
    autofix_class: 'gated_auto',
    confidence: 0.85,
    disposition: 'surviving',
    evidence: ['src/example.ts:42 demonstrates the failure path.'],
    file: 'src/example.ts',
    input_id: 'correctness#0',
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

function makeScreenResult(
  reviewer: string,
  findings: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    result: {
      admitted_findings: findings,
      dispatch_outcome: findings.length === 0 ? 'empty' : 'findings',
      residual_risks: [],
      testing_gaps: [],
    },
    reviewer,
  }
}

function makeSelectedDispatch(
  persona: string,
  overrides: FindingOverrides = {},
): Record<string, unknown> {
  return {
    dispatch_outcome: 'findings',
    persona,
    ...overrides,
  }
}

function buildInput(
  screenResults: readonly Record<string, unknown>[],
  selectedDispatches: readonly Record<string, unknown>[],
): { readonly raw_input: unknown } {
  return {
    raw_input: {
      screen_results: screenResults,
      selected_dispatches: selectedDispatches,
    },
  }
}

describe('prepareReviewCandidates -- confidence gate', () => {
  test('a P0 finding at exactly 0.50 confidence survives', () => {
    const finding = makeAdmittedFinding({
      confidence: 0.5,
      input_id: 'security#0',
      severity: 'P0',
    })
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('security', [finding])],
        [makeSelectedDispatch('security')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    const disposition = result.value.confidence_dispositions.find(
      (entry) => entry.input_id === 'security#0',
    )
    expect(disposition?.disposition).toBe('surviving')
  })

  test('a P0 finding at 0.49 confidence is suppressed', () => {
    const finding = makeAdmittedFinding({
      confidence: 0.49,
      input_id: 'security#0',
      severity: 'P0',
    })
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('security', [finding])],
        [makeSelectedDispatch('security')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    const disposition = result.value.confidence_dispositions.find(
      (entry) => entry.input_id === 'security#0',
    )
    expect(disposition?.disposition).toBe('suppressed')
  })

  test('a P1 finding at 0.59 confidence is suppressed', () => {
    const finding = makeAdmittedFinding({
      confidence: 0.59,
      input_id: 'correctness#0',
      severity: 'P1',
    })
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('correctness', [finding])],
        [makeSelectedDispatch('correctness')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    const disposition = result.value.confidence_dispositions.find(
      (entry) => entry.input_id === 'correctness#0',
    )
    expect(disposition?.disposition).toBe('suppressed')
  })

  test('a P1 finding at 0.60 confidence survives', () => {
    const finding = makeAdmittedFinding({
      confidence: 0.6,
      input_id: 'correctness#0',
      severity: 'P1',
    })
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('correctness', [finding])],
        [makeSelectedDispatch('correctness')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    const disposition = result.value.confidence_dispositions.find(
      (entry) => entry.input_id === 'correctness#0',
    )
    expect(disposition?.disposition).toBe('surviving')
  })

  test('every suppressed finding carries a fixed reason, regardless of its original confidence', () => {
    const lowConfidence = makeAdmittedFinding({
      confidence: 0.1,
      input_id: 'correctness#0',
      severity: 'P2',
    })
    const nearMiss = makeAdmittedFinding({
      confidence: 0.59,
      input_id: 'correctness#1',
      severity: 'P1',
    })
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('correctness', [lowConfidence, nearMiss])],
        [makeSelectedDispatch('correctness')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    const suppressed = result.value.confidence_dispositions.filter(
      (entry) => entry.disposition === 'suppressed',
    )
    expect(suppressed).toHaveLength(2)
    expect(suppressed[0]?.reason).toBeDefined()
    expect(suppressed[0]?.reason).toBe(suppressed[1]?.reason)
  })
})

describe('prepareReviewCandidates -- candidate grouping', () => {
  test('two personas reporting different defects on the same line form a candidate group with both findings intact', () => {
    const findingA = makeAdmittedFinding({
      input_id: 'correctness#0',
      line: 10,
      title: 'Off-by-one in loop bound',
    })
    const findingB = makeAdmittedFinding({
      input_id: 'security#0',
      line: 10,
      title: 'Unvalidated input reaches a sink',
    })
    const result = prepareReviewCandidates(
      buildInput(
        [
          makeScreenResult('correctness', [findingA]),
          makeScreenResult('security', [findingB]),
        ],
        [makeSelectedDispatch('correctness'), makeSelectedDispatch('security')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.value.candidate_groups).toHaveLength(1)
    const group = result.value.candidate_groups[0]
    expect(group?.file).toBe('src/example.ts')
    expect(group?.input_finding_ids).toEqual(['correctness#0', 'security#0'])
    expect(result.value.singletons).toEqual([])
  })

  test('several findings from a single persona on one file do not form a candidate group', () => {
    const findingA = makeAdmittedFinding({ input_id: 'correctness#0', line: 5 })
    const findingB = makeAdmittedFinding({
      input_id: 'correctness#1',
      line: 15,
    })
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('correctness', [findingA, findingB])],
        [makeSelectedDispatch('correctness')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.value.candidate_groups).toEqual([])
    expect(result.value.singletons).toEqual(['correctness#0', 'correctness#1'])
  })

  test('grouping is by normalized path: paths differing only in normalizable form land in the same group', () => {
    const findingA = makeAdmittedFinding({
      file: 'src/example.ts',
      input_id: 'correctness#0',
      line: 10,
    })
    const findingB = makeAdmittedFinding({
      file: './src/example.ts',
      input_id: 'security#0',
      line: 20,
    })
    const result = prepareReviewCandidates(
      buildInput(
        [
          makeScreenResult('correctness', [findingA]),
          makeScreenResult('security', [findingB]),
        ],
        [makeSelectedDispatch('correctness'), makeSelectedDispatch('security')],
      ),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.value.candidate_groups).toHaveLength(1)
    expect(result.value.candidate_groups[0]?.file).toBe('src/example.ts')
  })
})

describe('prepareReviewCandidates -- determinism', () => {
  test('permuting the input order yields byte-identical output', () => {
    const correctnessFindingA = makeAdmittedFinding({
      confidence: 0.9,
      input_id: 'correctness#0',
      line: 3,
    })
    const correctnessFindingB = makeAdmittedFinding({
      confidence: 0.4,
      input_id: 'correctness#1',
      line: 9,
      severity: 'P2',
    })
    const securityFinding = makeAdmittedFinding({
      confidence: 0.95,
      input_id: 'security#0',
      line: 3,
      title: 'Unvalidated input reaches a sink',
    })

    const baseline = prepareReviewCandidates(
      buildInput(
        [
          makeScreenResult('correctness', [
            correctnessFindingA,
            correctnessFindingB,
          ]),
          makeScreenResult('security', [securityFinding]),
        ],
        [
          makeSelectedDispatch('correctness', {
            selection_surface: ['src/example.ts', 'src/other.ts'],
          }),
          makeSelectedDispatch('security', {
            selection_surface: ['src/other.ts', 'src/example.ts'],
          }),
        ],
      ),
    )

    const permuted = prepareReviewCandidates(
      buildInput(
        [
          makeScreenResult('security', [securityFinding]),
          makeScreenResult('correctness', [
            correctnessFindingB,
            correctnessFindingA,
          ]),
        ],
        [
          makeSelectedDispatch('security', {
            selection_surface: ['src/example.ts', 'src/other.ts'],
          }),
          makeSelectedDispatch('correctness', {
            selection_surface: ['src/other.ts', 'src/example.ts'],
          }),
        ],
      ),
    )

    expect(baseline.ok).toBe(true)
    expect(permuted.ok).toBe(true)
    expect(JSON.stringify(baseline)).toBe(JSON.stringify(permuted))
  })
})

describe('prepareReviewCandidates -- rejections', () => {
  test('rejects duplicate persona outcomes without leaking payload content', () => {
    const result = prepareReviewCandidates(
      buildInput(
        [
          makeScreenResult('correctness', [makeAdmittedFinding()]),
          makeScreenResult('correctness', [
            makeAdmittedFinding({ input_id: 'correctness#1' }),
          ]),
        ],
        [makeSelectedDispatch('correctness')],
      ),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe('duplicate persona outcome')
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
    expect(result.rejection.path).not.toContain('Example issue')
  })

  test('rejects duplicate input IDs without leaking payload content', () => {
    const result = prepareReviewCandidates(
      buildInput(
        [
          makeScreenResult('correctness', [
            makeAdmittedFinding({ input_id: 'shared#0' }),
          ]),
          makeScreenResult('security', [
            makeAdmittedFinding({ input_id: 'shared#0' }),
          ]),
        ],
        [makeSelectedDispatch('correctness'), makeSelectedDispatch('security')],
      ),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe('duplicate input id')
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
    expect(result.rejection.path).not.toContain('Example issue')
  })

  test('rejects a screen result for a persona that was not selected', () => {
    const result = prepareReviewCandidates(
      buildInput(
        [makeScreenResult('correctness', [makeAdmittedFinding()])],
        [makeSelectedDispatch('security')],
      ),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe('unselected persona screen result')
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
    expect(result.rejection.path).not.toContain('Example issue')
  })

  test('rejects a selected dispatch with no corresponding screen result', () => {
    const result = prepareReviewCandidates(
      buildInput([], [makeSelectedDispatch('correctness')]),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe(
      'missing screen result for selected dispatch',
    )
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
    expect(result.rejection.path).not.toContain('Example issue')
  })

  test('rejects an aggregate payload exceeding the byte cap without parsing it', () => {
    const oversized = 'x'.repeat(AGGREGATE_STDIN_BYTE_CAP + 1)
    const result = prepareReviewCandidates({ raw_input: oversized })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe('aggregate payload exceeds byte cap')
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
    expect(result.rejection.path).toBe('$')
  })

  test('rejects malformed JSON without leaking exception text', () => {
    const result = prepareReviewCandidates({ raw_input: '{not json' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe('malformed JSON')
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
  })

  test('rejects a payload that fails schema validation', () => {
    const result = prepareReviewCandidates(
      buildInput(
        [{ reviewer: 'correctness' }],
        [makeSelectedDispatch('correctness')],
      ),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.reason).toBe('schema validation')
    expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
  })
})
