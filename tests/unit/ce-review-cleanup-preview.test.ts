import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/ce-review-cleanup/scripts/cleanup.mjs',
)
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href
const DATE_FAULT_FIXTURE_PATH = path.join(
  ROOT_DIR,
  'tests/fixtures/ce-review-cleanup/run-preview-with-injected-date-fault.mjs',
)
const CALL_EXPORT_FIXTURE_PATH = path.join(
  ROOT_DIR,
  'tests/fixtures/ce-review-cleanup/call-export-via-node.mjs',
)
const RUN_PREVIEW_FIXTURE_PATH = path.join(
  ROOT_DIR,
  'tests/fixtures/ce-review-cleanup/run-preview-via-node.mjs',
)

// mkfifo is a standard POSIX utility (not an installed dependency); some
// CI/sandbox environments may still lack it. Checked once at module load
// so the FIFO-hang test can skip with an honest reason instead of failing
// the whole suite on an unrelated platform gap.
const mkfifoAvailable = (() => {
  try {
    const probe = spawnSync('which', ['mkfifo'], { encoding: 'utf8' })
    return probe.status === 0 && probe.stdout.trim().length > 0
  } catch {
    return false
  }
})()

// ── Unknown-JSON narrowing (no `as` casts) ─────────────────────────────────

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCliResponse(value: unknown): value is {
  readonly schema_version: number
  readonly operation: string
  readonly result: string
  readonly category?: unknown
  readonly counts?: unknown
  readonly candidates?: unknown
  readonly token?: unknown
  readonly referenceTime?: unknown
  readonly cutoff?: unknown
  readonly usage?: unknown
  readonly exitCodes?: unknown
  readonly notes?: unknown
} {
  if (!isJsonObject(value)) return false
  if (typeof value.schema_version !== 'number') return false
  if (typeof value.operation !== 'string') return false
  if (typeof value.result !== 'string') return false
  return true
}

function isCounts(value: unknown): value is {
  readonly selected: number
  readonly excludedRecent: number
  readonly skippedUnknownUnsafe: number
} {
  if (!isJsonObject(value)) return false
  return (
    typeof value.selected === 'number' &&
    typeof value.excludedRecent === 'number' &&
    typeof value.skippedUnknownUnsafe === 'number'
  )
}

function isCandidateEntry(value: unknown): value is {
  readonly name: string
  readonly displayId: string
  readonly label?: unknown
  readonly lastModified?: unknown
  readonly reason?: unknown
} {
  if (!isJsonObject(value)) return false
  return typeof value.name === 'string' && typeof value.displayId === 'string'
}

function isCandidateGroups(value: unknown): value is {
  readonly selected: readonly unknown[]
  readonly excludedRecent: readonly unknown[]
  readonly skippedUnknownUnsafe: readonly unknown[]
} {
  if (!isJsonObject(value)) return false
  return (
    Array.isArray(value.selected) &&
    Array.isArray(value.excludedRecent) &&
    Array.isArray(value.skippedUnknownUnsafe)
  )
}

// ── CLI + subprocess harness ────────────────────────────────────────────

interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly response: unknown
}

function runCli(args: readonly string[]): CliResult {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const stdout = result.stdout ?? ''
  let response: unknown
  try {
    response = JSON.parse(stdout)
  } catch {
    response = undefined
  }
  return {
    exitCode: result.status ?? -1,
    response,
    stderr: result.stderr ?? '',
    stdout,
  }
}

/** Runs an exported pure function through the fixed `call-export-via-node.mjs`
 * fixture: program and data are separate from process start (no `-e`). */
function callExportViaNode(exportName: string, argsJson: unknown): unknown {
  const result = spawnSync(
    'node',
    [CALL_EXPORT_FIXTURE_PATH, exportName, JSON.stringify(argsJson)],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `subprocess for ${exportName} failed: ${result.stderr ?? ''}`,
    )
  }
  return JSON.parse(result.stdout ?? 'null')
}

/** Runs cleanup.mjs's runPreview() through the fixed `run-preview-via-node.mjs`
 * fixture: program and data are separate from process start (no `-e`). */
function runPreviewViaNode(options: {
  readonly root?: string
  readonly age?: string
  readonly ackOffline: boolean
  readonly referenceTimeMs: number
}): { readonly exitCode: number; readonly response: unknown } {
  const result = spawnSync(
    'node',
    [RUN_PREVIEW_FIXTURE_PATH, JSON.stringify(options)],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout ?? '')
  } catch {
    parsed = undefined
  }
  if (!isJsonObject(parsed) || typeof parsed.exitCode !== 'number') {
    throw new Error(`unexpected runPreview subprocess output: ${result.stdout}`)
  }
  return { exitCode: parsed.exitCode, response: parsed.response }
}

// ── Fixture helpers (real fs, own temp dirs only) ──────────────────────────

function makeTempProject(): {
  readonly projectRoot: string
  readonly reviewRoot: string
} {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ce-review-cleanup-preview-'),
  )
  const reviewRoot = path.join(
    projectRoot,
    '.context',
    'systematic',
    'ce-review',
  )
  fs.mkdirSync(reviewRoot, { recursive: true })
  return { projectRoot, reviewRoot }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

function createCandidate(
  reviewRoot: string,
  name: string,
  options: {
    readonly ageDays?: number
    readonly summary?: unknown
    readonly summaryRaw?: string
  } = {},
): string {
  const dir = path.join(reviewRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  if (options.summaryRaw !== undefined) {
    fs.writeFileSync(path.join(dir, 'review-summary.json'), options.summaryRaw)
  } else if (options.summary !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'review-summary.json'),
      JSON.stringify(options.summary),
    )
  }
  if (options.ageDays !== undefined) {
    const t = daysAgo(options.ageDays)
    const summaryPath = path.join(dir, 'review-summary.json')
    if (fs.existsSync(summaryPath)) fs.utimesSync(summaryPath, t, t)
    fs.utimesSync(dir, t, t)
  }
  return dir
}

function cleanupTemp(projectRoot: string): void {
  fs.rmSync(projectRoot, { force: true, recursive: true })
}

/** Reads a file's content and mtime from a single open file descriptor
 * (fstat + read on the same fd), rather than a path-based stat followed by
 * a separate path-based open/read -- avoiding a check-then-open gap on our
 * own fixture path. */
function readFileSnapshot(filePath: string): {
  readonly content: Buffer
  readonly mtimeMs: number
} {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const buffer = Buffer.alloc(stat.size)
    let readTotal = 0
    while (readTotal < buffer.length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        readTotal,
        buffer.length - readTotal,
        readTotal,
      )
      if (bytesRead <= 0) break
      readTotal += bytesRead
    }
    return { content: buffer.subarray(0, readTotal), mtimeMs: stat.mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Slice 1: operation/argument gate (ack, age, root) and root-missing no-op
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: operation and argument gate', () => {
  it('refuses even a preview when offline acknowledgment is missing', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli(['preview', '--root', projectRoot, '--age', '30'])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('error')
      expect(result.response.category).toBe('missing-acknowledgment')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('checks acknowledgment before ever resolving the root path', () => {
    const result = runCli([
      'preview',
      '--root',
      '/definitely/does/not/exist/anywhere-ce-review',
      '--age',
      '30',
    ])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('missing-acknowledgment')
  })

  it('refuses execute given preview-shaped arguments (an unrecognized --age flag) rather than silently previewing', () => {
    // Unit 3 note: execute has its own strict, disjoint argument contract
    // (--root/--token/--ack-offline only, no --age). This proves it never
    // falls back to interpreting preview-style flags -- see
    // tests/unit/ce-review-cleanup-delete.test.ts for the full execute
    // contract (missing/malformed token, stale digest, etc.).
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('error')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('refuses an unrecognized operation', () => {
    const result = runCli(['delete', '--ack-offline'])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('unknown-operation')
  })

  it('never echoes a long/unsafe unrecognized operation back into the response', () => {
    const unsafeOperation = `rm -rf / ; ${'x'.repeat(5_000)}`
    const result = runCli([unsafeOperation, '--ack-offline'])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('unknown-operation')
    expect(result.response.operation).toBe('unknown')
    expect(result.stdout).not.toContain(unsafeOperation)
    expect(result.stdout.length).toBeLessThan(1_000)
  })

  it('requires an age cutoff', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli(['preview', '--root', projectRoot, '--ack-offline'])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('missing-age')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it.each([
    ['0'],
    ['-1'],
    ['1.5'],
    ['abc'],
    ['30x'],
    ['99999999999999999999d'],
  ])('rejects invalid age input %p', (age) => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        age,
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-age')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects an age against the real clock whose derived cutoff would not be a representable Date, instead of crashing', () => {
    const { projectRoot } = makeTempProject()
    try {
      // Before the fix this reached `new Date(cutoffTimeMs)` and threw a
      // RangeError, caught only by the generic internal-error boundary.
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '102000000',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('error')
      expect(result.response.category).toBe('invalid-age')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a duration whose cutoff at referenceTimeMs 0 exceeds the representable-Date boundary', () => {
    const { projectRoot } = makeTempProject()
    try {
      // 100,000,001 days at referenceTimeMs 0 -> cutoff -8,640,000,086,400,000,
      // 86,400,000ms past Date's representable minimum.
      const result = runPreviewViaNode({
        ackOffline: true,
        age: '100000001',
        referenceTimeMs: 0,
        root: projectRoot,
      })
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-age')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('accepts the same 100,000,001-day duration when the reference time makes the derived cutoff exactly representable', () => {
    const { projectRoot } = makeTempProject()
    try {
      // Counterexample to duration-only rejection: this duration alone
      // exceeds MAX_REPRESENTABLE_DATE_MS by 86,400,000ms, but at
      // referenceTimeMs 86,400,000 the derived cutoff is exactly
      // -8,640,000,000,000,000 -- Date's own inclusive minimum, valid.
      const result = runPreviewViaNode({
        ackOffline: true,
        age: '100000001',
        referenceTimeMs: 86_400_000,
        root: projectRoot,
      })
      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBeUndefined()
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('accepts the exact boundary day count whose cutoff is still a representable Date', () => {
    const { projectRoot } = makeTempProject()
    try {
      // At referenceTimeMs 0, exactly 100,000,000 days is Date's own
      // documented minimum representable value (inclusive boundary).
      const result = runPreviewViaNode({
        ackOffline: true,
        age: '100000000',
        referenceTimeMs: 0,
        root: projectRoot,
      })
      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBeUndefined()
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('requires the root argument', () => {
    const result = runCli(['preview', '--age', '30', '--ack-offline'])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('missing-root-argument')
  })

  it('rejects a nonexistent project root argument', () => {
    const result = runCli([
      'preview',
      '--root',
      '/definitely/does/not/exist/anywhere-12345',
      '--age',
      '30',
      '--ack-offline',
    ])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('invalid-root')
  })

  it('rejects an unknown flag rather than silently ignoring it', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
        '--force',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects an unexpected positional token rather than silently ignoring it', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
        'unexpected-positional',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a duplicated --root flag', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a duplicated --age flag', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a duplicated --ack-offline flag', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a --root flag with a dangling (missing) value at the end of argv, rather than treating the run as rootless', () => {
    const result = runCli(['preview', '--age', '30', '--ack-offline', '--root'])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('invalid-arguments')
  })

  it('rejects a --root flag whose "value" is actually the next flag, rather than silently consuming it as the path', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        '--age', // --root's value would wrongly become the literal string "--age"
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects an --age flag whose "value" is actually the next flag', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '--ack-offline', // --age's value would wrongly become "--ack-offline"
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('accepts the documented happy path unchanged: --root, --age (day/week/bare-integer), --ack-offline in any argument order', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      // Deliberately reordered relative to the other happy-path tests.
      const result = runCli([
        'preview',
        '--ack-offline',
        '--age',
        '30d',
        '--root',
        projectRoot,
      ])
      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview')
      if (!isCounts(result.response.counts)) throw new Error('expected counts')
      expect(result.response.counts.selected).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('is a read-only no-op that creates nothing when the review root is missing', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-cleanup-preview-noroot-'),
    )
    try {
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('root-missing')
      expect(fs.existsSync(path.join(projectRoot, '.context'))).toBe(false)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 2: candidate age eligibility and selection
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: candidate age eligibility', () => {
  it('selects an old run directory after acknowledgment and a valid age cutoff', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview')
      if (!isCounts(result.response.counts)) throw new Error('expected counts')
      expect(result.response.counts.selected).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('accepts an explicit day suffix and a week suffix', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const dayResult = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30d',
        '--ack-offline',
      ])
      if (
        !isCliResponse(dayResult.response) ||
        !isCounts(dayResult.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(dayResult.response.counts.selected).toBe(1)

      const weekResult = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '4w',
        '--ack-offline',
      ])
      if (
        !isCliResponse(weekResult.response) ||
        !isCounts(weekResult.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(weekResult.response.counts.selected).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('excludes a candidate exactly at the cutoff boundary (strictly older required)', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const referenceTimeMs = Date.now()
      const ageDurationMs = 30 * 86_400_000
      const exactCutoffMtimeMs = referenceTimeMs - ageDurationMs
      const dir = createCandidate(reviewRoot, 'exact-cutoff-run')
      fs.utimesSync(
        dir,
        new Date(exactCutoffMtimeMs),
        new Date(exactCutoffMtimeMs),
      )

      const result = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })

      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.exitCode).toBe(0)
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.excludedRecent).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('selects a candidate one millisecond older than the cutoff', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const referenceTimeMs = Date.now()
      const ageDurationMs = 30 * 86_400_000
      const justOlderMtimeMs = referenceTimeMs - ageDurationMs - 1
      const dir = createCandidate(reviewRoot, 'just-older-run')
      fs.utimesSync(dir, new Date(justOlderMtimeMs), new Date(justOlderMtimeMs))

      const result = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })

      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('protects an old directory that has a newer nested entry', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'old-with-fresh-nested')
      const nested = path.join(dir, 'nested')
      fs.mkdirSync(nested)
      fs.writeFileSync(path.join(nested, 'fresh.txt'), 'fresh')
      const old = daysAgo(40)
      fs.utimesSync(dir, old, old)

      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.excludedRecent).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('skips a candidate with a future modification time as uncertain age, not eligible', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'future-run')
      const future = new Date(Date.now() + 365 * 86_400_000)
      fs.utimesSync(dir, future, future)

      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(1)
      if (!isCandidateGroups(result.response.candidates)) {
        throw new Error('expected candidate groups')
      }
      const skipped = result.response.candidates.skippedUnknownUnsafe[0]
      if (!isCandidateEntry(skipped))
        throw new Error('expected candidate entry')
      expect(skipped.reason).toBe('future-timestamp')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('includes arbitrary historical run-directory names regardless of format', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'run_2019-03-01_legacy-format', {
        ageDays: 400,
      })
      createCandidate(reviewRoot, 'not-timestamp-shaped-at-all', {
        ageDays: 400,
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(2)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('excludes non-directory administrative entries such as .gitignore', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      fs.writeFileSync(path.join(reviewRoot, '.gitignore'), '*\n')
      createCandidate(reviewRoot, 'a-run', { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(1)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(0)
      expect(result.response.counts.excludedRecent).toBe(0)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('reports nothing-eligible rather than implying a clean store when nothing is old enough', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'recent-run', { ageDays: 1 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.result).toBe('nothing-eligible')
      expect(result.response.token).toBeNull()
      expect(result.response.counts.excludedRecent).toBe(1)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 3: status label projection
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: status label projection', () => {
  function labelOfFirstSelected(response: unknown): string {
    if (!isCliResponse(response)) throw new Error('expected JSON response')
    if (!isCandidateGroups(response.candidates))
      throw new Error('expected groups')
    const entry = response.candidates.selected[0]
    if (!isCandidateEntry(entry)) throw new Error('expected candidate entry')
    if (typeof entry.label !== 'string') throw new Error('expected label')
    return entry.label
  }

  it('labels a current-schema completed run', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'completed-run', {
        ageDays: 40,
        summary: { run_status: 'completed', schema_version: 1 },
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(labelOfFirstSelected(result.response)).toBe('completed')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels an in-progress run without asserting inactivity', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'in-progress-run', {
        ageDays: 40,
        summary: { run_status: 'in_progress', schema_version: 1 },
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(labelOfFirstSelected(result.response)).toBe('in_progress')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels an abnormal (failed) run', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'abnormal-run', {
        ageDays: 40,
        summary: { run_status: 'abnormal', schema_version: 1 },
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(labelOfFirstSelected(result.response)).toBe('abnormal')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels an artifactless run with no summary file', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'artifactless-run', { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(labelOfFirstSelected(result.response)).toBe('artifactless')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels a legacy summary without schema_version', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'legacy-run', {
        ageDays: 40,
        summary: { status: 'complete' },
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(labelOfFirstSelected(result.response)).toBe('legacy')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels malformed JSON as unknown, not a failure', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'malformed-run', {
        ageDays: 40,
        summaryRaw: '{ this is not valid json ',
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(0)
      expect(labelOfFirstSelected(result.response)).toBe('unknown')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels an oversized (>1 MiB) summary as unknown without reading it fully', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const oversized = `{"schema_version":1,"run_status":"completed","padding":"${'x'.repeat(1_100_000)}"}`
      createCandidate(reviewRoot, 'oversized-run', {
        ageDays: 40,
        summaryRaw: oversized,
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(0)
      expect(labelOfFirstSelected(result.response)).toBe('unknown')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('labels an unrecognized run_status value as unknown', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'unrecognized-status-run', {
        ageDays: 40,
        summary: { run_status: 'not-a-real-status', schema_version: 1 },
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(labelOfFirstSelected(result.response)).toBe('unknown')
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 4: output safety — bounded escaped names, canaries, absolute paths
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: output safety', () => {
  it('includes the exact run name JSON-escaped, alongside a hash-derived displayId', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const trickyName = 'run-[click me](javascript:alert(1))-\u0007-bell'
      createCandidate(reviewRoot, trickyName, { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(0)
      // The raw control byte must never appear unescaped in the transport
      // bytes; JSON.stringify encodes it as \u0007 instead.
      expect(result.stdout.includes('\u0007')).toBe(false)
      if (
        !isCliResponse(result.response) ||
        !isCandidateGroups(result.response.candidates)
      ) {
        throw new Error('expected candidate groups')
      }
      const entry = result.response.candidates.selected[0]
      if (!isCandidateEntry(entry)) throw new Error('expected candidate entry')
      // JSON.parse decodes the escape back to the exact original string.
      expect(entry.name).toBe(trickyName)
      expect(entry.displayId.length).toBeGreaterThanOrEqual(8)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('never echoes planted source-evidence canaries from summary contents', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const canary = 'SECRET_SOURCE_EXCERPT_CANARY_ABC123'
      createCandidate(reviewRoot, 'run-with-summary', {
        ageDays: 40,
        summary: {
          evidence: [canary],
          findings: [{ evidence: [canary] }],
          run_status: 'completed',
          schema_version: 1,
        },
      })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(canary)
      expect(result.stderr).not.toContain(canary)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('never echoes the absolute project root path', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'some-run', { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.stdout).not.toContain(projectRoot)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('bounds an excessively long run name rather than echoing it unbounded', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const longName = `run-${'a'.repeat(220)}`
      createCandidate(reviewRoot, longName, { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCandidateGroups(result.response.candidates)
      ) {
        throw new Error('expected candidate groups')
      }
      const entry = result.response.candidates.selected[0]
      if (!isCandidateEntry(entry)) throw new Error('expected candidate entry')
      expect(entry.name.length).toBeLessThan(longName.length)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('lengthens the display-id prefix to avoid collisions within one preview', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const names = Array.from({ length: 25 }, (_, i) => `run-${i}`)
      for (const name of names)
        createCandidate(reviewRoot, name, { ageDays: 40 })
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCandidateGroups(result.response.candidates)
      ) {
        throw new Error('expected candidate groups')
      }
      const ids = result.response.candidates.selected.map((entry) => {
        if (!isCandidateEntry(entry))
          throw new Error('expected candidate entry')
        return entry.displayId
      })
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(names.length)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 5: read-only guarantee
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: read-only guarantee', () => {
  it('leaves the input tree byte-for-byte unchanged after preview', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'stable-run', {
        ageDays: 40,
        summary: { run_status: 'completed', schema_version: 1 },
      })
      const summaryPath = path.join(dir, 'review-summary.json')
      const before = readFileSnapshot(summaryPath)

      runCli(['preview', '--root', projectRoot, '--age', '30', '--ack-offline'])

      const after = readFileSnapshot(summaryPath)
      expect(after.content.equals(before.content)).toBe(true)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 6: root/ancestor symlink refusal
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: root and ancestor symlink refusal', () => {
  it('refuses a review root that is itself a symlink', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    const elsewhere = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-cleanup-elsewhere-'),
    )
    try {
      fs.rmSync(reviewRoot, { force: true, recursive: true })
      fs.symlinkSync(elsewhere, reviewRoot, 'dir')
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('unsafe-review-root')
    } finally {
      cleanupTemp(projectRoot)
      cleanupTemp(elsewhere)
    }
  })

  it('refuses an ancestor symlink (.context/systematic is a symlink)', () => {
    const { projectRoot } = makeTempProject()
    const elsewhere = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-cleanup-elsewhere-'),
    )
    try {
      const systematicDir = path.join(projectRoot, '.context', 'systematic')
      fs.rmSync(systematicDir, { force: true, recursive: true })
      fs.symlinkSync(elsewhere, systematicDir, 'dir')
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('unsafe-review-root')
    } finally {
      cleanupTemp(projectRoot)
      cleanupTemp(elsewhere)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 7: candidate-subtree symlinks, special files, traversal bounds
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: candidate symlinks and traversal bounds', () => {
  it('refuses a direct-child symlink as a candidate', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    const elsewhere = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-cleanup-symlink-target-'),
    )
    try {
      fs.symlinkSync(elsewhere, path.join(reviewRoot, 'symlinked-run'), 'dir')
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(1)
      if (!isCandidateGroups(result.response.candidates)) {
        throw new Error('expected groups')
      }
      const skipped = result.response.candidates.skippedUnknownUnsafe[0]
      if (!isCandidateEntry(skipped))
        throw new Error('expected candidate entry')
      expect(skipped.reason).toBe('symlink')
    } finally {
      cleanupTemp(projectRoot)
      cleanupTemp(elsewhere)
    }
  })

  it('rejects the whole candidate when an internal descendant is a symlink', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    const elsewhere = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-cleanup-internal-symlink-'),
    )
    try {
      const dir = createCandidate(reviewRoot, 'has-internal-symlink', {
        ageDays: 40,
      })
      fs.symlinkSync(elsewhere, path.join(dir, 'escape-hatch'), 'dir')
      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(1)
      if (!isCandidateGroups(result.response.candidates)) {
        throw new Error('expected groups')
      }
      const skipped = result.response.candidates.skippedUnknownUnsafe[0]
      if (!isCandidateEntry(skipped))
        throw new Error('expected candidate entry')
      expect(skipped.reason).toBe('symlink')
    } finally {
      cleanupTemp(projectRoot)
      cleanupTemp(elsewhere)
    }
  })

  it('reports a depth-bound violation without partially processing the candidate', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'too-deep', { ageDays: 40 })
      let current = dir
      for (let i = 0; i < 40; i++) {
        current = path.join(current, `d${i}`)
        fs.mkdirSync(current)
      }
      const old = daysAgo(40)
      fs.utimesSync(dir, old, old)

      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(1)
      if (!isCandidateGroups(result.response.candidates)) {
        throw new Error('expected groups')
      }
      const skipped = result.response.candidates.skippedUnknownUnsafe[0]
      if (!isCandidateEntry(skipped))
        throw new Error('expected candidate entry')
      expect(skipped.reason).toBe('depth-limit')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('reports an entry-count-bound violation with more than 10,000 real temp entries', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'too-many-entries', {
        ageDays: 40,
      })
      const total = 10_001
      for (let i = 0; i < total; i++) {
        fs.writeFileSync(path.join(dir, `f${i}`), '')
      }
      const old = daysAgo(40)
      fs.utimesSync(dir, old, old)

      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(1)
      if (!isCandidateGroups(result.response.candidates)) {
        throw new Error('expected groups')
      }
      const skipped = result.response.candidates.skippedUnknownUnsafe[0]
      if (!isCandidateEntry(skipped))
        throw new Error('expected candidate entry')
      expect(skipped.reason).toBe('entry-limit')
    } finally {
      cleanupTemp(projectRoot)
    }
  }, 30_000)

  it('refuses a real Unix domain socket as a special file, closing and unlinking it', async () => {
    if (process.platform === 'win32') {
      // Windows does not expose filesystem-path AF_UNIX sockets the same
      // way as POSIX systems; this is a genuine platform limitation, not a
      // generic skip.
      return
    }
    const { projectRoot, reviewRoot } = makeTempProject()
    const net = await import('node:net')
    const dir = createCandidate(reviewRoot, 'has-socket', { ageDays: 40 })
    const socketPath = path.join(dir, 'sock')
    const server = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => resolve())
      })

      const result = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      if (
        !isCliResponse(result.response) ||
        !isCounts(result.response.counts)
      ) {
        throw new Error('expected counts')
      }
      expect(result.response.counts.selected).toBe(0)
      expect(result.response.counts.skippedUnknownUnsafe).toBe(1)
      if (!isCandidateGroups(result.response.candidates)) {
        throw new Error('expected groups')
      }
      const skipped = result.response.candidates.skippedUnknownUnsafe[0]
      if (!isCandidateEntry(skipped))
        throw new Error('expected candidate entry')
      expect(skipped.reason).toBe('special-file')
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      fs.rmSync(socketPath, { force: true })
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 8: deterministic scanner-failure harness (no monkeypatching)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: deterministic scanner failure (node:assert harness)', () => {
  it('statSnapshotEntry reports a real lstat failure for a missing/replaced path, reusable for a future rescan', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      `import { statSnapshotEntry, walkCandidateSubtree } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const missing = statSnapshotEntry('/definitely/does/not/exist/ce-review-cleanup-probe');",
      'assert.equal(missing.ok, false);',
      "assert.equal(missing.reason, 'unreadable');",
      '',
      "const walked = walkCandidateSubtree('/definitely/does/not/exist/ce-review-cleanup-probe');",
      'assert.equal(walked.ok, false);',
      "assert.equal(walked.reason, 'unreadable');",
      '',
      "process.stdout.write('OK');",
    ]
    const script = lines.join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('OK')
    expect(result.status).toBe(0)
  })

  it('statSnapshotEntry classifies a real symlink and a real regular file correctly', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-cleanup-statentry-'),
    )
    try {
      const filePath = path.join(dir, 'a-file')
      fs.writeFileSync(filePath, 'x')
      const linkPath = path.join(dir, 'a-link')
      fs.symlinkSync(filePath, linkPath)

      const lines = [
        "import assert from 'node:assert/strict';",
        `import { statSnapshotEntry } from ${JSON.stringify(SCRIPT_URL)};`,
        '',
        `const file = statSnapshotEntry(${JSON.stringify(filePath)});`,
        'assert.equal(file.ok, true);',
        "assert.equal(file.type, 'file');",
        '',
        `const link = statSnapshotEntry(${JSON.stringify(linkPath)});`,
        'assert.equal(link.ok, false);',
        "assert.equal(link.reason, 'symlink');",
        '',
        "process.stdout.write('OK');",
      ]
      const script = lines.join('\n')
      const result = spawnSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe('OK')
    } finally {
      cleanupTemp(dir)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 9: prefix-widening pure function (synthetic digests, no test flags)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: display-id prefix widening', () => {
  it('widens the prefix length until synthetic digests sharing an 8-char prefix become unique', () => {
    const synthetic = [
      `aaaa1111${'0'.repeat(56)}`,
      `aaaa1111${'1'.repeat(56)}`,
      `bbbb2222${'2'.repeat(56)}`,
    ]
    const result = callExportViaNode('widenUniquePrefixes', synthetic)
    if (!Array.isArray(result)) throw new Error('expected an array of prefixes')
    expect(new Set(result).size).toBe(synthetic.length)
    expect(result[0]).not.toBe(result[1])
  })

  it('keeps the shortest unique prefix length when no collision exists', () => {
    const synthetic = ['1111aaaa', '2222bbbb', '3333cccc']
    const result = callExportViaNode('widenUniquePrefixes', synthetic)
    if (!Array.isArray(result)) throw new Error('expected an array of prefixes')
    for (const prefix of result) {
      if (typeof prefix !== 'string')
        throw new Error('expected a string prefix')
      expect(prefix.length).toBe(8)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 10: token/digest contract
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: token and digest contract', () => {
  function decodeToken(token: string): Record<string, unknown> {
    const decoded: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    )
    if (!isJsonObject(decoded))
      throw new Error('expected a decodable token payload')
    return decoded
  }

  it('produces a token whose fields are individually recoverable, not just a hash', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'token-run', { ageDays: 40 })
      const referenceTimeMs = Date.now()
      const result = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })
      if (
        !isCliResponse(result.response) ||
        typeof result.response.token !== 'string'
      ) {
        throw new Error('expected a token string')
      }
      const payload = decodeToken(result.response.token)
      expect(payload.referenceTimeMs).toBe(referenceTimeMs)
      expect(payload.ageDurationMs).toBe(30 * 86_400_000)
      expect(payload.cutoffTimeMs).toBe(referenceTimeMs - 30 * 86_400_000)
      expect(typeof payload.digest).toBe('string')
      expect(typeof payload.v).toBe('number')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('produces the same token for the same tree and fixed reference time (repeatable)', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'repeatable-run', {
        ageDays: 40,
        summary: { run_status: 'completed', schema_version: 1 },
      })
      const referenceTimeMs = Date.now()
      const first = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })
      const second = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })
      if (!isCliResponse(first.response) || !isCliResponse(second.response)) {
        throw new Error('expected JSON responses')
      }
      expect(first.response.token).toBe(second.response.token)
      expect(first.response.token).not.toBeNull()
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('changes the digest when a selected candidate is modified below its unchanged max mtime', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'mutating-run', { ageDays: 40 })
      const old = daysAgo(40)
      const referenceTimeMs = Date.now()

      const before = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })

      fs.writeFileSync(path.join(dir, 'extra.txt'), 'new content')
      fs.utimesSync(path.join(dir, 'extra.txt'), old, old)
      fs.utimesSync(dir, old, old)

      const after = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })

      if (!isCliResponse(before.response) || !isCliResponse(after.response)) {
        throw new Error('expected JSON responses')
      }
      expect(before.response.token).not.toBe(after.response.token)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('changes the digest when direct-child membership changes (a new run directory appears)', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'stable-run', { ageDays: 40 })
      const referenceTimeMs = Date.now()

      const before = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })

      createCandidate(reviewRoot, 'new-recent-run', { ageDays: 1 })

      const after = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })

      if (!isCliResponse(before.response) || !isCliResponse(after.response)) {
        throw new Error('expected JSON responses')
      }
      expect(before.response.token).not.toBe(after.response.token)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 11: exports contract (node:assert harness)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: module exports contract', () => {
  it('exports the documented pure functions for Unit 3 reuse, with no CLI side effects on import', () => {
    const expected = [
      'parseAgeCutoff',
      'computeCutoffTimeMs',
      'statSnapshotEntry',
      'walkCandidateSubtree',
      'deriveStatusLabel',
      'widenUniquePrefixes',
      'deriveDisplayIds',
      'boundedName',
      'computeSnapshotDigest',
      'buildPreviewToken',
      'runPreview',
    ]
    const lines = [
      "import assert from 'node:assert/strict';",
      `import * as mod from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      `const expected = ${JSON.stringify(expected)};`,
      'for (const name of expected) {',
      "  assert.equal(typeof mod[name], 'function', name + ' should be an exported function');",
      '}',
      '',
      "process.stdout.write('OK');",
    ]
    const script = lines.join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('OK')
    expect(result.status).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Slice 12: stale-snapshot status re-verification (TOCTOU regressions)
// ═══════════════════════════════════════════════════════════════════════
//
// deriveStatusLabel receives entries captured by an earlier
// walkCandidateSubtree call. A correct implementation must re-verify the
// CURRENT file at read time -- never trust the stale snapshot's recorded
// size or type -- and must never follow a symlink substituted after the
// snapshot was taken. Both scenarios below are real, deterministic
// filesystem states (no mocks, no monkeypatching).

describe('ce-review-cleanup preview: stale-snapshot status re-verification', () => {
  it('labels unknown when the current summary file grew past the cap after the snapshot was taken', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { walkCandidateSubtree, deriveStatusLabel } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-toctou-'));",
      'try {',
      "  const candidate = path.join(dir, 'run');",
      '  fs.mkdirSync(candidate);',
      "  const summaryPath = path.join(candidate, 'review-summary.json');",
      "  fs.writeFileSync(summaryPath, JSON.stringify({ schema_version: 1, run_status: 'completed' }));",
      '',
      '  const walked = walkCandidateSubtree(candidate);',
      '  assert.equal(walked.ok, true);',
      '',
      "  const oversized = JSON.stringify({ schema_version: 1, run_status: 'completed', padding: 'x'.repeat(1_100_000) });",
      '  fs.writeFileSync(summaryPath, oversized);',
      '',
      '  const label = deriveStatusLabel(candidate, walked.entries);',
      "  assert.equal(label, 'unknown', 'expected unknown for a current file that grew past the cap after the snapshot; got: ' + label);",
      '',
      "  process.stdout.write('OK');",
      '} finally {',
      '  fs.rmSync(dir, { force: true, recursive: true });',
      '}',
    ]
    const script = lines.join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('OK')
    expect(result.status).toBe(0)
  })

  it('labels unknown when the current summary was replaced via rename (same size, recognized status, different inode)', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { walkCandidateSubtree, deriveStatusLabel } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-toctou-rename-'));",
      'try {',
      "  const candidate = path.join(dir, 'run');",
      '  fs.mkdirSync(candidate);',
      "  const summaryPath = path.join(candidate, 'review-summary.json');",
      '  const original = \'{"schema_version":1,"run_status":"completed","pad":"AAAAAAAAAA"}\';',
      '  fs.writeFileSync(summaryPath, original);',
      '',
      '  const walked = walkCandidateSubtree(candidate);',
      '  assert.equal(walked.ok, true);',
      "  const originalEntry = walked.entries.find((e) => e.relativePath === 'review-summary.json');",
      '  assert.ok(originalEntry);',
      '',
      "  const replacement = path.join(dir, 'replacement.json');",
      '  const swapped = \'{"schema_version":1,"run_status":"completed","pad":"BBBBBBBBBB"}\';',
      '  assert.equal(swapped.length, original.length);',
      '  fs.writeFileSync(replacement, swapped);',
      '  fs.renameSync(replacement, summaryPath);',
      '',
      '  const newIno = fs.lstatSync(summaryPath).ino.toString();',
      "  assert.notEqual(newIno, originalEntry.ino, 'rename must produce a different inode for this regression to be meaningful');",
      '',
      '  const label = deriveStatusLabel(candidate, walked.entries);',
      "  assert.equal(label, 'unknown', 'expected unknown for a same-size, recognized-status file swapped in via rename; got: ' + label);",
      '',
      "  process.stdout.write('OK');",
      '} finally {',
      '  fs.rmSync(dir, { force: true, recursive: true });',
      '}',
    ]
    const script = lines.join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('OK')
    expect(result.status).toBe(0)
  })

  it('labels unknown and never follows a symlink substituted for the summary after the snapshot was taken', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { walkCandidateSubtree, deriveStatusLabel } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-toctou-symlink-'));",
      'try {',
      "  const candidate = path.join(dir, 'run');",
      '  fs.mkdirSync(candidate);',
      "  const summaryPath = path.join(candidate, 'review-summary.json');",
      "  fs.writeFileSync(summaryPath, JSON.stringify({ schema_version: 1, run_status: 'completed' }));",
      '',
      '  const walked = walkCandidateSubtree(candidate);',
      '  assert.equal(walked.ok, true);',
      '',
      "  const elsewhere = path.join(dir, 'elsewhere.json');",
      "  fs.writeFileSync(elsewhere, JSON.stringify({ schema_version: 1, run_status: 'degraded' }));",
      '  fs.rmSync(summaryPath);',
      '  fs.symlinkSync(elsewhere, summaryPath);',
      '',
      '  const label = deriveStatusLabel(candidate, walked.entries);',
      "  assert.equal(label, 'unknown', 'expected unknown for a summary path replaced by a symlink; must not follow it; got: ' + label);",
      '',
      "  process.stdout.write('OK');",
      '} finally {',
      '  fs.rmSync(dir, { force: true, recursive: true });',
      '}',
    ]
    const script = lines.join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('OK')
    expect(result.status).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════
// FIFO-substitution hang window (CodeQL js/file-system-race, cleanup.mjs
// deriveStatusLabel open)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: FIFO-substitution open no longer hangs', () => {
  const maybeIt = mkfifoAvailable ? it : it.skip

  maybeIt(
    'derives "unknown" (not a hang) from the real deriveStatusLabel when the checked path is swapped for a FIFO at the actual lstat->open syscall boundary',
    () => {
      const { projectRoot, reviewRoot } = makeTempProject()
      try {
        const dir = createCandidate(reviewRoot, 'fifo-swap-run', {
          ageDays: 40,
          summary: { run_status: 'completed', schema_version: 1 },
        })
        const summaryPath = path.join(dir, 'review-summary.json')

        // Fixed script; the candidate/summary paths are the only
        // per-run data, passed via argv. Intercepting the default `fs`
        // export's lstatSync (mutable CJS module object) and syncing it
        // into cleanup.mjs's named ESM binding lets this child perform
        // the filesystem swap from inside the real, single call
        // deriveStatusLabel makes for its pre-open check -- the actual
        // syscall boundary, not a timed race and not a production seam.
        const lines = [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          "import { execFileSync } from 'node:child_process';",
          `import { deriveStatusLabel, walkCandidateSubtree } from ${JSON.stringify(SCRIPT_URL)};`,
          '',
          'const candidateAbsPath = process.argv[1];',
          'const summaryPath = process.argv[2];',
          '',
          'const walked = walkCandidateSubtree(candidateAbsPath);',
          'if (!walked.ok) {',
          '  process.stdout.write(JSON.stringify({ setupError: walked.reason }));',
          '  process.exit(3);',
          '}',
          '',
          'const originalLstatSync = fs.lstatSync;',
          'const originalCloseSync = fs.closeSync;',
          'let closeCallCount = 0;',
          'fs.closeSync = function (fd) {',
          '  closeCallCount += 1;',
          '  return originalCloseSync(fd);',
          '};',
          'fs.lstatSync = function (p, options) {',
          '  if (p !== summaryPath) return originalLstatSync(p, options);',
          '  const stat = originalLstatSync(p, options);',
          "  fs.renameSync(p, p + '.aside');",
          "  execFileSync('mkfifo', [p]);",
          '  return stat;',
          '};',
          'syncBuiltinESMExports();',
          '',
          'const label = deriveStatusLabel(candidateAbsPath, walked.entries);',
          'const closeCallCountObserved = closeCallCount;',
          '',
          'fs.lstatSync = originalLstatSync;',
          'fs.closeSync = originalCloseSync;',
          'syncBuiltinESMExports();',
          '',
          'process.stdout.write(JSON.stringify({ label, closeCallCountObserved }));',
        ]
        const script = lines.join('\n')
        const result = spawnSync(
          'node',
          ['--input-type=module', '-e', script, '--', dir, summaryPath],
          { encoding: 'utf8', timeout: 5_000 },
        )
        expect(result.stderr).toBe('')
        let parsed: unknown
        try {
          parsed = JSON.parse(result.stdout)
        } catch {
          throw new Error(`expected JSON stdout, got: ${result.stdout}`)
        }
        if (!isJsonObject(parsed))
          throw new Error('expected a JSON object from the FIFO-swap child')
        expect(parsed.label).toBe('unknown')
        expect(parsed.closeCallCountObserved).toBe(1)
      } finally {
        cleanupTemp(projectRoot)
      }
    },
  )

  if (!mkfifoAvailable) {
    it('skips: mkfifo is not available on this platform/sandbox', () => {
      expect(mkfifoAvailable).toBe(false)
    })
  }
})

// ════════════════════════════════════════════════════════════════════════
// deriveStatusLabel: read-time failure never escapes as an uncaught exception
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup preview: read-time failure does not escape deriveStatusLabel', () => {
  it('returns "unknown" (not a thrown exception) when node:fs.readSync fails mid-read, and still closes the fd', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'injected-eio-run', {
        ageDays: 40,
        summary: { run_status: 'completed', schema_version: 1 },
      })

      const lines = [
        "import fs from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        `import { deriveStatusLabel, walkCandidateSubtree } from ${JSON.stringify(SCRIPT_URL)};`,
        '',
        'const candidateAbsPath = process.argv[1];',
        '',
        'const walked = walkCandidateSubtree(candidateAbsPath);',
        'if (!walked.ok) {',
        '  process.stdout.write(JSON.stringify({ setupError: walked.reason }));',
        '  process.exit(3);',
        '}',
        '',
        'const originalReadSync = fs.readSync;',
        'const originalCloseSync = fs.closeSync;',
        'let closeCallCount = 0;',
        'fs.closeSync = function (fd) {',
        '  closeCallCount += 1;',
        '  return originalCloseSync(fd);',
        '};',
        'fs.readSync = function () {',
        "  throw Object.assign(new Error('injected EIO'), { code: 'EIO' });",
        '};',
        'syncBuiltinESMExports();',
        '',
        'const injectedLabel = deriveStatusLabel(candidateAbsPath, walked.entries);',
        'const closeCallCountDuringInjection = closeCallCount;',
        '',
        'fs.readSync = originalReadSync;',
        'fs.closeSync = originalCloseSync;',
        'syncBuiltinESMExports();',
        '',
        'const restoredWalked = walkCandidateSubtree(candidateAbsPath);',
        'const restoredLabel = restoredWalked.ok',
        '  ? deriveStatusLabel(candidateAbsPath, restoredWalked.entries)',
        "  : 'walk-failed';",
        '',
        'process.stdout.write(JSON.stringify({',
        '  injectedLabel,',
        '  closeCallCountDuringInjection,',
        '  restoredLabel,',
        '}));',
      ]
      const script = lines.join('\n')
      const result = spawnSync(
        'node',
        ['--input-type=module', '-e', script, '--', dir],
        { encoding: 'utf8', timeout: 15_000 },
      )
      expect(result.stderr).toBe('')
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw new Error(`expected JSON stdout, got: ${result.stdout}`)
      }
      if (!isJsonObject(parsed))
        throw new Error('expected a JSON object from the injection child')
      expect(parsed.injectedLabel).toBe('unknown')
      expect(parsed.closeCallCountDuringInjection).toBe(1)
      expect(parsed.restoredLabel).toBe('completed')
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// main()'s top-level error boundary: a deterministic exception never
// leaves a raw stack trace on stderr or an undefined exit code
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup CLI: top-level error boundary', () => {
  it('emits the fixed internal-error JSON contract, not a raw stack trace, when a deterministic exception escapes main()', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = spawnSync(
        'node',
        [
          DATE_FAULT_FIXTURE_PATH,
          'preview',
          '--root',
          projectRoot,
          '--age',
          '30',
          '--ack-offline',
        ],
        { encoding: 'utf8', timeout: 15_000 },
      )

      expect(result.stderr).toBe('')
      expect(result.status).toBe(2)
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw new Error(`expected JSON stdout, got: ${result.stdout}`)
      }
      if (!isCliResponse(parsed))
        throw new Error('expected a CLI response object')
      expect(parsed.result).toBe('error')
      expect(parsed.category).toBe('internal-error')
      expect(parsed.operation).toBe('unknown')
      // The injected error's own message must never leak into output.
      expect(result.stdout).not.toContain('injected-fault')
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Static, read-only help: `help`, `--help`, `preview --help`, `execute --help`
// ═══════════════════════════════════════════════════════════════════════

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

describe('ce-review-cleanup CLI: static help', () => {
  it('top-level "help" returns a structured static response, not unknown-operation', () => {
    const result = runCli(['help'])
    expect(result.exitCode).toBe(0)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.result).toBe('help')
    expect(result.response.operation).toBe('help')
  })

  it('top-level "--help" returns the same structured static response', () => {
    const result = runCli(['--help'])
    expect(result.exitCode).toBe(0)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.result).toBe('help')
    expect(result.response.operation).toBe('help')
  })

  it('top-level help documents both preview and execute usage, required flags, and exit-code meanings', () => {
    const result = runCli(['help'])
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    const usage = result.response.usage
    if (!isJsonObject(usage)) throw new Error('expected a usage object')
    expect(typeof usage.preview).toBe('string')
    expect(typeof usage.execute).toBe('string')
    if (typeof usage.preview === 'string') {
      expect(usage.preview).toContain('--root')
      expect(usage.preview).toContain('--age')
      expect(usage.preview).toContain('--ack-offline')
    }
    if (typeof usage.execute === 'string') {
      expect(usage.execute).toContain('--root')
      expect(usage.execute).toContain('--token')
      expect(usage.execute).toContain('--ack-offline')
    }
    const exitCodes = result.response.exitCodes
    if (!isJsonObject(exitCodes))
      throw new Error('expected an exitCodes object')
    expect(Object.keys(exitCodes).sort()).toEqual(['0', '1', '2', '3'])
  })

  it('top-level help explains --ack-offline is an unverified operator assertion, and a token is not authenticated human approval', () => {
    const result = runCli(['help'])
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    const notes = result.response.notes
    if (!isStringArray(notes)) throw new Error('expected a notes string array')
    const joined = notes.join(' ').toLowerCase()
    expect(joined).toContain('ack-offline')
    expect(joined).toContain('assertion')
    expect(joined).toContain('not') // "not independently verified" / "not ... approval"
    expect(joined).toContain('token')
    expect(joined).toContain('approval')
  })

  it('"preview --help" returns scoped help without requiring --root/--age/--ack-offline', () => {
    const result = runCli(['preview', '--help'])
    expect(result.exitCode).toBe(0)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.result).toBe('help')
    expect(result.response.operation).toBe('preview')
  })

  it('"execute --help" returns scoped help without requiring --root/--token/--ack-offline', () => {
    const result = runCli(['execute', '--help'])
    expect(result.exitCode).toBe(0)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.result).toBe('help')
    expect(result.response.operation).toBe('execute')
  })

  it('rejects help mixed with execution options as ambiguous rather than silently running or silently ignoring --help', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'preview',
        '--help',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      expect(result.exitCode).not.toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('error')
      // Must not have scanned or produced a preview result.
      expect(result.response.result).not.toBe('preview')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects "execute --help" combined with --token as ambiguous rather than silently running execute or silently ignoring --help', () => {
    const result = runCli([
      'execute',
      '--help',
      '--token',
      'x',
      '--ack-offline',
    ])
    expect(result.exitCode).not.toBe(0)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.result).toBe('error')
  })

  it('help never scans the filesystem: an otherwise-invalid/nonexistent root passed alongside --help is still rejected as ambiguous, never triggering root resolution', () => {
    const result = runCli([
      'preview',
      '--root',
      '/definitely/does/not/exist/anywhere-help-test',
      '--help',
    ])
    expect(result.exitCode).not.toBe(0)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    // Must be an argument-shape rejection, not a root-resolution outcome.
    expect(result.response.result).toBe('error')
  })

  it('help output never echoes the invoking process cwd or environment values', () => {
    const result = runCli(['help'])
    expect(result.stdout).not.toContain(process.cwd())
    if (process.env.HOME) {
      expect(result.stdout).not.toContain(process.env.HOME)
    }
  })

  it('help is idempotent and produces byte-identical output across repeated invocations (no timestamps, no state)', () => {
    const first = runCli(['help'])
    const second = runCli(['help'])
    expect(first.stdout).toBe(second.stdout)
  })
})
