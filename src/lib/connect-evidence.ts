/**
 * The evidence boundary for `ce:connect`: what the helper may read from an
 * allowed project and how it reads it. A bounded, hashed inventory of tracked
 * files; a hardened, allow-listed git runner; contained reads; and a citation
 * checker that says which `path:line` citations still hold.
 *
 * Import rule: node builtins and `connect-config.ts` only. The `ce:connect`
 * helper bundles this module, so it must never import zod, `config.ts` or
 * `config-schema.ts`.
 *
 * Trust: an allowed project is untrusted input. Its git config, its file names
 * and its working tree all come from other people, so:
 * - git runs only the subcommands in `GIT_SUBCOMMANDS`, with the hardening
 *   flags before the subcommand, a scrubbed environment, `GIT_OPTIONAL_LOCKS=0`
 *   so a read never takes a lock or rewrites the index, literal pathspecs for
 *   path arguments, and `--` before every one of them (or paths on stdin,
 *   NUL-separated, where the subcommand takes them there);
 * - only the listing's regular files (mode 100644 or 100755) become evidence;
 *   symlinks (120000) and submodules (160000) are dropped before any open;
 * - a file is read only through `readContainedFile`, which refuses a path that
 *   leaves the root, `lstat`s every ancestor and the final component, opens
 *   with `O_NOFOLLOW`, and compares the opened descriptor's device and inode
 *   with the `lstat` result, then re-checks the ancestors;
 * - only the main checkout is read; a subdirectory or a linked worktree is
 *   refused by the allow-entry resolver.
 *
 * Nothing here writes to a project, runs a project command or reads history.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  type AllowEntryMissReason,
  resolveAllowEntry,
} from './connect-config.js'

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Provisional bounds. A run that reaches one is degraded and says so. The
 * values are tuned against a pilot under the Pi 20-turn cap, then frozen.
 */
export const CONNECT_BOUNDS = Object.freeze({
  /** Eligible files kept per project, corpus files first. */
  maxFilesPerProject: 4000,
  /** Largest file read, hashed or cited. A larger file is skipped. */
  maxFileBytes: 256 * 1024,
  /** Total bytes hashed per project. Reaching it stops the inventory. */
  maxHashedBytesPerProject: 32 * 1024 * 1024,
  /** Largest `git ls-files` output accepted. */
  maxListingBytes: 16 * 1024 * 1024,
  /** Path-and-line citations checked per project. */
  maxCitationsPerProject: 500,
  /** Rules a single rule family may hold. */
  maxRulesPerFamily: 12,
  /** Candidates accepted in one family batch. */
  maxCandidatesPerBatch: 8,
  /** Rule families examined in one run. */
  maxFamiliesPerRun: 6,
})

export type ConnectBounds = {
  readonly [K in keyof typeof CONNECT_BOUNDS]: number
}

// ── Git ─────────────────────────────────────────────────────────────────────

/** The only git subcommands the helper runs. */
export const GIT_SUBCOMMANDS = ['ls-files', 'cat-file', 'check-ignore'] as const

export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number]

/**
 * Config overrides placed before the subcommand. A repository's own config can
 * name an fsmonitor command or a hooks directory that git would run on its
 * behalf; these three settings turn that off for the helper's calls.
 */
export const GIT_HARDENING_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.untrackedCache=false',
] as const

const GIT_TIMEOUT_MS = 30_000

/** Environment variables git is allowed to inherit. Every `GIT_*` one is dropped. */
const GIT_INHERITED_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'SYSTEMROOT',
  'USERPROFILE',
]

function isGitSubcommand(value: string): value is GitSubcommand {
  return (GIT_SUBCOMMANDS as readonly string[]).includes(value)
}

/**
 * The full argv after `git`: hardening flags, the subcommand, its options, and
 * then `--` followed by any path arguments. A path that starts with `-` can
 * therefore never be read as an option.
 */
export function buildGitArgv(
  subcommand: GitSubcommand,
  args: readonly string[],
  paths: readonly string[] = [],
): string[] {
  return [
    ...GIT_HARDENING_ARGS,
    subcommand,
    ...args,
    ...(paths.length > 0 ? ['--', ...paths] : []),
  ]
}

/**
 * A fresh environment for git. Nothing the caller exported reaches it except
 * `PATH` and the home and temp locations, so a stray `GIT_DIR`,
 * `GIT_WORK_TREE` or `GIT_EXTERNAL_DIFF` cannot redirect a read.
 * `literalPathspecs` makes git read path arguments as plain names.
 */
export function gitEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
  literalPathspecs = false,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of GIT_INHERITED_ENV) {
    const value = base[name]
    if (value !== undefined) env[name] = value
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  // Path arguments are literal names, never pathspec patterns or magic.
  // `check-ignore` rejects the setting, and takes its paths on stdin instead.
  if (literalPathspecs) env.GIT_LITERAL_PATHSPECS = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
}

export type GitRun =
  | {
      readonly status: 'ok'
      readonly exitCode: number
      readonly stdout: Buffer
    }
  /** The subcommand is not in `GIT_SUBCOMMANDS`; git was not started. */
  | { readonly status: 'refused' }
  | {
      readonly status: 'failed'
      readonly reason: 'git-unavailable' | 'git-failed' | 'output-too-large'
    }

export interface GitRunOptions {
  /** The git executable. Defaults to `git` on `PATH`. */
  readonly gitBinary?: string
  /** Largest stdout accepted, in bytes. */
  readonly maxBytes?: number
  /** Path arguments, passed after `--`. */
  readonly paths?: readonly string[]
  /** Bytes written to git's stdin. */
  readonly input?: Buffer
}

/**
 * Run one allow-listed git subcommand in `cwd`. The exit code is returned for
 * the caller to read: `check-ignore` exits 1 when nothing matched. Never throws.
 */
export function runGit(
  cwd: string,
  subcommand: string,
  args: readonly string[],
  options: GitRunOptions = {},
): GitRun {
  if (!isGitSubcommand(subcommand)) return { status: 'refused' }
  const result = spawnSync(
    options.gitBinary ?? 'git',
    buildGitArgv(subcommand, args, options.paths),
    {
      cwd,
      env: gitEnvironment(process.env, (options.paths?.length ?? 0) > 0),
      ...(options.input === undefined ? {} : { input: options.input }),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: options.maxBytes ?? CONNECT_BOUNDS.maxListingBytes,
    },
  )
  if (result.error !== undefined) {
    const code = 'code' in result.error ? result.error.code : undefined
    if (code === 'ENOENT')
      return { status: 'failed', reason: 'git-unavailable' }
    if (code === 'ENOBUFS')
      return { status: 'failed', reason: 'output-too-large' }
    return { status: 'failed', reason: 'git-failed' }
  }
  if (result.status === null) return { status: 'failed', reason: 'git-failed' }
  return { status: 'ok', exitCode: result.status, stdout: result.stdout }
}

// ── Contained reads ─────────────────────────────────────────────────────────

/** Why a file was not read. */
export type ReadFailure =
  /** The path is absolute, empty, malformed or climbs out of the root. */
  | 'outside-root'
  /** An ancestor or the final component is a symlink. */
  | 'symlink'
  /** The final component is a directory, FIFO, device or socket. */
  | 'not-regular'
  | 'missing'
  | 'too-large'
  | 'unreadable'
  /** The path changed between the check and the open. */
  | 'changed'

export type ContainedRead =
  | {
      readonly kind: 'bytes'
      readonly bytes: Buffer
      readonly sha256: string
    }
  | { readonly kind: 'refused'; readonly reason: ReadFailure }

export interface ContainedReadOptions {
  /** Largest file accepted. Defaults to `CONNECT_BOUNDS.maxFileBytes`. */
  readonly maxBytes?: number
  /** Runs between the last `lstat` and the open. A test seam for races. */
  readonly beforeOpen?: () => void
}

const MAX_RELATIVE_PATH_LENGTH = 4096
const READ_CHUNK_BYTES = 64 * 1024

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

function lstatOrCode(
  target: string,
): fs.BigIntStats | 'missing' | 'unreadable' {
  try {
    return fs.lstatSync(target, { bigint: true })
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
}

/**
 * The segments of a root-relative path, or undefined when the path is not a
 * plain relative path: empty, absolute (POSIX or Windows), containing NUL, an
 * empty segment, `.` or `..`.
 */
function relativeSegments(rel: unknown): string[] | undefined {
  if (typeof rel !== 'string' || rel === '') return undefined
  if (rel.length > MAX_RELATIVE_PATH_LENGTH || rel.includes('\0'))
    return undefined
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return undefined
  const segments = rel.split('/')
  return segments.some((part) => part === '' || part === '.' || part === '..')
    ? undefined
    : segments
}

function sameIdentity(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function readFdBounded(
  fd: number,
  maxBytes: number,
): Buffer | 'too-large' | null {
  const limit = maxBytes + 1
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, limit - total),
      )
      const count = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (count === 0) break
      chunks.push(chunk.subarray(0, count))
      total += count
    }
  } catch {
    return null
  }
  return total >= limit ? 'too-large' : Buffer.concat(chunks)
}

interface Ancestor {
  readonly dir: string
  readonly stat: fs.BigIntStats
}

interface WalkedPath {
  readonly full: string
  readonly ancestors: readonly Ancestor[]
  /** The `lstat` of the final component, which is a regular file. */
  readonly before: fs.BigIntStats
}

/** `lstat` every ancestor, then the final component, refusing a symlink or a non-file. */
function walkToFile(
  root: string,
  segments: readonly string[],
): WalkedPath | ReadFailure {
  const ancestors: Ancestor[] = []
  let current = root
  for (const part of segments.slice(0, -1)) {
    current = path.join(current, part)
    const stat = lstatOrCode(current)
    if (typeof stat === 'string') return stat
    if (stat.isSymbolicLink()) return 'symlink'
    if (!stat.isDirectory()) return 'missing'
    ancestors.push({ dir: current, stat })
  }
  const full = path.join(current, segments.at(-1) ?? '')
  const before = lstatOrCode(full)
  if (typeof before === 'string') return before
  if (before.isSymbolicLink()) return 'symlink'
  if (!before.isFile()) return 'not-regular'
  return { full, ancestors, before }
}

function ancestorsUnchanged(ancestors: readonly Ancestor[]): boolean {
  return ancestors.every((ancestor) => {
    const again = lstatOrCode(ancestor.dir)
    return (
      typeof again !== 'string' &&
      !again.isSymbolicLink() &&
      sameIdentity(again, ancestor.stat)
    )
  })
}

function openNoFollow(full: string): number | ReadFailure {
  try {
    return fs.openSync(
      full,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    )
  } catch (error) {
    const code = errorCode(error)
    // The `lstat` found a regular file, so a loop or a vanished path here
    // means the path changed after the check.
    return code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR'
      ? 'changed'
      : 'unreadable'
  }
}

function readOpened(
  fd: number,
  walked: WalkedPath,
  maxBytes: number,
): ContainedRead {
  const opened = fs.fstatSync(fd, { bigint: true })
  if (!opened.isFile() || !sameIdentity(opened, walked.before)) {
    return { kind: 'refused', reason: 'changed' }
  }
  if (!ancestorsUnchanged(walked.ancestors)) {
    return { kind: 'refused', reason: 'changed' }
  }
  const bytes = readFdBounded(fd, maxBytes)
  if (bytes === null) return { kind: 'refused', reason: 'unreadable' }
  if (bytes === 'too-large') return { kind: 'refused', reason: 'too-large' }
  return {
    kind: 'bytes',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/**
 * Read a regular file at a root-relative path without following a symlink.
 *
 * 1. The path must be plain and relative, so `..` and absolute paths are
 *    refused before the filesystem is touched.
 * 2. Every ancestor and the final component are `lstat`ed. A symlink anywhere,
 *    or a final component that is not a regular file, is refused, so a FIFO
 *    is never opened.
 * 3. The open uses `O_NOFOLLOW` and `O_NONBLOCK`, and the opened descriptor's
 *    device and inode must equal the `lstat` result, so a path swapped after
 *    the check fails instead of being read.
 * 4. The ancestors are checked once more after the open, which catches a
 *    directory swapped for a symlink to the same file.
 * 5. The read stops one byte past `maxBytes`; the size is never trusted from a
 *    `stat`.
 *
 * `root` must be a trusted real path. Never throws.
 */
export function readContainedFile(
  root: string,
  rel: string,
  options: ContainedReadOptions = {},
): ContainedRead {
  const segments = relativeSegments(rel)
  if (segments === undefined) return { kind: 'refused', reason: 'outside-root' }
  const walked = walkToFile(root, segments)
  if (typeof walked === 'string') return { kind: 'refused', reason: walked }

  options.beforeOpen?.()

  const fd = openNoFollow(walked.full)
  if (typeof fd === 'string') return { kind: 'refused', reason: fd }
  try {
    return readOpened(
      fd,
      walked,
      options.maxBytes ?? CONNECT_BOUNDS.maxFileBytes,
    )
  } catch {
    return { kind: 'refused', reason: 'unreadable' }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // The read result is already decided.
    }
  }
}

// ── Citations ───────────────────────────────────────────────────────────────

export interface CitationInput {
  /** Root-relative path. */
  readonly path: string
  /** First cited line, 1-based. */
  readonly start: number
  /** Last cited line, inclusive. */
  readonly end: number
  /** The name the citing claim says is in the span. */
  readonly symbol?: string
}

export type CitationUncheckedReason = 'no-symbol' | 'invalid-span' | ReadFailure

/**
 * What a check established:
 * - `passed`: the symbol is in the cited lines.
 * - `not-in-span`: it is not; `foundElsewhere` says whether it still occurs
 *   somewhere else in the file (the code moved) or nowhere (it is gone).
 * - `unchecked`: the check could not run, and the reason says why.
 *
 * A verdict reports whether the citation still holds, not whether the code has
 * stayed put.
 */
export type CitationVerdict =
  | { readonly verdict: 'passed' }
  | { readonly verdict: 'not-in-span'; readonly foundElsewhere: boolean }
  | {
      readonly verdict: 'unchecked'
      readonly reason: CitationUncheckedReason
    }

export interface CheckCitationOptions {
  /** Largest cited file accepted. Defaults to `CONNECT_BOUNDS.maxFileBytes`. */
  readonly maxBytes?: number
}

const MAX_SYMBOL_LENGTH = 200

/** A character an identifier is made of: a letter, digit, `_` or `$`. */
function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  )
}

/**
 * Whether `identifier` occurs in `text` as a whole name: no identifier
 * character directly before or after the match. A dotted chain is matched as
 * one name. `alphaBeta` is not found in `alphaBetaAsync` or `myalphaBeta`.
 */
function containsIdentifier(text: string, identifier: string): boolean {
  let at = text.indexOf(identifier)
  while (at !== -1) {
    const end = at + identifier.length
    if (
      !isIdentifierCode(text.charCodeAt(at - 1)) &&
      !isIdentifierCode(text.charCodeAt(end))
    ) {
      return true
    }
    at = text.indexOf(identifier, at + 1)
  }
  return false
}

/** A trailing `()` is dropped. Undefined when nothing usable is left. */
function normalizeSymbol(symbol: string | undefined): string | undefined {
  if (symbol === undefined) return undefined
  const trimmed = symbol.trim().replace(/\(\)$/, '')
  if (trimmed === '' || trimmed.length > MAX_SYMBOL_LENGTH) return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  return /[\s\u0000-\u001f\u007f]/.test(trimmed) ? undefined : trimmed
}

function isValidSpan(start: number, end: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    end >= start
  )
}

function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Check one citation. The file is read through `readContainedFile`, so a path
 * outside the root, through a symlink, to a FIFO or over the size cap is
 * `unchecked` with the reason, and the file is never opened unsafely.
 */
export function checkCitation(
  root: string,
  citation: CitationInput,
  options: CheckCitationOptions = {},
): CitationVerdict {
  const unchecked = (reason: CitationUncheckedReason): CitationVerdict => ({
    verdict: 'unchecked',
    reason,
  })
  if (!isValidSpan(citation.start, citation.end))
    return unchecked('invalid-span')
  const symbol = normalizeSymbol(citation.symbol)
  if (symbol === undefined) return unchecked('no-symbol')

  const read = readContainedFile(
    root,
    citation.path,
    options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes },
  )
  if (read.kind === 'refused') return unchecked(read.reason)

  const content = read.bytes.toString('utf8')
  const span = splitLines(content)
    .slice(citation.start - 1, citation.end)
    .join('\n')
  if (containsIdentifier(span, symbol)) return { verdict: 'passed' }
  return {
    verdict: 'not-in-span',
    foundElsewhere: containsIdentifier(content, symbol),
  }
}

export interface ExtractedCitation {
  readonly path: string
  readonly start: number
  readonly end: number
  /** The first identifier the citing sentence names in backticks. */
  readonly symbol?: string
  /** 1-based line of the citation in the text. */
  readonly line: number
}

const CITATION_PATTERN =
  /(?<![\w./@+:-])([\w@+.-]+(?:\/[\w@+.-]+)*):(\d+)(?:-(\d+))?(?![\w:])/g
const CITED_EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/
const CODE_SPAN = /`([^`\n]+)`/g
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/
const FENCE = /^\s*(```|~~~)/

interface ProseLine {
  readonly text: string
  readonly lineNo: number
}

/** Paragraphs of consecutive prose lines; fenced blocks are skipped. */
function proseParagraphs(text: string): ProseLine[][] {
  const paragraphs: ProseLine[][] = []
  let current: ProseLine[] = []
  let fenced = false
  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current)
    current = []
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (FENCE.test(line)) {
      fenced = !fenced
      flush()
    } else if (fenced || line.trim() === '') {
      flush()
    } else {
      current.push({ text: line, lineNo: index + 1 })
    }
  }
  flush()
  return paragraphs
}

/** Which characters sit inside a backtick span, backticks included. */
function codeMask(text: string): boolean[] {
  const mask: boolean[] = []
  let inside = false
  for (const char of text) {
    if (char === '`') {
      inside = !inside
      mask.push(true)
    } else {
      mask.push(inside)
    }
  }
  return mask
}

/** Offsets where a sentence ends: `.`, `!`, `?` or `;` outside code, then whitespace or the end. */
function sentenceEnds(text: string, mask: readonly boolean[]): number[] {
  const ends: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (mask[index] === true || !'.!?;'.includes(text[index] ?? '')) continue
    const next = text[index + 1]
    if (next === undefined || /\s/.test(next)) ends.push(index + 1)
  }
  return ends
}

function looksLikeSymbol(content: string): boolean {
  if (!IDENTIFIER_CHAIN.test(content)) return false
  const name = content.replace(/\(\)$/, '')
  return (
    name.includes('_') ||
    /[a-z0-9][A-Z]/.test(name) ||
    /^[A-Z][A-Z0-9]{2,}$/.test(name)
  )
}

function sentenceSymbol(
  sentence: string,
  citationText: string,
): string | undefined {
  for (const match of sentence.matchAll(CODE_SPAN)) {
    const content = match[1] ?? ''
    if (content.includes(citationText)) continue
    if (looksLikeSymbol(content)) return content.replace(/\(\)$/, '')
  }
  return undefined
}

/**
 * The `path.ext:N[-M]` citations in markdown prose, each with the first
 * identifier its sentence names in backticks. Lexical, not a parser. Known
 * limits: URLs, `path:N:M` stack frames, paths with `.`/`..` segments and
 * absolute paths are not citations; fenced blocks are skipped; a comma list of
 * lines reads as its first span; a sentence ends at `.`, `!`, `?` or `;`
 * followed by whitespace, outside backticks.
 */
export function extractCitations(text: string): ExtractedCitation[] {
  return proseParagraphs(text).flatMap(paragraphCitations)
}

/** Whether a matched path is a plain relative path with a file extension. */
function isCitablePath(cited: string): boolean {
  return (
    CITED_EXTENSION.test(cited) &&
    !cited.split('/').some((part) => part === '.' || part === '..')
  )
}

function paragraphCitations(
  paragraph: readonly ProseLine[],
): ExtractedCitation[] {
  const joined = paragraph.map((line) => line.text).join('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of paragraph) {
    starts.push(offset)
    offset += line.text.length + 1
  }
  const lineAt = (at: number): number => {
    const index = starts.findLastIndex((start) => start <= at)
    return paragraph[Math.max(index, 0)]?.lineNo ?? 1
  }
  const ends = sentenceEnds(joined, codeMask(joined))
  const found: ExtractedCitation[] = []
  for (const match of joined.matchAll(CITATION_PATTERN)) {
    const cited = match[1] ?? ''
    if (!isCitablePath(cited)) continue
    const at = match.index ?? 0
    const from = ends.filter((end) => end <= at).at(-1) ?? 0
    const to = ends.find((end) => end > at) ?? joined.length
    const symbol = sentenceSymbol(joined.slice(from, to), match[0])
    const start = Number(match[2])
    found.push({
      path: cited,
      start,
      end: match[3] === undefined ? start : Number(match[3]),
      ...(symbol === undefined ? {} : { symbol }),
      line: lineAt(at),
    })
  }
  return found
}

export interface CitedDocument {
  readonly path: string
  readonly text: string
}

export interface ProjectCitation {
  readonly document: string
  readonly line: number
  readonly citation: Omit<ExtractedCitation, 'line'>
  readonly result: CitationVerdict
}

export interface ProjectCitationReport {
  /** True when no document holds a path-and-line citation, so none could be checked. */
  readonly unsupported: boolean
  readonly citations: readonly ProjectCitation[]
  /** True when the citation cap stopped the check. */
  readonly truncated: boolean
}

export interface ProjectCitationOptions {
  readonly bounds?: Partial<ConnectBounds>
  readonly maxBytes?: number
}

/**
 * Check every `path:line` citation in a project's documents against the
 * project's files. A project whose documents hold none is `unsupported`: the
 * check has nothing to say about it, which is not the same as every citation
 * holding.
 */
export function reportProjectCitations(
  root: string,
  documents: readonly CitedDocument[],
  options: ProjectCitationOptions = {},
): ProjectCitationReport {
  const cap =
    options.bounds?.maxCitationsPerProject ??
    CONNECT_BOUNDS.maxCitationsPerProject
  const citations: ProjectCitation[] = []
  let truncated = false
  for (const document of documents) {
    for (const { line, ...citation } of extractCitations(document.text)) {
      if (citations.length >= cap) {
        truncated = true
        break
      }
      citations.push({
        document: document.path,
        line,
        citation,
        result: checkCitation(
          root,
          citation,
          options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes },
        ),
      })
    }
    if (truncated) break
  }
  return {
    unsupported: citations.length === 0 && !truncated,
    citations,
    truncated,
  }
}

// ── Inventory ───────────────────────────────────────────────────────────────

/** What a file is evidence of. The order is the inventory order. */
export const INVENTORY_ROLES = [
  'learning',
  'plan',
  'brainstorm',
  'workflow',
  'config',
  'code',
] as const

export type InventoryRole = (typeof INVENTORY_ROLES)[number]

const CORPUS_DIRECTORIES: ReadonlyArray<readonly [string, InventoryRole]> = [
  ['docs/solutions/', 'learning'],
  ['docs/plans/', 'plan'],
  ['docs/brainstorms/', 'brainstorm'],
]

const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
])

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.sh',
  '.sql',
  '.lua',
])

/** Lockfiles whose extension the eligibility lists would otherwise accept. */
const LOCKFILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml'])

/**
 * Names that are never evidence: vendored code, env files, lockfiles and
 * minified bundles. Names whose extension no eligibility list accepts (such as
 * `.lock`, `.lockb`, `.sum` and `.map`) are already left out by those lists.
 */
function isExcludedPath(segments: readonly string[], name: string): boolean {
  return (
    segments.includes('node_modules') ||
    name.startsWith('.env') ||
    LOCKFILE_NAMES.has(name) ||
    name.endsWith('.min.js')
  )
}

/** The role of a tracked path, or undefined when it is not evidence. */
function classifyPath(rel: string): InventoryRole | undefined {
  const segments = rel.split('/')
  const name = segments.at(-1) ?? ''
  if (isExcludedPath(segments, name)) return undefined
  const extension = path.posix.extname(name)
  const corpus = CORPUS_DIRECTORIES.find(([prefix]) => rel.startsWith(prefix))
  if (corpus !== undefined && extension === '.md') return corpus[1]
  if (
    rel.startsWith('.github/workflows/') &&
    (extension === '.yml' || extension === '.yaml')
  ) {
    return 'workflow'
  }
  if (
    CONFIG_EXTENSIONS.has(extension) ||
    name === 'Dockerfile' ||
    name === 'Makefile'
  ) {
    return 'config'
  }
  return CODE_EXTENSIONS.has(extension) ? 'code' : undefined
}

export interface InventoryFile {
  readonly path: string
  readonly role: InventoryRole
  readonly bytes: number
  readonly sha256: string
}

export interface SkippedFile {
  readonly path: string
  readonly reason: ReadFailure
}

export type InventoryResult =
  | {
      readonly status: 'ok'
      /** The verified main repository root, as a realpath. */
      readonly mainRoot: string
      readonly files: readonly InventoryFile[]
      /** Files listed but not hashed. At most `MAX_LISTED_SKIPS` are named. */
      readonly skipped: readonly SkippedFile[]
      readonly skippedCount: number
      readonly excluded: {
        readonly symlinks: number
        readonly submodules: number
        /** Unmerged entries and modes other than a regular file. */
        readonly unmerged: number
        /** Tracked files that an ignore rule matches. */
        readonly ignored: number
        /** Tracked regular files that are not evidence. */
        readonly ineligible: number
      }
      readonly truncated: {
        /** The file-count cap dropped eligible files. */
        readonly files: boolean
        /** The hashing cap stopped the inventory. */
        readonly hashCap: boolean
      }
    }
  /** The entry is not an allowed main checkout; `reason` is the allow-entry reason. */
  | { readonly status: 'unmatched'; readonly reason: AllowEntryMissReason }
  | {
      readonly status: 'failed'
      readonly reason:
        | 'git-unavailable'
        | 'git-failed'
        | 'listing-too-large'
        | 'listing-malformed'
    }

export interface InventoryOptions {
  readonly bounds?: Partial<ConnectBounds>
  readonly gitBinary?: string
}

const MAX_LISTED_SKIPS = 100
const LISTING_RECORD = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/
const REGULAR_MODES = new Set(['100644', '100755'])
const SYMLINK_MODE = '120000'
const SUBMODULE_MODE = '160000'

function codepointOrder(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function inRoleOrder(
  a: { path: string; role: InventoryRole },
  b: { path: string; role: InventoryRole },
): number {
  const byRole =
    INVENTORY_ROLES.indexOf(a.role) - INVENTORY_ROLES.indexOf(b.role)
  return byRole === 0 ? codepointOrder(a.path, b.path) : byRole
}

type InventoryFailure = Extract<InventoryResult, { status: 'failed' }>
type EligibleFile = { path: string; role: InventoryRole }
type InventoryExcluded = Extract<InventoryResult, { status: 'ok' }>['excluded']

function failure(reason: InventoryFailure['reason']): InventoryFailure {
  return { status: 'failed', reason }
}

/** Map a git run that did not complete to an inventory failure. */
function gitFailure(run: GitRun): InventoryFailure | undefined {
  if (run.status === 'ok') return undefined
  if (run.status === 'refused' || run.reason === 'output-too-large') {
    return failure('git-failed')
  }
  return failure(run.reason)
}

/**
 * One `ls-files --stage` record: the file when it is eligible, the bucket it
 * is counted in when it is not, or undefined when the record is malformed.
 */
function classifyListingRecord(
  record: string,
):
  | EligibleFile
  | 'symlinks'
  | 'submodules'
  | 'unmerged'
  | 'ineligible'
  | undefined {
  const match = LISTING_RECORD.exec(record)
  if (match === null) return undefined
  const mode = match[1] ?? ''
  const rel = match[4] ?? ''
  if (match[3] !== '0') return 'unmerged'
  if (mode === SYMLINK_MODE) return 'symlinks'
  if (mode === SUBMODULE_MODE) return 'submodules'
  if (!REGULAR_MODES.has(mode)) return 'unmerged'
  const role = classifyPath(rel)
  return role === undefined ? 'ineligible' : { path: rel, role }
}

/**
 * List the index once and sort its entries: symlinks and submodules are
 * counted and dropped here, before any file is opened.
 */
function listEligible(
  mainRoot: string,
  maxListingBytes: number,
  gitOptions: GitRunOptions,
):
  | { eligible: EligibleFile[]; excluded: InventoryExcluded }
  | InventoryFailure {
  const listing = runGit(mainRoot, 'ls-files', ['-z', '--cached', '--stage'], {
    ...gitOptions,
    maxBytes: maxListingBytes,
  })
  if (listing.status === 'failed' && listing.reason === 'output-too-large') {
    return failure('listing-too-large')
  }
  const failed = gitFailure(listing)
  if (failed !== undefined) return failed
  if (listing.status !== 'ok' || listing.exitCode !== 0) {
    return failure('git-failed')
  }

  const excluded = {
    symlinks: 0,
    submodules: 0,
    unmerged: 0,
    ignored: 0,
    ineligible: 0,
  }
  const eligible: EligibleFile[] = []
  for (const record of listing.stdout.toString('utf8').split('\0')) {
    if (record === '') continue
    const entry = classifyListingRecord(record)
    if (entry === undefined) return failure('listing-malformed')
    if (typeof entry === 'string') excluded[entry]++
    else eligible.push(entry)
  }
  eligible.sort(inRoleOrder)
  return { eligible, excluded }
}

/**
 * The listed paths that an ignore rule matches. Paths go to `check-ignore` on
 * stdin, NUL-separated, so no file name can act as an option or carry a
 * newline into the framing. The `./` prefix stops a name that starts with `:`
 * from being read as pathspec magic; it comes back in the output and is
 * stripped.
 */
function ignoredPaths(
  mainRoot: string,
  files: readonly EligibleFile[],
  gitOptions: GitRunOptions,
): Set<string> | InventoryFailure {
  const ignored = new Set<string>()
  if (files.length === 0) return ignored
  const run = runGit(
    mainRoot,
    'check-ignore',
    ['--stdin', '-z', '--no-index'],
    {
      ...gitOptions,
      input: Buffer.from(files.map((file) => `./${file.path}\0`).join('')),
    },
  )
  const failed = gitFailure(run)
  if (failed !== undefined) return failed
  // Exit 0: some paths matched. Exit 1: none did. Anything else is an error.
  if (run.status !== 'ok' || (run.exitCode !== 0 && run.exitCode !== 1)) {
    return failure('git-failed')
  }
  for (const rel of run.stdout.toString('utf8').split('\0')) {
    if (rel.startsWith('./')) ignored.add(rel.slice(2))
  }
  return ignored
}

/** Read and hash the files in order until the hashing cap. */
function hashFiles(
  mainRoot: string,
  files: readonly EligibleFile[],
  bounds: ConnectBounds,
): Pick<
  Extract<InventoryResult, { status: 'ok' }>,
  'files' | 'skipped' | 'skippedCount'
> & { hashCapReached: boolean } {
  const hashed: InventoryFile[] = []
  const skipped: SkippedFile[] = []
  let skippedCount = 0
  let hashedBytes = 0
  for (const file of files) {
    const read = readContainedFile(mainRoot, file.path, {
      maxBytes: bounds.maxFileBytes,
    })
    if (read.kind === 'refused') {
      skippedCount++
      if (skipped.length < MAX_LISTED_SKIPS) {
        skipped.push({ path: file.path, reason: read.reason })
      }
      continue
    }
    if (hashedBytes + read.bytes.length > bounds.maxHashedBytesPerProject) {
      return { files: hashed, skipped, skippedCount, hashCapReached: true }
    }
    hashedBytes += read.bytes.length
    hashed.push({
      path: file.path,
      role: file.role,
      bytes: read.bytes.length,
      sha256: read.sha256,
    })
  }
  return { files: hashed, skipped, skippedCount, hashCapReached: false }
}

/**
 * Inventory the tracked, regular, eligible files of one allowed project.
 *
 * `entry` goes through `resolveAllowEntry`, so only a main checkout is read.
 * Git lists the index once (`ls-files -z --cached --stage`); symlinks and
 * submodules are dropped from the listing before any file is opened. Eligible
 * files are corpus documents, workflows, config and code, kept in role order
 * up to the file cap, then filtered through `check-ignore`. Each file is read
 * through `readContainedFile` and hashed until the hashing cap. A cap sets its
 * `truncated` flag; a file that cannot be read is named in `skipped`. Nothing
 * is written to the project. Never throws.
 */
export function inventoryProject(
  entry: string,
  options: InventoryOptions = {},
): InventoryResult {
  const bounds = { ...CONNECT_BOUNDS, ...options.bounds }
  const resolution = resolveAllowEntry(entry)
  if (resolution.status === 'unmatched') {
    return { status: 'unmatched', reason: resolution.reason }
  }
  const { mainRoot } = resolution
  const gitOptions =
    options.gitBinary === undefined ? {} : { gitBinary: options.gitBinary }

  const listed = listEligible(mainRoot, bounds.maxListingBytes, gitOptions)
  if ('status' in listed) return listed
  const kept = listed.eligible.slice(0, bounds.maxFilesPerProject)

  const ignored = ignoredPaths(mainRoot, kept, gitOptions)
  if (!(ignored instanceof Set)) return ignored
  const unignored = kept.filter((file) => !ignored.has(file.path))
  const hashed = hashFiles(mainRoot, unignored, bounds)

  return {
    status: 'ok',
    mainRoot,
    files: hashed.files,
    skipped: hashed.skipped,
    skippedCount: hashed.skippedCount,
    excluded: { ...listed.excluded, ignored: kept.length - unignored.length },
    truncated: {
      files: listed.eligible.length > bounds.maxFilesPerProject,
      hashCap: hashed.hashCapReached,
    },
  }
}
