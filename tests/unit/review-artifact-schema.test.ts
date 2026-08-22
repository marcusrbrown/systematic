import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ReviewArtifactSchema } from '../../src/lib/review-artifact-schema.js'

type JsonObject = Record<string, unknown>

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

  test('rejects every historical artifact fixture with a named reason', () => {
    const historicalFixtures = [
      'historical-review-summary-20260817.json',
      'historical-review-summary-20260714.json',
      'historical-review-summary-20260713.json',
      'historical-review-summary-20260714-181943.json',
      'historical-summary-20260731-212644.json',
      'historical-summary-20260731-140958.json',
      'historical-summary-20260801.json',
    ]

    for (const fixture of historicalFixtures) {
      const result = ReviewArtifactSchema.safeParse(readFixture(fixture))

      expect(result.success, `${fixture}: missing schema_version issue`).toBe(
        false,
      )
      if (!result.success) {
        expect(
          result.error.issues.some(
            (issue) =>
              issue.path.length === 1 && issue.path[0] === 'schema_version',
          ),
          `${fixture}: schema_version was not named`,
        ).toBe(true)
      }
    }
  })

  test('accepts the committed conforming fixture', () => {
    const result = ReviewArtifactSchema.safeParse(
      readFixture('conforming-review-summary.json'),
    )

    expect(result.success).toBe(true)
  })
})
