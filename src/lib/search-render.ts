/**
 * Renderer for durable-output search results.
 *
 * Turns the core's structured result into the one text every surface returns.
 * Owns sanitising, field caps, the snippet window, the warning cap and the
 * 16 KB cut with Systematic's own marker. Imports only types from the corpus
 * and external modules, so render tests never load filesystem code.
 *
 * `renderExternalResult` and `renderExternalFixedReply` render `kind:
 * "external"` the same way, with their own 12 KB allowance and marker. They
 * share the sanitizer, the field caps and the cut, and leave
 * `renderSearchResult` alone.
 *
 * Everything echoed passes `sanitizeInline` first, because titles, tags, file
 * names and bodies are untrusted text that ends up in an agent's context and
 * a human's terminal.
 */

import type { CorpusDocument, DocumentKind } from './search-corpus.js'
import type { ExternalRecord, SourceState } from './search-external.js'
import type { ProjectState, SourceOrigin } from './search-external-sources.js'

/** Hard cap on rendered output, in UTF-8 bytes. */
export const MAX_OUTPUT_BYTES = 16 * 1024
/** Appended on its own line when output is cut. */
export const TRUNCATION_MARKER =
  '[Systematic: search output truncated at 16 KB]'
export const MAX_TITLE_CHARS = 160
export const MAX_TAGS = 8
export const MAX_SNIPPET_CHARS = 240
export const MAX_WARNINGS = 5
/** The lifecycle line that lists the docs a successor replaces. */
export const SUPERSEDES_LABEL = 'Supersedes:'
/** The lifecycle line that names a successor in another kind. Information, not a caution. */
export const SUCCESSOR_LABEL = 'Successor:'

const MAX_TAG_CHARS = 64
const MAX_MODULE_CHARS = 120
const MAX_QUERY_ECHO_CHARS = 200
const MAX_WARNING_CHARS = 200
const MAX_NOTE_CHARS = 200
const MAX_LIFECYCLE_LINE_CHARS = 400
/** Cap on one predecessor path in a `Supersedes:` line. */
const MAX_PATH_CHARS = 400
const MAX_LABEL_CHARS = 40
const ELLIPSIS = '…'

/**
 * The status a hit prints. A solution gets `active`, `stale` or `superseded`;
 * the other kinds get the recorded value as written, or `unspecified`.
 */
export type SearchHitStatus = string

export interface SearchHit {
  /** 1-based position in the final list. */
  readonly rank: number
  readonly document: CorpusDocument
  readonly status: SearchHitStatus
  /** Fully formed `Supersedes:`, `Successor:` and `Caution:` lines, in print order. */
  readonly lifecycle: readonly string[]
}

/** What one searched kind held: its directory, its state and how many documents loaded. */
export interface KindCorpus {
  readonly kind: DocumentKind
  /** Root-relative directory, with `/` separators and no trailing slash. */
  readonly dir: string
  readonly state: 'none' | 'empty' | 'docs'
  readonly docCount: number
}

export interface SearchResult {
  /** The query as the caller sent it; sanitised and capped when echoed. */
  readonly query: string
  /** Unique, sorted query terms, used to pick snippet windows. */
  readonly queryTerms: readonly string[]
  /**
   * `none`: no searched directory exists. `empty`: a directory exists but none
   * holds an indexable doc. `docs` otherwise. `kinds` is one report per searched
   * kind, in table order: one entry for a single-kind search, every kind for `all`.
   */
  readonly corpus: {
    readonly state: 'none' | 'empty' | 'docs'
    readonly docCount: number
    readonly kinds: readonly KindCorpus[]
  }
  readonly hits: readonly SearchHit[]
  readonly notes: readonly string[]
  readonly warnings: readonly string[]
}

const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this strips terminal escapes from untrusted text before it is echoed
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
const LINE_BREAKS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this turns line breaks and tabs in untrusted text into a space
  /[\t\n\r\u000b\u000c\u0085\u2028\u2029]+/g
const CONTROL_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this strips control characters from untrusted text before it is echoed
  /[\u0000-\u001f\u007f-\u009f]/g
// Zero-width characters, bidirectional overrides and isolates, and the BOM.
const INVISIBLE_FORMATTING =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Cut to `max` UTF-16 units including the ellipsis, never inside a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = Math.max(0, max - ELLIPSIS.length)
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1
  return `${text.slice(0, cut)}${ELLIPSIS}`
}

/**
 * One line of safe text: terminal escape sequences removed, line breaks and
 * tabs turned into a space, every other control character and invisible
 * formatting character dropped, whitespace collapsed, then capped at `max`
 * characters with an ellipsis.
 */
export function sanitizeInline(
  text: string,
  max: number = Number.POSITIVE_INFINITY,
): string {
  const clean = text
    .replace(ANSI_SEQUENCE, '')
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROL_CHARACTERS, '')
    .replace(INVISIBLE_FORMATTING, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  return clip(clean, max)
}

/**
 * Cut `text` so the result, marker included, is at most `maxBytes` of UTF-8.
 * The cut lands on a character boundary, and on a line boundary when the kept
 * text has one. The marker goes on its own line. Text that already fits is
 * returned unchanged.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
  marker: string,
): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text

  const tail = `\n${marker}`
  const budget = Math.max(0, maxBytes - encoder.encode(tail).byteLength)
  let cut = budget
  // Step back off a continuation byte (10xxxxxx) onto a character boundary.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1
  let kept = new TextDecoder('utf-8').decode(bytes.subarray(0, cut))
  const lastBreak = kept.lastIndexOf('\n')
  if (lastBreak > 0) kept = kept.slice(0, lastBreak)
  return `${kept}${tail}`
}

const IDENTIFIER_RUN = /[a-z0-9]+(?:[_-]+[a-z0-9]+)*/gi
const WORD = /[a-z0-9]+/g

interface Occurrence {
  readonly start: number
  readonly end: number
  readonly terms: readonly string[]
}

/** Query terms that a run of identifier characters satisfies. Mirrors the tokenizer. */
function matchedTerms(run: string, wanted: ReadonlySet<string>): string[] {
  const lower = run.toLowerCase()
  const matched: string[] = []
  if (wanted.has(lower)) matched.push(lower)
  if (lower.includes('_') || lower.includes('-')) {
    for (const part of lower.match(WORD) ?? []) {
      if (wanted.has(part) && !matched.includes(part)) matched.push(part)
    }
  }
  return matched
}

function findOccurrences(
  text: string,
  wanted: ReadonlySet<string>,
): Occurrence[] {
  const found: Occurrence[] = []
  for (const match of text.matchAll(IDENTIFIER_RUN)) {
    const run = match[0]
    const terms = matchedTerms(run, wanted)
    if (terms.length === 0) continue
    const start = match.index ?? 0
    found.push({ start, end: start + run.length, terms })
  }
  return found
}

interface Window {
  readonly first: number
  readonly last: number
}

function addTerms(counts: Map<string, number>, terms: readonly string[]) {
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1)
}

function removeTerms(counts: Map<string, number>, terms: readonly string[]) {
  for (const term of terms) {
    const remaining = (counts.get(term) ?? 1) - 1
    if (remaining <= 0) counts.delete(term)
    else counts.set(term, remaining)
  }
}

/**
 * The window of occurrences, at most `width` characters wide, holding the most
 * distinct query terms. Integer counts; the earliest window wins a tie.
 */
function densestWindow(
  occurrences: readonly Occurrence[],
  width: number,
): Window | undefined {
  const counts = new Map<string, number>()
  let best: Window | undefined
  let bestDistinct = 0
  let next = 0
  for (let first = 0; first < occurrences.length; first++) {
    const head = occurrences[first]
    if (head === undefined) break
    for (
      let candidate = occurrences[next];
      candidate !== undefined && candidate.end - head.start <= width;
      candidate = occurrences[next]
    ) {
      addTerms(counts, candidate.terms)
      next += 1
    }
    if (next === first) {
      // This occurrence alone is wider than the window.
      next = first + 1
      continue
    }
    if (counts.size > bestDistinct) {
      bestDistinct = counts.size
      best = { first, last: next - 1 }
    }
    removeTerms(counts, head.terms)
  }
  return best
}

function cutAround(
  text: string,
  spanStart: number,
  spanEnd: number,
  inner: number,
): string {
  const middle = Math.floor((spanStart + spanEnd) / 2)
  let begin = Math.max(0, middle - Math.floor(inner / 2))
  const end0 = Math.min(text.length, begin + inner)
  begin = Math.max(0, end0 - inner)
  let end = end0

  if (begin > 0 && text.charAt(begin - 1) !== ' ') {
    const space = text.indexOf(' ', begin)
    if (space !== -1 && space + 1 <= spanStart) begin = space + 1
  }
  if (end < text.length && text.charAt(end) !== ' ') {
    const space = text.lastIndexOf(' ', end)
    if (space >= spanEnd) end = space
  }
  if (begin > 0 && isLowSurrogate(text.charCodeAt(begin))) begin += 1
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1

  const body = text.slice(begin, end).trim()
  return `${begin > 0 ? ELLIPSIS : ''}${body}${end < text.length ? ELLIPSIS : ''}`
}

/** The window of `text` holding the most distinct query terms, if any term matches. */
function bodySnippet(
  text: string,
  queryTerms: readonly string[],
): string | undefined {
  if (text === '' || queryTerms.length === 0) return undefined
  const occurrences = findOccurrences(text, new Set(queryTerms))
  const head = occurrences[0]
  if (head === undefined) return undefined

  // Room for an ellipsis at each end.
  const inner = MAX_SNIPPET_CHARS - 2 * ELLIPSIS.length
  const window = densestWindow(occurrences, inner)
  const first = window === undefined ? head : occurrences[window.first]
  const last = window === undefined ? head : occurrences[window.last]
  if (first === undefined || last === undefined) return undefined
  // No window means every match is wider than the snippet: show its start.
  const snippet =
    window === undefined
      ? clip(text.slice(first.start), MAX_SNIPPET_CHARS)
      : cutAround(text, first.start, last.end, inner)
  return snippet === '' ? undefined : snippet
}

/**
 * A one-line snippet of at most 240 characters. Picks the window of the body
 * holding the most distinct query terms (earliest on a tie) and centres on it.
 * With no match in the body it falls back to the symptoms, then the title.
 * Only called for the hits being returned.
 */
export function extractSnippet(
  document: Pick<CorpusDocument, 'body' | 'symptoms' | 'title'>,
  queryTerms: readonly string[],
): string {
  const fromBody = bodySnippet(sanitizeInline(document.body), queryTerms)
  if (fromBody !== undefined) return fromBody
  const symptoms = sanitizeInline(
    document.symptoms.join('; '),
    MAX_SNIPPET_CHARS,
  )
  if (symptoms !== '') return symptoms
  return sanitizeInline(document.title, MAX_SNIPPET_CHARS)
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

/** `a`, `a or b`, `a, b or c`. */
function joinOr(items: readonly string[]): string {
  const last = items[items.length - 1]
  if (items.length < 2 || last === undefined) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${last}`
}

/** `solution 128, plan 102, brainstorm none, ideation empty`. */
function kindTokens(kinds: readonly KindCorpus[]): string {
  return kinds
    .map(
      ({ kind, state, docCount }) =>
        `${kind} ${state === 'docs' ? docCount : state}`,
    )
    .join(', ')
}

function renderHeader(result: SearchResult): string {
  const query = sanitizeInline(result.query, MAX_QUERY_ECHO_CHARS)
  const prefix = `Search "${query}":`
  const { corpus } = result
  const [only, ...others] = corpus.kinds
  const single = only !== undefined && others.length === 0
  switch (corpus.state) {
    case 'none': {
      const dirs = joinOr(corpus.kinds.map(({ dir }) => `${dir}/`))
      return `${prefix} corpus: none (no ${dirs} directory under the project root).`
    }
    case 'empty':
      return single
        ? `${prefix} corpus: empty (${only.dir}/ holds no indexable docs).`
        : `${prefix} corpus: empty (no indexable docs: ${kindTokens(corpus.kinds)}).`
    case 'docs': {
      const counts = `${plural(corpus.docCount, 'doc')}, ${plural(result.hits.length, 'hit')}`
      const searched = single ? only.dir : kindTokens(corpus.kinds)
      return `${prefix} ${counts}. Corpus: ${searched}.`
    }
  }
}

/**
 * One lifecycle line. A `Supersedes:` line lists every predecessor path, so it
 * is sanitized and capped per path: a successor that replaces many docs keeps
 * all of them, and only the overall 16 KB cut bounds the total. A `Successor:`
 * line names one path, sanitized and capped the same way. Any other line
 * (`Caution:`) keeps one cap for the whole line.
 */
function renderLifecycleLine(line: string): string {
  const supersedes = `${SUPERSEDES_LABEL} `
  if (line.startsWith(supersedes)) {
    const paths = line
      .slice(supersedes.length)
      .split(', ')
      .map((path) => sanitizeInline(path, MAX_PATH_CHARS))
      .filter((path) => path !== '')
    return `${supersedes}${paths.join(', ')}`
  }
  const successor = `${SUCCESSOR_LABEL} `
  if (line.startsWith(successor)) {
    return `${successor}${sanitizeInline(line.slice(successor.length), MAX_PATH_CHARS)}`
  }
  return sanitizeInline(line, MAX_LIFECYCLE_LINE_CHARS)
}

function renderHit(hit: SearchHit, queryTerms: readonly string[]): string[] {
  const { document } = hit
  const lines = [`${hit.rank}. ${sanitizeInline(document.path)}`]
  lines.push(
    `   ${[
      `Title: ${sanitizeInline(document.title, MAX_TITLE_CHARS)}`,
      `Kind: ${sanitizeInline(document.kind, MAX_LABEL_CHARS)}`,
      `Status: ${sanitizeInline(hit.status, MAX_LABEL_CHARS)}`,
    ].join(' | ')}`,
  )

  const module =
    document.module === undefined
      ? ''
      : sanitizeInline(document.module, MAX_MODULE_CHARS)
  const tags = document.tags
    .map((tag) => sanitizeInline(tag, MAX_TAG_CHARS))
    .filter((tag) => tag !== '')
    .slice(0, MAX_TAGS)
  const meta: string[] = []
  if (module !== '') meta.push(`Module: ${module}`)
  if (tags.length > 0) meta.push(`Tags: ${tags.join(', ')}`)
  if (meta.length > 0) lines.push(`   ${meta.join(' | ')}`)

  lines.push(`   Snippet: ${extractSnippet(document, queryTerms)}`)
  for (const line of hit.lifecycle)
    lines.push(`   ${renderLifecycleLine(line)}`)
  return lines
}

/** Render a structured result as text, never more than `MAX_OUTPUT_BYTES`. */
export function renderSearchResult(result: SearchResult): string {
  const lines = [renderHeader(result)]

  if (result.notes.length > 0) {
    lines.push(
      `Notes: ${result.notes.map((note) => sanitizeInline(note, MAX_NOTE_CHARS)).join('; ')}`,
    )
  }
  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of result.warnings.slice(0, MAX_WARNINGS)) {
      lines.push(`- ${sanitizeInline(warning, MAX_WARNING_CHARS)}`)
    }
    const hidden = result.warnings.length - MAX_WARNINGS
    if (hidden > 0) lines.push(`- +${hidden} more`)
  }

  for (const hit of result.hits) {
    lines.push('', ...renderHit(hit, result.queryTerms))
  }

  return truncateUtf8(lines.join('\n'), MAX_OUTPUT_BYTES, TRUNCATION_MARKER)
}

// --- External sources -------------------------------------------------------

/** Hard cap on a rendered `external` reply, in UTF-8 bytes. Built-in output keeps 16 KB. */
export const EXTERNAL_MAX_OUTPUT_BYTES = 12 * 1024
/** Appended on its own line when an `external` reply is cut. It says 12 KB, never 16 KB. */
export const EXTERNAL_TRUNCATION_MARKER =
  '[Systematic: search output truncated at 12 KB]'

const EXTERNAL_PREFIX = 'External sources for'
const MAX_SECTION_NAME_CHARS = 40
const MAX_ROOTS_CHARS = 400
const MAX_NODE_TYPE_CHARS = 40

/** One returned hit of one external source. `rank` is 1-based within its source. */
export interface ExternalHit {
  readonly rank: number
  readonly record: ExternalRecord
}

/**
 * One active source in a reply. `hits` is the ranked list after the per-source
 * limit; the renderer drops whole hits from the end when the source goes past
 * its share of the allowance.
 */
export interface ExternalSection {
  readonly name: string
  readonly origin: SourceOrigin
  /** Absolute roots, as resolved. The renderer collapses the home directory to `~`. */
  readonly roots: readonly string[]
  readonly state: SourceState
  /** Records the source loaded; reported only for a loaded source with no hit. */
  readonly recordCount: number
  readonly hits: readonly ExternalHit[]
}

export interface ExternalSearchResult {
  /** The query as the caller sent it; sanitised and capped when echoed. */
  readonly query: string
  /** Unique, sorted query terms, used to pick snippet windows. */
  readonly queryTerms: readonly string[]
  /** The home directory `~` stands for in a section root. */
  readonly homeDir: string
  readonly project: ProjectState
  /** In the order they print. */
  readonly sections: readonly ExternalSection[]
  readonly notes: readonly string[]
  readonly warnings: readonly string[]
}

/** The replies the core owns, all `ok: true`. */
export type ExternalFixedReply =
  | { readonly kind: 'no-project' }
  | { readonly kind: 'no-active-source' }
  | {
      readonly kind: 'not-allowed'
      readonly proposals: number
      /** The verified main-root string; absent when the identity is unresolved. */
      readonly mainRoot?: string | undefined
    }

export interface ExternalReplyContext {
  /** Raw: a reply can be produced before the query is validated, so it may not be a string. */
  readonly query: unknown
  readonly notes: readonly string[]
  readonly warnings: readonly string[]
  readonly project?: ProjectState | undefined
}

/** The proposal count as a non-negative integer; anything else prints as 0. */
function proposalCount(count: number): number {
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function proposedNoun(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

/** What to do about a not-allowed project: the exact root to add, or why it cannot be allowed. */
function allowAdvice(count: number, mainRoot: string | undefined): string {
  if (mainRoot === undefined) {
    return 'Its identity could not be verified, so it cannot be allowed.'
  }
  const root = sanitizeInline(mainRoot, MAX_PATH_CHARS)
  return `To allow ${count === 1 ? 'it' : 'them'}, add "${root}" to search.allow_project_sources in your user config.`
}

/**
 * The fixed texts of the external replies. The first two are constants; the
 * not-allowed text takes the proposal count and, when the project identity is
 * verified, the exact main-root string to add. Every interpolation is
 * sanitized, and none of them carries a source name or a root. No text holds a
 * built-in routing token (`Corpus:`, `corpus: none`, `corpus: empty`,
 * `N docs, M hits`, `Search "`).
 */
export const EXTERNAL_REPLIES = {
  noProject:
    'no project: there is no .git directory at or above the start directory, so there are no external sources to search.',
  noActiveSource: 'no external sources are active for this project.',
  notAllowed(proposals: number, mainRoot?: string): string {
    const count = proposalCount(proposals)
    return `this project proposes ${count} ${proposedNoun(count, 'external source')}, but it is not in search.allow_project_sources, so nothing was read. ${allowAdvice(count, mainRoot)}`
  },
} as const

function externalPrefix(query: unknown): string {
  const echoed =
    typeof query === 'string' ? sanitizeInline(query, MAX_QUERY_ECHO_CHARS) : ''
  return `${EXTERNAL_PREFIX} "${echoed}":`
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** `Project sources: ...` for the project-level states, or `undefined` when there is nothing to say. */
function projectLine(project: ProjectState): string | undefined {
  switch (project.kind) {
    case 'none':
    case 'allowed':
      return undefined
    case 'config-unreadable':
      return 'Project sources: the project config could not be read, so it proposes none.'
    case 'not-allowed': {
      const count = proposalCount(project.proposals)
      return `Project sources: ${count} ${proposedNoun(count, 'proposed source')} not read: this project is not in search.allow_project_sources. ${allowAdvice(count, project.mainRoot)}`
    }
  }
}

/** Notes, then bounded warnings: the lines every external reply shares after its first line. */
function noteAndWarningLines(
  notes: readonly string[],
  warnings: readonly string[],
  middle: readonly string[] = [],
): string[] {
  const lines: string[] = []
  if (notes.length > 0) {
    lines.push(
      `Notes: ${notes.map((note) => sanitizeInline(note, MAX_NOTE_CHARS)).join('; ')}`,
    )
  }
  lines.push(...middle)
  if (warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of warnings.slice(0, MAX_WARNINGS)) {
      lines.push(`- ${sanitizeInline(warning, MAX_WARNING_CHARS)}`)
    }
    const hidden = warnings.length - MAX_WARNINGS
    if (hidden > 0) lines.push(`- +${hidden} more`)
  }
  return lines
}

/**
 * Render one of the core's fixed replies. The first line is the prefix and the
 * fixed text. No-project and not-allowed add notes only: the not-allowed reply
 * never echoes a source name or a root, so it takes no warnings. The
 * no-active-source reply also carries the project-level config state and the
 * bounded warnings, because those say why nothing is active.
 */
export function renderExternalFixedReply(
  reply: ExternalFixedReply,
  context: ExternalReplyContext,
): string {
  const prefix = externalPrefix(context.query)
  let lines: string[]
  switch (reply.kind) {
    case 'no-project':
      lines = [
        `${prefix} ${EXTERNAL_REPLIES.noProject}`,
        ...noteAndWarningLines(context.notes, []),
      ]
      break
    case 'not-allowed':
      lines = [
        `${prefix} ${EXTERNAL_REPLIES.notAllowed(reply.proposals, reply.mainRoot)}`,
        ...noteAndWarningLines(context.notes, []),
      ]
      break
    case 'no-active-source': {
      const state =
        context.project === undefined ? undefined : projectLine(context.project)
      lines = [
        `${prefix} ${EXTERNAL_REPLIES.noActiveSource}`,
        ...noteAndWarningLines(
          context.notes,
          context.warnings,
          state === undefined ? [] : [state],
        ),
      ]
      break
    }
  }
  return truncateUtf8(
    lines.join('\n'),
    EXTERNAL_MAX_OUTPUT_BYTES,
    EXTERNAL_TRUNCATION_MARKER,
  )
}

/** `/home/me/wiki` becomes `~/wiki` when `homeDir` is `/home/me`; a sibling like `/home/meme` is left alone. */
function collapseHome(root: string, homeDir: string): string {
  if (homeDir === '') return root
  if (root === homeDir) return '~'
  for (const separator of ['/', '\\']) {
    if (root.startsWith(`${homeDir}${separator}`)) {
      return `~${root.slice(homeDir.length)}`
    }
  }
  return root
}

function sectionHeader(section: ExternalSection, homeDir: string): string {
  const roots = section.roots
    .map((root) => collapseHome(root, homeDir))
    .join(', ')
  return `${sanitizeInline(section.name, MAX_SECTION_NAME_CHARS)} (${section.origin}): ${sanitizeInline(roots, MAX_ROOTS_CHARS)}`
}

function sectionStateLine(section: ExternalSection): string | undefined {
  switch (section.state) {
    case 'missing':
      return '   missing: root not found.'
    case 'empty':
      return '   empty: no readable records.'
    case 'unreadable':
      return '   unreadable: root could not be read.'
    case 'dropped':
      return '   dropped: see the warnings.'
    case 'loaded':
      return section.hits.length === 0 ? '   No matching records.' : undefined
  }
}

/** A record prints `node_type` where it has one, else its recorded status, else neither. */
function renderExternalHit(
  hit: ExternalHit,
  queryTerms: readonly string[],
): string[] {
  const { record } = hit
  const title = `Title: ${sanitizeInline(record.title, MAX_TITLE_CHARS)}`
  const label =
    record.nodeType !== undefined
      ? `node_type ${sanitizeInline(record.nodeType, MAX_NODE_TYPE_CHARS)}`
      : record.status !== undefined
        ? `Status: ${sanitizeInline(record.status, MAX_LABEL_CHARS)}`
        : undefined
  return [
    `${hit.rank}. ${sanitizeInline(record.path, MAX_PATH_CHARS)}`,
    `   ${label === undefined ? title : `${title} | ${label}`}`,
    `   Snippet: ${extractSnippet({ body: record.body, symptoms: [], title: record.title }, queryTerms)}`,
  ]
}

function moreHitsLine(count: number): string {
  return `+${count} more hits not shown`
}

/** Bytes one hit adds to a section: a blank line and the hit, each after a line break. */
function hitCost(lines: readonly string[]): number {
  return 2 + byteLength(lines.join('\n'))
}

/**
 * The longest prefix of `hits` that fits in `share` bytes together with the
 * `+N more hits not shown` line for whatever it leaves out. Whole hits only.
 */
function fitHits(
  hits: readonly (readonly string[])[],
  share: number,
): { readonly kept: number; readonly more: number } {
  for (let kept = hits.length; kept > 0; kept--) {
    const used = hits
      .slice(0, kept)
      .reduce((sum, lines) => sum + hitCost(lines), 0)
    const more = hits.length - kept
    const reserve = more > 0 ? 1 + byteLength(moreHitsLine(more)) : 0
    if (used + reserve <= share) return { kept, more }
  }
  return { kept: 0, more: hits.length }
}

/**
 * Render an `external` result: the prefix with the source and hit counts, the
 * notes, the project-level state line, the bounded warnings, then one section
 * per active source in the order given. The text is at most 12 KB. Every
 * source with hits gets an equal share of what the fixed lines leave; a
 * source past its share drops whole hits from the end and prints `+N more hits
 * not shown`. If the fixed lines alone overflow, the cut falls back to the
 * 12 KB marker, so the marker is only ever printed when text was lost.
 */
export function renderExternalResult(result: ExternalSearchResult): string {
  const { sections } = result
  const hitTotal = sections.reduce((sum, { hits }) => sum + hits.length, 0)
  const state = projectLine(result.project)
  const head = [
    `${externalPrefix(result.query)} ${plural(sections.length, 'source')}, ${plural(hitTotal, 'hit')}.`,
    ...noteAndWarningLines(
      result.notes,
      result.warnings,
      state === undefined ? [] : [state],
    ),
  ]

  const fixed = sections.map((section) => {
    const line = sectionStateLine(section)
    return [
      sectionHeader(section, result.homeDir),
      ...(line === undefined ? [] : [line]),
    ]
  })
  const baseBytes = byteLength(
    [...head, ...fixed.flatMap((lines) => ['', ...lines])].join('\n'),
  )
  const withHits = sections.filter(({ hits }) => hits.length > 0).length
  const share =
    withHits === 0
      ? 0
      : Math.floor(
          Math.max(0, EXTERNAL_MAX_OUTPUT_BYTES - baseBytes) / withHits,
        )

  const lines = [...head]
  sections.forEach((section, index) => {
    lines.push('', ...(fixed[index] ?? []))
    const rendered = section.hits.map((hit) =>
      renderExternalHit(hit, result.queryTerms),
    )
    const { kept, more } = fitHits(rendered, share)
    for (const hit of rendered.slice(0, kept)) lines.push('', ...hit)
    if (more > 0) lines.push(moreHitsLine(more))
  })

  return truncateUtf8(
    lines.join('\n'),
    EXTERNAL_MAX_OUTPUT_BYTES,
    EXTERNAL_TRUNCATION_MARKER,
  )
}
