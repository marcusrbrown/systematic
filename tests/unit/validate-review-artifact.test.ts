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
        'Usage: systematic validate-review-artifact <path> [--allow-outside-artifact-root]\n',
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

  it('reports a JSON array as a validation failure instead of legacy', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd)
      fs.writeFileSync(target, '[]')

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).not.toContain('Legacy review artifact')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports a bare string as a validation failure instead of legacy', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd)
      fs.writeFileSync(target, JSON.stringify('garbage'))

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).not.toContain('Legacy review artifact')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports a number as a validation failure instead of legacy', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd)
      fs.writeFileSync(target, '42')

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).not.toContain('Legacy review artifact')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports null as a validation failure instead of legacy', () => {
    const cwd = makeCwd()
    try {
      const target = artifactPath(cwd)
      fs.writeFileSync(target, 'null')

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/review-summary.json',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).not.toContain('Legacy review artifact')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('documents validation exit statuses and the required artifact path in help', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(['--help'], cwd)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        'The <path> argument is required by design; no artifact discovery is performed.',
      )
      expect(result.stdout).toContain('0 valid artifact')
      expect(result.stdout).toContain('1 validation failure')
      expect(result.stdout).toContain('2 operational failure')
      expect(result.stdout).toContain(
        '3 legacy artifact with no schema_version',
      )
      expect(result.stdout).toContain('--allow-outside-artifact-root')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('validates an artifact outside the artifact root when the flag is set', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = runCli(
        ['validate-review-artifact', target, '--allow-outside-artifact-root'],
        cwd,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(
        'Review artifact is valid (validated outside the run directory; not evidence for this run)\n',
      )
      expect(result.stderr).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('accepts the flag before the path (the advertised ordering)', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = runCli(
        ['validate-review-artifact', '--allow-outside-artifact-root', target],
        cwd,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Review artifact is valid')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('accepts the flag repeated more than once (idempotent)', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = runCli(
        [
          'validate-review-artifact',
          target,
          '--allow-outside-artifact-root',
          '--allow-outside-artifact-root',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Review artifact is valid')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still rejects an unknown flag alongside the recognized flag', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = runCli(
        [
          'validate-review-artifact',
          target,
          '--allow-outside-artifact-root',
          '--unknown-flag',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toBe(
        'Usage: systematic validate-review-artifact <path> [--allow-outside-artifact-root]\n',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still rejects an artifact outside the artifact root without the flag', () => {
    const cwd = makeCwd()
    artifactPath(cwd)
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = runCli(['validate-review-artifact', target], cwd)

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain(
        'must remain inside .context/systematic/ce-review',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('accepts the flag even when the artifact root directory does not exist', () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-no-run-dir-')),
    )
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = runCli(
        ['validate-review-artifact', target, '--allow-outside-artifact-root'],
        cwd,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        'Review artifact is valid (validated outside the run directory; not evidence for this run)',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still rejects a symlink in the path when the flag is set', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const real = path.join(outsideDir, 'real.json')
      fs.copyFileSync(CONFORMING_FIXTURE, real)
      const link = path.join(outsideDir, 'link.json')
      fs.symlinkSync(real, link)

      const result = runCli(
        ['validate-review-artifact', link, '--allow-outside-artifact-root'],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('symlinks')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still rejects parent-directory traversal when the flag is set', () => {
    const cwd = makeCwd()
    try {
      artifactPath(cwd)
      fs.writeFileSync(path.join(cwd, 'outside.json'), '{}')

      const result = runCli(
        [
          'validate-review-artifact',
          '.context/systematic/ce-review/../outside.json',
          '--allow-outside-artifact-root',
        ],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('parent-directory traversal')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not echo the supplied path for a malformed external artifact', () => {
    const cwd = makeCwd()
    const outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-external-artifact-')),
    )
    try {
      const target = path.join(outsideDir, 'malformed.json')
      fs.writeFileSync(target, '{ malformed json')

      const result = runCli(
        ['validate-review-artifact', target, '--allow-outside-artifact-root'],
        cwd,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('malformed JSON')
      expect(result.stderr).not.toContain(target)
      expect(result.stderr).not.toContain(outsideDir)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
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
      expect(result.stderr.split('\n')[0]).toBe('run_id too_big')
      expect(result.stderr).toBe(
        [
          'run_id too_big',
          'Schema: skills/ce-review/references/review-summary-schema.json',
          'Review artifact validation failed: 1 issue(s)',
          '',
        ].join('\n'),
      )
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
