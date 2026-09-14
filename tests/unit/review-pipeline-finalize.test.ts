import { describe, expect, test } from 'bun:test'
import type {
  DeriveRiskCoverageInput,
  FinalizeReviewDispositionsInput,
  LostRiskCriticalPersona,
  MergeOutput,
  PlanAssessmentResult,
  PrepareOutput,
  ReconcileValidatorResultsInput,
  ReconcileValidatorResultsOutput,
  RunReviewPipelineInput,
} from '../../src/lib/review-pipeline.js'
import {
  deriveRiskCoverage,
  finalizeReviewDispositions,
  reconcileValidatorResults,
  routePlanAssessment,
  runReviewPipeline,
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
    confidence: 0.85,
    evidence: ['src/example.ts:1 demonstrates the issue.'],
    file: 'src/example.ts',
    finding_id: findingId,
    fingerprint: `src/example.ts:1:P1:${findingId}`,
    input_finding_ids: [`${findingId}-input`],
    line: 1,
    owner: 'downstream-resolver',
    pre_existing: false,
    requires_verification: true,
    severity: 'P1',
    submitters: ['correctness'],
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

function lostPersona(
  persona: string,
  overrides: Partial<LostRiskCriticalPersona> = {},
): LostRiskCriticalPersona {
  return {
    persona,
    selection_surface: ['src/example.ts'],
    ...overrides,
  }
}

function riskCoverageScenario(
  overrides: Partial<DeriveRiskCoverageInput> = {},
): DeriveRiskCoverageInput {
  return {
    lost_risk_critical_personas: [lostPersona('security')],
    prepared: preparedOutput(),
    reconciled: reconciledOutput(),
    ...overrides,
  }
}

describe('deriveRiskCoverage', () => {
  test('a cross-persona, on-surface, validated finding satisfies coverage and cites it', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'reliability')],
        }),
        reconciled: reconciledOutput({
          findings: [mergedFinding('f-cov', { input_finding_ids: ['cov#0'] })],
        }),
      }),
    )

    expect(result).toEqual([
      { persona: 'security', satisfied: true, finding_id: 'f-cov' },
    ])
  })

  test('a finding owned solely by the lost persona itself is unsatisfied', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'security')],
        }),
        reconciled: reconciledOutput({
          findings: [mergedFinding('f-cov', { input_finding_ids: ['cov#0'] })],
        }),
      }),
    )

    expect(result).toEqual([{ persona: 'security', satisfied: false }])
  })

  test('an off-surface finding does not satisfy coverage', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [
            survivingFinding('cov#0', 'reliability', { file: 'src/other.ts' }),
          ],
        }),
        reconciled: reconciledOutput({
          findings: [
            mergedFinding('f-cov', {
              input_finding_ids: ['cov#0'],
              file: 'src/other.ts',
            }),
          ],
        }),
      }),
    )

    expect(result).toEqual([{ persona: 'security', satisfied: false }])
  })

  test('a finding filtered by a false validation does not satisfy coverage', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'reliability')],
        }),
        reconciled: reconciledOutput({
          findings: [
            {
              ...mergedFinding('f-cov', { input_finding_ids: ['cov#0'] }),
              validated: false,
            },
          ],
          filtered_finding_ids: ['f-cov'],
          filtered_input_ids: ['cov#0'],
        }),
      }),
    )

    expect(result).toEqual([{ persona: 'security', satisfied: false }])
  })

  test('a validation-band finding with an unavailable validator does not satisfy coverage', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'reliability')],
        }),
        reconciled: reconciledOutput({
          findings: [mergedFinding('f-cov', { input_finding_ids: ['cov#0'] })],
          lifecycle_failures: [
            {
              finding_id: 'f-cov',
              outcome: 'unavailable',
              reason: 'validator not reachable',
            },
          ],
        }),
      }),
    )

    expect(result).toEqual([{ persona: 'security', satisfied: false }])
  })

  test('a validation-band finding with a true result satisfies coverage', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'reliability')],
        }),
        reconciled: reconciledOutput({
          findings: [
            {
              ...mergedFinding('f-cov', { input_finding_ids: ['cov#0'] }),
              validated: true,
            },
          ],
        }),
      }),
    )

    expect(result).toEqual([
      { persona: 'security', satisfied: true, finding_id: 'f-cov' },
    ])
  })

  test('a candidate outside the validation band needs no result to satisfy coverage', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'reliability')],
        }),
        reconciled: reconciledOutput({
          findings: [mergedFinding('f-cov', { input_finding_ids: ['cov#0'] })],
        }),
      }),
    )

    expect(result).toEqual([
      { persona: 'security', satisfied: true, finding_id: 'f-cov' },
    ])
  })

  test('citation among two eligible candidates is deterministic and stable under permuted input', () => {
    const prepared = preparedOutput({
      surviving_findings: [
        survivingFinding('a#0', 'reliability'),
        survivingFinding('b#0', 'performance'),
      ],
    })
    const findingHigh = mergedFinding('f-b', { input_finding_ids: ['a#0'] })
    const findingLow = mergedFinding('f-a', { input_finding_ids: ['b#0'] })

    const orderedResult = deriveRiskCoverage(
      riskCoverageScenario({
        prepared,
        reconciled: reconciledOutput({
          findings: [findingHigh, findingLow],
        }),
      }),
    )
    const permutedResult = deriveRiskCoverage(
      riskCoverageScenario({
        prepared,
        reconciled: reconciledOutput({
          findings: [findingLow, findingHigh],
        }),
      }),
    )

    expect(orderedResult).toEqual([
      { persona: 'security', satisfied: true, finding_id: 'f-a' },
    ])
    expect(orderedResult).toEqual(permutedResult)
  })

  test('no lost risk-critical persona produces empty coverage output rather than fabricated entries', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({ lost_risk_critical_personas: [] }),
    )

    expect(result).toEqual([])
  })
})

function planAssessmentResult(
  kind: PlanAssessmentResult['kind'],
  description: string,
): PlanAssessmentResult {
  return { kind, description }
}

describe('routePlanAssessment', () => {
  test('an explicit unmet requirement produces residual actionable work and gates the verdict', () => {
    const result = routePlanAssessment({
      results: [
        planAssessmentResult(
          'explicit_unmet_requirement',
          'Requirement R3 was not implemented.',
        ),
      ],
    })

    expect(result.residual_actionable_work).toEqual([
      'Requirement R3 was not implemented.',
    ])
    expect(result.advisory_outputs).toEqual([])
    expect(result.gated_by_explicit_unmet_requirement).toBe(true)
  })

  test('an inferred gap produces advisory output and does not gate the verdict by itself', () => {
    const result = routePlanAssessment({
      results: [
        planAssessmentResult(
          'inferred_gap',
          'The plan did not mention rate limiting, but it may be missing.',
        ),
      ],
    })

    expect(result.residual_actionable_work).toEqual([])
    expect(result.advisory_outputs).toEqual([
      'The plan did not mention rate limiting, but it may be missing.',
    ])
    expect(result.gated_by_explicit_unmet_requirement).toBe(false)
  })

  test('neither kind carries a persona input identifier, and neither appears in any reviewer findings collection', () => {
    const explicit = planAssessmentResult(
      'explicit_unmet_requirement',
      'Requirement R1 was not implemented.',
    )
    const inferred = planAssessmentResult(
      'inferred_gap',
      'Possible missing edge case.',
    )

    // PlanAssessmentResult has no input_id or reviewer field at all -- a
    // plan-assessment result cannot carry a persona input identifier by
    // construction, not merely by convention.
    expect('input_id' in explicit).toBe(false)
    expect('reviewer' in explicit).toBe(false)
    expect('input_id' in inferred).toBe(false)
    expect('reviewer' in inferred).toBe(false)

    const result = routePlanAssessment({ results: [explicit, inferred] })

    // The routed output never assembles anything resembling a reviewer
    // findings collection -- only the two plain string channels and the
    // gate flag.
    expect(Object.keys(result).sort()).toEqual([
      'advisory_outputs',
      'gated_by_explicit_unmet_requirement',
      'residual_actionable_work',
    ])
    // Every entry in both channels is a plain description string -- never a
    // structured object that could carry an input_id or reviewer field.
    for (const entry of [
      ...result.residual_actionable_work,
      ...result.advisory_outputs,
    ]) {
      expect(typeof entry).toBe('string')
    }
  })

  test('a review with no plan assessment produces empty residual and advisory output and does not gate the verdict', () => {
    const result = routePlanAssessment({ results: [] })

    expect(result.residual_actionable_work).toEqual([])
    expect(result.advisory_outputs).toEqual([])
    expect(result.gated_by_explicit_unmet_requirement).toBe(false)
  })

  test('a mix of explicit and inferred results routes each to the correct channel', () => {
    const result = routePlanAssessment({
      results: [
        planAssessmentResult(
          'explicit_unmet_requirement',
          'Requirement R2 was not implemented.',
        ),
        planAssessmentResult('inferred_gap', 'Possible missing test.'),
        planAssessmentResult(
          'explicit_unmet_requirement',
          'Requirement R1 was not implemented.',
        ),
        planAssessmentResult('inferred_gap', 'Another suspected gap.'),
      ],
    })

    expect(result.residual_actionable_work).toEqual([
      'Requirement R1 was not implemented.',
      'Requirement R2 was not implemented.',
    ])
    expect(result.advisory_outputs).toEqual([
      'Another suspected gap.',
      'Possible missing test.',
    ])
    expect(result.gated_by_explicit_unmet_requirement).toBe(true)
  })

  test('output is stable under permuted input order', () => {
    const results: readonly PlanAssessmentResult[] = [
      planAssessmentResult(
        'explicit_unmet_requirement',
        'Requirement R2 was not implemented.',
      ),
      planAssessmentResult('inferred_gap', 'Possible missing test.'),
      planAssessmentResult(
        'explicit_unmet_requirement',
        'Requirement R1 was not implemented.',
      ),
      planAssessmentResult('inferred_gap', 'Another suspected gap.'),
    ]

    const resultA = routePlanAssessment({ results })
    const resultB = routePlanAssessment({ results: [...results].reverse() })

    expect(resultA).toEqual(resultB)
  })
})

function runPipelineScenario(
  overrides: Partial<RunReviewPipelineInput> = {},
): RunReviewPipelineInput {
  return {
    merge: mergeOutput([], []),
    validator_lifecycle_results: [],
    prepared: preparedOutput(),
    rejected_payloads: [],
    lost_risk_critical_personas: [],
    plan_assessment: { results: [] },
    ...overrides,
  }
}

describe('runReviewPipeline', () => {
  test('a run with nothing blocking reaches a clean verdict', () => {
    const result = runReviewPipeline(runPipelineScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toEqual({ clean: true, blocking_reasons: [] })
  })

  test('an explicit unmet plan requirement alone withholds the verdict and names the reason', () => {
    const result = runReviewPipeline(
      runPipelineScenario({
        plan_assessment: {
          results: [
            planAssessmentResult(
              'explicit_unmet_requirement',
              'Requirement R1 was not implemented.',
            ),
          ],
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toEqual({
      clean: false,
      blocking_reasons: [
        {
          kind: 'explicit_unmet_plan_requirement',
          description: 'Requirement R1 was not implemented.',
        },
      ],
    })
  })

  test('unsatisfied risk-critical coverage alone withholds the verdict and names the persona', () => {
    const result = runReviewPipeline(
      runPipelineScenario({
        lost_risk_critical_personas: [lostPersona('security')],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.risk_coverage).toEqual([
      { persona: 'security', satisfied: false },
    ])
    expect(result.value.verdict).toEqual({
      clean: false,
      blocking_reasons: [
        { kind: 'unsatisfied_risk_coverage', persona: 'security' },
      ],
    })
  })

  test('a degraded run alone withholds the verdict and names the finding', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['f1-input'] })
    const merge = mergeOutput([finding], ['f1'])

    const result = runReviewPipeline(
      runPipelineScenario({
        merge,
        validator_lifecycle_results: [
          lifecycleResult('f1', {
            outcome: 'failed',
            reason: 'validator timed out',
          }),
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.reconciled.degraded).toBe(true)
    expect(result.value.verdict).toEqual({
      clean: false,
      blocking_reasons: [
        {
          kind: 'degraded_validator_lifecycle',
          finding_id: 'f1',
          outcome: 'failed',
        },
      ],
    })
  })

  test('two blocking reasons at once are both reported, not just the first', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['f1-input'] })
    const merge = mergeOutput([finding], ['f1'])

    const result = runReviewPipeline(
      runPipelineScenario({
        merge,
        validator_lifecycle_results: [
          lifecycleResult('f1', {
            outcome: 'unavailable',
            reason: 'validator not reachable',
          }),
        ],
        plan_assessment: {
          results: [
            planAssessmentResult(
              'explicit_unmet_requirement',
              'Requirement R1 was not implemented.',
            ),
          ],
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict.clean).toBe(false)
    expect(result.value.verdict.blocking_reasons).toEqual([
      {
        kind: 'explicit_unmet_plan_requirement',
        description: 'Requirement R1 was not implemented.',
      },
      {
        kind: 'degraded_validator_lifecycle',
        finding_id: 'f1',
        outcome: 'unavailable',
      },
    ])
  })

  test('a rejection from validator reconciliation aborts the run with no partial output', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['f1-input'] })
    const merge = mergeOutput([finding], ['f1'])

    const result = runReviewPipeline(
      runPipelineScenario({
        merge,
        validator_lifecycle_results: [],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('missing validator result')
    expect('value' in result).toBe(false)
    expect(Object.keys(result).sort()).toEqual(['ok', 'rejection'])
  })

  test('output is byte-identical under permuted input order', () => {
    const findingA = mergedFinding('f1', { input_finding_ids: ['f1-input'] })
    const findingB = mergedFinding('f2', { input_finding_ids: ['f2-input'] })
    const merge = mergeOutput([findingA, findingB], ['f1', 'f2'])

    const resultF1 = lifecycleResult('f1', {
      outcome: 'failed',
      reason: 'timed out',
    })
    const resultF2 = lifecycleResult('f2', {
      outcome: 'unavailable',
      reason: 'not reachable',
    })

    const lostPersonas = [lostPersona('security'), lostPersona('reliability')]
    const planResults = [
      planAssessmentResult('explicit_unmet_requirement', 'B requirement.'),
      planAssessmentResult('explicit_unmet_requirement', 'A requirement.'),
    ]

    const scenarioA = runPipelineScenario({
      merge,
      validator_lifecycle_results: [resultF1, resultF2],
      lost_risk_critical_personas: lostPersonas,
      plan_assessment: { results: planResults },
    })
    const scenarioB = runPipelineScenario({
      merge,
      validator_lifecycle_results: [resultF2, resultF1],
      lost_risk_critical_personas: [...lostPersonas].reverse(),
      plan_assessment: { results: [...planResults].reverse() },
    })

    const resultA = runReviewPipeline(scenarioA)
    const resultB = runReviewPipeline(scenarioB)

    expect(resultA).toEqual(resultB)
  })
})
