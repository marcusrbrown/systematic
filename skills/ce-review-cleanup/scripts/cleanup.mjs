#!/usr/bin/env node

// Read-only preview scanner for historical `ce:review` run directories.
//
// This helper NEVER mutates the filesystem. It resolves a caller-supplied
// project root, canonicalizes it, and walks direct child directories of
// `.context/systematic/ce-review` to report which are older than a
// caller-supplied age cutoff. Deletion (`execute`) is a separate operation
// implemented in a later unit; invoking it here is explicitly refused rather
// than silently falling back to a preview.
//
// Usage:
//   node cleanup.mjs preview --root <path> --age <Nd|Nw|N> --ack-offline
//   node cleanup.mjs execute ...   (refused: not yet implemented)
//
// Output: a single bounded JSON object on stdout. No absolute paths, nested
// relative paths, subprocess errors, or artifact contents are ever emitted --
// only fixed diagnostic categories, bounded/JSON-escaped run names, and
// hash-derived display ids.

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── Constants ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1
const TOKEN_VERSION = 1
const MAX_DEPTH = 32
const MAX_ENTRIES = 10_000
const MAX_SUMMARY_BYTES = 1 * 1024 * 1024 // 1 MiB
const MAX_NAME_LENGTH = 200
const REVIEW_ROOT_SEGMENTS = ['.context', 'systematic', 'ce-review']
const SUMMARY_FILE_NAME = 'review-summary.json'
const KNOWN_RUN_STATUSES = new Set([
  'in_progress',
  'completed',
  'degraded',
  'abnormal',
])

// Fixed diagnostic categories. Never combine with dynamic/raw text.
const CATEGORY = Object.freeze({
  EXECUTE_NOT_IMPLEMENTED: 'execute-not-implemented',
  INVALID_AGE: 'invalid-age',
  INVALID_ROOT: 'invalid-root',
  MISSING_ACKNOWLEDGMENT: 'missing-acknowledgment',
  MISSING_AGE: 'missing-age',
  MISSING_ROOT: 'missing-root-argument',
  ROOT_ENUMERATION_FAILED: 'root-enumeration-failed',
  UNKNOWN_OPERATION: 'unknown-operation',
  UNSAFE_REVIEW_ROOT: 'unsafe-review-root',
})

// ── Pure helpers (exported for deterministic Node subprocess tests) ────────

/**
 * Parses a positive-integer age cutoff, optionally suffixed with `d` (days,
 * default) or `w` (weeks). Rejects zero, decimals, negative values,
 * malformed text, and arithmetic that would overflow a safe integer.
 * @param {unknown} input
 * @returns {{ days: number, ms: number } | undefined}
 */
export function parseAgeCutoff(input) {
  if (typeof input !== 'string') return undefined
  const match = /^([1-9]\d*)([dw]?)$/.exec(input.trim())
  if (!match) return undefined
  const amount = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined
  const unit = match[2] || 'd'
  const days = unit === 'w' ? amount * 7 : amount
  if (!Number.isSafeInteger(days) || days <= 0) return undefined
  const ms = days * 86_400_000
  if (!Number.isSafeInteger(ms) || ms <= 0) return undefined
  return { days, ms }
}

/**
 * Computes the absolute cutoff time (ms since epoch): candidates whose
 * maximum modification time is strictly earlier than this are eligible.
 * @param {number} referenceTimeMs
 * @param {number} ageDurationMs
 * @returns {number}
 */
export function computeCutoffTimeMs(referenceTimeMs, ageDurationMs) {
  return referenceTimeMs - ageDurationMs
}

/**
 * Truncates a name to a fixed maximum length so a single pathological entry
 * cannot produce unbounded output. JSON.stringify still escapes any control
 * characters the truncated name contains.
 * @param {string} name
 * @param {number} [maxLength]
 * @returns {string}
 */
export function boundedName(name, maxLength = MAX_NAME_LENGTH) {
  if (name.length <= maxLength) return name
  return `${name.slice(0, maxLength)}…`
}

/**
 * Widens a fixed starting prefix length across a set of already-computed
 * hex digests until every prefix is unique (or the full digest length is
 * reached). Pure and digest-agnostic so tests can exercise the widening
 * logic directly with synthetic digests, without needing to engineer a
 * real SHA-256 collision.
 * @param {readonly string[]} hexDigests
 * @param {{ startLength?: number, step?: number, maxLength?: number }} [options]
 * @returns {string[]} prefixes in the same order as the input digests
 */
export function widenUniquePrefixes(hexDigests, options = {}) {
  const startLength = options.startLength ?? 8
  const step = options.step ?? 4
  const maxLength = options.maxLength ?? 64
  let prefixLen = startLength
  for (; prefixLen < maxLength; prefixLen += step) {
    const prefixes = hexDigests.map((h) => h.slice(0, prefixLen))
    if (new Set(prefixes).size === prefixes.length) return prefixes
  }
  return hexDigests.map((h) => h.slice(0, maxLength))
}

/**
 * Derives a bounded, collision-resistant display id for each name without
 * the id itself revealing the underlying name (the name is still reported
 * separately, bounded and JSON-escaped).
 * @param {readonly string[]} names
 * @returns {Map<string, string>} name -> displayId
 */
export function deriveDisplayIds(names) {
  const fullHashes = names.map((name) =>
    createHash('sha256').update(name, 'utf8').digest('hex'),
  )
  const prefixes = widenUniquePrefixes(fullHashes)
  const result = new Map()
  names.forEach((name, i) => {
    result.set(name, prefixes[i])
  })
  return result
}

/**
 * Builds a versioned, bounded preview token. The token carries the fixed
 * reference time, normalized age duration, absolute cutoff, and a digest of
 * the scanned snapshot -- all recoverable without external state. It is not
 * proof of human approval; the skill must still ask separately.
 * @param {{ referenceTimeMs: number, ageDurationMs: number, cutoffTimeMs: number, digest: string }} fields
 * @returns {string}
 */
export function buildPreviewToken(fields) {
  const payload = {
    ageDurationMs: fields.ageDurationMs,
    cutoffTimeMs: fields.cutoffTimeMs,
    digest: fields.digest,
    referenceTimeMs: fields.referenceTimeMs,
    v: TOKEN_VERSION,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

// ── Filesystem-safe path resolution ─────────────────────────────────────────

/**
 * Walks a fixed sequence of path segments below a trusted canonical root,
 * refusing any symlink or non-directory component. Returns 'missing' the
 * moment a segment does not exist (never created), 'symlink' or
 * 'not-directory' if an existing segment is unsafe, or 'ok' with the final
 * resolved absolute path.
 * @param {string} canonicalRoot
 * @param {readonly string[]} segments
 */
function resolveSegmentChain(canonicalRoot, segments) {
  let current = canonicalRoot
  for (const segment of segments) {
    current = join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      return { status: 'missing' }
    }
    if (stat.isSymbolicLink()) return { status: 'symlink' }
    if (!stat.isDirectory()) return { status: 'not-directory' }
  }
  return { path: current, status: 'ok' }
}

// ── Per-entry stat (reusable by Unit 3's per-candidate rescan) ──────────────

/**
 * Lstats a single path and classifies it. Never follows symlinks. This is
 * the single point of "real filesystem truth" the walker and any future
 * rescan share -- calling it against a missing or replaced path produces a
 * genuine, deterministic lstat failure, not a simulated one.
 * @param {string} absPath
 * @returns {{ ok: true, type: 'file' | 'directory', dev: string, ino: string, mode: string, size: string, mtimeNs: string, ctimeNs: string } | { ok: false, reason: 'unreadable' | 'symlink' | 'special-file' }}
 */
export function statSnapshotEntry(absPath) {
  let stat
  try {
    stat = lstatSync(absPath, { bigint: true })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' }
  let type
  if (stat.isDirectory()) type = 'directory'
  else if (stat.isFile()) type = 'file'
  else return { ok: false, reason: 'special-file' }

  return {
    ctimeNs: stat.ctimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ok: true,
    size: stat.size.toString(),
    type,
  }
}

// ── Candidate subtree walk ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   relativePath: string,
 *   type: 'file' | 'directory',
 *   dev: string,
 *   ino: string,
 *   mode: string,
 *   size: string,
 *   mtimeNs: string,
 *   ctimeNs: string,
 * }} SnapshotEntry
 */

/**
 * Recursively lstats a candidate directory and every descendant via
 * {@link statSnapshotEntry}, rejecting the whole candidate on any symlink,
 * special file, unreadable entry, or traversal bound violation.
 *
 * The subtree's maximum modification time is tracked as a BigInt count of
 * nanoseconds, not a float. Epoch nanosecond values exceed float64's exact
 * integer range (2^53), so converting through `Number` before comparing
 * would introduce rounding noise large enough to flip a strict
 * older-than-cutoff comparison at exact-boundary inputs.
 * @param {string} candidateAbsPath
 * @returns {{ ok: true, entries: SnapshotEntry[], maxMtimeNs: bigint | null } | { ok: false, reason: string }}
 */
export function walkCandidateSubtree(candidateAbsPath) {
  /** @type {SnapshotEntry[]} */
  const entries = []
  /** @type {bigint | null} */
  let maxMtimeNs = null
  let count = 0

  /**
   * @param {string} absPath
   * @param {string} relPath
   * @param {number} depth
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function visit(absPath, relPath, depth) {
    if (depth > MAX_DEPTH) return { ok: false, reason: 'depth-limit' }

    const stat = statSnapshotEntry(absPath)
    if (!stat.ok) return { ok: false, reason: stat.reason }

    count += 1
    if (count > MAX_ENTRIES) return { ok: false, reason: 'entry-limit' }

    const mtimeNs = BigInt(stat.mtimeNs)
    if (maxMtimeNs === null || mtimeNs > maxMtimeNs) {
      maxMtimeNs = mtimeNs
    }

    const { ok: _statOk, ...meta } = stat
    entries.push({ ...meta, relativePath: relPath })

    if (stat.type === 'directory') {
      let children
      try {
        children = readdirSync(absPath, { withFileTypes: true })
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
      for (const child of children) {
        const childRel =
          relPath === '' ? child.name : `${relPath}/${child.name}`
        const result = visit(join(absPath, child.name), childRel, depth + 1)
        if (!result.ok) return result
      }
    }

    return { ok: true }
  }

  const outcome = visit(candidateAbsPath, '', 0)
  if (!outcome.ok) return { ok: false, reason: outcome.reason }

  entries.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  )

  return {
    entries,
    maxMtimeNs,
    ok: true,
  }
}

// ── Status label projection ─────────────────────────────────────────────────

/**
 * Derives a bounded status label from the CURRENT summary file, not the
 * walked snapshot's cached size/type -- only identity-corroborated content
 * up to MAX_SUMMARY_BYTES is ever parsed.
 *
 * Checks, in order: path-level lstat rejects non-regular/symlink before
 * open; O_NOFOLLOW (where the platform defines it) is a second, defense-in-
 * depth barrier against a symlink, not the sole protection; the opened fd's
 * identity (dev/ino) must match both the pre-open lstat and the walked
 * snapshot's recorded identity, or the file was replaced since the walk and
 * the label is `unknown`; after the bounded read, the path is re-lstat'd
 * and must still match the fd's identity.
 *
 * This narrows ordinary stale-state drift (a file resized, replaced, or
 * symlinked between the walk and this call). It is not an atomic guarantee
 * against an adversarial writer racing every check.
 * @param {string} candidateAbsPath
 * @param {readonly SnapshotEntry[]} entries
 * @returns {'in_progress' | 'completed' | 'degraded' | 'abnormal' | 'legacy' | 'artifactless' | 'unknown'}
 */
export function deriveStatusLabel(candidateAbsPath, entries) {
  const summaryEntry = entries.find((e) => e.relativePath === SUMMARY_FILE_NAME)
  if (!summaryEntry) return 'artifactless'

  const summaryPath = join(candidateAbsPath, SUMMARY_FILE_NAME)

  let pathStat
  try {
    pathStat = lstatSync(summaryPath, { bigint: true })
  } catch {
    return 'unknown'
  }
  if (!pathStat.isFile()) return 'unknown'

  const openFlags =
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)

  let fd
  try {
    fd = openSync(summaryPath, openFlags)
  } catch {
    return 'unknown'
  }

  try {
    let fdStat
    try {
      fdStat = fstatSync(fd, { bigint: true })
    } catch {
      return 'unknown'
    }
    if (!fdStat.isFile()) return 'unknown'

    const identityMatches =
      fdStat.dev === pathStat.dev &&
      fdStat.ino === pathStat.ino &&
      fdStat.dev.toString() === summaryEntry.dev &&
      fdStat.ino.toString() === summaryEntry.ino
    if (!identityMatches) return 'unknown'

    if (fdStat.size > BigInt(MAX_SUMMARY_BYTES)) return 'unknown'

    const size = Number(fdStat.size)
    const buffer = Buffer.alloc(size)
    let readTotal = 0
    while (readTotal < buffer.length) {
      const bytesRead = readSync(
        fd,
        buffer,
        readTotal,
        buffer.length - readTotal,
        readTotal,
      )
      if (bytesRead <= 0) break
      readTotal += bytesRead
    }
    const raw = buffer.subarray(0, readTotal).toString('utf8')

    let postStat
    try {
      postStat = lstatSync(summaryPath, { bigint: true })
    } catch {
      return 'unknown'
    }
    if (postStat.dev !== fdStat.dev || postStat.ino !== fdStat.ino) {
      return 'unknown'
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return 'unknown'
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return 'unknown'
    }
    if (!Object.hasOwn(parsed, 'schema_version')) return 'legacy'

    const status = parsed.run_status
    if (typeof status === 'string' && KNOWN_RUN_STATUSES.has(status)) {
      return status
    }
    return 'unknown'
  } finally {
    closeSync(fd)
  }
}

// ── Digest ───────────────────────────────────────────────────────────────

/**
 * Hashes a canonical serialization of the root identity, direct-child
 * inventory, and every selected candidate's full sorted metadata. Aggregate
 * max-mtime/count alone would miss same-count replacements and changes
 * beneath an unchanged maximum timestamp, so the full snapshot is bound.
 * @param {{ dev: string, ino: string }} rootIdentity
 * @param {readonly { name: string, type: string }[]} directChildren
 * @param {readonly { name: string, entries: readonly SnapshotEntry[] }[]} selectedCandidates
 * @returns {string}
 */
export function computeSnapshotDigest(
  rootIdentity,
  directChildren,
  selectedCandidates,
) {
  const structure = {
    directChildren: [...directChildren]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => ({ name: c.name, type: c.type })),
    root: rootIdentity,
    selectedCandidates: [...selectedCandidates]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => ({ entries: c.entries, name: c.name })),
    v: TOKEN_VERSION,
  }
  return createHash('sha256')
    .update(JSON.stringify(structure), 'utf8')
    .digest('hex')
}

// ── Preview operation ────────────────────────────────────────────────────

/**
 * @typedef {{
 *   root: string | undefined,
 *   age: string | undefined,
 *   ackOffline: boolean,
 *   referenceTimeMs: number,
 * }} PreviewOptions
 */

/**
 * @param {string} category
 * @returns {{ exitCode: number, response: Record<string, unknown> }}
 */
function errorResult(category) {
  return {
    exitCode: 2,
    response: {
      category,
      operation: 'preview',
      result: 'error',
      schema_version: SCHEMA_VERSION,
    },
  }
}

/**
 * Executes the read-only preview scan. Pure with respect to time (the
 * reference time is an explicit input), so tests can exercise exact-cutoff
 * and future-timestamp scenarios deterministically without sleeping.
 * @param {PreviewOptions} options
 * @returns {{ exitCode: number, response: Record<string, unknown> }}
 */
export function runPreview(options) {
  if (!options.ackOffline) {
    return errorResult(CATEGORY.MISSING_ACKNOWLEDGMENT)
  }

  if (options.age === undefined) {
    return errorResult(CATEGORY.MISSING_AGE)
  }
  const ageCutoff = parseAgeCutoff(options.age)
  if (!ageCutoff) {
    return errorResult(CATEGORY.INVALID_AGE)
  }

  if (!options.root) {
    return errorResult(CATEGORY.MISSING_ROOT)
  }

  let canonicalRoot
  try {
    canonicalRoot = realpathSync(options.root)
    if (!lstatSync(canonicalRoot).isDirectory()) {
      return errorResult(CATEGORY.INVALID_ROOT)
    }
  } catch {
    return errorResult(CATEGORY.INVALID_ROOT)
  }

  const chain = resolveSegmentChain(canonicalRoot, REVIEW_ROOT_SEGMENTS)
  if (chain.status === 'missing') {
    return {
      exitCode: 0,
      response: {
        operation: 'preview',
        result: 'root-missing',
        schema_version: SCHEMA_VERSION,
      },
    }
  }
  if (chain.status !== 'ok') {
    return errorResult(CATEGORY.UNSAFE_REVIEW_ROOT)
  }
  const reviewRoot = chain.path

  let rootStat
  let directEntries
  try {
    rootStat = lstatSync(reviewRoot, { bigint: true })
    directEntries = readdirSync(reviewRoot, { withFileTypes: true })
  } catch {
    return errorResult(CATEGORY.ROOT_ENUMERATION_FAILED)
  }

  const referenceTimeMs = options.referenceTimeMs
  const cutoffTimeMs = computeCutoffTimeMs(referenceTimeMs, ageCutoff.ms)
  // Comparisons happen in nanosecond BigInt space (see walkCandidateSubtree)
  // to avoid float64 precision loss at exact-boundary inputs.
  const referenceTimeNs = BigInt(referenceTimeMs) * 1_000_000n
  const cutoffTimeNs = BigInt(cutoffTimeMs) * 1_000_000n

  /** @type {{ name: string, type: string }[]} */
  const directChildren = []
  /** @type {string[]} */
  const candidateDirNames = []
  /** @type {{ name: string; reason: string }[]} */
  const skippedUnknownUnsafe = []

  for (const dirent of directEntries) {
    if (dirent.isSymbolicLink()) {
      directChildren.push({ name: dirent.name, type: 'symlink' })
      skippedUnknownUnsafe.push({ name: dirent.name, reason: 'symlink' })
      continue
    }
    if (dirent.isDirectory()) {
      directChildren.push({ name: dirent.name, type: 'directory' })
      candidateDirNames.push(dirent.name)
      continue
    }
    // Non-directory administrative entries (e.g. .gitignore) are neither
    // candidates nor reported, but still bound into the digest below.
    directChildren.push({ name: dirent.name, type: 'other' })
  }

  /** @type {{ name: string; label: string; lastModifiedMs: number }[]} */
  const selected = []
  /** @type {{ name: string; label: string; lastModifiedMs: number }[]} */
  const excludedRecent = []
  /** @type {{ name: string; entries: SnapshotEntry[] }[]} */
  const selectedSnapshots = []

  for (const name of candidateDirNames) {
    const candidateAbsPath = join(reviewRoot, name)
    const walked = walkCandidateSubtree(candidateAbsPath)
    if (!walked.ok) {
      skippedUnknownUnsafe.push({ name, reason: walked.reason })
      continue
    }

    const { maxMtimeNs } = walked
    if (maxMtimeNs === null) {
      skippedUnknownUnsafe.push({ name, reason: 'invalid-timestamp' })
      continue
    }
    if (maxMtimeNs > referenceTimeNs) {
      skippedUnknownUnsafe.push({ name, reason: 'future-timestamp' })
      continue
    }

    const label = deriveStatusLabel(candidateAbsPath, walked.entries)
    // Safe: epoch milliseconds (~1.7e12) are far below float64's exact
    // integer range, unlike the raw nanosecond value above.
    const lastModifiedMs = Number(maxMtimeNs / 1_000_000n)

    if (maxMtimeNs < cutoffTimeNs) {
      selected.push({ label, lastModifiedMs, name })
      selectedSnapshots.push({ entries: walked.entries, name })
    } else {
      excludedRecent.push({ label, lastModifiedMs, name })
    }
  }

  const allNames = [
    ...selected.map((c) => c.name),
    ...excludedRecent.map((c) => c.name),
    ...skippedUnknownUnsafe.map((c) => c.name),
  ]
  const displayIds = deriveDisplayIds(allNames)

  const digest = computeSnapshotDigest(
    { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() },
    directChildren,
    selectedSnapshots,
  )

  const token =
    selected.length > 0
      ? buildPreviewToken({
          ageDurationMs: ageCutoff.ms,
          cutoffTimeMs,
          digest,
          referenceTimeMs,
        })
      : null

  const result = selected.length === 0 ? 'nothing-eligible' : 'preview'

  return {
    exitCode: 0,
    response: {
      candidates: {
        excludedRecent: excludedRecent.map((c) => ({
          displayId: displayIds.get(c.name),
          label: c.label,
          lastModified: new Date(c.lastModifiedMs).toISOString(),
          name: boundedName(c.name),
        })),
        selected: selected.map((c) => ({
          displayId: displayIds.get(c.name),
          label: c.label,
          lastModified: new Date(c.lastModifiedMs).toISOString(),
          name: boundedName(c.name),
        })),
        skippedUnknownUnsafe: skippedUnknownUnsafe.map((c) => ({
          displayId: displayIds.get(c.name),
          name: boundedName(c.name),
          reason: c.reason,
        })),
      },
      counts: {
        excludedRecent: excludedRecent.length,
        selected: selected.length,
        skippedUnknownUnsafe: skippedUnknownUnsafe.length,
      },
      cutoff: new Date(cutoffTimeMs).toISOString(),
      operation: 'preview',
      referenceTime: new Date(referenceTimeMs).toISOString(),
      result,
      schema_version: SCHEMA_VERSION,
      token,
    },
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────

/**
 * @param {readonly string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function getFlag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : undefined
}

function main() {
  const argv = process.argv.slice(2)
  const operation = argv[0]
  const rest = argv.slice(1)

  if (operation === 'execute') {
    emitAndExit(errorResult(CATEGORY.EXECUTE_NOT_IMPLEMENTED), 'execute')
    return
  }

  if (operation !== 'preview') {
    emitAndExit(errorResult(CATEGORY.UNKNOWN_OPERATION), operation)
    return
  }

  const root = getFlag(rest, '--root')
  const age = getFlag(rest, '--age')
  const ackOffline = rest.includes('--ack-offline')

  const outcome = runPreview({
    ackOffline,
    age,
    referenceTimeMs: Date.now(),
    root,
  })
  process.stdout.write(`${JSON.stringify(outcome.response)}\n`)
  process.exit(outcome.exitCode)
}

/**
 * @param {{ exitCode: number, response: Record<string, unknown> }} outcome
 * @param {string | undefined} operation
 */
function emitAndExit(outcome, operation) {
  const response = { ...outcome.response, operation: operation ?? null }
  process.stdout.write(`${JSON.stringify(response)}\n`)
  process.exit(outcome.exitCode)
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectInvocation) {
  main()
}
