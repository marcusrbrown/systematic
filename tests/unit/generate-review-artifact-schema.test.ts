import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  generateSchemaContent,
  REVIEW_SCHEMA_RELATIVE_PATH,
} from '../../scripts/generate-review-artifact-schema.js'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const GENERATOR = path.join(
  REPO_ROOT,
  'scripts/generate-review-artifact-schema.ts',
)
const SCHEMA_PATH = path.join(REPO_ROOT, REVIEW_SCHEMA_RELATIVE_PATH)

function runGenerator(...args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bun', GENERATOR, ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  return `${result.stdout.toString()}${result.stderr.toString()}`
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
    expect(fs.readFileSync(SCHEMA_PATH, 'utf8')).toBe(generateSchemaContent())
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
