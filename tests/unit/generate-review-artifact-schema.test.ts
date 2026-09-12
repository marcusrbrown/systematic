import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  generateSchemaContent,
  normalizeForCompare,
  REVIEW_SCHEMA_RELATIVE_PATH,
  REVIEW_SCHEMA_TARGETS,
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

  test('owns exactly the two ce:review schemas and isolates document-review', () => {
    const targets = REVIEW_SCHEMA_TARGETS.map((target) => target.relativePath)

    expect(targets).toEqual([
      'skills/ce-review/references/review-summary-schema.json',
      'skills/ce-review/references/findings-schema.json',
    ])
    expect(targets).not.toContain(
      'skills/document-review/references/findings-schema.json',
    )
    expect(generateSchemaContent()).not.toContain('document-review')
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

  test('the CI workflow invokes the review schema drift gate', () => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/main.yaml'),
      'utf8',
    )

    expect(workflow).toContain(
      '- name: Review artifact schema drift check\n        run: bun run review-schema:drift',
    )
  })
})
