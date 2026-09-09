#!/usr/bin/env node

// Preview and snapshot-bound deletion scanner for historical `ce:review`
// run directories.
//
// `preview` never mutates the filesystem: it resolves a caller-supplied
// project root, canonicalizes it, and walks direct child directories of
// `.context/systematic/ce-review` to report which are older than a
// caller-supplied age cutoff, returning a bounded token over that scan.
//
// `execute` deletes only the exact candidates the token was built from. It
// rescans using the token's own fixed time boundary (never "now"), and
// deletes nothing at all if that rescan's digest no longer matches the
// token -- a changed root, changed membership, or changed candidate
// invalidates the whole approval. A token is not proof of human consent;
// the caller (a skill) must still ask separately before invoking execute.
//
// Usage:
//   node cleanup.mjs preview --root <path> --age <Nd|Nw|N> --ack-offline
//   node cleanup.mjs execute --root <path> --ack-offline --token <token>
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
  rmSync,
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
  INVALID_AGE: 'invalid-age',
  INVALID_ARGUMENTS: 'invalid-arguments',
  INVALID_ROOT: 'invalid-root',
  INVALID_TOKEN: 'invalid-token',
  MISSING_ACKNOWLEDGMENT: 'missing-acknowledgment',
  MISSING_AGE: 'missing-age',
  MISSING_ROOT: 'missing-root-argument',
  MISSING_TOKEN: 'missing-token',
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

// ── Shared scan core (used by both preview and execute) ────────────────────

/**
 * @typedef {{
 *   ok: true,
 *   rootIdentity: { dev: string, ino: string },
 *   directChildren: { name: string, type: string }[],
 *   selected: { name: string, label: string, lastModifiedMs: number, entries: SnapshotEntry[] }[],
 *   excludedRecent: { name: string, label: string, lastModifiedMs: number }[],
 *   skippedUnknownUnsafe: { name: string, reason: string }[],
 * } | { ok: false, category: string }} ScanResult
 */

/**
 * Enumerates direct children of an already-resolved, already-safety-checked
 * review root and classifies every candidate directory by age and status.
 * Both `runPreview` and `runExecute` call this so their selection logic can
 * never drift apart; `runExecute` passes the token's fixed `cutoffTimeMs`
 * and `referenceTimeMs` instead of the current wall clock, so elapsed real
 * time cannot silently expand or shrink the approved set -- any actual
 * difference in the underlying tree shows up as a digest mismatch instead.
 * @param {string} reviewRoot
 * @param {number} cutoffTimeMs
 * @param {number} referenceTimeMs
 * @returns {ScanResult}
 */
function scanReviewRoot(reviewRoot, cutoffTimeMs, referenceTimeMs) {
  let rootStat
  let directEntries
  try {
    rootStat = lstatSync(reviewRoot, { bigint: true })
    directEntries = readdirSync(reviewRoot, { withFileTypes: true })
  } catch {
    return { category: CATEGORY.ROOT_ENUMERATION_FAILED, ok: false }
  }

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

  /** @type {{ name: string; label: string; lastModifiedMs: number; entries: SnapshotEntry[] }[]} */
  const selected = []
  /** @type {{ name: string; label: string; lastModifiedMs: number }[]} */
  const excludedRecent = []

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
      selected.push({ entries: walked.entries, label, lastModifiedMs, name })
    } else {
      excludedRecent.push({ label, lastModifiedMs, name })
    }
  }

  return {
    directChildren,
    excludedRecent,
    ok: true,
    rootIdentity: {
      dev: rootStat.dev.toString(),
      ino: rootStat.ino.toString(),
    },
    selected,
    skippedUnknownUnsafe,
  }
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
 * @param {string} operation
 * @param {string} category
 * @returns {{ exitCode: number, response: Record<string, unknown> }}
 */
function errorResultFor(operation, category) {
  return {
    exitCode: 2,
    response: {
      category,
      operation,
      result: 'error',
      schema_version: SCHEMA_VERSION,
    },
  }
}

/**
 * Resolves a caller-supplied project root to the canonical, symlink-free
 * review root, shared by preview and execute.
 * @param {string | undefined} rootArg
 * @returns {{ status: 'ok', path: string } | { status: 'missing' } | { status: 'invalid-root' } | { status: 'unsafe' }}
 */
function resolveReviewRoot(rootArg) {
  if (!rootArg) return { status: 'invalid-root' }
  let canonicalRoot
  try {
    canonicalRoot = realpathSync(rootArg)
    if (!lstatSync(canonicalRoot).isDirectory()) {
      return { status: 'invalid-root' }
    }
  } catch {
    return { status: 'invalid-root' }
  }
  const chain = resolveSegmentChain(canonicalRoot, REVIEW_ROOT_SEGMENTS)
  if (chain.status === 'missing') return { status: 'missing' }
  if (chain.status !== 'ok') return { status: 'unsafe' }
  return { canonicalProjectRoot: canonicalRoot, path: chain.path, status: 'ok' }
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
    return errorResultFor('preview', CATEGORY.MISSING_ACKNOWLEDGMENT)
  }

  if (options.age === undefined) {
    return errorResultFor('preview', CATEGORY.MISSING_AGE)
  }
  const ageCutoff = parseAgeCutoff(options.age)
  if (!ageCutoff) {
    return errorResultFor('preview', CATEGORY.INVALID_AGE)
  }

  if (!options.root) {
    return errorResultFor('preview', CATEGORY.MISSING_ROOT)
  }

  const resolved = resolveReviewRoot(options.root)
  if (resolved.status === 'invalid-root') {
    return errorResultFor('preview', CATEGORY.INVALID_ROOT)
  }
  if (resolved.status === 'missing') {
    return {
      exitCode: 0,
      response: {
        operation: 'preview',
        result: 'root-missing',
        schema_version: SCHEMA_VERSION,
      },
    }
  }
  if (resolved.status === 'unsafe') {
    return errorResultFor('preview', CATEGORY.UNSAFE_REVIEW_ROOT)
  }
  const reviewRoot = resolved.path

  const referenceTimeMs = options.referenceTimeMs
  const cutoffTimeMs = computeCutoffTimeMs(referenceTimeMs, ageCutoff.ms)

  const scan = scanReviewRoot(reviewRoot, cutoffTimeMs, referenceTimeMs)
  if (!scan.ok) {
    return errorResultFor('preview', scan.category)
  }

  const allNames = [
    ...scan.selected.map((c) => c.name),
    ...scan.excludedRecent.map((c) => c.name),
    ...scan.skippedUnknownUnsafe.map((c) => c.name),
  ]
  const displayIds = deriveDisplayIds(allNames)

  const digest = computeSnapshotDigest(
    scan.rootIdentity,
    scan.directChildren,
    scan.selected.map((c) => ({ entries: c.entries, name: c.name })),
  )

  const token =
    scan.selected.length > 0
      ? buildPreviewToken({
          ageDurationMs: ageCutoff.ms,
          cutoffTimeMs,
          digest,
          referenceTimeMs,
        })
      : null

  const result = scan.selected.length === 0 ? 'nothing-eligible' : 'preview'

  return {
    exitCode: 0,
    response: {
      candidates: {
        excludedRecent: scan.excludedRecent.map((c) => ({
          displayId: displayIds.get(c.name),
          label: c.label,
          lastModified: new Date(c.lastModifiedMs).toISOString(),
          name: boundedName(c.name),
        })),
        selected: scan.selected.map((c) => ({
          displayId: displayIds.get(c.name),
          label: c.label,
          lastModified: new Date(c.lastModifiedMs).toISOString(),
          name: boundedName(c.name),
        })),
        skippedUnknownUnsafe: scan.skippedUnknownUnsafe.map((c) => ({
          displayId: displayIds.get(c.name),
          name: boundedName(c.name),
          reason: c.reason,
        })),
      },
      counts: {
        excludedRecent: scan.excludedRecent.length,
        selected: scan.selected.length,
        skippedUnknownUnsafe: scan.skippedUnknownUnsafe.length,
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

// ── Execute (deletion) token ─────────────────────────────────────────────

const MAX_TOKEN_LENGTH = 4096

/**
 * Decodes and structurally validates a preview token: correct version,
 * every field present with the expected type, all integers finite/safe,
 * the cutoff/duration/reference-time relationship internally consistent,
 * and the digest shaped like a SHA-256 hex string. Does not check the
 * digest against any scan -- that happens once the review root is known.
 * @param {unknown} token
 * @returns {{ v: number, referenceTimeMs: number, ageDurationMs: number, cutoffTimeMs: number, digest: string } | undefined}
 */
const TOKEN_FIELDS = Object.freeze([
  'v',
  'referenceTimeMs',
  'ageDurationMs',
  'cutoffTimeMs',
  'digest',
])

export function decodeExecutionToken(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  if (token.length > MAX_TOKEN_LENGTH) return undefined

  let decodedBytes
  try {
    decodedBytes = Buffer.from(token, 'base64url')
  } catch {
    return undefined
  }
  // Buffer.from(..., 'base64url') is permissive: it silently drops
  // characters outside the base64url alphabet and tolerates missing
  // padding. Re-encoding the decoded bytes and requiring an exact match
  // rejects any input that is not itself the canonical base64url form.
  if (decodedBytes.toString('base64url') !== token) return undefined

  let parsed
  try {
    parsed = JSON.parse(decodedBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  // Structural guard, not authentication: reject any payload that does not
  // carry exactly the fixed field set (no extra/unknown keys, none absent).
  const keys = Object.keys(parsed)
  if (
    keys.length !== TOKEN_FIELDS.length ||
    !TOKEN_FIELDS.every((field) => keys.includes(field))
  ) {
    return undefined
  }

  const { v, referenceTimeMs, ageDurationMs, cutoffTimeMs, digest } = parsed
  if (v !== TOKEN_VERSION) return undefined
  if (!Number.isSafeInteger(referenceTimeMs) || referenceTimeMs < 0) {
    return undefined
  }
  if (!Number.isSafeInteger(ageDurationMs) || ageDurationMs <= 0) {
    return undefined
  }
  if (!Number.isSafeInteger(cutoffTimeMs)) return undefined
  if (cutoffTimeMs !== referenceTimeMs - ageDurationMs) return undefined
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    return undefined
  }

  return { ageDurationMs, cutoffTimeMs, digest, referenceTimeMs, v }
}

// ── Execute (deletion) per-candidate primitive ──────────────────────────

/**
 * Immediately before removing one previously-approved candidate, re-walks
 * the fixed `.context/systematic/ce-review` segment chain from the
 * canonical project root -- never trusting a previously-resolved review
 * root path string, which could since traverse an ancestor symlink even
 * when the review directory's own device/inode identity is unchanged
 * (e.g. the whole `.context` tree relocated and a symlink left in its
 * place still resolves to the same underlying directory). Also rechecks
 * this candidate's entire subtree against its approved snapshot, then
 * removes only that exact direct-child path -- never a path derived from
 * a display name or supplied by the token.
 *
 * Deliberately does not re-diff the whole root's membership: a caller's
 * own prior deletions earlier in the same batch legitimately change the
 * root's mtime and child list, and re-checking that here would misclassify
 * expected self-induced change as external drift. The ancestor chain,
 * root identity (device/inode, not-a-symlink), and this one candidate's
 * full metadata are the only things rechecked.
 * @param {{ canonicalProjectRoot: string, rootIdentity: { dev: string, ino: string }, candidate: { name: string, entries: SnapshotEntry[] } }} input
 * @returns {{ status: 'deleted' } | { status: 'skipped', reason: string } | { status: 'failed', reason: string }}
 */
export function executeApprovedCandidate({
  canonicalProjectRoot,
  rootIdentity,
  candidate,
}) {
  if (
    !candidate.name ||
    candidate.name === '.' ||
    candidate.name === '..' ||
    candidate.name.includes('/')
  ) {
    return { reason: 'refused-unsafe-name', status: 'failed' }
  }

  const chain = resolveSegmentChain(canonicalProjectRoot, REVIEW_ROOT_SEGMENTS)
  if (chain.status !== 'ok') {
    return { reason: 'root-identity-changed', status: 'failed' }
  }
  const reviewRoot = chain.path

  let freshRootStat
  try {
    freshRootStat = lstatSync(reviewRoot, { bigint: true })
  } catch {
    return { reason: 'root-unavailable', status: 'failed' }
  }
  if (
    freshRootStat.isSymbolicLink() ||
    freshRootStat.dev.toString() !== rootIdentity.dev ||
    freshRootStat.ino.toString() !== rootIdentity.ino
  ) {
    return { reason: 'root-identity-changed', status: 'failed' }
  }

  const candidateAbsPath = join(reviewRoot, candidate.name)
  const rewalked = walkCandidateSubtree(candidateAbsPath)
  if (!rewalked.ok) {
    return { reason: 'drift-detected', status: 'skipped' }
  }
  if (JSON.stringify(rewalked.entries) !== JSON.stringify(candidate.entries)) {
    return { reason: 'drift-detected', status: 'skipped' }
  }

  try {
    rmSync(candidateAbsPath, { recursive: true })
  } catch {
    return { reason: 'deletion-failed', status: 'failed' }
  }

  return { status: 'deleted' }
}

// ── Execute (deletion) operation ─────────────────────────────────────────

/**
 * @typedef {{
 *   root: string | undefined,
 *   ackOffline: boolean,
 *   token: string | undefined,
 *   nowMs: number,
 * }} ExecuteOptions
 */

/**
 * @returns {{ exitCode: number, response: Record<string, unknown> }}
 */
function previewStaleResult() {
  return {
    exitCode: 3,
    response: {
      operation: 'execute',
      result: 'preview-stale',
      schema_version: SCHEMA_VERSION,
    },
  }
}

/**
 * Validates the token and offline acknowledgment, rescans the review root
 * using the token's fixed time boundary (never the current wall clock),
 * and -- only if the fresh digest still matches the token -- deletes each
 * originally-selected candidate via {@link executeApprovedCandidate}.
 *
 * `nowMs` is used only to reject a token whose reference time is in the
 * future; it never substitutes for the token's own fixed reference time in
 * the rescan itself, so elapsed real time cannot silently expand the
 * approved set.
 * @param {ExecuteOptions} options
 * @returns {{ exitCode: number, response: Record<string, unknown> }}
 */
export function runExecute(options) {
  if (!options.ackOffline) {
    return errorResultFor('execute', CATEGORY.MISSING_ACKNOWLEDGMENT)
  }
  if (options.token === undefined) {
    return errorResultFor('execute', CATEGORY.MISSING_TOKEN)
  }
  const decoded = decodeExecutionToken(options.token)
  if (!decoded) {
    return errorResultFor('execute', CATEGORY.INVALID_TOKEN)
  }
  if (decoded.referenceTimeMs > options.nowMs) {
    return errorResultFor('execute', CATEGORY.INVALID_TOKEN)
  }

  if (!options.root) {
    return errorResultFor('execute', CATEGORY.MISSING_ROOT)
  }

  const resolved = resolveReviewRoot(options.root)
  if (resolved.status === 'invalid-root') {
    return errorResultFor('execute', CATEGORY.INVALID_ROOT)
  }
  if (resolved.status === 'missing') {
    // The review root existed at preview time (a token was issued) but is
    // gone now: membership changed, not a fresh no-op.
    return previewStaleResult()
  }
  if (resolved.status === 'unsafe') {
    return errorResultFor('execute', CATEGORY.UNSAFE_REVIEW_ROOT)
  }
  const reviewRoot = resolved.path
  const canonicalProjectRoot = resolved.canonicalProjectRoot

  const scan = scanReviewRoot(
    reviewRoot,
    decoded.cutoffTimeMs,
    decoded.referenceTimeMs,
  )
  if (!scan.ok) {
    return errorResultFor('execute', scan.category)
  }

  const digest = computeSnapshotDigest(
    scan.rootIdentity,
    scan.directChildren,
    scan.selected.map((c) => ({ entries: c.entries, name: c.name })),
  )
  if (digest !== decoded.digest) {
    return previewStaleResult()
  }

  /** @type {{ name: string }[]} */
  const deleted = []
  /** @type {{ name: string; reason: string }[]} */
  const skipped = []
  /** @type {{ name: string; reason: string }[]} */
  const failed = []

  for (const candidate of scan.selected) {
    const outcome = executeApprovedCandidate({
      candidate,
      canonicalProjectRoot,
      rootIdentity: scan.rootIdentity,
    })
    if (outcome.status === 'deleted') {
      deleted.push({ name: candidate.name })
    } else if (outcome.status === 'skipped') {
      skipped.push({ name: candidate.name, reason: outcome.reason })
    } else {
      failed.push({ name: candidate.name, reason: outcome.reason })
    }
  }

  const allNames = [
    ...scan.selected.map((c) => c.name),
    ...scan.excludedRecent.map((c) => c.name),
    ...scan.skippedUnknownUnsafe.map((c) => c.name),
  ]
  const displayIds = deriveDisplayIds(allNames)

  const partial = skipped.length > 0 || failed.length > 0

  return {
    exitCode: partial ? 1 : 0,
    response: {
      candidates: {
        deleted: deleted.map((c) => ({
          displayId: displayIds.get(c.name),
          name: boundedName(c.name),
        })),
        excludedRecent: scan.excludedRecent.map((c) => ({
          displayId: displayIds.get(c.name),
          label: c.label,
          lastModified: new Date(c.lastModifiedMs).toISOString(),
          name: boundedName(c.name),
        })),
        failed: failed.map((c) => ({
          displayId: displayIds.get(c.name),
          name: boundedName(c.name),
          reason: c.reason,
        })),
        skipped: skipped.map((c) => ({
          displayId: displayIds.get(c.name),
          name: boundedName(c.name),
          reason: c.reason,
        })),
        skippedUnknownUnsafe: scan.skippedUnknownUnsafe.map((c) => ({
          displayId: displayIds.get(c.name),
          name: boundedName(c.name),
          reason: c.reason,
        })),
      },
      counts: {
        deleted: deleted.length,
        excludedRecent: scan.excludedRecent.length,
        failed: failed.length,
        selected: scan.selected.length,
        skipped: skipped.length,
        skippedUnknownUnsafe: scan.skippedUnknownUnsafe.length,
      },
      operation: 'execute',
      result: partial ? 'partial' : 'deleted',
      schema_version: SCHEMA_VERSION,
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

/**
 * Strictly parses `execute`'s fixed argument set: only `--root <value>`,
 * `--token <value>`, and the boolean `--ack-offline` are recognized. Any
 * unknown flag, a duplicate flag, or a flag missing its value is rejected
 * outright -- there is no `--force` or other extra deletion path.
 * @param {readonly string[]} args
 * @returns {{ ok: true, root: string | undefined, token: string | undefined, ackOffline: boolean } | { ok: false }}
 */
function parseExecuteArgs(args) {
  let root
  let token
  let ackOffline = false
  let rootSeen = false
  let tokenSeen = false
  let ackSeen = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--root' || arg === '--token') {
      const seen = arg === '--root' ? rootSeen : tokenSeen
      if (seen) return { ok: false }
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) return { ok: false }
      if (arg === '--root') {
        root = value
        rootSeen = true
      } else {
        token = value
        tokenSeen = true
      }
      i += 1
      continue
    }
    if (arg === '--ack-offline') {
      if (ackSeen) return { ok: false }
      ackSeen = true
      ackOffline = true
      continue
    }
    return { ok: false }
  }

  return { ackOffline, ok: true, root, token }
}

function main() {
  const argv = process.argv.slice(2)
  const operation = argv[0]
  const rest = argv.slice(1)

  if (operation === 'execute') {
    const parsedArgs = parseExecuteArgs(rest)
    if (!parsedArgs.ok) {
      emitAndExit(
        errorResultFor('execute', CATEGORY.INVALID_ARGUMENTS),
        'execute',
      )
      return
    }
    const outcome = runExecute({
      ackOffline: parsedArgs.ackOffline,
      nowMs: Date.now(),
      root: parsedArgs.root,
      token: parsedArgs.token,
    })
    process.stdout.write(`${JSON.stringify(outcome.response)}\n`)
    process.exit(outcome.exitCode)
    return
  }

  if (operation !== 'preview') {
    emitAndExit(
      errorResultFor('preview', CATEGORY.UNKNOWN_OPERATION),
      operation,
    )
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
