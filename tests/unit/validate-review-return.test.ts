import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.ts')
const MAX_REVIEW_RETURN_BYTES = 1024 * 1024

const VALID_MESSAGE = 'Review return is valid'

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
  suggested_fix: 'Specify the migration and deployment ordering.',
}

const VALID_RETURN = {
  reviewer: 'correctness',
  findings: [BASE_FINDING],
  residual_risks: [],
  testing_gaps: [],
}

const EMPTY_RETURN = { ...VALID_RETURN, findings: [] }

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-review-return-'))
}

function runCli(
  args: string[],
  cwd: string,
  input?: string | Buffer,
): {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
} {
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    cwd,
    ...(input === undefined ? {} : { input }),
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
    stdout: (result.stdout ?? Buffer.alloc(0)).toString('utf8'),
  }
}

/** Pad an ASCII prefix with spaces to an exact byte length. */
function padAsciiToBytes(prefix: string, totalBytes: number): Buffer {
  const prefixBuffer = Buffer.from(prefix, 'utf8')
  const padding = totalBytes - prefixBuffer.byteLength
  if (padding < 0) throw new Error('prefix exceeds target byte budget')
  return Buffer.concat([prefixBuffer, Buffer.alloc(padding, 0x20)])
}

/** Pad a UTF-8 prefix with 2-byte characters (plus one space if needed) to an exact byte length. */
function padMultibyteToBytes(prefix: string, totalBytes: number): Buffer {
  const chunks = [Buffer.from(prefix, 'utf8')]
  let length = chunks[0]?.byteLength ?? 0
  while (length + 2 <= totalBytes) {
    chunks.push(Buffer.from('é', 'utf8'))
    length += 2
  }
  if (length < totalBytes) {
    chunks.push(Buffer.alloc(totalBytes - length, 0x20))
  }
  return Buffer.concat(chunks)
}

describe('systematic validate-review-return', () => {
  it('accepts a conforming findings return from stdin', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify(VALID_RETURN),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${VALID_MESSAGE}\n`)
      expect(result.stderr).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts a conforming empty return from stdin', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify(EMPTY_RETURN),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${VALID_MESSAGE}\n`)
      expect(result.stderr).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts the largest safe line identity from raw JSON', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify({
          ...VALID_RETURN,
          findings: [{ ...BASE_FINDING, line: Number.MAX_SAFE_INTEGER }],
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${VALID_MESSAGE}\n`)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects unsafe and lexically collapsing line identities from raw JSON', () => {
    const cwd = makeCwd()
    try {
      const base = JSON.stringify({
        ...VALID_RETURN,
        findings: [{ ...BASE_FINDING, line: 0 }],
      })

      for (const lexicalLine of [
        '"line":9007199254740992', // Number.MAX_SAFE_INTEGER + 1
        '"line":9007199254740993', // distinct lexical integer that JSON.parse collapses
        '"line":9007199254740993.5', // fraction that JSON.parse rounds to an integer
      ]) {
        const result = runCli(
          ['validate-review-return'],
          cwd,
          base.replace('"line":0', lexicalLine),
        )

        expect(result.exitCode, lexicalLine).toBe(1)
        expect(result.stderr, lexicalLine).toContain('findings.0.line')
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a parent-owned annotation as schema-invalid without echoing the key', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify({ ...VALID_RETURN, harness: 'opencode' }),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('unrecognized_keys')
      expect(result.stderr).not.toContain('harness')
      expect(result.stdout).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects malformed JSON', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(['validate-review-return'], cwd, '{ malformed json')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('not valid JSON')
      expect(result.stderr).not.toContain('SyntaxError')
      expect(result.stdout).toBe('')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects trailing non-whitespace after one JSON document', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        `${JSON.stringify(VALID_RETURN)} trailing`,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('not valid JSON')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects empty and whitespace-only stdin as empty', () => {
    const cwd = makeCwd()
    try {
      for (const input of ['', '   \n\t ']) {
        const result = runCli(['validate-review-return'], cwd, input)

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('empty')
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('treats an immediately-closed stdin with no payload as empty, with no writes', () => {
    const cwd = makeCwd()
    try {
      const before = fs.readdirSync(cwd)
      const result = runCli(['validate-review-return'], cwd, Buffer.alloc(0))

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Review return is empty\n')
      expect(fs.readdirSync(cwd)).toEqual(before)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects invalid UTF-8 bytes before JSON parsing', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('not valid UTF-8')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts input at exactly the byte cap', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        padAsciiToBytes(JSON.stringify(VALID_RETURN), MAX_REVIEW_RETURN_BYTES),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${VALID_MESSAGE}\n`)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects input one byte over the cap as oversized', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(
        ['validate-review-return'],
        cwd,
        padAsciiToBytes(
          JSON.stringify(VALID_RETURN),
          MAX_REVIEW_RETURN_BYTES + 1,
        ),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('1 MiB')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('limits a multibyte payload by bytes, not JavaScript string length', () => {
    const cwd = makeCwd()
    try {
      const over = padMultibyteToBytes(
        JSON.stringify(VALID_RETURN),
        MAX_REVIEW_RETURN_BYTES + 1,
      )
      // The decoded string is shorter than the byte cap, so a
      // string-length implementation would misreport malformed JSON.
      expect(over.toString('utf8').length).toBeLessThan(
        MAX_REVIEW_RETURN_BYTES + 1,
      )

      const result = runCli(['validate-review-return'], cwd, over)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('1 MiB')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects unknown, positional, and duplicate arguments with usage', () => {
    const cwd = makeCwd()
    try {
      for (const args of [
        ['validate-review-return', 'artifact.json'],
        ['validate-review-return', '--json'],
        ['validate-review-return', 'validate-review-return'],
      ]) {
        const result = runCli(args, cwd, JSON.stringify(VALID_RETURN))

        expect(result.exitCode, args.join(' ')).toBe(2)
        expect(result.stderr).toContain(
          'Usage: systematic validate-review-return',
        )
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('bounds projected issue lines and reports the full issue count', () => {
    const cwd = makeCwd()
    try {
      const manyViolations = {
        findings: [{}, {}, {}],
      }
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify(manyViolations),
      )

      expect(result.exitCode).toBe(1)
      const lines = result.stderr.split('\n').filter(Boolean)
      const issueLines = lines.filter(
        (line) => !line.startsWith('Review return validation failed'),
      )
      expect(issueLines.length).toBeLessThanOrEqual(8)
      expect(result.stderr).toMatch(
        /Review return validation failed: \d+ issue\(s\)/,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('never echoes secret-shaped unknown keys or values byte-for-byte', () => {
    const cwd = makeCwd()
    try {
      const keyCanary = 'ghp_SECRET_CANARY_KEY_do_not_leak'
      const valueCanary = 'sk-live-SECRET_CANARY_VALUE_do_not_leak'
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify({
          ...VALID_RETURN,
          [keyCanary]: valueCanary,
          findings: [{ ...BASE_FINDING, [keyCanary]: valueCanary }],
        }),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain(keyCanary)
      expect(result.stdout).not.toContain(valueCanary)
      expect(result.stderr).not.toContain(keyCanary)
      expect(result.stderr).not.toContain(valueCanary)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('writes nothing into a synthetic cwd', () => {
    const cwd = makeCwd()
    try {
      const before = fs.readdirSync(cwd)
      const result = runCli(
        ['validate-review-return'],
        cwd,
        JSON.stringify(VALID_RETURN),
      )

      expect(result.exitCode).toBe(0)
      expect(fs.readdirSync(cwd)).toEqual(before)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('documents the command and its exit statuses in help', () => {
    const cwd = makeCwd()
    try {
      const result = runCli(['--help'], cwd)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('validate-review-return')
      expect(result.stdout).toContain('1 MiB')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves the existing artifact command and help contract', () => {
    const cwd = makeCwd()
    try {
      const noPath = runCli(['validate-review-artifact'], cwd)

      expect(noPath.exitCode).toBe(2)
      expect(noPath.stderr).toBe(
        'Usage: systematic validate-review-artifact <path> [--allow-outside-artifact-root]\n',
      )

      const help = runCli(['--help'], cwd)
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain(
        'The <path> argument is required by design; no artifact discovery is performed.',
      )
      expect(help.stdout).toContain('3 legacy artifact with no schema_version')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
