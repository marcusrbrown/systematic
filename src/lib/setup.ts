import fs from 'node:fs'
import path from 'node:path'
import type { ParseError } from 'jsonc-parser'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  parseTree,
} from 'jsonc-parser'

/** The one package identity this module knows how to configure (literal check, not a resolver). */
export const SYSTEMATIC_PACKAGE_NAME = '@fro.bot/systematic'

/** The exact string written into a fresh Pi `packages` array entry. */
export const PI_PACKAGE_IDENTIFIER = `npm:${SYSTEMATIC_PACKAGE_NAME}`

export type Harness = 'opencode' | 'pi'

/** Discriminated result: exactly one of these two states, never a boolean pair. */
export type SetupResult =
  | { status: 'configured'; targetPath: string }
  | { status: 'already-configured'; targetPath: string }

const SETUP_ERROR_NAME = 'SetupError'

/** Creates a fail-closed validation error for this module (repo convention: no custom classes). */
function createSetupError(message: string): Error {
  const error = new Error(message)
  error.name = SETUP_ERROR_NAME
  return error
}

/** Type guard for errors raised by `createSetupError`. */
export function isSetupError(error: unknown): error is Error {
  return error instanceof Error && error.name === SETUP_ERROR_NAME
}

/**
 * Narrow filesystem seam for injecting failures (e.g. a broken `renameSync`)
 * in tests. Default implementation is real `node:fs`.
 */
export interface SetupFsOps {
  writeFileSync: typeof fs.writeFileSync
  renameSync: typeof fs.renameSync
  unlinkSync: typeof fs.unlinkSync
  chmodSync: typeof fs.chmodSync
}

const DEFAULT_OPS: SetupFsOps = {
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  chmodSync: fs.chmodSync,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bare identity, or `@<nonempty suffix>` — a trailing bare `@` does not count. */
function matchesIdentity(identifier: string, base: string): boolean {
  if (identifier === base) return true
  const prefix = `${base}@`
  return identifier.startsWith(prefix) && identifier.length > prefix.length
}

function isSystematicIdentifier(identifier: string): boolean {
  return matchesIdentity(identifier, SYSTEMATIC_PACKAGE_NAME)
}

function isPiSystematicIdentifier(identifier: string): boolean {
  return matchesIdentity(identifier, PI_PACKAGE_IDENTIFIER)
}

/** lstat that returns null only for an absent path and still observes dangling symlinks. */
function lstatOrNull(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function assertRealpathUnderCwd(dir: string, cwd: string): void {
  const realDir = fs.realpathSync(dir)
  const realCwd = fs.realpathSync(cwd)
  const relative = path.relative(realCwd, realDir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createSetupError(
      `Refusing to write under ${dir}: resolved directory escapes the project root`,
    )
  }
}

/** Requires a real parent directory contained beneath `cwd`. */
function assertParentTrusted(parentDir: string, cwd: string): void {
  const stat = lstatOrNull(parentDir)
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw createSetupError(
        `Refusing to write under ${parentDir}: not a real directory`,
      )
    }
    assertRealpathUnderCwd(parentDir, cwd)
    return
  }
  fs.mkdirSync(parentDir, { recursive: true })
  assertRealpathUnderCwd(parentDir, cwd)
}

/** Selects the first existing OpenCode config, including dangling symlinks. */
const OPENCODE_TARGET_CANDIDATES = [
  '.opencode/opencode.jsonc',
  '.opencode/opencode.json',
  'opencode.jsonc',
  'opencode.json',
] as const

function resolveOpenCodeTargetPath(cwd: string): string {
  const opencodeDirStat = lstatOrNull(path.join(cwd, '.opencode'))
  if (opencodeDirStat?.isSymbolicLink()) {
    return path.join(cwd, OPENCODE_TARGET_CANDIDATES[0])
  }

  for (const candidate of OPENCODE_TARGET_CANDIDATES) {
    const candidatePath = path.join(cwd, candidate)
    if (lstatOrNull(candidatePath) !== null) return candidatePath
  }
  return path.join(cwd, 'opencode.jsonc')
}

interface TrustedExisting {
  bytes: Buffer
  mode: number
}

const IS_WINDOWS = process.platform === 'win32'

const OPEN_FLAGS = IS_WINDOWS
  ? fs.constants.O_RDONLY
  : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK

/** Opens once without following POSIX symlinks and rejects non-regular files. */
function assertWindowsPreOpenTrust(targetPath: string): void {
  const preStat = lstatOrNull(targetPath)
  if (preStat && (preStat.isSymbolicLink() || !preStat.isFile())) {
    throw createSetupError(`Refusing to read ${targetPath}: not a regular file`)
  }
}

function openTrustedExisting(targetPath: string): TrustedExisting | null {
  if (IS_WINDOWS) assertWindowsPreOpenTrust(targetPath)

  let fd: number
  try {
    fd = fs.openSync(targetPath, OPEN_FLAGS)
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') return null
      if (error.code === 'ELOOP') {
        throw createSetupError(
          `Refusing to read ${targetPath}: target is a symlink`,
        )
      }
    }
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      throw createSetupError(
        `Refusing to read ${targetPath}: not a regular file`,
      )
    }
    return { bytes: fs.readFileSync(fd), mode: stat.mode & 0o777 }
  } finally {
    fs.closeSync(fd)
  }
}

/** Atomically stages a no-clobber backup, then replaces the target. */
function atomicWrite(
  targetPath: string,
  content: string,
  originalBytes: Buffer | null,
  mode: number,
  ops: SetupFsOps,
): void {
  const preserveMode = originalBytes !== null

  if (originalBytes !== null) {
    const backupPath = `${targetPath}.bak`
    if (lstatOrNull(backupPath) !== null) {
      throw createSetupError(
        `Refusing to write backup ${backupPath}: a file already exists at that path`,
      )
    }
    writeTempAndRename(backupPath, originalBytes, mode, preserveMode, ops)
  }

  writeTempAndRename(targetPath, content, mode, preserveMode, ops)
}

function writeTempAndRename(
  destPath: string,
  content: string | Buffer,
  mode: number,
  preserveExactMode: boolean,
  ops: SetupFsOps,
): void {
  const parentDir = path.dirname(destPath)
  const tempPath = makeTempPath(parentDir, path.basename(destPath))
  try {
    ops.writeFileSync(tempPath, content, { flag: 'wx', mode })
    if (preserveExactMode) {
      ops.chmodSync(tempPath, mode)
    }
    ops.renameSync(tempPath, destPath)
  } catch (error) {
    cleanupTemp(tempPath, ops)
    throw error
  }
}

function makeTempPath(parentDir: string, basename: string): string {
  return path.join(
    parentDir,
    `.${basename}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

function cleanupTemp(tempPath: string, ops: SetupFsOps): void {
  if (!fs.existsSync(tempPath)) return
  try {
    ops.unlinkSync(tempPath)
  } catch {
    // Best-effort cleanup; the original write/rename error is what matters.
  }
}

/** Rejects duplicate top-level property keys among `names` in the parsed tree. */
function assertNoDuplicateTopLevelKeys(
  rawText: string,
  targetPath: string,
  names: readonly string[],
): void {
  const root = parseTree(rawText)
  if (!root?.children) return
  const seen = new Set<string>()
  for (const child of root.children) {
    const keyNode = child.children?.[0]
    const key = keyNode?.value
    if (typeof key !== 'string' || !names.includes(key)) continue
    if (seen.has(key)) {
      throw createSetupError(
        `Invalid OpenCode config in ${targetPath}: duplicate top-level \`${key}\` key`,
      )
    }
    seen.add(key)
  }
}

function parseOpenCodeJsonc(rawText: string, targetPath: string): unknown {
  const errors: ParseError[] = []
  const parsed = parseJsonc(rawText, errors, {
    allowTrailingComma: true,
  }) as unknown
  if (errors.length > 0) {
    throw createSetupError(
      `Invalid OpenCode config in ${targetPath}: JSONC parse error (code ${errors[0]?.error})`,
    )
  }
  return parsed
}

function setupOpenCode(cwd: string, ops: SetupFsOps): SetupResult {
  const targetPath = resolveOpenCodeTargetPath(cwd)
  assertParentTrusted(path.dirname(targetPath), cwd)
  const existing = openTrustedExisting(targetPath)

  if (existing === null) {
    const content = `${JSON.stringify({ plugin: [SYSTEMATIC_PACKAGE_NAME] }, null, 2)}\n`
    atomicWrite(targetPath, content, null, 0o644, ops)
    return { status: 'configured', targetPath }
  }

  const rawText = existing.bytes.toString('utf8')
  assertNoDuplicateTopLevelKeys(rawText, targetPath, ['plugin', 'plugins'])
  const parsed = parseOpenCodeJsonc(rawText, targetPath)
  if (!isRecord(parsed)) {
    throw createSetupError(
      `Invalid OpenCode config in ${targetPath}: root must be an object`,
    )
  }

  if (Object.hasOwn(parsed, 'plugins')) {
    throw createSetupError(
      `Invalid OpenCode config in ${targetPath}: \`plugins\` (plural) is not supported by OpenCode's schema; use singular \`plugin\``,
    )
  }

  if (!Object.hasOwn(parsed, 'plugin')) {
    const edits = modify(rawText, ['plugin'], [SYSTEMATIC_PACKAGE_NAME], {})
    atomicWrite(
      targetPath,
      applyEdits(rawText, edits),
      existing.bytes,
      existing.mode,
      ops,
    )
    return { status: 'configured', targetPath }
  }

  const existingValue = parsed.plugin
  if (!Array.isArray(existingValue)) {
    throw createSetupError(
      `Invalid OpenCode config in ${targetPath}: \`plugin\` must be an array`,
    )
  }

  const identifiers: string[] = []
  for (const entry of existingValue) {
    if (typeof entry !== 'string') {
      throw createSetupError(
        `Invalid OpenCode config in ${targetPath}: \`plugin\` contains a non-string entry`,
      )
    }
    identifiers.push(entry)
  }

  if (identifiers.some((identifier) => isSystematicIdentifier(identifier))) {
    return { status: 'already-configured', targetPath }
  }

  const edits = modify(
    rawText,
    ['plugin', existingValue.length],
    SYSTEMATIC_PACKAGE_NAME,
    {},
  )
  atomicWrite(
    targetPath,
    applyEdits(rawText, edits),
    existing.bytes,
    existing.mode,
    ops,
  )
  return { status: 'configured', targetPath }
}

function getPiEntryIdentifier(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (isRecord(entry) && typeof entry.source === 'string') return entry.source
  return null
}

/**
 * A matching tagged object counts as already-configured only when it can't
 * be shown to disable/filter what Systematic needs (`autoload: false`, or an
 * `extensions`/`skills` filter list). Other filters (`prompts`, `themes`)
 * don't affect Systematic and are ignored.
 */
function assertPiTaggedEntryUsable(entry: unknown, targetPath: string): void {
  if (!isRecord(entry)) return
  if (entry.autoload === false) {
    throw createSetupError(
      `Invalid Pi settings in ${targetPath}: the existing \`${SYSTEMATIC_PACKAGE_NAME}\` package entry has \`autoload: false\`, which may prevent Systematic from loading; remove that flag or the entry before re-running setup`,
    )
  }
  if (Object.hasOwn(entry, 'extensions') || Object.hasOwn(entry, 'skills')) {
    throw createSetupError(
      `Invalid Pi settings in ${targetPath}: the existing \`${SYSTEMATIC_PACKAGE_NAME}\` package entry declares an \`extensions\`/\`skills\` filter, which cannot be proven safe for Systematic's extension/skills; adjust the filter before re-running setup`,
    )
  }
}

function setupPi(cwd: string, ops: SetupFsOps): SetupResult {
  const targetPath = path.join(cwd, '.pi', 'settings.json')
  assertParentTrusted(path.dirname(targetPath), cwd)
  const existing = openTrustedExisting(targetPath)

  if (existing === null) {
    const content = `${JSON.stringify({ packages: [PI_PACKAGE_IDENTIFIER] }, null, 2)}\n`
    atomicWrite(targetPath, content, null, 0o644, ops)
    return { status: 'configured', targetPath }
  }

  const rawText = existing.bytes.toString('utf8')
  assertNoDuplicateTopLevelKeys(rawText, targetPath, ['packages'])
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    throw createSetupError(
      `Invalid Pi settings in ${targetPath}: unable to parse JSON (${errorMessage(error)})`,
    )
  }
  if (!isRecord(parsed)) {
    throw createSetupError(
      `Invalid Pi settings in ${targetPath}: root must be an object`,
    )
  }

  const existingPackages = parsed.packages

  if (existingPackages === undefined) {
    const edits = modify(rawText, ['packages'], [PI_PACKAGE_IDENTIFIER], {})
    atomicWrite(
      targetPath,
      applyEdits(rawText, edits),
      existing.bytes,
      existing.mode,
      ops,
    )
    return { status: 'configured', targetPath }
  }

  if (!Array.isArray(existingPackages)) {
    throw createSetupError(
      `Invalid Pi settings in ${targetPath}: \`packages\` must be an array`,
    )
  }

  const identifiers: string[] = []
  for (const entry of existingPackages) {
    const identifier = getPiEntryIdentifier(entry)
    if (identifier === null) {
      throw createSetupError(
        `Invalid Pi settings in ${targetPath}: \`packages\` contains an entry of unsupported shape`,
      )
    }
    identifiers.push(identifier)
  }

  const matchIndex = identifiers.findIndex((identifier) =>
    isPiSystematicIdentifier(identifier),
  )
  if (matchIndex !== -1) {
    assertPiTaggedEntryUsable(existingPackages[matchIndex], targetPath)
    return { status: 'already-configured', targetPath }
  }

  const edits = modify(
    rawText,
    ['packages', existingPackages.length],
    PI_PACKAGE_IDENTIFIER,
    {},
  )
  atomicWrite(
    targetPath,
    applyEdits(rawText, edits),
    existing.bytes,
    existing.mode,
    ops,
  )
  return { status: 'configured', targetPath }
}

/**
 * Configures the given harness's project-local config to load
 * `@fro.bot/systematic`. Project-local only -- no `--global` mode. Writes
 * are atomic, backed-up on real mutation, idempotent, and isolated per
 * harness (setting up one never touches the other's config file).
 *
 * `opsOverride` is an injectable filesystem seam for tests exercising
 * failure/cleanup paths; production callers should omit it.
 */
export function setupHarness(
  harness: Harness,
  cwd: string,
  opsOverride?: Partial<SetupFsOps>,
): SetupResult {
  const ops: SetupFsOps = { ...DEFAULT_OPS, ...opsOverride }

  switch (harness) {
    case 'opencode':
      return setupOpenCode(cwd, ops)
    case 'pi':
      return setupPi(cwd, ops)
    default:
      throw createSetupError(
        `Unknown harness: ${String(harness)}. Use: opencode, pi`,
      )
  }
}
