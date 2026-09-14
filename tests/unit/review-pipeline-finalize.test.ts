import { describe, expect, test } from 'bun:test'
import type {
  MergeOutput,
  ReconcileValidatorResultsInput,
} from '../../src/lib/review-pipeline.js'
import { reconcileValidatorResults } from '../../src/lib/review-pipeline.js'

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
