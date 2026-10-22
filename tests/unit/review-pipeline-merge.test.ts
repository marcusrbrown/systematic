import { describe, expect, test } from 'bun:test'
import {
  MAX_RUN_DISAGREEMENT_FACTS,
  MAX_RUN_FINDINGS,
} from '../../src/lib/review-artifact-schema.js'
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
import { MergeOutputSchema } from '../../src/lib/review-pipeline-contract.js'
import {
  declineEveryGroupMember,
  mergeEveryGroup,
  type PipelineFindingSpec,
  type PipelineRun,
  runPipeline,
} from './review-run-fixtures.js'

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
  expect(Object.keys(result.rejection).sort()).toEqual([
    'kind',
    'path',
    'reason',
  ])
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
  expect(Object.keys(result.rejection).sort()).toEqual([
    'kind',
    'path',
    'reason',
  ])
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
    expect(merged?.route_narrowing_reason).toBe(
      'Only a human should apply this fix.',
    )
  })

  test('a narrowing proposed route equal to the meet carries no route_narrowing_reason when the model proposes none', () => {
    // `assembleMergedGroupFinding` only carries `route_narrowing_reason` onto
    // the wire when `deriveRoute` reports the resolved route actually
    // differs from the meet (`DerivedMergedFindingFields.route_differs_from_meet`)
    // -- never merely because the decision set `proposed_route`. This case
    // has no `proposed_route` at all, so the resolved route is the meet
    // itself and no reason is ever in play, but the fix that carries
    // reasons conditionally is the same either way (see the KTD24
    // identity-proposal regression tests in review-pipeline-finalize.test.ts
    // for the case where `proposed_route` *is* set but equals the meet).
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
    expect('route_narrowing_reason' in (merged ?? {})).toBe(false)
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

  test('every carried mechanical field (severity, confidence, pre_existing, fingerprint, submitters) is present on both merged groups and singletons', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 10 },
      ]),
    ]
    const decisions: ApplyDecision = [
      mergedDecision({
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['correctness#1'] }),
      decisions,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const merged = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'merge-1',
    )
    expect(merged?.severity).toBe('P1')
    expect(merged?.confidence).toBeGreaterThan(0)
    expect(merged?.pre_existing).toBe(false)
    // Fingerprint derives from the contributing finding's own file
    // ('src/example.ts', the `survivingFinding` fixture default), not the
    // candidate group's nominal file ('src/a.ts').
    expect(merged?.fingerprint).toBe('src/example.ts:10:P1')
    // Two distinct submitters, sorted.
    expect(merged?.submitters).toEqual(['correctness', 'security'])

    const singleton = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'correctness#1',
    )
    expect(singleton?.severity).toBe('P1')
    expect(singleton?.confidence).toBeGreaterThan(0)
    expect(singleton?.pre_existing).toBe(false)
    expect(singleton?.fingerprint).toBe('src/example.ts:1:P1')
    expect(singleton?.submitters).toEqual(['correctness'])
  })

  test('pre_existing is true only when every contributing input is pre-existing', () => {
    const mixedZero = { ...survivingFinding('mixed#0'), pre_existing: true }
    const mixedOne = { ...survivingFinding('mixed#1'), pre_existing: false }
    const allPreFinding = {
      ...survivingFinding('all-pre#0'),
      pre_existing: true,
    }

    const customPrepared: PrepareOutput = {
      candidate_groups: [
        group('src/example.ts', [
          { input_id: 'mixed#0', line: 1 },
          { input_id: 'mixed#1', line: 1 },
        ]),
      ],
      confidence_dispositions: [mixedZero, mixedOne, allPreFinding].map(
        (finding) => ({
          confidence: finding.confidence,
          disposition: 'surviving' as const,
          input_id: finding.input_id,
        }),
      ),
      coverage_union: [],
      singletons: ['all-pre#0'],
      surviving_findings: [mixedZero, mixedOne, allPreFinding],
    }

    const result = applyReviewAdjudication({
      prepared: customPrepared,
      decisions: [
        mergedDecision({
          decision_id: 'merge-mixed',
          input_finding_ids: ['mixed#0', 'mixed#1'],
          line: 1,
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const mixed = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'merge-mixed',
    )
    expect(mixed?.pre_existing).toBe(false)

    const allPre = result.value.merged_findings.find(
      (finding) => finding.finding_id === 'all-pre#0',
    )
    expect(allPre?.pre_existing).toBe(true)
  })

  test('round-trips through the amended MergeOutputSchema', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 10 },
      ]),
    ]
    const result = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['correctness#1'] }),
      decisions: [
        mergedDecision({
          input_finding_ids: ['correctness#0', 'security#0'],
          line: 10,
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(MergeOutputSchema.safeParse(result.value).success).toBe(true)
  })

  test('two findings tied on severity, confidence, path, line, and fingerprint order deterministically by finding ID', () => {
    const findings = [
      { ...survivingFinding('zulu#0'), file: 'src/tied.ts', line: 5 },
      { ...survivingFinding('alpha#0'), file: 'src/tied.ts', line: 5 },
    ]

    const result = applyReviewAdjudication({
      prepared: preparedFromFindings(findings),
      decisions: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Both tie on every earlier key (same severity, confidence, path, line,
    // and therefore the same derived fingerprint) -- only the finding ID
    // breaks the tie, and 'alpha#0' sorts before 'zulu#0'.
    const [first, second] = result.value.merged_findings
    expect(first?.fingerprint).toBe(second?.fingerprint)
    expect(
      result.value.merged_findings.map((finding) => finding.finding_id),
    ).toEqual(['alpha#0', 'zulu#0'])
  })
})

describe('applyReviewAdjudication: duplicate/colliding assembled finding IDs', () => {
  test('a non-colliding control -- one merge group, one declined singleton, one passthrough singleton, all with distinct IDs -- still succeeds', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
    ]
    const decisions: ApplyDecision = [
      mergedDecision({
        decision_id: 'merge-control',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['passthrough-control#0'] }),
      decisions,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.value.merged_findings.map((finding) => finding.finding_id).sort(),
    ).toEqual(['merge-control', 'passthrough-control#0'])
  })

  test('two merge group decisions sharing a decision_id are rejected (duplicate merged group decision id)', () => {
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
        decision_id: 'dup-merge',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
      mergedDecision({
        decision_id: 'dup-merge',
        input_finding_ids: ['correctness#1', 'security#1'],
        line: 20,
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expectApplyRejection(result, 'duplicate merged group decision id')
  })

  test('two declined decisions sharing a decision_id are rejected (duplicate declined decision id)', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
    ]
    const decisions: ApplyDecision = [
      declinedDecision('dup-decline', 'correctness#0'),
      declinedDecision('dup-decline', 'security#0'),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expectApplyRejection(result, 'duplicate declined decision id')
  })

  test('a passthrough singletons array carrying a duplicate input ID is rejected (duplicate passthrough singleton input id)', () => {
    // `PrepareOutputSchema.singletons` (`review-pipeline-contract.ts`) is a
    // plain bounded array with no uniqueness refinement, so a duplicate
    // reaches `applyReviewAdjudication` unfiltered.
    const result = applyReviewAdjudication({
      prepared: prepared([], { singletons: ['dup#0', 'dup#0'] }),
      decisions: [],
    })

    expectApplyRejection(result, 'duplicate passthrough singleton input id')
  })

  test('a declined decision_id colliding with a merge group decision_id is rejected (declined decision id collides with merged group decision id)', () => {
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
        decision_id: 'collide',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
      declinedDecision('collide', 'correctness#1'),
      declinedDecision('other', 'security#1'),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups),
      decisions,
    })

    expectApplyRejection(
      result,
      'declined decision id collides with merged group decision id',
    )
  })

  test('a declined decision_id colliding with a passthrough singleton input_id is rejected (declined decision id collides with passthrough singleton input id)', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
    ]
    const decisions: ApplyDecision = [
      declinedDecision('d1', 'correctness#0'),
      declinedDecision('collide', 'security#0'),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['collide'] }),
      decisions,
    })

    expectApplyRejection(
      result,
      'declined decision id collides with passthrough singleton input id',
    )
  })

  test('a passthrough singleton input_id colliding with a merge group decision_id is rejected (passthrough singleton input id collides with merged group decision id)', () => {
    const groups = [
      group('src/a.ts', [
        { input_id: 'correctness#0', line: 10 },
        { input_id: 'security#0', line: 12 },
      ]),
    ]
    const decisions: ApplyDecision = [
      mergedDecision({
        decision_id: 'collide',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 10,
      }),
    ]

    const result = applyReviewAdjudication({
      prepared: prepared(groups, { singletons: ['collide'] }),
      decisions,
    })

    expectApplyRejection(
      result,
      'passthrough singleton input id collides with merged group decision id',
    )
  })
})

describe('applyReviewAdjudication -- the prepared echo', () => {
  function expectNamedRejection(
    result: ApplyReviewAdjudicationResult,
    reason: string,
    path: string,
  ): void {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason as string).toBe(reason)
    expect(result.rejection.path).toBe(path)
    expect(Object.keys(result.rejection).sort()).toEqual([
      'kind',
      'path',
      'reason',
    ])
  }

  const GROUP = group('src/a.ts', [
    { input_id: 'correctness#0', line: 10 },
    { input_id: 'security#0', line: 12 },
  ])
  const DECLINE_BOTH: Decision[] = [
    declinedDecision('d0', 'correctness#0'),
    declinedDecision('d1', 'security#0'),
  ]

  test('an echo that drops a candidate-group member from the survivors is a named rejection, not a throw', () => {
    const echo = prepared([GROUP])
    const dropped: PrepareOutput = {
      ...echo,
      surviving_findings: echo.surviving_findings.filter(
        (finding) => finding.input_id !== 'security#0',
      ),
    }

    let result: ApplyReviewAdjudicationResult | undefined
    expect(() => {
      result = applyReviewAdjudication({
        prepared: dropped,
        decisions: DECLINE_BOTH,
      })
    }).not.toThrow()

    if (!result) throw new Error('expected a result')
    expectNamedRejection(
      result,
      'prepared survivor missing for input id',
      'candidate_groups.0.members.1.input_id',
    )
  })

  test('an echo that drops a singleton from the survivors is a named rejection, not a throw', () => {
    const echo = prepared([], { singletons: ['correctness#0', 'security#0'] })
    const dropped: PrepareOutput = {
      ...echo,
      surviving_findings: echo.surviving_findings.filter(
        (finding) => finding.input_id !== 'security#0',
      ),
    }

    let result: ApplyReviewAdjudicationResult | undefined
    expect(() => {
      result = applyReviewAdjudication({ prepared: dropped, decisions: [] })
    }).not.toThrow()

    if (!result) throw new Error('expected a result')
    expectNamedRejection(
      result,
      'prepared survivor missing for input id',
      'singletons.1',
    )
  })

  test('an echo whose singleton is also a candidate-group member is a named rejection', () => {
    const echo = prepared([GROUP], { singletons: ['correctness#0'] })

    const result = applyReviewAdjudication({
      prepared: {
        ...echo,
        surviving_findings: echo.surviving_findings.filter(
          (finding, index, all) =>
            all.findIndex((other) => other.input_id === finding.input_id) ===
            index,
        ),
      },
      decisions: DECLINE_BOTH,
    })

    expectNamedRejection(
      result,
      'singleton input id is also a candidate group member',
      'singletons.0',
    )
  })

  test('an echo with a duplicate singleton is a named rejection at the repeated entry', () => {
    const echo = prepared([], { singletons: ['dup#0', 'dup#0'] })

    const result = applyReviewAdjudication({
      prepared: {
        ...echo,
        surviving_findings: echo.surviving_findings.slice(0, 1),
      },
      decisions: [],
    })

    expectNamedRejection(
      result,
      'duplicate passthrough singleton input id',
      'singletons.1',
    )
  })

  const uniqueSurvivors = (echo: PrepareOutput) =>
    echo.surviving_findings.filter(
      (finding, index, all) =>
        all.findIndex((other) => other.input_id === finding.input_id) === index,
    )

  test('an echo that leaves a survivor out of every group and singleton is a named rejection at that survivor', () => {
    const echo = prepared([], { singletons: ['correctness#0', 'security#0'] })

    const result = applyReviewAdjudication({
      prepared: { ...echo, singletons: ['correctness#0'] },
      decisions: [],
    })

    expectNamedRejection(
      result,
      'prepared survivor missing from the partition',
      'surviving_findings.1.input_id',
    )
  })

  test('an echo that drops a group member from its group but keeps it as a survivor is a named rejection', () => {
    const echo = prepared([GROUP])

    const result = applyReviewAdjudication({
      prepared: {
        ...echo,
        candidate_groups: [{ ...GROUP, members: GROUP.members.slice(0, 1) }],
      },
      decisions: [declinedDecision('d0', 'correctness#0')],
    })

    expectNamedRejection(
      result,
      'prepared survivor missing from the partition',
      'surviving_findings.1.input_id',
    )
  })

  test('an echo that repeats a surviving finding input id is a named rejection at the repeated entry', () => {
    const echo = prepared([], { singletons: ['correctness#0'] })

    const result = applyReviewAdjudication({
      prepared: {
        ...echo,
        surviving_findings: [
          ...echo.surviving_findings,
          ...echo.surviving_findings,
        ],
      },
      decisions: [],
    })

    expectNamedRejection(
      result,
      'duplicate prepared survivor input id',
      'surviving_findings.1.input_id',
    )
  })

  test('an echo that lists a member twice in one group is a named rejection at the repeated entry', () => {
    const echo = prepared([GROUP])

    const result = applyReviewAdjudication({
      prepared: {
        ...echo,
        candidate_groups: [
          {
            ...GROUP,
            members: [GROUP.members[0], GROUP.members[0]].filter(
              (member) => member !== undefined,
            ),
          },
        ],
        surviving_findings: uniqueSurvivors(echo),
      },
      decisions: DECLINE_BOTH,
    })

    expectNamedRejection(
      result,
      'duplicate candidate group member',
      'candidate_groups.0.members.1.input_id',
    )
  })

  test('an echo that lists the same member in two groups is a named rejection at the second group', () => {
    const second = group('src/b.ts', [
      { input_id: 'correctness#0', line: 3 },
      { input_id: 'quality#0', line: 4 },
    ])
    const echo = prepared([GROUP, second])

    const result = applyReviewAdjudication({
      prepared: { ...echo, surviving_findings: uniqueSurvivors(echo) },
      decisions: DECLINE_BOTH,
    })

    expectNamedRejection(
      result,
      'duplicate candidate group member',
      'candidate_groups.1.members.0.input_id',
    )
  })

  test('a consistent echo is unaffected by the survivor and disjointness checks', () => {
    const result = applyReviewAdjudication({
      prepared: prepared([GROUP], { singletons: ['other#0'] }),
      decisions: DECLINE_BOTH,
    })

    expect(result.ok).toBe(true)
  })
})

describe('applyReviewAdjudication -- merge output schema', () => {
  test('an output that fails its schema returns a bounded rejection and does not throw', () => {
    const singletons = Array.from(
      { length: MAX_RUN_FINDINGS + 1 },
      (_, index) => `reviewer-x#${index}`,
    )
    const oversized = prepared([], { singletons })

    let result: ApplyReviewAdjudicationResult | undefined
    expect(() => {
      result = applyReviewAdjudication({ prepared: oversized, decisions: [] })
    }).not.toThrow()

    if (!result) throw new Error('expected a result')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { rejection } = result
    expect(rejection.reason as string).toBe(
      'merge output failed schema validation',
    )
    if (rejection.kind !== 'schema')
      throw new Error('expected a schema rejection')
    expect(rejection.total).toBeGreaterThanOrEqual(1)
    expect(rejection.issues.length).toBeLessThanOrEqual(8)
    expect(rejection.issues[0]?.path).toBe(rejection.path)
    for (const issue of rejection.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'path'])
    }
  })

  test.each([33, 51])(
    '%d singletons merge into the same number of findings',
    (count) => {
      const singletons = Array.from(
        { length: count },
        (_, index) => `reviewer-x#${index}`,
      )

      const result = applyReviewAdjudication({
        prepared: prepared([], { singletons }),
        decisions: [],
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.merged_findings).toHaveLength(count)
    },
  )
})

type CapacityDecisions = ReturnType<
  NonNullable<Parameters<typeof runPipeline>[0]['decide']>
>

describe('the real pipeline chain at run scale', () => {
  const MAX_FINDINGS_PER_REVIEWER = 32

  function singletonsFor(
    reviewer: string,
    count: number,
    extra: Partial<PipelineFindingSpec> = {},
  ): PipelineFindingSpec[] {
    return Array.from({ length: count }, (_, index) => ({
      file: `src/${reviewer}/file-${index}.ts`,
      ...extra,
    }))
  }

  function expectCompleted(run: PipelineRun): void {
    expect(run.prepare.ok).toBe(true)
    expect(run.merge?.ok).toBe(true)
    expect(run.finalize?.ok).toBe(true)
    expect(run.parsed).toEqual({ artifactOk: true, outputOk: true })
  }

  /** The artifact of a completed writing run. Throws, so an assertion on it
   * cannot be skipped when the run did not produce one. */
  function writtenArtifact(run: PipelineRun) {
    const finalize = run.finalize
    if (!finalize?.ok) throw new Error('expected finalize to succeed')
    expect(finalize.value.kind).toBe('writing')
    if (finalize.value.kind !== 'writing') {
      throw new Error('expected a writing finalize')
    }
    return finalize.value.artifact
  }

  test('34 survivors in one file from two reviewers pass prepare', () => {
    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: Array.from({ length: 17 }, (_, index) => ({
            file: 'src/shared.ts',
            line: index + 1,
          })),
        },
        {
          reviewer: 'reviewer-b',
          findings: Array.from({ length: 17 }, (_, index) => ({
            file: 'src/shared.ts',
            line: index + 100,
          })),
        },
      ],
    })

    expect(run.prepare.ok).toBe(true)
    if (!run.prepare.ok) return
    expect(run.prepare.value.candidate_groups[0]?.members).toHaveLength(34)
  })

  test('more than 32 findings complete the whole chain', () => {
    const run = runPipeline({
      reviewers: [
        { reviewer: 'reviewer-a', findings: singletonsFor('a', 32) },
        { reviewer: 'reviewer-b', findings: singletonsFor('b', 32) },
      ],
    })

    expectCompleted(run)
    const artifact = writtenArtifact(run)
    expect(artifact.findings).toHaveLength(64)
  })

  test('a group whose members are all declined completes the whole chain', () => {
    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: Array.from({ length: 3 }, (_, index) => ({
            file: 'src/shared.ts',
            line: index + 1,
          })),
        },
        {
          reviewer: 'reviewer-b',
          findings: Array.from({ length: 3 }, (_, index) => ({
            file: 'src/shared.ts',
            line: index + 50,
          })),
        },
      ],
      decide: declineEveryGroupMember,
    })

    expectCompleted(run)
  })

  test('a group merged into one finding completes the whole chain', () => {
    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: [{ file: 'src/shared.ts', line: 1 }],
        },
        {
          reviewer: 'reviewer-b',
          findings: [{ file: 'src/shared.ts', line: 1 }],
        },
      ],
      decide: mergeEveryGroup,
    })

    expectCompleted(run)
  })

  test('a report-only run with release-owned findings fills the report-only queue', () => {
    const run = runPipeline({
      mode: 'report-only',
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: singletonsFor('a', 32, { owner: 'release' }),
        },
        {
          reviewer: 'reviewer-b',
          findings: singletonsFor('b', 32, { owner: 'release' }),
        },
      ],
    })

    expect(run.prepare.ok).toBe(true)
    expect(run.merge?.ok).toBe(true)
    expect(run.finalize?.ok).toBe(true)
    expect(run.parsed).toEqual({ artifactOk: true, outputOk: true })
    if (!run.finalize?.ok) return
    expect(run.finalize.value.kind).toBe('report_only')
    if (run.finalize.value.kind !== 'report_only') return
    expect(run.finalize.value.queues.report_only.length).toBeGreaterThan(32)
  })

  test('100 validator requests with more than 64 failed or unavailable complete the whole chain', () => {
    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: singletonsFor('a', 32, { severity: 'P1' }),
        },
        {
          reviewer: 'reviewer-b',
          findings: singletonsFor('b', 32, { severity: 'P1' }),
        },
        {
          reviewer: 'reviewer-c',
          findings: singletonsFor('c', 32, { severity: 'P1' }),
        },
        {
          reviewer: 'reviewer-d',
          findings: singletonsFor('d', 4, { severity: 'P1' }),
        },
      ],
      validatorOutcome: (index) =>
        index < 70 ? (index % 2 === 0 ? 'failed' : 'unavailable') : 'true',
    })

    expectCompleted(run)
    expect(run.merge?.ok && run.merge.value.validator_requests.length).toBe(100)
    const artifact = writtenArtifact(run)
    expect(artifact.coverage.validator_failures.length).toBeGreaterThan(64)
  })

  test('more than 64 distinct residual risks and testing gaps across two reviewers complete the whole chain', () => {
    const labelled = (prefix: string, from: number, to: number) =>
      Array.from(
        { length: to - from },
        (_, index) => `${prefix} ${from + index}.`,
      )

    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: singletonsFor('a', 1),
          residualRisks: labelled('Risk', 0, 64),
          testingGaps: labelled('Gap', 0, 64),
        },
        {
          reviewer: 'reviewer-b',
          findings: singletonsFor('b', 1),
          residualRisks: labelled('Risk', 64, 128),
          testingGaps: labelled('Gap', 64, 128),
        },
      ],
    })

    expectCompleted(run)
    const artifact = writtenArtifact(run)
    const { coverage } = artifact
    expect(coverage.residual_risks).toHaveLength(128)
    expect(coverage.testing_gaps).toHaveLength(128)
  })

  test('blank and whitespace-only risks and gaps are dropped from coverage', () => {
    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: singletonsFor('a', 1),
          residualRisks: ['', '   ', 'A real risk.'],
          testingGaps: ['\t', 'A real gap.', ''],
        },
      ],
    })

    expectCompleted(run)
    const artifact = writtenArtifact(run)
    const { coverage } = artifact
    expect(coverage.residual_risks).toEqual(['A real risk.'])
    expect(coverage.testing_gaps).toEqual(['A real gap.'])
  })

  test('more than 64 distinct disagreement facts complete the whole chain', () => {
    const run = runPipeline({
      reviewers: [
        {
          reviewer: 'reviewer-a',
          findings: Array.from({ length: 20 }, (_, index) => ({
            file: 'src/shared.ts',
            line: index + 1,
          })),
        },
        {
          reviewer: 'reviewer-b',
          findings: Array.from({ length: 20 }, (_, index) => ({
            file: 'src/shared.ts',
            line: index + 100,
          })),
        },
      ],
      decide: declineEveryGroupMember,
      factsPerDecision: 2,
    })

    expectCompleted(run)
    const artifact = writtenArtifact(run)
    expect(artifact.coverage.intent_uncertainty.length).toBeGreaterThan(64)
  })

  test('a run at the run capacity with groups, merged and declined decisions, facts and validator requests completes as a writing run', () => {
    const PAIRS = 32
    const REVIEWERS = PAIRS * 2
    const SHARED_PER_REVIEWER = 8
    const GATED_PER_REVIEWER = 2
    const MERGED_FACTS = 2
    const DECLINED_FACTS = 3

    const reviewers = Array.from({ length: REVIEWERS }, (_, index) => {
      const reviewer = `reviewer-${index}`
      const pair = Math.floor(index / 2)
      const lineBase = index % 2 === 0 ? 1 : 101
      return {
        reviewer,
        findings: Array.from({ length: MAX_FINDINGS_PER_REVIEWER }, (_, n) =>
          n < SHARED_PER_REVIEWER
            ? { file: `src/shared-${pair}.ts`, line: lineBase + n }
            : {
                file: `src/${reviewer}/only-${n}.ts`,
                requiresVerification:
                  n < SHARED_PER_REVIEWER + GATED_PER_REVIEWER,
              },
        ),
      }
    })
    expect(REVIEWERS * MAX_FINDINGS_PER_REVIEWER).toBe(MAX_RUN_FINDINGS)

    // Even groups merge into one finding that carries facts; odd groups
    // decline every member.
    const decide = (prepared: PrepareOutput): CapacityDecisions =>
      prepared.candidate_groups.flatMap(
        (group, index): CapacityDecisions =>
          index % 2 === 0
            ? [
                {
                  decision_id: `merged-${index}`,
                  disposition: 'merged' as const,
                  input_finding_ids: group.members.map((m) => m.input_id),
                  title: `Merged issue ${index}`,
                  why_it_matters: 'Two reviewers described the same failure.',
                  evidence: [`${group.file}:1 demonstrates the failure path.`],
                  line: group.members[0]?.line ?? 1,
                  disagreement_facts: Array.from(
                    { length: MERGED_FACTS },
                    (_, n) => `Merged fact ${index} ${n}.`,
                  ),
                },
              ]
            : group.members.map((member) => ({
                decision_id: `declined-${member.input_id}`,
                disposition: 'declined' as const,
                input_finding_id: member.input_id,
                declined_reason: 'The reviewers described different problems.',
              })),
      )

    const start = performance.now()
    const run = runPipeline({
      reviewers,
      decide,
      factsPerDecision: DECLINED_FACTS,
    })
    console.log(
      `capacity run: ${Math.round(performance.now() - start)} ms, ` +
        `${run.merge?.ok ? run.merge.value.validator_requests.length : 0} validator requests`,
    )

    expectCompleted(run)
    const artifact = writtenArtifact(run)

    const mergedGroups = PAIRS / 2
    const declinedMembers = (PAIRS / 2) * SHARED_PER_REVIEWER * 2
    const groupMembers = PAIRS * SHARED_PER_REVIEWER * 2
    const singletons = MAX_RUN_FINDINGS - groupMembers
    const expectedFacts =
      mergedGroups * MERGED_FACTS + declinedMembers * (1 + DECLINED_FACTS)
    const expectedRequests = REVIEWERS * GATED_PER_REVIEWER

    expect(run.prepare.ok && run.prepare.value.candidate_groups).toHaveLength(
      PAIRS,
    )
    expect(artifact.findings).toHaveLength(
      mergedGroups + declinedMembers + singletons,
    )
    expect(artifact.coverage.intent_uncertainty).toHaveLength(expectedFacts)
    expect(expectedFacts).toBeGreaterThan(64)
    expect(expectedFacts).toBeLessThanOrEqual(MAX_RUN_DISAGREEMENT_FACTS)
    expect(artifact.coverage.validators).toBe(expectedRequests)
  }, 60_000)
})
