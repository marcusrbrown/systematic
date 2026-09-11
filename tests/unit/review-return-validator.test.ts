import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MAX_PROJECTED_ISSUE_LINES,
  MAX_REVIEW_RETURN_BYTES,
  REVIEW_RETURN_EMPTY_MESSAGE,
  REVIEW_RETURN_INVALID_UTF8_MESSAGE,
  REVIEW_RETURN_MALFORMED_JSON_MESSAGE,
  REVIEW_RETURN_OVERSIZED_MESSAGE,
  REVIEW_RETURN_READ_FAILED_MESSAGE,
  REVIEW_RETURN_TTY_MESSAGE,
  REVIEW_RETURN_VALID_MESSAGE,
  type ReviewReturnValidatorOptions,
  runReviewReturnValidator,
  VALIDATE_REVIEW_RETURN_USAGE,
  validateReviewReturnValue,
} from '../../src/lib/review-return-validator.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const VALIDATOR_ENTRY = path.join(
  ROOT_DIR,
  'src/lib/review-return-validator.ts',
)

const BASE_FINDING = {
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
}

const VALID_RETURN = {
  reviewer: 'correctness',
  findings: [BASE_FINDING],
  residual_risks: [],
  testing_gaps: [],
}

function padAsciiToBytes(prefix: string, totalBytes: number): Buffer {
  const prefixBuffer = Buffer.from(prefix, 'utf8')
  const padding = totalBytes - prefixBuffer.byteLength
  if (padding < 0) throw new Error('prefix exceeds target byte budget')
  return Buffer.concat([prefixBuffer, Buffer.alloc(padding, 0x20)])
}

function runWith(
  input: Buffer,
  overrides: Partial<ReviewReturnValidatorOptions> = {},
): {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
} {
  const stdout: string[] = []
  const stderr: string[] = []
  let offset = 0
  const status = runReviewReturnValidator({
    argv: ['systematic', 'validate-review-return'],
    isTTY: false,
    readChunk: (_fd, buffer, bufferOffset, length) => {
      if (offset >= input.length) return 0
      const bytes = Math.min(length, input.length - offset)
      input.copy(buffer, bufferOffset, offset, offset + bytes)
      offset += bytes
      return bytes
    },
    outputSink: (message) => stdout.push(message),
    errorSink: (message) => stderr.push(message),
    ...overrides,
  })
  return { status, stderr: stderr.join('\n'), stdout: stdout.join('\n') }
}

describe('validateReviewReturnValue', () => {
  test('accepts an empty findings return', () => {
    expect(validateReviewReturnValue(VALID_RETURN)).toEqual({ ok: true })
    expect(
      validateReviewReturnValue({ ...VALID_RETURN, findings: [] }),
    ).toEqual({ ok: true })
  })

  test('reports a total count and caps projected issues', () => {
    const result = validateReviewReturnValue({
      findings: [{}, {}, {}, {}],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.total).toBeGreaterThan(MAX_PROJECTED_ISSUE_LINES)
    expect(result.issues).toHaveLength(MAX_PROJECTED_ISSUE_LINES)
    for (const issue of result.issues) {
      expect(typeof issue.path).toBe('string')
      expect(typeof issue.code).toBe('string')
    }
  })

  test('projects only paths and codes, never unrecognized key names', () => {
    const result = validateReviewReturnValue({
      ...VALID_RETURN,
      SECRET_KEY_NAME: 'secret-value',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    const projected = JSON.stringify(result)
    expect(projected).not.toContain('SECRET_KEY_NAME')
    expect(projected).not.toContain('secret-value')
  })
})

describe('runReviewReturnValidator', () => {
  test('accepts a conforming findings return', () => {
    const result = runWith(Buffer.from(JSON.stringify(VALID_RETURN), 'utf8'))

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(REVIEW_RETURN_VALID_MESSAGE)
    expect(result.stderr).toBe('')
  })

  test('rejects a TTY without reading stdin', () => {
    let readCalled = false
    const result = runWith(Buffer.from('{}'), {
      isTTY: true,
      readChunk: () => {
        readCalled = true
        return 0
      },
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(REVIEW_RETURN_TTY_MESSAGE)
    expect(readCalled).toBe(false)
  })

  test('reports a stdin read failure as operational (exit 2)', () => {
    const result = runWith(Buffer.from('{}'), {
      readChunk: () => {
        throw new Error('EIO')
      },
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(REVIEW_RETURN_READ_FAILED_MESSAGE)
    expect(result.stderr).not.toContain('EIO')
  })

  test('rejects empty and whitespace-only input', () => {
    for (const input of ['', '   \n\t ']) {
      const result = runWith(Buffer.from(input, 'utf8'))
      expect(result.status, JSON.stringify(input)).toBe(1)
      expect(result.stderr).toBe(REVIEW_RETURN_EMPTY_MESSAGE)
    }
  })

  test('rejects invalid UTF-8', () => {
    const result = runWith(Buffer.from([0xff, 0xfe, 0x7b]))

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(REVIEW_RETURN_INVALID_UTF8_MESSAGE)
  })

  test('rejects malformed JSON and trailing data', () => {
    for (const input of ['{ malformed', `${JSON.stringify(VALID_RETURN)} x`]) {
      const result = runWith(Buffer.from(input, 'utf8'))
      expect(result.status).toBe(1)
      expect(result.stderr).toBe(REVIEW_RETURN_MALFORMED_JSON_MESSAGE)
    }
  })

  test('accepts input at exactly the byte cap and rejects one byte over', () => {
    const atCap = runWith(
      padAsciiToBytes(JSON.stringify(VALID_RETURN), MAX_REVIEW_RETURN_BYTES),
    )
    expect(atCap.status).toBe(0)

    const overCap = runWith(
      padAsciiToBytes(
        JSON.stringify(VALID_RETURN),
        MAX_REVIEW_RETURN_BYTES + 1,
      ),
    )
    expect(overCap.status).toBe(1)
    expect(overCap.stderr).toBe(REVIEW_RETURN_OVERSIZED_MESSAGE)
  })

  test('rejects a schema-invalid return with bounded, payload-safe diagnostics', () => {
    const keyCanary = 'ghp_SECRET_CANARY_KEY'
    const valueCanary = 'sk-live-SECRET_CANARY_VALUE'
    const result = runWith(
      Buffer.from(
        JSON.stringify({
          ...VALID_RETURN,
          [keyCanary]: valueCanary,
        }),
        'utf8',
      ),
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unrecognized_keys')
    expect(result.stderr).not.toContain(keyCanary)
    expect(result.stderr).not.toContain(valueCanary)
  })

  test('rejects extra, unknown, and duplicate arguments with usage', () => {
    for (const argv of [
      ['systematic', 'validate-review-return', 'extra'],
      ['systematic', 'validate-review-return', '--json'],
      ['systematic', 'validate-review-return', 'validate-review-return'],
      ['systematic', 'capabilities'],
    ]) {
      const result = runWith(Buffer.from('{}'), { argv })
      expect(result.status, argv.join(' ')).toBe(2)
      expect(result.stderr).toBe(VALIDATE_REVIEW_RETURN_USAGE)
    }
  })

  test('accepts the command-only argv form', () => {
    const result = runWith(Buffer.from(JSON.stringify(VALID_RETURN), 'utf8'), {
      argv: ['validate-review-return'],
    })

    expect(result.status).toBe(0)
  })

  test('bounds projected issue lines while reporting the full count', () => {
    const result = runWith(
      Buffer.from(JSON.stringify({ findings: [{}, {}, {}] }), 'utf8'),
    )

    expect(result.status).toBe(1)
    const lines = result.stderr.split('\n').filter(Boolean)
    const summary = lines.at(-1)
    expect(summary).toMatch(/^Review return validation failed: \d+ issue\(s\)$/)
    expect(lines.length - 1).toBeLessThanOrEqual(MAX_PROJECTED_ISSUE_LINES)
  })

  test('does not write into the working directory', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-return-unit-'))
    const previousCwd = process.cwd()
    try {
      process.chdir(cwd)
      const before = fs.readdirSync(cwd)
      const result = runWith(Buffer.from(JSON.stringify(VALID_RETURN), 'utf8'))
      expect(result.status).toBe(0)
      expect(fs.readdirSync(cwd)).toEqual(before)
    } finally {
      process.chdir(previousCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('real Node compatibility', () => {
  const nodeProbe = spawnSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  const nodeBinary =
    nodeProbe.status === 0 ? nodeProbe.stdout.trim() : undefined

  test('the validator bundle runs under a real Node binary, not Bun', () => {
    if (!nodeBinary) {
      console.warn('skipping real-Node validator test: no Node binary on PATH')
      return
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-return-node-'))
    try {
      const bundlePath = path.join(dir, 'validator.mjs')
      const build = spawnSync(
        'bun',
        [
          'build',
          VALIDATOR_ENTRY,
          '--target=node',
          '--format=esm',
          `--outfile=${bundlePath}`,
        ],
        { cwd: ROOT_DIR, encoding: 'utf8', timeout: 30_000 },
      )
      expect(build.status, build.stderr).toBe(0)

      const driver = `
const mod = await import(${JSON.stringify(pathToFileURL(bundlePath).href)})
if (typeof Bun !== 'undefined') {
  console.error('driver ran under Bun, not Node')
  process.exit(3)
}
const pure = mod.validateReviewReturnValue(${JSON.stringify(VALID_RETURN)})
if (!pure.ok) process.exit(4)
const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_RETURN))}, 'utf8')
let sent = false
const status = mod.runReviewReturnValidator({
  argv: ['systematic', 'validate-review-return'],
  isTTY: false,
  readChunk: (_fd, buffer, offset, length) => {
    if (sent) return 0
    sent = true
    const n = Math.min(length, bytes.length)
    bytes.copy(buffer, offset, 0, n)
    return n
  },
  outputSink: (message) => process.stdout.write(message + '\\n'),
  errorSink: (message) => process.stderr.write(message + '\\n'),
})
if (status !== 0) process.exit(5)
console.log('node-ok')
`
      const run = spawnSync(nodeBinary, ['--input-type=module', '-e', driver], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      })

      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('node-ok')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
