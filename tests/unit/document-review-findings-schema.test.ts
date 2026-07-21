import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'

type Finding = {
  title: string
  severity: 'P0' | 'P1' | 'P2' | 'P3'
  section: string
  why_it_matters: string
  finding_type: 'error' | 'omission'
  autofix_class: 'safe_auto' | 'gated_auto' | 'manual'
  confidence: number
  evidence: string[]
  suggested_fix?: string
}

type Report = {
  reviewer: string
  findings: Finding[]
  residual_risks: string[]
  deferred_questions: string[]
}

const schemaPath = path.resolve(
  import.meta.dir,
  '../../skills/document-review/references/findings-schema.json',
)
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<
  string,
  unknown
>
const validate = new Ajv({ strict: false }).compile(schema)

const baseFinding: Finding = {
  title: 'Missing deployment ordering',
  severity: 'P1',
  section: 'Implementation',
  why_it_matters: 'The deployment can fail when the migration runs too late.',
  finding_type: 'omission',
  autofix_class: 'gated_auto',
  confidence: 75,
  evidence: ['Deploy the application before the migration.'],
  suggested_fix: 'Specify the migration and deployment ordering.',
}

const baseReport: Report = {
  reviewer: 'feasibility',
  findings: [baseFinding],
  residual_risks: [],
  deferred_questions: [],
}

function reportWithFinding(changes: Partial<Finding>): Report {
  return {
    ...baseReport,
    findings: [{ ...baseFinding, ...changes }],
  }
}

describe('document review findings schema', () => {
  test('accepts every confidence anchor', () => {
    for (const confidence of [0, 25, 50, 75, 100]) {
      expect(validate(reportWithFinding({ confidence }))).toBe(true)
    }
  })

  test('accepts every autofix class', () => {
    for (const autofix_class of [
      'safe_auto',
      'gated_auto',
      'manual',
    ] as const) {
      expect(validate(reportWithFinding({ autofix_class }))).toBe(true)
    }
  })

  test('rejects decimal confidence', () => {
    expect(validate(reportWithFinding({ confidence: 0.9 }))).toBe(false)
  })

  test('rejects out-of-set confidence values', () => {
    expect(validate(reportWithFinding({ confidence: 60 }))).toBe(false)
    expect(validate(reportWithFinding({ confidence: 101 }))).toBe(false)
  })

  test('rejects legacy autofix classes', () => {
    expect(
      validate({
        ...baseReport,
        findings: [{ ...baseFinding, autofix_class: 'auto' }],
      }),
    ).toBe(false)
    expect(
      validate({
        ...baseReport,
        findings: [{ ...baseFinding, autofix_class: 'present' }],
      }),
    ).toBe(false)
  })

  test('rejects a report missing a required field', () => {
    const { reviewer: _reviewer, ...missingReviewer } = baseReport
    expect(validate(missingReviewer)).toBe(false)
  })

  test('rejects a finding missing a required field', () => {
    const { title: _title, ...missingTitle } = baseFinding
    expect(validate({ ...baseReport, findings: [missingTitle] })).toBe(false)
  })

  test('rejects empty evidence', () => {
    expect(validate(reportWithFinding({ evidence: [] }))).toBe(false)
  })

  test('accepts a report with no findings', () => {
    expect(validate({ ...baseReport, findings: [] })).toBe(true)
  })
})
