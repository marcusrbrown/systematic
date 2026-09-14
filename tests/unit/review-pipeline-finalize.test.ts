import { describe, expect, test } from 'bun:test'
import type {
  FinalizeReviewDispositionsInput,
  MergeOutput,
  PrepareOutput,
  ReconcileValidatorResultsInput,
  ReconcileValidatorResultsOutput,
} from '../../src/lib/review-pipeline.js'
import {
  finalizeReviewDispositions,
  reconcileValidatorResults,
} from '../../src/lib/review-pipeline.js'

type LifecycleResults =
  ReconcileValidatorResultsInput['validator_lifecycle_results']
type LifecycleResult = LifecycleResults[number]['result']

function mergedFinding(
  findingId: string,
  overrides: Partial<MergeOutput['merged_findings'][number]> = {},
): MergeOutput['merged_findings'][number] {
  return {
    autofix_class: 'gated_auto',
    evidence: ['src/example.ts:1 demonstrates the issue.'],
    file: 'src/example.ts',
    finding_id: findingId,
    input_finding_ids: [`${findingId}-input`],
    line: 1,
    owner: 'downstream-resolver',
    requires_verification: true,
    suggested_fix: 'Apply the fix.',
    title: 'Example issue',
    why_it_matters: 'The example path can fail during normal execution.',
    ...overrides,
  }
}

function mergeOutput(
  findings: readonly MergeOutput['merged_findings'][number][],
  requestedFindingIds: readonly string[],
): MergeOutput {
  const byId = new Map(findings.map((finding) => [finding.finding_id, finding]))
  return {
    disagreement_facts: [],
    merged_findings: [...findings],
    validator_requests: requestedFindingIds.map((findingId) => {
      const finding = byId.get(findingId)
      return {
        file: finding?.file ?? 'src/example.ts',
        finding_id: findingId,
        line: finding?.line ?? 1,
      }
    }),
  }
}

function lifecycleResult(
  findingId: string,
  result: LifecycleResult,
): LifecycleResults[number] {
  return { finding_id: findingId, result }
}

describe('reconcileValidatorResults', () => {
  test('a true result marks the finding validated and leaves it actionable', () => {
    const finding = mergedFinding('f1')
    const merge = mergeOutput([finding], ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [lifecycleResult('f1', { outcome: 'true' })],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.findings).toEqual([{ ...finding, validated: true }])
    expect(result.value.filtered_finding_ids).toEqual([])
    expect(result.value.filtered_input_ids).toEqual([])
    expect(result.value.lifecycle_failures).toEqual([])
    expect(result.value.degraded).toBe(false)
  })

  test('a false result filters the finding and every contributing input', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['a#0', 'b#0'] })
    const merge = mergeOutput([finding], ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [
        lifecycleResult('f1', {
          outcome: 'false',
          reason: 'disproven by validator',
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.findings).toEqual([{ ...finding, validated: false }])
    expect(result.value.filtered_finding_ids).toEqual(['f1'])
    expect(result.value.filtered_input_ids).toEqual(['a#0', 'b#0'])
    expect(result.value.lifecycle_failures).toEqual([])
    expect(result.value.degraded).toBe(false)
  })

  test('a failed result leaves validated absent, keeps the finding visible, records the failure, and degrades the run', () => {
    const finding = mergedFinding('f1')
    const merge = mergeOutput([finding], ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [
        lifecycleResult('f1', {
          outcome: 'failed',
          reason: 'validator timed out',
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.findings).toEqual([finding])
    const [reconciled] = result.value.findings
    expect(reconciled).toBeDefined()
    expect('validated' in (reconciled ?? {})).toBe(false)
    expect(result.value.filtered_finding_ids).toEqual([])
    expect(result.value.filtered_input_ids).toEqual([])
    expect(result.value.lifecycle_failures).toEqual([
      { finding_id: 'f1', outcome: 'failed', reason: 'validator timed out' },
    ])
    expect(result.value.degraded).toBe(true)
  })

  test('an unavailable result behaves the same way and is distinguishable from failed', () => {
    const finding = mergedFinding('f1')
    const merge = mergeOutput([finding], ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [
        lifecycleResult('f1', {
          outcome: 'unavailable',
          reason: 'validator not reachable',
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.findings).toEqual([finding])
    const [reconciled] = result.value.findings
    expect(reconciled).toBeDefined()
    expect('validated' in (reconciled ?? {})).toBe(false)
    expect(result.value.lifecycle_failures).toEqual([
      {
        finding_id: 'f1',
        outcome: 'unavailable',
        reason: 'validator not reachable',
      },
    ])
    expect(result.value.degraded).toBe(true)
  })

  test('an unrequested finding keeps validated absent and is distinguishable from an unavailable one', () => {
    const findings = [mergedFinding('f1'), mergedFinding('f2')]
    const merge = mergeOutput(findings, ['f2'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [
        lifecycleResult('f2', {
          outcome: 'unavailable',
          reason: 'validator not reachable',
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const f1 = result.value.findings.find(
      (finding) => finding.finding_id === 'f1',
    )
    expect(f1).toBeDefined()
    expect('validated' in (f1 as object)).toBe(false)
    // f1 was never requested, so it must not appear in lifecycle_failures --
    // that set is reserved for requested-but-uncertain findings.
    expect(
      result.value.lifecycle_failures.some(
        (failure) => failure.finding_id === 'f1',
      ),
    ).toBe(false)
    expect(result.value.lifecycle_failures).toEqual([
      {
        finding_id: 'f2',
        outcome: 'unavailable',
        reason: 'validator not reachable',
      },
    ])
  })

  test('a missing result for a requested finding is rejected', () => {
    const findings = [mergedFinding('f1')]
    const merge = mergeOutput(findings, ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('missing validator result')
    expect(result.rejection.path).toBe('validator_requests.0.finding_id')
  })

  test('a duplicate result is rejected', () => {
    const findings = [mergedFinding('f1')]
    const merge = mergeOutput(findings, ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [
        lifecycleResult('f1', { outcome: 'true' }),
        lifecycleResult('f1', { outcome: 'true' }),
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('duplicate validator result')
    expect(result.rejection.path).toBe(
      'validator_lifecycle_results.1.finding_id',
    )
  })

  test('a result for an unrequested finding is rejected', () => {
    const findings = [mergedFinding('f1')]
    const merge = mergeOutput(findings, [])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [lifecycleResult('f1', { outcome: 'true' })],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('unrequested validator result')
    expect(result.rejection.path).toBe(
      'validator_lifecycle_results.0.finding_id',
    )
  })

  test('output is stable under permuted result order', () => {
    const findings = [
      mergedFinding('f1', { input_finding_ids: ['a#0'] }),
      mergedFinding('f2', { input_finding_ids: ['b#0'] }),
      mergedFinding('f3', { input_finding_ids: ['c#0'] }),
    ]
    const merge = mergeOutput(findings, ['f1', 'f2', 'f3'])
    const resultF1 = lifecycleResult('f1', { outcome: 'true' })
    const resultF2 = lifecycleResult('f2', {
      outcome: 'false',
      reason: 'disproven',
    })
    const resultF3 = lifecycleResult('f3', {
      outcome: 'failed',
      reason: 'timed out',
    })
    const resultsA: LifecycleResults = [resultF1, resultF2, resultF3]
    const resultsB: LifecycleResults = [resultF3, resultF1, resultF2]

    const outputA = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: resultsA,
    })
    const outputB = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: resultsB,
    })

    expect(outputA.ok).toBe(true)
    expect(outputB.ok).toBe(true)
    if (!outputA.ok || !outputB.ok) return
    expect(outputA.value).toEqual(outputB.value)
  })
})

function survivingFinding(
  inputId: string,
  reviewer: string,
  overrides: Partial<PrepareOutput['surviving_findings'][number]> = {},
): PrepareOutput['surviving_findings'][number] {
  return {
    input_id: inputId,
    reviewer,
    title: 'Example issue',
    severity: 'P2',
    file: 'src/example.ts',
    line: 1,
    why_it_matters: 'The example path can fail during normal execution.',
    autofix_class: 'gated_auto',
    owner: 'downstream-resolver',
    requires_verification: true,
    confidence: 0.8,
    evidence: ['src/example.ts:1 demonstrates the issue.'],
    pre_existing: false,
    disposition: 'surviving',
    ...overrides,
  }
}

function confidenceDisposition(
  inputId: string,
  disposition: 'surviving' | 'suppressed',
  overrides: Partial<PrepareOutput['confidence_dispositions'][number]> = {},
): PrepareOutput['confidence_dispositions'][number] {
  return {
    input_id: inputId,
    disposition,
    confidence: 0.8,
    ...overrides,
  }
}

function preparedOutput(overrides: Partial<PrepareOutput> = {}): PrepareOutput {
  return {
    confidence_dispositions: [],
    coverage_union: [],
    singletons: [],
    candidate_groups: [],
    surviving_findings: [],
    ...overrides,
  }
}

function reconciledOutput(
  overrides: Partial<ReconcileValidatorResultsOutput> = {},
): ReconcileValidatorResultsOutput {
  return {
    findings: [],
    filtered_finding_ids: [],
    filtered_input_ids: [],
    lifecycle_failures: [],
    degraded: false,
    ...overrides,
  }
}

describe('finalizeReviewDispositions', () => {
  function buildScenario(): FinalizeReviewDispositionsInput {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('r1#0', 'surviving'),
        confidenceDisposition('r2#0', 'surviving'),
        confidenceDisposition('r2#1', 'surviving'),
        confidenceDisposition('r3#0', 'suppressed', {
          reason: 'confidence below gate threshold',
        }),
        confidenceDisposition('r4#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('r1#0', 'r1', { pre_existing: false }),
        survivingFinding('r2#0', 'r2', { pre_existing: true }),
        survivingFinding('r2#1', 'r2', { pre_existing: true }),
        survivingFinding('r4#0', 'r4', { pre_existing: false }),
      ],
    })

    const reconciled = reconciledOutput({
      findings: [
        mergedFinding('f-single', {
          input_finding_ids: ['r1#0'],
          owner: 'review-fixer',
        }),
        mergedFinding('f-merged', {
          input_finding_ids: ['r2#0', 'r2#1'],
          owner: 'downstream-resolver',
        }),
        mergedFinding('f-filtered', {
          input_finding_ids: ['r4#0'],
          owner: 'human',
        }),
      ],
      filtered_finding_ids: ['f-filtered'],
      filtered_input_ids: ['r4#0'],
    })

    return {
      prepared,
      reconciled,
      rejected_payloads: [{ rejected_finding_count: 3 }],
    }
  }

  test('every admitted input receives exactly one disposition', () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.input_dispositions).toEqual([
      { input_id: 'r1#0', disposition: 'surviving' },
      { input_id: 'r2#0', disposition: 'merged' },
      { input_id: 'r2#1', disposition: 'merged' },
      {
        input_id: 'r3#0',
        disposition: 'suppressed',
        reason: 'confidence below gate threshold',
      },
      { input_id: 'r4#0', disposition: 'filtered' },
    ])
    const ids = result.input_dispositions.map((entry) => entry.input_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('disposition counts sum to findings observed, including a weighted rejected-payload entry', () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.disposition_counts).toEqual({
      surviving: 1,
      merged: 2,
      suppressed: 1,
      filtered: 1,
      rejected: 3,
    })

    const admittedObserved =
      buildScenario().prepared.confidence_dispositions.length
    const rejectedObserved = buildScenario().rejected_payloads.reduce(
      (total, payload) => total + payload.rejected_finding_count,
      0,
    )
    const { surviving, merged, suppressed, filtered, rejected } =
      result.disposition_counts
    expect(surviving + merged + suppressed + filtered + rejected).toBe(
      admittedObserved + rejectedObserved,
    )
  })

  test('pre-existing findings are separated from newly introduced ones', () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.pre_existing_findings).toEqual([
      { finding_id: 'f-merged', unconfirmed: false },
    ])
    expect(result.new_findings).toEqual([
      { finding_id: 'f-single', unconfirmed: false },
    ])
  })

  test('a filtered finding enters no queue', () => {
    const result = finalizeReviewDispositions(buildScenario())

    const allQueued = [
      ...result.queues.fixer,
      ...result.queues.residual,
      ...result.queues.report_only,
    ]
    expect(allQueued.some((entry) => entry.finding_id === 'f-filtered')).toBe(
      false,
    )
    expect(
      result.pre_existing_findings.some(
        (entry) => entry.finding_id === 'f-filtered',
      ),
    ).toBe(false)
    expect(
      result.new_findings.some((entry) => entry.finding_id === 'f-filtered'),
    ).toBe(false)
  })

  test('queues are mutually exclusive and collectively cover every actionable finding', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('a#0', 'surviving'),
        confidenceDisposition('b#0', 'surviving'),
        confidenceDisposition('c#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('a#0', 'a'),
        survivingFinding('b#0', 'b'),
        survivingFinding('c#0', 'c'),
      ],
    })
    const reconciled = reconciledOutput({
      findings: [
        mergedFinding('f-fixer', {
          input_finding_ids: ['a#0'],
          owner: 'review-fixer',
        }),
        mergedFinding('f-human', {
          input_finding_ids: ['b#0'],
          owner: 'human',
        }),
        mergedFinding('f-release', {
          input_finding_ids: ['c#0'],
          owner: 'release',
        }),
      ],
    })

    const result = finalizeReviewDispositions({
      prepared,
      reconciled,
      rejected_payloads: [],
    })

    const queueLists = [
      result.queues.fixer,
      result.queues.residual,
      result.queues.report_only,
    ]
    const seen = new Set<string>()
    for (const queue of queueLists) {
      for (const entry of queue) {
        expect(seen.has(entry.finding_id)).toBe(false)
        seen.add(entry.finding_id)
      }
    }
    expect(seen).toEqual(
      new Set(result.new_findings.map((entry) => entry.finding_id)),
    )
    expect(result.queues.fixer.map((entry) => entry.finding_id)).toEqual([
      'f-fixer',
    ])
    expect(result.queues.residual.map((entry) => entry.finding_id)).toEqual([
      'f-human',
    ])
    expect(result.queues.report_only.map((entry) => entry.finding_id)).toEqual([
      'f-release',
    ])
  })

  test('a finding whose validator was unavailable still appears in a queue and stays marked unconfirmed', () => {
    const scenario = buildScenario()
    const result = finalizeReviewDispositions({
      ...scenario,
      reconciled: {
        ...scenario.reconciled,
        lifecycle_failures: [
          {
            finding_id: 'f-single',
            outcome: 'unavailable',
            reason: 'validator not reachable',
          },
        ],
      },
    })

    expect(result.queues.fixer).toEqual([
      { finding_id: 'f-single', unconfirmed: true },
    ])
  })

  test('output is byte-identical under permuted input order', () => {
    const scenario = buildScenario()
    const permuted: FinalizeReviewDispositionsInput = {
      prepared: {
        ...scenario.prepared,
        confidence_dispositions: [
          ...scenario.prepared.confidence_dispositions,
        ].reverse(),
        surviving_findings: [...scenario.prepared.surviving_findings].reverse(),
      },
      reconciled: {
        ...scenario.reconciled,
        findings: [...scenario.reconciled.findings].reverse(),
      },
      rejected_payloads: [...scenario.rejected_payloads].reverse(),
    }

    const resultA = finalizeReviewDispositions(scenario)
    const resultB = finalizeReviewDispositions(permuted)

    expect(resultA).toEqual(resultB)
  })
})
