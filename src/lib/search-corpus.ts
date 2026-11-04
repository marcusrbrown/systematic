/**
 * Corpus loader for durable-output search: project root, `kind` table, safe
 * walk of one kind's docs directory and a narrowing wrapper around
 * `parseFrontmatter`.
 *
 * Reads from disk on every call and keeps no memo, because `ce:compound`
 * searches right after it writes. Never throws: every filesystem failure
 * becomes a bounded, sanitised warning. Holds no lifecycle logic. Documents
 * carry the narrowed `status`, `superseded_by` and `stale_reason` that the
 * search core's resolver reads.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import { readBytesBounded } from './search-bounded-read.js'
import type { ExcludeMatcher } from './search-exclude.js'
import { isRecord } from './validation.js'

/** Largest single file loaded, in bytes. */
export const MAX_FILE_BYTES = 256 * 1024
/** Most files considered per load. */
export const MAX_FILES = 2000
/** Deepest directory level walked; files directly in the kind directory are depth 0. */
export const MAX_DEPTH = 6
/** Total bytes of text loaded per call. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024
/** Discovery stops here so a hostile tree cannot make the walk itself unbounded. */
export const MAX_DISCOVERED_FILES = MAX_FILES * 4
/**
 * Most directory entries one external source may examine in total, across every
 * directory and every root of the source. The discovery ceiling counts accepted
 * candidates only, so this bounds the work a tree of non-matching entries can
 * cost.
 */
export const MAX_LISTED_ENTRIES = MAX_DISCOVERED_FILES * 4
/** Longest warning, in characters, after sanitising. */
const MAX_WARNING_LENGTH = 200
/** Indexed when a walk names no extensions. */
const DEFAULT_EXTENSIONS = ['.md'] as const

/** What a walk skips and what it indexes; the part of a kind a source shares. */
interface WalkSpec {
  /** Lower-case file names that are never indexed. */
  readonly excludedFiles: readonly string[]
  /** Directory names that are never descended into. */
  readonly excludedDirs: readonly string[]
  /** Lower-case file extensions that are indexed, dot included. Defaults to `.md`. */
  readonly extensions?: readonly string[]
}

interface KindSpec extends WalkSpec {
  /** Root-relative directory holding the kind, with `/` separators. */
  readonly dir: string
  /** Whether `status` / `superseded_by` / `stale_reason` apply to the kind. */
  readonly lifecycle: boolean
}

/**
 * One entry per document kind. Every Markdown file under a kind's directory
 * counts, except a README and anything under `_archived/`. The loader reads the
 * filesystem and never consults git, so a gitignored directory loads like a
 * tracked one. A new kind is a new entry here plus its frontmatter fit.
 */
export const KIND_TABLE = {
  solution: {
    dir: 'docs/solutions',
    excludedFiles: ['readme.md', 'critical-patterns.md'],
    excludedDirs: ['_archived'],
    lifecycle: true,
  },
  plan: {
    dir: 'docs/plans',
    excludedFiles: ['readme.md'],
    excludedDirs: ['_archived'],
    lifecycle: true,
  },
  brainstorm: {
    dir: 'docs/brainstorms',
    excludedFiles: ['readme.md'],
    excludedDirs: ['_archived'],
    lifecycle: true,
  },
  ideation: {
    dir: 'docs/ideation',
    excludedFiles: ['readme.md'],
    excludedDirs: ['_archived'],
    lifecycle: true,
  },
} as const satisfies Record<string, KindSpec>

export type DocumentKind = keyof typeof KIND_TABLE

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === 'string' && Object.hasOwn(KIND_TABLE, value)
}

/**
 * The `superseded_by` frontmatter value, kept apart from its meaning so the
 * resolver sees every malformed shape: `none` (key absent or null), `value`
 * (a string, possibly empty) or `invalid` (a list, mapping, number or any
 * other non-string).
 */
export type SupersededByField =
  | { readonly state: 'none' }
  | { readonly state: 'value'; readonly value: string }
  | { readonly state: 'invalid' }

export interface CorpusDocument {
  /** Root-relative path with `/` separators. */
  readonly path: string
  readonly kind: DocumentKind
  /** The first non-empty string of `title`, `topic`, then the file name without `.md`. */
  readonly title: string
  readonly tags: readonly string[]
  readonly module: string | undefined
  readonly component: string | undefined
  readonly problemType: string | undefined
  readonly symptoms: readonly string[]
  readonly appliesWhen: readonly string[]
  /** Raw `status` string; `undefined` when absent or not a string. */
  readonly status: string | undefined
  readonly supersededBy: SupersededByField
  readonly staleReason: string | undefined
  /** Text after the frontmatter block, or the whole file when there is none. */
  readonly body: string
}

export interface CorpusLoad {
  /** `none` when the kind directory does not exist (or lies outside the root). */
  readonly state: 'none' | 'loaded'
  readonly documents: readonly CorpusDocument[]
  /** Bounded, sanitised, in deterministic order. */
  readonly warnings: readonly string[]
}

const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this strips terminal escapes from untrusted file names and titles
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
const CONTROL_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this strips control characters from untrusted file names and titles
  /[\u0000-\u001f\u007f-\u009f]/g

/** Strip terminal escapes and control characters, then cap the length. */
export function cleanForWarning(text: string): string {
  const clean = text.replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARACTERS, '')
  return clean.length > MAX_WARNING_LENGTH
    ? `${clean.slice(0, MAX_WARNING_LENGTH)}…`
    : clean
}

export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export function safeLstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

type Probe<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' }

/** ENOENT and ENOTDIR mean nothing is there; any other error is an access or I/O failure. */
function isAbsence(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function probeRealpath(target: string): Probe<string> {
  try {
    return { kind: 'ok', value: fs.realpathSync(target) }
  } catch (error) {
    return { kind: isAbsence(error) ? 'absent' : 'failed' }
  }
}

function probeLstat(target: string): Probe<fs.Stats> {
  try {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false })
    return stat === undefined ? { kind: 'absent' } : { kind: 'ok', value: stat }
  } catch (error) {
    return { kind: isAbsence(error) ? 'absent' : 'failed' }
  }
}

export function safeReaddir(target: string): string[] | null {
  try {
    return fs.readdirSync(target)
  } catch {
    return null
  }
}

/**
 * The entries one external source may still examine. One budget is shared by
 * every directory and root of the source; the built-in kinds have none and list
 * a directory whole.
 */
export interface EntryBudget {
  remaining: number
  /** True once a listing was cut short or skipped for want of budget. */
  exhausted: boolean
}

export function newEntryBudget(
  limit: number = MAX_LISTED_ENTRIES,
): EntryBudget {
  return { remaining: limit, exhausted: false }
}

/**
 * List a directory against a budget: at most `budget.remaining` names, which
 * are then taken off the budget. A directory with more entries, or one reached
 * after the budget ran out, marks the budget exhausted; a spent budget opens
 * nothing. `null` when the directory cannot be read.
 */
export function listDirectoryWithin(
  target: string,
  budget: EntryBudget,
): BoundedListing | null {
  if (budget.remaining <= 0) {
    budget.exhausted = true
    return { names: [], truncated: true }
  }
  const listing = listDirectoryBounded(target, budget.remaining)
  if (listing === null) return null
  budget.remaining -= listing.names.length
  if (listing.truncated) {
    budget.remaining = 0
    budget.exhausted = true
  }
  return listing
}

export interface BoundedListing {
  readonly names: string[]
  /** True when the directory held more than `limit` entries, so `names` is a subset. */
  readonly truncated: boolean
}

/**
 * List a directory, holding at most `limit` names. Entries stream from the
 * directory handle, so a folder of millions of entries is never materialized.
 * A listing cut at `limit` is a subset in directory order; the caller sorts
 * what it got and says the listing was cut. `null` when the directory cannot
 * be opened or read.
 */
export function listDirectoryBounded(
  target: string,
  limit: number,
): BoundedListing | null {
  let directory: fs.Dir
  try {
    directory = fs.opendirSync(target)
  } catch {
    return null
  }
  const names: string[] = []
  try {
    while (true) {
      const entry = directory.readSync()
      if (entry === null) return { names, truncated: false }
      if (names.length >= limit) return { names, truncated: true }
      names.push(entry.name)
    }
  } catch {
    return null
  } finally {
    try {
      directory.closeSync()
    } catch {
      // Nothing useful to do: the listing is already decided.
    }
  }
}

/**
 * The shared walk behind `resolveSearchRoot` and `lookupSearchRoot`: realpath
 * the start directory, then climb to the nearest ancestor holding `.git` (a
 * directory, or a file for a worktree). It returns the found root, or `null`
 * together with the realpathed start when none is found. An unreadable
 * ancestor stops the walk as "not found"; it never throws.
 */
function walkToGitRoot(startDir: string): {
  readonly gitRoot: string | null
  readonly start: string
} {
  const resolved = path.resolve(startDir)
  const start = safeRealpath(resolved) ?? resolved
  let current = start
  while (true) {
    try {
      if (fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false })) {
        return { gitRoot: current, start }
      }
    } catch {
      return { gitRoot: null, start }
    }
    const parent = path.dirname(current)
    if (parent === current) return { gitRoot: null, start }
    current = parent
  }
}

/**
 * The project root: the nearest ancestor of `startDir` holding `.git` (a
 * directory, or a file for a worktree), resolved with `realpath`; otherwise
 * `startDir` itself, also resolved.
 *
 * `lookupSearchRoot` is the variant for callers that must keep the start
 * directory unresolved when there is no repository, and must know whether one
 * was found. Both share `walkToGitRoot`.
 *
 * This is a copy of the private `findGitWorktreeRoot` in
 * `discovered-skills.ts`, and the two differ on purpose: search falls back to
 * the start directory, while discovery returns null. Do not unify them.
 * Importing `discovered-skills.ts` here would also pull its dependencies into
 * the standalone search bin. This is the second use; extract at the third.
 */
export function resolveSearchRoot(startDir: string): string {
  const { gitRoot, start } = walkToGitRoot(startDir)
  return gitRoot ?? start
}

/** What `lookupSearchRoot` found. */
export interface SearchRootLookup {
  /**
   * The repository root (realpathed) when `foundGit`; otherwise the caller's
   * `startDir`, unchanged and unresolved.
   */
  readonly root: string
  /** Whether an ancestor holding `.git` was found. */
  readonly foundGit: boolean
}

/**
 * Like `resolveSearchRoot`, but reports whether `.git` was found and, when
 * none was, hands back `startDir` exactly as given instead of its realpath.
 * Config loading uses it so a directory outside any repository keeps the path
 * the caller passed (a temp directory under a symlinked prefix stays as is).
 */
export function lookupSearchRoot(startDir: string): SearchRootLookup {
  const { gitRoot } = walkToGitRoot(startDir)
  return gitRoot === null
    ? { root: startDir, foundGit: false }
    : { root: gitRoot, foundGit: true }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export type SymlinkedComponent = 'root' | 'ancestor'

/**
 * Whether a component of the path from `container` down to `target` is a
 * symlink, checked with `lstat` one component at a time: `root` when the final
 * component is, `ancestor` when one above it is. A `target` that is not lexically
 * inside `container` has no components to check; the realpath containment check
 * owns it. A component that is missing or cannot be inspected ends the check.
 */
export function symlinkedComponent(
  container: string,
  target: string,
): SymlinkedComponent | undefined {
  if (!isInside(container, target)) return undefined
  const segments = path.relative(container, target).split(path.sep)
  let current = container
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    const stat = safeLstat(current)
    if (stat === null) return undefined
    if (stat.isSymbolicLink()) {
      return index === segments.length - 1 ? 'root' : 'ancestor'
    }
  }
  return undefined
}

export interface SourceFileCandidate {
  /** Path relative to the walked directory, with `/` separators. */
  readonly relative: string
  readonly absolute: string
  readonly size: number
}

interface Discovery {
  readonly candidates: SourceFileCandidate[]
  /** True when discovery stopped at the cap, so counts are lower bounds. */
  truncated: boolean
  /** True when the walked directory itself could not be listed. */
  rootUnreadable: boolean
  /** Set for an external source: the entries every directory of the walk shares. */
  readonly budget?: EntryBudget | undefined
  /** Set for an external source with excludes: tests a path relative to the walked directory. */
  readonly isExcluded?: ExcludeMatcher | undefined
}

type EntryKind = 'file' | 'directory' | 'ignored'

/** Classify one entry without following symlinks; symlinks are ignored. */
function classifyEntry(
  spec: WalkSpec,
  name: string,
  stat: fs.Stats | null,
): EntryKind {
  // Gone since readdir, or a symlink: skipped, never followed.
  if (stat === null || stat.isSymbolicLink()) return 'ignored'
  if (stat.isDirectory()) {
    return spec.excludedDirs.includes(name) ? 'ignored' : 'directory'
  }
  if (!stat.isFile()) return 'ignored'
  const lower = name.toLowerCase()
  const extensions = spec.extensions ?? DEFAULT_EXTENSIONS
  const indexable =
    extensions.some((extension) => lower.endsWith(extension)) &&
    !spec.excludedFiles.includes(lower)
  return indexable ? 'file' : 'ignored'
}

function wholeListing(directory: string): BoundedListing | null {
  const names = safeReaddir(directory)
  return names === null ? null : { names, truncated: false }
}

/**
 * The entry names of one walked directory, or `null` when it cannot be read.
 * A subdirectory that cannot be read gets a warning here; the walked directory
 * itself is reported by `discoverSourceFiles`. With a budget, the listing takes
 * its names from it; the caller says once that the budget ran out.
 */
function listWalkedDirectory(
  budget: EntryBudget | undefined,
  label: string,
  directory: string,
  prefix: string,
  warnings: string[],
): string[] | null {
  const listing =
    budget === undefined
      ? wholeListing(directory)
      : listDirectoryWithin(directory, budget)
  if (listing === null) {
    if (prefix !== '') {
      const shown = `${label}/${prefix.slice(0, -1)}`
      warnings.push(cleanForWarning(`could not read directory ${shown}`))
    }
    return null
  }
  return listing.names
}

/** Keep a file, or mark discovery truncated once the ceiling is reached. The next entry stops the walk. */
function addCandidate(found: Discovery, candidate: SourceFileCandidate): void {
  if (found.candidates.length >= MAX_DISCOVERED_FILES) {
    found.truncated = true
    return
  }
  found.candidates.push(candidate)
}

function discoverFiles(
  spec: WalkSpec,
  label: string,
  directory: string,
  prefix: string,
  depth: number,
  found: Discovery,
  warnings: string[],
): void {
  const names = listWalkedDirectory(
    found.budget,
    label,
    directory,
    prefix,
    warnings,
  )
  if (names === null) {
    if (depth === 0) found.rootUnreadable = true
    return
  }
  names.sort(compareCodeUnits)
  for (const name of names) {
    if (found.truncated) return
    // The listing already charged this name to the budget. An excluded entry is
    // not inspected, entered or counted toward any file or byte cap.
    if (found.isExcluded?.(`${prefix}${name}`) === true) continue
    const absolute = path.join(directory, name)
    const stat = safeLstat(absolute)
    const entryKind = classifyEntry(spec, name, stat)
    if (entryKind === 'directory' && depth + 1 <= MAX_DEPTH) {
      const child = `${prefix}${name}/`
      discoverFiles(spec, label, absolute, child, depth + 1, found, warnings)
    } else if (entryKind === 'file' && stat !== null) {
      addCandidate(found, {
        relative: `${prefix}${name}`,
        absolute,
        size: stat.size,
      })
    }
  }
}

export function narrowString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A string with something in it after trimming; anything else is `undefined`. */
export function narrowNonEmptyString(value: unknown): string | undefined {
  const trimmed = narrowString(value)?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * A string, or a list of strings (and finite numbers, since YAML reads a bare
 * `404` tag as a number). Anything else, including a nested or cyclic
 * structure, is dropped rather than stringified.
 */
function narrowStringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const item of items) {
    if (typeof item === 'string') result.push(item)
    else if (typeof item === 'number' && Number.isFinite(item))
      result.push(String(item))
  }
  return result
}

function narrowSupersededBy(value: unknown): SupersededByField {
  if (value === undefined || value === null) return { state: 'none' }
  if (typeof value === 'string') return { state: 'value', value }
  return { state: 'invalid' }
}

export type ParsedMarkdown =
  | {
      readonly ok: true
      readonly data: Record<string, unknown>
      /** Text after the frontmatter block, or the whole file when there is none. */
      readonly body: string
    }
  | { readonly ok: false; readonly reason: string }

/**
 * The frontmatter step both the built-in kinds and the external Markdown
 * sources share: strips a leading BOM, supplies the newline `parseFrontmatter`'s
 * regex needs when the closing `---` is the last line, and rejects invalid YAML
 * and a block that is not a mapping. No frontmatter is a body-only file with
 * empty data, with no warning.
 */
export function parseMarkdownFrontmatter(content: string): ParsedMarkdown {
  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  if (!text.endsWith('\n')) text += '\n'

  const parsed = parseFrontmatter(text)
  if (parsed.parseError) return { ok: false, reason: 'invalid frontmatter' }
  if (parsed.hadFrontmatter && !isRecord(parsed.data)) {
    return { ok: false, reason: 'frontmatter is not a mapping' }
  }
  return {
    ok: true,
    data: isRecord(parsed.data) ? parsed.data : {},
    body: parsed.body,
  }
}

export type ParsedDocument =
  | { readonly ok: true; readonly document: CorpusDocument }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse one file. Wraps `parseMarkdownFrontmatter` and reads only known
 * fields, narrowing each. No frontmatter means a body-only document with no
 * warning. Invalid YAML, or a frontmatter block that is not a mapping, is not
 * indexable.
 */
export function parseCorpusDocument(
  kind: DocumentKind,
  relativePath: string,
  content: string,
): ParsedDocument {
  const parsed = parseMarkdownFrontmatter(content)
  if (!parsed.ok) return parsed
  const data = parsed.data

  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  const title =
    narrowNonEmptyString(data.title) ??
    narrowNonEmptyString(data.topic) ??
    fileName.replace(/\.md$/i, '')
  return {
    ok: true,
    document: {
      path: relativePath,
      kind,
      title,
      tags: narrowStringList(data.tags),
      module: narrowString(data.module),
      component: narrowString(data.component),
      problemType: narrowString(data.problem_type),
      symptoms: narrowStringList(data.symptoms),
      appliesWhen: narrowStringList(data.applies_when),
      status: narrowString(data.status),
      supersededBy: narrowSupersededBy(data.superseded_by),
      staleReason: narrowString(data.stale_reason),
      body: parsed.body,
    },
  }
}

export type ParsedSourceFile<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

export interface DiscoverSourceFilesOptions {
  /** The directory to walk. Not yet resolved: this function takes its realpath. */
  readonly directory: string
  /**
   * When set, the walked directory's realpath must lie strictly inside this
   * directory's realpath, or nothing is loaded. Built-in kinds and project
   * roots set it; user roots do not.
   */
  readonly containedIn?: string | undefined
  readonly walk: WalkSpec
  /**
   * An external source's entry budget, shared with the other roots of the same
   * source. Left out, every directory is listed whole.
   */
  readonly entryBudget?: EntryBudget | undefined
  /**
   * Tests a path relative to the walked directory, `/`-joined. A match leaves
   * the entry out and, for a directory, its whole subtree. Built-in kinds set
   * none.
   */
  readonly isExcluded?: ExcludeMatcher | undefined
  /** Names the directory in warnings: `spec.dir` for a built-in kind, the source name for an external one. */
  readonly label: string
}

export type SourceDiscovery =
  | {
      /**
       * `missing`: nothing is there (or it is not a directory). `unreadable`:
       * an access or I/O failure. `outside`: the realpath left `containedIn`.
       */
      readonly state: 'missing' | 'unreadable' | 'outside'
    }
  | {
      readonly state: 'found'
      /** Sorted by relative path in code-unit order; every file the walk found, before any cap. */
      readonly candidates: SourceFileCandidate[]
      /** True when discovery stopped at its ceiling, so counts are lower bounds. */
      readonly truncated: boolean
    }

/**
 * Probe one directory and walk it without reading any file. Symlinks are
 * skipped at every depth. Absence is a quiet `missing`; any other failure is
 * `unreadable` and says so once, in fixed text with no error detail. Never
 * throws.
 */
export function discoverSourceFiles(
  options: DiscoverSourceFilesOptions,
  warnings: string[],
): SourceDiscovery {
  const { directory, containedIn, walk, label, entryBudget, isExcluded } =
    options
  const directoryProbe = probeRealpath(directory)
  const containerProbe =
    containedIn === undefined ? undefined : probeRealpath(containedIn)
  if (containerProbe?.kind === 'failed' || directoryProbe.kind === 'failed') {
    warnings.push(`could not read ${label}; not loaded`)
    return { state: 'unreadable' }
  }
  if (
    (containerProbe !== undefined && containerProbe.kind !== 'ok') ||
    directoryProbe.kind !== 'ok'
  ) {
    return { state: 'missing' }
  }
  const directoryReal = directoryProbe.value
  const statProbe = probeLstat(directoryReal)
  if (statProbe.kind === 'failed') {
    warnings.push(`could not read ${label}; not loaded`)
    return { state: 'unreadable' }
  }
  if (statProbe.kind !== 'ok' || !statProbe.value.isDirectory()) {
    return { state: 'missing' }
  }

  // A committed symlink must not pull text from outside the project into output.
  if (
    containerProbe !== undefined &&
    !isInside(containerProbe.value, directoryReal)
  ) {
    warnings.push(`${label} resolves outside the project root; not loaded`)
    return { state: 'outside' }
  }

  const found: Discovery = {
    candidates: [],
    truncated: false,
    rootUnreadable: false,
    budget: entryBudget,
    isExcluded,
  }
  discoverFiles(walk, label, directoryReal, '', 0, found, warnings)
  // Whether `realpath` of a locked directory fails depends on the platform; a
  // directory that exists but cannot be listed is `unreadable` on all of them.
  if (found.rootUnreadable) {
    warnings.push(`could not read ${label}; not loaded`)
    return { state: 'unreadable' }
  }
  return {
    state: 'found',
    candidates: found.candidates.sort((a, b) =>
      compareCodeUnits(a.relative, b.relative),
    ),
    truncated: found.truncated,
  }
}

export interface ReadSourceFilesOptions<T> {
  /** Prepended to a candidate's relative path to form the path a record carries. */
  readonly displayPrefix: string
  /** Names the source in the file-limit and text-budget warnings. */
  readonly label: string
  /** Largest single file read, in bytes. */
  readonly maxFileBytes: number
  /**
   * Bytes of a read budget shared with other sources that this call may still
   * use. Left out for the built-in kinds, which share none.
   */
  readonly sharedBytes?: number | undefined
  /** Parses one file; `displayPath` is `displayPrefix/relative`. */
  readonly parse: (displayPath: string, content: string) => ParsedSourceFile<T>
}

export interface SourceFilesRead<T> {
  readonly items: T[]
  /** Stat bytes of the files opened, the figure a shared read budget draws on. */
  readonly bytesRead: number
}

/** What bounds a read: the per-file cap, the per-source text budget or the budget shared with other sources. */
export type ReadBound = 'file' | 'source' | 'shared'

export interface ReadAllowance {
  /** The most a file may hold: a read stops at one byte past it. */
  readonly limit: number
  readonly bound: ReadBound
}

/**
 * How much the next file may hold, given the bytes this source has already
 * used: the smallest of the per-file cap and what is left of the per-source
 * text budget and of the shared budget. The size seen at discovery is not part
 * of it, because a file can grow after discovery.
 */
export function readAllowance(
  used: number,
  maxFileBytes: number,
  sharedBytes?: number,
): ReadAllowance {
  const source = MAX_TOTAL_BYTES - used
  const shared = sharedBytes === undefined ? Infinity : sharedBytes - used
  const left = Math.max(Math.min(source, shared), 0)
  if (maxFileBytes <= left) return { limit: maxFileBytes, bound: 'file' }
  return { limit: left, bound: shared < source ? 'shared' : 'source' }
}

interface ReadOutcome<T> extends SourceFilesRead<T> {
  readonly budgetSkipped: number
  readonly budgetBound: ReadBound
}

type BudgetedRead =
  | { readonly kind: 'text'; readonly text: string; readonly bytes: number }
  | { readonly kind: 'skip'; readonly reason: string; readonly bytes: number }
  | { readonly kind: 'stop'; readonly bound: ReadBound; readonly bytes: number }

/**
 * Read one file within the per-file cap and what is left of the per-source and
 * shared budgets. `bytes` is what the read charges. The size seen at discovery
 * can be out of date, so the read itself is limited to what the budgets leave:
 * a file that crosses a budget stops the source, charged what was left.
 */
function readWithinBudgets<T>(
  options: ReadSourceFilesOptions<T>,
  candidate: SourceFileCandidate,
  used: number,
): BudgetedRead {
  const { maxFileBytes, sharedBytes } = options
  const tooLarge = `larger than ${maxFileBytes} bytes`
  if (candidate.size > maxFileBytes) {
    return { kind: 'skip', reason: tooLarge, bytes: 0 }
  }
  if (used + candidate.size > MAX_TOTAL_BYTES) {
    return { kind: 'stop', bound: 'source', bytes: 0 }
  }
  if (sharedBytes !== undefined && used + candidate.size > sharedBytes) {
    return { kind: 'stop', bound: 'shared', bytes: 0 }
  }
  const allowance = readAllowance(used, maxFileBytes, sharedBytes)
  const read = readBytesBounded(candidate.absolute, allowance.limit)
  if (read.kind === 'too-large') {
    return allowance.bound === 'file'
      ? { kind: 'skip', reason: tooLarge, bytes: read.bytesRead }
      : { kind: 'stop', bound: allowance.bound, bytes: allowance.limit }
  }
  if (read.kind !== 'bytes') {
    return { kind: 'skip', reason: 'could not be read', bytes: 0 }
  }
  return {
    kind: 'text',
    text: read.bytes.toString('utf8'),
    bytes: read.bytes.byteLength,
  }
}

/**
 * Read the first `considered` candidates in order, each within the budgets
 * (see `readWithinBudgets`). A file that crosses a budget is rejected and
 * nothing after it is read.
 */
function readCandidates<T>(
  options: ReadSourceFilesOptions<T>,
  candidates: readonly SourceFileCandidate[],
  considered: number,
  warnings: string[],
): ReadOutcome<T> {
  const items: T[] = []
  let totalBytes = 0
  for (let index = 0; index < considered; index++) {
    const candidate = candidates[index]
    if (candidate === undefined) break
    const logicalPath = `${options.displayPrefix}/${candidate.relative}`
    const display = cleanForWarning(logicalPath)
    const read = readWithinBudgets(options, candidate, totalBytes)
    totalBytes += read.bytes
    if (read.kind === 'stop') {
      return {
        items,
        bytesRead: totalBytes,
        budgetSkipped: considered - index,
        budgetBound: read.bound,
      }
    }
    if (read.kind === 'skip') {
      warnings.push(`skipped ${display}: ${read.reason}`)
      continue
    }
    const parsed = options.parse(logicalPath, read.text)
    if (parsed.ok) items.push(parsed.value)
    else warnings.push(`skipped ${display}: ${parsed.reason}`)
  }
  return {
    items,
    bytesRead: totalBytes,
    budgetSkipped: 0,
    budgetBound: 'source',
  }
}

/**
 * Read the first `MAX_FILES` of `candidates` (already sorted), within the
 * per-file cap and the per-call `MAX_TOTAL_BYTES`, and warn about whatever the
 * file limit or the text budget left out. `truncated` is the discovery flag.
 * Never throws.
 */
export function readSourceFiles<T>(
  options: ReadSourceFilesOptions<T>,
  candidates: readonly SourceFileCandidate[],
  truncated: boolean,
  warnings: string[],
): SourceFilesRead<T> {
  const considered = Math.min(candidates.length, MAX_FILES)
  const { items, bytesRead, budgetSkipped, budgetBound } = readCandidates(
    options,
    candidates,
    considered,
    warnings,
  )

  const capSkipped = candidates.length - considered
  if (capSkipped > 0) {
    const atLeast = truncated ? 'at least ' : ''
    warnings.push(
      `${options.label}: file limit of ${MAX_FILES} reached; skipped ${atLeast}${capSkipped} files`,
    )
  }
  if (budgetSkipped > 0) {
    warnings.push(
      budgetBound === 'shared'
        ? `${options.label}: read budget of this call reached; skipped ${budgetSkipped} files`
        : `${options.label}: text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped ${budgetSkipped} files`,
    )
  }
  return { items, bytesRead }
}

export type SourceFilesLoad<T> =
  | {
      readonly state: 'missing' | 'unreadable' | 'outside'
      readonly warnings: string[]
    }
  | {
      readonly state: 'loaded'
      readonly items: T[]
      readonly bytesRead: number
      readonly warnings: string[]
    }

/**
 * The shared walk-and-read core: discover one directory, then read what the
 * caps allow. `loadCorpus` is a caller of it for the built-in kinds; the
 * external loader uses `discoverSourceFiles` and `readSourceFiles` directly so
 * it can merge several roots and check a shared budget before reading.
 */
export function loadSourceFiles<T>(
  discover: DiscoverSourceFilesOptions,
  read: ReadSourceFilesOptions<T>,
): SourceFilesLoad<T> {
  const warnings: string[] = []
  const discovery = discoverSourceFiles(discover, warnings)
  if (discovery.state !== 'found') {
    return { state: discovery.state, warnings }
  }
  const { items, bytesRead } = readSourceFiles(
    read,
    discovery.candidates,
    discovery.truncated,
    warnings,
  )
  return { state: 'loaded', items, bytesRead, warnings }
}

/**
 * Load every indexable document of one kind under `root`, sorted by
 * root-relative path in code-unit order. `root` should come from
 * `resolveSearchRoot`.
 */
export function loadCorpus(
  root: string,
  kind: DocumentKind = 'solution',
): CorpusLoad {
  const spec: KindSpec = KIND_TABLE[kind]
  const loaded = loadSourceFiles<CorpusDocument>(
    {
      directory: path.join(root, ...spec.dir.split('/')),
      containedIn: root,
      walk: spec,
      label: spec.dir,
    },
    {
      displayPrefix: spec.dir,
      label: spec.dir,
      maxFileBytes: MAX_FILE_BYTES,
      parse: (displayPath, content) => {
        const parsed = parseCorpusDocument(kind, displayPath, content)
        return parsed.ok
          ? { ok: true, value: parsed.document }
          : { ok: false, reason: parsed.reason }
      },
    },
  )
  if (loaded.state !== 'loaded') {
    return { state: 'none', documents: [], warnings: loaded.warnings }
  }
  return {
    state: 'loaded',
    documents: loaded.items,
    warnings: loaded.warnings,
  }
}
