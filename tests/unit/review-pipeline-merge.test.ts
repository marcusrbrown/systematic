import { describe, expect, test } from 'bun:test'
import type {
  PrepareOutput,
  ValidateAdjudicationResult,
} from '../../src/lib/review-pipeline.js'
import { validateAdjudication } from '../../src/lib/review-pipeline.js'

type Decision = Parameters<typeof validateAdjudication>[1][number]
type CandidateGroup = PrepareOutput['candidate_groups'][number]

function mergedDecision(
  overrides: Partial<Record<string, unknown>> = {},
): Decision {
  return {
    decision_id: 'merge-1',
    disposition: 'merged',
    evidence: ['src/x.ts:5 shows both reviewers flagged the same defect.'],
    input_finding_ids: ['correctness#0', 'security#0'],
    line: 5,
    suggested_fix: 'Apply the shared fix once.',
    title: 'Duplicate finding across reviewers',
    why_it_matters: 'Both reviewers independently caught the same defect.',
    ...overrides,
  } as Decision
}

function declinedDecision(
  decisionId: string,
  inputFindingId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Decision {
  return {
    decision_id: decisionId,
    declined_reason: 'Not corroborated by another reviewer.',
    disposition: 'declined',
    input_finding_id: inputFindingId,
    ...overrides,
  } as Decision
}

function group(
  file: string,
  members: { readonly input_id: string; readonly line: number }[],
): CandidateGroup {
  return { file, members: [...members] }
}

function prepared(
  candidateGroups: CandidateGroup[],
  options: {
    readonly singletons?: readonly string[]
    readonly suppressed?: readonly string[]
  } = {},
): PrepareOutput {
  return {
    candidate_groups: [...candidateGroups],
    confidence_dispositions: (options.suppressed ?? []).map((inputId) => ({
      confidence: 0.4,
      disposition: 'suppressed' as const,
      input_id: inputId,
      reason: 'confidence below gate threshold',
    })),
    coverage_union: [],
    singletons: [...(options.singletons ?? [])],
  }
}

function expectRejection(
  result: ValidateAdjudicationResult,
  reason: string,
  path: string,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.rejection.reason as string).toBe(reason)
  expect(result.rejection.path).toBe(path)
  // No partial output escapes, and the diagnostic carries no payload content:
  // only the fixed reason code and a structural JSON path.
  expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
  expect(result.rejection.path).not.toMatch(/[A-Z][a-z]+ [a-z]+/) // no prose/title text
  expect('value' in result).toBe(false)
}

describe('validateAdjudication', () => {
  test('accepts a valid partition of one merge and one declined singleton', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
      group('src/b.ts', [
        { input_id: 'correctness#1', line: 20 },
        { input_id: 'security#1', line: 22 },
      ]),
    ]
    const decisions: Decision[] = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
      declinedDecision('decline-1', 'correctness#1'),
      declinedDecision('decline-2', 'security#1'),
    ]

    const result = validateAdjudication(
      prepared(groups, { singletons: ['correctness#2'] }),
      decisions,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.merged).toHaveLength(1)
    expect(result.value.merged[0]?.decision.decision_id).toBe('merge-1')
    expect(result.value.merged[0]?.file).toBe('src/a.ts')
    expect(result.value.declined).toHaveLength(2)
    expect(
      result.value.declined.map((entry) => entry.decision.decision_id),
    ).toEqual(['decline-1', 'decline-2'])
    expect(result.value.singletons).toEqual(['correctness#2'])
  })

  test('accepts zero candidate groups with an empty decision set, passing singletons through', () => {
    const result = validateAdjudication(
      prepared([], { singletons: ['x#0', 'x#1'] }),
      [],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.merged).toEqual([])
    expect(result.value.declined).toEqual([])
    expect(result.value.singletons).toEqual(['x#0', 'x#1'])
  })

  test('permuting decision order yields byte-identical output', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
      group('src/b.ts', [
        { input_id: 'correctness#1', line: 20 },
        { input_id: 'security#1', line: 22 },
      ]),
    ]
    const decisions: Decision[] = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
      declinedDecision('decline-1', 'correctness#1'),
      declinedDecision('decline-2', 'security#1'),
    ]

    const forward = validateAdjudication(prepared(groups), decisions)
    const reversed = validateAdjudication(
      prepared(groups),
      [...decisions].reverse(),
    )

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed))
  })

  test('rejects an input ID that does not exist in the prepared state (case 1)', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const result = validateAdjudication(prepared(groups), [
      declinedDecision('decline-1', 'unknown#0'),
    ])
    expectRejection(result, 'unknown input id', 'decisions.0.input_finding_id')
  })

  test('rejects an input ID the confidence gate suppressed (case 2)', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const result = validateAdjudication(
      prepared(groups, { suppressed: ['low-conf#0'] }),
      [declinedDecision('decline-1', 'low-conf#0')],
    )
    expectRejection(
      result,
      'suppressed input id',
      'decisions.0.input_finding_id',
    )
  })

  test('rejects an input ID cited by two different decisions (case 3)', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const result = validateAdjudication(prepared(groups), [
      declinedDecision('decline-1', 'correctness#0'),
      declinedDecision('decline-2', 'correctness#0'),
    ])
    expectRejection(
      result,
      'duplicate input id citation',
      'decisions.1.input_finding_id',
    )
  })

  test('rejects an eligible input ID omitted from every decision (case 4)', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const result = validateAdjudication(prepared(groups), [
      declinedDecision('decline-1', 'correctness#0'),
    ])
    expectRejection(
      result,
      'omitted eligible input id',
      'candidate_groups.0.members.1.input_id',
    )
  })

  test('rejects an input ID cited by a decision belonging to a different candidate group (case 5)', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
      group('src/b.ts', [
        { input_id: 'correctness#1', line: 20 },
        { input_id: 'security#1', line: 22 },
      ]),
    ]
    const result = validateAdjudication(prepared(groups), [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'correctness#1'],
        line: 10,
      }),
      declinedDecision('decline-1', 'security#0'),
      declinedDecision('decline-2', 'security#1'),
    ])
    expectRejection(
      result,
      'cross-group input id citation',
      'decisions.0.input_finding_ids.1',
    )
  })

  test('rejects a representative line that is not one of the group members lines (case 6)', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const result = validateAdjudication(prepared(groups), [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 999,
      }),
    ])
    expectRejection(result, 'representative line mismatch', 'decisions.0.line')
  })

  test('rejects a non-empty decision set when there are no candidate groups (case 7)', () => {
    const result = validateAdjudication(prepared([]), [
      declinedDecision('decline-1', 'correctness#0'),
    ])
    expectRejection(
      result,
      'unexpected decisions for empty candidate set',
      'decisions',
    )
  })
})
