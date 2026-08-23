import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  REVIEW_ARTIFACT_CUSTOM_MESSAGES,
  type ReviewArtifact,
  ReviewArtifactSchema,
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
        fingerprint: 'src/example.ts|40|example issue',
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

    const expectedIssues: Record<string, readonly string[]> = {
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
        expect(issueSignatures, `${fixture}: unexpected issue set`).toEqual(
          expectedIssues[fixture],
        )
      }
    }
  })

  test('all custom schema issues use authored literal messages', () => {
    const customMessages = new Set(REVIEW_ARTIFACT_CUSTOM_MESSAGES)
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
              fingerprint: 'src/example.ts|40|example issue',
              submitters: ['correctness'],
              agreement_credit: [],
            },
          },
        ],
      }),
    ]

    const issues = cases.flatMap((value) => {
      const result = ReviewArtifactSchema.safeParse(value)
      expect(result.success).toBe(false)
      return result.success
        ? []
        : result.error.issues.filter((issue) => issue.code === 'custom')
    })

    expect(issues.length).toBe(2)
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
