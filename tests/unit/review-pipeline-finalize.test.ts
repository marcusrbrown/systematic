import { describe, expect, test } from 'bun:test'
import { ReviewArtifactSchema } from '../../src/lib/review-artifact-schema.js'
import type {
  ApplyReviewAdjudicationInput,
  BuildReviewCoverageInput,
  DeriveFinalizeContextInput,
  DeriveRiskCoverageInput,
  FinalizeReviewDispositionsInput,
  FinalizeReviewInput,
  InputLedgerRow,
  LostRiskCriticalPersona,
  MergeOutput,
  PlanAssessmentResult,
  PrepareOutput,
  ProjectSynthesizedFindingsInput,
  ReconcileValidatorResultsInput,
  ReconcileValidatorResultsOutput,
  RunReviewPipelineInput,
} from '../../src/lib/review-pipeline.js'
import {
  applyReviewAdjudication,
  buildInputLedger,
  buildReviewCoverage,
  checkDispositionCountsReconcileLedger,
  checkRiskCoverageSemantics,
  deriveFinalizeContext,
  deriveRiskCoverage,
  finalizeReview,
  finalizeReviewDispositions,
  projectSynthesizedFindings,
  reconcileValidatorResults,
  routePlanAssessment,
  runReviewPipeline,
} from '../../src/lib/review-pipeline.js'
import { FinalizeOutputSchema } from '../../src/lib/review-pipeline-contract.js'

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

  test('a false result filters the finding, carries the reason as validation_reason, and filters every contributing input', () => {
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
    expect(result.value.findings).toEqual([
      {
        ...finding,
        validated: false,
        validation_reason: 'disproven by validator',
      },
    ])
    expect(result.value.filtered_finding_ids).toEqual(['f1'])
    expect(result.value.filtered_input_ids).toEqual(['a#0', 'b#0'])
    expect(result.value.lifecycle_failures).toEqual([])
    expect(result.value.degraded).toBe(false)
  })

  test('a true result carries no validation_reason', () => {
    const finding = mergedFinding('f1')
    const merge = mergeOutput([finding], ['f1'])
    const result = reconcileValidatorResults({
      merge,
      validator_lifecycle_results: [lifecycleResult('f1', { outcome: 'true' })],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [reconciled] = result.value.findings
    expect(reconciled).toBeDefined()
    expect('validation_reason' in (reconciled ?? {})).toBe(false)
  })

  test('failed and unavailable outcomes record a lifecycle failure without a validation_reason on the finding', () => {
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
    const [reconciled] = result.value.findings
    expect(reconciled).toBeDefined()
    expect('validation_reason' in (reconciled ?? {})).toBe(false)
    expect(result.value.lifecycle_failures).toEqual([
      { finding_id: 'f1', outcome: 'failed', reason: 'validator timed out' },
    ])
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

type FinalizeScreenResultFixture =
  DeriveFinalizeContextInput['screen_results'][number]
type FinalizeDispatchRecordFixture =
  DeriveFinalizeContextInput['dispatch_records'][number]

function financeScreenResult(
  reviewer: string,
  overrides: Partial<FinalizeScreenResultFixture['result']> = {},
): FinalizeScreenResultFixture {
  return {
    reviewer,
    result: {
      admitted_findings: [],
      dispatch_outcome: 'findings',
      harness: 'opencode',
      residual_risks: [],
      testing_gaps: [],
      ...overrides,
    },
  }
}

function dispatchRecord(
  persona: string,
  overrides: Partial<FinalizeDispatchRecordFixture> = {},
): FinalizeDispatchRecordFixture {
  return {
    persona,
    dispatch_outcome: 'findings',
    ...overrides,
  }
}

// `deriveFinalizeContext` only accepts a `not_attempted` validation envelope
// (item 011): the persisted artifact is built before artifact
// self-validation can run, so this is the only truthful pre-write value.
const NOT_ATTEMPTED_VALIDATION = {
  status: 'not_attempted' as const,
  reason: 'no autofix applied',
}

function buildAdjudicatedMergeOutput(prepared: PrepareOutput): MergeOutput {
  const decisions: ApplyReviewAdjudicationInput['decisions'] = []
  const result = applyReviewAdjudication({ prepared, decisions })
  if (!result.ok) {
    throw new Error('test fixture: unexpected adjudication rejection')
  }
  return result.value
}

function finalizeContextScenario(): DeriveFinalizeContextInput {
  const prepared = preparedOutput({
    confidence_dispositions: [
      confidenceDisposition('correctness#0', 'surviving'),
    ],
    surviving_findings: [survivingFinding('correctness#0', 'correctness')],
    singletons: ['correctness#0'],
  })
  const merge = buildAdjudicatedMergeOutput(prepared)

  return {
    merge,
    prepared,
    screen_results: [
      financeScreenResult('correctness', {
        admitted_findings: [admittedScreenFinding('correctness#0')],
      }),
    ],
    dispatch_records: [dispatchRecord('correctness')],
    parent_run_metadata: {
      selected_dispatches: [dispatchRecord('correctness')],
      validation: NOT_ATTEMPTED_VALIDATION,
    },
  }
}

describe('deriveFinalizeContext', () => {
  test('a clean, well-formed envelope produces no rejected payloads and no lost personas', () => {
    const result = deriveFinalizeContext(finalizeContextScenario())

    expect(result).toEqual({
      ok: true,
      value: { rejected_payloads: [], lost_risk_critical_personas: [] },
    })
  })

  test('a carried route that narrows owner from review-fixer to release is accepted, and its reason is carried onto the merged finding', () => {
    // Updated for the route-narrowing-reason fix: `MergedFindingSchema` now
    // carries the model's real `route_narrowing_reason` on the merge wire
    // (`review-pipeline-contract.ts`), and the KTD19 verifier
    // (`checkMergedFindingsMatchDerivation`, via `mergedFindingRouteReasonMismatch`
    // and `mergedFindingDivergesFromDerivation`) checks that real reason
    // against the route meet instead of a fabricated placeholder. A P0
    // finding whose declined decision narrows `owner` all the way to
    // `release` -- moving it from the fixer queue to report_only -- is
    // accepted here because the narrowing is real *and* its reason is
    // carried through untouched, satisfying the new pairing check.
    // `OWNER_NARROWS_TO` treats `release` as the terminal, most-conservative
    // owner, so narrowing toward it is the same "always allow narrowing,
    // never allow widening" rule every other route field follows -- and now
    // the original narrowing reason survives merge instead of being lost.
    //
    // A declined decision must cite an eligible *candidate-group* member --
    // `validateAdjudication` rejects any decision at all when
    // `prepared.candidate_groups` is empty (`'unexpected decisions for empty
    // candidate set'`), and a passthrough `singletons` entry never needs (or
    // accepts) a decision citing it. So the P0 finding under test is placed
    // in a two-member candidate group alongside an unrelated `security#0`
    // finding, which is declined plainly (no route narrowing) purely to
    // satisfy `validateNoOmissions` -- every eligible group member must be
    // cited by exactly one decision, merged or declined.
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
        confidenceDisposition('security#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', {
          owner: 'review-fixer',
          severity: 'P0',
        }),
        survivingFinding('security#0', 'security'),
      ],
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness#0', line: 1 },
            { input_id: 'security#0', line: 1 },
          ],
        },
      ],
    })
    const decisions: ApplyReviewAdjudicationInput['decisions'] = [
      {
        decision_id: 'declined-narrowed-0',
        disposition: 'declined',
        input_finding_id: 'correctness#0',
        declined_reason: 'Escalated to release per policy, not auto-fixed.',
        proposed_route: {
          autofix_class: 'advisory',
          owner: 'release',
          requires_verification: true,
        },
        route_narrowing_reason: 'Escalated to release per policy.',
      },
      {
        decision_id: 'declined-plain-0',
        disposition: 'declined',
        input_finding_id: 'security#0',
        declined_reason: 'Not corroborated by another reviewer.',
      },
    ]
    const mergeResult = applyReviewAdjudication({ prepared, decisions })
    expect(mergeResult.ok).toBe(true)
    if (!mergeResult.ok) return
    expect(mergeResult.value.merged_findings).toHaveLength(2)
    const narrowed = mergeResult.value.merged_findings.find(
      (finding) => finding.finding_id === 'declined-narrowed-0',
    )
    expect(narrowed?.owner).toBe('release')
    expect(narrowed?.route_narrowing_reason).toBe(
      'Escalated to release per policy.',
    )
    const plain = mergeResult.value.merged_findings.find(
      (finding) => finding.finding_id === 'declined-plain-0',
    )
    expect('route_narrowing_reason' in (plain ?? {})).toBe(false)

    const result = deriveFinalizeContext({
      merge: mergeResult.value,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', { severity: 'P0' }),
          ],
        }),
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0')],
        }),
      ],
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('security'),
      ],
      parent_run_metadata: {
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security'),
        ],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    })

    expect(result.ok).toBe(true)
  })

  test('a merged finding whose route narrows from the meet but carries no route_narrowing_reason rejects', () => {
    // Before the fix, `mergedFindingDivergesFromDerivation` always fabricated
    // a placeholder `route_narrowing_reason` before re-deriving, so this case
    // silently passed at finalize no matter what the carried finding actually
    // carried. The fabrication is gone; a narrowed route with no real reason
    // now rejects.
    const scenario = finalizeContextScenario()
    const merge: MergeOutput = {
      ...scenario.merge,
      merged_findings: scenario.merge.merged_findings.map((finding) =>
        finding.finding_id === 'correctness#0'
          ? { ...finding, owner: 'release' }
          : finding,
      ),
    }

    const result = deriveFinalizeContext({ ...scenario, merge })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding route narrowing reason mismatch',
    )
  })

  test('a merged finding whose route equals the meet but carries a route_narrowing_reason rejects', () => {
    // A reason with no real narrowing is a false provenance claim -- the
    // route-meet/reason pairing must hold in both directions.
    const scenario = finalizeContextScenario()
    const merge: MergeOutput = {
      ...scenario.merge,
      merged_findings: scenario.merge.merged_findings.map((finding) =>
        finding.finding_id === 'correctness#0'
          ? { ...finding, route_narrowing_reason: 'Not actually narrower.' }
          : finding,
      ),
    }

    const result = deriveFinalizeContext({ ...scenario, merge })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding route narrowing reason mismatch',
    )
  })

  test('a survivor missing from the merged findings rejects', () => {
    const scenario = finalizeContextScenario()
    const prepared: PrepareOutput = {
      ...scenario.prepared,
      confidence_dispositions: [
        ...scenario.prepared.confidence_dispositions,
        confidenceDisposition('correctness#1', 'surviving'),
      ],
      surviving_findings: [
        ...scenario.prepared.surviving_findings,
        survivingFinding('correctness#1', 'correctness'),
      ],
    }

    const result = deriveFinalizeContext({ ...scenario, prepared })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('survivor missing from merge inputs')
  })

  test('a duplicate merged finding ID rejects', () => {
    const scenario = finalizeContextScenario()
    const merge: MergeOutput = {
      ...scenario.merge,
      merged_findings: [
        ...scenario.merge.merged_findings,
        ...scenario.merge.merged_findings,
      ],
    }

    const result = deriveFinalizeContext({ ...scenario, merge })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('duplicate merged finding ID')
  })

  test('a selected dispatch with no screen result rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({ ...scenario, screen_results: [] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'screen result missing for selected persona',
    )
  })

  test('dispatch_records disagreeing with parent_run_metadata.selected_dispatches rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      dispatch_records: [
        dispatchRecord('correctness', { dispatch_outcome: 'empty' }),
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('dispatch record mismatch')
  })

  test('a tampered carried severity rejects', () => {
    const scenario = finalizeContextScenario()
    const merge: MergeOutput = {
      ...scenario.merge,
      merged_findings: scenario.merge.merged_findings.map((finding) => ({
        ...finding,
        severity: 'P0',
      })),
    }

    const result = deriveFinalizeContext({ ...scenario, merge })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding fields diverge from derivation',
    )
  })

  test('each always-lost dispatch outcome marks a selected risk-critical persona lost', () => {
    for (const dispatchOutcome of [
      'malformed',
      'never_returned',
      'validation_unavailable',
    ] as const) {
      const record = dispatchRecord('security', {
        dispatch_outcome: dispatchOutcome,
        selection_surface: ['src/auth.ts'],
      })
      const scenario: DeriveFinalizeContextInput = {
        merge: mergeOutput([], []),
        prepared: preparedOutput(),
        screen_results: [
          financeScreenResult('security', {
            dispatch_outcome: dispatchOutcome,
          }),
        ],
        dispatch_records: [record],
        parent_run_metadata: {
          selected_dispatches: [record],
          validation: NOT_ATTEMPTED_VALIDATION,
        },
      }

      const result = deriveFinalizeContext(scenario)

      expect(result.ok, dispatchOutcome).toBe(true)
      if (!result.ok) continue
      expect(result.value.lost_risk_critical_personas).toEqual([
        { persona: 'security', selection_surface: ['src/auth.ts'] },
      ])
    }
  })

  test('a rejected summary carrying P0, P1, or unknown severities is a loss even when the dispatch outcome is findings', () => {
    const record = dispatchRecord('security', {
      dispatch_outcome: 'findings',
      selection_surface: ['src/auth.ts'],
    })
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput([], []),
      prepared: preparedOutput(),
      screen_results: [
        financeScreenResult('security', {
          dispatch_outcome: 'findings',
          rejected_summary: {
            dispatch_outcome: 'malformed',
            rejected_finding_count: 1,
            rejected_severities: ['P1'],
            reason: 'One finding failed schema validation.',
          },
        }),
      ],
      dispatch_records: [record],
      parent_run_metadata: {
        selected_dispatches: [record],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lost_risk_critical_personas).toEqual([
      { persona: 'security', selection_surface: ['src/auth.ts'] },
    ])
    expect(result.value.rejected_payloads).toEqual([
      { rejected_finding_count: 1 },
    ])
  })

  test('a P2/P3-only partial rejection is not a loss', () => {
    const record = dispatchRecord('security', {
      dispatch_outcome: 'findings',
      selection_surface: ['src/auth.ts'],
    })
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput([], []),
      prepared: preparedOutput(),
      screen_results: [
        financeScreenResult('security', {
          dispatch_outcome: 'findings',
          rejected_summary: {
            dispatch_outcome: 'malformed',
            rejected_finding_count: 2,
            rejected_severities: ['P2', 'P3'],
            reason: 'Two findings failed schema validation.',
          },
        }),
      ],
      dispatch_records: [record],
      parent_run_metadata: {
        selected_dispatches: [record],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lost_risk_critical_personas).toEqual([])
    expect(result.value.rejected_payloads).toEqual([
      { rejected_finding_count: 2 },
    ])
  })

  test('a duplicate persona in dispatch_records with a missing selected persona rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('correctness'),
      ],
      parent_run_metadata: {
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security'),
        ],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('dispatch record mismatch')
  })

  test('removing the validator request for a P1 finding rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', { severity: 'P1' }),
      ],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: DeriveFinalizeContextInput = {
      merge: { ...merge, validator_requests: [] },
      prepared,
      screen_results: [financeScreenResult('correctness')],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'validator request references unknown merged finding',
    )
  })

  test('two merged findings citing the same input ID rejects', () => {
    const survivor = survivingFinding('correctness#0', 'correctness')
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput(
        [
          mergedFinding('finding-a', { input_finding_ids: ['correctness#0'] }),
          mergedFinding('finding-b', { input_finding_ids: ['correctness#0'] }),
        ],
        [],
      ),
      prepared: preparedOutput({
        confidence_dispositions: [
          confidenceDisposition('correctness#0', 'surviving'),
        ],
        surviving_findings: [survivor],
        singletons: ['correctness#0'],
      }),
      screen_results: [financeScreenResult('correctness')],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'survivor claimed by multiple merged findings',
    )
  })

  test('a merged finding file diverging from its contributing survivor rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', {
          requires_verification: false,
          severity: 'P2',
        }),
      ],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)
    const tampered: MergeOutput = {
      ...merge,
      merged_findings: merge.merged_findings.map((finding, index) =>
        index === 0 ? { ...finding, file: 'src/other.ts' } : finding,
      ),
    }

    const scenario: DeriveFinalizeContextInput = {
      merge: tampered,
      prepared,
      screen_results: [financeScreenResult('correctness')],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding fields diverge from derivation',
    )
  })

  test('a merged finding line not matching any contributing survivor rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
        confidenceDisposition('security#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', { line: 5 }),
        survivingFinding('security#0', 'security', { line: 9 }),
      ],
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness#0', line: 5 },
            { input_id: 'security#0', line: 9 },
          ],
        },
      ],
    })
    const decisions: ApplyReviewAdjudicationInput['decisions'] = [
      {
        decision_id: 'merge-1',
        disposition: 'merged',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 9,
        title: 'Duplicate finding across reviewers',
        why_it_matters: 'Both reviewers independently caught the same defect.',
        evidence: [
          'src/example.ts:9 shows both reviewers flagged the same defect.',
        ],
        suggested_fix: 'Apply the shared fix once.',
      },
    ]
    const adjudicated = applyReviewAdjudication({ prepared, decisions })
    if (!adjudicated.ok) {
      throw new Error('test fixture: unexpected adjudication rejection')
    }
    const merge = adjudicated.value
    const tampered: MergeOutput = {
      ...merge,
      merged_findings: merge.merged_findings.map((finding) =>
        finding.finding_id === 'merge-1'
          ? {
              ...finding,
              line: 42,
              fingerprint: `${finding.file}:42:${finding.severity}`,
            }
          : finding,
      ),
      validator_requests: merge.validator_requests.map((request) =>
        request.finding_id === 'merge-1' ? { ...request, line: 42 } : request,
      ),
    }

    const scenario: DeriveFinalizeContextInput = {
      merge: tampered,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [admittedScreenFinding('correctness#0')],
        }),
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0')],
        }),
      ],
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('security'),
      ],
      parent_run_metadata: {
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security'),
        ],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding fields diverge from derivation',
    )
  })

  test('a merged finding line matching a non-first contributing survivor accepts', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
        confidenceDisposition('security#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', { line: 5 }),
        survivingFinding('security#0', 'security', { line: 9 }),
      ],
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness#0', line: 5 },
            { input_id: 'security#0', line: 9 },
          ],
        },
      ],
    })
    // The decision's representative line (9) is `security#0`'s line, the
    // *second* survivor once sorted by input ID (`correctness#0` <
    // `security#0`) -- proving the check does not just special-case the
    // first contributing survivor.
    const decisions: ApplyReviewAdjudicationInput['decisions'] = [
      {
        decision_id: 'merge-1',
        disposition: 'merged',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 9,
        title: 'Duplicate finding across reviewers',
        why_it_matters: 'Both reviewers independently caught the same defect.',
        evidence: [
          'src/example.ts:9 shows both reviewers flagged the same defect.',
        ],
        suggested_fix: 'Apply the shared fix once.',
      },
    ]
    const adjudicated = applyReviewAdjudication({ prepared, decisions })
    if (!adjudicated.ok) {
      throw new Error('test fixture: unexpected adjudication rejection')
    }

    const scenario: DeriveFinalizeContextInput = {
      merge: adjudicated.value,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', { line: 5 }),
          ],
        }),
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0', { line: 9 })],
        }),
      ],
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('security'),
      ],
      parent_run_metadata: {
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security'),
        ],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
  })

  test('a fabricated agreement_credit laundering a matching confidence boost rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
        confidenceDisposition('security#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness'),
        survivingFinding('security#0', 'security'),
      ],
      singletons: ['correctness#0', 'security#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)
    // `correctness#0` is a true passthrough singleton (one submitter,
    // `correctness`). `security` genuinely returned in this run (its own
    // singleton, `security#0`) but never contributed to `correctness#0`, so
    // crediting it here is fabricated -- and the +0.10 confidence bump is
    // recomputed to stay self-consistent with the fabricated credit.
    const tampered: MergeOutput = {
      ...merge,
      merged_findings: merge.merged_findings.map((finding) =>
        finding.finding_id === 'correctness#0'
          ? { ...finding, agreement_credit: ['security'], confidence: 0.9 }
          : finding,
      ),
    }

    const scenario: DeriveFinalizeContextInput = {
      merge: tampered,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [admittedScreenFinding('correctness#0')],
        }),
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0')],
        }),
      ],
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('security'),
      ],
      parent_run_metadata: {
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security'),
        ],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding fields diverge from derivation',
    )
  })

  test('a legitimately credited merged finding is accepted with its boosted confidence', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
        confidenceDisposition('security#0', 'surviving'),
        confidenceDisposition('testing#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness'),
        survivingFinding('security#0', 'security'),
        survivingFinding('testing#0', 'testing', { file: 'src/other.ts' }),
      ],
      candidate_groups: [
        {
          file: 'src/example.ts',
          members: [
            { input_id: 'correctness#0', line: 1 },
            { input_id: 'security#0', line: 1 },
          ],
        },
      ],
      singletons: ['testing#0'],
    })
    // `testing` genuinely returned (its own singleton, `testing#0`) and is
    // not a submitter of the merged group, so crediting it is legitimate --
    // exactly what `deriveMergedFindingFields` itself would produce.
    const decisions: ApplyReviewAdjudicationInput['decisions'] = [
      {
        decision_id: 'merge-1',
        disposition: 'merged',
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 1,
        title: 'Duplicate finding across reviewers',
        why_it_matters: 'Both reviewers independently caught the same defect.',
        evidence: [
          'src/example.ts:1 shows both reviewers flagged the same defect.',
        ],
        suggested_fix: 'Apply the shared fix once.',
        eligible_agreement_credit: ['testing'],
      },
    ]
    const adjudicated = applyReviewAdjudication({ prepared, decisions })
    if (!adjudicated.ok) {
      throw new Error('test fixture: unexpected adjudication rejection')
    }

    const scenario: DeriveFinalizeContextInput = {
      merge: adjudicated.value,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [admittedScreenFinding('correctness#0')],
        }),
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0')],
        }),
        financeScreenResult('testing', {
          admitted_findings: [
            admittedScreenFinding('testing#0', { file: 'src/other.ts' }),
          ],
        }),
      ],
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('security'),
        dispatchRecord('testing'),
      ],
      parent_run_metadata: {
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security'),
          dispatchRecord('testing'),
        ],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const finding = scenario.merge.merged_findings.find(
      (candidate) => candidate.finding_id === 'merge-1',
    )
    expect(finding?.agreement_credit).toEqual(['testing'])
    expect(finding?.confidence).toBe(0.9)
  })

  test('a suppressed confidence disposition with no screened finding rejects', () => {
    const scenario = finalizeContextScenario()
    const prepared: PrepareOutput = {
      ...scenario.prepared,
      confidence_dispositions: [
        ...scenario.prepared.confidence_dispositions,
        confidenceDisposition('ghost#0', 'suppressed'),
      ],
    }

    const result = deriveFinalizeContext({ ...scenario, prepared })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'confidence disposition references unscreened finding',
    )
  })

  test('a merged finding citing input from an unavailable reviewer rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('security#0', 'surviving'),
      ],
      surviving_findings: [survivingFinding('security#0', 'security')],
      singletons: ['security#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)
    const unavailableDispatch = dispatchRecord('security', {
      dispatch_outcome: 'validation_unavailable',
    })

    const scenario: DeriveFinalizeContextInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0')],
          dispatch_outcome: 'validation_unavailable',
        }),
      ],
      dispatch_records: [unavailableDispatch],
      parent_run_metadata: {
        selected_dispatches: [unavailableDispatch],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'merged finding cites input from unavailable reviewer',
    )
  })

  test('a validation_unavailable dispatch record with no screen result does not reject', () => {
    const unavailableDispatch = dispatchRecord('security', {
      dispatch_outcome: 'validation_unavailable',
    })
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput([], []),
      prepared: preparedOutput(),
      screen_results: [],
      dispatch_records: [unavailableDispatch],
      parent_run_metadata: {
        selected_dispatches: [unavailableDispatch],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
  })

  test('an extra screen result for an unselected persona still rejects even when another persona is exempt', () => {
    const unavailableDispatch = dispatchRecord('security', {
      dispatch_outcome: 'validation_unavailable',
    })
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput([], []),
      prepared: preparedOutput(),
      screen_results: [financeScreenResult('testing')],
      dispatch_records: [unavailableDispatch],
      parent_run_metadata: {
        selected_dispatches: [unavailableDispatch],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('unexpected screen result for persona')
  })

  test('a screen result whose outcome disagrees with an exempt dispatch record rejects', () => {
    const unavailableDispatch = dispatchRecord('security', {
      dispatch_outcome: 'validation_unavailable',
    })
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput([], []),
      prepared: preparedOutput(),
      screen_results: [
        financeScreenResult('security', { dispatch_outcome: 'findings' }),
      ],
      dispatch_records: [unavailableDispatch],
      parent_run_metadata: {
        selected_dispatches: [unavailableDispatch],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'screen result outcome does not match dispatch record',
    )
  })

  test('a never_returned dispatch record for a non-risk-critical persona with no screen result does not reject, and the run degrades through finalizeReview', () => {
    const neverReturnedDispatch = dispatchRecord('testing', {
      dispatch_outcome: 'never_returned',
    })
    const scenario: DeriveFinalizeContextInput = {
      merge: mergeOutput([], []),
      prepared: preparedOutput(),
      screen_results: [],
      dispatch_records: [neverReturnedDispatch],
      parent_run_metadata: {
        selected_dispatches: [neverReturnedDispatch],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)

    const reviewBase = finalizeReviewScenario()
    const reviewResult = finalizeReview({
      ...reviewBase,
      dispatch_records: [...reviewBase.dispatch_records, neverReturnedDispatch],
      parent_run_metadata: {
        ...reviewBase.parent_run_metadata,
        selected_dispatches: [
          ...reviewBase.parent_run_metadata.selected_dispatches,
          neverReturnedDispatch,
        ],
      },
    })

    expect(reviewResult.ok).toBe(true)
    if (!reviewResult.ok) return
    expect(reviewResult.value.kind).toBe('writing')
    if (reviewResult.value.kind !== 'writing') return
    expect(reviewResult.value.artifact.run_status).toBe('degraded')
    expect(reviewResult.value.report.coverage.failed_reviewers).toContain(
      'testing',
    )
  })

  test('permuted selection_surface order between dispatch_records and selected_dispatches passes', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      dispatch_records: [
        dispatchRecord('correctness', {
          selection_surface: ['src/a.ts', 'src/b.ts'],
        }),
      ],
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [
          dispatchRecord('correctness', {
            selection_surface: ['src/b.ts', 'src/a.ts'],
          }),
        ],
      },
    })

    expect(result.ok).toBe(true)
  })

  test('a duplicate selection_surface entry rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      dispatch_records: [
        dispatchRecord('correctness', {
          selection_surface: ['src/a.ts', 'src/a.ts'],
        }),
      ],
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [
          dispatchRecord('correctness', {
            selection_surface: ['src/a.ts', 'src/a.ts'],
          }),
        ],
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('duplicate selection surface entry')
  })

  test('a normalized-collision selection_surface entry on a risk-critical persona rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      dispatch_records: [
        dispatchRecord('security', {
          selection_surface: ['src/example.ts', './src/example.ts'],
        }),
      ],
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [
          dispatchRecord('security', {
            selection_surface: ['src/example.ts', './src/example.ts'],
          }),
        ],
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('duplicate selection surface entry')
  })

  test('dispatch_records and selected_dispatches disagreeing on selection_reason rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      dispatch_records: [
        dispatchRecord('correctness', { selection_reason: 'Reason A.' }),
      ],
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [
          dispatchRecord('correctness', { selection_reason: 'Reason B.' }),
        ],
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('dispatch record mismatch')
  })

  test('a parent_run_metadata.validation status other than not_attempted rejects', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        validation: { status: 'passed' },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'validation must be not_attempted at finalize',
    )
  })

  test('a parent_run_metadata.validation status of failed rejects identically', () => {
    const scenario = finalizeContextScenario()

    const result = deriveFinalizeContext({
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        validation: { status: 'failed', reason: 'Self-validation failed.' },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'validation must be not_attempted at finalize',
    )
  })

  test('a survivor whose reviewer diverges from the screen result that admitted its ID rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
      ],
      // `security` never actually screened this input -- only `correctness`
      // did, below -- so the carried reviewer is laundered.
      surviving_findings: [survivingFinding('correctness#0', 'security')],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: DeriveFinalizeContextInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [admittedScreenFinding('correctness#0')],
        }),
      ],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'surviving finding diverges from its screened finding',
    )
  })

  test('a survivor whose confidence was raised above its screened value rejects', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving', {
          confidence: 0.95,
        }),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', { confidence: 0.95 }),
      ],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: DeriveFinalizeContextInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', { confidence: 0.6 }),
          ],
        }),
      ],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'surviving finding diverges from its screened finding',
    )
  })

  test('an untampered survivor whose fields match its screened finding accepts', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving', {
          confidence: 0.72,
        }),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', {
          confidence: 0.72,
          file: 'src/other.ts',
          line: 9,
          severity: 'P1',
        }),
      ],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: DeriveFinalizeContextInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', {
              confidence: 0.72,
              file: 'src/other.ts',
              line: 9,
              severity: 'P1',
            }),
          ],
        }),
      ],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
  })

  test('a survivor whose input ID was never screened and never carries a confidence disposition rejects', () => {
    // `ghost#0` never appears in any screen result's `admitted_findings`,
    // and no `confidence_dispositions` entry cites it either -- it is
    // entirely fabricated, not merely tampered. The confidence-dispositions
    // loop in `checkConfidenceDispositionsResolveScreenedFindings` only
    // walks `confidence_dispositions`, so an empty ledger never trips it;
    // this pins the survivor-side join catching it instead.
    const prepared = preparedOutput({
      confidence_dispositions: [],
      surviving_findings: [survivingFinding('ghost#0', 'correctness')],
      singletons: ['ghost#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: DeriveFinalizeContextInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('correctness', { admitted_findings: [] }),
      ],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'surviving finding references unscreened input',
    )
  })

  test('a survivor whose input ID was screened and carries a matching confidence disposition still accepts', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
      ],
      surviving_findings: [survivingFinding('correctness#0', 'correctness')],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: DeriveFinalizeContextInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [admittedScreenFinding('correctness#0')],
        }),
      ],
      dispatch_records: [dispatchRecord('correctness')],
      parent_run_metadata: {
        selected_dispatches: [dispatchRecord('correctness')],
        validation: NOT_ATTEMPTED_VALIDATION,
      },
    }

    const result = deriveFinalizeContext(scenario)

    expect(result.ok).toBe(true)
  })
})

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
          pre_existing: true,
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
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [admittedScreenFinding('r1#0')],
        }),
        financeScreenResult('r2', {
          admitted_findings: [
            admittedScreenFinding('r2#0'),
            admittedScreenFinding('r2#1'),
          ],
        }),
        financeScreenResult('r3', {
          admitted_findings: [admittedScreenFinding('r3#0')],
        }),
        financeScreenResult('r4', {
          admitted_findings: [admittedScreenFinding('r4#0')],
        }),
      ],
      dispatch_records: [
        dispatchRecord('r1'),
        dispatchRecord('r2'),
        dispatchRecord('r3'),
        dispatchRecord('r4'),
      ],
    }
  }

  test('every admitted input receives exactly one disposition', () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.input_dispositions).toEqual([
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
    const ids = result.value.input_dispositions.map((entry) => entry.input_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('disposition counts sum to findings observed, including a weighted rejected-payload entry', () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.disposition_counts).toEqual({
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
      result.value.disposition_counts
    expect(surviving + merged + suppressed + filtered + rejected).toBe(
      admittedObserved + rejectedObserved,
    )
  })

  test("pre-existing findings are separated from newly introduced ones, reading the finding's carried pre_existing field", () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pre_existing_findings).toEqual([
      { finding_id: 'f-merged', unconfirmed: false },
    ])
    expect(result.value.new_findings).toEqual([
      { finding_id: 'f-single', unconfirmed: false },
    ])
  })

  test('pre-existing status trusts the carried pre_existing field rather than recomputing it from surviving_findings', () => {
    // f-merged's contributing survivors (r2#0, r2#1) are both pre_existing in
    // `prepared`, but the merged finding's own carried `pre_existing` is
    // false -- the carried field wins, proving this reads the finding
    // directly instead of re-deriving from `prepared.surviving_findings`.
    const scenario = buildScenario()
    const reconciled = {
      ...scenario.reconciled,
      findings: scenario.reconciled.findings.map((finding) =>
        finding.finding_id === 'f-merged'
          ? { ...finding, pre_existing: false }
          : finding,
      ),
    }

    const result = finalizeReviewDispositions({ ...scenario, reconciled })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.value.pre_existing_findings.some(
        (entry) => entry.finding_id === 'f-merged',
      ),
    ).toBe(false)
    expect(
      result.value.new_findings.some(
        (entry) => entry.finding_id === 'f-merged',
      ),
    ).toBe(true)
  })

  test('a filtered finding enters no queue', () => {
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const allQueued = [
      ...result.value.queues.fixer,
      ...result.value.queues.residual,
      ...result.value.queues.report_only,
    ]
    expect(allQueued.some((entry) => entry.finding_id === 'f-filtered')).toBe(
      false,
    )
    expect(
      result.value.pre_existing_findings.some(
        (entry) => entry.finding_id === 'f-filtered',
      ),
    ).toBe(false)
    expect(
      result.value.new_findings.some(
        (entry) => entry.finding_id === 'f-filtered',
      ),
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
      screen_results: [],
      dispatch_records: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const queueLists = [
      result.value.queues.fixer,
      result.value.queues.residual,
      result.value.queues.report_only,
    ]
    const seen = new Set<string>()
    for (const queue of queueLists) {
      for (const entry of queue) {
        expect(seen.has(entry.finding_id)).toBe(false)
        seen.add(entry.finding_id)
      }
    }
    expect(seen).toEqual(
      new Set(result.value.new_findings.map((entry) => entry.finding_id)),
    )
    expect(result.value.queues.fixer.map((entry) => entry.finding_id)).toEqual([
      'f-fixer',
    ])
    expect(
      result.value.queues.residual.map((entry) => entry.finding_id),
    ).toEqual(['f-human'])
    expect(
      result.value.queues.report_only.map((entry) => entry.finding_id),
    ).toEqual(['f-release'])
  })

  test('an unconfirmed in-band finding is still reported but excluded from every action queue', () => {
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

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.queues.fixer).toEqual([])
    expect(result.value.queues.residual).toEqual([])
    expect(result.value.queues.report_only).toEqual([])
    expect(result.value.new_findings).toEqual([
      { finding_id: 'f-single', unconfirmed: true },
    ])
  })

  test('an out-of-band finding (never requested for validation) is queued normally', () => {
    // f-single is never mentioned in lifecycle_failures, so it was either
    // never requested or was confirmed -- either way it is not "unconfirmed"
    // and stays in its owner's queue exactly as before.
    const result = finalizeReviewDispositions(buildScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.queues.fixer).toEqual([
      { finding_id: 'f-single', unconfirmed: false },
    ])
  })

  test('an unconfirmed finding never enters an action queue, so every queued entry has unconfirmed: false', () => {
    // f-single would normally land in queues.fixer (owner: 'review-fixer' in
    // buildScenario); marking it unconfirmed via lifecycle_failures removes
    // it from every queue instead of carrying unconfirmed: true into one.
    // This pins the invariant that queues.*[].unconfirmed can only ever be
    // false -- partitionFindings routes an unconfirmed finding to
    // new_findings only, never into fixer/residual/report_only.
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

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const allQueued = [
      ...result.value.queues.fixer,
      ...result.value.queues.residual,
      ...result.value.queues.report_only,
    ]
    expect(allQueued.every((entry) => entry.unconfirmed === false)).toBe(true)
    expect(allQueued.some((entry) => entry.finding_id === 'f-single')).toBe(
      false,
    )
  })

  test('a surviving confidence disposition whose finding cannot be found in the merged findings rejects rather than defaulting to surviving', () => {
    const scenario = buildScenario()
    const prepared: PrepareOutput = {
      ...scenario.prepared,
      confidence_dispositions: [
        ...scenario.prepared.confidence_dispositions,
        confidenceDisposition('ghost#0', 'surviving'),
      ],
    }

    const result = finalizeReviewDispositions({ ...scenario, prepared })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'survivor missing from merged findings',
    )
    expect(result.rejection.path).toBe(
      'prepared.confidence_dispositions.5.input_id',
    )
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
      screen_results: [...scenario.screen_results].reverse(),
      dispatch_records: [...scenario.dispatch_records].reverse(),
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
      {
        persona: 'security',
        satisfied: true,
        finding_id: 'f-cov',
        input_finding_id: 'cov#0',
      },
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
      {
        persona: 'security',
        satisfied: true,
        finding_id: 'f-cov',
        input_finding_id: 'cov#0',
      },
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
      {
        persona: 'security',
        satisfied: true,
        finding_id: 'f-cov',
        input_finding_id: 'cov#0',
      },
    ])
  })

  test('surface matching normalizes both the lost persona surface and the finding path', () => {
    const result = deriveRiskCoverage(
      riskCoverageScenario({
        lost_risk_critical_personas: [
          lostPersona('security', { selection_surface: ['./src/example.ts'] }),
        ],
        prepared: preparedOutput({
          surviving_findings: [survivingFinding('cov#0', 'reliability')],
        }),
        reconciled: reconciledOutput({
          findings: [mergedFinding('f-cov', { input_finding_ids: ['cov#0'] })],
        }),
      }),
    )

    expect(result).toEqual([
      {
        persona: 'security',
        satisfied: true,
        finding_id: 'f-cov',
        input_finding_id: 'cov#0',
      },
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
      {
        persona: 'security',
        satisfied: true,
        finding_id: 'f-a',
        input_finding_id: 'b#0',
      },
    ])
    expect(orderedResult).toEqual(permutedResult)
  })

  test('candidates are ordered by canonical severity/confidence/path/line/fingerprint order, not by finding_id', () => {
    // finding_id alphabetical order would pick 'f-a' (P2); the canonical
    // order (severity first) must pick 'f-z' (P0) instead.
    const prepared = preparedOutput({
      surviving_findings: [
        survivingFinding('a#0', 'reliability', { severity: 'P2' }),
        survivingFinding('z#0', 'performance', { severity: 'P0' }),
      ],
    })
    const findingP2 = mergedFinding('f-a', {
      input_finding_ids: ['a#0'],
      severity: 'P2',
      fingerprint: 'src/example.ts:1:P2:f-a',
    })
    const findingP0 = mergedFinding('f-z', {
      input_finding_ids: ['z#0'],
      severity: 'P0',
      fingerprint: 'src/example.ts:1:P0:f-z',
    })

    const result = deriveRiskCoverage(
      riskCoverageScenario({
        prepared,
        reconciled: reconciledOutput({
          findings: [findingP2, findingP0],
        }),
      }),
    )

    expect(result).toEqual([
      {
        persona: 'security',
        satisfied: true,
        finding_id: 'f-z',
        input_finding_id: 'z#0',
      },
    ])
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
    screen_results: [],
    dispatch_records: [],
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

type LedgerAdmittedFinding =
  FinalizeScreenResultFixture['result']['admitted_findings'][number]

function admittedScreenFinding(
  inputId: string,
  overrides: Partial<LedgerAdmittedFinding> = {},
): LedgerAdmittedFinding {
  return {
    input_id: inputId,
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

function ledgerFinalized(
  inputDispositions: readonly {
    readonly input_id: string
    readonly disposition: 'surviving' | 'merged' | 'suppressed' | 'filtered'
    readonly reason?: string
  }[],
) {
  return {
    input_dispositions: inputDispositions,
    disposition_counts: {
      surviving: 0,
      merged: 0,
      suppressed: 0,
      filtered: 0,
      rejected: 0,
    },
    pre_existing_findings: [],
    new_findings: [],
    queues: { fixer: [], residual: [], report_only: [] },
  }
}

describe('buildInputLedger', () => {
  test('every admitted input has exactly one row, ordered by input ID', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('r2#0', 'surviving'),
        confidenceDisposition('r1#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('r2#0', 'r2'),
        survivingFinding('r1#0', 'r1'),
      ],
    })

    const result = buildInputLedger({
      prepared,
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [admittedScreenFinding('r1#0')],
        }),
        financeScreenResult('r2', {
          admitted_findings: [admittedScreenFinding('r2#0')],
        }),
      ],
      dispatch_records: [dispatchRecord('r1'), dispatchRecord('r2')],
      finalized: ledgerFinalized([
        { input_id: 'r1#0', disposition: 'surviving' },
        { input_id: 'r2#0', disposition: 'merged' },
      ]),
      reconciled: reconciledOutput(),
    })

    expect(result).toEqual([
      {
        record_type: 'admitted',
        input_id: 'r1#0',
        reviewer: 'r1',
        confidence: 0.8,
        disposition: 'surviving',
        reason: expect.any(String),
      },
      {
        record_type: 'admitted',
        input_id: 'r2#0',
        reviewer: 'r2',
        confidence: 0.8,
        disposition: 'merged',
        reason: expect.any(String),
      },
    ])
  })

  test('a suppressed row keeps the confidence-gate reason', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('r1#0', 'suppressed', {
          reason: 'confidence below gate threshold',
        }),
      ],
    })

    const result = buildInputLedger({
      prepared,
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [admittedScreenFinding('r1#0')],
        }),
      ],
      dispatch_records: [dispatchRecord('r1')],
      finalized: ledgerFinalized([
        {
          input_id: 'r1#0',
          disposition: 'suppressed',
          reason: 'confidence below gate threshold',
        },
      ]),
      reconciled: reconciledOutput(),
    })

    expect(result).toEqual([
      {
        record_type: 'admitted',
        input_id: 'r1#0',
        reviewer: 'r1',
        confidence: 0.8,
        disposition: 'suppressed',
        reason: 'confidence below gate threshold',
      },
    ])
  })

  test('a filtered row carries the disproving validator reason', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [confidenceDisposition('r1#0', 'surviving')],
      surviving_findings: [survivingFinding('r1#0', 'r1')],
    })
    const reconciled = reconciledOutput({
      findings: [
        {
          ...mergedFinding('f1', { input_finding_ids: ['r1#0'] }),
          validated: false,
          validation_reason: 'The behavior described does not reproduce.',
        },
      ],
      filtered_finding_ids: ['f1'],
      filtered_input_ids: ['r1#0'],
    })

    const result = buildInputLedger({
      prepared,
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [admittedScreenFinding('r1#0')],
        }),
      ],
      dispatch_records: [dispatchRecord('r1')],
      finalized: ledgerFinalized([
        { input_id: 'r1#0', disposition: 'filtered' },
      ]),
      reconciled,
    })

    expect(result).toEqual([
      {
        record_type: 'admitted',
        input_id: 'r1#0',
        reviewer: 'r1',
        confidence: 0.8,
        disposition: 'filtered',
        reason: 'The behavior described does not reproduce.',
      },
    ])
  })

  test('rejected rows carry the extracted severities, sorted by reviewer', () => {
    const result = buildInputLedger({
      prepared: preparedOutput(),
      screen_results: [
        financeScreenResult('r2', {
          admitted_findings: [],
          dispatch_outcome: 'malformed',
          rejected_summary: {
            dispatch_outcome: 'malformed',
            rejected_finding_count: 2,
            rejected_severities: ['P1', 'P2'],
            reason: 'payload failed schema validation',
          },
        }),
        financeScreenResult('r1', {
          admitted_findings: [],
          dispatch_outcome: 'malformed',
          rejected_summary: {
            dispatch_outcome: 'malformed',
            rejected_finding_count: 1,
            rejected_severities: ['unknown'],
            reason: 'payload could not be parsed',
          },
        }),
      ],
      dispatch_records: [dispatchRecord('r1'), dispatchRecord('r2')],
      finalized: ledgerFinalized([]),
      reconciled: reconciledOutput(),
    })

    expect(result).toEqual([
      {
        record_type: 'rejected_summary',
        reviewer: 'r1',
        dispatch_outcome: 'malformed',
        rejected_finding_count: 1,
        rejected_severities: ['unknown'],
        disposition: 'rejected',
        reason: 'payload could not be parsed',
      },
      {
        record_type: 'rejected_summary',
        reviewer: 'r2',
        dispatch_outcome: 'malformed',
        rejected_finding_count: 2,
        rejected_severities: ['P1', 'P2'],
        disposition: 'rejected',
        reason: 'payload failed schema validation',
      },
    ])
  })

  test('a rejection with no summary produces no row at all (KTD21)', () => {
    const result = buildInputLedger({
      prepared: preparedOutput(),
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [],
          dispatch_outcome: 'malformed',
        }),
      ],
      dispatch_records: [
        dispatchRecord('r1', { dispatch_outcome: 'malformed' }),
      ],
      finalized: ledgerFinalized([]),
      reconciled: reconciledOutput(),
    })

    expect(result).toEqual([])
  })

  test('a validation_unavailable persona has no ledger row of either kind', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [confidenceDisposition('r1#0', 'surviving')],
      surviving_findings: [survivingFinding('r1#0', 'r1')],
    })

    const result = buildInputLedger({
      prepared,
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [admittedScreenFinding('r1#0')],
          dispatch_outcome: 'validation_unavailable',
        }),
      ],
      dispatch_records: [
        dispatchRecord('r1', { dispatch_outcome: 'validation_unavailable' }),
      ],
      finalized: ledgerFinalized([
        { input_id: 'r1#0', disposition: 'surviving' },
      ]),
      reconciled: reconciledOutput(),
    })

    expect(result).toEqual([])
  })
})

describe('checkDispositionCountsReconcileLedger', () => {
  test('a disposition count whose admitted-weight sum matches the admitted ledger row count reconciles', () => {
    const ledger: readonly InputLedgerRow[] = [
      {
        record_type: 'admitted',
        input_id: 'a#0',
        reviewer: 'a',
        confidence: 0.8,
        disposition: 'surviving',
        reason: 'x',
      },
      {
        record_type: 'admitted',
        input_id: 'b#0',
        reviewer: 'b',
        confidence: 0.8,
        disposition: 'suppressed',
        reason: 'x',
      },
      {
        record_type: 'rejected_summary',
        reviewer: 'c',
        dispatch_outcome: 'malformed',
        rejected_finding_count: 2,
        rejected_severities: ['P1'],
        disposition: 'rejected',
        reason: 'x',
      },
    ]

    const result = checkDispositionCountsReconcileLedger(
      { surviving: 1, merged: 0, suppressed: 1, filtered: 0, rejected: 2 },
      ledger,
    )

    expect(result.ok).toBe(true)
  })

  test('a deliberately mismatched count set is rejected', () => {
    const ledger: readonly InputLedgerRow[] = [
      {
        record_type: 'admitted',
        input_id: 'a#0',
        reviewer: 'a',
        confidence: 0.8,
        disposition: 'surviving',
        reason: 'x',
      },
      {
        record_type: 'admitted',
        input_id: 'b#0',
        reviewer: 'b',
        confidence: 0.8,
        disposition: 'suppressed',
        reason: 'x',
      },
    ]

    const result = checkDispositionCountsReconcileLedger(
      // Claims three admitted-weight findings; the ledger only carries two
      // admitted rows.
      { surviving: 2, merged: 0, suppressed: 1, filtered: 0, rejected: 2 },
      ledger,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe(
      'disposition counts do not reconcile with the admitted input ledger',
    )
  })
})

describe('buildReviewCoverage', () => {
  function coverageInput(
    overrides: Partial<BuildReviewCoverageInput> = {},
  ): BuildReviewCoverageInput {
    return {
      dispatch_records: [dispatchRecord('r1')],
      validator_lifecycle_results: [],
      screen_results: [financeScreenResult('r1')],
      reconciled: reconciledOutput(),
      merge: mergeOutput([], []),
      ...overrides,
    }
  }

  test('residual risks and testing gaps union across reviewers, deduped and sorted', () => {
    const result = buildReviewCoverage(
      coverageInput({
        dispatch_records: [dispatchRecord('r1'), dispatchRecord('r2')],
        screen_results: [
          financeScreenResult('r1', {
            residual_risks: ['Race condition under load.', 'Shared risk.'],
            testing_gaps: ['No integration test for retries.'],
          }),
          financeScreenResult('r2', {
            residual_risks: ['Shared risk.'],
            testing_gaps: ['No load test.'],
          }),
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.residual_risks).toEqual([
      'Race condition under load.',
      'Shared risk.',
    ])
    expect(result.value.testing_gaps).toEqual([
      'No integration test for retries.',
      'No load test.',
    ])
  })

  test('failed reviewers list personas whose dispatch outcome was malformed, never_returned, or validation_unavailable', () => {
    const result = buildReviewCoverage(
      coverageInput({
        dispatch_records: [
          dispatchRecord('r1', { dispatch_outcome: 'malformed' }),
          dispatchRecord('r2', { dispatch_outcome: 'never_returned' }),
          dispatchRecord('r3', { dispatch_outcome: 'validation_unavailable' }),
          dispatchRecord('r4', { dispatch_outcome: 'findings' }),
        ],
        screen_results: [
          financeScreenResult('r1'),
          financeScreenResult('r2'),
          financeScreenResult('r3'),
          financeScreenResult('r4'),
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.failed_reviewers).toEqual(['r1', 'r2', 'r3'])
  })

  test('validator failure reasons are carried one per lifecycle failure', () => {
    const result = buildReviewCoverage(
      coverageInput({
        reconciled: reconciledOutput({
          lifecycle_failures: [
            {
              finding_id: 'f1',
              outcome: 'failed',
              reason: 'validator timed out',
            },
            {
              finding_id: 'f2',
              outcome: 'unavailable',
              reason: 'validator not reachable',
            },
          ],
          degraded: true,
        }),
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.validator_failures).toEqual([
      'validator timed out',
      'validator not reachable',
    ])
  })

  test('intent uncertainty passes through the merge phase disagreement facts', () => {
    const result = buildReviewCoverage(
      coverageInput({
        merge: {
          ...mergeOutput([], []),
          disagreement_facts: ['Reviewers disagreed about severity.'],
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.intent_uncertainty).toEqual([
      'Reviewers disagreed about severity.',
    ])
  })

  test('reviewers and validators report the dispatch and lifecycle-result counts', () => {
    const result = buildReviewCoverage(
      coverageInput({
        dispatch_records: [dispatchRecord('r1'), dispatchRecord('r2')],
        screen_results: [financeScreenResult('r1'), financeScreenResult('r2')],
        validator_lifecycle_results: [
          lifecycleResult('f1', { outcome: 'true' }),
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.reviewers).toBe(2)
    expect(result.value.validators).toBe(1)
  })

  test('a union exceeding the MAX_PERSONAS bound rejects with a fixed reason instead of truncating', () => {
    const manyRisks = Array.from({ length: 65 }, (_, index) => `Risk ${index}.`)
    const result = buildReviewCoverage(
      coverageInput({
        screen_results: [
          financeScreenResult('r1', { residual_risks: manyRisks }),
        ],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection).toEqual({
      path: 'coverage.residual_risks',
      reason: 'coverage array exceeds bound',
    })
  })
})

describe('projectSynthesizedFindings', () => {
  function projectInput(
    overrides: Partial<ProjectSynthesizedFindingsInput> = {},
  ): ProjectSynthesizedFindingsInput {
    return { findings: [], ...overrides }
  }

  test('nests fingerprint, submitters, and agreement_credit under provenance and strips finding_id', () => {
    const finding = mergedFinding('f1', {
      input_finding_ids: ['a#0', 'b#0'],
      fingerprint: 'src/example.ts:1:P1:f1',
      submitters: ['correctness', 'reliability'],
      agreement_credit: ['security'],
    })

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )[0]
    if (!projected) throw new Error('expected exactly one projected finding')

    expect(projected.provenance).toEqual({
      fingerprint: 'src/example.ts:1:P1:f1',
      submitters: ['correctness', 'reliability'],
      agreement_credit: ['security'],
    })
    expect('finding_id' in projected).toBe(false)
    expect('fingerprint' in projected).toBe(false)
    expect('submitters' in projected).toBe(false)
    expect('agreement_credit' in projected).toBe(false)
  })

  test('absent agreement credit projects to an empty list, never omitted', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['a#0'] })

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )[0]
    if (!projected) throw new Error('expected exactly one projected finding')

    expect(projected.provenance.agreement_credit).toEqual([])
  })

  test('a filtered finding carries validated: false and its validation reason', () => {
    const finding = {
      ...mergedFinding('f1', { input_finding_ids: ['a#0'] }),
      validated: false,
      validation_reason: 'Evidence could not be reproduced.',
    }

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )[0]
    if (!projected) throw new Error('expected exactly one projected finding')

    expect(projected.validated).toBe(false)
    expect(projected.validation_reason).toBe(
      'Evidence could not be reproduced.',
    )
  })

  test('a never-validated finding carries neither validated nor validation_reason', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['a#0'] })

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )[0]
    if (!projected) throw new Error('expected exactly one projected finding')

    expect('validated' in projected).toBe(false)
    expect('validation_reason' in projected).toBe(false)
  })

  test('a carried route_narrowing_reason reaches the projected artifact finding', () => {
    const finding = mergedFinding('f1', {
      input_finding_ids: ['a#0'],
      owner: 'release',
      route_narrowing_reason: 'Escalated to release per policy.',
    })

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )[0]
    if (!projected) throw new Error('expected exactly one projected finding')

    expect(projected.route_narrowing_reason).toBe(
      'Escalated to release per policy.',
    )
  })

  test('no carried route_narrowing_reason projects without the field', () => {
    const finding = mergedFinding('f1', { input_finding_ids: ['a#0'] })

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )[0]
    if (!projected) throw new Error('expected exactly one projected finding')

    expect('route_narrowing_reason' in projected).toBe(false)
  })

  test('projection preserves the reconciled order', () => {
    const findings = [
      mergedFinding('f1', { input_finding_ids: ['a#0'], title: 'First issue' }),
      mergedFinding('f2', {
        input_finding_ids: ['b#0'],
        title: 'Second issue',
      }),
    ]

    const projected = projectSynthesizedFindings(projectInput({ findings }))

    expect(projected.map((finding) => finding.title)).toEqual([
      'First issue',
      'Second issue',
    ])
  })

  test('every projected finding parses strictly against the artifact findings schema', () => {
    const finding = mergedFinding('f1', {
      input_finding_ids: ['a#0'],
      submitters: ['correctness'],
    })

    const projected = projectSynthesizedFindings(
      projectInput({ findings: [finding] }),
    )

    expect(() =>
      ReviewArtifactSchema.shape.findings.parse(projected),
    ).not.toThrow()
  })
})

describe('route narrowing to release', () => {
  test('a P0 finding narrowed to release routes to report_only, unexplained by no other queue, and carries its reason into the persisted artifact', () => {
    const finding = mergedFinding('p0-release', {
      input_finding_ids: ['r1#0'],
      owner: 'release',
      severity: 'P0',
      route_narrowing_reason: 'Escalated to release: requires legal sign-off.',
    })
    const prepared = preparedOutput({
      confidence_dispositions: [confidenceDisposition('r1#0', 'surviving')],
      surviving_findings: [survivingFinding('r1#0', 'r1')],
    })
    const reconciled = reconciledOutput({ findings: [finding] })

    const dispositions = finalizeReviewDispositions({
      prepared,
      reconciled,
      rejected_payloads: [],
      screen_results: [
        financeScreenResult('r1', {
          admitted_findings: [admittedScreenFinding('r1#0')],
        }),
      ],
      dispatch_records: [dispatchRecord('r1')],
    })

    expect(dispositions.ok).toBe(true)
    if (!dispositions.ok) return
    expect(
      dispositions.value.queues.report_only.map((entry) => entry.finding_id),
    ).toEqual(['p0-release'])
    expect(dispositions.value.queues.fixer).toEqual([])
    expect(dispositions.value.queues.residual).toEqual([])

    const [projected] = projectSynthesizedFindings({ findings: [finding] })
    if (!projected) throw new Error('expected exactly one projected finding')
    expect(projected.owner).toBe('release')
    expect(projected.severity).toBe('P0')
    expect(projected.route_narrowing_reason).toBe(
      'Escalated to release: requires legal sign-off.',
    )
  })
})

describe('checkRiskCoverageSemantics', () => {
  function dispatchEntry(
    persona: string,
    overrides: {
      readonly selection_surface?: readonly string[]
    } = {},
  ) {
    return {
      persona,
      dispatch_outcome: 'findings' as const,
      input_finding_count: 1,
      ...overrides,
    }
  }

  function projectedFinding(
    findingId: string,
    overrides: Partial<MergeOutput['merged_findings'][number]> & {
      readonly validated?: boolean
    } = {},
  ) {
    const { validated, ...mergedOverrides } = overrides
    const finding = {
      ...mergedFinding(findingId, mergedOverrides),
      ...(validated !== undefined ? { validated } : {}),
    }
    const [projected] = projectSynthesizedFindings({ findings: [finding] })
    if (!projected) throw new Error('expected exactly one projected finding')
    return projected
  }

  test('rejects an in-band cited finding without an explicit true validation', () => {
    const finding = projectedFinding('f1', {
      input_finding_ids: ['correctness#1'],
      file: 'src/auth.ts',
    })

    const result = checkRiskCoverageSemantics({
      dispatches: [
        dispatchEntry('security', { selection_surface: ['src/auth.ts'] }),
      ],
      findings: [finding],
      risk_coverage: [
        {
          persona: 'security',
          satisfied: true,
          input_finding_id: 'correctness#1',
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection).toEqual({
      path: 'risk_coverage.0.input_finding_id',
      reason:
        'satisfied risk coverage must cite a validated finding on the lost persona selection surface',
    })
  })

  test("rejects a citation whose finding file does not normalize to the lost persona's selection surface", () => {
    const finding = projectedFinding('f2', {
      input_finding_ids: ['correctness#2'],
      file: 'src/other.ts',
      validated: true,
    })

    const result = checkRiskCoverageSemantics({
      dispatches: [
        dispatchEntry('security', { selection_surface: ['src/auth.ts'] }),
      ],
      findings: [finding],
      risk_coverage: [
        {
          persona: 'security',
          satisfied: true,
          input_finding_id: 'correctness#2',
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection).toEqual({
      path: 'risk_coverage.0.input_finding_id',
      reason:
        'satisfied risk coverage must cite a validated finding on the lost persona selection surface',
    })
  })

  test('passes when the cited finding file and selection surface normalize to the same path despite differing spellings', () => {
    const finding = projectedFinding('f3', {
      input_finding_ids: ['correctness#3'],
      file: 'src\\nested\\.\\auth.ts',
      validated: true,
    })

    const result = checkRiskCoverageSemantics({
      dispatches: [
        dispatchEntry('security', {
          selection_surface: ['./src/nested/auth.ts'],
        }),
      ],
      findings: [finding],
      risk_coverage: [
        {
          persona: 'security',
          satisfied: true,
          input_finding_id: 'correctness#3',
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  test('passes when risk_coverage is absent', () => {
    const result = checkRiskCoverageSemantics({ dispatches: [], findings: [] })

    expect(result.ok).toBe(true)
  })
})

function finalizeReviewScenario(
  overrides: Partial<FinalizeReviewInput> = {},
): FinalizeReviewInput {
  const prepared = preparedOutput({
    confidence_dispositions: [
      confidenceDisposition('correctness#0', 'surviving'),
    ],
    surviving_findings: [
      survivingFinding('correctness#0', 'correctness', {
        requires_verification: false,
        severity: 'P3',
      }),
    ],
    singletons: ['correctness#0'],
  })
  const merge = buildAdjudicatedMergeOutput(prepared)

  return {
    merge,
    prepared,
    screen_results: [
      financeScreenResult('correctness', {
        admitted_findings: [
          admittedScreenFinding('correctness#0', {
            requires_verification: false,
            severity: 'P3',
          }),
        ],
      }),
    ],
    dispatch_records: [dispatchRecord('correctness')],
    validator_lifecycle_results: [],
    plan_assessment: { verdict: 'All requirements met.', results: [] },
    parent_run_metadata: {
      run_id: 'run-1',
      mode: 'interactive',
      harness: 'opencode',
      branch: 'main',
      head_sha: 'a'.repeat(40),
      selected_dispatches: [dispatchRecord('correctness')],
      timestamps: {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:05:00.000Z',
      },
      validation: { status: 'not_attempted', reason: 'no autofix applied' },
      applied_fixes: [],
    },
    ...overrides,
  }
}

describe('finalizeReview', () => {
  test('a clean run reaches a completed, clean artifact that parses against ReviewArtifactSchema and FinalizeOutputSchema', () => {
    const result = finalizeReview(finalizeReviewScenario())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    const { artifact } = result.value
    expect(artifact.run_status).toBe('completed')
    expect(artifact.verdict).toBe('All requirements met.')
    expect(() => ReviewArtifactSchema.parse(artifact)).not.toThrow()
    expect(() => FinalizeOutputSchema.parse(result.value)).not.toThrow()
  })

  test('writing and report-only agree on findings, ledger-derived dispositions, queues, coverage, and verdict', () => {
    const base = finalizeReviewScenario()
    const writingResult = finalizeReview(base)
    const reportOnlyResult = finalizeReview({
      ...base,
      parent_run_metadata: { ...base.parent_run_metadata, mode: 'report-only' },
    })

    expect(writingResult.ok).toBe(true)
    expect(reportOnlyResult.ok).toBe(true)
    if (!writingResult.ok || !reportOnlyResult.ok) return
    expect(writingResult.value.kind).toBe('writing')
    expect(reportOnlyResult.value.kind).toBe('report_only')
    if (writingResult.value.kind !== 'writing') return
    if (reportOnlyResult.value.kind !== 'report_only') return

    expect(writingResult.value.report.findings).toEqual(
      reportOnlyResult.value.findings,
    )
    expect(writingResult.value.report.input_dispositions).toEqual(
      reportOnlyResult.value.input_dispositions,
    )
    expect(writingResult.value.report.queues).toEqual(
      reportOnlyResult.value.queues,
    )
    expect(writingResult.value.report.coverage).toEqual(
      reportOnlyResult.value.coverage,
    )
    expect(writingResult.value.report.verdict).toEqual(
      reportOnlyResult.value.verdict,
    )
    expect(writingResult.value.artifact.verdict).toEqual(
      reportOnlyResult.value.verdict,
    )
  })

  // `checkRiskCoverageSemantics` runs before the report-only/writing branch
  // so both output kinds are gated identically -- report-only's projection
  // carries `risk_coverage` too and is externally visible, so it must not
  // skip the check via the early return. A genuine violation is not
  // reachable through `finalizeReview`: `deriveRiskCoverage` only ever cites
  // a candidate that `isEligibleRiskCoverageCandidate` (on-surface,
  // cross-persona) and `isValidationBandEligible` (in-band candidates need
  // an explicit `true`) already accepted, and `requiresValidatorRequest`
  // guarantees every in-band finding was requested for validation, so an
  // absent `validated` on an in-band finding always lands it in
  // `lifecycle_failures` and makes it ineligible at derivation -- the same
  // rule the gate re-checks. So this test instead pins report-only and
  // writing to produce byte-identical `risk_coverage` for a real satisfied
  // loss, proving both paths run through the same gate and projection.
  test('writing and report-only produce identical risk_coverage for a satisfied risk-critical persona loss', () => {
    const correctnessDispatch = dispatchRecord('correctness')
    const securityDispatch = dispatchRecord('security', {
      dispatch_outcome: 'malformed',
      selection_surface: ['src/auth.ts'],
    })
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', {
          file: 'src/auth.ts',
          requires_verification: false,
          severity: 'P3',
        }),
      ],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)
    const base = finalizeReviewScenario({
      dispatch_records: [correctnessDispatch, securityDispatch],
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', {
              file: 'src/auth.ts',
              requires_verification: false,
              severity: 'P3',
            }),
          ],
        }),
        financeScreenResult('security', {
          admitted_findings: [],
          dispatch_outcome: 'malformed',
        }),
      ],
      prepared,
      merge,
    })
    const scenario: FinalizeReviewInput = {
      ...base,
      parent_run_metadata: {
        ...base.parent_run_metadata,
        selected_dispatches: [correctnessDispatch, securityDispatch],
      },
    }

    const writingResult = finalizeReview(scenario)
    const reportOnlyResult = finalizeReview({
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        mode: 'report-only',
      },
    })

    expect(writingResult.ok).toBe(true)
    expect(reportOnlyResult.ok).toBe(true)
    if (!writingResult.ok || !reportOnlyResult.ok) return
    if (writingResult.value.kind !== 'writing') {
      throw new Error('expected writing kind')
    }
    if (reportOnlyResult.value.kind !== 'report_only') {
      throw new Error('expected report_only kind')
    }

    expect(writingResult.value.artifact.risk_coverage).toEqual([
      {
        persona: 'security',
        satisfied: true,
        input_finding_id: 'correctness#0',
      },
    ])
    expect(reportOnlyResult.value.risk_coverage).toEqual(
      writingResult.value.artifact.risk_coverage,
    )
  })

  test('an all-reviewer failure is not clean even when no risk-critical persona was selected', () => {
    const failedDispatch = dispatchRecord('correctness', {
      dispatch_outcome: 'malformed',
    })
    const scenario = finalizeReviewScenario({
      dispatch_records: [failedDispatch],
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [],
          dispatch_outcome: 'malformed',
        }),
      ],
      prepared: preparedOutput(),
      merge: {
        disagreement_facts: [],
        merged_findings: [],
        validator_requests: [],
      },
    })
    const withMatchingSelection: FinalizeReviewInput = {
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [failedDispatch],
      },
    }

    const result = finalizeReview(withMatchingSelection)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    expect(result.value.artifact.run_status).toBe('degraded')
    expect(result.value.artifact.verdict).not.toBe('All requirements met.')
  })

  test('an unavailable persona degrades the run even when risk coverage is otherwise satisfied', () => {
    const securityDispatch = dispatchRecord('security', {
      dispatch_outcome: 'validation_unavailable',
      selection_surface: ['src/auth.ts'],
    })
    const scenario = finalizeReviewScenario({
      dispatch_records: [dispatchRecord('correctness'), securityDispatch],
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', {
              requires_verification: false,
              severity: 'P3',
            }),
          ],
        }),
        financeScreenResult('security', {
          admitted_findings: [],
          dispatch_outcome: 'validation_unavailable',
        }),
      ],
    })
    const withMatchingSelection: FinalizeReviewInput = {
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [dispatchRecord('correctness'), securityDispatch],
      },
    }

    const result = finalizeReview(withMatchingSelection)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    // `security` had no recorded selection surface to lose, so risk coverage
    // reports no unsatisfied persona for it -- yet `run_status` still
    // degrades on the `validation_unavailable` dispatch outcome alone, per
    // KTD20.
    expect(result.value.artifact.run_status).toBe('degraded')
  })

  test('a never-returned persona degrades the run even when risk coverage is otherwise satisfied', () => {
    const testingDispatch = dispatchRecord('testing', {
      dispatch_outcome: 'never_returned',
    })
    const scenario = finalizeReviewScenario({
      dispatch_records: [dispatchRecord('correctness'), testingDispatch],
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', {
              requires_verification: false,
              severity: 'P3',
            }),
          ],
        }),
        financeScreenResult('testing', {
          admitted_findings: [],
          dispatch_outcome: 'never_returned',
        }),
      ],
    })
    const withMatchingSelection: FinalizeReviewInput = {
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        selected_dispatches: [dispatchRecord('correctness'), testingDispatch],
      },
    }

    const result = finalizeReview(withMatchingSelection)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    expect(result.value.artifact.run_status).toBe('degraded')
    expect(result.value.artifact.verdict).not.toBe('All requirements met.')
    expect(result.value.report.coverage.failed_reviewers).toContain('testing')
  })

  test('an artifact parse failure surfaces as a rejection with no partial output', () => {
    const base = finalizeReviewScenario()
    const scenario: FinalizeReviewInput = {
      ...base,
      parent_run_metadata: {
        ...base.parent_run_metadata,
        branch: 'x'.repeat(300),
      },
    }

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.reason).toBe('artifact failed schema validation')
    expect('value' in result).toBe(false)
    expect(Object.keys(result).sort()).toEqual(['ok', 'rejection'])
  })

  test('changing only run_id changes only run_id in the artifact', () => {
    const scenarioA = finalizeReviewScenario()
    const scenarioB: FinalizeReviewInput = {
      ...scenarioA,
      parent_run_metadata: {
        ...scenarioA.parent_run_metadata,
        run_id: 'run-2',
      },
    }

    const resultA = finalizeReview(scenarioA)
    const resultB = finalizeReview(scenarioB)

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    if (!resultA.ok || !resultB.ok) return
    if (resultA.value.kind !== 'writing' || resultB.value.kind !== 'writing')
      return

    const { run_id: runIdA, ...restA } = resultA.value.artifact
    const { run_id: runIdB, ...restB } = resultB.value.artifact
    expect(runIdA).toBe('run-1')
    expect(runIdB).toBe('run-2')
    expect(restA).toEqual(restB)
  })

  test('a report-only run never wraps an artifact', () => {
    const base = finalizeReviewScenario()
    const scenario: FinalizeReviewInput = {
      ...base,
      parent_run_metadata: { ...base.parent_run_metadata, mode: 'report-only' },
    }

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('report_only')
    expect('artifact' in result.value).toBe(false)
    expect(() => FinalizeOutputSchema.parse(result.value)).not.toThrow()
  })

  test('a rejection from deriveFinalizeContext aborts finalizeReview with no partial output', () => {
    const base = finalizeReviewScenario()
    const scenario: FinalizeReviewInput = {
      ...base,
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('extra-persona'),
      ],
    }

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('value' in result).toBe(false)
  })

  test('a suppressed disposition with no screened finding rejects identically in report-only and interactive', () => {
    const base = finalizeReviewScenario()
    const scenario: FinalizeReviewInput = {
      ...base,
      prepared: {
        ...base.prepared,
        confidence_dispositions: [
          ...base.prepared.confidence_dispositions,
          confidenceDisposition('ghost#0', 'suppressed'),
        ],
      },
    }

    const interactiveResult = finalizeReview(scenario)
    const reportOnlyResult = finalizeReview({
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        mode: 'report-only',
      },
    })

    expect(interactiveResult.ok).toBe(false)
    expect(reportOnlyResult.ok).toBe(false)
    if (interactiveResult.ok || reportOnlyResult.ok) return
    expect(interactiveResult.rejection.reason).toBe(
      'confidence disposition references unscreened finding',
    )
    expect(reportOnlyResult.rejection.reason).toBe(
      interactiveResult.rejection.reason,
    )
  })

  test('a cited input whose reviewer is unavailable in both dispatch arrays rejects identically in report-only and interactive', () => {
    const base = finalizeReviewScenario()
    const unavailableDispatch = dispatchRecord('correctness', {
      dispatch_outcome: 'validation_unavailable',
    })
    const scenario: FinalizeReviewInput = {
      ...base,
      // Screen result outcome agrees with the (forged) dispatch outcome so
      // this exercises the provenance check below, not the screen-result
      // outcome-agreement check (item 010).
      screen_results: base.screen_results.map((result) =>
        result.reviewer === 'correctness'
          ? {
              ...result,
              result: {
                ...result.result,
                dispatch_outcome: 'validation_unavailable',
              },
            }
          : result,
      ),
      dispatch_records: [unavailableDispatch],
      parent_run_metadata: {
        ...base.parent_run_metadata,
        selected_dispatches: [unavailableDispatch],
      },
    }

    const interactiveResult = finalizeReview(scenario)
    const reportOnlyResult = finalizeReview({
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        mode: 'report-only',
      },
    })

    expect(interactiveResult.ok).toBe(false)
    expect(reportOnlyResult.ok).toBe(false)
    if (interactiveResult.ok || reportOnlyResult.ok) return
    expect(interactiveResult.rejection.reason).toBe(
      'merged finding cites input from unavailable reviewer',
    )
    expect(reportOnlyResult.rejection.reason).toBe(
      interactiveResult.rejection.reason,
    )
  })

  test('a duplicate confidence disposition entry rejects identically in report-only and interactive', () => {
    const base = finalizeReviewScenario()
    const scenario: FinalizeReviewInput = {
      ...base,
      prepared: {
        ...base.prepared,
        confidence_dispositions: [
          ...base.prepared.confidence_dispositions,
          confidenceDisposition('correctness#0', 'surviving'),
        ],
      },
    }

    const interactiveResult = finalizeReview(scenario)
    const reportOnlyResult = finalizeReview({
      ...scenario,
      parent_run_metadata: {
        ...scenario.parent_run_metadata,
        mode: 'report-only',
      },
    })

    expect(interactiveResult.ok).toBe(false)
    expect(reportOnlyResult.ok).toBe(false)
    if (interactiveResult.ok || reportOnlyResult.ok) return
    expect(interactiveResult.rejection.reason).toBe(
      'duplicate confidence disposition',
    )
    expect(reportOnlyResult.rejection.reason).toBe(
      interactiveResult.rejection.reason,
    )
  })

  test('disposition_counts excludes a validation_unavailable persona and reconciles with the admitted ledger row count plus rejected weight', () => {
    const prepared = preparedOutput({
      confidence_dispositions: [
        confidenceDisposition('correctness#0', 'surviving'),
        confidenceDisposition('correctness#1', 'suppressed', {
          reason: 'confidence below gate threshold',
        }),
        // `security` is withheld (validation_unavailable) but still minted a
        // screened, suppressed finding -- it must contribute no ledger row
        // and no disposition-count weight, per KTD21.
        confidenceDisposition('security#0', 'suppressed', {
          reason: 'confidence below gate threshold',
        }),
      ],
      surviving_findings: [
        survivingFinding('correctness#0', 'correctness', {
          requires_verification: false,
          severity: 'P3',
        }),
      ],
      singletons: ['correctness#0'],
    })
    const merge = buildAdjudicatedMergeOutput(prepared)

    const scenario: FinalizeReviewInput = {
      merge,
      prepared,
      screen_results: [
        financeScreenResult('correctness', {
          admitted_findings: [
            admittedScreenFinding('correctness#0', {
              requires_verification: false,
              severity: 'P3',
            }),
            admittedScreenFinding('correctness#1'),
          ],
        }),
        financeScreenResult('security', {
          admitted_findings: [admittedScreenFinding('security#0')],
          dispatch_outcome: 'validation_unavailable',
        }),
        financeScreenResult('testing', {
          admitted_findings: [],
          dispatch_outcome: 'malformed',
          rejected_summary: {
            dispatch_outcome: 'malformed',
            rejected_finding_count: 2,
            rejected_severities: ['P1', 'P2'],
            reason: 'payload failed schema validation',
          },
        }),
      ],
      dispatch_records: [
        dispatchRecord('correctness'),
        dispatchRecord('security', {
          dispatch_outcome: 'validation_unavailable',
          selection_surface: ['src/example.ts'],
        }),
        dispatchRecord('testing', { dispatch_outcome: 'malformed' }),
      ],
      validator_lifecycle_results: [],
      plan_assessment: { verdict: 'All requirements met.', results: [] },
      parent_run_metadata: {
        run_id: 'run-1',
        mode: 'interactive',
        harness: 'opencode',
        branch: 'main',
        head_sha: 'a'.repeat(40),
        selected_dispatches: [
          dispatchRecord('correctness'),
          dispatchRecord('security', {
            dispatch_outcome: 'validation_unavailable',
            selection_surface: ['src/example.ts'],
          }),
          dispatchRecord('testing', { dispatch_outcome: 'malformed' }),
        ],
        timestamps: {
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:05:00.000Z',
        },
        validation: { status: 'not_attempted', reason: 'no autofix applied' },
        applied_fixes: [],
      },
    }

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    const { artifact } = result.value
    expect(artifact.disposition_counts).toEqual({
      surviving: 1,
      merged: 0,
      suppressed: 1,
      filtered: 0,
      rejected: 2,
    })
    const admittedRows = artifact.input_findings.filter(
      (row) => row.record_type === 'admitted',
    )
    expect(admittedRows).toHaveLength(2)
    expect(admittedRows.some((row) => row.input_id === 'security#0')).toBe(
      false,
    )
  })

  test('a validation_unavailable dispatch with no screen result completes as degraded with no ledger row for it', () => {
    const unavailableDispatch = dispatchRecord('testing', {
      dispatch_outcome: 'validation_unavailable',
    })
    const prepared = preparedOutput()
    const merge = buildAdjudicatedMergeOutput(prepared)
    const scenario: FinalizeReviewInput = {
      merge,
      prepared,
      screen_results: [],
      dispatch_records: [unavailableDispatch],
      validator_lifecycle_results: [],
      plan_assessment: { verdict: 'All requirements met.', results: [] },
      parent_run_metadata: {
        run_id: 'run-1',
        mode: 'interactive',
        harness: 'opencode',
        branch: 'main',
        head_sha: 'a'.repeat(40),
        selected_dispatches: [unavailableDispatch],
        timestamps: {
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:05:00.000Z',
        },
        validation: NOT_ATTEMPTED_VALIDATION,
        applied_fixes: [],
      },
    }

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    expect(result.value.artifact.run_status).toBe('degraded')
    expect(
      result.value.artifact.input_findings.some(
        (finding) => finding.reviewer === 'testing',
      ),
    ).toBe(false)
  })

  test('a selected conditional dispatch with selection_reason retains both it and selection_surface in the writing artifact', () => {
    const conditionalDispatch = dispatchRecord('correctness', {
      selection_surface: ['src/example.ts'],
      selection_reason: 'Touches example.ts directly.',
    })
    const base = finalizeReviewScenario({
      dispatch_records: [conditionalDispatch],
    })
    const scenario: FinalizeReviewInput = {
      ...base,
      parent_run_metadata: {
        ...base.parent_run_metadata,
        selected_dispatches: [conditionalDispatch],
      },
    }

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('writing')
    if (result.value.kind !== 'writing') return
    const dispatch = result.value.artifact.dispatches.find(
      (entry) => entry.persona === 'correctness',
    )
    expect(dispatch?.selection_surface).toEqual(['src/example.ts'])
    expect(dispatch?.selection_reason).toBe('Touches example.ts directly.')
  })

  test('a validation status other than not_attempted rejects identically in report-only and interactive', () => {
    const base = finalizeReviewScenario()
    for (const validation of [
      { status: 'passed' as const },
      { status: 'failed' as const, reason: 'Self-validation failed.' },
    ]) {
      const scenario: FinalizeReviewInput = {
        ...base,
        parent_run_metadata: { ...base.parent_run_metadata, validation },
      }

      const interactiveResult = finalizeReview(scenario)
      const reportOnlyResult = finalizeReview({
        ...scenario,
        parent_run_metadata: {
          ...scenario.parent_run_metadata,
          mode: 'report-only',
        },
      })

      expect(interactiveResult.ok, validation.status).toBe(false)
      expect(reportOnlyResult.ok, validation.status).toBe(false)
      if (interactiveResult.ok || reportOnlyResult.ok) continue
      expect(interactiveResult.rejection.reason).toBe(
        'validation must be not_attempted at finalize',
      )
      expect(reportOnlyResult.rejection.reason).toBe(
        interactiveResult.rejection.reason,
      )
    }
  })

  test('validation not_attempted with a reason is accepted', () => {
    const scenario = finalizeReviewScenario()

    const result = finalizeReview(scenario)

    expect(result.ok).toBe(true)
  })
})
