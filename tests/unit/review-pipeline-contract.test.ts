import { describe, expect, test } from 'bun:test'
import {
  MAX_DECISION_FACTS,
  MAX_FINDINGS,
  MAX_PERSONAS,
  MAX_RUN_DISAGREEMENT_FACTS,
  MAX_RUN_FINDINGS,
  ReviewArtifactSchema,
} from '../../src/lib/review-artifact-schema.js'
import {
  AdjudicationEnvelopeSchema,
  AGGREGATE_BYTE_CAP_HEADROOM,
  AGGREGATE_STDIN_BYTE_CAP,
  FinalizeInputSchema,
  FinalizeOutputSchema,
  isRouteTransitionAllowed,
  MergeInputSchema,
  MergeOutputSchema,
  ParentRunMetadataSchema,
  PER_FINDING_BYTE_ASSUMPTION,
  PlanAssessmentEnvelopeSchema,
  PrepareInputSchema,
  PrepareOutputSchema,
  ROUTE_REFUSAL_TABLE,
  ScreenInputSchema,
  ScreenOutputSchema,
  ValidatorLifecycleResultSchema,
  ValidatorLifecycleResultsSchema,
} from '../../src/lib/review-pipeline-contract.js'

type JsonObject = Record<string, unknown>

const rawFindingFixture = {
  title: 'Example issue',
  severity: 'P1',
  file: 'src/example.ts',
  line: 42,
  why_it_matters: 'The example path can fail during normal execution.',
  autofix_class: 'gated_auto',
  owner: 'downstream-resolver',
  requires_verification: true,
  confidence: 0.85,
  evidence: ['src/example.ts:42 demonstrates the failure path.'],
  pre_existing: false,
  suggested_fix: 'Handle the failure before continuing.',
}

const rawReturnFixture = {
  reviewer: 'correctness',
  findings: [rawFindingFixture],
  residual_risks: [],
  testing_gaps: [],
}

const admittedFindingFixture = {
  ...rawFindingFixture,
  disposition: 'surviving',
  input_id: 'correctness-0',
}

const screenInputFixture: JsonObject = {
  raw_return: rawReturnFixture,
  expected_reviewer: 'correctness',
  invoking_harness: 'opencode',
}

const screenOutputFixture: JsonObject = {
  dispatch_outcome: 'findings',
  admitted_findings: [admittedFindingFixture],
  residual_risks: [],
  testing_gaps: [],
  harness: 'opencode',
}

const prepareInputFixture: JsonObject = {
  screen_results: [
    {
      reviewer: 'correctness',
      result: screenOutputFixture,
    },
  ],
  selected_dispatches: [
    {
      persona: 'correctness',
      dispatch_outcome: 'findings',
      selection_surface: ['src/example.ts'],
    },
  ],
}

const survivingFindingFixture: JsonObject = {
  ...rawFindingFixture,
  disposition: 'surviving',
  input_id: 'correctness-0',
  reviewer: 'correctness',
}

const prepareOutputFixture: JsonObject = {
  confidence_dispositions: [
    {
      input_id: 'correctness-0',
      disposition: 'surviving',
      confidence: 0.85,
    },
  ],
  coverage_union: ['src/example.ts'],
  singletons: ['correctness-0'],
  candidate_groups: [],
  surviving_findings: [survivingFindingFixture],
}

describe('ScreenInputSchema', () => {
  test('accepts a conforming screen input', () => {
    expect(ScreenInputSchema.safeParse(screenInputFixture).success).toBe(true)
  })

  test('rejects an unknown top-level key', () => {
    const result = ScreenInputSchema.safeParse({
      ...screenInputFixture,
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })
})

describe('ScreenOutputSchema', () => {
  test('accepts a conforming screen output', () => {
    expect(ScreenOutputSchema.safeParse(screenOutputFixture).success).toBe(true)
  })

  test('rejects an unknown key on an admitted finding', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      admitted_findings: [{ ...admittedFindingFixture, extra: 'nope' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects an out-of-bound rejected summary reason', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      dispatch_outcome: 'malformed',
      rejected_summary: {
        dispatch_outcome: 'malformed',
        rejected_finding_count: 1,
        reason: 'x'.repeat(2049),
      },
    })
    expect(result.success).toBe(false)
  })

  test('accepts a conforming rejected summary', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      admitted_findings: [],
      dispatch_outcome: 'malformed',
      rejected_summary: {
        dispatch_outcome: 'malformed',
        rejected_finding_count: 1,
        rejected_severities: ['P1'],
        reason: 'Reviewer output did not parse as JSON.',
      },
    })
    expect(result.success).toBe(true)
  })

  test('rejects a rejected summary whose severity count does not match the finding count', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      admitted_findings: [],
      dispatch_outcome: 'malformed',
      rejected_summary: {
        dispatch_outcome: 'malformed',
        rejected_finding_count: 2,
        rejected_severities: ['P1'],
        reason: 'Reviewer output did not parse as JSON.',
      },
    })
    expect(result.success).toBe(false)
  })

  test('accepts an unknown rejected severity classification', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      admitted_findings: [],
      dispatch_outcome: 'malformed',
      rejected_summary: {
        dispatch_outcome: 'malformed',
        rejected_finding_count: 1,
        rejected_severities: ['unknown'],
        reason: 'Reviewer output did not parse as JSON.',
      },
    })
    expect(result.success).toBe(true)
  })

  test('rejects validation_unavailable as a rejected summary outcome', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      dispatch_outcome: 'validation_unavailable',
      rejected_summary: {
        dispatch_outcome: 'validation_unavailable',
        rejected_finding_count: 1,
        reason: 'Reviewer output did not parse as JSON.',
      },
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown harness value', () => {
    const result = ScreenOutputSchema.safeParse({
      ...screenOutputFixture,
      harness: 'not-a-harness',
    })
    expect(result.success).toBe(false)
  })

  test('rejects a missing harness field', () => {
    const { harness: _harness, ...withoutHarness } = screenOutputFixture
    const result = ScreenOutputSchema.safeParse(withoutHarness)
    expect(result.success).toBe(false)
  })

  test('admitted_findings bound tracks the exported MAX_FINDINGS constant', () => {
    const atMax = Array.from({ length: MAX_FINDINGS }, (_, index) => ({
      ...admittedFindingFixture,
      input_id: `correctness-${index}`,
    }))
    const overMax = [
      ...atMax,
      { ...admittedFindingFixture, input_id: 'correctness-overflow' },
    ]

    expect(
      ScreenOutputSchema.safeParse({
        ...screenOutputFixture,
        admitted_findings: atMax,
      }).success,
    ).toBe(true)
    expect(
      ScreenOutputSchema.safeParse({
        ...screenOutputFixture,
        admitted_findings: overMax,
      }).success,
    ).toBe(false)
  })
})

describe('PrepareInputSchema', () => {
  test('accepts a conforming prepare input', () => {
    expect(PrepareInputSchema.safeParse(prepareInputFixture).success).toBe(true)
  })

  test('rejects an unknown key on a selected dispatch', () => {
    const result = PrepareInputSchema.safeParse({
      ...prepareInputFixture,
      selected_dispatches: [
        {
          persona: 'correctness',
          dispatch_outcome: 'findings',
          extra: 'nope',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('selected_dispatches bound tracks the exported MAX_PERSONAS constant', () => {
    const dispatch = { persona: 'correctness', dispatch_outcome: 'findings' }
    const atMax = Array.from({ length: MAX_PERSONAS }, () => dispatch)
    const overMax = [...atMax, dispatch]

    expect(
      PrepareInputSchema.safeParse({
        ...prepareInputFixture,
        screen_results: [],
        selected_dispatches: atMax,
      }).success,
    ).toBe(true)
    expect(
      PrepareInputSchema.safeParse({
        ...prepareInputFixture,
        screen_results: [],
        selected_dispatches: overMax,
      }).success,
    ).toBe(false)
  })
})

describe('PrepareOutputSchema', () => {
  test('accepts a conforming prepare output', () => {
    expect(PrepareOutputSchema.safeParse(prepareOutputFixture).success).toBe(
      true,
    )
  })

  test('rejects an unknown key on a candidate group', () => {
    const result = PrepareOutputSchema.safeParse({
      ...prepareOutputFixture,
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness-0', line: 10 },
            { input_id: 'security-0', line: 12 },
          ],
          extra: 'nope',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown key on a candidate group member', () => {
    const result = PrepareOutputSchema.safeParse({
      ...prepareOutputFixture,
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness-0', line: 10, extra: 'nope' },
            { input_id: 'security-0', line: 12 },
          ],
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a candidate group with fewer than two members', () => {
    const result = PrepareOutputSchema.safeParse({
      ...prepareOutputFixture,
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [{ input_id: 'correctness-0', line: 10 }],
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('accepts a valid candidate group', () => {
    const result = PrepareOutputSchema.safeParse({
      ...prepareOutputFixture,
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness-0', line: 10 },
            { input_id: 'security-0', line: 12 },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test('rejects an unknown key on a surviving finding', () => {
    const result = PrepareOutputSchema.safeParse({
      ...prepareOutputFixture,
      surviving_findings: [{ ...survivingFindingFixture, extra: 'nope' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a surviving finding missing its reviewer', () => {
    const { reviewer: _reviewer, ...withoutReviewer } = survivingFindingFixture
    const result = PrepareOutputSchema.safeParse({
      ...prepareOutputFixture,
      surviving_findings: [withoutReviewer],
    })
    expect(result.success).toBe(false)
  })

  test('surviving_findings bound tracks the exported MAX_FINDINGS * MAX_PERSONAS maxima', () => {
    const atMax = Array.from(
      { length: MAX_FINDINGS * MAX_PERSONAS },
      (_, index) => ({
        ...survivingFindingFixture,
        input_id: `correctness-${index}`,
      }),
    )
    const overMax = [
      ...atMax,
      { ...survivingFindingFixture, input_id: 'correctness-overflow' },
    ]

    expect(
      PrepareOutputSchema.safeParse({
        ...prepareOutputFixture,
        surviving_findings: atMax,
      }).success,
    ).toBe(true)
    expect(
      PrepareOutputSchema.safeParse({
        ...prepareOutputFixture,
        surviving_findings: overMax,
      }).success,
    ).toBe(false)
  })
})

// A realistic (not maximal) envelope: ~12 personas each contributing ~5
// findings, with typical rather than bound-maxing string lengths. Exists to
// catch a future change that pushes ordinary envelopes toward the cap --
// `AGGREGATE_STDIN_BYTE_CAP`'s own formula test above already pins the
// pathological-maximum side of that arithmetic.
const REALISTIC_PERSONA_COUNT = 12
const REALISTIC_FINDINGS_PER_PERSONA = 5

const REALISTIC_PERSONA_INDICES = Array.from(
  { length: REALISTIC_PERSONA_COUNT },
  (_, index) => index,
)
const REALISTIC_FINDING_INDICES = Array.from(
  { length: REALISTIC_FINDINGS_PER_PERSONA },
  (_, index) => index,
)
const REALISTIC_ENTRIES = REALISTIC_PERSONA_INDICES.flatMap((personaIndex) =>
  REALISTIC_FINDING_INDICES.map((findingIndex) => ({
    personaIndex,
    findingIndex,
  })),
)

const realisticPersona = (personaIndex: number): string =>
  `persona-${personaIndex}`
const realisticFile = (personaIndex: number): string =>
  `src/module-${personaIndex}.ts`
const realisticInputId = (personaIndex: number, findingIndex: number): string =>
  `${realisticPersona(personaIndex)}-finding-${findingIndex}`

const realisticRawFinding = (
  personaIndex: number,
  findingIndex: number,
): JsonObject => {
  const line = 10 + findingIndex
  const file = realisticFile(personaIndex)
  return {
    title: `Issue ${personaIndex}-${findingIndex} in module boundary handling`,
    severity: 'P2',
    file,
    line,
    why_it_matters:
      'This path is reachable during normal request handling and can leave state inconsistent if the caller does not check the return value.',
    autofix_class: 'manual',
    owner: 'review-fixer',
    requires_verification: false,
    confidence: 0.72,
    evidence: [`${file}:${line} shows the unchecked path.`],
    pre_existing: false,
    suggested_fix: 'Check the return value and propagate the error.',
  }
}

const realisticSurvivingFinding = (
  personaIndex: number,
  findingIndex: number,
): JsonObject => ({
  ...realisticRawFinding(personaIndex, findingIndex),
  disposition: 'surviving',
  input_id: realisticInputId(personaIndex, findingIndex),
  reviewer: realisticPersona(personaIndex),
})

const realisticAdmittedFinding = (
  personaIndex: number,
  findingIndex: number,
): JsonObject => ({
  ...realisticRawFinding(personaIndex, findingIndex),
  disposition: 'surviving',
  input_id: realisticInputId(personaIndex, findingIndex),
})

const realisticConfidenceDisposition = (
  personaIndex: number,
  findingIndex: number,
): JsonObject => ({
  input_id: realisticInputId(personaIndex, findingIndex),
  disposition: 'surviving',
  confidence: 0.72,
})

const realisticPreparedOutput: JsonObject = {
  confidence_dispositions: REALISTIC_ENTRIES.map(
    ({ personaIndex, findingIndex }) =>
      realisticConfidenceDisposition(personaIndex, findingIndex),
  ),
  coverage_union: REALISTIC_PERSONA_INDICES.map(realisticFile),
  singletons: REALISTIC_ENTRIES.map(({ personaIndex, findingIndex }) =>
    realisticInputId(personaIndex, findingIndex),
  ),
  candidate_groups: [],
  surviving_findings: REALISTIC_ENTRIES.map(({ personaIndex, findingIndex }) =>
    realisticSurvivingFinding(personaIndex, findingIndex),
  ),
}

// `AdjudicationEnvelopeSchema.decisions` is bounded at `MAX_RUN_FINDINGS`.
// The authority is the schema caps themselves: the `decisions` maximum times
// the per-decision facts maximum bounds the facts aggregate. Candidate-group
// membership is not the authority, because `members` and `candidate_groups`
// are capped independently. Most findings remain singletons that never get a
// decision, and one declined decision per persona (well under the bound)
// reflects that.
const realisticDeclinedDecision = (personaIndex: number): JsonObject => ({
  decision_id: `decision-${realisticInputId(personaIndex, 0)}`,
  disposition: 'declined',
  input_finding_id: realisticInputId(personaIndex, 0),
  declined_reason: 'Only one reviewer flagged this input finding.',
})

const realisticMergeInputFixture: JsonObject = {
  prepared: realisticPreparedOutput,
  adjudication: {
    decisions: REALISTIC_PERSONA_INDICES.map(realisticDeclinedDecision),
  },
}

const realisticMergedFinding = (personaIndex: number): JsonObject => {
  const file = realisticFile(personaIndex)
  return {
    finding_id: `merged-${personaIndex}`,
    file,
    title: `Merged issue for module ${personaIndex}`,
    why_it_matters:
      'Two reviewers independently flagged the same unchecked return value on this path.',
    line: 10,
    autofix_class: 'manual',
    owner: 'review-fixer',
    requires_verification: false,
    evidence: [`${file}:10 shows the shared issue.`],
    suggested_fix: 'Check the return value and propagate the error.',
    input_finding_ids: [
      realisticInputId(personaIndex, 0),
      realisticInputId(personaIndex, 1),
    ],
    severity: 'P2',
    confidence: 0.72,
    pre_existing: false,
    fingerprint: `${file}:10:P2`,
    submitters: [realisticPersona(personaIndex)],
  }
}

const realisticValidatorRequest = (personaIndex: number): JsonObject => ({
  finding_id: `merged-${personaIndex}`,
  file: realisticFile(personaIndex),
  line: 10,
})

const realisticMergeOutputFixture: JsonObject = {
  merged_findings: REALISTIC_PERSONA_INDICES.map(realisticMergedFinding),
  validator_requests: REALISTIC_PERSONA_INDICES.map(realisticValidatorRequest),
  disagreement_facts: [],
}

const realisticScreenResult = (personaIndex: number): JsonObject => ({
  reviewer: realisticPersona(personaIndex),
  result: {
    dispatch_outcome: 'findings',
    admitted_findings: REALISTIC_FINDING_INDICES.map((findingIndex) =>
      realisticAdmittedFinding(personaIndex, findingIndex),
    ),
    residual_risks: [],
    testing_gaps: [],
    harness: 'opencode',
  },
})

const realisticSelectedDispatch = (personaIndex: number): JsonObject => ({
  persona: realisticPersona(personaIndex),
  dispatch_outcome: 'findings',
  selection_surface: [realisticFile(personaIndex)],
})

const realisticValidatorLifecycleResult = (
  personaIndex: number,
): JsonObject => ({
  finding_id: `merged-${personaIndex}`,
  result: { outcome: 'true' },
})

const realisticParentRunMetadata: JsonObject = {
  run_id: 'run-realistic',
  mode: 'interactive',
  harness: 'opencode',
  branch: 'main',
  head_sha: 'a'.repeat(40),
  selected_dispatches: REALISTIC_PERSONA_INDICES.map(realisticSelectedDispatch),
  timestamps: {
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:05:00.000Z',
  },
  validation: { status: 'passed' },
  applied_fixes: [],
}

const realisticFinalizeInputFixture: JsonObject = {
  merge: realisticMergeOutputFixture,
  prepared: realisticPreparedOutput,
  screen_results: REALISTIC_PERSONA_INDICES.map(realisticScreenResult),
  dispatch_records: REALISTIC_PERSONA_INDICES.map(realisticSelectedDispatch),
  validator_lifecycle_results: REALISTIC_PERSONA_INDICES.map(
    realisticValidatorLifecycleResult,
  ),
  plan_assessment: {
    verdict: 'Ready to merge after minor fixups.',
    results: [
      {
        kind: 'inferred_gap',
        description:
          'Retry backoff for the new client is not covered by a test.',
      },
    ],
  },
  parent_run_metadata: realisticParentRunMetadata,
}

describe('AGGREGATE_STDIN_BYTE_CAP', () => {
  test('equals its stated formula', () => {
    expect(AGGREGATE_STDIN_BYTE_CAP).toBe(
      MAX_PERSONAS * MAX_FINDINGS * PER_FINDING_BYTE_ASSUMPTION +
        AGGREGATE_BYTE_CAP_HEADROOM,
    )
  })

  test('a realistic-scale merge envelope (12 personas, ~5 findings each) parses and stays comfortably under the cap', () => {
    expect(MergeInputSchema.safeParse(realisticMergeInputFixture).success).toBe(
      true,
    )

    const measuredBytes = Buffer.byteLength(
      JSON.stringify(realisticMergeInputFixture),
    )
    const headroomMultiple = AGGREGATE_STDIN_BYTE_CAP / measuredBytes
    expect(
      measuredBytes,
      `realistic merge envelope measured ${measuredBytes} bytes, ` +
        `${headroomMultiple.toFixed(1)}x under the ${AGGREGATE_STDIN_BYTE_CAP}-byte cap`,
    ).toBeLessThan(AGGREGATE_STDIN_BYTE_CAP)
  })

  test('a realistic-scale finalize envelope (12 personas, ~5 findings each) parses and stays comfortably under the cap', () => {
    expect(
      FinalizeInputSchema.safeParse(realisticFinalizeInputFixture).success,
    ).toBe(true)

    const measuredBytes = Buffer.byteLength(
      JSON.stringify(realisticFinalizeInputFixture),
    )
    const headroomMultiple = AGGREGATE_STDIN_BYTE_CAP / measuredBytes
    expect(
      measuredBytes,
      `realistic finalize envelope measured ${measuredBytes} bytes, ` +
        `${headroomMultiple.toFixed(1)}x under the ${AGGREGATE_STDIN_BYTE_CAP}-byte cap`,
    ).toBeLessThan(AGGREGATE_STDIN_BYTE_CAP)
  })
})

describe('ROUTE_REFUSAL_TABLE / isRouteTransitionAllowed', () => {
  const base = {
    autofix_class: 'safe_auto',
    owner: 'review-fixer',
    requires_verification: false,
  } as const

  test('allows a narrowing transition', () => {
    expect(
      isRouteTransitionAllowed(base, {
        autofix_class: 'manual',
        owner: 'human',
        requires_verification: true,
      }),
    ).toBe(true)
  })

  test('refuses a widening autofix_class transition', () => {
    expect(
      isRouteTransitionAllowed(
        { ...base, autofix_class: 'manual' },
        { ...base, autofix_class: 'safe_auto' },
      ),
    ).toBe(false)
  })

  test('refuses an incomparable owner pair', () => {
    expect(
      isRouteTransitionAllowed(
        { ...base, owner: 'downstream-resolver' },
        { ...base, owner: 'human' },
      ),
    ).toBe(false)
    expect(
      isRouteTransitionAllowed(
        { ...base, owner: 'human' },
        { ...base, owner: 'downstream-resolver' },
      ),
    ).toBe(false)
  })

  test('refuses requires_verification widening from true to false', () => {
    expect(
      isRouteTransitionAllowed(
        { ...base, requires_verification: true },
        { ...base, requires_verification: false },
      ),
    ).toBe(false)
  })

  test('table data is not a simple string-sorted or enum-order ladder', () => {
    // Alphabetically, 'downstream-resolver' < 'human' < 'release' <
    // 'review-fixer'. A sort-derived table would let review-fixer only reach
    // itself (it sorts last), but the authored table allows it to reach every
    // other owner.
    expect(ROUTE_REFUSAL_TABLE.owner['review-fixer']).toContain('release')
    expect(ROUTE_REFUSAL_TABLE.owner['review-fixer']).toContain(
      'downstream-resolver',
    )
    expect(ROUTE_REFUSAL_TABLE.owner['review-fixer']).toContain('human')
  })
})

const mergedDecisionFixture: JsonObject = {
  decision_id: 'decision-0',
  disposition: 'merged',
  input_finding_ids: ['correctness-0', 'security-0'],
  title: 'Merged issue title',
  why_it_matters: 'Explains the impact of the merged issue for context.',
  evidence: ['src/example.ts:42 shows the merged issue.'],
  suggested_fix: 'Apply the suggested fix here.',
  line: 42,
}

const declinedDecisionFixture: JsonObject = {
  decision_id: 'decision-1',
  disposition: 'declined',
  input_finding_id: 'correctness-1',
  declined_reason: 'The two findings describe unrelated failure modes.',
}

const adjudicationFixture: JsonObject = {
  decisions: [mergedDecisionFixture, declinedDecisionFixture],
}

const mergeInputFixture: JsonObject = {
  prepared: prepareOutputFixture,
  adjudication: adjudicationFixture,
}

const mergedFindingFixture: JsonObject = {
  finding_id: 'decision-0',
  file: 'src/example.ts',
  title: 'Merged issue title',
  why_it_matters: 'Explains the impact of the merged issue for context.',
  line: 42,
  autofix_class: 'gated_auto',
  owner: 'downstream-resolver',
  requires_verification: true,
  evidence: ['src/example.ts:42 shows the merged issue.'],
  suggested_fix: 'Apply the suggested fix here.',
  input_finding_ids: ['correctness-0', 'security-0'],
  severity: 'P1',
  confidence: 0.85,
  pre_existing: false,
  fingerprint: 'src/example.ts:42:P1',
  submitters: ['correctness', 'security'],
}

const validatorRequestFixture: JsonObject = {
  finding_id: 'decision-0',
  file: 'src/example.ts',
  line: 42,
}

const mergeOutputFixture: JsonObject = {
  merged_findings: [mergedFindingFixture],
  validator_requests: [validatorRequestFixture],
  disagreement_facts: [],
}

const selectedDispatchFixture: JsonObject = {
  persona: 'correctness',
  dispatch_outcome: 'findings',
  selection_surface: ['src/example.ts'],
}

const planAssessmentFixture: JsonObject = {
  verdict: 'Ready to merge after minor fixups.',
  results: [
    {
      kind: 'explicit_unmet_requirement',
      description: 'The plan required a migration script that was not added.',
    },
    {
      kind: 'inferred_gap',
      description: 'Retry backoff for the new client is not covered by a test.',
    },
  ],
}

const parentRunMetadataFixture: JsonObject = {
  run_id: 'run-123',
  mode: 'interactive',
  harness: 'opencode',
  branch: 'main',
  head_sha: 'a'.repeat(40),
  selected_dispatches: [selectedDispatchFixture],
  timestamps: {
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:05:00.000Z',
  },
  validation: { status: 'passed' },
  applied_fixes: [],
}

const reportProjectionFixture: JsonObject = {
  verdict: 'Ready to merge after minor fixups.',
  findings: [
    {
      title: 'Merged issue title',
      severity: 'P1',
      file: 'src/example.ts',
      line: 42,
      why_it_matters: 'Explains the impact of the merged issue for context.',
      autofix_class: 'gated_auto',
      owner: 'downstream-resolver',
      requires_verification: true,
      confidence: 0.85,
      evidence: ['src/example.ts:42 shows the merged issue.'],
      pre_existing: false,
      suggested_fix: 'Apply the suggested fix here.',
      validated: true,
      input_finding_ids: ['correctness-0'],
      provenance: {
        fingerprint: 'fp-1',
        submitters: ['correctness'],
        agreement_credit: [],
      },
    },
  ],
  applied_fixes: [],
  residual_actionable_work: [],
  advisory_outputs: [],
  coverage: {
    residual_risks: [],
    testing_gaps: [],
    failed_reviewers: [],
    validator_failures: [],
    intent_uncertainty: [],
  },
  input_dispositions: [{ input_id: 'correctness-0', disposition: 'surviving' }],
  disposition_counts: {
    surviving: 0,
    merged: 1,
    suppressed: 0,
    filtered: 0,
    rejected: 0,
  },
  queues: {
    fixer: [],
    residual: [{ finding_id: 'decision-0', unconfirmed: false }],
    report_only: [],
  },
  pre_existing_findings: [],
  risk_coverage: [],
}

const reviewArtifactFixture: JsonObject = {
  schema_version: 1,
  run_id: 'run-123',
  branch: 'main',
  head_sha: 'a'.repeat(40),
  mode: 'interactive',
  harness: 'opencode',
  run_status: 'completed',
  verdict: 'Ready to merge after minor fixups.',
  completed_at: '2026-01-01T00:05:00.000Z',
  dispatches: [
    {
      persona: 'correctness',
      dispatch_outcome: 'findings',
      input_finding_count: 1,
    },
  ],
  input_findings: [
    {
      record_type: 'admitted',
      input_id: 'correctness-0',
      reviewer: 'correctness',
      confidence: 0.85,
      disposition: 'surviving',
      reason: 'Reviewer confidence assessment.',
    },
  ],
  findings: reportProjectionFixture.findings,
  disposition_counts: {
    surviving: 0,
    merged: 1,
    suppressed: 0,
    filtered: 0,
    rejected: 0,
  },
  applied_fixes: [],
  residual_actionable_work: [],
  advisory_outputs: [],
  coverage: reportProjectionFixture.coverage,
  validation: { status: 'passed' },
}

const finalizeInputFixture: JsonObject = {
  merge: mergeOutputFixture,
  prepared: prepareOutputFixture,
  screen_results: prepareInputFixture.screen_results,
  dispatch_records: [selectedDispatchFixture],
  validator_lifecycle_results: [
    { finding_id: 'decision-0', result: { outcome: 'true' } },
  ],
  plan_assessment: planAssessmentFixture,
  parent_run_metadata: parentRunMetadataFixture,
}

describe('AdjudicationEnvelopeSchema', () => {
  test('accepts a conforming adjudication envelope', () => {
    expect(
      AdjudicationEnvelopeSchema.safeParse(adjudicationFixture).success,
    ).toBe(true)
  })

  test('rejects an unknown key on a merged decision', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [{ ...mergedDecisionFixture, extra: 'nope' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown key on a declined decision', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [{ ...declinedDecisionFixture, extra: 'nope' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects duplicate decision IDs', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [
        mergedDecisionFixture,
        {
          ...declinedDecisionFixture,
          decision_id: mergedDecisionFixture.decision_id,
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('rejects an input ID appearing in two merge groups', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [
        mergedDecisionFixture,
        {
          decision_id: 'decision-2',
          disposition: 'merged',
          input_finding_ids: ['correctness-0', 'reliability-0'],
          title: 'Another merged issue',
          why_it_matters: 'Also explains an impact for context.',
          evidence: ['src/example.ts:10 shows another issue.'],
          suggested_fix: null,
          line: 10,
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a decision missing its disposition', () => {
    const { disposition: _disposition, ...withoutDisposition } =
      mergedDecisionFixture
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [withoutDisposition],
    })
    expect(result.success).toBe(false)
  })

  test('accepts a proposed_route paired with a route_narrowing_reason on a merged decision', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [
        {
          ...mergedDecisionFixture,
          proposed_route: {
            autofix_class: 'manual',
            owner: 'downstream-resolver',
            requires_verification: true,
          },
          route_narrowing_reason: 'Only a human should apply this fix.',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test('rejects a proposed_route without a route_narrowing_reason on a merged decision', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [
        {
          ...mergedDecisionFixture,
          proposed_route: {
            autofix_class: 'manual',
            owner: 'downstream-resolver',
            requires_verification: true,
          },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a proposed_route without a route_narrowing_reason on a declined decision', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [
        {
          ...declinedDecisionFixture,
          proposed_route: {
            autofix_class: 'advisory',
            owner: 'human',
            requires_verification: true,
          },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown key on a proposed_route', () => {
    const result = AdjudicationEnvelopeSchema.safeParse({
      decisions: [
        {
          ...mergedDecisionFixture,
          proposed_route: {
            autofix_class: 'manual',
            owner: 'downstream-resolver',
            requires_verification: true,
            extra: 'nope',
          },
          route_narrowing_reason: 'Only a human should apply this fix.',
        },
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('MergeInputSchema / MergeOutputSchema', () => {
  test('accepts a conforming merge input', () => {
    expect(MergeInputSchema.safeParse(mergeInputFixture).success).toBe(true)
  })

  test('accepts a conforming merge output', () => {
    expect(MergeOutputSchema.safeParse(mergeOutputFixture).success).toBe(true)
  })

  test('rejects an unknown top-level key on merge input', () => {
    const result = MergeInputSchema.safeParse({
      ...mergeInputFixture,
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown key on a merged finding', () => {
    const result = MergeOutputSchema.safeParse({
      ...mergeOutputFixture,
      merged_findings: [{ ...mergedFindingFixture, extra: 'nope' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects a merged finding missing a carried mechanical field', () => {
    const { submitters: _submitters, ...withoutSubmitters } =
      mergedFindingFixture
    const result = MergeOutputSchema.safeParse({
      ...mergeOutputFixture,
      merged_findings: [withoutSubmitters],
    })
    expect(result.success).toBe(false)
  })

  test('carries severity, confidence, pre_existing, fingerprint, and submitters on the wire', () => {
    const result = MergeOutputSchema.safeParse(mergeOutputFixture)
    expect(result.success).toBe(true)
    if (!result.success) return
    const [finding] = result.data.merged_findings
    expect(finding?.severity).toBe('P1')
    expect(finding?.confidence).toBe(0.85)
    expect(finding?.pre_existing).toBe(false)
    expect(finding?.fingerprint).toBe('src/example.ts:42:P1')
    expect(finding?.submitters).toEqual(['correctness', 'security'])
  })

  test('accepts a merged finding carrying route_narrowing_reason', () => {
    const result = MergeOutputSchema.safeParse({
      ...mergeOutputFixture,
      merged_findings: [
        {
          ...mergedFindingFixture,
          route_narrowing_reason: 'Escalated to release per policy.',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const [finding] = result.data.merged_findings
    expect(finding?.route_narrowing_reason).toBe(
      'Escalated to release per policy.',
    )
  })

  test('a merged finding without route_narrowing_reason still validates', () => {
    const result = MergeOutputSchema.safeParse(mergeOutputFixture)
    expect(result.success).toBe(true)
    if (!result.success) return
    const [finding] = result.data.merged_findings
    expect('route_narrowing_reason' in (finding ?? {})).toBe(false)
  })
})

describe('ValidatorLifecycleResultSchema', () => {
  test('accepts a validated-true result', () => {
    expect(
      ValidatorLifecycleResultSchema.safeParse({ outcome: 'true' }).success,
    ).toBe(true)
  })

  test('accepts a validated-false result with a reason', () => {
    expect(
      ValidatorLifecycleResultSchema.safeParse({
        outcome: 'false',
        reason: 'The suggested fix did not compile.',
      }).success,
    ).toBe(true)
  })

  test('rejects an unknown key on a validator lifecycle result', () => {
    const result = ValidatorLifecycleResultSchema.safeParse({
      outcome: 'true',
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })

  test('a failure/timeout non-answer cannot be expressed as validated-true', () => {
    const result = ValidatorLifecycleResultSchema.safeParse({
      outcome: 'true',
      reason: 'Validator timed out.',
    })
    // The 'true' branch is `.strict()` with only an `outcome` field, so a
    // failure/timeout reason cannot be smuggled onto it -- and the 'failed'
    // branch requires `outcome: 'failed'`, not `outcome: 'true'`, so there is
    // no shape a non-answer can take that also satisfies the true branch.
    expect(result.success).toBe(false)
  })

  test('an unavailable non-answer cannot be expressed as validated-true', () => {
    const unavailable = ValidatorLifecycleResultSchema.safeParse({
      outcome: 'unavailable',
      reason: 'Validator persona did not run for this session.',
    })
    expect(unavailable.success).toBe(true)
    if (unavailable.success) {
      expect(unavailable.data.outcome).not.toBe('true')
    }
  })
})

describe('PlanAssessmentEnvelopeSchema', () => {
  test('accepts a conforming plan assessment envelope', () => {
    expect(
      PlanAssessmentEnvelopeSchema.safeParse(planAssessmentFixture).success,
    ).toBe(true)
  })

  test('rejects an unknown key', () => {
    const result = PlanAssessmentEnvelopeSchema.safeParse({
      ...planAssessmentFixture,
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })

  test('accepts an empty results array', () => {
    const result = PlanAssessmentEnvelopeSchema.safeParse({
      verdict: planAssessmentFixture.verdict,
      results: [],
    })
    expect(result.success).toBe(true)
  })

  test('rejects an unknown key on a result entry', () => {
    const result = PlanAssessmentEnvelopeSchema.safeParse({
      verdict: planAssessmentFixture.verdict,
      results: [{ kind: 'inferred_gap', description: 'x', extra: 'nope' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects the pre-routed run_status field', () => {
    const result = PlanAssessmentEnvelopeSchema.safeParse({
      verdict: planAssessmentFixture.verdict,
      results: [],
      run_status: 'completed',
    })
    expect(result.success).toBe(false)
  })

  test('rejects the pre-routed residual_actionable_work and advisory_outputs fields', () => {
    const result = PlanAssessmentEnvelopeSchema.safeParse({
      verdict: planAssessmentFixture.verdict,
      results: [],
      residual_actionable_work: [],
      advisory_outputs: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('ParentRunMetadataSchema', () => {
  test('accepts conforming parent run metadata', () => {
    expect(
      ParentRunMetadataSchema.safeParse(parentRunMetadataFixture).success,
    ).toBe(true)
  })

  test('rejects an unknown key such as cwd', () => {
    const result = ParentRunMetadataSchema.safeParse({
      ...parentRunMetadataFixture,
      cwd: '/tmp/review-run',
    })
    expect(result.success).toBe(false)
  })

  test('accepts report-only as a mode', () => {
    const result = ParentRunMetadataSchema.safeParse({
      ...parentRunMetadataFixture,
      mode: 'report-only',
    })
    expect(result.success).toBe(true)
  })

  test('the artifact mode enum still rejects report-only', () => {
    const result = ReviewArtifactSchema.safeParse({
      ...reviewArtifactFixture,
      mode: 'report-only',
    })
    expect(result.success).toBe(false)
  })
})

describe('FinalizeInputSchema / FinalizeOutputSchema', () => {
  test('accepts a conforming finalize input', () => {
    const result = FinalizeInputSchema.safeParse(finalizeInputFixture)
    expect(result.success).toBe(true)
  })

  test('rejects an unknown top-level key on a finalize input', () => {
    const result = FinalizeInputSchema.safeParse({
      ...finalizeInputFixture,
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })

  test('rejects a finalize input missing screen_results', () => {
    const { screen_results: _screenResults, ...withoutScreenResults } =
      finalizeInputFixture
    const result = FinalizeInputSchema.safeParse(withoutScreenResults)
    expect(result.success).toBe(false)
  })

  test('rejects a finalize input missing prepared', () => {
    const { prepared: _prepared, ...withoutPrepared } = finalizeInputFixture
    const result = FinalizeInputSchema.safeParse(withoutPrepared)
    expect(result.success).toBe(false)
  })

  test('accepts a dispatch record carrying selection_reason', () => {
    const withSelectionReason = {
      ...finalizeInputFixture,
      dispatch_records: [
        {
          ...selectedDispatchFixture,
          selection_reason: 'Touches example.ts directly.',
        },
      ],
    }
    const result = FinalizeInputSchema.safeParse(withSelectionReason)
    expect(result.success).toBe(true)
  })

  test('accepts a conforming writing-mode finalize output', () => {
    const result = FinalizeOutputSchema.safeParse({
      kind: 'writing',
      artifact: reviewArtifactFixture,
      report: reportProjectionFixture,
    })
    expect(result.success).toBe(true)
  })

  test('accepts a conforming report-only finalize output', () => {
    const result = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...reportProjectionFixture,
    })
    expect(result.success).toBe(true)
  })

  test('rejects a report-only finalize output carrying persistence-only fields', () => {
    const withSchemaVersion = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...reportProjectionFixture,
      schema_version: 1,
    })
    const withRunId = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...reportProjectionFixture,
      run_id: 'run-123',
    })
    expect(withSchemaVersion.success).toBe(false)
    expect(withRunId.success).toBe(false)
  })

  test('rejects a report-only finalize output wrapped in an artifact field', () => {
    const result = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...reportProjectionFixture,
      artifact: reviewArtifactFixture,
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown key on the report projection', () => {
    const result = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...reportProjectionFixture,
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })

  test('rejects a report projection missing disposition_counts', () => {
    const { disposition_counts: _dispositionCounts, ...withoutCounts } =
      reportProjectionFixture
    const result = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...withoutCounts,
    })
    expect(result.success).toBe(false)
  })

  test('rejects a report projection missing queues', () => {
    const { queues: _queues, ...withoutQueues } = reportProjectionFixture
    const result = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...withoutQueues,
    })
    expect(result.success).toBe(false)
  })

  test('accepts a report projection that omits the optional risk_coverage', () => {
    const { risk_coverage: _riskCoverage, ...withoutRiskCoverage } =
      reportProjectionFixture
    const result = FinalizeOutputSchema.safeParse({
      kind: 'report_only',
      ...withoutRiskCoverage,
    })
    expect(result.success).toBe(true)
  })
})

// --- Run-level bounds -------------------------------------------------------
//
// Every run-level array is bounded by `MAX_RUN_FINDINGS` (or the facts
// aggregate), derived from what the upstream phase can emit. Each probe parses
// at its bound and rejects one past it with `too_big` at the exact path. The
// bounds come from the exported constants, never from literals.

type ProbePath = readonly (string | number)[]

interface Parsable {
  safeParse(value: unknown):
    | { readonly success: true }
    | {
        readonly success: false
        readonly error: {
          readonly issues: readonly {
            readonly code: string
            readonly path: readonly PropertyKey[]
          }[]
        }
      }
}

function tooBigPaths(schema: Parsable, value: unknown): string[] {
  const result = schema.safeParse(value)
  if (result.success) return []
  return result.error.issues
    .filter((issue) => issue.code === 'too_big')
    .map((issue) => JSON.stringify(issue.path))
}

function items<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index))
}

interface BoundProbe {
  readonly name: string
  readonly schema: Parsable
  readonly bound: number
  readonly path: ProbePath
  readonly build: (count: number) => unknown
}

const declinedDecisionAt = (index: number): JsonObject => ({
  ...declinedDecisionFixture,
  decision_id: `decision-${index}`,
  input_finding_id: `input-${index}`,
})

const mergedDecisionWith = (extra: JsonObject): JsonObject => ({
  ...mergedDecisionFixture,
  ...extra,
})

const group = (members: number): JsonObject => ({
  file: 'src/example.ts',
  members: items(members, (index) => ({ input_id: `input-${index}`, line: 1 })),
})

const queueEntry = (index: number): JsonObject => ({
  finding_id: `finding-${index}`,
  unconfirmed: false,
})

const projectionWith = (changes: JsonObject): JsonObject => ({
  ...reportProjectionFixture,
  kind: 'report_only',
  queues: { fixer: [], residual: [], report_only: [] },
  pre_existing_findings: [],
  ...changes,
})

const RUN_LEVEL_PROBES: BoundProbe[] = [
  {
    name: 'prepare candidate group members',
    schema: PrepareOutputSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['candidate_groups', 0, 'members'],
    build: (count) => ({
      ...prepareOutputFixture,
      candidate_groups: [group(count)],
    }),
  },
  {
    name: 'prepare candidate groups',
    schema: PrepareOutputSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['candidate_groups'],
    build: (count) => ({
      ...prepareOutputFixture,
      candidate_groups: items(count, () => group(2)),
    }),
  },
  {
    name: 'adjudication decisions',
    schema: AdjudicationEnvelopeSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['decisions'],
    build: (count) => ({ decisions: items(count, declinedDecisionAt) }),
  },
  {
    name: 'merged decision input finding IDs',
    schema: AdjudicationEnvelopeSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['decisions', 0, 'input_finding_ids'],
    build: (count) => ({
      decisions: [
        mergedDecisionWith({
          input_finding_ids: items(count, (index) => `input-${index}`),
        }),
      ],
    }),
  },
  {
    name: 'merged findings',
    schema: MergeOutputSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['merged_findings'],
    build: (count) => ({
      ...mergeOutputFixture,
      merged_findings: items(count, (index) => ({
        ...mergedFindingFixture,
        finding_id: `decision-${index}`,
      })),
    }),
  },
  {
    name: 'merged finding input finding IDs',
    schema: MergeOutputSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['merged_findings', 0, 'input_finding_ids'],
    build: (count) => ({
      ...mergeOutputFixture,
      merged_findings: [
        {
          ...mergedFindingFixture,
          input_finding_ids: items(count, (index) => `input-${index}`),
        },
      ],
    }),
  },
  {
    name: 'validator requests',
    schema: MergeOutputSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['validator_requests'],
    build: (count) => ({
      ...mergeOutputFixture,
      validator_requests: items(count, (index) => ({
        ...validatorRequestFixture,
        finding_id: `decision-${index}`,
      })),
    }),
  },
  {
    name: 'merge disagreement facts aggregate',
    schema: MergeOutputSchema,
    bound: MAX_RUN_DISAGREEMENT_FACTS,
    path: ['disagreement_facts'],
    build: (count) => ({
      ...mergeOutputFixture,
      disagreement_facts: items(count, () => 'The reviewers disagree.'),
    }),
  },
  {
    name: 'finalize input disagreement facts aggregate',
    schema: FinalizeInputSchema,
    bound: MAX_RUN_DISAGREEMENT_FACTS,
    path: ['merge', 'disagreement_facts'],
    build: (count) => ({
      ...finalizeInputFixture,
      merge: {
        ...mergeOutputFixture,
        disagreement_facts: items(count, () => 'The reviewers disagree.'),
      },
    }),
  },
  {
    name: 'validator lifecycle results',
    schema: ValidatorLifecycleResultsSchema,
    bound: MAX_RUN_FINDINGS,
    path: [],
    build: (count) =>
      items(count, (index) => ({
        finding_id: `decision-${index}`,
        result: { outcome: 'true' },
      })),
  },
  {
    name: 'plan assessment results',
    schema: PlanAssessmentEnvelopeSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['results'],
    build: (count) => ({
      ...planAssessmentFixture,
      results: items(count, () => ({
        kind: 'inferred_gap',
        description: 'A gap the plan left open.',
      })),
    }),
  },
  {
    name: 'parent run metadata applied fixes',
    schema: ParentRunMetadataSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['applied_fixes'],
    build: (count) => ({
      ...parentRunMetadataFixture,
      applied_fixes: items(count, () => 'Updated the example path.'),
    }),
  },
  ...(['fixer', 'residual', 'report_only'] as const).map(
    (queue): BoundProbe => ({
      name: `report queue ${queue}`,
      schema: FinalizeOutputSchema,
      bound: MAX_RUN_FINDINGS,
      path: ['queues', queue],
      build: (count) =>
        projectionWith({
          queues: {
            fixer: [],
            residual: [],
            report_only: [],
            [queue]: items(count, queueEntry),
          },
        }),
    }),
  ),
  {
    name: 'pre-existing findings',
    schema: FinalizeOutputSchema,
    bound: MAX_RUN_FINDINGS,
    path: ['pre_existing_findings'],
    build: (count) =>
      projectionWith({ pre_existing_findings: items(count, queueEntry) }),
  },
]

describe('run-level contract bounds', () => {
  test.each(RUN_LEVEL_PROBES)(
    '$name parses at its bound',
    ({ schema, bound, build }) => {
      expect(schema.safeParse(build(bound)).success).toBe(true)
    },
  )

  test.each(RUN_LEVEL_PROBES)(
    '$name rejects one past its bound with too_big at its path',
    ({ schema, bound, path, build }) => {
      expect(tooBigPaths(schema, build(bound + 1))).toContain(
        JSON.stringify(path),
      )
    },
  )

  test('one decision keeps its facts at the per-decision bound', () => {
    const decision = (disposition: 'merged' | 'declined', count: number) => ({
      decisions: [
        {
          ...(disposition === 'merged'
            ? mergedDecisionFixture
            : declinedDecisionFixture),
          disagreement_facts: items(count, () => 'The reviewers disagree.'),
        },
      ],
    })

    for (const disposition of ['merged', 'declined'] as const) {
      expect(
        AdjudicationEnvelopeSchema.safeParse(
          decision(disposition, MAX_DECISION_FACTS),
        ).success,
      ).toBe(true)
      expect(
        tooBigPaths(
          AdjudicationEnvelopeSchema,
          decision(disposition, MAX_DECISION_FACTS + 1),
        ),
      ).toContain(JSON.stringify(['decisions', 0, 'disagreement_facts']))
    }
  })

  test('the facts aggregate covers one declined reason plus the per-decision facts for every decision', () => {
    expect(MAX_DECISION_FACTS).toBe(MAX_FINDINGS)
    expect(MAX_RUN_FINDINGS).toBe(MAX_FINDINGS * MAX_PERSONAS)
    expect(MAX_RUN_DISAGREEMENT_FACTS).toBe(
      MAX_RUN_FINDINGS * (MAX_DECISION_FACTS + 1),
    )
  })

  test('the per-reviewer bounds keep their values', () => {
    const overFindings = {
      ...screenOutputFixture,
      admitted_findings: items(MAX_FINDINGS + 1, (index) => ({
        ...admittedFindingFixture,
        input_id: `correctness-${index}`,
      })),
    }
    expect(tooBigPaths(ScreenOutputSchema, overFindings)).toContain(
      JSON.stringify(['admitted_findings']),
    )
  })
})
