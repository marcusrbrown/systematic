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
import type { OverlayConfig, SystematicConfig } from './config.js'
import { loadConfigWithSources } from './config.js'
import { parseFrontmatter } from './frontmatter.js'
import type { ManifestEntry } from './pi-subagents-personas.js'
import { generateAll } from './pi-subagents-personas.js'

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

export const MANIFEST_FILENAME = '.systematic-pi-subagents-manifest.json'

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

// ── Manifest I/O ──────────────────────────────────────────────────────────────

/**
 * Read and validate the manifest at agentsRoot. Returns a typed result that
 * distinguishes absent (no file), ok (valid manifest), and malformed
 * (invalid JSON, wrong schema, duplicates, unsafe filenames).
 */
/** Validate a parsed manifest object. Returns an error string or null if valid. */
function validateManifestObject(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null)
    return 'Manifest root must be an object'
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.files))
    return 'Manifest "files" field must be an array'
  const seenFilenames = new Set<string>()
  for (const entry of obj.files as unknown[]) {
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
  }
  return null
}

export function readManifestStrict(agentsRoot: string): ManifestReadResult {
  const manifestPath = path.join(agentsRoot, MANIFEST_FILENAME)

  // Distinguish absent from read-error
  let stat: fs.Stats | null = null
  try {
    stat = fs.lstatSync(manifestPath)
  } catch {
    return { kind: 'absent' }
  }
  if (!stat.isFile())
    return {
      kind: 'malformed',
      error: `Manifest path exists but is not a regular file: ${manifestPath}`,
    }

  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8')
  } catch (err) {
    return {
      kind: 'malformed',
      error: `Cannot read manifest: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

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

function snapshotFiles(filePaths: string[]): Backup {
  const backup: Backup = new Map()
  for (const p of filePaths) {
    try {
      backup.set(p, fs.readFileSync(p, 'utf-8'))
    } catch {
      backup.set(p, undefined)
    }
  }
  return backup
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
  const backup = snapshotFiles(pathsToWatch)
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
 * Resolve the effective `model` value for a persona: per-agent overlay beats
 * category overlay; explicit `model: null` on the winning overlay means
 * "omit" (never fall through to a lower-precedence value).
 */
function resolveModel(
  config: SystematicConfig,
  category: string | undefined,
  agentKey: string,
): string | undefined {
  const agentOverlay = lookupOverlay(config.agents, category, agentKey)
  if (agentOverlay && Object.hasOwn(agentOverlay, 'model')) {
    const value = agentOverlay.model
    return typeof value === 'string' ? value : undefined
  }
  const categoryOverlay = category ? config.categories?.[category] : undefined
  if (categoryOverlay && Object.hasOwn(categoryOverlay, 'model')) {
    const value = categoryOverlay.model
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

const PI_SUBAGENTS_FRONTMATTER_FIELDS = [
  'thinking',
  'max_turns',
  'tools',
  'skills',
] as const

/**
 * Resolve the effective `pi_subagents` fields for a persona: category
 * values apply first, per-agent values override field-by-field (not
 * whole-object replacement).
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
  for (const field of PI_SUBAGENTS_FRONTMATTER_FIELDS) {
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
 * are never emitted (pi-subagents v0.14.1 has no equivalent fields).
 */
function applyConfigToContent(
  content: string,
  config: SystematicConfig,
  category: string | undefined,
  agentKey: string,
): string {
  const { data, body } = parseFrontmatter<Record<string, unknown>>(content)
  const model = resolveModel(config, category, agentKey)
  const piSubagentsFields = resolvePiSubagentsFields(config, category, agentKey)

  const frontmatter: Record<string, unknown> = {}
  if (typeof data.description === 'string') {
    frontmatter.description = data.description
  }
  if (model !== undefined) frontmatter.model = model
  for (const field of PI_SUBAGENTS_FRONTMATTER_FIELDS) {
    if (Object.hasOwn(piSubagentsFields, field)) {
      frontmatter[field] = piSubagentsFields[field]
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
): ManifestEntry[] {
  return entries.map((entry) => {
    if (entry.status === 'excluded-critical' || !entry.content) return entry
    const { category, agentKey } = parseSourceCategoryAndKey(
      entry.sourceRelPath,
    )
    const content = applyConfigToContent(
      entry.content,
      config,
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
  const config = loadConfigWithSources(configOptions.cwd, {
    includeProject: configOptions.scope === 'project',
  }).config
  return applyConfigToEntries(entries, config)
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

function findStalePaths(
  absRoot: string,
  prevManifest: PiSubagentsManifest | null,
  currentFilenames: Set<string>,
): string[] {
  if (!prevManifest) return []
  const stale: string[] = []
  for (const mEntry of prevManifest.files) {
    if (currentFilenames.has(mEntry.filename)) continue
    const safe = safeFilePath(absRoot, mEntry.filename)
    if (safe !== null && fs.existsSync(safe)) stale.push(safe)
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

  const rootOrErr = prepareExportRoot(agentsRoot)
  if (typeof rootOrErr !== 'string') return rootOrErr
  const absRoot = rootOrErr

  // Refuse on malformed manifest before any mutation
  const manifestResult = readManifestStrict(absRoot)
  if (manifestResult.kind === 'malformed')
    return makeExportError(
      `Malformed manifest — refusing to export: ${manifestResult.error}`,
    )
  const prevManifest =
    manifestResult.kind === 'ok' ? manifestResult.manifest : null

  const owned = ownedFilenames(prevManifest)
  const { toWrite, toSkip, refused, currentFilenames } = classifyExportEntries(
    absRoot,
    entries,
    owned,
  )
  const staleOwned = findStalePaths(absRoot, prevManifest, currentFilenames)
  const newManifest = (): PiSubagentsManifest => ({
    generatedAt: new Date().toISOString(),
    agentsRoot: absRoot,
    files: buildNewManifestFiles(toWrite, toSkip),
  })

  const tx = runWithRollback(
    [
      ...toWrite.map((x) => x.safePath),
      ...staleOwned,
      path.join(absRoot, MANIFEST_FILENAME),
    ],
    [
      ...toWrite.map(
        ({ entry, safePath }) =>
          () =>
            atomicWriteString(safePath, entry.content ?? ''),
      ),
      ...staleOwned.map((p) => () => {
        if (fs.existsSync(p)) fs.unlinkSync(p)
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

  const rootOrErr = validateRefreshRoot(agentsRoot)
  if (typeof rootOrErr !== 'string') return rootOrErr
  const absRoot = rootOrErr

  // Refuse on malformed manifest before any mutation
  const manifestResult = readManifestStrict(absRoot)
  if (manifestResult.kind === 'malformed')
    return {
      status: 'error',
      updated: 0,
      skippedUnowned: 0,
      error: `Malformed manifest — refusing to refresh: ${manifestResult.error}`,
    }
  const manifest = manifestResult.kind === 'ok' ? manifestResult.manifest : null

  const { toUpdate, toKeep, skippedUnowned } = classifyRefreshEntries(
    absRoot,
    entries,
    ownedFilenames(manifest),
  )
  const needsManifest = manifest !== null || toUpdate.length + toKeep.length > 0
  const newManifest = (): PiSubagentsManifest => ({
    generatedAt: new Date().toISOString(),
    agentsRoot: absRoot,
    files: buildNewManifestFiles(toUpdate, toKeep),
  })

  const tx = runWithRollback(
    [...toUpdate.map((x) => x.safePath), path.join(absRoot, MANIFEST_FILENAME)],
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
/** Collect existing file paths to delete during cleanup. */
function collectCleanupPaths(
  absRoot: string,
  manifest: PiSubagentsManifest,
): string[] {
  const paths: string[] = []
  for (const entry of manifest.files) {
    const safe = safeFilePath(absRoot, entry.filename)
    if (safe !== null && fs.existsSync(safe)) paths.push(safe)
  }
  const manifestPath = path.join(absRoot, MANIFEST_FILENAME)
  if (fs.existsSync(manifestPath)) paths.push(manifestPath)
  return paths
}

export function cleanup(agentsRoot: string): CleanupResult {
  const absRoot = path.resolve(agentsRoot)
  const manifestResult = readManifestStrict(absRoot)
  if (manifestResult.kind === 'absent') return { status: 'ok' }
  if (manifestResult.kind === 'malformed')
    throw new Error(
      `Malformed manifest — refusing to cleanup: ${manifestResult.error}`,
    )
  const manifest = manifestResult.manifest

  const pathsToDelete = collectCleanupPaths(absRoot, manifest)
  const tx = runWithRollback(
    pathsToDelete,
    pathsToDelete.map((p) => () => {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }),
  )

  if (!tx.ok) return { status: 'error', error: tx.error }
  return { status: 'ok' }
}
