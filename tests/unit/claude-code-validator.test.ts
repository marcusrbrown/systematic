import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runClaudeCodeValidator } from '../../src/claude-code-validator.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CONFORMING_FIXTURE = path.join(
  ROOT_DIR,
  'tests/fixtures/review-artifacts/conforming-review-summary.json',
)

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-validator-'))
}

function artifactPath(cwd: string): string {
  const directory = path.join(cwd, '.context/systematic/ce-review')
  fs.mkdirSync(directory, { recursive: true })
  return path.join(directory, 'review-summary.json')
}

function runValidator(cwd: string): {
  readonly exitCode: number
  readonly stdout: string[]
  readonly stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = runClaudeCodeValidator({
    argv: ['.context/systematic/ce-review/review-summary.json'],
    cwd: fs.realpathSync(cwd),
    errorSink: (message) => stderr.push(message),
    outputSink: (message) => stdout.push(message),
  })
  return { exitCode, stderr, stdout }
}

describe('Claude Code bundled validator entry', () => {
  it('returns 0 for a valid artifact', () => {
    const cwd = makeCwd()
    try {
      fs.copyFileSync(CONFORMING_FIXTURE, artifactPath(cwd))

      const result = runValidator(cwd)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toEqual(['Review artifact is valid'])
      expect(result.stderr).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns 1 and projects invalid output to path and code without artifact content', () => {
    const cwd = makeCwd()
    const distinctive = 'bundled-validator-secret-7c1e'
    try {
      const target = artifactPath(cwd)
      const artifact = JSON.parse(
        fs.readFileSync(CONFORMING_FIXTURE, 'utf8'),
      ) as {
        run_id: string
      }
      artifact.run_id = `${distinctive}${'x'.repeat(65)}`
      fs.writeFileSync(target, JSON.stringify(artifact))

      const result = runValidator(cwd)

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toEqual([])
      expect(result.stderr).toEqual([
        'run_id too_big',
        'Schema: skills/ce-review/references/review-summary-schema.json',
        'Review artifact validation failed: 1 issue(s)',
      ])
      expect(result.stderr.join('\n')).not.toContain(distinctive)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns 3 for a legacy object without schema_version', () => {
    const cwd = makeCwd()
    try {
      fs.writeFileSync(artifactPath(cwd), JSON.stringify({ legacy: true }))

      const result = runValidator(cwd)

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toEqual([
        'Legacy review artifact: no schema_version field',
      ])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns 2 for an unreadable artifact path', () => {
    const cwd = makeCwd()
    try {
      fs.mkdirSync(path.join(cwd, '.context/systematic/ce-review'), {
        recursive: true,
      })

      const result = runValidator(cwd)

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toEqual(['Review artifact file was not found'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns 0 for a valid artifact outside the run directory with the flag', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-validator-external-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const stdout: string[] = []
      const exitCode = runClaudeCodeValidator({
        argv: [target, '--allow-outside-artifact-root'],
        cwd: fs.realpathSync(cwd),
        outputSink: (message) => stdout.push(message),
      })

      expect(exitCode).toBe(0)
      expect(stdout).toEqual([
        'Review artifact is valid (validated outside the run directory; not evidence for this run)',
      ])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('accepts the flag repeated more than once', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-validator-external-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const exitCode = runClaudeCodeValidator({
        argv: [
          target,
          '--allow-outside-artifact-root',
          '--allow-outside-artifact-root',
        ],
        cwd: fs.realpathSync(cwd),
      })

      expect(exitCode).toBe(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still returns 2 for an artifact outside the run directory without the flag', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-validator-external-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const exitCode = runClaudeCodeValidator({
        argv: [target],
        cwd: fs.realpathSync(cwd),
      })

      expect(exitCode).toBe(2)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
