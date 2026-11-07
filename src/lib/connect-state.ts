/**
 * Run state for `ce:connect`: the state root, the lock, published runs, the
 * ledger and the prune. It answers three questions: may two runs overlap, what
 * did a run publish, and has a candidate already been proposed or decided.
 *
 * Import rule: node builtins, `connect-config.ts` and `connect-evidence.ts`
 * only. The `ce:connect` helper bundles this module, so it must never import
 * zod, `config.ts` or `config-schema.ts`.
 *
 * Layout under the state root (directories 0700, files 0600):
 *
 *     lock/holder.json      the held lock: pid, process start time, nonce
 *     runs/<id>/            a published run
 *     runs/<id>.tmp/        a run being staged
 *     ledger.json           the ledger
 *
 * Staging and publishing: a run is built in `runs/<id>.tmp/` and the rename to
 * `runs/<id>/` is the commit. The ledger is rewritten after it, with a
 * temporary file and a rename. A crash between the two leaves a committed run
 * whose candidates are missing from the ledger, so the next run proposes them
 * once more. Leftover `.tmp` directories are removed by the prune.
 *
 * The lock is a directory made with `mkdir`, which is atomic. The holder file
 * is written under a temporary name and renamed into place. A lock is stale
 * when its holder is dead, or when the pid is alive with a different start
 * time (the pid was reused). A start time that cannot be read means busy,
 * never stale. To reclaim, the stale directory is renamed to a unique name and
 * the moved holder's nonce must equal the one that was judged stale; a
 * mismatch means a live lock was moved, so it is put back and the caller is
 * busy. A lock with no readable holder is reclaimable after ten minutes.
 *
 * The ledger is minimal: identities, source paths, fingerprints, status and a
 * reason. It holds no excerpt and is never evidence. Its writers copy named
 * fields only, so extra fields on a candidate never reach the file.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { type ContainerRefusal, containerRefusal } from './connect-config.js'
import { readContainedFile } from './connect-evidence.js'

// ── Constants ───────────────────────────────────────────────────────────────

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** A lock directory with no usable holder is reclaimable after this long. */
export const HOLDERLESS_LOCK_MAX_AGE_MS = 10 * 60 * 1000

/** A published run directory is pruned once it is older than this. */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const LOCK_DIR = 'lock'
const HOLDER_FILE = 'holder.json'
const RUNS_DIR = 'runs'
const LEDGER_FILE = 'ledger.json'
const STAGING_SUFFIX = '.tmp'

const MAX_HOLDER_BYTES = 4096
const MAX_LEDGER_BYTES = 16 * 1024 * 1024
const MAX_STRING_LENGTH = 512
const MAX_PATH_LENGTH = 4096
const MAX_REASON_LENGTH = 500
const MAX_SOURCES = 32
const MAX_TARGET_EVIDENCE = 64
const MAX_HISTORY = 10
const MAX_POSSIBLE_MATCHES = 5
const MAX_RUN_FILES = 16
const MAX_PROCESS_PROBE_MS = 5000

/** A run id or a run file name: one plain path segment. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL_CHARACTER = /\p{Cc}/u

// ── Small helpers ───────────────────────────────────────────────────────────

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `lstat` result, or undefined when nothing is there. Other errors throw. */
function lstatMaybe(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    // A leftover is cleaned by a later run; the caller's result is decided.
  }
}

/** Create a file that must not exist, write it, flush it, and set its mode. */
function writeFileExclusive(file: string, data: string): void {
  const fd = fs.openSync(file, 'wx', FILE_MODE)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(file, FILE_MODE)
}

/** Replace `target` by writing a sibling temporary file and renaming it over. */
function writeFileAtomic(target: string, data: string): void {
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    writeFileExclusive(temporary, data)
    fs.renameSync(temporary, target)
  } catch (error) {
    removeQuietly(temporary)
    throw error
  }
}

function plainText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTER.test(value)
  )
}

function codepointOrder(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

// ── State root ──────────────────────────────────────────────────────────────

export type StateRootRefusal =
  | ContainerRefusal
  /** The root, or the runs directory, is a symlink. */
  | 'symlink'
  | 'not-directory'
  /** Another user owns the directory. */
  | 'foreign-owner'
  | 'unwritable'

export type StateRootResult =
  | {
      readonly status: 'ok'
      readonly root: string
      /** An existing root had loose permissions and was set to 0700. */
      readonly tightened: boolean
    }
  | { readonly status: 'refused'; readonly reason: StateRootRefusal }

export interface StateRootOptions {
  /** Main roots of the allowed projects. State may not live in one. */
  readonly allowedRoots: readonly string[]
}

type DirectoryCheck =
  | { readonly ok: true; readonly tightened: boolean }
  | { readonly ok: false; readonly reason: StateRootRefusal }

/** Make `dir` a real directory of ours at 0700, tightening it if it was looser. */
function ensureOwnDirectory(dir: string): DirectoryCheck {
  const existing = lstatMaybe(dir)
  if (existing === undefined) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    fs.chmodSync(dir, DIR_MODE)
    return { ok: true, tightened: false }
  }
  if (existing.isSymbolicLink()) return { ok: false, reason: 'symlink' }
  if (!existing.isDirectory()) return { ok: false, reason: 'not-directory' }
  const uid = process.getuid?.()
  if (uid !== undefined && existing.uid !== uid) {
    return { ok: false, reason: 'foreign-owner' }
  }
  if ((existing.mode & 0o777) !== DIR_MODE) {
    fs.chmodSync(dir, DIR_MODE)
    return { ok: true, tightened: true }
  }
  return { ok: true, tightened: false }
}

/**
 * Check and create the state root. A root that sits in a checkout, in an
 * allowed project, or that is (or has a `runs` directory that is) a symlink is
 * refused; a looser existing root is tightened to 0700. Never throws.
 */
export function prepareStateRoot(
  root: string,
  options: StateRootOptions,
): StateRootResult {
  const resolved = path.resolve(root)
  const container = containerRefusal(resolved, options.allowedRoots)
  if (container !== undefined) return { status: 'refused', reason: container }
  try {
    const rootCheck = ensureOwnDirectory(resolved)
    if (!rootCheck.ok) return { status: 'refused', reason: rootCheck.reason }
    const runsCheck = ensureOwnDirectory(path.join(resolved, RUNS_DIR))
    if (!runsCheck.ok) return { status: 'refused', reason: runsCheck.reason }
    return {
      status: 'ok',
      root: resolved,
      tightened: rootCheck.tightened || runsCheck.tightened,
    }
  } catch {
    return { status: 'refused', reason: 'unwritable' }
  }
}

// ── Process table ───────────────────────────────────────────────────────────

/**
 * What the lock needs to know about other processes. It is a seam so tests can
 * script a process table.
 */
export interface ProcessTable {
  /** Whether a process with this pid exists. */
  isAlive(pid: number): boolean
  /** An opaque value that is stable for the life of one process, or undefined when unknown. */
  startTime(pid: number): string | undefined
}

/**
 * The start time field of a Linux `/proc/<pid>/stat` line (field 22). The
 * command name is parenthesised and may itself hold parentheses, so the fields
 * are counted from the last `)`.
 */
export function parseLinuxStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  // Field 3 (the state) is the first one after the command name.
  const value = fields[22 - 3]
  return value !== undefined && /^\d+$/.test(value) ? value : undefined
}

/**
 * The start time of a process: `ps -o lstart=` through argv, no shell, on
 * macOS; `/proc/<pid>/stat` on Linux. Undefined for a dead process, an invalid
 * pid, an unsupported platform or any read failure.
 */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'linux') {
      return parseLinuxStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
    }
    if (process.platform === 'darwin') {
      const probe = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: MAX_PROCESS_PROBE_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { LC_ALL: 'C', LANG: 'C' },
      })
      if (probe.status !== 0) return undefined
      const started = probe.stdout.trim()
      return started === '' ? undefined : started
    }
  } catch {
    return undefined
  }
  return undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return errorCode(error) !== 'ESRCH'
  }
}

export const systemProcessTable: ProcessTable = {
  isAlive: isProcessAlive,
  startTime: processStartTime,
}

// ── Lock ────────────────────────────────────────────────────────────────────

export interface LockHooks {
  /** Runs after a reclaimer has judged a lock stale and before it moves it. A test seam for races. */
  readonly afterObserve?: () => void
}

export interface LockOptions {
  /** The pid recorded as the holder. Defaults to this process. */
  readonly pid?: number
  readonly processes?: ProcessTable
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number
  readonly hooks?: LockHooks
}

/** Proof of a held lock. Pass it to the operations that need the lock. */
export interface LockHandle {
  readonly root: string
  readonly nonce: string
  readonly pid: number
}

export type LockBusyReason =
  /** The holder is alive and its start time matches. */
  | 'held'
  /** The holder is alive but its start time cannot be compared. */
  | 'holder-unverifiable'
  /** The lock has no usable holder and is less than ten minutes old. */
  | 'holderless-recent'
  /** Another process changed the lock while it was being reclaimed. */
  | 'reclaim-contended'

export type LockReclaimReason =
  | 'holder-dead'
  | 'pid-reused'
  | 'holderless-expired'

/** What was reclaimed. The caller records it in the run record. */
export interface LockReclaim {
  readonly reason: LockReclaimReason
  readonly previousPid?: number
  readonly previousNonce?: string
}

export type LockResult =
  | {
      readonly status: 'acquired'
      readonly lock: LockHandle
      readonly reclaimed?: LockReclaim
    }
  | { readonly status: 'busy'; readonly reason: LockBusyReason }
  | {
      readonly status: 'failed'
      readonly reason: 'not-a-directory' | 'unwritable'
    }

interface LockHolder {
  readonly version: 1
  readonly pid: number
  readonly startTime: string | null
  readonly nonce: string
}

type HolderRead =
  | { readonly kind: 'holder'; readonly holder: LockHolder }
  | { readonly kind: 'none' }

function parseHolder(bytes: Buffer): LockHolder | undefined {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== 1) return undefined
  const { pid, startTime, nonce } = value
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined
  }
  if (startTime !== null && !plainText(startTime, MAX_STRING_LENGTH)) {
    return undefined
  }
  if (typeof nonce !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(nonce)) {
    return undefined
  }
  return { version: 1, pid, startTime, nonce }
}

/** The holder file of the directory named `dirName` under the root, if it holds a usable one. */
function readHolderAt(root: string, dirName: string): HolderRead {
  const read = readContainedFile(root, `${dirName}/${HOLDER_FILE}`, {
    maxBytes: MAX_HOLDER_BYTES,
  })
  if (read.kind !== 'bytes') return { kind: 'none' }
  const holder = parseHolder(read.bytes)
  return holder === undefined ? { kind: 'none' } : { kind: 'holder', holder }
}

function holdsLock(handle: LockHandle): boolean {
  const read = readHolderAt(handle.root, LOCK_DIR)
  return read.kind === 'holder' && read.holder.nonce === handle.nonce
}

type CreateOutcome =
  | { readonly kind: 'created'; readonly lock: LockHandle }
  | { readonly kind: 'exists' }
  | { readonly kind: 'contended' }
  | { readonly kind: 'error' }

/** Make the lock directory and write the holder file into it. */
function createLock(
  root: string,
  pid: number,
  processes: ProcessTable,
): CreateOutcome {
  const lockDir = path.join(root, LOCK_DIR)
  try {
    fs.mkdirSync(lockDir, { mode: DIR_MODE })
  } catch (error) {
    return errorCode(error) === 'EEXIST'
      ? { kind: 'exists' }
      : { kind: 'error' }
  }
  const nonce = randomUUID()
  const holder: LockHolder = {
    version: 1,
    pid,
    startTime: processes.startTime(pid) ?? null,
    nonce,
  }
  try {
    fs.chmodSync(lockDir, DIR_MODE)
    const temporary = path.join(lockDir, `${HOLDER_FILE}.tmp-${randomUUID()}`)
    try {
      writeFileExclusive(temporary, `${JSON.stringify(holder)}\n`)
      fs.renameSync(temporary, path.join(lockDir, HOLDER_FILE))
    } catch (error) {
      removeQuietly(temporary)
      throw error
    }
  } catch {
    removeQuietly(lockDir)
    return { kind: 'error' }
  }
  const lock: LockHandle = { root, nonce, pid }
  // A reclaimer that moved this directory before the holder file landed would
  // have changed the nonce under us.
  return holdsLock(lock) ? { kind: 'created', lock } : { kind: 'contended' }
}

type LockVerdict =
  | { readonly action: 'busy'; readonly reason: LockBusyReason }
  | {
      readonly action: 'reclaim'
      readonly reclaim: LockReclaim
      /** The nonce that was judged stale, or null when the lock had no holder. */
      readonly expectedNonce: string | null
    }

function judgeLock(
  root: string,
  lockDir: string,
  processes: ProcessTable,
  now: number,
): LockVerdict {
  const read = readHolderAt(root, LOCK_DIR)
  if (read.kind === 'none') {
    const age = now - fs.lstatSync(lockDir).mtimeMs
    return age >= HOLDERLESS_LOCK_MAX_AGE_MS
      ? {
          action: 'reclaim',
          reclaim: { reason: 'holderless-expired' },
          expectedNonce: null,
        }
      : { action: 'busy', reason: 'holderless-recent' }
  }
  const { holder } = read
  const previous = { previousPid: holder.pid, previousNonce: holder.nonce }
  if (!processes.isAlive(holder.pid)) {
    return {
      action: 'reclaim',
      reclaim: { reason: 'holder-dead', ...previous },
      expectedNonce: holder.nonce,
    }
  }
  const started = processes.startTime(holder.pid)
  if (started === undefined || holder.startTime === null) {
    return { action: 'busy', reason: 'holder-unverifiable' }
  }
  if (started !== holder.startTime) {
    return {
      action: 'reclaim',
      reclaim: { reason: 'pid-reused', ...previous },
      expectedNonce: holder.nonce,
    }
  }
  return { action: 'busy', reason: 'held' }
}

/** Whether the directory that was moved aside is the lock that was judged stale. */
function movedIsJudged(
  root: string,
  stale: string,
  expectedNonce: string | null,
  now: number,
): boolean {
  const stat = lstatMaybe(stale)
  if (stat === undefined || !stat.isDirectory()) return false
  const read = readHolderAt(root, path.basename(stale))
  if (expectedNonce !== null) {
    return read.kind === 'holder' && read.holder.nonce === expectedNonce
  }
  // A holderless lock is judged by age; a fresh one is somebody mid-acquire.
  return (
    read.kind === 'none' && now - stat.mtimeMs >= HOLDERLESS_LOCK_MAX_AGE_MS
  )
}

/** Put a moved-aside lock back, unless something already took its place. */
function restoreLock(stale: string, lockDir: string): void {
  try {
    if (lstatMaybe(lockDir) === undefined) fs.renameSync(stale, lockDir)
  } catch {
    // The directory stays under its unique name; `ledger unlock` clears locks.
  }
}

function reclaimLock(
  root: string,
  lockDir: string,
  verdict: Extract<LockVerdict, { action: 'reclaim' }>,
  pid: number,
  processes: ProcessTable,
  now: number,
): LockResult {
  const stale = path.join(root, `${LOCK_DIR}.stale-${randomUUID()}`)
  try {
    fs.renameSync(lockDir, stale)
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { status: 'busy', reason: 'reclaim-contended' }
      : { status: 'failed', reason: 'unwritable' }
  }
  if (!movedIsJudged(root, stale, verdict.expectedNonce, now)) {
    restoreLock(stale, lockDir)
    return { status: 'busy', reason: 'reclaim-contended' }
  }
  removeQuietly(stale)
  const created = createLock(root, pid, processes)
  if (created.kind === 'created') {
    return {
      status: 'acquired',
      lock: created.lock,
      reclaimed: verdict.reclaim,
    }
  }
  return created.kind === 'error'
    ? { status: 'failed', reason: 'unwritable' }
    : { status: 'busy', reason: 'reclaim-contended' }
}

/**
 * Take the lock, reclaiming it when its holder is verifiably gone. Never
 * throws. A busy result carries no handle, so a busy run cannot publish,
 * prune or decide.
 */
export function acquireLock(
  root: string,
  options: LockOptions = {},
): LockResult {
  const pid = options.pid ?? process.pid
  const processes = options.processes ?? systemProcessTable
  const now = options.now ?? Date.now
  const lockDir = path.join(root, LOCK_DIR)
  try {
    const created = createLock(root, pid, processes)
    if (created.kind === 'created') {
      return { status: 'acquired', lock: created.lock }
    }
    if (created.kind === 'error')
      return { status: 'failed', reason: 'unwritable' }
    if (created.kind === 'contended') {
      return { status: 'busy', reason: 'reclaim-contended' }
    }

    const existing = lstatMaybe(lockDir)
    if (existing === undefined) {
      return { status: 'busy', reason: 'reclaim-contended' }
    }
    if (!existing.isDirectory()) {
      return { status: 'failed', reason: 'not-a-directory' }
    }
    const observedAt = now()
    const verdict = judgeLock(root, lockDir, processes, observedAt)
    if (verdict.action === 'busy') {
      return { status: 'busy', reason: verdict.reason }
    }
    options.hooks?.afterObserve?.()
    return reclaimLock(root, lockDir, verdict, pid, processes, now())
  } catch {
    return { status: 'failed', reason: 'unwritable' }
  }
}

/**
 * Release a lock this handle holds. A lock whose holder file carries another
 * nonce belongs to someone else and is left alone (`lost`). Never throws.
 */
export function releaseLock(
  handle: LockHandle,
): 'released' | 'lost' | 'failed' {
  if (!holdsLock(handle)) return 'lost'
  try {
    fs.rmSync(path.join(handle.root, LOCK_DIR), {
      recursive: true,
      force: true,
    })
    return 'released'
  } catch {
    return 'failed'
  }
}

export type UnlockResult =
  | {
      readonly status: 'unlocked'
      readonly holder?: { readonly pid: number; readonly nonce: string }
    }
  | { readonly status: 'no-lock' }
  | { readonly status: 'failed'; readonly reason: 'unwritable' }

/**
 * Remove the lock whoever holds it: the manual escape for a lock the
 * verification rules will not reclaim. Anything at the lock path goes, a
 * symlink included, and nothing behind a symlink is touched. Never throws.
 */
export function forceUnlock(root: string): UnlockResult {
  const lockDir = path.join(root, LOCK_DIR)
  try {
    if (lstatMaybe(lockDir) === undefined) return { status: 'no-lock' }
    const read = readHolderAt(root, LOCK_DIR)
    const aside = path.join(root, `${LOCK_DIR}.unlocked-${randomUUID()}`)
    fs.renameSync(lockDir, aside)
    fs.rmSync(aside, { recursive: true, force: true })
    return read.kind === 'holder'
      ? {
          status: 'unlocked',
          holder: { pid: read.holder.pid, nonce: read.holder.nonce },
        }
      : { status: 'unlocked' }
  } catch {
    return { status: 'failed', reason: 'unwritable' }
  }
}

// ── Run ids ─────────────────────────────────────────────────────────────────

/** A sortable, unique run id: a UTC timestamp and eight hex characters. */
export function newRunId(now: number = Date.now()): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

function isRunId(value: string): boolean {
  return SAFE_NAME.test(value) && !value.endsWith(STAGING_SUFFIX)
}

// ── Candidates and identity ─────────────────────────────────────────────────

/** A source file a candidate rests on. An undefined fingerprint means the file is missing. */
export interface SourceRef {
  readonly role: string
  readonly path: string
  readonly fingerprint: string | undefined
}

/** A file in the target project the candidate cites. */
export interface TargetEvidenceRef {
  readonly path: string
  readonly fingerprint: string
}

export interface CandidateRecord {
  readonly kind: string
  /** The target project's main-root identity. */
  readonly target: string
  /** The rule id the helper's index issued. */
  readonly ruleId: string
  readonly sources: readonly SourceRef[]
  readonly targetEvidence: readonly TargetEvidenceRef[]
}

function normalizePath(value: string): string {
  return path.posix.normalize(value)
}

function validPath(value: unknown): value is string {
  if (!plainText(value, MAX_PATH_LENGTH)) return false
  const normalized = normalizePath(value)
  return (
    !normalized.startsWith('/') &&
    normalized !== '..' &&
    !normalized.startsWith('../')
  )
}

function validFingerprint(value: unknown): value is string {
  return plainText(value, 128)
}

function validCandidate(value: CandidateRecord): boolean {
  if (!plainText(value.kind, MAX_STRING_LENGTH)) return false
  if (!plainText(value.target, MAX_PATH_LENGTH)) return false
  if (!plainText(value.ruleId, MAX_STRING_LENGTH)) return false
  if (value.sources.length < 1 || value.sources.length > MAX_SOURCES) {
    return false
  }
  for (const source of value.sources) {
    if (!plainText(source.role, MAX_STRING_LENGTH)) return false
    if (!validPath(source.path)) return false
    if (
      source.fingerprint !== undefined &&
      !validFingerprint(source.fingerprint)
    ) {
      return false
    }
  }
  if (value.targetEvidence.length > MAX_TARGET_EVIDENCE) return false
  return value.targetEvidence.every(
    (ref) => validPath(ref.path) && validFingerprint(ref.fingerprint),
  )
}

/** Sources with normalized paths, duplicates removed, in a fixed order. */
function normalizedSources(candidate: CandidateRecord): SourceRef[] {
  const seen = new Set<string>()
  const out: SourceRef[] = []
  for (const source of candidate.sources) {
    const normalized = normalizePath(source.path)
    const key = `${source.role}\0${normalized}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      role: source.role,
      path: normalized,
      fingerprint: source.fingerprint,
    })
  }
  return out.sort(
    (a, b) => codepointOrder(a.role, b.role) || codepointOrder(a.path, b.path),
  )
}

function normalizedTargetEvidence(
  candidate: CandidateRecord,
): TargetEvidenceRef[] {
  const byPath = new Map<string, TargetEvidenceRef>()
  for (const ref of candidate.targetEvidence) {
    const normalized = normalizePath(ref.path)
    if (!byPath.has(normalized)) {
      byPath.set(normalized, { path: normalized, fingerprint: ref.fingerprint })
    }
  }
  return [...byPath.values()].sort((a, b) => codepointOrder(a.path, b.path))
}

/**
 * The identity of a candidate: kind, target, rule id and the normalized
 * (role, path) of each source. Fingerprints and target evidence are not part
 * of it, so a changed file reopens the same entry instead of making a new one.
 */
export function candidateIdentity(candidate: CandidateRecord): string {
  const sources = normalizedSources(candidate).map((s) => [s.role, s.path])
  return createHash('sha256')
    .update(
      JSON.stringify([
        'connect-candidate-v1',
        candidate.kind,
        candidate.target,
        candidate.ruleId,
        sources,
      ]),
    )
    .digest('hex')
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export type LedgerStatus = 'candidate' | 'promoted' | 'rejected'

export type ReopenReason = 'sources changed' | 'target changed'

export interface LedgerSource {
  readonly role: string
  readonly path: string
  readonly fingerprint: string
}

/** The state an entry had before it was reopened. */
export interface LedgerHistoryItem {
  readonly status: LedgerStatus
  readonly reason?: string
  readonly destination?: string
  readonly reopened?: ReopenReason
  readonly sources: readonly LedgerSource[]
  readonly targetEvidence: readonly TargetEvidenceRef[]
  readonly recordedAt: string
}

export interface LedgerEntry {
  readonly id: string
  readonly kind: string
  readonly target: string
  readonly ruleId: string
  readonly sources: readonly LedgerSource[]
  readonly targetEvidence: readonly TargetEvidenceRef[]
  readonly status: LedgerStatus
  readonly reason?: string
  readonly destination?: string
  readonly reopened?: ReopenReason
  readonly history: readonly LedgerHistoryItem[]
  readonly recordedAt: string
}

export interface Ledger {
  readonly version: 1
  readonly entries: readonly LedgerEntry[]
}

const LEDGER_STATUSES: readonly LedgerStatus[] = [
  'candidate',
  'promoted',
  'rejected',
]

function isLedgerStatus(value: unknown): value is LedgerStatus {
  return LEDGER_STATUSES.some((status) => status === value)
}

function isReopenReason(value: unknown): value is ReopenReason {
  return value === 'sources changed' || value === 'target changed'
}

function isOptionalText(value: unknown, maxLength: number): boolean {
  return value === undefined || plainText(value, maxLength)
}

function isLedgerSource(value: unknown): value is LedgerSource {
  return (
    isRecord(value) &&
    plainText(value.role, MAX_STRING_LENGTH) &&
    plainText(value.path, MAX_PATH_LENGTH) &&
    validFingerprint(value.fingerprint)
  )
}

function isTargetEvidenceRef(value: unknown): value is TargetEvidenceRef {
  return (
    isRecord(value) &&
    plainText(value.path, MAX_PATH_LENGTH) &&
    validFingerprint(value.fingerprint)
  )
}

function isHistoryItem(value: unknown): value is LedgerHistoryItem {
  return (
    isRecord(value) &&
    isLedgerStatus(value.status) &&
    isOptionalText(value.reason, MAX_REASON_LENGTH) &&
    isOptionalText(value.destination, MAX_PATH_LENGTH) &&
    (value.reopened === undefined || isReopenReason(value.reopened)) &&
    Array.isArray(value.sources) &&
    value.sources.every(isLedgerSource) &&
    Array.isArray(value.targetEvidence) &&
    value.targetEvidence.every(isTargetEvidenceRef) &&
    plainText(value.recordedAt, MAX_STRING_LENGTH)
  )
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  return (
    isRecord(value) &&
    plainText(value.id, MAX_STRING_LENGTH) &&
    plainText(value.kind, MAX_STRING_LENGTH) &&
    plainText(value.target, MAX_PATH_LENGTH) &&
    plainText(value.ruleId, MAX_STRING_LENGTH) &&
    Array.isArray(value.sources) &&
    value.sources.every(isLedgerSource) &&
    Array.isArray(value.targetEvidence) &&
    value.targetEvidence.every(isTargetEvidenceRef) &&
    isLedgerStatus(value.status) &&
    isOptionalText(value.reason, MAX_REASON_LENGTH) &&
    isOptionalText(value.destination, MAX_PATH_LENGTH) &&
    (value.reopened === undefined || isReopenReason(value.reopened)) &&
    Array.isArray(value.history) &&
    value.history.every(isHistoryItem) &&
    plainText(value.recordedAt, MAX_STRING_LENGTH)
  )
}

function parseLedger(text: string): Ledger | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== 1) return undefined
  const { entries } = value
  if (!Array.isArray(entries) || !entries.every(isLedgerEntry)) return undefined
  return { version: 1, entries }
}

export type LedgerRead =
  | { readonly status: 'ok'; readonly ledger: Ledger }
  | {
      readonly status: 'unreadable'
      readonly reason: 'invalid' | 'too-large' | 'unreadable'
    }

/**
 * Read the ledger. A missing file is an empty ledger. A file that is corrupt,
 * oversize or not a regular file is unreadable and is never replaced by an
 * empty one, so a bad file cannot silently drop history. This is `ledger show`.
 */
export function readLedger(root: string): LedgerRead {
  const read = readContainedFile(root, LEDGER_FILE, {
    maxBytes: MAX_LEDGER_BYTES,
  })
  if (read.kind === 'refused') {
    if (read.reason === 'missing') {
      return { status: 'ok', ledger: { version: 1, entries: [] } }
    }
    return {
      status: 'unreadable',
      reason: read.reason === 'too-large' ? 'too-large' : 'unreadable',
    }
  }
  const ledger = parseLedger(read.bytes.toString('utf8'))
  return ledger === undefined
    ? { status: 'unreadable', reason: 'invalid' }
    : { status: 'ok', ledger }
}

function writeLedger(root: string, ledger: Ledger): void {
  writeFileAtomic(
    path.join(root, LEDGER_FILE),
    `${JSON.stringify(ledger, null, 2)}\n`,
  )
}

// ── Suppression ─────────────────────────────────────────────────────────────

/** What the ledger says about one candidate. */
export type CandidateStanding =
  | {
      readonly standing: 'new'
      readonly id: string
      /** Other entries for the same kind, target and rule whose source content matches under another path. A human decides. */
      readonly possibleMatches: readonly string[]
    }
  | {
      readonly standing: 'suppressed'
      readonly id: string
      readonly priorStatus: LedgerStatus
    }
  | {
      readonly standing: 'reopened'
      readonly id: string
      readonly reason: ReopenReason
      readonly priorStatus: LedgerStatus
      /** Where the promoted learning lives, when a promoted entry's sources changed. */
      readonly refreshPointer?: string
    }
  | {
      readonly standing: 'unresolved'
      readonly id: string
      readonly missing: readonly string[]
    }

function sameSources(
  current: readonly SourceRef[],
  prior: LedgerEntry,
): boolean {
  return current.every((source) =>
    prior.sources.some(
      (known) =>
        known.role === source.role &&
        known.path === source.path &&
        known.fingerprint === source.fingerprint,
    ),
  )
}

/** Compared on paths both runs cite: a citation set that varies run to run must not reopen an entry. */
function sameTargetEvidence(
  current: readonly TargetEvidenceRef[],
  prior: LedgerEntry,
): boolean {
  return current.every((ref) => {
    const known = prior.targetEvidence.find((item) => item.path === ref.path)
    return known === undefined || known.fingerprint === ref.fingerprint
  })
}

function possibleRenames(
  ledger: Ledger,
  candidate: CandidateRecord,
  id: string,
  sources: readonly SourceRef[],
): string[] {
  const matches: string[] = []
  for (const entry of ledger.entries) {
    if (entry.id === id) continue
    if (
      entry.kind !== candidate.kind ||
      entry.target !== candidate.target ||
      entry.ruleId !== candidate.ruleId
    ) {
      continue
    }
    const moved = entry.sources.some((known) =>
      sources.some(
        (source) =>
          source.fingerprint === known.fingerprint &&
          source.path !== known.path,
      ),
    )
    if (moved) matches.push(entry.id)
    if (matches.length >= MAX_POSSIBLE_MATCHES) break
  }
  return matches
}

/**
 * Decide what the ledger says about a candidate, without writing:
 *
 * - a missing source is `unresolved`, never `changed`;
 * - no prior entry is `new`;
 * - unchanged source and target fingerprints are `suppressed`, whatever the
 *   prior status;
 * - a changed source fingerprint is `reopened` as "sources changed" (with a
 *   refresh pointer when the prior entry was promoted);
 * - otherwise a changed target fingerprint is `reopened` as "target changed".
 */
export function classifyCandidate(
  ledger: Ledger,
  candidate: CandidateRecord,
): CandidateStanding {
  const id = candidateIdentity(candidate)
  const sources = normalizedSources(candidate)
  const missing = sources
    .filter((source) => source.fingerprint === undefined)
    .map((source) => source.path)
  if (missing.length > 0) return { standing: 'unresolved', id, missing }

  const prior = ledger.entries.find((entry) => entry.id === id)
  if (prior === undefined) {
    return {
      standing: 'new',
      id,
      possibleMatches: possibleRenames(ledger, candidate, id, sources),
    }
  }
  const sourcesSame = sameSources(sources, prior)
  if (
    sourcesSame &&
    sameTargetEvidence(normalizedTargetEvidence(candidate), prior)
  ) {
    return { standing: 'suppressed', id, priorStatus: prior.status }
  }
  if (sourcesSame) {
    return {
      standing: 'reopened',
      id,
      reason: 'target changed',
      priorStatus: prior.status,
    }
  }
  return {
    standing: 'reopened',
    id,
    reason: 'sources changed',
    priorStatus: prior.status,
    ...(prior.status === 'promoted' && prior.destination !== undefined
      ? { refreshPointer: prior.destination }
      : {}),
  }
}

function ledgerSources(candidate: CandidateRecord): LedgerSource[] {
  return normalizedSources(candidate).flatMap((source) =>
    source.fingerprint === undefined
      ? []
      : [
          {
            role: source.role,
            path: source.path,
            fingerprint: source.fingerprint,
          },
        ],
  )
}

function snapshot(entry: LedgerEntry): LedgerHistoryItem {
  return {
    status: entry.status,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.destination === undefined
      ? {}
      : { destination: entry.destination }),
    ...(entry.reopened === undefined ? {} : { reopened: entry.reopened }),
    sources: entry.sources,
    targetEvidence: entry.targetEvidence,
    recordedAt: entry.recordedAt,
  }
}

/**
 * Fold candidates into the ledger in order, so two candidates with one
 * identity in a batch resolve the same way two runs would. Only named fields
 * are copied; nothing else on a candidate reaches the ledger.
 */
function applyCandidates(
  ledger: Ledger,
  candidates: readonly CandidateRecord[],
  recordedAt: string,
): { ledger: Ledger; outcomes: CandidateStanding[] } {
  let entries = [...ledger.entries]
  const outcomes: CandidateStanding[] = []
  for (const candidate of candidates) {
    const outcome = classifyCandidate({ version: 1, entries }, candidate)
    outcomes.push(outcome)
    if (outcome.standing === 'new') {
      entries.push({
        id: outcome.id,
        kind: candidate.kind,
        target: candidate.target,
        ruleId: candidate.ruleId,
        sources: ledgerSources(candidate),
        targetEvidence: normalizedTargetEvidence(candidate),
        status: 'candidate',
        history: [],
        recordedAt,
      })
    } else if (outcome.standing === 'reopened') {
      entries = entries.map((entry) =>
        entry.id === outcome.id
          ? {
              id: entry.id,
              kind: entry.kind,
              target: entry.target,
              ruleId: entry.ruleId,
              sources: ledgerSources(candidate),
              targetEvidence: normalizedTargetEvidence(candidate),
              status: 'candidate',
              reopened: outcome.reason,
              history: [...entry.history, snapshot(entry)].slice(-MAX_HISTORY),
              recordedAt,
            }
          : entry,
      )
    }
  }
  return { ledger: { version: 1, entries }, outcomes }
}

// ── Publishing ──────────────────────────────────────────────────────────────

export interface PublishInput {
  readonly runId: string
  /** File name to content. Names are single path segments. */
  readonly files: Readonly<Record<string, string>>
  readonly candidates: readonly CandidateRecord[]
}

export interface PublishOptions {
  /** Milliseconds since the epoch, for ledger timestamps. Defaults to `Date.now`. */
  readonly now?: () => number
  readonly hooks?: {
    /** Runs once the run is staged and before the rename commits it. A test seam for a crash. */
    readonly beforeCommit?: () => void
    /** Runs after the rename committed the run and before the ledger is rewritten. A test seam for a crash. */
    readonly afterCommit?: () => void
  }
}

export type PublishFailure =
  | 'lock-lost'
  | 'invalid-run-id'
  | 'invalid-file-name'
  | 'invalid-candidate'
  | 'run-exists'
  | 'ledger-unreadable'
  | 'write-failed'

export type PublishResult =
  | {
      readonly status: 'published'
      readonly runDir: string
      readonly outcomes: readonly CandidateStanding[]
      /** The rename committed the run; the ledger rewrite can still fail after it. */
      readonly ledger:
        | { readonly written: true }
        | { readonly written: false; readonly error: string }
    }
  | { readonly status: 'failed'; readonly reason: PublishFailure }

function validPublishInput(input: PublishInput): PublishFailure | undefined {
  if (!isRunId(input.runId)) return 'invalid-run-id'
  const names = Object.keys(input.files)
  if (names.length > MAX_RUN_FILES || !names.every((n) => SAFE_NAME.test(n))) {
    return 'invalid-file-name'
  }
  return input.candidates.every(validCandidate)
    ? undefined
    : 'invalid-candidate'
}

/** Build `runs/<id>.tmp/`, returning the failure if it could not be built. */
function stageRun(
  staging: string,
  files: Readonly<Record<string, string>>,
): PublishFailure | undefined {
  try {
    fs.mkdirSync(staging, { mode: DIR_MODE })
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? 'run-exists' : 'write-failed'
  }
  try {
    fs.chmodSync(staging, DIR_MODE)
    for (const [name, content] of Object.entries(files)) {
      writeFileExclusive(path.join(staging, name), content)
    }
    return undefined
  } catch {
    removeQuietly(staging)
    return 'write-failed'
  }
}

/**
 * Publish a run: stage `runs/<id>.tmp/`, rename it to `runs/<id>/` (the
 * commit), then rewrite the ledger. The lock must be held. The ledger is read
 * before anything is staged, so an unreadable ledger publishes nothing. A
 * failure to rewrite the ledger after the commit is reported, not undone: the
 * run stays and its candidates are proposed again next time.
 */
export function publishRun(
  root: string,
  lock: LockHandle,
  input: PublishInput,
  options: PublishOptions = {},
): PublishResult {
  if (!holdsLock(lock)) return { status: 'failed', reason: 'lock-lost' }
  const invalid = validPublishInput(input)
  if (invalid !== undefined) return { status: 'failed', reason: invalid }

  const prior = readLedger(root)
  if (prior.status !== 'ok') {
    return { status: 'failed', reason: 'ledger-unreadable' }
  }

  const runs = path.join(root, RUNS_DIR)
  const finalDir = path.join(runs, input.runId)
  const staging = `${finalDir}${STAGING_SUFFIX}`
  try {
    const runsStat = lstatMaybe(runs)
    if (runsStat === undefined || !runsStat.isDirectory()) {
      return { status: 'failed', reason: 'write-failed' }
    }
    if (lstatMaybe(finalDir) !== undefined) {
      return { status: 'failed', reason: 'run-exists' }
    }
  } catch {
    return { status: 'failed', reason: 'write-failed' }
  }

  const staged = stageRun(staging, input.files)
  if (staged !== undefined) return { status: 'failed', reason: staged }
  options.hooks?.beforeCommit?.()
  try {
    fs.renameSync(staging, finalDir)
  } catch {
    removeQuietly(staging)
    return { status: 'failed', reason: 'write-failed' }
  }

  options.hooks?.afterCommit?.()

  const recordedAt = new Date((options.now ?? Date.now)()).toISOString()
  const applied = applyCandidates(prior.ledger, input.candidates, recordedAt)
  try {
    writeLedger(root, applied.ledger)
    return {
      status: 'published',
      runDir: finalDir,
      outcomes: applied.outcomes,
      ledger: { written: true },
    }
  } catch (error) {
    return {
      status: 'published',
      runDir: finalDir,
      outcomes: applied.outcomes,
      ledger: {
        written: false,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

// ── Prune ───────────────────────────────────────────────────────────────────

export type PruneResult =
  | {
      readonly status: 'pruned'
      readonly removedRuns: readonly string[]
      readonly removedStaging: readonly string[]
      /** Entries that matched but could not be removed. */
      readonly failed: readonly string[]
    }
  | { readonly status: 'failed'; readonly reason: 'lock-lost' | 'unreadable' }

export interface PruneOptions {
  readonly now?: () => number
}

/**
 * Remove published runs older than thirty days and every leftover staging
 * directory. The lock is held, so a staging directory is a crash leftover.
 * Symlinks, files and names that are not run ids are ignored, and the ledger
 * is never touched.
 */
export function pruneRuns(
  root: string,
  lock: LockHandle,
  options: PruneOptions = {},
): PruneResult {
  if (!holdsLock(lock)) return { status: 'failed', reason: 'lock-lost' }
  const runs = path.join(root, RUNS_DIR)
  const now = (options.now ?? Date.now)()
  const removedRuns: string[] = []
  const removedStaging: string[] = []
  const failed: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(runs)
  } catch {
    return { status: 'failed', reason: 'unreadable' }
  }
  for (const name of names) {
    const outcome = pruneEntry(path.join(runs, name), name, now)
    if (outcome === 'failed') failed.push(name)
    else if (outcome === 'run') removedRuns.push(name)
    else if (outcome === 'staging') removedStaging.push(name)
  }
  return { status: 'pruned', removedRuns, removedStaging, failed }
}

/** Remove one `runs/` entry if it is an expired run or a staging directory. */
function pruneEntry(
  full: string,
  name: string,
  now: number,
): 'run' | 'staging' | 'kept' | 'failed' {
  const staging = name.endsWith(STAGING_SUFFIX)
  const stem = staging ? name.slice(0, -STAGING_SUFFIX.length) : name
  if (!SAFE_NAME.test(stem) || (!staging && !isRunId(name))) return 'kept'
  try {
    const stat = lstatMaybe(full)
    if (stat === undefined || !stat.isDirectory()) return 'kept'
    if (!staging && now - stat.mtimeMs <= RUN_RETENTION_MS) return 'kept'
    fs.rmSync(full, { recursive: true, force: true })
    return staging ? 'staging' : 'run'
  } catch {
    return 'failed'
  }
}

// ── decide and clear ────────────────────────────────────────────────────────

export interface DecideInput {
  readonly id: string
  readonly status: 'promoted' | 'rejected'
  /** One line, 500 characters at most. Required for both statuses. */
  readonly reason: string
  /** Where a promoted learning was written. Ignored for `rejected`. */
  readonly destination?: string
}

export type DecideResult =
  | { readonly status: 'decided'; readonly entry: LedgerEntry }
  | { readonly status: 'busy'; readonly reason: LockBusyReason }
  | {
      readonly status: 'failed'
      readonly reason:
        | 'invalid-input'
        | 'unknown-candidate'
        | 'lock-failed'
        | 'ledger-unreadable'
        | 'write-failed'
    }

function validDecision(input: DecideInput): boolean {
  if (!plainText(input.id, MAX_STRING_LENGTH)) return false
  if (input.status !== 'promoted' && input.status !== 'rejected') return false
  if (!plainText(input.reason.trim(), MAX_REASON_LENGTH)) return false
  return isOptionalText(input.destination, MAX_PATH_LENGTH)
}

/**
 * Record a decision on a ledger entry. It takes the lock, so a busy lock makes
 * it fail without writing, and rewrites the ledger by temp-and-rename. Both
 * statuses need a reason.
 */
export function decideLedgerEntry(
  root: string,
  input: DecideInput,
  options: LockOptions = {},
): DecideResult {
  if (!validDecision(input))
    return { status: 'failed', reason: 'invalid-input' }
  const acquired = acquireLock(root, options)
  if (acquired.status === 'busy') return acquired
  if (acquired.status === 'failed') {
    return { status: 'failed', reason: 'lock-failed' }
  }
  try {
    const read = readLedger(root)
    if (read.status !== 'ok') {
      return { status: 'failed', reason: 'ledger-unreadable' }
    }
    const prior = read.ledger.entries.find((entry) => entry.id === input.id)
    if (prior === undefined) {
      return { status: 'failed', reason: 'unknown-candidate' }
    }
    const decided: LedgerEntry = {
      id: prior.id,
      kind: prior.kind,
      target: prior.target,
      ruleId: prior.ruleId,
      sources: prior.sources,
      targetEvidence: prior.targetEvidence,
      status: input.status,
      reason: input.reason.trim(),
      ...(input.status === 'promoted' && input.destination !== undefined
        ? { destination: input.destination }
        : {}),
      history: prior.history,
      recordedAt: new Date((options.now ?? Date.now)()).toISOString(),
    }
    try {
      writeLedger(root, {
        version: 1,
        entries: read.ledger.entries.map((entry) =>
          entry.id === prior.id ? decided : entry,
        ),
      })
    } catch {
      return { status: 'failed', reason: 'write-failed' }
    }
    return { status: 'decided', entry: decided }
  } finally {
    releaseLock(acquired.lock)
  }
}

export type ClearResult =
  | { readonly status: 'cleared'; readonly removed: boolean }
  | { readonly status: 'busy'; readonly reason: LockBusyReason }
  | {
      readonly status: 'failed'
      readonly reason: 'lock-failed' | 'write-failed'
    }

/** Delete the ledger under the lock (`ledger clear`). A busy lock changes nothing. */
export function clearLedger(
  root: string,
  options: LockOptions = {},
): ClearResult {
  const acquired = acquireLock(root, options)
  if (acquired.status === 'busy') return acquired
  if (acquired.status === 'failed') {
    return { status: 'failed', reason: 'lock-failed' }
  }
  try {
    const file = path.join(root, LEDGER_FILE)
    const existed = lstatMaybe(file) !== undefined
    fs.rmSync(file, { force: true })
    return { status: 'cleared', removed: existed }
  } catch {
    return { status: 'failed', reason: 'write-failed' }
  } finally {
    releaseLock(acquired.lock)
  }
}
