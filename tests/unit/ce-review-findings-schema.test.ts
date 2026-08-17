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
const ajv = new Ajv({ strict: false })
const validateParent = ajv.compile(schema)
const validateSubAgent = ajv.compile({
  ...schema,
  $ref: '#/definitions/subAgentReturn',
})

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

const { disposition: _disposition, ...baseSubAgentFinding } = baseFinding
const baseSubAgentArtifact = {
  reviewer: 'correctness',
  findings: [baseSubAgentFinding],
  residual_risks: [],
  testing_gaps: [],
}

function artifactWithFinding(changes: Record<string, unknown>) {
  return {
    ...baseArtifact,
    findings: [{ ...baseFinding, ...changes }],
  }
}

function subAgentWithFinding(changes: Record<string, unknown>) {
  return {
    ...baseSubAgentArtifact,
    findings: [{ ...baseSubAgentFinding, ...changes }],
  }
}

function errorMentions(
  validate: typeof validateParent,
  pathSuffix: string,
): boolean {
  return (validate.errors ?? []).some((error) => {
    const fieldPath = error.instancePath ?? ''
    const params = error.params as {
      missingProperty?: string
      additionalProperty?: string
    }
    return (
      fieldPath.endsWith(pathSuffix) ||
      params.missingProperty === pathSuffix.split('/').at(-1) ||
      params.additionalProperty === pathSuffix.split('/').at(-1)
    )
  })
}

function hasKeyword(
  validate: typeof validateParent,
  keyword: string,
  pathSuffix: string,
): boolean {
  return (validate.errors ?? []).some(
    (error) =>
      error.keyword === keyword &&
      (error.instancePath ?? '').endsWith(pathSuffix),
  )
}

function hasAdditionalProperty(
  validate: typeof validateParent,
  property: string,
  instancePath: string,
): boolean {
  return (validate.errors ?? []).some((error) => {
    const params = error.params as { additionalProperty?: string }
    return (
      error.keyword === 'additionalProperties' &&
      error.instancePath === instancePath &&
      params.additionalProperty === property
    )
  })
}

describe('ce:review findings schema', () => {
  test('accepts a bounded parent finding with provenance and disposition', () => {
    expect(validateParent(baseArtifact)).toBe(true)
  })

  test('accepts a sub-agent return without parent-owned fields', () => {
    expect(validateSubAgent(baseSubAgentArtifact)).toBe(true)
  })

  test('accepts every dispatch outcome and disposition vocabulary value', () => {
    for (const dispatch_outcome of [
      'findings',
      'empty',
      'malformed',
      'never_returned',
    ]) {
      expect(validateParent({ ...baseArtifact, dispatch_outcome })).toBe(true)
    }

    for (const disposition of [
      'surviving',
      'merged',
      'suppressed',
      'filtered',
      'rejected',
    ]) {
      expect(validateParent(artifactWithFinding({ disposition }))).toBe(true)
    }
  })

  test('rejects an unknown dispatch outcome or disposition', () => {
    expect(
      validateParent({ ...baseArtifact, dispatch_outcome: 'dropped' }),
    ).toBe(false)
    expect(errorMentions(validateParent, '/dispatch_outcome')).toBe(true)

    expect(
      validateParent(artifactWithFinding({ disposition: 'dropped' })),
    ).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/disposition')).toBe(true)
  })

  test('rejects parent records missing dispatch_outcome', () => {
    const { dispatch_outcome: _dispatchOutcome, ...missingDispatchOutcome } =
      baseArtifact
    expect(validateParent(missingDispatchOutcome)).toBe(false)
    expect(errorMentions(validateParent, '/dispatch_outcome')).toBe(true)
    expect(hasKeyword(validateParent, 'required', '')).toBe(true)
  })

  test('rejects parent findings missing disposition', () => {
    const { disposition: _findingDisposition, ...missingDisposition } =
      baseFinding
    expect(
      validateParent({ ...baseArtifact, findings: [missingDisposition] }),
    ).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/disposition')).toBe(true)
    expect(hasKeyword(validateParent, 'required', '/findings/0')).toBe(true)
  })

  test('rejects sub-agent returns carrying parent-owned fields', () => {
    expect(
      validateSubAgent({ ...baseSubAgentArtifact, harness: 'opencode' }),
    ).toBe(false)
    expect(hasAdditionalProperty(validateSubAgent, 'harness', '')).toBe(true)

    expect(
      validateSubAgent(subAgentWithFinding({ disposition: 'surviving' })),
    ).toBe(false)
    expect(
      hasAdditionalProperty(validateSubAgent, 'disposition', '/findings/0'),
    ).toBe(true)
  })

  test('rejects an unknown top-level field and names the closure constraint', () => {
    expect(
      validateParent({ ...baseArtifact, ROGUE_TOP_LEVEL: 'survives' }),
    ).toBe(false)
    expect(hasAdditionalProperty(validateParent, 'ROGUE_TOP_LEVEL', '')).toBe(
      true,
    )
  })

  test('rejects an unknown finding field and names the closure constraint', () => {
    expect(
      validateParent(artifactWithFinding({ EXTRA_INJECTED_FIELD: 'survives' })),
    ).toBe(false)
    expect(
      hasAdditionalProperty(
        validateParent,
        'EXTRA_INJECTED_FIELD',
        '/findings/0',
      ),
    ).toBe(true)
  })

  test('rejects empty why_it_matters and names the field', () => {
    expect(validateParent(artifactWithFinding({ why_it_matters: '' }))).toBe(
      false,
    )
    expect(errorMentions(validateParent, '/findings/0/why_it_matters')).toBe(
      true,
    )
  })

  test('rejects over-long why_it_matters and names the maxLength constraint', () => {
    expect(
      validateParent(artifactWithFinding({ why_it_matters: 'x'.repeat(2049) })),
    ).toBe(false)
    expect(
      hasKeyword(validateParent, 'maxLength', '/findings/0/why_it_matters'),
    ).toBe(true)
  })

  test('rejects empty evidence and names the field', () => {
    expect(validateParent(artifactWithFinding({ evidence: [] }))).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/evidence')).toBe(true)
  })

  test('accepts evidence at both count and string-length boundaries', () => {
    expect(
      validateParent(
        artifactWithFinding({
          evidence: Array.from(
            { length: 5 },
            (_, index) => `Evidence ${index}`,
          ),
        }),
      ),
    ).toBe(true)
    expect(
      validateParent(
        artifactWithFinding({
          evidence: ['x'.repeat(500)],
        }),
      ),
    ).toBe(true)
  })

  test('rejects evidence longer than the entry cap', () => {
    expect(
      validateParent(
        artifactWithFinding({
          evidence: ['x'.repeat(501)],
        }),
      ),
    ).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/evidence/0')).toBe(true)
    expect(
      hasKeyword(validateParent, 'maxLength', '/findings/0/evidence/0'),
    ).toBe(true)
  })

  test('accepts a bounded excerpt with an explicit overflow marker', () => {
    expect(
      validateParent(
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

  test('rejects absolute paths in overflow excerpts', () => {
    for (const excerpt of [
      '/Users/example/repo/src/file.ts',
      'C:\\repo\\src\\file.ts',
      'C:/repo/src/file.ts',
      '\\\\server\\share\\file.ts',
    ]) {
      expect(
        validateParent(
          artifactWithFinding({
            evidence: [{ overflow: true, excerpt }],
          }),
        ),
      ).toBe(false)
      expect(
        errorMentions(validateParent, '/findings/0/evidence/0/excerpt'),
      ).toBe(true)
    }
  })

  test('rejects evidence exceeding the entry-count cap', () => {
    expect(
      validateParent(
        artifactWithFinding({
          evidence: Array.from(
            { length: 6 },
            (_, index) => `Evidence ${index}`,
          ),
        }),
      ),
    ).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/evidence')).toBe(true)
    expect(hasKeyword(validateParent, 'maxItems', '/findings/0/evidence')).toBe(
      true,
    )
  })

  test('rejects over-count residual risks', () => {
    expect(
      validateParent({
        ...baseArtifact,
        residual_risks: Array.from({ length: 65 }, () => 'risk'),
      }),
    ).toBe(false)
    expect(hasKeyword(validateParent, 'maxItems', '/residual_risks')).toBe(true)
  })

  test('rejects absolute paths but accepts repo-relative paths', () => {
    expect(
      validateParent(
        artifactWithFinding({ file: '/Users/example/repo/src/file.ts' }),
      ),
    ).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/file')).toBe(true)

    for (const file of [
      'C:\\repo\\src\\file.ts',
      'C:/repo/src/file.ts',
      '\\\\server\\share\\file.ts',
    ]) {
      expect(validateParent(artifactWithFinding({ file }))).toBe(false)
      expect(errorMentions(validateParent, '/findings/0/file')).toBe(true)
    }

    expect(validateParent(artifactWithFinding({ file: 'src/file.ts' }))).toBe(
      true,
    )
  })

  test('rejects absolute paths inside evidence', () => {
    for (const evidence of [
      '/Users/example/repo/src/file.ts',
      'C:\\repo\\src\\file.ts',
      'C:/repo/src/file.ts',
      '\\\\server\\share\\file.ts',
    ]) {
      expect(
        validateParent(artifactWithFinding({ evidence: [evidence] })),
      ).toBe(false)
      expect(errorMentions(validateParent, '/findings/0/evidence/0')).toBe(true)
    }
  })

  test('rejects a location without its line and names the missing field', () => {
    const { line: _line, ...locationWithoutLine } = baseFinding
    expect(
      validateParent({
        ...baseArtifact,
        findings: [locationWithoutLine],
      }),
    ).toBe(false)
    expect(errorMentions(validateParent, '/findings/0/line')).toBe(true)
  })

  test('rejects unknown harness provenance', () => {
    expect(validateParent({ ...baseArtifact, harness: 'unknown' })).toBe(false)
    expect(errorMentions(validateParent, '/harness')).toBe(true)
  })
})
