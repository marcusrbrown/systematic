/**
 * The `connect` config block: the allow list of projects that `ce:connect`
 * may read, a reader that fails closed, a per-entry resolver that says why an
 * entry did not match, and the table of hosts where the researcher's tool
 * limits have host-specific evidence.
 *
 * Import rule: this module may import only `jsonc-parser`, node builtins,
 * `search-bounded-read.ts` and `search-project-identity.ts` (both node
 * builtins only). It must never import zod, `config.ts`, `config-schema.ts` or
 * `search-user-config.ts`: the `ce:connect` helper bundles it, and any of those
 * would drag the config loader and zod into that bundle. `config-schema.ts`
 * imports the limits from here and tags the same block `trust:
 * 'project-or-higher'`; the dependency runs one way.
 *
 * The block also holds named `groups` of allow-list-form entries. A group
 * narrows a run to part of the allow list and never adds a project: nothing
 * here checks that a member is on the allow list; the selection step does,
 * on resolved main roots.
 *
 * Trust: `connect` is user-only. User config, `OPENCODE_CONFIG_DIR` config and
 * the `systematic.local` file beside each may set it. `config.ts` strips it
 * from project config with a warning, and this reader never opens a project
 * file at all, so a repository cannot widen the list on any surface.
 *
 * Fail closed: the block is validated whole. An unknown key, a wrong type or
 * a list over its limit makes that layer's block unreadable, and an
 * unreadable block contributes no entries. A missing, unparseable, oversize
 * or non-regular file contributes none either. No failure can add an entry
 * the user did not write. The four layers merge, the allow lists by union and
 * the groups by name (a later layer replaces a same-named group whole), so a
 * layer that fails drops only its own entries and groups.
 *
 * Warnings name config files and reasons, never an allow-list entry: an entry
 * is a project the user chose to expose, and a warning can reach logs and
 * replies that the project is not allowed to see.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser'
import { readBytesBounded } from './search-bounded-read.js'
import { resolveProjectIdentity } from './search-project-identity.js'

// ── Limits ──────────────────────────────────────────────────────────────────

/** The allow list holds at most this many entries. */
export const MAX_ALLOW_PROJECTS = 64

/** One allow-list entry is at most this many characters. */
export const MAX_ALLOW_PROJECT_LENGTH = 4096

/** Largest config file the reader accepts. A larger file is unreadable. */
export const MAX_CONNECT_CONFIG_BYTES = 1024 * 1024

/** Longest file path or reason echoed into a warning. */
const MAX_DIAGNOSTIC_LENGTH = 200

/** One config layer holds at most this many groups. */
export const MAX_CONNECT_GROUPS = 32

/** A group name: lowercase letters, digits and hyphens, one to 64 characters, led by a letter or digit. */
export const CONNECT_GROUP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The `connect` block's keys. */
const ALLOW_PROJECTS_KEY = 'allow_projects'
const GROUPS_KEY = 'groups'

// ── The block ───────────────────────────────────────────────────────────────

/** Group name to member list. A member has the form of an allow-list entry. */
export type ConnectGroups = Record<string, string[]>

export interface ConnectSettings {
  allow_projects: string[]
  groups?: ConnectGroups
}

export type ConnectBlockValidation =
  | {
      readonly ok: true
      readonly allowProjects: string[]
      readonly groups: ConnectGroups
    }
  | { readonly ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` is a list of at most `max` non-empty, bounded strings, and not shorter than `min`. */
function readEntryList(
  value: unknown,
  min: number,
  max: number,
): string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return undefined
  }
  const entries: string[] = []
  for (const entry of value as unknown[]) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_ALLOW_PROJECT_LENGTH
    ) {
      return undefined
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Read `groups`: at most `MAX_CONNECT_GROUPS` entries, each named by
 * `CONNECT_GROUP_NAME_PATTERN` and holding one to `MAX_ALLOW_PROJECTS` members
 * of the allow-list entry form. Shape only: whether a member is on the allow
 * list is the caller's question at selection time.
 */
function readGroups(value: unknown): ConnectGroups | undefined {
  if (!isRecord(value)) return undefined
  const names = Object.keys(value)
  if (names.length > MAX_CONNECT_GROUPS) return undefined
  const groups: ConnectGroups = {}
  for (const name of names) {
    if (!CONNECT_GROUP_NAME_PATTERN.test(name)) return undefined
    const members = readEntryList(value[name], 1, MAX_ALLOW_PROJECTS)
    if (members === undefined) return undefined
    groups[name] = members
  }
  return groups
}

/**
 * Validate a `connect` block with plain guards. The block is valid when it is
 * an object whose only keys, if any, are `allow_projects` and `groups`.
 * `allow_projects` holds at most `MAX_ALLOW_PROJECTS` non-empty strings of at
 * most `MAX_ALLOW_PROJECT_LENGTH` characters. `groups` maps names to member
 * lists as `readGroups` describes. The zod schema in `config-schema.ts`
 * accepts and rejects the same values; a test pins the two together.
 */
export function validateConnectBlock(value: unknown): ConnectBlockValidation {
  if (!isRecord(value)) return { ok: false }
  if (
    Object.keys(value).some(
      (key) => key !== ALLOW_PROJECTS_KEY && key !== GROUPS_KEY,
    )
  ) {
    return { ok: false }
  }
  const allowProjects = readEntryList(
    Object.hasOwn(value, ALLOW_PROJECTS_KEY) ? value[ALLOW_PROJECTS_KEY] : [],
    0,
    MAX_ALLOW_PROJECTS,
  )
  if (allowProjects === undefined) return { ok: false }
  const groups = readGroups(
    Object.hasOwn(value, GROUPS_KEY) ? value[GROUPS_KEY] : {},
  )
  if (groups === undefined) return { ok: false }
  return { ok: true, allowProjects, groups }
}

// ── Layer discovery ─────────────────────────────────────────────────────────
//
// The same four layers, in the same order, as the search reader
// (`selectUserLevelConfigFiles`). The functions are repeated here because that
// module imports zod; a parity test pins the two together.

export interface ConnectConfigOptions {
  readonly homeDir?: string
  readonly userConfigDir?: string
  /** `null` or a blank string means no custom directory. Leave the key out to read `OPENCODE_CONFIG_DIR`. */
  readonly customConfigDir?: string | null
}

export interface ConnectConfigDirs {
  readonly homeDir: string
  readonly userConfigDir: string
  readonly customConfigDir: string | undefined
}

export type ConnectConfigLayer =
  | 'user'
  | 'user.local'
  | 'custom'
  | 'custom.local'

export interface ConnectConfigFile {
  readonly layer: ConnectConfigLayer
  readonly path: string
}

export interface ConnectConfigSelection {
  readonly files: readonly ConnectConfigFile[]
  /** The custom directory is the user directory, spelled the same way or reached through a symlink. */
  readonly aliased: boolean
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** Whether a directory entry exists at `target`, a dangling link included. */
function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    const code = errorCode(error)
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

function selectConfigFile(dir: string, basename: string): string {
  const jsoncPath = path.join(dir, `${basename}.jsonc`)
  return entryExists(jsoncPath) ? jsoncPath : path.join(dir, `${basename}.json`)
}

function realpathOrResolved(dir: string): string {
  const resolved = path.resolve(dir)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function resolveConnectConfigDirs(
  options?: ConnectConfigOptions,
): ConnectConfigDirs {
  const homeDir = options?.homeDir ?? os.homedir()
  const userConfigDir =
    options?.userConfigDir ?? path.join(homeDir, '.config/opencode')
  const rawCustom =
    options !== undefined && Object.hasOwn(options, 'customConfigDir')
      ? options.customConfigDir?.trim()
      : process.env.OPENCODE_CONFIG_DIR?.trim()
  return { homeDir, userConfigDir, customConfigDir: rawCustom || undefined }
}

export function selectConnectConfigFiles(
  dirs: ConnectConfigDirs,
): ConnectConfigSelection {
  const files: ConnectConfigFile[] = [
    {
      layer: 'user',
      path: selectConfigFile(dirs.userConfigDir, 'systematic'),
    },
    {
      layer: 'user.local',
      path: selectConfigFile(dirs.userConfigDir, 'systematic.local'),
    },
  ]
  const custom = dirs.customConfigDir
  if (!custom) return { files, aliased: false }
  files.push(
    { layer: 'custom', path: selectConfigFile(custom, 'systematic') },
    {
      layer: 'custom.local',
      path: selectConfigFile(custom, 'systematic.local'),
    },
  )
  const aliased =
    path.resolve(custom) === path.resolve(dirs.userConfigDir) ||
    realpathOrResolved(custom) === realpathOrResolved(dirs.userConfigDir)
  return { files, aliased }
}

// ── Containment ─────────────────────────────────────────────────────────────

export type ContainerRefusal = 'checkout' | 'allowed-root'

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

/** Whether `dir` or any ancestor holds a `.git` entry of any kind. */
function insideCheckout(dir: string): boolean {
  let current = dir
  for (;;) {
    if (entryExists(path.join(current, '.git'))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * Why `dir` may not hold configuration or state, or `undefined` when it may.
 * A directory is refused when it is, or sits inside, an allowed root
 * (`allowed-root`), or when it or any ancestor holds a `.git` entry
 * (`checkout`). A repository is untrusted input, so what it holds must not
 * steer what the helper reads or where it writes. Both sides are compared as
 * realpaths when they exist.
 */
export function containerRefusal(
  dir: string,
  allowedRoots: readonly string[],
): ContainerRefusal | undefined {
  const real = realpathOrResolved(dir)
  for (const root of allowedRoots) {
    if (isInside(real, realpathOrResolved(root))) return 'allowed-root'
  }
  return insideCheckout(real) ? 'checkout' : undefined
}

// ── The reader ──────────────────────────────────────────────────────────────

export interface ConnectAllowListLoad {
  /** The union of the readable layers' entries, in layer order, duplicates removed. */
  readonly allowProjects: readonly string[]
  /**
   * The readable layers' groups by name. A later layer replaces a same-named
   * group whole. A member is not checked against the allow list here.
   */
  readonly groups: Readonly<Record<string, readonly string[]>>
  /** Some layer's file or block could not be read and contributed nothing. */
  readonly unreadable: boolean
  /** One line per problem. They name files and reasons, never an allow-list entry. */
  readonly warnings: readonly string[]
  /** Set when the custom config directory was refused and none of its files were read. */
  readonly customDirRefused?: ContainerRefusal
}

type BlockRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'read'
      readonly allowProjects: readonly string[]
      readonly groups: ConnectGroups
    }

/** Make `text` fit on one line of a warning: no control characters, bounded. */
function displaySafe(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? '?' : char
  }
  return out.length > MAX_DIAGNOSTIC_LENGTH
    ? `${out.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}\u2026`
    : out
}

function readConnectBlock(filePath: string): BlockRead {
  const read = readBytesBounded(filePath, MAX_CONNECT_CONFIG_BYTES)
  switch (read.kind) {
    case 'absent':
      // `absent` is also what a dangling link reports; selection chose it.
      return entryExists(filePath)
        ? { kind: 'failed', reason: 'unable to read file' }
        : { kind: 'absent' }
    case 'not-regular':
      return { kind: 'failed', reason: 'not a regular file' }
    case 'too-large':
      return {
        kind: 'failed',
        reason: `file is larger than ${MAX_CONNECT_CONFIG_BYTES / (1024 * 1024)} MB`,
      }
    case 'failed':
      return { kind: 'failed', reason: 'unable to read file' }
    case 'bytes':
      break
  }
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(read.bytes.toString('utf-8'), errors, {
    allowTrailingComma: true,
  })
  const firstError = errors[0]
  if (firstError) {
    return {
      kind: 'failed',
      reason: `JSONC parse error: ${printParseErrorCode(firstError.error)}`,
    }
  }
  if (!isRecord(parsed)) {
    return { kind: 'failed', reason: 'root must be an object' }
  }
  if (!Object.hasOwn(parsed, 'connect')) {
    return { kind: 'read', allowProjects: [], groups: {} }
  }
  const validation = validateConnectBlock(parsed.connect)
  return validation.ok
    ? {
        kind: 'read',
        allowProjects: validation.allowProjects,
        groups: validation.groups,
      }
    : { kind: 'failed', reason: 'the connect block is not valid' }
}

function expandHome(entry: string, homeDir: string): string {
  if (entry === '~') return homeDir
  if (entry.startsWith('~/') || entry.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, entry.slice(2))
  }
  return entry
}

/** The realpath of every entry that is absolute and exists. A bad entry is skipped. */
function existingRoots(
  entries: readonly string[],
  homeDir: string,
): readonly string[] {
  const roots: string[] = []
  for (const entry of entries) {
    const expanded = expandHome(entry, homeDir)
    if (!path.isAbsolute(expanded)) continue
    try {
      roots.push(fs.realpathSync.native(expanded))
    } catch {
      // A stale entry roots nothing.
    }
  }
  return roots
}

/**
 * Read the allow list from the user-level files: user, user.local, then
 * custom and custom.local when a custom directory is set. It never reads
 * project config and never throws.
 *
 * The custom directory is refused, and none of its files are opened, when it
 * is inside an allowed root of the user layers or inside a checkout: a
 * repository must not be able to supply the file that names the projects the
 * helper reads. A custom directory that is the user directory is not a second
 * source and is not refused.
 */
export function loadConnectAllowList(
  options?: ConnectConfigOptions,
): ConnectAllowListLoad {
  const dirs = resolveConnectConfigDirs(options)
  const selection = selectConnectConfigFiles(dirs)
  const warnings: string[] = []
  const entries = new Set<string>()
  const groups: ConnectGroups = {}
  let unreadable = false

  const readLayer = (file: ConnectConfigFile): void => {
    const read = readConnectBlock(file.path)
    if (read.kind === 'absent') return
    if (read.kind === 'failed') {
      unreadable = true
      warnings.push(
        `[systematic] connect settings in ${displaySafe(file.path)} could not be read (${read.reason}); the allow list and groups from that file were ignored.`,
      )
      return
    }
    for (const entry of read.allowProjects) entries.add(entry)
    for (const [name, members] of Object.entries(read.groups)) {
      groups[name] = [...members]
    }
  }

  const isUserLayer = (file: ConnectConfigFile): boolean =>
    file.layer === 'user' || file.layer === 'user.local'
  for (const file of selection.files.filter(isUserLayer)) readLayer(file)

  const customFiles = selection.files.filter((file) => !isUserLayer(file))
  let customDirRefused: ContainerRefusal | undefined
  if (customFiles.length > 0 && !selection.aliased && dirs.customConfigDir) {
    customDirRefused = containerRefusal(
      dirs.customConfigDir,
      existingRoots([...entries], dirs.homeDir),
    )
    if (customDirRefused === undefined) {
      for (const file of customFiles) readLayer(file)
    } else {
      warnings.push(
        `[systematic] OPENCODE_CONFIG_DIR is inside ${customDirRefused === 'checkout' ? 'a repository checkout' : 'an allowed project'}; its connect settings were not read.`,
      )
    }
  }

  return {
    allowProjects: [...entries],
    groups,
    unreadable,
    warnings,
    ...(customDirRefused !== undefined && { customDirRefused }),
  }
}

// ── The per-entry resolver ──────────────────────────────────────────────────

/** Why an allow-list entry matched no project. */
export type AllowEntryMissReason =
  /** Not an absolute path once `~` is expanded. */
  | 'not-absolute'
  /** The path does not exist. */
  | 'stale'
  /** The path exists but is not a repository, and none encloses it. */
  | 'not-a-repository'
  /** The path is inside a repository, or a linked worktree: only the main root is allowed. */
  | 'not-main-root'
  /** The path or its repository layout could not be read or verified. */
  | 'unreadable'

export type AllowEntryResolution =
  | {
      readonly status: 'resolved'
      readonly entry: string
      /** The verified main repository root, as a realpath. */
      readonly mainRoot: string
    }
  | {
      readonly status: 'unmatched'
      readonly entry: string
      readonly reason: AllowEntryMissReason
    }

export interface AllowEntryOptions {
  /** Home directory for `~` entries. Defaults to `os.homedir()`. */
  readonly homeDir?: string
}

function unmatched(
  entry: string,
  reason: AllowEntryMissReason,
): AllowEntryResolution {
  return { status: 'unmatched', entry, reason }
}

/** Whether a proper ancestor of `dir` holds a `.git` entry. */
function enclosedByCheckout(dir: string): boolean {
  const parent = path.dirname(dir)
  return parent !== dir && insideCheckout(parent)
}

/**
 * Resolve one allow-list entry to a verified main repository root, or say why
 * it did not match. The entry is expanded (`~`), realpathed, and its identity
 * derived with `resolveProjectIdentity`; the main root must equal the entry's
 * realpath exactly, so a subdirectory and a linked worktree are not accepted.
 * Never throws.
 */
export function resolveAllowEntry(
  entry: string,
  options: AllowEntryOptions = {},
): AllowEntryResolution {
  const expanded = expandHome(entry, options.homeDir ?? os.homedir())
  if (!path.isAbsolute(expanded)) return unmatched(entry, 'not-absolute')

  let real: string
  try {
    real = fs.realpathSync.native(expanded)
  } catch (error) {
    const code = errorCode(error)
    return unmatched(
      entry,
      code === 'ENOENT' || code === 'ENOTDIR' ? 'stale' : 'unreadable',
    )
  }
  try {
    if (!fs.statSync(real).isDirectory()) {
      return unmatched(entry, 'not-a-repository')
    }
  } catch {
    return unmatched(entry, 'unreadable')
  }

  const identity = resolveProjectIdentity(real)
  if (identity.status === 'resolved') {
    return identity.mainRoot === real
      ? { status: 'resolved', entry, mainRoot: real }
      : unmatched(entry, 'not-main-root')
  }
  if (identity.reason === 'not-a-checkout') {
    return unmatched(
      entry,
      enclosedByCheckout(real) ? 'not-main-root' : 'not-a-repository',
    )
  }
  return unmatched(entry, 'unreadable')
}

export interface ResolvedAllowList {
  readonly resolved: ReadonlyArray<{
    readonly entry: string
    readonly mainRoot: string
  }>
  readonly unmatched: ReadonlyArray<{
    readonly entry: string
    readonly reason: AllowEntryMissReason
  }>
}

/**
 * Resolve every entry. Two entries that name one project collapse into the
 * first; a later duplicate is neither resolved nor unmatched.
 */
export function resolveAllowList(
  entries: readonly string[],
  options: AllowEntryOptions = {},
): ResolvedAllowList {
  const resolved: Array<{ entry: string; mainRoot: string }> = []
  const missed: Array<{ entry: string; reason: AllowEntryMissReason }> = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const resolution = resolveAllowEntry(entry, options)
    if (resolution.status === 'unmatched') {
      missed.push({ entry, reason: resolution.reason })
      continue
    }
    if (seen.has(resolution.mainRoot)) continue
    seen.add(resolution.mainRoot)
    resolved.push({ entry, mainRoot: resolution.mainRoot })
  }
  return { resolved, unmatched: missed }
}

// ── The host-support table ──────────────────────────────────────────────────

export const CONNECT_HOSTS = [
  'opencode-v1',
  'opencode-v2',
  'pi',
  'claude-code',
] as const

export type ConnectHost = (typeof CONNECT_HOSTS)[number]

/**
 * One host and exact version with host-specific evidence that the researcher's
 * tool limits hold. The evidence is a real-host refusal test, a test showing the
 * allowlist reaching the delegate session, or a recorded manual observation.
 * `observedBy` names it. A test is named as `<file> > <test title>`. A manual
 * observation is named as `HARNESSES.md > <entry id>`; a unit test requires that
 * entry to exist and to be marked manual evidence. A row without `observedBy`
 * never matches.
 */
export interface HostSupportRow {
  readonly host: ConnectHost
  readonly version: string
  readonly observedBy: string
}

/**
 * The supported combinations. A row is added only for a host and version with
 * host-specific evidence that the shipped agent's tool limits hold there: a
 * real-host refusal test, an allowlist reaching the delegate session, or a
 * recorded manual observation marked as manual evidence. The `claude-code` row
 * rests on a recorded manual tool-list observation, not a tested refusal,
 * because that host cannot be driven by a scripted model here.
 *
 * Every row is exact: the version is the one the proof ran against, and any
 * other version, older or newer, is unlisted.
 */
export const HOST_SUPPORT_TABLE: readonly HostSupportRow[] = [
  {
    host: 'opencode-v1',
    // renovate: datasource=npm depName=opencode-ai
    version: '1.19.5',
    observedBy:
      'tests/integration/opencode-v1-isolation.test.ts > the shipped researcher, dispatched from the packed plugin, is refused shell, write, edit and web fetch and its read reaches the parent',
  },
  {
    host: 'opencode-v2',
    // renovate: datasource=npm depName=@opencode/cli
    version: '2.2.6',
    observedBy:
      'tests/integration/opencode-v2.test.ts > a session-level allow does not lift the guarded researcher when a parent with that rule dispatches it',
  },
  {
    host: 'pi',
    // renovate: datasource=npm depName=@earendil-works/pi-coding-agent
    version: '1.5.0',
    observedBy:
      'tests/unit/pi-delegate-session.test.ts > the shipped researcher reaches createAgentSession with read, grep and find and none of bash, write, edit or systematic_delegate',
  },
  {
    host: 'claude-code',
    version: '2.1.319',
    observedBy: 'HARNESSES.md > CN-5',
  },
]

export type HostSupportVerdict =
  | { readonly supported: true; readonly row: HostSupportRow }
  | {
      readonly supported: false
      /** `unobserved`: no usable version. `unlisted`: no row names this host and version. */
      readonly reason: 'unobserved' | 'unlisted'
    }

/**
 * A version as the skill reports it: trimmed, one leading `v` dropped, and
 * SemVer build metadata (everything from the first `+`) cut off, because build
 * metadata does not change which release a build is. A prerelease tag stays,
 * so `1.19.5-rc.1` is not `1.19.5`. `undefined` when no version is left.
 */
function normalizeVersion(version: unknown): string | undefined {
  if (typeof version !== 'string') return undefined
  const withoutV = version.trim().replace(/^v/i, '')
  const plus = withoutV.indexOf('+')
  const core = (plus === -1 ? withoutV : withoutV.slice(0, plus)).trim()
  return core === '' ? undefined : core
}

/**
 * Check an observed host and version against the table. The match is exact:
 * a version that is not listed is refused, whether older or newer. A pair the
 * skill could not observe is unsupported.
 */
export function checkHostSupport(
  host: unknown,
  version: unknown,
  table: readonly HostSupportRow[] = HOST_SUPPORT_TABLE,
): HostSupportVerdict {
  const observed = normalizeVersion(version)
  if (observed === undefined) return { supported: false, reason: 'unobserved' }
  const row = table.find(
    (candidate) =>
      candidate.host === host &&
      typeof candidate.observedBy === 'string' &&
      candidate.observedBy.trim() !== '' &&
      normalizeVersion(candidate.version) === observed,
  )
  return row === undefined
    ? { supported: false, reason: 'unlisted' }
    : { supported: true, row }
}
