#!/usr/bin/env node

// Prepares the targeted `.context/.gitignore` protection for review artifacts
// before the `ce:review` producer creates a run directory. See
// docs/plans/2026-09-08-001-feat-review-artifact-cleanup-plan.md (Unit 1).
//
// Usage: node ensure-ignore.mjs --root <path>
//
// Exit 0: JSON { status: 'protected' | 'not-applicable', caveats: [...] }
// Exit 2: JSON { status: 'blocked', reason: <fixed category> }
//
// No absolute paths, file contents, raw Git stderr, or stack traces are ever
// printed. Every failure path resolves to one of the fixed BLOCK categories.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ── Fixed contract ──────────────────────────────────────────────────────────

export const REQUIRED_ENTRY = '/systematic/ce-review/'
export const NEGATED_ENTRY = `!${REQUIRED_ENTRY}`
export const ARTIFACT_DIR_REL = '.context/systematic/ce-review'
export const ARTIFACT_DESCENDANT_REL =
  '.context/systematic/ce-review/probe-check/artifact.json'

export const BLOCK = Object.freeze({
  GIT_AMBIGUOUS: 'git-ambiguous',
  GIT_ERROR: 'git-error',
  GIT_TIMEOUT: 'git-timeout',
  IGNORE_FILE_TOO_LARGE: 'ignore-file-too-large',
  INVALID_ARGUMENTS: 'invalid-arguments',
  INVALID_ROOT: 'invalid-root',
  MISSING_GIT: 'missing-git',
  SYMLINK_REJECTED: 'symlink-rejected',
  VERIFY_FAILED: 'verify-failed',
  WRITE_CONFLICT: 'write-conflict',
  WRITE_FAILED: 'write-failed',
})

// Fixed upper bound on the `.context/.gitignore` file this helper will read
// or produce. Rejected before allocation, not truncated.
export const IGNORE_FILE_MAX_BYTES = 1024 * 1024

// Ordinary staging only: tracked files, force-add, and copies elsewhere are
// unaffected by this ignore entry (R3, R19).
const CAVEATS = Object.freeze(['tracked-files-and-force-add-unaffected'])

// The CLI always uses this fixed, bounded default. It is not configurable
// through environment variables; `classifyGitWorkTree`'s `timeoutMs` option
// exists so internal tests can inject a short value deterministically.
const DEFAULT_GIT_TIMEOUT_MS = 5000

// ── Filesystem helpers ───────────────────────────────────────────────────────

export function lstatOrNull(targetPath) {
  try {
    return fs.lstatSync(targetPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Resolves the supplied root to its canonical existing directory, or null. */
export function canonicalizeRoot(rawRoot) {
  try {
    const real = fs.realpathSync(rawRoot)
    const stat = fs.statSync(real)
    if (!stat.isDirectory()) return null
    return real
  } catch {
    return null
  }
}

/**
 * Walks `segments` below `root` and reports whether any existing component is
 * a symlink, or a non-directory occupies an intermediate position, or the
 * final `.gitignore` segment exists but is not a regular file. A missing
 * component (nothing yet created) is not rejected here.
 */
export function findUnsafeComponent(root, segments) {
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    const stat = lstatOrNull(current)
    if (!stat) return false
    if (stat.isSymbolicLink()) return true
    const isLast = index === segments.length - 1
    if (!isLast && !stat.isDirectory()) return true
    if (isLast && segment === '.gitignore' && !stat.isFile()) return true
  }
  return false
}

/** True when both `dev`+`ino` pairs identify the same underlying file (Node's `fs.Stats` exposes both across platforms; exact semantics depend on the filesystem). Not proof of atomicity -- only that two observations agree. */
function sameFileIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Reads a file's bytes/mode/identity without following a symlink at the
 * final component. Identity (`dev`+`ino`) is captured alongside content and
 * mode so a later recheck can detect a same-bytes replacement (a different
 * file swapped in via rename) or a mode-only change, not just a content diff.
 *
 * Two independent checks guard the read, since either alone is incomplete:
 *  1. An `lstat` on the path *before* opening rejects a symlink or any
 *     non-regular file (socket, FIFO, device, ...) without ever calling
 *     `open()` on it -- some non-regular types otherwise produce a
 *     platform-specific `open()` error this function should never surface
 *     as an uncaught throw, and a target this function must never block on
 *     (e.g. a FIFO with no writer).
 *  2. `O_NOFOLLOW` on the `open()` call itself rejects a symlink presented
 *     for the first time at open (a path that was a plain file at the lstat
 *     above, then replaced). `O_NOFOLLOW` is undefined on platforms that
 *     don't support it (`fs.constants.O_NOFOLLOW ?? 0` degrades to a no-op
 *     flag there), so `open()` would silently follow such a symlink. This
 *     function corroborates the opened descriptor's `dev`/`ino` against the
 *     pre-open `lstat` snapshot; a mismatch means the path did not
 *     consistently name the same file across the two observations, which is
 *     treated as unsafe. This corroboration narrows, but cannot close, the
 *     race window between the `lstat` and the `open()` -- it detects an
 *     observed identity change, not a guarantee against a well-timed racer.
 */
export function readTrustedFile(filePath) {
  const preStat = lstatOrNull(filePath)
  if (!preStat) return { exists: false }
  if (preStat.isSymbolicLink() || !preStat.isFile()) {
    return { exists: true, symlink: true }
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let fd
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false }
    if (error && error.code === 'ELOOP') return { exists: true, symlink: true }
    // Any other open error (EACCES, EPERM, resource limits, ...) is not
    // evidence of a symlink -- rethrow for the caller's fixed-category catch.
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return { exists: true, symlink: true }
    if (!sameFileIdentity(stat, preStat)) return { exists: true, symlink: true }

    // Reject before allocating a buffer for an oversize file.
    if (stat.size > IGNORE_FILE_MAX_BYTES) {
      return oversizeResult(stat)
    }

    const bytes = readExactBounded(fd, stat.size)
    if (bytes === null) {
      // Fewer bytes were available than `fstat` reported (a concurrent
      // shrink mid-read): the snapshot is untrustworthy. This is an
      // observed change, not evidence of a symlink -- no partial buffer is
      // returned in its place.
      return { changed: true, exists: true }
    }

    // The read window is not atomic: the file could have grown past the cap,
    // grown or shrunk within the cap, or had its mode changed, between the
    // `fstat` above and the read completing. Recheck the same descriptor
    // before trusting the bytes just read -- an exact match on size and
    // mode is required, not just "still under the cap".
    const afterStat = fs.fstatSync(fd)
    if (afterStat.size > IGNORE_FILE_MAX_BYTES) {
      return oversizeResult(afterStat)
    }
    if (afterStat.size !== stat.size || afterStat.mode !== stat.mode) {
      return { changed: true, exists: true }
    }

    return {
      bytes,
      dev: stat.dev,
      exists: true,
      ino: stat.ino,
      mode: stat.mode & 0o777,
    }
  } finally {
    fs.closeSync(fd)
  }
}

function oversizeResult(stat) {
  return {
    dev: stat.dev,
    exists: true,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    tooLarge: true,
  }
}

/** Reads exactly `size` bytes from `fd` at fixed positions, or null if the descriptor produced fewer bytes than expected (a concurrent shrink). Never returns a silently short buffer. */
function readExactBounded(fd, size) {
  if (size === 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const bytesRead = fs.readSync(fd, buffer, offset, size - offset, offset)
    if (bytesRead === 0) return null
    offset += bytesRead
  }
  return buffer
}

// ── Content composition (byte-exact, never decoded to a string) ────────────
//
// Existing content may contain byte sequences that are not valid UTF-8.
// Decoding to a string and re-encoding would silently corrupt them (each
// invalid sequence becomes U+FFFD, which re-encodes to different bytes than
// the original), violating byte preservation (R2). Line-splitting and
// exact-line comparison against the ASCII-only required/negated entries work
// correctly directly on raw bytes.

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d
const REQUIRED_ENTRY_BUFFER = Buffer.from(REQUIRED_ENTRY, 'utf8')
const NEGATED_ENTRY_BUFFER = Buffer.from(NEGATED_ENTRY, 'utf8')
const REQUIRED_ENTRY_LINE_BUFFER = Buffer.from(`${REQUIRED_ENTRY}\n`, 'utf8')

/** Splits bytes on `\n`, stripping a trailing `\r` per line -- byte-level equivalent of `text.split(/\r?\n/)`. */
function splitLinesBytes(bytes) {
  const lines = []
  let start = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === NEWLINE_BYTE) {
      const end = i > start && bytes[i - 1] === CARRIAGE_RETURN_BYTE ? i - 1 : i
      lines.push(bytes.subarray(start, end))
      start = i + 1
    }
  }
  lines.push(bytes.subarray(start, bytes.length))
  return lines
}

/**
 * True only when the required entry is present as an exact line and no later
 * exact negation of it follows. A same-file negation after the entry makes it
 * ineffective; a later re-assertion after the negation makes it effective
 * again. Purely a byte-level judgment about this one file, independent of
 * ancestor `.gitignore` protection -- the explicit nested entry is required
 * even when an ancestor already ignores the parent directory.
 */
export function isEntryEffectiveInBytes(bytes) {
  if (!bytes || bytes.length === 0) return false
  let effective = false
  for (const line of splitLinesBytes(bytes)) {
    if (line.equals(REQUIRED_ENTRY_BUFFER)) effective = true
    else if (line.equals(NEGATED_ENTRY_BUFFER)) effective = false
  }
  return effective
}

/** Appends the required entry, preserving existing bytes exactly and adding a separator only if needed. */
export function composeAppendedBytes(existingBytes) {
  if (!existingBytes || existingBytes.length === 0)
    return REQUIRED_ENTRY_LINE_BUFFER
  const needsSeparator =
    existingBytes[existingBytes.length - 1] !== NEWLINE_BYTE
  return needsSeparator
    ? Buffer.concat([
        existingBytes,
        Buffer.from('\n'),
        REQUIRED_ENTRY_LINE_BUFFER,
      ])
    : Buffer.concat([existingBytes, REQUIRED_ENTRY_LINE_BUFFER])
}

// ── Conflict-checked atomic write ───────────────────────────────────────────

function cleanupTemp(tempPath) {
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  } catch {
    // Best-effort cleanup; the original error is what matters.
  }
}

function makeTempPath(parentDir) {
  return path.join(
    parentDir,
    `.gitignore.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

/**
 * Writes `newContent` to `filePath` only if the file still matches the
 * `existing` snapshot immediately before the rename. Detects a conflicting
 * edit that landed between the initial read and this write; never overwrites
 * an observed conflict, and never rolls back a later editor's change.
 */
export function writeIgnoreFileIfUnchanged(filePath, existing, newContent) {
  const parentDir = path.dirname(filePath)
  const mode =
    existing.exists && existing.mode !== undefined ? existing.mode : 0o644
  const tempPath = makeTempPath(parentDir)

  try {
    fs.writeFileSync(tempPath, newContent, { flag: 'wx', mode })
  } catch {
    cleanupTemp(tempPath)
    return { ok: false, reason: 'failed' }
  }

  let recheck
  try {
    recheck = readTrustedFile(filePath)
  } catch {
    cleanupTemp(tempPath)
    return { ok: false, reason: 'failed' }
  }

  // A conflict is any observed change to identity, mode, or content: a
  // same-bytes replacement via a different inode, or a mode-only change,
  // both count even though a naive content-only diff would miss them.
  const unchanged = existing.exists
    ? recheck.exists &&
      !recheck.symlink &&
      sameFileIdentity(recheck, existing) &&
      recheck.mode === existing.mode &&
      Buffer.isBuffer(recheck.bytes) &&
      Buffer.isBuffer(existing.bytes) &&
      recheck.bytes.equals(existing.bytes)
    : !recheck.exists

  if (!unchanged) {
    cleanupTemp(tempPath)
    return { ok: false, reason: 'conflict' }
  }

  try {
    fs.renameSync(tempPath, filePath)
  } catch {
    cleanupTemp(tempPath)
    return { ok: false, reason: 'failed' }
  }

  return { ok: true }
}

// ── Git classification ───────────────────────────────────────────────────────

const GIT_ENV_STRIP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]

function sanitizedGitEnv() {
  const env = { ...process.env }
  for (const key of GIT_ENV_STRIP) delete env[key]
  env.LC_ALL = 'C'
  env.LANG = 'C'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/**
 * Runs a Git subcommand with an argument array, a bounded timeout, a
 * controlled locale, and repository-redirection environment overrides
 * stripped. `options.timeoutMs` defaults to a fixed bound; it is not exposed
 * through a public environment variable -- only internal callers (and their
 * tests) can override it per invocation.
 */
export function runGit(args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    timeout: timeoutMs,
    windowsHide: true,
  })
}

// Controlled-locale message for git's unambiguous "no repository" diagnostic.
// Deliberately distinct from the corrupt-metadata message ("not a git
// repository: <path>"), which lacks the parenthetical and must not match.
const NOT_A_REPO_PATTERN =
  /^fatal: not a git repository \(or any of the parent directories\): /m

export function classifyGitWorkTree(root, options = {}) {
  const result = runGit(['rev-parse', '--is-inside-work-tree'], root, options)

  if (result.error) {
    if (result.error.code === 'ENOENT') return { kind: 'missing-git' }
    if (result.error.code === 'ETIMEDOUT') return { kind: 'timeout' }
    return { kind: 'error' }
  }
  if (result.signal) return { kind: 'timeout' }

  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()

  if (result.status === 0) {
    // "false" means inside a `.git` directory of a repo with no accessible
    // work tree (e.g. a bare repository) -- ambiguous, not a plain work tree.
    // Distinguishing this from "true" requires reading stdout, not just the
    // (identical, zero) exit status.
    return stdout === 'true' ? { kind: 'work-tree' } : { kind: 'ambiguous' }
  }

  if (result.status === 128 && NOT_A_REPO_PATTERN.test(stderr)) {
    return { kind: 'non-git' }
  }

  return { kind: 'error' }
}

/** Confirms the directory and a descendant are both ignored, without creating a canary file. */
export function verifyEffectiveIgnore(root) {
  const dirCheck = runGit(
    ['check-ignore', '--no-index', '--quiet', '--', `${ARTIFACT_DIR_REL}/`],
    root,
  )
  if (dirCheck.error || dirCheck.signal || dirCheck.status !== 0) return false

  const descendantCheck = runGit(
    ['check-ignore', '--no-index', '--quiet', '--', ARTIFACT_DESCENDANT_REL],
    root,
  )
  if (
    descendantCheck.error ||
    descendantCheck.signal ||
    descendantCheck.status !== 0
  ) {
    return false
  }

  return true
}

// ── Orchestration ────────────────────────────────────────────────────────────

function blocked(reason) {
  return { exitCode: 2, result: { reason, status: 'blocked' } }
}

function protectedResult(status) {
  return { exitCode: 0, result: { caveats: CAVEATS, status } }
}

/** Converts any propagated non-ENOENT stat failure from `findUnsafeComponent` into the fixed blocked contract instead of an uncaught exception. */
function findUnsafeComponentOrBlock(root, segments) {
  try {
    return { unsafe: findUnsafeComponent(root, segments) }
  } catch {
    return { blockedResult: blocked(BLOCK.WRITE_FAILED) }
  }
}

export function ensureIgnore(rawRoot) {
  const root = canonicalizeRoot(rawRoot)
  if (!root) return blocked(BLOCK.INVALID_ROOT)

  const contextCheck = findUnsafeComponentOrBlock(root, ['.context'])
  if (contextCheck.blockedResult) return contextCheck.blockedResult
  if (contextCheck.unsafe) return blocked(BLOCK.SYMLINK_REJECTED)

  const ignoreCheck = findUnsafeComponentOrBlock(root, [
    '.context',
    '.gitignore',
  ])
  if (ignoreCheck.blockedResult) return ignoreCheck.blockedResult
  if (ignoreCheck.unsafe) return blocked(BLOCK.SYMLINK_REJECTED)

  const classification = classifyGitWorkTree(root)
  if (classification.kind === 'missing-git') return blocked(BLOCK.MISSING_GIT)
  if (classification.kind === 'timeout') return blocked(BLOCK.GIT_TIMEOUT)
  if (classification.kind === 'ambiguous') return blocked(BLOCK.GIT_AMBIGUOUS)
  if (classification.kind === 'error') return blocked(BLOCK.GIT_ERROR)

  const contextDir = path.join(root, '.context')
  const ignorePath = path.join(contextDir, '.gitignore')

  try {
    fs.mkdirSync(contextDir, { recursive: true })
  } catch {
    return blocked(BLOCK.WRITE_FAILED)
  }
  // The directory may have been replaced by a symlink between the earlier
  // check and this creation; re-verify before touching the nested file.
  const recheck = findUnsafeComponentOrBlock(root, ['.context'])
  if (recheck.blockedResult) return recheck.blockedResult
  if (recheck.unsafe) return blocked(BLOCK.SYMLINK_REJECTED)

  let existing
  try {
    existing = readTrustedFile(ignorePath)
  } catch {
    return blocked(BLOCK.WRITE_FAILED)
  }
  if (existing.symlink) return blocked(BLOCK.SYMLINK_REJECTED)
  if (existing.tooLarge) return blocked(BLOCK.IGNORE_FILE_TOO_LARGE)
  if (existing.changed) return blocked(BLOCK.WRITE_CONFLICT)

  const existingBytes =
    existing.exists && existing.bytes ? existing.bytes : undefined

  if (!isEntryEffectiveInBytes(existingBytes)) {
    const newContent = composeAppendedBytes(existingBytes)
    // The prospective composed length -- not an approximation -- must fit
    // the cap before any write is attempted.
    if (newContent.length > IGNORE_FILE_MAX_BYTES) {
      return blocked(BLOCK.IGNORE_FILE_TOO_LARGE)
    }
    const writeResult = writeIgnoreFileIfUnchanged(
      ignorePath,
      existing,
      newContent,
    )
    if (!writeResult.ok) {
      return blocked(
        writeResult.reason === 'conflict'
          ? BLOCK.WRITE_CONFLICT
          : BLOCK.WRITE_FAILED,
      )
    }
  }

  if (classification.kind === 'non-git') {
    return protectedResult('not-applicable')
  }

  if (!verifyEffectiveIgnore(root)) return blocked(BLOCK.VERIFY_FAILED)
  return protectedResult('protected')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = new Set(['--root'])

/**
 * Strictly parses `--root <value>` and nothing else: an unknown flag, a
 * duplicate `--root`, a missing value, or any stray positional argument is
 * rejected rather than silently accepted or defaulted.
 */
export function parseArgs(argv) {
  let root
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!KNOWN_FLAGS.has(token)) return null
    if (root !== undefined) return null // duplicate --root
    const value = argv[i + 1]
    // Reject a missing value or any value starting with `--` (an option
    // consumed as a path); `./--name` remains a valid literal path.
    if (value === undefined || value.startsWith('--')) return null
    root = value
    i += 1
  }
  return root === undefined ? null : root
}

function main() {
  const root = parseArgs(process.argv.slice(2))
  if (root === null) {
    process.stdout.write(
      `${JSON.stringify({ reason: BLOCK.INVALID_ARGUMENTS, status: 'blocked' })}\n`,
    )
    process.exit(2)
    return
  }

  // Final boundary: any unanticipated exception still maps to the fixed
  // blocked contract, never a raw error.
  let outcome
  try {
    outcome = ensureIgnore(root)
  } catch {
    process.stdout.write(
      `${JSON.stringify({ reason: BLOCK.WRITE_FAILED, status: 'blocked' })}\n`,
    )
    process.exit(2)
    return
  }

  const { exitCode, result } = outcome
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(exitCode)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
}
