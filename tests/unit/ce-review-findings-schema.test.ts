import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'

const schemaPath = path.resolve(
  import.meta.dir,
  '../../skills/ce-review/references/findings-schema.json',
)
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<
  string,
  unknown
>
const validate = new Ajv({ strict: false }).compile(schema)

const baseFinding = {
  title: 'Missing deployment ordering',
  severity: 'P1',
  file: 'src/deploy/migrate.ts',
  line: 42,
  why_it_matters: 'The deployment can fail when the migration runs too late.',
  autofix_class: 'gated_auto',
  owner: 'downstream-resolver',
  requires_verification: true,
  confidence: 0.75,
  evidence: [
    'src/deploy/migrate.ts:42 runs the deployment before the migration.',
  ],
  pre_existing: false,
  suggested_fix: 'Specify the migration and deployment ordering.',
  disposition: 'surviving',
}

const baseArtifact = {
  reviewer: 'correctness',
  harness: 'opencode',
  dispatch_outcome: 'findings',
  findings: [baseFinding],
  residual_risks: [],
  testing_gaps: [],
}

function artifactWithFinding(changes: Record<string, unknown>) {
  return {
    ...baseArtifact,
    findings: [{ ...baseFinding, ...changes }],
  }
}

function errorMentions(pathSuffix: string): boolean {
  return (validate.errors ?? []).some((error) => {
    const fieldPath = error.instancePath ?? ''
    return (
      fieldPath.endsWith(pathSuffix) ||
      (error.params as { missingProperty?: string }).missingProperty ===
        pathSuffix.split('/').at(-1)
    )
  })
}

describe('ce:review findings schema', () => {
  test('accepts a bounded finding with provenance and disposition', () => {
    expect(validate(baseArtifact)).toBe(true)
  })

  test('accepts every dispatch outcome and disposition vocabulary value', () => {
    for (const dispatch_outcome of [
      'findings',
      'empty',
      'malformed',
      'never_returned',
    ]) {
      expect(validate({ ...baseArtifact, dispatch_outcome })).toBe(true)
    }

    for (const disposition of [
      'surviving',
      'merged',
      'suppressed',
      'filtered',
      'rejected',
    ]) {
      expect(validate(artifactWithFinding({ disposition }))).toBe(true)
    }
  })

  test('rejects an unknown dispatch outcome or disposition', () => {
    expect(validate({ ...baseArtifact, dispatch_outcome: 'dropped' })).toBe(
      false,
    )
    expect(errorMentions('/dispatch_outcome')).toBe(true)

    expect(validate(artifactWithFinding({ disposition: 'dropped' }))).toBe(
      false,
    )
    expect(errorMentions('/findings/0/disposition')).toBe(true)
  })

  test('rejects empty why_it_matters and names the field', () => {
    expect(validate(artifactWithFinding({ why_it_matters: '' }))).toBe(false)
    expect(errorMentions('/findings/0/why_it_matters')).toBe(true)
  })

  test('rejects empty evidence and names the field', () => {
    expect(validate(artifactWithFinding({ evidence: [] }))).toBe(false)
    expect(errorMentions('/findings/0/evidence')).toBe(true)
  })

  test('rejects evidence longer than the entry cap', () => {
    expect(
      validate(
        artifactWithFinding({
          evidence: ['x'.repeat(501)],
        }),
      ),
    ).toBe(false)
    expect(errorMentions('/findings/0/evidence/0')).toBe(true)
  })

  test('accepts a bounded excerpt with an explicit overflow marker', () => {
    expect(
      validate(
        artifactWithFinding({
          evidence: [
            {
              overflow: true,
              excerpt: 'x'.repeat(500),
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  test('rejects evidence exceeding the entry-count cap', () => {
    expect(
      validate(
        artifactWithFinding({
          evidence: Array.from(
            { length: 6 },
            (_, index) => `Evidence ${index}`,
          ),
        }),
      ),
    ).toBe(false)
    expect(errorMentions('/findings/0/evidence')).toBe(true)
  })

  test('rejects absolute paths but accepts repo-relative paths', () => {
    expect(
      validate(
        artifactWithFinding({ file: '/Users/example/repo/src/file.ts' }),
      ),
    ).toBe(false)
    expect(errorMentions('/findings/0/file')).toBe(true)

    expect(validate(artifactWithFinding({ file: 'src/file.ts' }))).toBe(true)
  })

  test('rejects a location without its line and names the missing field', () => {
    const { line: _line, ...locationWithoutLine } = baseFinding
    expect(
      validate({
        ...baseArtifact,
        findings: [locationWithoutLine],
      }),
    ).toBe(false)
    expect(errorMentions('/findings/0/line')).toBe(true)
  })

  test('rejects unknown harness provenance', () => {
    expect(validate({ ...baseArtifact, harness: 'unknown' })).toBe(false)
    expect(errorMentions('/harness')).toBe(true)
  })
})
