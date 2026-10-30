/**
 * Corpus loader for durable-output search: project root, `kind` table, safe
 * walk of `docs/solutions/` and a narrowing wrapper around `parseFrontmatter`.
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
const MAX_DISCOVERED_FILES = MAX_FILES * 4
/** Longest warning, in characters, after sanitising. */
const MAX_WARNING_LENGTH = 200

interface KindSpec {
  /** Root-relative directory holding the kind, with `/` separators. */
  readonly dir: string
  /** Lower-case file names that are never indexed. */
  readonly excludedFiles: readonly string[]
  /** Directory names that are never descended into. */
  readonly excludedDirs: readonly string[]
  /** Whether `status` / `superseded_by` / `stale_reason` apply to the kind. */
  readonly lifecycle: boolean
}

/**
 * One entry per document kind. Release 1 indexes `docs/solutions/` only; a new
 * kind (plans, brainstorms) is a new entry here plus its frontmatter fit.
 */
export const KIND_TABLE = {
  solution: {
    dir: 'docs/solutions',
    excludedFiles: ['readme.md', 'critical-patterns.md'],
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
  /** The `title` field, else the file name without `.md`. */
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
function cleanForWarning(text: string): string {
  const clean = text.replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARACTERS, '')
  return clean.length > MAX_WARNING_LENGTH
    ? `${clean.slice(0, MAX_WARNING_LENGTH)}…`
    : clean
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function safeLstat(target: string): fs.Stats | null {
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

function safeReaddir(target: string): string[] | null {
  try {
    return fs.readdirSync(target)
  } catch {
    return null
  }
}

/**
 * The project root: the nearest ancestor of `startDir` holding `.git` (a
 * directory, or a file for a worktree), resolved with `realpath`; otherwise
 * `startDir` itself, also resolved.
 *
 * This is a copy of the private `findGitWorktreeRoot` in
 * `discovered-skills.ts`, and the two differ on purpose: search falls back to
 * the start directory, while discovery returns null. Do not unify them.
 * Importing `discovered-skills.ts` here would also pull its dependencies into
 * the standalone search bin. This is the second use; extract at the third.
 */
export function resolveSearchRoot(startDir: string): string {
  const resolved = path.resolve(startDir)
  const start = safeRealpath(resolved) ?? resolved
  let current = start
  while (true) {
    try {
      if (fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false })) {
        return current
      }
    } catch {
      return start // unreadable ancestor: stop walking, never throw
    }
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

interface Candidate {
  /** Path relative to the kind directory, with `/` separators. */
  readonly relative: string
  readonly absolute: string
  readonly size: number
}

interface Discovery {
  readonly candidates: Candidate[]
  /** True when discovery stopped at the cap, so counts are lower bounds. */
  truncated: boolean
}

type EntryKind = 'file' | 'directory' | 'ignored'

/** Classify one entry without following symlinks; symlinks are ignored. */
function classifyEntry(
  spec: KindSpec,
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
  const indexable = lower.endsWith('.md') && !spec.excludedFiles.includes(lower)
  return indexable ? 'file' : 'ignored'
}

function discoverFiles(
  spec: KindSpec,
  directory: string,
  prefix: string,
  depth: number,
  found: Discovery,
  warnings: string[],
): void {
  const names = safeReaddir(directory)
  if (names === null) {
    const shown =
      prefix === '' ? spec.dir : `${spec.dir}/${prefix.slice(0, -1)}`
    warnings.push(cleanForWarning(`could not read directory ${shown}`))
    return
  }
  names.sort(compareCodeUnits)
  for (const name of names) {
    if (found.truncated) return
    const absolute = path.join(directory, name)
    const stat = safeLstat(absolute)
    const entryKind = classifyEntry(spec, name, stat)
    if (entryKind === 'directory' && depth + 1 <= MAX_DEPTH) {
      const child = `${prefix}${name}/`
      discoverFiles(spec, absolute, child, depth + 1, found, warnings)
    } else if (entryKind === 'file' && stat !== null) {
      if (found.candidates.length >= MAX_DISCOVERED_FILES) {
        found.truncated = true
        return
      }
      found.candidates.push({
        relative: `${prefix}${name}`,
        absolute,
        size: stat.size,
      })
    }
  }
}

function narrowString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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

export type ParsedDocument =
  | { readonly ok: true; readonly document: CorpusDocument }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse one file. Wraps `parseFrontmatter` (which stays unedited): strips a
 * leading BOM, supplies the newline its regex needs when the closing `---` is
 * the last line, and reads only known fields, narrowing each. No frontmatter
 * means a body-only document with no warning. Invalid YAML, or a frontmatter
 * block that is not a mapping, is not indexable.
 */
export function parseCorpusDocument(
  kind: DocumentKind,
  relativePath: string,
  content: string,
): ParsedDocument {
  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  if (!text.endsWith('\n')) text += '\n'

  const parsed = parseFrontmatter(text)
  if (parsed.parseError) return { ok: false, reason: 'invalid frontmatter' }
  if (parsed.hadFrontmatter && !isRecord(parsed.data)) {
    return { ok: false, reason: 'frontmatter is not a mapping' }
  }
  const data: Record<string, unknown> = isRecord(parsed.data) ? parsed.data : {}

  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  const title = narrowString(data.title)?.trim()
  return {
    ok: true,
    document: {
      path: relativePath,
      kind,
      title: title ? title : fileName.replace(/\.md$/i, ''),
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

interface ReadOutcome {
  readonly documents: CorpusDocument[]
  readonly budgetSkipped: number
}

/** Read the first `considered` candidates in order, within the size and byte caps. */
function readCandidates(
  spec: KindSpec,
  kind: DocumentKind,
  candidates: readonly Candidate[],
  considered: number,
  warnings: string[],
): ReadOutcome {
  const documents: CorpusDocument[] = []
  let totalBytes = 0
  for (let index = 0; index < considered; index++) {
    const candidate = candidates[index]
    if (candidate === undefined) break
    const logicalPath = `${spec.dir}/${candidate.relative}`
    const display = cleanForWarning(logicalPath)
    if (candidate.size > MAX_FILE_BYTES) {
      warnings.push(`skipped ${display}: larger than ${MAX_FILE_BYTES} bytes`)
      continue
    }
    if (totalBytes + candidate.size > MAX_TOTAL_BYTES) {
      return { documents, budgetSkipped: considered - index }
    }
    totalBytes += candidate.size

    let bytes: Buffer
    try {
      bytes = fs.readFileSync(candidate.absolute)
    } catch {
      warnings.push(`skipped ${display}: could not be read`)
      continue
    }
    // The file may have grown since lstat.
    if (bytes.byteLength > MAX_FILE_BYTES) {
      warnings.push(`skipped ${display}: larger than ${MAX_FILE_BYTES} bytes`)
      continue
    }
    const parsed = parseCorpusDocument(
      kind,
      logicalPath,
      bytes.toString('utf8'),
    )
    if (parsed.ok) documents.push(parsed.document)
    else warnings.push(`skipped ${display}: ${parsed.reason}`)
  }
  return { documents, budgetSkipped: 0 }
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
  const warnings: string[] = []
  const none: CorpusLoad = { state: 'none', documents: [], warnings }

  // Absence is a quiet `none`. Any other failure stays `none` too, but says so
  // once, in fixed text with no error detail.
  const unreadable = (): CorpusLoad => {
    warnings.push(`could not read ${spec.dir}; not loaded`)
    return none
  }
  const rootProbe = probeRealpath(root)
  const directoryProbe = probeRealpath(path.join(root, ...spec.dir.split('/')))
  if (rootProbe.kind === 'failed' || directoryProbe.kind === 'failed') {
    return unreadable()
  }
  if (rootProbe.kind !== 'ok' || directoryProbe.kind !== 'ok') return none
  const rootReal = rootProbe.value
  const directoryReal = directoryProbe.value
  const statProbe = probeLstat(directoryReal)
  if (statProbe.kind === 'failed') return unreadable()
  if (statProbe.kind !== 'ok' || !statProbe.value.isDirectory()) return none

  // A committed symlink must not pull text from outside the project into output.
  if (!isInside(rootReal, directoryReal)) {
    warnings.push(`${spec.dir} resolves outside the project root; not loaded`)
    return none
  }

  const found: Discovery = { candidates: [], truncated: false }
  discoverFiles(spec, directoryReal, '', 0, found, warnings)
  const candidates = found.candidates.sort((a, b) =>
    compareCodeUnits(a.relative, b.relative),
  )

  const considered = Math.min(candidates.length, MAX_FILES)
  const { documents, budgetSkipped } = readCandidates(
    spec,
    kind,
    candidates,
    considered,
    warnings,
  )

  const capSkipped = candidates.length - considered
  if (capSkipped > 0) {
    const atLeast = found.truncated ? 'at least ' : ''
    warnings.push(
      `file limit of ${MAX_FILES} reached; skipped ${atLeast}${capSkipped} files`,
    )
  }
  if (budgetSkipped > 0) {
    warnings.push(
      `text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped ${budgetSkipped} files`,
    )
  }

  return { state: 'loaded', documents, warnings }
}
