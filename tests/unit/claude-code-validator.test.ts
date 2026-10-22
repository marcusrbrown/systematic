import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildValidatorBundle } from '../../scripts/build-claude-code-plugin.js'
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
        'Review artifact failed schema validation',
        'Schema: skills/ce-review/references/review-summary-schema.json',
        'run_id too_big',
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

  it('prints eight issue lines and the overflow count for more than eight issues, with no values or key names', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd)
      const artifact = JSON.parse(
        fs.readFileSync(CONFORMING_FIXTURE, 'utf8'),
      ) as Record<string, unknown>
      for (const key of Object.keys(artifact).slice(0, 10)) {
        artifact[key] = { VALUE_CANARY: 'VALUE_CANARY' }
      }
      artifact.KEY_CANARY_unknown = 'VALUE_CANARY'
      fs.writeFileSync(target, JSON.stringify(artifact))

      const result = runValidator(cwd)

      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toBe('Review artifact failed schema validation')
      expect(result.stderr[1]).toMatch(/^Schema: /)
      expect(result.stderr.slice(2, 10)).toHaveLength(8)
      expect(result.stderr[10]).toMatch(/^… and \d+ more$/)
      expect(result.stderr).toHaveLength(11)
      expect(result.stderr.join('\n')).not.toContain('CANARY')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('the built bundle prints the same shape from a directory outside the repository', async () => {
    const bundle = await buildValidatorBundle(ROOT_DIR)
    const foreign = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-foreign-')),
    )
    try {
      const bin = path.join(foreign, 'validator.mjs')
      fs.writeFileSync(bin, bundle)
      const target = artifactPath(foreign)
      const artifact = JSON.parse(
        fs.readFileSync(CONFORMING_FIXTURE, 'utf8'),
      ) as Record<string, unknown>
      for (const key of Object.keys(artifact).slice(0, 10)) {
        artifact[key] = { VALUE_CANARY: 'VALUE_CANARY' }
      }
      fs.writeFileSync(target, JSON.stringify(artifact))

      const result = spawnSync(
        'node',
        [bin, '.context/systematic/ce-review/review-summary.json'],
        { cwd: foreign, encoding: 'utf8', timeout: 30_000 },
      )

      expect(result.status).toBe(1)
      const lines = (result.stderr ?? '').trimEnd().split('\n')
      expect(lines[0]).toBe('Review artifact failed schema validation')
      expect(lines.slice(2, 10)).toHaveLength(8)
      expect(lines[10]).toMatch(/^… and \d+ more$/)
      expect(result.stderr).not.toContain('CANARY')
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true })
    }
  }, 60_000)
})
