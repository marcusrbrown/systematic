import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'
import { z } from 'zod'

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

  test('rejects whitespace-only strings with the pattern constraint', () => {
    for (const [field, pathSuffix] of [
      ['title', '/findings/0/title'],
      ['why_it_matters', '/findings/0/why_it_matters'],
    ] as const) {
      expect(validateParent(artifactWithFinding({ [field]: ' ' }))).toBe(false)
      expect(hasKeyword(validateParent, 'pattern', pathSuffix)).toBe(true)
    }

    expect(validateParent({ ...baseArtifact, reviewer: ' ' })).toBe(false)
    expect(hasKeyword(validateParent, 'pattern', '/reviewer')).toBe(true)
  })

  test('accepts findings at the maxItems boundary', () => {
    expect(
      validateParent({
        ...baseArtifact,
        findings: Array.from({ length: 32 }, () => baseFinding),
      }),
    ).toBe(true)
  })

  test('rejects findings beyond the maxItems boundary', () => {
    expect(
      validateParent({
        ...baseArtifact,
        findings: Array.from({ length: 33 }, () => baseFinding),
      }),
    ).toBe(false)
    expect(hasKeyword(validateParent, 'maxItems', '/findings')).toBe(true)
  })

  test('accepts a title at the maxLength boundary', () => {
    expect(
      validateParent(artifactWithFinding({ title: 'x'.repeat(256) })),
    ).toBe(true)
  })

  test('rejects a title beyond the maxLength boundary', () => {
    expect(
      validateParent(artifactWithFinding({ title: 'x'.repeat(257) })),
    ).toBe(false)
    expect(hasKeyword(validateParent, 'maxLength', '/findings/0/title')).toBe(
      true,
    )
  })

  test('accepts a suggested_fix at the maxLength boundary', () => {
    expect(
      validateParent(artifactWithFinding({ suggested_fix: 'x'.repeat(2048) })),
    ).toBe(true)
  })

  test('rejects a suggested_fix beyond the maxLength boundary', () => {
    expect(
      validateParent(artifactWithFinding({ suggested_fix: 'x'.repeat(2049) })),
    ).toBe(false)
    expect(
      hasKeyword(validateParent, 'maxLength', '/findings/0/suggested_fix'),
    ).toBe(true)
  })

  test('accepts a reviewer at the maxLength boundary', () => {
    expect(validateParent({ ...baseArtifact, reviewer: 'x'.repeat(64) })).toBe(
      true,
    )
  })

  test('rejects a reviewer beyond the maxLength boundary', () => {
    expect(validateParent({ ...baseArtifact, reviewer: 'x'.repeat(65) })).toBe(
      false,
    )
    expect(hasKeyword(validateParent, 'maxLength', '/reviewer')).toBe(true)
  })

  test('accepts a residual risk item at the maxLength boundary', () => {
    expect(
      validateParent({
        ...baseArtifact,
        residual_risks: ['x'.repeat(1024)],
      }),
    ).toBe(true)
  })

  test('rejects a residual risk item beyond the maxLength boundary', () => {
    expect(
      validateParent({
        ...baseArtifact,
        residual_risks: ['x'.repeat(1025)],
      }),
    ).toBe(false)
    expect(hasKeyword(validateParent, 'maxLength', '/residual_risks/0')).toBe(
      true,
    )
  })

  test('accepts a testing gap item at the maxLength boundary', () => {
    expect(
      validateParent({
        ...baseArtifact,
        testing_gaps: ['x'.repeat(1024)],
      }),
    ).toBe(true)
  })

  test('rejects a testing gap item beyond the maxLength boundary', () => {
    expect(
      validateParent({
        ...baseArtifact,
        testing_gaps: ['x'.repeat(1025)],
      }),
    ).toBe(false)
    expect(hasKeyword(validateParent, 'maxLength', '/testing_gaps/0')).toBe(
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

function omitKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

function collectDescriptions(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(collectDescriptions)
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    const own =
      typeof record.description === 'string' ? [record.description] : []
    return [...own, ...Object.values(record).flatMap(collectDescriptions)]
  }
  return []
}

async function importSchemaModule(): Promise<Record<string, unknown>> {
  return (await import(
    '../../src/lib/review-artifact-schema.js'
  )) as unknown as Record<string, unknown>
}

function compileGenerated(schemaValue: unknown) {
  const jsonSchema = z.toJSONSchema(schemaValue as z.ZodType, {
    target: 'draft-7',
  }) as Record<string, unknown>
  const ajv = new Ajv({ strict: false })
  const validate = ajv.compile(jsonSchema)
  return (value: unknown): boolean => validate(value) as boolean
}

const parityCorpus: Array<{
  name: string
  root: 'raw' | 'parent'
  value: unknown
}> = [
  // Accepted raw returns.
  {
    name: 'raw empty',
    root: 'raw',
    value: { ...baseSubAgentArtifact, findings: [] },
  },
  { name: 'raw findings', root: 'raw', value: baseSubAgentArtifact },
  {
    name: 'raw overflow evidence',
    root: 'raw',
    value: subAgentWithFinding({
      evidence: [{ overflow: true, excerpt: 'src/file.ts excerpt' }],
    }),
  },
  {
    name: 'raw severity P0',
    root: 'raw',
    value: subAgentWithFinding({ severity: 'P0' }),
  },
  {
    name: 'raw empty risk and gap strings',
    root: 'raw',
    value: {
      ...baseSubAgentArtifact,
      residual_risks: [''],
      testing_gaps: [''],
    },
  },
  {
    name: 'raw risk at 1024',
    root: 'raw',
    value: { ...baseSubAgentArtifact, residual_risks: ['x'.repeat(1024)] },
  },
  // Rejected raw returns (#964 boundaries).
  {
    name: 'raw severity medium',
    root: 'raw',
    value: subAgentWithFinding({ severity: 'medium' }),
  },
  {
    name: 'raw severity unknown',
    root: 'raw',
    value: subAgentWithFinding({ severity: 'unknown' }),
  },
  {
    name: 'raw parent harness annotation',
    root: 'raw',
    value: { ...baseSubAgentArtifact, harness: 'opencode' },
  },
  {
    name: 'raw parent dispatch_outcome annotation',
    root: 'raw',
    value: { ...baseSubAgentArtifact, dispatch_outcome: 'findings' },
  },
  {
    name: 'raw finding disposition annotation',
    root: 'raw',
    value: subAgentWithFinding({ disposition: 'surviving' }),
  },
  {
    name: 'raw unknown top-level',
    root: 'raw',
    value: { ...baseSubAgentArtifact, ROGUE_TOP_LEVEL: 'x' },
  },
  {
    name: 'raw unknown finding field',
    root: 'raw',
    value: subAgentWithFinding({ EXTRA_INJECTED_FIELD: 'x' }),
  },
  {
    name: 'raw missing reviewer',
    root: 'raw',
    value: omitKey(baseSubAgentArtifact, 'reviewer'),
  },
  {
    name: 'raw absolute posix file',
    root: 'raw',
    value: subAgentWithFinding({ file: '/Users/example/repo/src/file.ts' }),
  },
  {
    name: 'raw windows drive file',
    root: 'raw',
    value: subAgentWithFinding({ file: 'C:/repo/src/file.ts' }),
  },
  {
    name: 'raw unc file',
    root: 'raw',
    value: subAgentWithFinding({ file: '\\\\server\\share\\file.ts' }),
  },
  {
    name: 'raw empty evidence',
    root: 'raw',
    value: subAgentWithFinding({ evidence: [] }),
  },
  {
    name: 'raw evidence over cap',
    root: 'raw',
    value: subAgentWithFinding({
      evidence: Array.from({ length: 6 }, (_, index) => `e${index}`),
    }),
  },
  {
    name: 'raw evidence string over cap',
    root: 'raw',
    value: subAgentWithFinding({ evidence: ['x'.repeat(501)] }),
  },
  {
    name: 'raw object risk entry',
    root: 'raw',
    value: { ...baseSubAgentArtifact, residual_risks: [{ reason: 'x' }] },
  },
  {
    name: 'raw risk over cap',
    root: 'raw',
    value: { ...baseSubAgentArtifact, residual_risks: ['x'.repeat(1025)] },
  },
  {
    name: 'raw testing gap over cap',
    root: 'raw',
    value: { ...baseSubAgentArtifact, testing_gaps: ['x'.repeat(1025)] },
  },
  {
    name: 'raw findings over cap',
    root: 'raw',
    value: {
      ...baseSubAgentArtifact,
      findings: Array.from({ length: 33 }, () => baseSubAgentFinding),
    },
  },
  {
    name: 'raw line above max safe integer',
    root: 'raw',
    value: subAgentWithFinding({ line: 9007199254740992 }),
  },
  {
    name: 'raw title over cap',
    root: 'raw',
    value: subAgentWithFinding({ title: 'x'.repeat(257) }),
  },
  {
    name: 'raw reviewer over cap',
    root: 'raw',
    value: { ...baseSubAgentArtifact, reviewer: 'x'.repeat(65) },
  },
  {
    name: 'raw suggested_fix over cap',
    root: 'raw',
    value: subAgentWithFinding({ suggested_fix: 'x'.repeat(2049) }),
  },
  {
    name: 'raw confidence over cap',
    root: 'raw',
    value: subAgentWithFinding({ confidence: 1.1 }),
  },
  // Parent records.
  { name: 'parent valid', root: 'parent', value: baseArtifact },
  {
    name: 'parent empty findings',
    root: 'parent',
    value: { ...baseArtifact, findings: [] },
  },
  {
    name: 'parent unknown dispatch outcome',
    root: 'parent',
    value: { ...baseArtifact, dispatch_outcome: 'dropped' },
  },
  {
    name: 'parent missing dispatch outcome',
    root: 'parent',
    value: omitKey(baseArtifact, 'dispatch_outcome'),
  },
  {
    name: 'parent finding missing disposition',
    root: 'parent',
    value: { ...baseArtifact, findings: [baseSubAgentFinding] },
  },
  {
    name: 'parent unknown top-level',
    root: 'parent',
    value: { ...baseArtifact, ROGUE_TOP_LEVEL: 1 },
  },
  {
    name: 'parent unknown finding field',
    root: 'parent',
    value: artifactWithFinding({ EXTRA_INJECTED_FIELD: 1 }),
  },
  {
    name: 'parent absolute file',
    root: 'parent',
    value: artifactWithFinding({ file: '/abs/file.ts' }),
  },
  {
    name: 'parent risk over cap',
    root: 'parent',
    value: { ...baseArtifact, residual_risks: ['x'.repeat(1025)] },
  },
  {
    name: 'parent severity medium',
    root: 'parent',
    value: artifactWithFinding({ severity: 'medium' }),
  },
  {
    name: 'parent line above max safe integer',
    root: 'parent',
    value: artifactWithFinding({ line: 9007199254740992 }),
  },
]

describe('canonical Zod schema parity', () => {
  test('exports canonical raw-return and parent-record schemas', async () => {
    const schemaModule = await importSchemaModule()

    expect(
      schemaModule.SubAgentReturnSchema,
      'SubAgentReturnSchema export',
    ).toBeDefined()
    expect(
      schemaModule.ParentRecordSchema,
      'ParentRecordSchema export',
    ).toBeDefined()
  })

  test('generated schemas match committed accept/reject over the corpus', async () => {
    const schemaModule = await importSchemaModule()
    const candidateRaw = compileGenerated(schemaModule.SubAgentReturnSchema)
    const candidateParent = compileGenerated(schemaModule.ParentRecordSchema)

    for (const entry of parityCorpus) {
      const committed = entry.root === 'raw' ? validateSubAgent : validateParent
      const candidate = entry.root === 'raw' ? candidateRaw : candidateParent
      const committedAccepts = committed(entry.value)
      const candidateAccepts = candidate(entry.value)

      expect(
        candidateAccepts,
        `${entry.name}: committed=${committedAccepts} candidate=${candidateAccepts}`,
      ).toBe(committedAccepts)
    }
  })

  test('generated schemas preserve every committed prompt-facing description', async () => {
    const schemaModule = await importSchemaModule()
    // The document-level title/description envelope is assembled by the
    // generator (U2); prompt-facing descriptions live on the definitions.
    const committedDescriptions = new Set(
      collectDescriptions(schema.definitions),
    )
    const generatedDescriptions = new Set(
      [
        z.toJSONSchema(schemaModule.SubAgentReturnSchema as z.ZodType, {
          target: 'draft-7',
        }),
        z.toJSONSchema(schemaModule.ParentRecordSchema as z.ZodType, {
          target: 'draft-7',
        }),
      ].flatMap(collectDescriptions),
    )

    for (const description of committedDescriptions) {
      expect(
        generatedDescriptions.has(description),
        `missing description: ${description}`,
      ).toBe(true)
    }
  })
})
