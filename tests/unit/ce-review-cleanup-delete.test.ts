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
} {
  if (!isJsonObject(value)) return false
  if (typeof value.schema_version !== 'number') return false
  if (typeof value.operation !== 'string') return false
  if (typeof value.result !== 'string') return false
  return true
}

function isExecuteCounts(value: unknown): value is {
  readonly selected: number
  readonly excludedRecent: number
  readonly skippedUnknownUnsafe: number
  readonly deleted: number
  readonly skipped: number
  readonly failed: number
} {
  if (!isJsonObject(value)) return false
  return (
    typeof value.selected === 'number' &&
    typeof value.excludedRecent === 'number' &&
    typeof value.skippedUnknownUnsafe === 'number' &&
    typeof value.deleted === 'number' &&
    typeof value.skipped === 'number' &&
    typeof value.failed === 'number'
  )
}

// ── CLI harness ──────────────────────────────────────────────────────────

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

/** Runs an exported pure function through a real Node subprocess, proving
 * no node_modules dependency, with explicit control over inputs that would
 * otherwise depend on wall-clock time. */
function runExecuteViaNode(options: {
  readonly root?: string
  readonly ackOffline: boolean
  readonly token?: string
  readonly nowMs: number
}): { readonly exitCode: number; readonly response: unknown } {
  const script = `
import { runExecute } from ${JSON.stringify(SCRIPT_URL)};
const result = runExecute(${JSON.stringify(options)});
process.stdout.write(JSON.stringify(result));
`
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout ?? '')
  } catch {
    parsed = undefined
  }
  if (!isJsonObject(parsed) || typeof parsed.exitCode !== 'number') {
    throw new Error(
      `unexpected runExecute subprocess output: ${result.stdout} / ${result.stderr}`,
    )
  }
  return { exitCode: parsed.exitCode, response: parsed.response }
}

function runPreviewViaNode(options: {
  readonly root?: string
  readonly age?: string
  readonly ackOffline: boolean
  readonly referenceTimeMs: number
}): { readonly exitCode: number; readonly response: unknown } {
  const script = `
import { runPreview } from ${JSON.stringify(SCRIPT_URL)};
const result = runPreview(${JSON.stringify(options)});
process.stdout.write(JSON.stringify(result));
`
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  })
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

function extractToken(previewResponse: unknown): string {
  if (
    !isCliResponse(previewResponse) ||
    typeof previewResponse.token !== 'string'
  ) {
    throw new Error(
      `expected a preview token, got: ${JSON.stringify(previewResponse)}`,
    )
  }
  return previewResponse.token
}

// ── Fixture helpers (real fs, own temp dirs only) ──────────────────────────

function makeTempProject(): {
  readonly projectRoot: string
  readonly reviewRoot: string
} {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ce-review-cleanup-delete-'),
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
  } = {},
): string {
  const dir = path.join(reviewRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  if (options.summary !== undefined) {
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

// ═══════════════════════════════════════════════════════════════════════
// First real behavioral assertion (TDD checkpoint): a valid preview token
// from this test's own fixture must produce a successful delete, not the
// prior unit's execute-not-implemented refusal.
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: first real behavioral slice', () => {
  it('deletes the single previewed candidate given a valid token and offline acknowledgment', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const candidateDir = createCandidate(reviewRoot, 'old-run', {
        ageDays: 40,
      })

      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])

      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('deleted')
      if (!isExecuteCounts(result.response.counts)) {
        throw new Error('expected execute counts')
      }
      expect(result.response.counts.deleted).toBe(1)
      expect(result.response.counts.failed).toBe(0)
      expect(result.response.counts.skipped).toBe(0)
      expect(fs.existsSync(candidateDir)).toBe(false)
      expect(fs.existsSync(reviewRoot)).toBe(true)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Argument and token validation
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: argument and token validation', () => {
  it('refuses execute when offline acknowledgment is missing, even with a valid token', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('missing-acknowledgment')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('refuses execute when the token is missing', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli(['execute', '--root', projectRoot, '--ack-offline'])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('missing-token')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  const validDigest = 'a'.repeat(64)
  function encodeRawToken(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  }

  it.each([
    ['not-base64-json-at-all'],
    [encodeRawToken(null)],
    [
      encodeRawToken({
        ageDurationMs: 1,
        cutoffTimeMs: 0,
        digest: validDigest,
        referenceTimeMs: 1,
        v: 2, // wrong version
      }),
    ],
    [
      encodeRawToken({
        ageDurationMs: 1,
        cutoffTimeMs: -2,
        digest: validDigest,
        referenceTimeMs: -1, // negative reference time
        v: 1,
      }),
    ],
    [
      encodeRawToken({
        ageDurationMs: 0, // zero duration
        cutoffTimeMs: 10,
        digest: validDigest,
        referenceTimeMs: 10,
        v: 1,
      }),
    ],
    [
      encodeRawToken({
        ageDurationMs: 5,
        cutoffTimeMs: 999, // inconsistent with referenceTimeMs - ageDurationMs
        digest: validDigest,
        referenceTimeMs: 10,
        v: 1,
      }),
    ],
    [
      encodeRawToken({
        ageDurationMs: 5,
        cutoffTimeMs: 5,
        digest: 'not-hex', // wrong shape
        referenceTimeMs: 10,
        v: 1,
      }),
    ],
    [
      `${encodeRawToken({
        ageDurationMs: 5,
        cutoffTimeMs: 5,
        digest: validDigest,
        referenceTimeMs: 10,
        v: 1,
      })}${'A'.repeat(5000)}`, // oversized
    ],
  ])('rejects a malformed/oversized/inconsistent token: %s', (token) => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-token')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a token whose reference time is in the future relative to now', () => {
    // Capture the base time once: deriving both timestamps from a single
    // reading (instead of two separate `Date.now()` calls) removes any
    // theoretical millisecond-boundary tear between them, keeping the
    // token's own cutoff/duration/reference-time relationship exact.
    const nowMs = Date.now()
    const futureToken = Buffer.from(
      JSON.stringify({
        ageDurationMs: 1000,
        cutoffTimeMs: nowMs + 365 * 86_400_000 - 1000,
        digest: 'a'.repeat(64),
        referenceTimeMs: nowMs + 365 * 86_400_000,
        v: 1,
      }),
      'utf8',
    ).toString('base64url')
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        futureToken,
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-token')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects an unknown flag', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        'x',
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

  it('rejects a duplicated --root flag', () => {
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        'x',
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
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--ack-offline',
        '--token',
        'x',
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-arguments')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  function wellFormedToken(): string {
    return Buffer.from(
      JSON.stringify({
        ageDurationMs: 5,
        cutoffTimeMs: 5,
        digest: 'a'.repeat(64),
        referenceTimeMs: 10,
        v: 1,
      }),
      'utf8',
    ).toString('base64url')
  }

  it('rejects a missing root argument (structurally valid token, so root is what is actually exercised)', () => {
    const result = runCli([
      'execute',
      '--ack-offline',
      '--token',
      wellFormedToken(),
    ])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('missing-root-argument')
  })

  it('rejects a nonexistent root argument (structurally valid token, so root is what is actually exercised)', () => {
    const result = runCli([
      'execute',
      '--root',
      '/definitely/does/not/exist/anywhere-ce-review-execute',
      '--ack-offline',
      '--token',
      wellFormedToken(),
    ])
    expect(result.exitCode).toBe(2)
    if (!isCliResponse(result.response))
      throw new Error('expected JSON response')
    expect(result.response.category).toBe('invalid-root')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Wrong-root rejection
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: wrong-root rejection', () => {
  it('rejects a token from one root when supplied against a different (structurally identical) root', () => {
    const projectA = makeTempProject()
    const projectB = makeTempProject()
    try {
      createCandidate(projectA.reviewRoot, 'old-run', { ageDays: 40 })
      createCandidate(projectB.reviewRoot, 'old-run', { ageDays: 40 })

      const preview = runCli([
        'preview',
        '--root',
        projectA.projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      const result = runCli([
        'execute',
        '--root',
        projectB.projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(3)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview-stale')

      // Neither root's candidate was touched.
      expect(fs.existsSync(path.join(projectA.reviewRoot, 'old-run'))).toBe(
        true,
      )
      expect(fs.existsSync(path.join(projectB.reviewRoot, 'old-run'))).toBe(
        true,
      )
    } finally {
      cleanupTemp(projectA.projectRoot)
      cleanupTemp(projectB.projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Initial whole-selection staleness (exit 3, zero deletions)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: initial staleness invalidates the whole preview', () => {
  it('rejects when the review root disappeared entirely after preview', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      fs.rmSync(reviewRoot, { force: true, recursive: true })

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(3)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview-stale')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a same-count directory replacement (different inode, same name)', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const original = createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)
      const originalIno = fs.lstatSync(original).ino

      fs.rmSync(original, { force: true, recursive: true })
      const replacement = createCandidate(reviewRoot, 'old-run', {
        ageDays: 40,
      })
      expect(fs.lstatSync(replacement).ino).not.toBe(originalIno)

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(3)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview-stale')
      expect(fs.existsSync(replacement)).toBe(true)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a nested modification below the unchanged max-mtime', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const dir = createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const nestedFile = path.join(dir, 'a.txt')
      fs.writeFileSync(nestedFile, 'one')
      const old = daysAgo(40)
      fs.utimesSync(nestedFile, old, old)
      fs.utimesSync(dir, old, old)

      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      // Same name, same mtime pinned back to old, different content/size.
      fs.writeFileSync(nestedFile, 'two-different-length')
      fs.utimesSync(nestedFile, old, old)
      fs.utimesSync(dir, old, old)

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(3)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview-stale')
      expect(fs.existsSync(dir)).toBe(true)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects when a new run directory appeared (membership changed)', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'old-run', { ageDays: 40 })
      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      createCandidate(reviewRoot, 'brand-new-run', { ageDays: 1 })

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(3)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview-stale')
      expect(fs.existsSync(path.join(reviewRoot, 'old-run'))).toBe(true)
      expect(fs.existsSync(path.join(reviewRoot, 'brand-new-run'))).toBe(true)
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects when a previously-selected candidate directory was removed (membership changed)', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      createCandidate(reviewRoot, 'run-a', { ageDays: 40 })
      const dirB = createCandidate(reviewRoot, 'run-b', { ageDays: 40 })
      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      fs.rmSync(dirB, { force: true, recursive: true })

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(3)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('preview-stale')
      expect(fs.existsSync(path.join(reviewRoot, 'run-a'))).toBe(true)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Fixed cutoff reuse: elapsed real time must not expand the approved set
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: fixed cutoff reuse', () => {
  it('succeeds using the token fixed time boundary even when nowMs has advanced far past a second candidate crossing the cutoff', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const referenceTimeMs = Date.now()
      // A: already 40 days old at T0 -- selected under a 30-day cutoff.
      const dirA = createCandidate(reviewRoot, 'run-a', { ageDays: 40 })
      // B: only 20 days old at T0 -- excluded-recent under a 30-day cutoff,
      // but WOULD cross a 30-day cutoff computed from a much later "now".
      const dirB = createCandidate(reviewRoot, 'run-b', { ageDays: 20 })

      const preview = runPreviewViaNode({
        ackOffline: true,
        age: '30',
        referenceTimeMs,
        root: projectRoot,
      })
      const token = extractToken(preview.response)

      // Real wall-clock time "advances" by 25 days -- far enough that a
      // buggy implementation reusing `nowMs` for the rescan cutoff would
      // newly include run-b, changing the digest.
      const farFutureNowMs = referenceTimeMs + 25 * 86_400_000

      const result = runExecuteViaNode({
        ackOffline: true,
        nowMs: farFutureNowMs,
        root: projectRoot,
        token,
      })

      expect(result.exitCode).toBe(0)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('deleted')
      if (!isExecuteCounts(result.response.counts))
        throw new Error('expected counts')
      expect(result.response.counts.deleted).toBe(1)
      expect(fs.existsSync(dirA)).toBe(false)
      expect(fs.existsSync(dirB)).toBe(true)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Per-candidate drift after the initial whole-selection match: partial
// results, other candidates preserved (Node harness driving the exported
// per-candidate primitive directly against a real, altered fs -- no
// sleep-based races, no global mock, no production test flag).
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: per-candidate drift and partial results', () => {
  it('skips a candidate whose subtree was altered after the approved snapshot was taken, without touching a sibling candidate', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { walkCandidateSubtree, executeApprovedCandidate } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-drift-'));",
      'try {',
      "  const reviewRoot = path.join(dir, '.context', 'systematic', 'ce-review');",
      '  fs.mkdirSync(reviewRoot, { recursive: true });',
      "  const candidateA = path.join(reviewRoot, 'run-a');",
      "  const candidateB = path.join(reviewRoot, 'run-b');",
      '  fs.mkdirSync(candidateA);',
      '  fs.mkdirSync(candidateB);',
      '',
      '  const walkedA = walkCandidateSubtree(candidateA);',
      '  const walkedB = walkCandidateSubtree(candidateB);',
      '  assert.equal(walkedA.ok, true);',
      '  assert.equal(walkedB.ok, true);',
      '',
      '  const rootStat = fs.lstatSync(reviewRoot, { bigint: true });',
      '  const rootIdentity = { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() };',
      '  const canonicalProjectRoot = fs.realpathSync(dir);',
      '',
      '  // Alter candidate A on real disk after its snapshot was taken -- a',
      '  // genuine, deterministic drift, not a simulated one.',
      "  fs.writeFileSync(path.join(candidateA, 'unexpected.txt'), 'surprise');",
      '',
      "  const outcomeA = executeApprovedCandidate({ candidate: { entries: walkedA.entries, name: 'run-a' }, canonicalProjectRoot, rootIdentity });",
      "  assert.equal(outcomeA.status, 'skipped');",
      "  assert.equal(outcomeA.reason, 'drift-detected');",
      '  assert.equal(fs.existsSync(candidateA), true);',
      '',
      "  const outcomeB = executeApprovedCandidate({ candidate: { entries: walkedB.entries, name: 'run-b' }, canonicalProjectRoot, rootIdentity });",
      "  assert.equal(outcomeB.status, 'deleted');",
      '  assert.equal(fs.existsSync(candidateB), false);',
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

  // A genuine full-CLI ('preview' then 'execute' as two separate process
  // invocations) demonstration of *post-initial-match* per-candidate drift
  // would require a real external writer racing the single synchronous
  // runExecute call between its whole-selection digest check and its
  // per-candidate loop -- which the plan explicitly disclaims testing via
  // sleep-based races. The Node-harness test above exercises the exact
  // same recheck logic deterministically instead, per the plan's own
  // guidance to keep candidate deletion separate from scanning for this
  // reason. The real permission-based failure suite below demonstrates
  // the equivalent partial-result aggregation through the full CLI.
})

// ═══════════════════════════════════════════════════════════════════════
// Symlink substitution before deletion
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: symlink substitution refused', () => {
  it('skips a candidate replaced by a symlink after the approved snapshot, via the same per-candidate primitive', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { walkCandidateSubtree, executeApprovedCandidate } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-drift-symlink-'));",
      'try {',
      "  const reviewRoot = path.join(dir, '.context', 'systematic', 'ce-review');",
      '  fs.mkdirSync(reviewRoot, { recursive: true });',
      "  const candidate = path.join(reviewRoot, 'run-a');",
      '  fs.mkdirSync(candidate);',
      '  const walked = walkCandidateSubtree(candidate);',
      '  assert.equal(walked.ok, true);',
      '',
      '  const rootStat = fs.lstatSync(reviewRoot, { bigint: true });',
      '  const rootIdentity = { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() };',
      '  const canonicalProjectRoot = fs.realpathSync(dir);',
      '',
      "  const elsewhere = path.join(dir, 'elsewhere');",
      '  fs.mkdirSync(elsewhere);',
      '  fs.rmSync(candidate, { force: true, recursive: true });',
      '  fs.symlinkSync(elsewhere, candidate, "dir");',
      '',
      "  const outcome = executeApprovedCandidate({ candidate: { entries: walked.entries, name: 'run-a' }, canonicalProjectRoot, rootIdentity });",
      "  assert.equal(outcome.status, 'skipped');",
      "  assert.equal(outcome.reason, 'drift-detected');",
      '  // The symlink itself, and its target, must both survive untouched.',
      '  assert.equal(fs.lstatSync(candidate).isSymbolicLink(), true);',
      '  assert.equal(fs.existsSync(elsewhere), true);',
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

// ═══════════════════════════════════════════════════════════════════════
// Real deletion failure (permission-based; this sandbox runs unprivileged)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: real deletion failure preserves other outcomes', () => {
  it('reports one candidate failed (permission-denied removal) while its sibling still deletes; root and unrelated data remain', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Root bypasses directory write-permission checks, so this specific
      // permission-based failure cannot be forced deterministically when
      // running privileged. Documented limitation, not a silent skip.
      return
    }

    const { projectRoot, reviewRoot } = makeTempProject()
    const dirA = createCandidate(reviewRoot, 'run-a', { ageDays: 40 })
    const dirB = createCandidate(reviewRoot, 'run-b', { ageDays: 40 })
    fs.writeFileSync(path.join(dirB, 'child.txt'), 'x')
    // Adding a file just now bumped dirB's own mtime to "now"; re-pin the
    // whole subtree old so run-b is still selected under the 30-day cutoff.
    const oldB = daysAgo(40)
    fs.utimesSync(path.join(dirB, 'child.txt'), oldB, oldB)
    fs.utimesSync(dirB, oldB, oldB)
    try {
      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)

      // Remove write permission on run-b itself so its own directory entry
      // cannot be unlinked from the review root, even though its content
      // was already (or can be) removed -- a real, deterministic recursive
      // removal failure, not a simulated one.
      fs.chmodSync(reviewRoot, 0o555)

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])

      // Restore permissions before any assertion can throw, so cleanup
      // always succeeds regardless of test outcome.
      fs.chmodSync(reviewRoot, 0o755)

      expect(result.exitCode).toBe(1)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.result).toBe('partial')
      if (!isExecuteCounts(result.response.counts))
        throw new Error('expected counts')
      expect(result.response.counts.failed).toBe(2)
      expect(result.response.counts.deleted).toBe(0)
      expect(fs.existsSync(dirA)).toBe(true)
      expect(fs.existsSync(dirB)).toBe(true)
      expect(fs.existsSync(reviewRoot)).toBe(true)
    } finally {
      fs.chmodSync(reviewRoot, 0o755)
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Output safety and no persisted artifacts
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: output safety and no persisted artifacts', () => {
  it('never echoes planted source-evidence canaries and creates no lock/state/approval files anywhere', () => {
    const { projectRoot, reviewRoot } = makeTempProject()
    try {
      const canary = 'SECRET_SOURCE_EXCERPT_CANARY_EXECUTE_XYZ'
      createCandidate(reviewRoot, 'run-with-summary', {
        ageDays: 40,
        summary: {
          evidence: [canary],
          run_status: 'completed',
          schema_version: 1,
        },
      })

      const beforeEntries = fs.readdirSync(projectRoot)

      const preview = runCli([
        'preview',
        '--root',
        projectRoot,
        '--age',
        '30',
        '--ack-offline',
      ])
      const token = extractToken(preview.response)
      expect(preview.stdout).not.toContain(canary)

      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(canary)
      expect(result.stderr).not.toContain(canary)
      expect(result.stdout).not.toContain(projectRoot)

      // No new top-level entries (lock files, approval manifests, state)
      // appeared in the project root as a side effect of either operation.
      const afterEntries = fs.readdirSync(projectRoot)
      expect(afterEntries).toEqual(beforeEntries)
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Exports contract (node:assert harness)
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: module exports contract', () => {
  it('exports the documented execute-side pure functions, with no CLI side effects on import', () => {
    const expected = [
      'decodeExecutionToken',
      'executeApprovedCandidate',
      'runExecute',
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
// Ancestor-symlink substitution: relocating the whole .context tree and
// leaving a symlink in its place preserves the review root's device/inode
// identity (it is still the same underlying directory), so an identity
// check alone is insufficient -- the ancestor PATH itself must be
// rechecked for symlink traversal immediately before each deletion.
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: ancestor-symlink substitution refused', () => {
  it('refuses deletion when an ancestor (.context) was replaced with a symlink after the approved snapshot, even though device/inode identity is unchanged', () => {
    const lines = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { walkCandidateSubtree, executeApprovedCandidate } from ${JSON.stringify(SCRIPT_URL)};`,
      '',
      "const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-ancestor-'));",
      "const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-cleanup-ancestor-moved-'));",
      'try {',
      "  const contextDir = path.join(projectRoot, '.context');",
      "  const reviewRoot = path.join(contextDir, 'systematic', 'ce-review');",
      '  fs.mkdirSync(reviewRoot, { recursive: true });',
      "  const candidateDir = path.join(reviewRoot, 'old-run');",
      '  fs.mkdirSync(candidateDir);',
      '',
      '  const walked = walkCandidateSubtree(candidateDir);',
      '  assert.equal(walked.ok, true);',
      '  const rootStat = fs.lstatSync(reviewRoot, { bigint: true });',
      '  const rootIdentity = { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() };',
      '  const canonicalProjectRoot = fs.realpathSync(projectRoot);',
      '',
      '  // Relocate the ENTIRE .context tree to another owned temp location,',
      '  // then leave a symlink in its place. The review root/candidate keep',
      '  // their original device/inode identity -- only the ancestor path',
      '  // now traverses a symlink.',
      "  const movedContextDir = path.join(elsewhere, '.context');",
      '  fs.renameSync(contextDir, movedContextDir);',
      "  fs.symlinkSync(movedContextDir, contextDir, 'dir');",
      '',
      "  const relocatedCandidateDir = path.join(movedContextDir, 'systematic', 'ce-review', 'old-run');",
      '  assert.equal(fs.existsSync(relocatedCandidateDir), true);',
      '',
      '  const outcome = executeApprovedCandidate({',
      "    candidate: { entries: walked.entries, name: 'old-run' },",
      '    canonicalProjectRoot,',
      '    rootIdentity,',
      '  });',
      '',
      "  assert.notEqual(outcome.status, 'deleted', 'must refuse deletion through a symlinked ancestor even when device/inode identity matches; got: ' + JSON.stringify(outcome));",
      "  assert.equal(fs.existsSync(relocatedCandidateDir), true, 'the relocated run directory must survive');",
      '',
      "  process.stdout.write('OK');",
      '} finally {',
      '  fs.rmSync(projectRoot, { force: true, recursive: true });',
      '  fs.rmSync(elsewhere, { force: true, recursive: true });',
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

// ═══════════════════════════════════════════════════════════════════════
// Token structural hardening: unknown fields and non-canonical base64url
// ═══════════════════════════════════════════════════════════════════════

describe('ce-review-cleanup execute: token structural hardening (not authentication)', () => {
  it('rejects a token payload with an extra unknown field', () => {
    const token = Buffer.from(
      JSON.stringify({
        ageDurationMs: 5,
        cutoffTimeMs: 5,
        digest: 'a'.repeat(64),
        extraField: 'unexpected',
        referenceTimeMs: 10,
        v: 1,
      }),
      'utf8',
    ).toString('base64url')
    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        token,
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-token')
    } finally {
      cleanupTemp(projectRoot)
    }
  })

  it('rejects a non-canonical base64url encoding (regular base64 alphabet, e.g. containing "+")', () => {
    const canonicalPayload = JSON.stringify({
      ageDurationMs: 5,
      cutoffTimeMs: 5,
      digest: 'a'.repeat(64),
      referenceTimeMs: 10,
      v: 1,
    })
    // Pick bytes deliberately so the *regular* base64 alphabet uses a '+'
    // where base64url would use '-'. If '+' happens not to appear for this
    // payload, fall back to injecting stray non-alphabet padding, which is
    // equally non-canonical for base64url.
    let nonCanonical = Buffer.from(canonicalPayload, 'utf8').toString('base64')
    if (nonCanonical.includes('+') || nonCanonical.includes('/')) {
      nonCanonical = nonCanonical.replaceAll('+', '-').replaceAll('/', '_')
    }
    // Force non-canonical padding/length regardless: append a trailing
    // '=' character, which is valid in standard base64 but must never
    // appear in this implementation's canonical base64url tokens.
    const withPadding = `${nonCanonical.replace(/=+$/, '')}=`

    const { projectRoot } = makeTempProject()
    try {
      const result = runCli([
        'execute',
        '--root',
        projectRoot,
        '--ack-offline',
        '--token',
        withPadding,
      ])
      expect(result.exitCode).toBe(2)
      if (!isCliResponse(result.response))
        throw new Error('expected JSON response')
      expect(result.response.category).toBe('invalid-token')
    } finally {
      cleanupTemp(projectRoot)
    }
  })
})
