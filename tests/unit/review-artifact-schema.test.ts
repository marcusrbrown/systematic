import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  ParentFindingSchema,
  ParentRecordSchema,
  REVIEW_ARTIFACT_CUSTOM_MESSAGES,
  type ReviewArtifact,
  ReviewArtifactSchema,
  SubAgentFindingSchema,
  SubAgentReturnSchema,
} from '../../src/lib/review-artifact-schema.js'

type JsonObject = Record<string, unknown>

type UnvalidatedFindingRequiresReason =
  Extract<ReviewArtifact['findings'][number], { validated: false }> extends {
    validation_reason: string
  }
    ? true
    : false

const fixtureRoot = path.resolve(
  import.meta.dir,
  '../fixtures/review-artifacts',
)

const baseFinding = {
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
  validated: true,
  validation_reason: 'The issue is reproducible in the changed code.',
}

const admittedFinding = {
  record_type: 'admitted',
  input_id: 'correctness#1',
  reviewer: 'correctness',
  confidence: 0.85,
  disposition: 'surviving',
  reason: 'The finding passed the confidence gate.',
}

const rejectedSummary = {
  record_type: 'rejected_summary',
  reviewer: 'testing',
  dispatch_outcome: 'malformed',
  rejected_finding_count: 2,
  rejected_severities: ['P2', 'unknown'],
  disposition: 'rejected',
  reason: 'The persona return failed schema validation.',
}

const baseArtifact: JsonObject = {
  schema_version: 1,
  run_id: '20260821-000000-example',
  mode: 'interactive',
  harness: 'opencode',
  run_status: 'completed',
  verdict: 'Ready to merge',
  branch: 'fix/example',
  head_sha: '0123456789abcdef0123456789abcdef01234567',
  completed_at: '2026-08-21T00:00:00Z',
  dispatches: [
    {
      persona: 'correctness',
      dispatch_outcome: 'findings',
      input_finding_count: 1,
    },
    {
      persona: 'testing',
      dispatch_outcome: 'malformed',
      input_finding_count: 2,
      rejection_reason: 'The persona return failed schema validation.',
    },
  ],
  input_findings: [admittedFinding, rejectedSummary],
  findings: [
    {
      ...baseFinding,
      input_finding_ids: ['correctness#1'],
      provenance: {
        fingerprint: 'src/example.ts|42',
        submitters: ['correctness'],
        agreement_credit: [],
      },
    },
  ],
  disposition_counts: {
    surviving: 1,
    merged: 0,
    suppressed: 0,
    filtered: 0,
    rejected: 2,
  },
  applied_fixes: ['Updated the example path.'],
  residual_actionable_work: [],
  advisory_outputs: ['Review the example boundary manually.'],
  coverage: {
    reviewers: 2,
    validators: 1,
    residual_risks: [],
    testing_gaps: [],
    failed_reviewers: ['testing'],
    validator_failures: [],
    intent_uncertainty: [],
  },
}

function artifactWith(changes: JsonObject): JsonObject {
  return { ...baseArtifact, ...changes }
}

function readFixture(name: string): JsonObject {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, name), 'utf8'),
  ) as JsonObject
}

describe('review artifact schema', () => {
  test('accepts a fully populated artifact with admitted and rejected ledger rows', () => {
    const result = ReviewArtifactSchema.safeParse(baseArtifact)

    expect(result.success).toBe(true)
  })

  test('rejects a risk-critical dispatch without a selection surface', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects a risk-critical dispatch with an empty selection surface', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
            selection_surface: [],
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('accepts an always-on dispatch without a selection surface', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
          },
        ],
      }),
    )

    expect(result.success).toBe(true)
  })

  test('rejects satisfied risk coverage without a citing input finding ID', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        risk_coverage: [
          {
            persona: 'security',
            satisfied: true,
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects unsatisfied risk coverage with a citing input finding ID', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        risk_coverage: [
          {
            persona: 'security',
            satisfied: false,
            input_finding_id: 'correctness#1',
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('accepts an artifact that omits risk coverage', () => {
    const result = ReviewArtifactSchema.safeParse(baseArtifact)

    expect(result.success).toBe(true)
  })

  test('accepts an artifact that omits validation', () => {
    const result = ReviewArtifactSchema.safeParse(baseArtifact)

    expect(result.success).toBe(true)
  })

  test('accepts passed validation without a reason', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ validation: { status: 'passed' } }),
    )

    expect(result.success).toBe(true)
  })

  test('rejects passed validation with a reason', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        validation: { status: 'passed', reason: 'The check completed.' },
      }),
    )

    expect(result.success).toBe(false)
  })

  test('requires a reason for every non-passed validation status', () => {
    for (const status of ['failed', 'unavailable', 'not_attempted'] as const) {
      const result = ReviewArtifactSchema.safeParse(
        artifactWith({ validation: { status } }),
      )

      expect(result.success, `${status} should require a reason`).toBe(false)
    }
  })

  test('accepts a reason for every non-passed validation status', () => {
    for (const status of ['failed', 'unavailable', 'not_attempted'] as const) {
      const result = ReviewArtifactSchema.safeParse(
        artifactWith({
          validation: { status, reason: 'The check was not successful.' },
        }),
      )

      expect(result.success, `${status} should accept a reason`).toBe(true)
    }
  })

  test('rejects an unknown validation status', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ validation: { status: 'unknown' } }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects extra keys inside validation', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        validation: { status: 'passed', extra: 'not part of the contract' },
      }),
    )

    expect(result.success).toBe(false)
  })

  test('enforces the validation reason length bound', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        validation: { status: 'failed', reason: 'x'.repeat(2049) },
      }),
    )

    expect(result.success).toBe(false)
  })

  test('enforces selection surface path and array bounds', () => {
    const tooLongPath = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
            selection_surface: [`src/${'x'.repeat(253)}`],
          },
        ],
      }),
    )
    expect(tooLongPath.success).toBe(false)

    const tooManyPaths = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
            selection_surface: Array.from(
              { length: 33 },
              (_, index) => `src/example-${index}.ts`,
            ),
          },
        ],
      }),
    )
    expect(tooManyPaths.success).toBe(false)

    const tooLongReason = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
            selection_surface: ['src/example.ts'],
            selection_reason: 'x'.repeat(2049),
          },
        ],
      }),
    )
    expect(tooLongReason.success).toBe(false)

    const tooManyCoverageEntries = ReviewArtifactSchema.safeParse(
      artifactWith({
        risk_coverage: Array.from({ length: 65 }, () => ({
          persona: 'security',
          satisfied: false,
        })),
      }),
    )
    expect(tooManyCoverageEntries.success).toBe(false)
  })

  test('requires a validation reason in the type for unvalidated findings', () => {
    const requirement: UnvalidatedFindingRequiresReason = true

    expect(requirement).toBe(true)
  })

  test('accepts an artifact with an empty input_findings array', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ input_findings: [] }),
    )

    expect(result.success).toBe(true)
  })

  test('accepts a well-formed declined merge entry', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        declined_merges: [
          {
            file: 'src/example.ts',
            input_finding_ids: ['correctness#1', 'testing#1'],
            reason: 'The findings describe separate validation paths.',
          },
        ],
      }),
    )

    expect(result.success).toBe(true)
  })

  test('accepts an artifact that omits declined merges', () => {
    const result = ReviewArtifactSchema.safeParse(baseArtifact)

    expect(result.success).toBe(true)
  })

  test('rejects a declined merge entry missing a required field', () => {
    const entry = {
      file: 'src/example.ts',
      input_finding_ids: ['correctness#1', 'testing#1'],
      reason: 'The findings describe separate validation paths.',
    }

    for (const field of ['file', 'input_finding_ids', 'reason'] as const) {
      const incompleteEntry = { ...entry }
      delete incompleteEntry[field]
      const result = ReviewArtifactSchema.safeParse(
        artifactWith({ declined_merges: [incompleteEntry] }),
      )

      expect(result.success, `${field} should be required`).toBe(false)
    }
  })

  test('enforces declined merge array and reason bounds', () => {
    const entry = {
      file: 'src/example.ts',
      input_finding_ids: ['correctness#1', 'testing#1'],
      reason: 'The findings describe separate validation paths.',
    }

    const tooManyEntries = ReviewArtifactSchema.safeParse(
      artifactWith({
        declined_merges: Array.from({ length: 33 }, () => entry),
      }),
    )
    expect(tooManyEntries.success).toBe(false)

    const tooManyInputIds = ReviewArtifactSchema.safeParse(
      artifactWith({
        declined_merges: [
          {
            ...entry,
            input_finding_ids: Array.from(
              { length: 33 },
              (_, index) => `reviewer#${index + 1}`,
            ),
          },
        ],
      }),
    )
    expect(tooManyInputIds.success).toBe(false)

    const oversizedReason = ReviewArtifactSchema.safeParse(
      artifactWith({
        declined_merges: [{ ...entry, reason: 'x'.repeat(2049) }],
      }),
    )
    expect(oversizedReason.success).toBe(false)
  })

  test('rejects a rejected summary with no rejected findings', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        input_findings: [
          {
            ...rejectedSummary,
            rejected_finding_count: 0,
            rejected_severities: [],
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join('.') === 'input_findings.0.rejected_finding_count',
        ),
      ).toBe(true)
    }
  })

  test('rejects a rejected summary whose severity count disagrees', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        input_findings: [
          {
            ...rejectedSummary,
            rejected_finding_count: 2,
            rejected_severities: ['P2'],
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join('.') === 'input_findings.0.rejected_severities',
        ),
      ).toBe(true)
    }
  })

  test('rejects an admitted row carrying rejected-summary fields', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        input_findings: [{ ...admittedFinding, rejected_finding_count: 1 }],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects a ledger row without record_type', () => {
    const { record_type: _recordType, ...withoutRecordType } = admittedFinding
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ input_findings: [withoutRecordType] }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects schema_version values other than literal 1', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ schema_version: 2 }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects an artifact without verdict', () => {
    const { verdict: _verdict, ...withoutVerdict } = baseArtifact
    const result = ReviewArtifactSchema.safeParse(withoutVerdict)

    expect(result.success).toBe(false)
  })

  test('accepts an empty branch for detached HEAD artifacts', () => {
    const result = ReviewArtifactSchema.safeParse(artifactWith({ branch: '' }))

    expect(result.success).toBe(true)
  })

  test('rejects short and uppercase head SHAs', () => {
    for (const head_sha of [
      '0123456789abcdef',
      '0123456789ABCDEF0123456789abcdef01234567',
    ]) {
      const result = ReviewArtifactSchema.safeParse(artifactWith({ head_sha }))

      expect(result.success).toBe(false)
    }
  })

  test('rejects a malformed completion timestamp', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ completed_at: 'not-a-timestamp' }),
    )

    expect(result.success).toBe(false)
  })

  test('requires branch, head SHA, and completion timestamp', () => {
    for (const field of ['branch', 'head_sha', 'completed_at'] as const) {
      const artifact = { ...baseArtifact }
      delete artifact[field]

      const result = ReviewArtifactSchema.safeParse(artifact)

      expect(result.success, `${field} should be required`).toBe(false)
    }
  })

  test('rejects an unknown top-level key', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ unknown_key: 'not part of the contract' }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects a string exceeding its explicit bound', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({ run_id: 'x'.repeat(65) }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects every historical artifact fixture with its expected issue set', () => {
    const historicalFixtures = [
      'historical-review-summary-20260714.json',
      'historical-review-summary-20260713.json',
      'historical-review-summary-20260714-181943.json',
      'historical-summary-20260731-212644.json',
      'historical-summary-20260731-140958.json',
      'historical-summary-20260801.json',
      'historical-review-summary-20260817.json',
    ]

    const expectedIssues: Record<string, string[]> = {
      'historical-review-summary-20260713.json': [
        'schema_version invalid_value',
        'branch invalid_type',
        'head_sha invalid_type',
        'harness invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        'dispatches invalid_type',
        'input_findings invalid_type',
        'findings.0.why_it_matters invalid_type',
        'findings.0.evidence invalid_type',
        'findings.0.pre_existing invalid_type',
        'findings.0.input_finding_ids invalid_type',
        'findings.0.provenance invalid_type',
        'findings.0 unrecognized_keys',
        'findings.1.why_it_matters invalid_type',
        'findings.1.evidence invalid_type',
        'findings.1.pre_existing invalid_type',
        'findings.1.input_finding_ids invalid_type',
        'findings.1.provenance invalid_type',
        'findings.1 unrecognized_keys',
        'disposition_counts invalid_type',
        'applied_fixes invalid_type',
        'residual_actionable_work invalid_type',
        'advisory_outputs invalid_type',
        'coverage invalid_type',
        '$ unrecognized_keys',
      ],
      'historical-review-summary-20260714-181943.json': [
        'schema_version invalid_value',
        'branch invalid_type',
        'head_sha invalid_type',
        'harness invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        'dispatches invalid_type',
        'input_findings invalid_type',
        'findings.0.why_it_matters invalid_type',
        'findings.0.evidence invalid_type',
        'findings.0.pre_existing invalid_type',
        'findings.0.input_finding_ids invalid_type',
        'findings.0.provenance invalid_type',
        'findings.1.why_it_matters invalid_type',
        'findings.1.evidence invalid_type',
        'findings.1.pre_existing invalid_type',
        'findings.1.input_finding_ids invalid_type',
        'findings.1.provenance invalid_type',
        'disposition_counts invalid_type',
        'residual_actionable_work invalid_type',
        'advisory_outputs invalid_type',
        'coverage invalid_type',
        '$ unrecognized_keys',
      ],
      'historical-review-summary-20260714.json': [
        'schema_version invalid_value',
        'branch invalid_type',
        'head_sha invalid_type',
        'harness invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        'dispatches invalid_type',
        'input_findings invalid_type',
        ...Array.from({ length: 5 }, (_, index) => [
          `findings.${index}.file invalid_type`,
          `findings.${index}.line invalid_type`,
          `findings.${index}.why_it_matters invalid_type`,
          `findings.${index}.autofix_class invalid_value`,
          `findings.${index}.owner invalid_value`,
          `findings.${index}.requires_verification invalid_type`,
          `findings.${index}.confidence invalid_type`,
          `findings.${index}.evidence invalid_type`,
          `findings.${index}.pre_existing invalid_type`,
          `findings.${index}.input_finding_ids invalid_type`,
          `findings.${index}.provenance invalid_type`,
          `findings.${index} unrecognized_keys`,
        ]).flat(),
        'disposition_counts invalid_type',
        'applied_fixes invalid_type',
        'residual_actionable_work invalid_type',
        'advisory_outputs invalid_type',
        'coverage.residual_risks invalid_type',
        'coverage.testing_gaps invalid_type',
        'coverage.failed_reviewers invalid_type',
        'coverage.validator_failures invalid_type',
        'coverage.intent_uncertainty invalid_type',
        'coverage unrecognized_keys',
        '$ unrecognized_keys',
      ],
      'historical-review-summary-20260817.json': [
        'schema_version invalid_value',
        'run_id invalid_type',
        'branch invalid_type',
        'head_sha invalid_type',
        'mode invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        ...Array.from({ length: 9 }, (_, index) => [
          `dispatches.${index}.persona invalid_type`,
          `dispatches.${index}.input_finding_count invalid_type`,
          `dispatches.${index} unrecognized_keys`,
        ]).flat(),
        'input_findings invalid_type',
        'findings invalid_type',
        'disposition_counts invalid_type',
        'applied_fixes invalid_type',
        'residual_actionable_work invalid_type',
        'advisory_outputs invalid_type',
        'coverage invalid_type',
        '$ unrecognized_keys',
      ],
      'historical-summary-20260731-140958.json': [
        'schema_version invalid_value',
        'run_id invalid_type',
        'head_sha invalid_type',
        'harness invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        'dispatches invalid_type',
        'input_findings invalid_type',
        'findings invalid_type',
        'disposition_counts invalid_type',
        'applied_fixes invalid_type',
        'residual_actionable_work invalid_type',
        'advisory_outputs invalid_type',
        'coverage.residual_risks invalid_type',
        'coverage.testing_gaps invalid_type',
        'coverage.failed_reviewers invalid_type',
        'coverage.validator_failures invalid_type',
        'coverage.intent_uncertainty invalid_type',
        'coverage unrecognized_keys',
        '$ unrecognized_keys',
      ],
      'historical-summary-20260731-212644.json': [
        'schema_version invalid_value',
        'run_id invalid_type',
        'head_sha invalid_type',
        'harness invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        'dispatches invalid_type',
        'input_findings invalid_type',
        'disposition_counts invalid_type',
        'advisory_outputs invalid_type',
        'coverage.residual_risks invalid_type',
        'coverage.testing_gaps invalid_type',
        'coverage.intent_uncertainty invalid_type',
        'coverage unrecognized_keys',
        '$ unrecognized_keys',
      ],
      'historical-summary-20260801.json': [
        'schema_version invalid_value',
        'run_id invalid_type',
        'head_sha invalid_type',
        'harness invalid_value',
        'run_status invalid_value',
        'completed_at invalid_type',
        'dispatches invalid_type',
        'input_findings invalid_type',
        'findings.0.why_it_matters invalid_type',
        'findings.0.evidence invalid_type',
        'findings.0.pre_existing invalid_type',
        'findings.0.input_finding_ids invalid_type',
        'findings.0.provenance invalid_type',
        'findings.0 unrecognized_keys',
        'disposition_counts invalid_type',
        'advisory_outputs invalid_type',
        'coverage.residual_risks invalid_type',
        'coverage.testing_gaps invalid_type',
        'coverage.intent_uncertainty invalid_type',
        'coverage unrecognized_keys',
        '$ unrecognized_keys',
      ],
    }

    for (const fixture of historicalFixtures) {
      const result = ReviewArtifactSchema.safeParse(readFixture(fixture))

      expect(result.success, `${fixture}: unexpectedly valid`).toBe(false)
      if (!result.success) {
        const issueSignatures = result.error.issues.map(
          (issue) => `${issue.path.join('.') || '$'} ${issue.code}`,
        )
        const expected = expectedIssues[fixture]
        if (!expected) {
          throw new Error(`${fixture}: missing entry in expectedIssues`)
        }
        expect(issueSignatures, `${fixture}: unexpected issue set`).toEqual(
          expected,
        )
      }
    }
  })

  test('all custom schema issues use authored literal messages', () => {
    const customMessages = new Set<string>(REVIEW_ARTIFACT_CUSTOM_MESSAGES)
    const cases = [
      artifactWith({
        input_findings: [
          {
            ...rejectedSummary,
            rejected_severities: ['P2'],
          },
        ],
      }),
      artifactWith({
        findings: [
          {
            ...baseFinding,
            validated: false,
            validation_reason: undefined,
            input_finding_ids: ['correctness#1'],
            provenance: {
              fingerprint: 'src/example.ts|42',
              submitters: ['correctness'],
              agreement_credit: [],
            },
          },
        ],
      }),
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'findings',
            input_finding_count: 1,
          },
        ],
      }),
      artifactWith({
        risk_coverage: [
          {
            persona: 'security',
            satisfied: true,
          },
        ],
      }),
      artifactWith({
        risk_coverage: [
          {
            persona: 'security',
            satisfied: false,
            input_finding_id: 'correctness#1',
          },
        ],
      }),
      artifactWith({ validation: { status: 'failed' } }),
      artifactWith({
        validation: { status: 'passed', reason: 'The check completed.' },
      }),
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 2,
          },
        ],
        input_findings: [],
      }),
      artifactWith({
        run_status: 'completed',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
        input_findings: [],
      }),
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
      }),
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
        input_findings: [{ ...rejectedSummary, reviewer: 'correctness' }],
      }),
    ]

    const issues = cases.flatMap((value) => {
      const result = ReviewArtifactSchema.safeParse(value)
      expect(result.success).toBe(false)
      return result.success
        ? []
        : result.error.issues.filter((issue) => issue.code === 'custom')
    })

    expect(issues.length).toBe(11)
    for (const issue of issues) {
      expect(customMessages.has(issue.message)).toBe(true)
    }
  })

  test('accepts the committed conforming fixture', () => {
    const result = ReviewArtifactSchema.safeParse(
      readFixture('conforming-review-summary.json'),
    )

    expect(result.success).toBe(true)
  })
})

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

const parentFindingFixture = {
  ...rawFindingFixture,
  disposition: 'surviving',
}

const parentRecordFixture = {
  reviewer: 'correctness',
  harness: 'opencode',
  dispatch_outcome: 'findings',
  findings: [parentFindingFixture],
  residual_risks: [],
  testing_gaps: [],
}

function rawWithFinding(changes: JsonObject): JsonObject {
  return {
    ...rawReturnFixture,
    findings: [{ ...rawFindingFixture, ...changes }],
  }
}

describe('raw reviewer return and parent record schemas', () => {
  test('accepts a conforming empty raw return', () => {
    const result = SubAgentReturnSchema.safeParse({
      ...rawReturnFixture,
      findings: [],
    })

    expect(result.success).toBe(true)
  })

  test('accepts a conforming findings raw return with bounded overflow evidence', () => {
    const result = SubAgentReturnSchema.safeParse({
      ...rawReturnFixture,
      findings: [
        {
          ...rawFindingFixture,
          evidence: [{ overflow: true, excerpt: 'src/example.ts excerpt' }],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test('accepts every raw severity from P0 through P3', () => {
    for (const severity of ['P0', 'P1', 'P2', 'P3'] as const) {
      const result = SubAgentReturnSchema.safeParse(
        rawWithFinding({ severity }),
      )

      expect(result.success, severity).toBe(true)
    }
  })

  test('rejects medium and the parent-only unknown severity on raw findings', () => {
    for (const severity of ['medium', 'unknown']) {
      const result = SubAgentReturnSchema.safeParse(
        rawWithFinding({ severity }),
      )

      expect(result.success, severity).toBe(false)
    }
  })

  test('rejects parent-owned reviewer and dispatch fields on raw returns', () => {
    for (const annotation of [
      { harness: 'opencode' },
      { dispatch_outcome: 'findings' },
      { reviewer: 'correctness', harness: 'opencode' },
    ]) {
      const result = SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        ...annotation,
      })

      expect(result.success, JSON.stringify(annotation)).toBe(false)
    }
  })

  test('rejects parent-owned disposition and validation annotations on raw findings', () => {
    for (const annotation of [
      { disposition: 'surviving' },
      { validated: true },
      { validation_reason: 'The finding was validated.' },
      { input_finding_ids: ['correctness#1'] },
      { provenance: {} },
    ]) {
      const result = SubAgentReturnSchema.safeParse(rawWithFinding(annotation))

      expect(result.success, JSON.stringify(annotation)).toBe(false)
    }
  })

  test('accepts a conforming parent record with harness, dispatch, and disposition', () => {
    const result = ParentRecordSchema.safeParse(parentRecordFixture)

    expect(result.success).toBe(true)
  })

  test('accepts an empty parent record', () => {
    const result = ParentRecordSchema.safeParse({
      ...parentRecordFixture,
      findings: [],
    })

    expect(result.success).toBe(true)
  })

  test('requires dispatch_outcome and harness on parent records', () => {
    for (const field of ['dispatch_outcome', 'harness'] as const) {
      const parent: Record<string, unknown> = { ...parentRecordFixture }
      delete parent[field]

      expect(ParentRecordSchema.safeParse(parent).success, field).toBe(false)
    }
  })

  test('requires disposition on parent findings but not raw findings', () => {
    expect(
      ParentRecordSchema.safeParse({
        ...parentRecordFixture,
        findings: [rawFindingFixture],
      }).success,
    ).toBe(false)
    expect(SubAgentFindingSchema.safeParse(rawFindingFixture).success).toBe(
      true,
    )
    expect(ParentFindingSchema.safeParse(parentFindingFixture).success).toBe(
      true,
    )
  })

  test('does not accept a raw return as a parent record or vice versa', () => {
    expect(ParentRecordSchema.safeParse(rawReturnFixture).success).toBe(false)
    expect(SubAgentReturnSchema.safeParse(parentRecordFixture).success).toBe(
      false,
    )
  })

  test('rejects malformed nested findings', () => {
    for (const finding of [
      { ...rawFindingFixture, line: 0 },
      { ...rawFindingFixture, line: -1 },
      { ...rawFindingFixture, confidence: 1.5 },
      { ...rawFindingFixture, evidence: [] },
      { ...rawFindingFixture, evidence: [{ overflow: true }] },
      { ...rawFindingFixture, severity: 'medium' },
    ]) {
      const result = SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        findings: [finding],
      })

      expect(result.success, JSON.stringify(finding)).toBe(false)
    }
  })

  test('preserves integer >= 1 line semantics without a safe-integer maximum', () => {
    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ line: 9007199254740992 }))
        .success,
    ).toBe(true)
    expect(
      ParentRecordSchema.safeParse({
        ...parentRecordFixture,
        findings: [{ ...parentFindingFixture, line: 9007199254740992 }],
      }).success,
    ).toBe(true)

    for (const line of [1.5, 0, -1]) {
      expect(
        SubAgentReturnSchema.safeParse(rawWithFinding({ line })).success,
        `${line}`,
      ).toBe(false)
    }
  })

  test('shares one line-number schema so every admitted raw line is representable in the artifact', () => {
    const unsafeLine = 9007199254740992
    const provenance = {
      fingerprint: `src/example.ts|${unsafeLine}`,
      submitters: ['correctness'],
      agreement_credit: [],
    }

    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ line: unsafeLine }))
        .success,
    ).toBe(true)
    expect(
      ReviewArtifactSchema.safeParse(
        artifactWith({
          findings: [
            {
              ...baseFinding,
              line: unsafeLine,
              input_finding_ids: ['correctness#1'],
              provenance,
            },
          ],
        }),
      ).success,
    ).toBe(true)

    for (const line of [1.5, 0, -1]) {
      expect(
        ReviewArtifactSchema.safeParse(
          artifactWith({
            findings: [
              {
                ...baseFinding,
                line,
                input_finding_ids: ['correctness#1'],
                provenance,
              },
            ],
          }),
        ).success,
        `aggregate line ${line}`,
      ).toBe(false)
    }
  })

  test('rejects unknown top-level and nested fields', () => {
    expect(
      SubAgentReturnSchema.safeParse({ ...rawReturnFixture, rogue: true })
        .success,
    ).toBe(false)
    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ rogue: true })).success,
    ).toBe(false)
    expect(
      ParentRecordSchema.safeParse({ ...parentRecordFixture, rogue: true })
        .success,
    ).toBe(false)
    expect(
      ParentRecordSchema.safeParse({
        ...parentRecordFixture,
        findings: [{ ...parentFindingFixture, rogue: true }],
      }).success,
    ).toBe(false)
  })

  test('enforces reviewer, title, why_it_matters, suggested_fix, and confidence bounds', () => {
    expect(
      SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        reviewer: 'x'.repeat(64),
      }).success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        reviewer: 'x'.repeat(65),
      }).success,
    ).toBe(false)

    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ title: 'x'.repeat(256) }))
        .success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ title: 'x'.repeat(257) }))
        .success,
    ).toBe(false)

    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({ why_it_matters: 'x'.repeat(2048) }),
      ).success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({ why_it_matters: 'x'.repeat(2049) }),
      ).success,
    ).toBe(false)

    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({ suggested_fix: 'x'.repeat(2048) }),
      ).success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({ suggested_fix: 'x'.repeat(2049) }),
      ).success,
    ).toBe(false)
    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ suggested_fix: null }))
        .success,
    ).toBe(true)

    for (const confidence of [0, 1]) {
      expect(
        SubAgentReturnSchema.safeParse(rawWithFinding({ confidence })).success,
        `${confidence}`,
      ).toBe(true)
    }
    for (const confidence of [-0.1, 1.1]) {
      expect(
        SubAgentReturnSchema.safeParse(rawWithFinding({ confidence })).success,
        `${confidence}`,
      ).toBe(false)
    }
  })

  test('enforces evidence count and entry bounds', () => {
    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({
          evidence: Array.from({ length: 5 }, (_, index) => `e${index}`),
        }),
      ).success,
    ).toBe(true)
    for (const evidence of [
      [],
      Array.from({ length: 6 }, (_, index) => `e${index}`),
    ]) {
      expect(
        SubAgentReturnSchema.safeParse(rawWithFinding({ evidence })).success,
      ).toBe(false)
    }

    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({ evidence: ['x'.repeat(500)] }),
      ).success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({ evidence: ['x'.repeat(501)] }),
      ).success,
    ).toBe(false)

    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({
          evidence: [{ overflow: true, excerpt: 'x'.repeat(500) }],
        }),
      ).success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse(
        rawWithFinding({
          evidence: [{ overflow: true, excerpt: 'x'.repeat(501) }],
        }),
      ).success,
    ).toBe(false)
  })

  test('enforces the findings array bound', () => {
    expect(
      SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        findings: Array.from({ length: 32 }, () => rawFindingFixture),
      }).success,
    ).toBe(true)
    expect(
      SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        findings: Array.from({ length: 33 }, () => rawFindingFixture),
      }).success,
    ).toBe(false)
  })

  test('preserves residual-risk and testing-gap acceptance semantics', () => {
    // Empty and whitespace-only strings remain acceptable; these fields must
    // not inherit the ReasonSchema non-empty/pattern restrictions.
    expect(
      SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        residual_risks: [''],
        testing_gaps: ['   '],
      }).success,
    ).toBe(true)

    expect(
      SubAgentReturnSchema.safeParse({
        ...rawReturnFixture,
        residual_risks: ['x'.repeat(1024)],
        testing_gaps: ['x'.repeat(1024)],
      }).success,
    ).toBe(true)
    for (const key of ['residual_risks', 'testing_gaps'] as const) {
      expect(
        SubAgentReturnSchema.safeParse({
          ...rawReturnFixture,
          [key]: ['x'.repeat(1025)],
        }).success,
        `${key} maxLength`,
      ).toBe(false)
      expect(
        SubAgentReturnSchema.safeParse({
          ...rawReturnFixture,
          [key]: Array.from({ length: 65 }, () => 'risk'),
        }).success,
        `${key} maxItems`,
      ).toBe(false)
    }
  })

  test('enforces repository-relative path conventions for files and evidence', () => {
    const absolutePaths = [
      '/Users/example/repo/src/file.ts',
      'C:\\repo\\src\\file.ts',
      'C:/repo/src/file.ts',
      '\\\\server\\share\\file.ts',
    ]

    for (const file of absolutePaths) {
      expect(
        SubAgentReturnSchema.safeParse(rawWithFinding({ file })).success,
        file,
      ).toBe(false)
      expect(
        SubAgentReturnSchema.safeParse(rawWithFinding({ evidence: [file] }))
          .success,
        `evidence: ${file}`,
      ).toBe(false)
    }

    expect(
      SubAgentReturnSchema.safeParse(rawWithFinding({ file: 'src/file.ts' }))
        .success,
    ).toBe(true)
  })

  test('does not regress the aggregate review artifact contract', () => {
    expect(ReviewArtifactSchema.safeParse(baseArtifact).success).toBe(true)
    // A raw return is not an aggregate artifact: the boundary is preserved.
    expect(ReviewArtifactSchema.safeParse(rawReturnFixture).success).toBe(false)
  })
})

describe('dispatch outcome validation_unavailable (KTD8 amendment)', () => {
  test('accepts a zero-count validation_unavailable dispatch entry in a degraded run', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
            rejection_reason: 'Raw validator command could not run.',
          },
        ],
        input_findings: [],
      }),
    )

    expect(result.success).toBe(true)
  })

  test('rejects a completed run carrying validation_unavailable evidence', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        run_status: 'completed',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
        input_findings: [],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join('.') === 'run_status',
        ),
      ).toBe(true)
    }
  })

  test('rejects a validation_unavailable dispatch with a nonzero input finding count', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 3,
          },
        ],
        input_findings: [],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join('.') === 'dispatches.0.input_finding_count',
        ),
      ).toBe(true)
    }
  })

  test('rejects an admitted input finding for a validation_unavailable persona', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join('.') === 'input_findings.0.reviewer',
        ),
      ).toBe(true)
    }
  })

  test('rejects a rejected-summary row for a validation_unavailable persona', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'correctness',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
        input_findings: [{ ...rejectedSummary, reviewer: 'correctness' }],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join('.') === 'input_findings.0.reviewer',
        ),
      ).toBe(true)
    }
  })

  test('accepts truthful in_progress and abnormal runs carrying validation_unavailable', () => {
    for (const run_status of ['in_progress', 'abnormal'] as const) {
      const result = ReviewArtifactSchema.safeParse(
        artifactWith({
          run_status,
          dispatches: [
            {
              persona: 'correctness',
              dispatch_outcome: 'validation_unavailable',
              input_finding_count: 0,
            },
          ],
          input_findings: [],
        }),
      )

      expect(result.success, run_status).toBe(true)
    }
  })

  test('accepts a degraded run carrying validation_unavailable', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        run_status: 'degraded',
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
            selection_surface: ['src/auth.ts'],
            selection_reason: 'Authentication surface changed.',
          },
        ],
      }),
    )

    expect(result.success).toBe(true)
  })

  test('rejects a risk-critical validation_unavailable dispatch without a selection surface', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        dispatches: [
          {
            persona: 'security',
            dispatch_outcome: 'validation_unavailable',
            input_finding_count: 0,
          },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('rejects a rejected-summary row carrying validation_unavailable', () => {
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        input_findings: [
          { ...rejectedSummary, dispatch_outcome: 'validation_unavailable' },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  test('accepts a legacy schema_version 1 rejected-summary row carrying never_returned', () => {
    // Reader compatibility: historical schema_version 1 artifacts could carry
    // this row even though new writers must never emit it.
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        input_findings: [
          { ...rejectedSummary, dispatch_outcome: 'never_returned' },
        ],
      }),
    )

    expect(result.success).toBe(true)
  })

  test('accepts a legacy schema_version 1 rejected-summary row carrying empty', () => {
    // `empty` is preserved solely so existing schema_version 1 artifacts stay
    // valid; it is not a semantically valid rejected-summary outcome and the
    // prose contract continues to forbid it.
    const result = ReviewArtifactSchema.safeParse(
      artifactWith({
        input_findings: [{ ...rejectedSummary, dispatch_outcome: 'empty' }],
      }),
    )

    expect(result.success).toBe(true)
  })

  test('keeps the existing four dispatch outcomes valid', () => {
    for (const dispatch_outcome of [
      'findings',
      'empty',
      'malformed',
      'never_returned',
    ] as const) {
      const result = ReviewArtifactSchema.safeParse(
        artifactWith({
          dispatches: [
            {
              persona: 'correctness',
              dispatch_outcome,
              input_finding_count: 0,
            },
          ],
        }),
      )

      expect(result.success, dispatch_outcome).toBe(true)
    }
  })
})
