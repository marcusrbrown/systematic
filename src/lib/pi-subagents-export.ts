/**
 * pi-subagents export lifecycle: resolve, preview, export, refresh, cleanup.
 *
 * Writes user-chosen agents dirs ($PI_CODING_AGENT_DIR/agents or
 * <cwd>/.pi/agents). Batch-transactional with rollback: if any file write or
 * the manifest write fails, the operation rolls back to the pre-operation
 * state. Rollback reports any restoration failures explicitly.
 *
 * Manifest tracks ownership. Malformed or hostile manifests cause every
 * lifecycle verb to refuse before mutation. No writes from module import.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  OverlayConfig,
  SourcedOverlayConfigMap,
  SystematicConfig,
} from './config.js'
import { loadConfigWithSources } from './config.js'
import { parseFrontmatter } from './frontmatter.js'
import type { ManifestEntry } from './pi-subagents-personas.js'
import { generateAll } from './pi-subagents-personas.js'
import {
  resolveRouting,
  toSourcedPiSubagentsOverlays,
} from './routing-resolver.js'

export type ExportScope = 'project' | 'global'

/**
 * Scope-appropriate config resolution for export/preview/refresh. When
 * provided, the effective config (`user → project → custom` for project
 * scope; `user → custom` for global scope — never absorbing cwd project
 * overlays) is applied to each exported persona's frontmatter: `model`
 * resolved from the `categories`/`agents` overlay (per-agent beats category;
 * `model: null` omits) and Pi-native `pi_subagents` fields (`thinking`,
 * `max_turns`, `tools`, `skills`) resolved from the `pi_subagents`
 * namespace after trust filtering. Omitting `configOptions` preserves the
 * model-free, config-neutral export (backward compatible default).
 */
export interface ExportConfigOptions {
  scope: ExportScope
  cwd: string
}

// ── Manifest types ────────────────────────────────────────────────────────────

export const MANIFEST_FILENAME = '.systematic-personas.json'

/** Exclusive per-root mutation lock. Guards export/refresh/cleanup; preview is lock-free. */
export const LOCK_FILENAME = '.systematic-personas.lock'

/** Generated persona namespace filename pattern — manifest entries must match this. */
const GENERATED_NAMESPACE_PATTERN = /^systematic-[a-z0-9-]+\.md$/

export interface ManifestFileEntry {
  filename: string
  hash: string
  status: 'exported' | 'exported-with-warning'
}

export interface PiSubagentsManifest {
  generatedAt: string
  agentsRoot: string
  files: ManifestFileEntry[]
}

/**
 * Strict manifest read result — distinguishes absent from malformed.
 *
 *   absent   → no manifest file; operations proceed as first-export.
 *   ok       → valid manifest, returned in `manifest`.
 *   malformed → manifest file exists but is invalid (bad JSON, wrong schema,
 *               duplicate filenames, unsafe filenames). Operations must refuse.
 */
export type ManifestReadResult =
  | { kind: 'absent' }
  | { kind: 'ok'; manifest: PiSubagentsManifest }
  | { kind: 'malformed'; error: string }

// ── Target resolution ─────────────────────────────────────────────────────────

export function resolveAgentsRoot(scope: ExportScope, cwd: string): string {
  if (scope === 'project') return path.join(cwd, '.pi', 'agents')
  const envDir = process.env.PI_CODING_AGENT_DIR
  const base = envDir ? envDir : path.join(os.homedir(), '.pi', 'agent')
  return path.join(base, 'agents')
}

// ── Scope-anchored symlink safety ───────────────────────────────────────────

/**
 * Resolve the safety anchor for a scope: the topmost directory whose
 * descendants (down to agentsRoot) are walked and lstat-checked for
 * symlinks/non-directories. Never inspects ancestors above this anchor
 * (avoids false positives from OS-level ancestor symlinks, e.g. macOS
 * `/var` -> `/private/var`).
 *
 * - project: cwd
 * - global with PI_CODING_AGENT_DIR set: the env dir's PARENT (so the env
 *   dir itself is included in the walk and checked)
 * - global without PI_CODING_AGENT_DIR: homedir
 */
export function resolveAnchor(scope: ExportScope, cwd: string): string {
  if (scope === 'project') return path.resolve(cwd)
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) return path.resolve(path.dirname(envDir))
  return path.resolve(os.homedir())
}

function anchorForScope(
  configOptions: ExportConfigOptions | undefined,
  agentsRootFallback: string,
): string {
  const resolvedAgentsRoot = path.resolve(agentsRootFallback)
  if (configOptions) {
    // Scope context is known: always validate against the scope's real
    // safety anchor. Never weaken to agentsRoot's own immediate parent —
    // a caller-supplied agentsRoot that falls outside the declared scope's
    // anchor is a mismatch that must be refused (via assertAnchoredPathSafe),
    // not silently accepted under a shallower single-level check.
    return resolveAnchor(configOptions.scope, configOptions.cwd)
  }
  // No scope context supplied — fall back to validating agentsRoot itself
  // against its immediate parent only (preserves single-level symlink-root
  // rejection for legacy config-neutral callers).
  return path.dirname(resolvedAgentsRoot)
}

/**
 * Walk every path component from `anchor` down to `targetPath` (inclusive),
 * lstat-ing each. Rejects any symlink or non-directory intermediate/final
 * component. Missing components are fine (not yet created — nothing to
 * reject). Never inspects filesystem ancestors above `anchor`.
 */
function assertAnchoredPathSafe(anchor: string, targetPath: string): void {
  const resolvedAnchor = path.resolve(anchor)
  const resolvedTarget = path.resolve(targetPath)
  if (
    resolvedTarget !== resolvedAnchor &&
    !resolvedTarget.startsWith(resolvedAnchor + path.sep)
  ) {
    throw new Error(
      `Refusing to operate on ${resolvedTarget}: outside safety anchor ${resolvedAnchor}`,
    )
  }
  const rel = path.relative(resolvedAnchor, resolvedTarget)
  const parts = rel === '' ? [] : rel.split(path.sep)
  let current = resolvedAnchor
  for (const part of parts) {
    current = path.join(current, part)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch {
      continue // not yet created — nothing to reject
    }
    if (stat.isSymbolicLink())
      throw new Error(
        `Refusing to operate through ${current}: symlink detected`,
      )
    if (!stat.isDirectory())
      throw new Error(`Refusing to operate through ${current}: not a directory`)
  }
}

/**
 * After the lexical anchored walk (`assertAnchoredPathSafe`) and root
 * creation/existence checks have passed, canonicalize both the anchor and
 * the agents root with `fs.realpathSync` and require the canonical root to
 * remain within (or equal to) the canonical anchor.
 *
 * This closes a raced-symlink window the lexical walk cannot: `lstat`-based
 * component checks and the eventual `mkdir`/open are not atomic, so an
 * attacker able to swap a real ancestor directory for a symlink in between
 * could make the physically-resolved root land outside the anchor even
 * though every lexical component looked clean at check time. Comparing
 * canonical (fully-resolved) paths after the target exists detects that.
 *
 * This is a best-effort narrowing of the race window, not an atomic
 * openat-relative guarantee — a symlink swap occurring after this
 * canonicalization but before the caller's subsequent lock/read/mutation
 * (which is the very next thing every caller does) is not defended against
 * by userspace `realpath` + compare alone. `root` must already exist when
 * this is called (callers create/validate existence first).
 */
function assertCanonicalRootWithinAnchor(anchor: string, root: string): string {
  let canonicalAnchor: string
  try {
    canonicalAnchor = fs.realpathSync(anchor)
  } catch (err) {
    throw new Error(
      `Cannot resolve safety anchor ${anchor}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const canonicalRoot = fs.realpathSync(root)
  if (
    canonicalRoot !== canonicalAnchor &&
    !canonicalRoot.startsWith(canonicalAnchor + path.sep)
  ) {
    throw new Error(
      `Refusing to operate on ${canonicalRoot}: canonical path escapes safety anchor ` +
        `${canonicalAnchor} (raced-symlink ancestor detected after resolution)`,
    )
  }
  return canonicalRoot
}

// ── Manifest I/O ──────────────────────────────────────────────────────────────

/**
 * Read and validate the manifest at agentsRoot. Returns a typed result that
 * distinguishes absent (no file), ok (valid manifest), and malformed
 * (invalid JSON, wrong schema, duplicates, unsafe filenames).
 */
/** Validate a single manifest files entry. Returns an error string or null if valid. */
function validateManifestEntry(
  entry: unknown,
  seenFilenames: Set<string>,
): string | null {
  if (typeof entry !== 'object' || entry === null)
    return 'Manifest files entry must be an object'
  const e = entry as Record<string, unknown>
  if (typeof e.filename !== 'string' || typeof e.hash !== 'string')
    return 'Manifest files entry missing required string fields'
  if (seenFilenames.has(e.filename))
    return `Manifest contains duplicate filename: "${e.filename}"`
  seenFilenames.add(e.filename)
  if (path.basename(e.filename) !== e.filename || path.isAbsolute(e.filename))
    return `Unsafe filename in manifest: "${e.filename}" — contains traversal or path separators (invalid filename)`
  if (!GENERATED_NAMESPACE_PATTERN.test(e.filename))
    return `Manifest entry "${e.filename}" is not a generated namespace file (must match systematic-*.md; invalid filename)`
  return null
}

/** Validate a parsed manifest object. Returns an error string or null if valid. */
function validateManifestObject(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null)
    return 'Manifest root must be an object'
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.files))
    return 'Manifest "files" field must be an array'
  const seenFilenames = new Set<string>()
  for (const entry of obj.files as unknown[]) {
    const error = validateManifestEntry(entry, seenFilenames)
    if (error !== null) return error
  }
  return null
}

const HAS_O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number'

/**
 * Manual symlink refusal for platforms without O_NOFOLLOW (notably
 * Windows), where the open() call itself cannot refuse a symlinked
 * manifest path. lstat the path (never open/read through it) and require
 * it to still identify the exact file already opened (same device/inode).
 * Any mismatch — the path is now a symlink, or it was replaced between
 * open and this check — fails closed without reading a replacement.
 * Returns an error string, or null if the path checks out.
 */
function verifyManifestPathIdentity(
  manifestPath: string,
  openedStat: fs.Stats,
): string | null {
  let linkStat: fs.Stats
  try {
    linkStat = fs.lstatSync(manifestPath)
  } catch (err) {
    return `Cannot verify manifest path after open: ${err instanceof Error ? err.message : String(err)}`
  }
  if (linkStat.isSymbolicLink())
    return `Refusing to read manifest through symlink: ${manifestPath}`
  if (linkStat.dev !== openedStat.dev || linkStat.ino !== openedStat.ino)
    return `Manifest path identity changed during read (possible tamper): ${manifestPath}`
  return null
}

function openManifestFd(
  manifestPath: string,
): { kind: 'fd'; fd: number } | { kind: 'result'; result: ManifestReadResult } {
  const openFlags =
    fs.constants.O_RDONLY | (HAS_O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0)
  try {
    return { kind: 'fd', fd: fs.openSync(manifestPath, openFlags) }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      return { kind: 'result', result: { kind: 'absent' } }
    if ((err as { code?: string }).code === 'ELOOP')
      return {
        kind: 'result',
        result: {
          kind: 'malformed',
          error: `Refusing to read manifest through symlink: ${manifestPath}`,
        },
      }
    return {
      kind: 'result',
      result: {
        kind: 'malformed',
        error: `Cannot read manifest: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
}

function parseManifestContents(raw: string): ManifestReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      kind: 'malformed',
      error: `Manifest JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const validationError = validateManifestObject(parsed)
  if (validationError !== null)
    return { kind: 'malformed', error: validationError }
  return { kind: 'ok', manifest: parsed as PiSubagentsManifest }
}

export function readManifestStrict(agentsRoot: string): ManifestReadResult {
  const manifestPath = path.join(agentsRoot, MANIFEST_FILENAME)

  const opened = openManifestFd(manifestPath)
  if (opened.kind === 'result') return opened.result
  const { fd } = opened

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile())
      return {
        kind: 'malformed',
        error: `Manifest path exists but is not a regular file: ${manifestPath}`,
      }

    if (!HAS_O_NOFOLLOW) {
      const identityError = verifyManifestPathIdentity(manifestPath, stat)
      if (identityError !== null)
        return { kind: 'malformed', error: identityError }
    }

    return parseManifestContents(fs.readFileSync(fd, 'utf-8'))
  } catch (err) {
    return {
      kind: 'malformed',
      error: `Cannot read manifest: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Convenience wrapper: returns the manifest for 'ok', null for 'absent', throws
 * a structured Error for 'malformed'. Used by callers that already distinguished absent.
 */
export function readManifest(agentsRoot: string): PiSubagentsManifest | null {
  const result = readManifestStrict(agentsRoot)
  if (result.kind === 'absent') return null
  if (result.kind === 'ok') return result.manifest
  return null // malformed treated as null in legacy callers
}

export function writeManifest(
  agentsRoot: string,
  manifest: PiSubagentsManifest,
): void {
  atomicWriteString(
    path.join(agentsRoot, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

// ── Path safety ───────────────────────────────────────────────────────────────

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

function assertRealAgentsRoot(agentsRoot: string): string {
  let stat: fs.Stats | null = null
  try {
    stat = fs.lstatSync(agentsRoot)
  } catch {
    /* will be created */
  }
  if (stat !== null) {
    if (stat.isSymbolicLink())
      throw new Error(
        `Refusing to write under ${agentsRoot}: not a real directory (symlink detected)`,
      )
    if (!stat.isDirectory())
      throw new Error(`Refusing to write under ${agentsRoot}: not a directory`)
  }
  return fs.realpathSync(agentsRoot)
}

function safeFilePathOrThrow(agentsRoot: string, filename: string): string {
  if (path.basename(filename) !== filename || path.isAbsolute(filename)) {
    throw new Error(
      `Unsafe filename in manifest: "${filename}" — contains traversal or path separators (invalid filename)`,
    )
  }
  const resolved = path.resolve(agentsRoot, filename)
  if (!resolved.startsWith(agentsRoot + path.sep) && resolved !== agentsRoot) {
    throw new Error(
      `Unsafe filename in manifest: "${filename}" resolves outside agents root (traversal)`,
    )
  }
  return resolved
}

function safeFilePath(agentsRoot: string, filename: string): string | null {
  try {
    return safeFilePathOrThrow(agentsRoot, filename)
  } catch {
    return null
  }
}

// ── Exclusive per-root mutation lock ────────────────────────────────────────

/**
 * Acquire the exclusive per-root mutation lock via `openSync` with exclusive
 * creation ('wx'). Fails closed with an actionable message if the lock
 * already exists — never auto-deletes a pre-existing lock (it may belong to
 * a concurrently running process, or indicate a prior crash that needs
 * manual inspection). Returns a discriminated result rather than throwing a
 * dedicated error class (this repo requires zero classes); the `contention`
 * tag distinguishes lock contention from other operational open failures.
 */
type LockAcquireResult =
  | { ok: true; fd: number }
  | { ok: false; contention: boolean; error: string }

function acquireLock(agentsRoot: string): LockAcquireResult {
  const lockPath = path.join(agentsRoot, LOCK_FILENAME)
  try {
    return { ok: true, fd: fs.openSync(lockPath, 'wx') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        ok: false,
        contention: true,
        error:
          `Another export/refresh/cleanup operation appears to be in progress ` +
          `(lock file exists: ${lockPath}). If no other operation is running ` +
          `(e.g. after a crash), verify manually and remove the lock file yourself.`,
      }
    }
    return {
      ok: false,
      contention: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Release a lock acquired by this process. Always call from a finally block. */
function releaseLock(agentsRoot: string, fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    /* best effort */
  }
  try {
    fs.unlinkSync(path.join(agentsRoot, LOCK_FILENAME))
  } catch {
    /* best effort */
  }
}

/**
 * Run `fn` under the exclusive per-root mutation lock. On lock contention,
 * returns `{ locked: false, error }` without running `fn`. On success or
 * failure of `fn`, the lock is always released.
 */
function withLock<T>(
  agentsRoot: string,
  fn: () => T,
):
  | { locked: true; result: T }
  | { locked: false; error: string; isContention: boolean } {
  const acquired = acquireLock(agentsRoot)
  if (!acquired.ok) {
    return {
      locked: false,
      error: acquired.error,
      isContention: acquired.contention,
    }
  }
  try {
    return { locked: true, result: fn() }
  } finally {
    releaseLock(agentsRoot, acquired.fd)
  }
}

// ── Atomic write ──────────────────────────────────────────────────────────────

function atomicWriteString(destPath: string, content: string): void {
  const parentDir = path.dirname(destPath)
  const tmpPath = path.join(
    parentDir,
    `.${path.basename(destPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  try {
    fs.writeFileSync(tmpPath, content, { flag: 'w', mode: 0o644 })
    fs.renameSync(tmpPath, destPath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* best effort */
    }
    throw err
  }
}

// ── Transactional snapshot / rollback ─────────────────────────────────────────

/** Backup record: path → pre-operation content (undefined = was absent). */
type Backup = Map<string, string | undefined>

type SnapshotResult =
  | { ok: true; backup: Backup }
  | { ok: false; error: string }

/**
 * Snapshot each path's current content. Only ENOENT (absent) is treated as
 * "no prior content" — any other read failure (permission denied, EISDIR,
 * etc.) is a real problem and aborts the snapshot entirely so the caller
 * can refuse before the first mutating operation runs.
 */
function snapshotFiles(filePaths: string[]): SnapshotResult {
  const backup: Backup = new Map()
  for (const p of filePaths) {
    try {
      backup.set(p, fs.readFileSync(p, 'utf-8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        backup.set(p, undefined)
        continue
      }
      return {
        ok: false,
        error: `Cannot snapshot ${p}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  return { ok: true, backup }
}

/** Restore each path to its pre-operation state. Returns paths that failed to restore. */
function restoreFromBackup(backup: Backup): string[] {
  const failed: string[] = []
  for (const [p, content] of backup) {
    try {
      if (content === undefined) {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } else {
        fs.writeFileSync(p, content, 'utf-8')
      }
    } catch {
      failed.push(p)
    }
  }
  return failed
}

function rollbackMessage(failed: string[]): string {
  return failed.length === 0
    ? 'rolled back'
    : `partial rollback (restoration failed for: ${failed.map((p) => path.basename(p)).join(', ')})`
}

export interface TxResult {
  ok: boolean
  error?: string
  rollbackFailed: string[]
}

/**
 * Run a sequence of filesystem operations under snapshot/rollback protection.
 *
 * 1. Snapshot `pathsToWatch` (current content or absent marker).
 * 2. Execute each `op` in order. On the first throw, stop.
 * 3. On any failure: restore all watched paths to their snapshotted state.
 *    Returns `{ ok: false, error, rollbackFailed }` — `rollbackFailed` lists
 *    paths whose restoration itself failed (partial rollback, reported honestly).
 * 4. On full success: returns `{ ok: true, rollbackFailed: [] }`.
 *
 * Exported for direct testing; also used by all production commit/delete paths.
 */
export function runWithRollback(
  pathsToWatch: string[],
  ops: Array<() => void>,
): TxResult {
  const snapshot = snapshotFiles(pathsToWatch)
  if (!snapshot.ok) {
    return { ok: false, error: snapshot.error, rollbackFailed: [] }
  }
  const backup = snapshot.backup
  for (const op of ops) {
    try {
      op()
    } catch (err) {
      const rollbackFailed = restoreFromBackup(backup)
      const rb = rollbackMessage(rollbackFailed)
      return {
        ok: false,
        error: `${err instanceof Error ? err.message : String(err)} (${rb})`,
        rollbackFailed,
      }
    }
  }
  return { ok: true, rollbackFailed: [] }
}

// ── Ownership index ───────────────────────────────────────────────────────────

function ownedFilenames(manifest: PiSubagentsManifest | null): Set<string> {
  if (manifest === null) return new Set()
  const s = new Set<string>()
  for (const entry of manifest.files) {
    if (
      path.basename(entry.filename) === entry.filename &&
      !path.isAbsolute(entry.filename)
    )
      s.add(entry.filename)
  }
  return s
}

// ── Plan types ────────────────────────────────────────────────────────────────

export type PlanAction =
  | { action: 'create'; filename: string }
  | { action: 'update'; filename: string }
  | { action: 'refuse'; filename: string; reason: string }
  | { action: 'remove'; filename: string }
  | { action: 'skip'; filename: string }

export interface ExportPlan {
  status: 'ok' | 'error'
  error?: string
  agentsRoot: string
  actions: PlanAction[]
}

// ── Config-aware frontmatter application ────────────────────────────────────────

/** Extract `{ category, agentKey }` from a curated persona's `agents/<category>/<name>.md` source path. */
function parseSourceCategoryAndKey(sourceRelPath: string): {
  category: string | undefined
  agentKey: string
} {
  const parts = sourceRelPath.split('/')
  // agents/<category>/<name>.md
  if (parts.length >= 3 && parts[0] === 'agents') {
    const fileName = parts.at(-1) ?? ''
    return {
      category: parts[1],
      agentKey: fileName.replace(/\.md$/, ''),
    }
  }
  const fileName = parts.at(-1) ?? sourceRelPath
  return { category: undefined, agentKey: fileName.replace(/\.md$/, '') }
}

/** Look up an overlay by bare key or `category/key` qualified id. */
function lookupOverlay(
  map: Record<string, OverlayConfig> | undefined,
  category: string | undefined,
  agentKey: string,
): OverlayConfig | undefined {
  if (!map) return undefined
  if (category) {
    const qualified = map[`${category}/${agentKey}`]
    if (qualified) return qualified
  }
  return map[agentKey]
}

/**
 * Resolve the effective `model` and `thinking` values for a persona on the
 * `pi` harness through the shared routing resolver — the same precedence
 * (agent block > agent flat > category block > category flat for `model`;
 * agent block > category block, then the legacy `pi_subagents.thinking`
 * location, for the qualifier) that the OpenCode config hook and the Pi
 * delegate tool use. `model: null`/no model anywhere both omit the field
 * (export never falls back to a parent model the way the delegate does —
 * there is no parent session at export time).
 */
function resolveRoutedFields(
  overlays: SourcedOverlayConfigMap,
  piSubagentsOverlays: SourcedOverlayConfigMap,
  category: string | undefined,
  agentKey: string,
): { model: string | undefined; thinking: string | undefined } {
  const resolution = resolveRouting({
    overlays,
    piSubagentsOverlays,
    target: { agentKey, category: category ?? '' },
    harness: 'pi',
  })
  return {
    model: typeof resolution.model === 'string' ? resolution.model : undefined,
    thinking: resolution.qualifier,
  }
}

const OTHER_PI_SUBAGENTS_FRONTMATTER_FIELDS = [
  'max_turns',
  'tools',
  'skills',
] as const

/**
 * Resolve the effective `pi_subagents` fields that are NOT part of routing
 * (`max_turns`, `tools`, `skills`): category values apply first, per-agent
 * values override field-by-field (not whole-object replacement). `thinking`
 * moved to `resolveRoutedFields` (Unit 5) — it is routing, not export-only
 * metadata.
 */
function resolvePiSubagentsFields(
  config: SystematicConfig,
  category: string | undefined,
  agentKey: string,
): Record<string, unknown> {
  const categoryOverlay = category
    ? config.pi_subagents?.categories?.[category]
    : undefined
  const agentOverlay = lookupOverlay(
    config.pi_subagents?.agents,
    category,
    agentKey,
  )
  const result: Record<string, unknown> = {}
  for (const field of OTHER_PI_SUBAGENTS_FRONTMATTER_FIELDS) {
    if (agentOverlay && Object.hasOwn(agentOverlay, field)) {
      result[field] = agentOverlay[field]
    } else if (categoryOverlay && Object.hasOwn(categoryOverlay, field)) {
      result[field] = categoryOverlay[field]
    }
  }
  return result
}

/**
 * Re-render a generated persona's frontmatter with config-resolved `model`
 * and `pi_subagents` fields, preserving stable field order: description,
 * model, thinking, max_turns, tools, skills. `variant`/`temperature`/`top_p`
 * are never emitted (pi-subagents v0.14.3 has no equivalent fields).
 */
function applyConfigToContent(
  content: string,
  config: SystematicConfig,
  overlays: SourcedOverlayConfigMap,
  piSubagentsOverlays: SourcedOverlayConfigMap,
  category: string | undefined,
  agentKey: string,
): string {
  const { data, body } = parseFrontmatter<Record<string, unknown>>(content)
  const { model, thinking } = resolveRoutedFields(
    overlays,
    piSubagentsOverlays,
    category,
    agentKey,
  )
  const otherFields = resolvePiSubagentsFields(config, category, agentKey)

  const frontmatter: Record<string, unknown> = {}
  if (typeof data.description === 'string') {
    frontmatter.description = data.description
  }
  if (model !== undefined) frontmatter.model = model
  if (thinking !== undefined) frontmatter.thinking = thinking
  for (const field of OTHER_PI_SUBAGENTS_FRONTMATTER_FIELDS) {
    if (Object.hasOwn(otherFields, field)) {
      frontmatter[field] = otherFields[field]
    }
  }

  let frontmatterBlock: string
  if (Object.keys(frontmatter).length === 0) {
    frontmatterBlock = '---\n---'
  } else {
    const lines = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n')
    frontmatterBlock = `---\n${lines}\n---`
  }

  const trimmedBody = body.replace(/^\n+/, '')
  return `${frontmatterBlock}\n\n${trimmedBody}`
}

/**
 * Apply scope-appropriate effective config to every entry's rendered
 * content and recompute its hash. Pure — does not mutate the input array.
 */
function applyConfigToEntries(
  entries: ManifestEntry[],
  config: SystematicConfig,
  overlays: SourcedOverlayConfigMap,
  piSubagentsOverlays: SourcedOverlayConfigMap,
): ManifestEntry[] {
  return entries.map((entry) => {
    if (entry.status === 'excluded-critical' || !entry.content) return entry
    const { category, agentKey } = parseSourceCategoryAndKey(
      entry.sourceRelPath,
    )
    const content = applyConfigToContent(
      entry.content,
      config,
      overlays,
      piSubagentsOverlays,
      category,
      agentKey,
    )
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    return { ...entry, content, hash }
  })
}

/**
 * Generate the curated persona set and, when `configOptions` is provided,
 * apply the scope-appropriate effective config to each entry's frontmatter.
 * Throws (schema/config errors) or generator errors propagate to the caller,
 * which must fail closed before any write.
 */
function generateEntries(
  repoRoot: string,
  configOptions: ExportConfigOptions | undefined,
): ManifestEntry[] {
  const entries = generateAll(repoRoot)
  if (!configOptions) return entries
  const { config, overlays } = loadConfigWithSources(configOptions.cwd, {
    includeProject: configOptions.scope === 'project',
  })
  const piSubagentsOverlays = toSourcedPiSubagentsOverlays(config.pi_subagents)
  return applyConfigToEntries(entries, config, overlays, piSubagentsOverlays)
}

// ── Package root discovery ─────────────────────────────────────────────────────

function findPackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url)
  const dir = path.resolve(path.dirname(thisFile), '..', '..')
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  let candidate = path.dirname(thisFile)
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  throw new Error('Could not locate package root (no package.json found)')
}

// ── Preview helpers ────────────────────────────────────────────────────────────

function planExistingEntry(
  absRoot: string,
  filename: string,
  hash: string,
  owned: Set<string>,
): PlanAction {
  const diskContent = fs.readFileSync(path.join(absRoot, filename), 'utf-8')
  const diskHash = crypto.createHash('sha256').update(diskContent).digest('hex')
  if (owned.has(filename)) {
    return diskHash !== hash
      ? { action: 'update', filename }
      : { action: 'skip', filename }
  }
  return {
    action: 'refuse',
    filename,
    reason: 'File exists but is not owned by a previous export',
  }
}

function planEntryActions(
  absRoot: string,
  entries: ManifestEntry[],
  owned: Set<string>,
): PlanAction[] {
  const actions: PlanAction[] = []
  for (const entry of entries) {
    if (entry.status === 'excluded-critical' || !entry.content) continue
    const exists = fs.existsSync(path.join(absRoot, entry.filename))
    actions.push(
      exists
        ? planExistingEntry(absRoot, entry.filename, entry.hash, owned)
        : { action: 'create', filename: entry.filename },
    )
  }
  return actions
}

function planRemoveActions(
  absRoot: string,
  manifest: PiSubagentsManifest | null,
  currentFilenames: Set<string>,
): PlanAction[] {
  if (!manifest) return []
  const removes: PlanAction[] = []
  for (const mEntry of manifest.files) {
    if (currentFilenames.has(mEntry.filename)) continue
    const safe = safeFilePath(absRoot, mEntry.filename)
    if (safe !== null && fs.existsSync(safe))
      removes.push({ action: 'remove', filename: mEntry.filename })
  }
  return removes
}

// ── Preview ───────────────────────────────────────────────────────────────────

export function preview(
  agentsRoot: string,
  configOptions?: ExportConfigOptions,
): ExportPlan {
  const absRoot = path.resolve(agentsRoot)

  // Check manifest first — malformed manifest is an error
  const manifestResult = readManifestStrict(absRoot)
  if (manifestResult.kind === 'malformed') {
    return {
      status: 'error',
      error: `Malformed manifest: ${manifestResult.error}`,
      agentsRoot: absRoot,
      actions: [],
    }
  }
  const manifest = manifestResult.kind === 'ok' ? manifestResult.manifest : null

  let entries: ManifestEntry[]
  try {
    entries = generateEntries(findPackageRoot(), configOptions)
  } catch (err) {
    return {
      status: 'error',
      error: `Generator failed: ${err instanceof Error ? err.message : String(err)}`,
      agentsRoot: absRoot,
      actions: [],
    }
  }

  const owned = ownedFilenames(manifest)
  const currentFilenames = new Set(
    entries
      .filter((e) => e.status !== 'excluded-critical' && e.content)
      .map((e) => e.filename),
  )

  return {
    status: 'ok',
    agentsRoot: absRoot,
    actions: [
      ...planEntryActions(absRoot, entries, owned),
      ...planRemoveActions(absRoot, manifest, currentFilenames),
    ],
  }
}

// ── ExportResult ──────────────────────────────────────────────────────────────

export interface ExportResult {
  status: 'ok' | 'error'
  written: number
  skipped: number
  refused: Array<{ filename: string; reason: string }>
  error?: string
}

// ── exportPersonas internals ──────────────────────────────────────────────────

type ExportPair = { entry: ManifestEntry; safePath: string }
type RefuseRecord = { filename: string; reason: string }

function classifyOneExportEntry(
  absRoot: string,
  entry: ManifestEntry,
  owned: Set<string>,
): { kind: 'write' | 'skip' | 'refuse'; safePath?: string; reason?: string } {
  const safePath = safeFilePath(absRoot, entry.filename)
  if (safePath === null)
    return { kind: 'refuse', reason: 'Filename would escape agents root' }
  if (fs.existsSync(safePath) && !owned.has(entry.filename))
    return {
      kind: 'refuse',
      reason: 'File exists but is not owned by a previous export (user file)',
    }
  if (fs.existsSync(safePath)) {
    const diskHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(safePath, 'utf-8'))
      .digest('hex')
    if (diskHash === entry.hash) return { kind: 'skip', safePath }
  }
  return { kind: 'write', safePath }
}

function classifyExportEntries(
  absRoot: string,
  entries: ManifestEntry[],
  owned: Set<string>,
): {
  toWrite: ExportPair[]
  toSkip: ExportPair[]
  refused: RefuseRecord[]
  currentFilenames: Set<string>
} {
  const toWrite: ExportPair[] = []
  const toSkip: ExportPair[] = []
  const refused: RefuseRecord[] = []
  const currentFilenames = new Set<string>()

  for (const entry of entries) {
    if (entry.status === 'excluded-critical' || !entry.content) continue
    currentFilenames.add(entry.filename)
    const result = classifyOneExportEntry(absRoot, entry, owned)
    if (result.kind === 'refuse') {
      refused.push({
        filename: entry.filename,
        reason: result.reason ?? 'refused',
      })
    } else if (result.safePath !== undefined && result.kind === 'skip') {
      toSkip.push({ entry, safePath: result.safePath })
    } else if (result.safePath !== undefined) {
      toWrite.push({ entry, safePath: result.safePath })
    }
  }

  return { toWrite, toSkip, refused, currentFilenames }
}

function buildNewManifestFiles(
  toWrite: Array<{ entry: ManifestEntry; safePath: string }>,
  toSkip: Array<{ entry: ManifestEntry; safePath: string }>,
): ManifestFileEntry[] {
  const toFileEntry = (e: ManifestEntry): ManifestFileEntry => ({
    filename: e.filename,
    hash: e.hash,
    status:
      e.status === 'exported-with-warning'
        ? 'exported-with-warning'
        : 'exported',
  })
  return [
    ...toSkip.map(({ entry }) => toFileEntry(entry)),
    ...toWrite.map(({ entry }) => toFileEntry(entry)),
  ]
}

function makeExportError(error: string): ExportResult {
  return { status: 'error', written: 0, skipped: 0, refused: [], error }
}

function prepareExportRoot(agentsRoot: string): string | ExportResult {
  let preStat: fs.Stats | null = null
  try {
    preStat = fs.lstatSync(agentsRoot)
  } catch {
    /* absent */
  }
  if (preStat?.isSymbolicLink())
    return makeExportError(
      `Refusing to write under ${agentsRoot}: not a real directory (symlink detected)`,
    )
  try {
    fs.mkdirSync(agentsRoot, { recursive: true })
    return assertRealAgentsRoot(agentsRoot)
  } catch (err) {
    return makeExportError(err instanceof Error ? err.message : String(err))
  }
}

/** Throws if disk content at `filePath` does not match `expectedHash` (tamper/drift guard). */
function assertHashMatchesOrThrow(
  filePath: string,
  expectedHash: string,
  filename: string,
  verb: string,
): void {
  const diskContent = fs.readFileSync(filePath, 'utf-8')
  const diskHash = crypto.createHash('sha256').update(diskContent).digest('hex')
  if (diskHash !== expectedHash) {
    throw new Error(
      `Refusing to ${verb} "${filename}": content on disk does not match the ` +
        `manifest hash (drifted or tampered). Resolve manually or re-export/refresh first.`,
    )
  }
}

/** A deletion target with the manifest metadata needed to recheck its hash immediately before unlink. */
interface DeletionTarget {
  path: string
  filename: string
  hash: string
}

function findStalePaths(
  absRoot: string,
  prevManifest: PiSubagentsManifest | null,
  currentFilenames: Set<string>,
): DeletionTarget[] {
  if (!prevManifest) return []
  const stale: DeletionTarget[] = []
  for (const mEntry of prevManifest.files) {
    if (currentFilenames.has(mEntry.filename)) continue
    const safe = safeFilePath(absRoot, mEntry.filename)
    if (safe === null || !fs.existsSync(safe)) continue
    assertHashMatchesOrThrow(
      safe,
      mEntry.hash,
      mEntry.filename,
      'remove stale file',
    )
    stale.push({ path: safe, filename: mEntry.filename, hash: mEntry.hash })
  }
  return stale
}

// ── exportPersonas ────────────────────────────────────────────────────────────

export function exportPersonas(
  agentsRoot: string,
  configOptions?: ExportConfigOptions,
): ExportResult {
  // Resolve config first (fail closed before any mutation, including mkdir).
  let entries: ManifestEntry[]
  try {
    entries = generateEntries(findPackageRoot(), configOptions)
  } catch (err) {
    return makeExportError(
      `Failed to generate personas: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Scope-anchored lexical ancestor walk before any mutation (including mkdir).
  const anchor = anchorForScope(configOptions, agentsRoot)
  try {
    assertAnchoredPathSafe(anchor, path.resolve(agentsRoot))
  } catch (err) {
    return makeExportError(err instanceof Error ? err.message : String(err))
  }

  const rootOrErr = prepareExportRoot(agentsRoot)
  if (typeof rootOrErr !== 'string') return rootOrErr

  // Canonicalize anchor and root and require the root to remain within the
  // canonical anchor before any lock/read/mutation. Closes the raced-symlink
  // ancestor window the lexical walk above cannot (see doc comment).
  let absRoot: string
  try {
    absRoot = assertCanonicalRootWithinAnchor(anchor, rootOrErr)
  } catch (err) {
    return makeExportError(err instanceof Error ? err.message : String(err))
  }

  // Manifest read happens INSIDE the lock (below), not here: reading it
  // before acquiring the exclusive mutation lock would leave a TOCTOU
  // window where a concurrent operation could mutate the manifest between
  // this read and lock acquisition, making the read stale by the time
  // mutation actually happens.
  const lockResult = withLock(absRoot, (): ExportResult => {
    const manifestResult = readManifestStrict(absRoot)
    if (manifestResult.kind === 'malformed')
      return makeExportError(
        `Malformed manifest — refusing to export: ${manifestResult.error}`,
      )
    const prevManifest =
      manifestResult.kind === 'ok' ? manifestResult.manifest : null

    const owned = ownedFilenames(prevManifest)
    const { toWrite, toSkip, refused, currentFilenames } =
      classifyExportEntries(absRoot, entries, owned)
    let staleOwned: DeletionTarget[]
    try {
      staleOwned = findStalePaths(absRoot, prevManifest, currentFilenames)
    } catch (err) {
      return makeExportError(err instanceof Error ? err.message : String(err))
    }
    const newManifest = (): PiSubagentsManifest => ({
      generatedAt: new Date().toISOString(),
      agentsRoot: absRoot,
      files: buildNewManifestFiles(toWrite, toSkip),
    })

    const tx = runWithRollback(
      [
        ...toWrite.map((x) => x.safePath),
        ...staleOwned.map((x) => x.path),
        path.join(absRoot, MANIFEST_FILENAME),
      ],
      [
        ...toWrite.map(
          ({ entry, safePath }) =>
            () =>
              atomicWriteString(safePath, entry.content ?? ''),
        ),
        ...staleOwned.map(({ path: p, filename, hash }) => () => {
          if (fs.existsSync(p)) {
            // Recheck immediately before unlink: closes the TOCTOU window
            // between collection (findStalePaths, above) and this delete —
            // a writer could have replaced the file's content in between.
            assertHashMatchesOrThrow(p, hash, filename, 'remove stale file')
            fs.unlinkSync(p)
          }
        }),
        () => writeManifest(absRoot, newManifest()),
      ],
    )

    if (!tx.ok)
      return {
        status: 'error',
        written: 0,
        skipped: toSkip.length,
        refused,
        error: tx.error,
      }

    return {
      status: 'ok',
      written: toWrite.length,
      skipped: toSkip.length,
      refused,
    }
  })

  if (!lockResult.locked) return makeExportError(lockResult.error)
  return lockResult.result
}

// ── RefreshResult ─────────────────────────────────────────────────────────────

export interface RefreshResult {
  status: 'ok' | 'error'
  updated: number
  skippedUnowned: number
  error?: string
}

// ── refresh internals ─────────────────────────────────────────────────────────

type RefreshKind =
  | 'update'
  | 'keep'
  | 'skip-unowned'
  | 'skip-unexported'
  | 'ignore'

function classifyOneRefreshEntry(
  absRoot: string,
  entry: ManifestEntry,
  owned: Set<string>,
): { kind: RefreshKind; safePath?: string } {
  const safePath = safeFilePath(absRoot, entry.filename)
  if (safePath === null) return { kind: 'ignore' }
  const exists = fs.existsSync(safePath)
  if (exists && !owned.has(entry.filename))
    return { kind: 'skip-unowned', safePath }
  if (!exists && !owned.has(entry.filename)) return { kind: 'skip-unexported' }
  if (exists) {
    const diskHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(safePath, 'utf-8'))
      .digest('hex')
    if (diskHash === entry.hash) return { kind: 'keep', safePath }
  }
  return { kind: 'update', safePath }
}

function classifyRefreshEntries(
  absRoot: string,
  entries: ManifestEntry[],
  owned: Set<string>,
): { toUpdate: ExportPair[]; toKeep: ExportPair[]; skippedUnowned: number } {
  const toUpdate: ExportPair[] = []
  const toKeep: ExportPair[] = []
  let skippedUnowned = 0

  for (const entry of entries) {
    if (entry.status === 'excluded-critical' || !entry.content) continue
    const result = classifyOneRefreshEntry(absRoot, entry, owned)
    if (result.kind === 'skip-unowned') {
      skippedUnowned++
      continue
    }
    if (result.kind === 'ignore' || result.kind === 'skip-unexported') continue
    if (result.safePath !== undefined && result.kind === 'keep')
      toKeep.push({ entry, safePath: result.safePath })
    else if (result.safePath !== undefined)
      toUpdate.push({ entry, safePath: result.safePath })
  }

  return { toUpdate, toKeep, skippedUnowned }
}

function validateRefreshRoot(agentsRoot: string): string | RefreshResult {
  const absRoot = path.resolve(agentsRoot)
  if (!fs.existsSync(absRoot))
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: `Agents root does not exist: ${absRoot}. Run export first.`,
    }
  try {
    const stat = fs.lstatSync(absRoot)
    if (stat.isSymbolicLink())
      return {
        status: 'error',
        updated: 0,
        skippedUnowned: 0,
        error: `Refusing to write under ${absRoot}: not a real directory (symlink)`,
      }
  } catch (err) {
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return absRoot
}

// ── refresh ───────────────────────────────────────────────────────────────────

export function refresh(
  agentsRoot: string,
  configOptions?: ExportConfigOptions,
): RefreshResult {
  // Resolve config first (fail closed before any mutation).
  let entries: ManifestEntry[]
  try {
    entries = generateEntries(findPackageRoot(), configOptions)
  } catch (err) {
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: `Failed to generate personas: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const absRootCandidate = path.resolve(agentsRoot)

  // Scope-anchored lexical ancestor walk before any mutation (and before
  // existence checks, so a symlinked ancestor is rejected even if the
  // resolved target doesn't itself exist).
  const anchor = anchorForScope(configOptions, absRootCandidate)
  try {
    assertAnchoredPathSafe(anchor, absRootCandidate)
  } catch (err) {
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const rootOrErr = validateRefreshRoot(agentsRoot)
  if (typeof rootOrErr !== 'string') return rootOrErr

  // Canonicalize anchor and root and require the root to remain within the
  // canonical anchor before any lock/read/mutation. Closes the raced-symlink
  // ancestor window the lexical walk above cannot (see doc comment).
  let absRoot: string
  try {
    absRoot = assertCanonicalRootWithinAnchor(anchor, rootOrErr)
  } catch (err) {
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Manifest read happens INSIDE the lock (below), not here: reading it
  // before acquiring the exclusive mutation lock would leave a TOCTOU
  // window where a concurrent operation could mutate the manifest between
  // this read and lock acquisition, making the read stale by the time
  // mutation actually happens.
  const lockResult = withLock(absRoot, (): RefreshResult => {
    const manifestResult = readManifestStrict(absRoot)
    if (manifestResult.kind === 'malformed')
      return {
        status: 'error',
        updated: 0,
        skippedUnowned: 0,
        error: `Malformed manifest — refusing to refresh: ${manifestResult.error}`,
      }
    const manifest =
      manifestResult.kind === 'ok' ? manifestResult.manifest : null

    const { toUpdate, toKeep, skippedUnowned } = classifyRefreshEntries(
      absRoot,
      entries,
      ownedFilenames(manifest),
    )
    const needsManifest =
      manifest !== null || toUpdate.length + toKeep.length > 0
    const newManifest = (): PiSubagentsManifest => ({
      generatedAt: new Date().toISOString(),
      agentsRoot: absRoot,
      files: buildNewManifestFiles(toUpdate, toKeep),
    })

    const tx = runWithRollback(
      [
        ...toUpdate.map((x) => x.safePath),
        path.join(absRoot, MANIFEST_FILENAME),
      ],
      [
        ...toUpdate.map(
          ({ entry, safePath }) =>
            () =>
              atomicWriteString(safePath, entry.content ?? ''),
        ),
        ...(needsManifest ? [() => writeManifest(absRoot, newManifest())] : []),
      ],
    )

    if (!tx.ok)
      return { status: 'error', updated: 0, skippedUnowned, error: tx.error }

    return { status: 'ok', updated: toUpdate.length, skippedUnowned }
  })

  if (!lockResult.locked)
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: lockResult.error,
    }
  return lockResult.result
}

// ── CleanupResult ─────────────────────────────────────────────────────────────

export interface CleanupResult {
  status: 'ok' | 'error'
  error?: string
}

// ── cleanup ───────────────────────────────────────────────────────────────────

/**
 * Remove all manifest-owned files and the manifest, transactionally.
 *
 * Refuses if the manifest is malformed (throws).
 * If any unlink fails, rolls back all deletions and returns error result.
 * Reports rollback partial failures honestly.
 */
/** Collect existing hash-checked deletion targets and the manifest path (if present) for cleanup. */
function collectCleanupPaths(
  absRoot: string,
  manifest: PiSubagentsManifest,
): { targets: DeletionTarget[]; manifestPath: string | null } {
  const targets: DeletionTarget[] = []
  for (const entry of manifest.files) {
    const safe = safeFilePath(absRoot, entry.filename)
    if (safe === null || !fs.existsSync(safe)) continue
    assertHashMatchesOrThrow(safe, entry.hash, entry.filename, 'delete')
    targets.push({ path: safe, filename: entry.filename, hash: entry.hash })
  }
  const manifestPath = path.join(absRoot, MANIFEST_FILENAME)
  return {
    targets,
    manifestPath: fs.existsSync(manifestPath) ? manifestPath : null,
  }
}

export function cleanup(
  agentsRoot: string,
  configOptions?: ExportConfigOptions,
): CleanupResult {
  const absRootCandidate = path.resolve(agentsRoot)

  // Symlink-root rejection first (before any manifest read).
  const preStat = statOrNull(absRootCandidate)
  if (preStat?.isSymbolicLink())
    throw new Error(
      `Refusing to operate on ${absRootCandidate}: not a real directory (symlink detected)`,
    )

  // Scope-anchored lexical ancestor walk.
  const anchor = anchorForScope(configOptions, absRootCandidate)
  assertAnchoredPathSafe(anchor, absRootCandidate)

  // Idempotent no-op: an absent agents root has nothing to clean up. Short-
  // circuit before lock acquisition — the lock file lives inside agentsRoot,
  // so attempting to acquire it here would fail ENOENT and break the
  // established idempotent-no-op contract for a nonexistent root. Symlink
  // and non-directory roots were already refused above/remain refused by
  // the canonicalization below when the root does exist.
  if (!fs.existsSync(absRootCandidate)) return { status: 'ok' }

  // Canonicalize anchor and root and require the root to remain within the
  // canonical anchor before any lock/read/mutation. Closes the raced-symlink
  // ancestor window the lexical walk above cannot (see doc comment).
  const absRoot = assertCanonicalRootWithinAnchor(anchor, absRootCandidate)

  // Manifest read happens INSIDE the lock (below), not here: reading it
  // before acquiring the exclusive mutation lock would leave a TOCTOU
  // window where a concurrent operation could mutate the manifest between
  // this read and lock acquisition, making the read stale by the time
  // deletion actually happens. A malformed-manifest throw from inside the
  // locked callback propagates straight out of withLock (its `finally`
  // still releases the lock first) — no separate rethrow plumbing needed.
  type CleanupInner = { kind: 'absent' } | { kind: 'tx'; tx: TxResult }

  const lockResult = withLock(absRoot, (): CleanupInner => {
    const manifestResult = readManifestStrict(absRoot)
    if (manifestResult.kind === 'absent') return { kind: 'absent' }
    if (manifestResult.kind === 'malformed')
      throw new Error(
        `Malformed manifest — refusing to cleanup: ${manifestResult.error}`,
      )
    const manifest = manifestResult.manifest

    const { targets, manifestPath } = collectCleanupPaths(absRoot, manifest)
    const pathsToWatch = [
      ...targets.map((t) => t.path),
      ...(manifestPath ? [manifestPath] : []),
    ]
    const tx = runWithRollback(pathsToWatch, [
      ...targets.map(({ path: p, filename, hash }) => () => {
        if (fs.existsSync(p)) {
          // Recheck immediately before unlink: closes the TOCTOU window
          // between collection (collectCleanupPaths, above) and this
          // delete — a writer could have replaced the file's content in
          // between.
          assertHashMatchesOrThrow(p, hash, filename, 'delete')
          fs.unlinkSync(p)
        }
      }),
      ...(manifestPath
        ? [
            () => {
              if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath)
            },
          ]
        : []),
    ])
    return { kind: 'tx', tx }
  })

  if (!lockResult.locked) {
    // cleanup's established contract throws for fail-closed refusals
    // (malformed manifest, hostile filenames, symlinked root/ancestors);
    // lock contention is the same class of refusal-before-mutation, so it
    // throws too. A lock-file-creation failure for an unrelated reason
    // (e.g. permission denied on the directory) is an operational failure
    // like any other write failure, and returns a structured error result.
    if (lockResult.isContention) throw new Error(lockResult.error)
    return { status: 'error', error: lockResult.error }
  }

  if (lockResult.result.kind === 'absent') return { status: 'ok' }
  const tx = lockResult.result.tx

  if (!tx.ok) return { status: 'error', error: tx.error }
  return { status: 'ok' }
}
