import { describe, expect, test } from 'bun:test'
import {
  MAX_FINDINGS,
  MAX_PERSONAS,
} from '../../src/lib/review-artifact-schema.js'
import {
  AGGREGATE_BYTE_CAP_HEADROOM,
  AGGREGATE_STDIN_BYTE_CAP,
  isRouteTransitionAllowed,
  PER_FINDING_BYTE_ASSUMPTION,
  PrepareInputSchema,
  PrepareOutputSchema,
  ROUTE_REFUSAL_TABLE,
  ScreenInputSchema,
  ScreenOutputSchema,
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

const prepareOutputFixture: JsonObject = {
  confidence_dispositions: [
    {
      input_id: 'correctness-0',
      disposition: 'surviving',
    },
  ],
  coverage_union: ['src/example.ts'],
  singletons: ['correctness-0'],
  candidate_groups: [],
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
          input_finding_ids: ['correctness-0', 'security-0'],
          extra: 'nope',
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
          input_finding_ids: ['correctness-0'],
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
          input_finding_ids: ['correctness-0', 'security-0'],
        },
      ],
    })
    expect(result.success).toBe(true)
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
