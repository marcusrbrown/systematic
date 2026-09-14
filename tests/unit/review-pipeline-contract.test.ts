import { describe, expect, test } from 'bun:test'
import {
  MAX_FINDINGS,
  MAX_PERSONAS,
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

describe('AGGREGATE_STDIN_BYTE_CAP', () => {
  test('equals its stated formula', () => {
    expect(AGGREGATE_STDIN_BYTE_CAP).toBe(
      MAX_PERSONAS * MAX_FINDINGS * PER_FINDING_BYTE_ASSUMPTION +
        AGGREGATE_BYTE_CAP_HEADROOM,
    )
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
