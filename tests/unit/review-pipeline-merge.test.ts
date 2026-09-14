import { describe, expect, test } from 'bun:test'
import type {
  ApplyReviewAdjudicationResult,
  DeriveMergedFindingResult,
  MergeContributingFindings,
  MergedFindingModelDecision,
  PrepareOutput,
  ValidateAdjudicationResult,
} from '../../src/lib/review-pipeline.js'
import {
  applyReviewAdjudication,
  deriveMergedFindingFields,
  validateAdjudication,
} from '../../src/lib/review-pipeline.js'

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

/**
 * Builds a surviving admitted finding for the given stable input ID, inferring
 * its reviewer from the conventional `<reviewer>#<index>` fixture shape used
 * throughout this file's decisions and groups.
 */
function survivingFinding(
  inputId: string,
): PrepareOutput['surviving_findings'][number] {
  return {
    autofix_class: 'gated_auto',
    confidence: 0.85,
    disposition: 'surviving',
    evidence: ['src/example.ts:1 demonstrates the issue.'],
    file: 'src/example.ts',
    input_id: inputId,
    line: 1,
    owner: 'downstream-resolver',
    pre_existing: false,
    requires_verification: true,
    reviewer: inputId.split('#')[0] ?? inputId,
    severity: 'P1',
    suggested_fix: 'Apply the fix.',
    title: 'Example issue',
    why_it_matters: 'The example path can fail during normal execution.',
  }
}

function prepared(
  candidateGroups: CandidateGroup[],
  options: {
    readonly singletons?: readonly string[]
    readonly suppressed?: readonly string[]
  } = {},
): PrepareOutput {
  const survivingIds = [
    ...candidateGroups.flatMap((candidateGroup) =>
      candidateGroup.members.map((member) => member.input_id),
    ),
    ...(options.singletons ?? []),
  ]

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
    surviving_findings: survivingIds.map(survivingFinding),
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

type SurvivingFinding = PrepareOutput['surviving_findings'][number]

/**
 * Builds one contributing surviving finding, starting from `survivingFinding`
 * (the same fixture builder the `validateAdjudication` tests above use) and
 * layering on per-test overrides.
 */
function contributingFinding(
  inputId: string,
  overrides: Partial<SurvivingFinding> = {},
): SurvivingFinding {
  return { ...survivingFinding(inputId), ...overrides }
}

const DEFAULT_ROUTE = {
  autofix_class: 'gated_auto',
  owner: 'downstream-resolver',
  requires_verification: true,
} as const

function baseDecision(
  overrides: Partial<MergedFindingModelDecision> = {},
): MergedFindingModelDecision {
  return { line: 1, ...overrides }
}

function expectMergedFindingRejection(
  result: DeriveMergedFindingResult,
  reason: string,
  path: string,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.rejection.reason as string).toBe(reason)
  expect(result.rejection.path).toBe(path)
  expect(Object.keys(result.rejection).sort()).toEqual(['path', 'reason'])
  expect('value' in result).toBe(false)
}

describe('deriveMergedFindingFields', () => {
  test('a single-reviewer input gets no confidence boost', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { confidence: 0.85 }),
      contributingFinding('correctness#1', { confidence: 0.7 }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.submitters).toEqual(['correctness'])
    expect(result.value.confidence).toBe(0.85)
  })

  test('two distinct reviewers merge: submitters derived and sorted, +0.10 applied', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('security#0', { confidence: 0.85 }),
      contributingFinding('correctness#0', { confidence: 0.8 }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness', 'security'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.submitters).toEqual(['correctness', 'security'])
    expect(result.value.confidence).toBe(0.95)
  })

  test('the confidence boost caps at 1.0 rather than exceeding it', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('security#0', { confidence: 0.95 }),
      contributingFinding('correctness#0', { confidence: 0.9 }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness', 'security'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.confidence).toBe(1)
  })

  test('severity is the maximum among contributing inputs, not the first or last', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { severity: 'P2' }),
      contributingFinding('security#0', { severity: 'P0' }),
      contributingFinding('performance#0', { severity: 'P3' }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness', 'security', 'performance'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.severity).toBe('P0')
  })

  test('all-pre-existing contributing inputs yield pre_existing true', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { pre_existing: true }),
      contributingFinding('security#0', { pre_existing: true }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness', 'security'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pre_existing).toBe(true)
  })

  test('mixed pre_existing evidence yields pre_existing false (actionable)', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { pre_existing: true }),
      contributingFinding('security#0', { pre_existing: false }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness', 'security'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pre_existing).toBe(false)
  })

  test('a route-widening attempt is rejected', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { ...DEFAULT_ROUTE }),
      contributingFinding('security#0', { ...DEFAULT_ROUTE }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision({
        proposed_route: { ...DEFAULT_ROUTE, autofix_class: 'safe_auto' },
        route_narrowing_reason: 'Model attempted to widen the route.',
      }),
      returned_reviewers: ['correctness', 'security'],
    })

    expectMergedFindingRejection(result, 'route widening', 'proposed_route')
  })

  test('a route-narrowing attempt with a reason is accepted', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { ...DEFAULT_ROUTE }),
      contributingFinding('security#0', { ...DEFAULT_ROUTE }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision({
        proposed_route: { ...DEFAULT_ROUTE, autofix_class: 'manual' },
        route_narrowing_reason: 'Only a human should apply this fix.',
      }),
      returned_reviewers: ['correctness', 'security'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.route).toEqual({
      ...DEFAULT_ROUTE,
      autofix_class: 'manual',
    })
  })

  test('the meet route is used when the model proposes no narrowing', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', {
        ...DEFAULT_ROUTE,
        autofix_class: 'safe_auto',
      }),
      contributingFinding('security#0', {
        ...DEFAULT_ROUTE,
        autofix_class: 'manual',
      }),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision(),
      returned_reviewers: ['correctness', 'security'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The meet must be reachable by narrowing from both safe_auto and
    // manual; manual is the most permissive value that satisfies both.
    expect(result.value.route.autofix_class).toBe('manual')
  })

  test('agreement credit naming a reviewer with no return is rejected', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0'),
      contributingFinding('security#0'),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision({ eligible_agreement_credit: ['performance'] }),
      returned_reviewers: ['correctness', 'security'],
    })

    expectMergedFindingRejection(
      result,
      'agreement credit reviewer did not return',
      'eligible_agreement_credit.0',
    )
  })

  test('agreement credit duplicating an existing submitter is rejected', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0'),
      contributingFinding('security#0'),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision({ eligible_agreement_credit: ['correctness'] }),
      returned_reviewers: ['correctness', 'security'],
    })

    expectMergedFindingRejection(
      result,
      'agreement credit reviewer already a submitter',
      'eligible_agreement_credit.0',
    )
  })

  test('agreement credit duplicated within the claim itself is rejected', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0'),
      contributingFinding('security#0'),
    ]

    const result = deriveMergedFindingFields({
      contributing,
      decision: baseDecision({
        eligible_agreement_credit: ['performance', 'performance'],
      }),
      returned_reviewers: ['correctness', 'security', 'performance'],
    })

    expectMergedFindingRejection(
      result,
      'duplicate agreement credit reviewer',
      'eligible_agreement_credit.1',
    )
  })

  test('identical inputs produce an identical fingerprint', () => {
    const contributing: MergeContributingFindings = [
      contributingFinding('correctness#0', { file: 'src/example.ts' }),
      contributingFinding('security#0', { file: 'src/example.ts' }),
    ]
    const decision = baseDecision({ line: 7 })

    const first = deriveMergedFindingFields({
      contributing,
      decision,
      returned_reviewers: ['correctness', 'security'],
    })
    const second = deriveMergedFindingFields({
      contributing,
      decision,
      returned_reviewers: ['correctness', 'security'],
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.fingerprint).toBe(second.value.fingerprint)
  })

  test('a different normalized path produces a different fingerprint', () => {
    const contributingA: MergeContributingFindings = [
      contributingFinding('correctness#0', { file: 'src/a.ts' }),
      contributingFinding('security#0', { file: 'src/a.ts' }),
    ]
    const contributingB: MergeContributingFindings = [
      contributingFinding('correctness#0', { file: 'src/b.ts' }),
      contributingFinding('security#0', { file: 'src/b.ts' }),
    ]
    const decision = baseDecision({ line: 7 })

    const resultA = deriveMergedFindingFields({
      contributing: contributingA,
      decision,
      returned_reviewers: ['correctness', 'security'],
    })
    const resultB = deriveMergedFindingFields({
      contributing: contributingB,
      decision,
      returned_reviewers: ['correctness', 'security'],
    })

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    if (!resultA.ok || !resultB.ok) return
    expect(resultA.value.fingerprint).not.toBe(resultB.value.fingerprint)
  })
})

type ApplyDecision = Parameters<typeof applyReviewAdjudication>[0]['decisions']

function expectApplyRejection(
  result: ApplyReviewAdjudicationResult,
  reason: string,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.rejection.reason as string).toBe(reason)
  expect('value' in result).toBe(false)
}

/**
 * Builds a `PrepareOutput` directly from a fully custom set of surviving
 * findings, bypassing the `prepared()` fixture (which hardcodes every
 * finding's severity/confidence/file/line) so a test can control those
 * fields per finding.
 */
function preparedFromFindings(
  findings: PrepareOutput['surviving_findings'],
): PrepareOutput {
  return {
    candidate_groups: [],
    confidence_dispositions: findings.map((finding) => ({
      confidence: finding.confidence,
      disposition: 'surviving' as const,
      input_id: finding.input_id,
    })),
    coverage_union: [],
    singletons: findings.map((finding) => finding.input_id),
    surviving_findings: findings,
  }
}

describe('applyReviewAdjudication', () => {
  test('a partition of one merge plus declined singletons produces both, with the merged finding carrying derived fields and singletons passing through', () => {
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
    const decisions: ApplyDecision = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
      declinedDecision('decline-1', 'correctness#1'),
      declinedDecision('decline-2', 'security#1'),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['correctness#2'] }),
      decisions,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.merged_findings).toHaveLength(4)

    const merged = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'merge-1',
    )
    expect(merged).toBeDefined()
    expect(merged?.file).toBe('src/a.ts')
    expect(merged?.title).toBe('Duplicate finding across reviewers')
    expect(merged?.why_it_matters).toBe(
      'Both reviewers independently caught the same defect.',
    )
    expect(merged?.suggested_fix).toBe('Apply the shared fix once.')
    expect(merged?.line).toBe(10)
    expect(merged?.input_finding_ids).toEqual(['correctness#0', 'security#0'])
    // Two distinct submitters -- the confidence-agreement boost applies.
    expect(merged?.requires_verification).toBe(true)

    const declined = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'decline-1',
    )
    expect(declined).toBeDefined()
    expect(declined?.input_finding_ids).toEqual(['correctness#1'])
    expect(declined?.title).toBe('Example issue')

    const singleton = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'correctness#2',
    )
    expect(singleton).toBeDefined()
    expect(singleton?.input_finding_ids).toEqual(['correctness#2'])

    // The declined-separation reasons flow into the top-level disagreement
    // facts since `MergedFindingSchema` has no dedicated field for them.
    expect(result.value.disagreement_facts).toContain(
      'Not corroborated by another reviewer.',
    )
  })

  test('zero candidate groups with an empty decision set succeeds and passes every singleton through', () => {
    const result = applyReviewAdjudication({
      prepared: prepared([], { singletons: ['x#0', 'x#1'] }),
      decisions: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.merged_findings).toHaveLength(2)
    expect(
      result.value.merged_findings.map((finding) => finding.finding_id).sort(),
    ).toEqual(['x#0', 'x#1'])
    expect(
      result.value.merged_findings.every(
        (finding) => finding.input_finding_ids.length === 1,
      ),
    ).toBe(true)
  })

  test('a rejection from partition validation aborts with no partial output', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const decisions: ApplyDecision = [
      declinedDecision('decline-1', 'unknown#0'),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expectApplyRejection(result, 'unknown input id')
  })

  test('a rejection from field derivation aborts with no partial output', () => {
    // Exercised via an invalid `eligible_agreement_credit` claim -- a real
    // schema field independent of route narrowing -- to prove the same
    // whole-derivation-rejects-with-no-partial-output guarantee.
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const decisions: ApplyDecision = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 5,
        eligible_agreement_credit: ['performance'],
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expectApplyRejection(result, 'agreement credit reviewer did not return')
  })

  test('a narrowing proposed route with a reason flows through the wire envelope and is applied', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const decisions: ApplyDecision = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 5,
        proposed_route: { ...DEFAULT_ROUTE, autofix_class: 'manual' },
        route_narrowing_reason: 'Only a human should apply this fix.',
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const merged = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'merge-1',
    )
    expect(merged?.autofix_class).toBe('manual')
    expect(merged?.owner).toBe(DEFAULT_ROUTE.owner)
    expect(merged?.requires_verification).toBe(
      DEFAULT_ROUTE.requires_verification,
    )
  })

  test('a widening proposed route arriving through the wire envelope is rejected', () => {
    const groups = [
      group('src/x.ts', [
        { input_id: 'correctness#0', line: 5 },
        { input_id: 'security#0', line: 6 },
      ]),
    ]
    const decisions: ApplyDecision = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 5,
        proposed_route: { ...DEFAULT_ROUTE, autofix_class: 'safe_auto' },
        route_narrowing_reason: 'Model attempted to widen the route.',
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expectApplyRejection(result, 'route widening')
  })

  test('the validator request set contains exactly P0/P1 findings plus requires_verification findings, and nothing else', () => {
    const findings = [
      {
        ...survivingFinding('p0-low#0'),
        severity: 'P0' as const,
        requires_verification: false,
        confidence: 0.5,
      },
      {
        ...survivingFinding('p1-low#0'),
        severity: 'P1' as const,
        requires_verification: false,
        confidence: 0.6,
      },
      {
        ...survivingFinding('p2-verify#0'),
        severity: 'P2' as const,
        requires_verification: true,
        confidence: 0.7,
      },
      {
        ...survivingFinding('p2-plain#0'),
        severity: 'P2' as const,
        requires_verification: false,
        confidence: 0.8,
      },
    ]

    const result = applyReviewAdjudication({
      prepared: preparedFromFindings(findings),
      decisions: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.value.validator_requests
        .map((request) => request.finding_id)
        .sort(),
    ).toEqual(['p0-low#0', 'p1-low#0', 'p2-verify#0'])
    expect(
      result.value.validator_requests.some(
        (request) => request.finding_id === 'p2-plain#0',
      ),
    ).toBe(false)
  })

  test('findings come out sorted by severity, then confidence descending, then path, then line', () => {
    const findings = [
      {
        ...survivingFinding('alpha#0'),
        severity: 'P1' as const,
        confidence: 0.99,
        file: 'src/z.ts',
        line: 1,
      },
      {
        ...survivingFinding('beta#0'),
        severity: 'P0' as const,
        confidence: 0.5,
        file: 'src/a.ts',
        line: 1,
      },
      {
        ...survivingFinding('gamma#0'),
        severity: 'P0' as const,
        confidence: 0.5,
        file: 'src/a.ts',
        line: 9,
      },
    ]

    const result = applyReviewAdjudication({
      prepared: preparedFromFindings(findings),
      decisions: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // `beta` (P0) outranks `alpha` (P1) even with far lower confidence;
    // `gamma` shares beta's severity and confidence but sorts after it by
    // line, since both share the same path.
    expect(
      result.value.merged_findings.map((finding) => finding.finding_id),
    ).toEqual(['beta#0', 'gamma#0', 'alpha#0'])
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
    const decisions: ApplyDecision = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
      declinedDecision('decline-1', 'correctness#1'),
      declinedDecision('decline-2', 'security#1'),
    ]

    const forward = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['correctness#2'] }),
      decisions,
    })
    const reversed = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['correctness#2'] }),
      decisions: [...decisions].reverse(),
    })

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed))
  })
})
