import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkSchema,
  generateFindingsSchemaContent,
  generatePipelineSchemaContent,
  generateReviewerReturnSchemaContent,
  generateSchemaContent,
  normalizeForCompare,
  PIPELINE_SCHEMA_RELATIVE_PATH,
  REVIEW_SCHEMA_RELATIVE_PATH,
  REVIEW_SCHEMA_TARGETS,
  REVIEWER_RETURN_SCHEMA_RELATIVE_PATH,
  writeSchema,
} from '../../scripts/generate-review-artifact-schema.js'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const GENERATOR = path.join(
  REPO_ROOT,
  'scripts/generate-review-artifact-schema.ts',
)
const SCHEMA_PATH = path.join(REPO_ROOT, REVIEW_SCHEMA_RELATIVE_PATH)

const FINDINGS_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/findings-schema.json'
const FINDINGS_SCHEMA_PATH = path.join(REPO_ROOT, FINDINGS_SCHEMA_RELATIVE_PATH)

function withFindingsContent(content: string, callback: () => void): void {
  const original = fs.readFileSync(FINDINGS_SCHEMA_PATH, 'utf8')
  try {
    fs.writeFileSync(FINDINGS_SCHEMA_PATH, content, 'utf8')
    callback()
  } finally {
    fs.writeFileSync(FINDINGS_SCHEMA_PATH, original, 'utf8')
  }
}

function runGenerator(...args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bun', GENERATOR, ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  const stdout = result.stdout ?? Buffer.alloc(0)
  const stderr = result.stderr ?? Buffer.alloc(0)
  return `${stdout.toString()}${stderr.toString()}`
}

function withSchemaContent(content: string, callback: () => void): void {
  const original = fs.readFileSync(SCHEMA_PATH, 'utf8')
  try {
    fs.writeFileSync(SCHEMA_PATH, content, 'utf8')
    callback()
  } finally {
    fs.writeFileSync(SCHEMA_PATH, original, 'utf8')
  }
}

describe('review artifact schema generator', () => {
  test('generation produces the committed schema at the declared path', () => {
    const result = runGenerator()

    expect(result.exitCode, output(result)).toBe(0)
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true)
    const generated = generateSchemaContent()
    expect(generated.endsWith('\n')).toBe(true)
    expect(fs.readFileSync(SCHEMA_PATH, 'utf8')).toBe(generated)
  })

  test('--check exits 0 when the committed schema matches the Zod source', () => {
    const result = runGenerator('--check')

    expect(result.exitCode, output(result)).toBe(0)
  })

  test('--check exits nonzero and names the committed schema on drift', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as Record<
      string,
      unknown
    >
    withSchemaContent(
      `${JSON.stringify({ ...schema, title: 'Drifted schema' }, null, 2)}\n`,
      () => {
        const result = runGenerator('--check')

        expect(result.exitCode).toBe(1)
        expect(output(result)).toContain(REVIEW_SCHEMA_RELATIVE_PATH)
      },
    )
  })

  test('a fresh generation is immediately clean on a subsequent --check', () => {
    const generateResult = runGenerator()
    expect(generateResult.exitCode, output(generateResult)).toBe(0)

    const checkResult = runGenerator('--check')
    expect(checkResult.exitCode, output(checkResult)).toBe(0)
  })

  test('--check reports a missing committed schema', () => {
    const original = fs.readFileSync(SCHEMA_PATH, 'utf8')
    try {
      fs.rmSync(SCHEMA_PATH)
      const result = runGenerator('--check')

      expect(result.exitCode).toBe(1)
      expect(output(result)).toContain(REVIEW_SCHEMA_RELATIVE_PATH)
      expect(output(result)).toContain('does not exist')
    } finally {
      fs.writeFileSync(SCHEMA_PATH, original, 'utf8')
    }
  })

  test('--check reports a malformed committed schema as drift', () => {
    withSchemaContent('{ malformed json\n', () => {
      const result = runGenerator('--check')

      expect(result.exitCode).toBe(1)
      expect(output(result)).toContain(REVIEW_SCHEMA_RELATIVE_PATH)
    })
  })

  test('normalization changes line endings but preserves trailing whitespace', () => {
    expect(normalizeForCompare('foo\r\nbar\r\n')).toBe('foo\nbar\n')
    expect(normalizeForCompare('foo\n\n')).toBe('foo\n\n')
    expect(normalizeForCompare('foo \n')).toBe('foo \n')
  })

  test('--check exits nonzero and names the committed findings schema on drift', () => {
    const schema = JSON.parse(
      fs.readFileSync(FINDINGS_SCHEMA_PATH, 'utf8'),
    ) as Record<string, unknown>
    withFindingsContent(
      `${JSON.stringify({ ...schema, title: 'Drifted findings schema' }, null, 2)}\n`,
      () => {
        const result = runGenerator('--check')

        expect(result.exitCode).toBe(1)
        expect(output(result)).toContain(FINDINGS_SCHEMA_RELATIVE_PATH)
      },
    )
  })

  test('generation writes the findings schema and reports both targets', () => {
    const result = runGenerator()

    expect(result.exitCode, output(result)).toBe(0)
    expect(output(result)).toContain(REVIEW_SCHEMA_RELATIVE_PATH)
    expect(output(result)).toContain(FINDINGS_SCHEMA_RELATIVE_PATH)
  })

  test('owns exactly the four ce:review schemas and isolates document-review', () => {
    const targets = REVIEW_SCHEMA_TARGETS.map((target) => target.relativePath)

    expect(targets).toEqual([
      'skills/ce-review/references/review-summary-schema.json',
      'skills/ce-review/references/findings-schema.json',
      REVIEWER_RETURN_SCHEMA_RELATIVE_PATH,
      PIPELINE_SCHEMA_RELATIVE_PATH,
    ])
    expect(targets).not.toContain(
      'skills/document-review/references/findings-schema.json',
    )
    expect(generateSchemaContent()).not.toContain('document-review')
  })

  test('the check fails and names the reviewer view on drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-schema-'))
    try {
      writeSchema(root)
      expect(checkSchema(root).ok).toBe(true)

      const viewPath = path.join(root, REVIEWER_RETURN_SCHEMA_RELATIVE_PATH)
      fs.appendFileSync(viewPath, '\n', 'utf8')
      const result = checkSchema(root)

      expect(result.ok).toBe(false)
      expect(result.message).toContain(REVIEWER_RETURN_SCHEMA_RELATIVE_PATH)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('the reviewer view is rooted at subAgentReturn with byte-equal definitions', () => {
    const view = JSON.parse(generateReviewerReturnSchemaContent()) as {
      readonly $ref: string
      readonly definitions: Record<string, unknown>
    }
    const full = JSON.parse(generateFindingsSchemaContent()) as {
      readonly $ref: string
      readonly definitions: Record<string, unknown>
    }

    expect(view.$ref).toBe('#/definitions/subAgentReturn')
    expect(full.$ref).toBe('#/definitions/parentRecord')
    expect(Object.keys(view.definitions).sort()).toEqual([
      'subAgentFinding',
      'subAgentReturn',
    ])
    for (const [name, definition] of Object.entries(view.definitions)) {
      expect(JSON.stringify(definition), name).toBe(
        JSON.stringify(full.definitions[name]),
      )
    }
  })

  test('the reviewer view carries no parent-owned record or field', () => {
    const content = generateReviewerReturnSchemaContent()

    for (const name of [
      'parentRecord',
      'parentFinding',
      'harness',
      'dispatch_outcome',
      'disposition',
    ]) {
      expect(content, name).not.toContain(name)
    }
  })

  test('the generated pipeline schema excludes helper-produced internal phase state', () => {
    const pipelineSchema = JSON.parse(generatePipelineSchemaContent()) as {
      readonly definitions: Record<string, unknown>
    }
    const definitionNames = Object.keys(pipelineSchema.definitions)

    expect(definitionNames).not.toContain('screenOutput')
    expect(definitionNames).not.toContain('prepareOutput')
    expect(definitionNames).not.toContain('mergeOutput')
    expect(definitionNames).not.toContain('finalizeOutput')
  })

  test('keeps the shared final-v1 safe-integer line bound in both committed schemas', () => {
    const expected = {
      type: 'integer',
      exclusiveMinimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }
    const summary = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as {
      readonly properties: {
        readonly findings: {
          readonly items: {
            readonly properties: { readonly line: unknown }
          }
        }
      }
    }
    const findings = JSON.parse(
      fs.readFileSync(FINDINGS_SCHEMA_PATH, 'utf8'),
    ) as {
      readonly definitions: {
        readonly subAgentFinding: {
          readonly properties: { readonly line: unknown }
        }
      }
    }

    expect(summary.properties.findings.items.properties.line).toEqual(expected)
    expect(findings.definitions.subAgentFinding.properties.line).toMatchObject(
      expected,
    )
  })
})
