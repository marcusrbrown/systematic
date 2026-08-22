import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.ts')
const FIXTURE_DIR = path.join(ROOT_DIR, 'tests/fixtures/review-artifacts')
const CONFORMING_FIXTURE = path.join(
  FIXTURE_DIR,
  'conforming-review-summary.json',
)
const HISTORICAL_FIXTURE = path.join(
  FIXTURE_DIR,
  'historical-review-summary-20260817.json',
)

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-review-artifact-'))
}

function artifactPath(cwd: string, filename = 'review-summary.json'): string {
  const directory = path.join(cwd, '.context/systematic/ce-review')
  fs.mkdirSync(directory, { recursive: true })
  return path.join(directory, filename)
}

function copyFixture(cwd: string, fixture: string): string {
  const target = artifactPath(cwd)
  fs.copyFileSync(fixture, target)
  return target
}

function runCli(
  args: string[],
  cwd: string,
): {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
} {
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('fixture must contain an object')
  }
  return parsed as Record<string, unknown>
}

describe('systematic validate-review-artifact', () => {
  it('accepts a conforming artifact under the permitted root', () => {
    const cwd = makeCwd()
    try {
      copyFixture(cwd, CONFORMING_FIXTURE)

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Review artifact is valid')
      expect(result.stderr).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports a validation path and code for a non-conforming artifact', () => {
    const cwd = makeCwd()
    try {
      const target = copyFixture(cwd, CONFORMING_FIXTURE)
      const artifact = readJsonObject(target)
      artifact.run_id = 'x'.repeat(65)
      fs.writeFileSync(target, JSON.stringify(artifact))

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('run_id')
      expect(result.stderr).toContain('too_big')
      expect(result.stderr).toContain('1 issue(s)')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns an operational failure for a missing file', () => {
    const cwd = makeCwd()
    try {
      artifactPath(cwd)
      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/missing.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('not found')
      expect(result.stderr).not.toContain('validation failed')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns an operational failure for malformed JSON without a stack trace', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd)
      fs.writeFileSync(target, '{ malformed json')

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('malformed JSON')
      expect(result.stderr).not.toContain('SyntaxError')
      expect(result.stderr).not.toContain('at ')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('requires a path and prints usage instead of discovering a target', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(['validate-review-artifact'], cwd)

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toBe(
        'Usage: systematic validate-review-artifact <path>\n',
      )
      expect(result.stdout).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a symlink outside the artifact root before reading it', () => {
    const cwd = makeCwd()
    const outside = path.join(cwd, 'outside-secret.json')
    try {
      artifactPath(cwd)
      fs.writeFileSync(outside, 'secret artifact content')
      fs.symlinkSync(
        outside,
        path.join(cwd, '.context/systematic/ce-review/link.json'),
      )

      const result = runCli(
        ['validate-review-artifact', '.context/systematic/ce-review/link.json'],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('symlinks')
      expect(result.stderr).not.toContain('secret artifact content')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects parent-directory traversal escaping the artifact root', () => {
    const cwd = makeCwd()
    try {
      artifactPath(cwd)
      fs.writeFileSync(path.join(cwd, 'outside.json'), '{}')

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/../outside.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('parent-directory traversal')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('classifies an artifact without schema_version as legacy', () => {
    const cwd = makeCwd()
    try {
      copyFixture(cwd, HISTORICAL_FIXTURE)

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain('Legacy review artifact')
      expect(result.stderr).toContain('no schema_version')
      expect(result.stderr).not.toContain('validation failed')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not echo artifact strings or generated Zod messages', () => {
    const cwd = makeCwd()
    const distinctive = 'distinctive-review-secret-9f4c'
    try {
      const target = copyFixture(cwd, CONFORMING_FIXTURE)
      const artifact = readJsonObject(target)
      artifact.run_id = `${distinctive}${'x'.repeat(65)}`
      fs.writeFileSync(target, JSON.stringify(artifact))

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('run_id too_big')
      expect(result.stderr).not.toContain(distinctive)
      expect(result.stderr).not.toContain('expected string')
      expect(result.stderr).not.toContain('received')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves authored messages for custom schema invariants', () => {
    const cwd = makeCwd()
    try {
      const target = copyFixture(cwd, CONFORMING_FIXTURE)
      const artifact = readJsonObject(target)
      artifact.input_findings = [
        {
          record_type: 'rejected_summary',
          reviewer: 'testing',
          dispatch_outcome: 'malformed',
          rejected_finding_count: 2,
          rejected_severities: ['P1'],
          disposition: 'rejected',
          reason: 'The persona return failed schema validation.',
        },
      ]
      fs.writeFileSync(target, JSON.stringify(artifact))

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(
        'input_findings.0.rejected_severities custom: severity count must match rejected finding count',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects non-regular-file targets as operational failures', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd, 'directory')
      fs.mkdirSync(target)

      const result = runCli(
        ['validate-review-artifact', '.context/systematic/ce-review/directory'],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('regular file')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
