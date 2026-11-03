/**
 * The one host-neutral composition behind durable-output search.
 *
 * `runSearch` validates the request, resolves the project root, loads the
 * corpus of each requested kind, runs the lexical lane over the merged
 * documents, resolves the lifecycle, and renders. Every adapter (OpenCode v1
 * and v2, Pi, the CLI and the standalone search bin) calls it and does only host
 * I/O: the start directory, the settings, and mapping the response to its
 * host's return shape. Adapters never format text themselves.
 *
 * `kind: "external"` is a selector beside the four kinds, not a fifth kind. It
 * takes its own branch: the core resolves the active sources for the call
 * through an injectable resolver, loads each one, ranks each source on its own
 * index, and hands the sections to `renderExternalResult`. Built-in kinds never
 * reach that branch, so their output is unchanged.
 *
 * This module also owns the `SearchSettings` type, the tool name and argument
 * constants, and the lifecycle constants and resolver. The resolver follows
 * the learnings-researcher's rules: at most 5 hops, a visited set, and a form
 * rule for the successor path. A successor resolves within a kind and is only
 * shown across kinds: a link into another kind's directory ends the walk at the
 * last same-kind document with a `Successor:` line. A superseded doc whose
 * successor cannot be resolved is returned at its own rank with
 * `Caution: successor unresolved`. Nothing is dropped.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  type CorpusDocument,
  type CorpusLoad,
  type DocumentKind,
  isDocumentKind,
  KIND_TABLE,
  loadCorpus,
  resolveSearchRoot,
} from './search-corpus.js'
import { loadExternalSources, type SourceLoad } from './search-external.js'
import {
  type ActiveSource,
  type ExternalSourcesInput,
  type ExternalSourcesResolution,
  resolveExternalSources,
} from './search-external-sources.js'
import {
  BM25F_PARAMS,
  type Bm25fParams,
  buildLexicalIndex,
  type LexicalDocument,
  searchLexical,
  uniqueQueryTerms,
} from './search-lexical.js'
import {
  type ExternalFixedReply,
  type ExternalSearchResult,
  type ExternalSection,
  type KindCorpus,
  renderExternalFixedReply,
  renderExternalResult,
  renderSearchResult,
  type SearchHit,
  type SearchHitStatus,
  type SearchResult,
  SUCCESSOR_LABEL,
  SUPERSEDES_LABEL,
  sanitizeInline,
} from './search-render.js'
import {
  resolveUserLevelConfigDirs,
  type UserLevelConfigDirOptions,
} from './search-user-config.js'

export type { SearchHit, SearchResult } from './search-render.js'
export { SUCCESSOR_LABEL, SUPERSEDES_LABEL }

/** Tool name shared by every host surface. */
export const SEARCH_TOOL_NAME = 'systematic_search'
/** Tool argument names shared by every host surface. */
export const SEARCH_ARGS = {
  query: 'query',
  kind: 'kind',
  limit: 'limit',
} as const

export const DEFAULT_LIMIT = 8
export const MIN_LIMIT = 1
export const MAX_LIMIT = 20
export const MAX_QUERY_CHARS = 2000

/** The `kind` value that searches every kind in one ranking. It is a selector, not a table key. */
export const KIND_SELECTOR_ALL = 'all'

/**
 * The `kind` value that searches the user-allowed external sources. Like `all`
 * it is a selector, not a table key, and it is exclusive: it does not combine
 * with a kind or with `all`.
 */
export const KIND_SELECTOR_EXTERNAL = 'external'

/** Most hits one external source returns, whatever `limit` asks for. */
export const MAX_EXTERNAL_HITS_PER_SOURCE = 5

const DOCUMENT_KINDS = Object.keys(KIND_TABLE).filter(isDocumentKind)
const KIND_NAMES = [
  ...DOCUMENT_KINDS,
  KIND_SELECTOR_ALL,
  KIND_SELECTOR_EXTERNAL,
]

/**
 * The tool text every host surface shows the model. `limit` is a plain integer
 * in every host schema, so its range is stated here and nowhere else: the core
 * owns the out-of-range error and a host never pre-empts it.
 */
export const SEARCH_TOOL_DESCRIPTION =
  "Search this project's durable outputs by symptom, error text, module or topic: the docs/solutions learnings, and the docs/plans, docs/brainstorms and docs/ideation documents that earlier work wrote. Returns ranked hits with path, title, kind, snippet, tags and status. A superseded document is replaced by its successor in the same kind, a successor in another kind is named on a Successor line, and a stale one carries a caution. Read a hit's path for the full text. Use it before debugging a failure or planning work that a past learning, plan, brainstorm or ideation doc may already cover. With kind external, a hit's path is `<source>/<path>`: the source name, then a path inside one of that source's roots, which the source's section header lists. Strip the source name to resolve it. The reply does not say which root a hit came from; with several roots, the file is under the first listed root that has it."
export const SEARCH_ARG_DESCRIPTIONS = {
  query: `What to look for: a symptom, error message, module or topic, in plain words. At most ${MAX_QUERY_CHARS} characters.`,
  kind: `Optional. The kind of durable output to search: ${DOCUMENT_KINDS.map((kind) => `"${kind}" (${KIND_TABLE[kind].dir}/)`).join(', ')}, or "${KIND_SELECTOR_ALL}" for every kind in one ranking, or "${KIND_SELECTOR_EXTERNAL}" for the external decision sources the user allowed, each ranked on its own. Defaults to "solution".`,
  limit: `Optional. How many hits to return, an integer from ${MIN_LIMIT} to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}. With kind "${KIND_SELECTOR_EXTERNAL}" it applies to each source instead, and at most ${MAX_EXTERNAL_HITS_PER_SOURCE} hits per source are returned.`,
} as const

/** One-line texts an adapter returns when it cannot reach the core. They carry no detail from the failure. */
export const SEARCH_NOTICES = {
  failed: 'Error: search failed.',
  noProject:
    'No project directory is available for this session, so there is nothing to search.',
} as const
/** The note an adapter passes in `SearchOptions.notes` when a settings source could not be read. */
export const SEARCH_CONFIG_UNREADABLE_NOTE = 'config unreadable'

/** Most `superseded_by` links followed from one candidate. */
export const MAX_SUCCESSOR_HOPS = 5
export const CAUTION_LABEL = 'Caution:'
export const SUCCESSOR_UNRESOLVED_TEXT = 'successor unresolved'
export const STALE_CAUTION_TEXT = 'marked stale'
const MAX_STALE_REASON_CHARS = 200
/** Printed for a plan, brainstorm or ideation hit that records no status. */
const UNSPECIFIED_STATUS = 'unspecified'

/** Fixed validation errors. They never echo the rejected value. */
export const SEARCH_ERRORS = {
  queryEmpty: 'Error: query must be a non-empty string.',
  queryTooLong: `Error: query must be at most ${MAX_QUERY_CHARS} characters.`,
  kindUnknown: `Error: kind must be one of: ${KIND_NAMES.join(', ')}.`,
  limitInvalid: `Error: limit must be an integer from ${MIN_LIMIT} to ${MAX_LIMIT}.`,
} as const

/** User-level search settings. The zod schema's output type must stay assignable to this. */
export interface SearchSettings {
  readonly enabled?: boolean | undefined
}

export interface SearchRequest {
  /** Raw host values: the core validates them. */
  readonly query: unknown
  readonly kind?: unknown
  readonly limit?: unknown
}

export interface SearchOptions {
  /** The directory the root walk-up starts from. */
  readonly startDir: string
  readonly settings?: SearchSettings | undefined
  /** Notes an adapter wants shown ahead of the core's own, such as `SEARCH_CONFIG_UNREADABLE_NOTE`. */
  readonly notes?: readonly string[] | undefined
  /** Override the BM25F table. The recall tuning uses this; hosts do not. */
  readonly lexicalParams?: Bm25fParams | undefined
  /** Replace the disk loader. Tests use this to control load order. */
  readonly corpusLoader?:
    | ((root: string, kind: DocumentKind) => CorpusLoad)
    | undefined
  /**
   * The user-level config directories `kind: "external"` reads its allow list
   * and user sources from. A host or CLI config-dir override goes here; left
   * out, the reader uses the home directory and `OPENCODE_CONFIG_DIR`.
   */
  readonly configOptions?: UserLevelConfigDirOptions | undefined
  /**
   * Replace the per-call external reader. The default resolves the active
   * sources from the user files, the project file and the project identity.
   * Tests use this to control what a call sees.
   */
  readonly externalResolver?: ExternalResolver | undefined
}

/** Reads everything for one `external` call and returns the active sources. The default never throws. */
export type ExternalResolver = (
  input: ExternalSourcesInput,
) => ExternalSourcesResolution

/** The default resolver: the per-call reader in `search-external-sources.ts`. */
export const defaultExternalResolver: ExternalResolver = resolveExternalSources

/**
 * What an `external` call produced: one of the core's fixed replies, or the
 * ranked sections of the active sources.
 */
export type ExternalOutcome =
  | { readonly kind: 'fixed'; readonly reply: ExternalFixedReply }
  | { readonly kind: 'sections'; readonly result: ExternalSearchResult }

/**
 * A response is tagged by `ok`, then by `selector`: a built-in response carries
 * `result` and an external one carries `external`, and neither carries the
 * other, so a consumer must narrow on `selector` before reading either. Every
 * response carries `text`, which is all the adapters read.
 */
export type SearchResponse =
  | {
      readonly ok: true
      readonly selector: 'builtin'
      readonly text: string
      readonly result: SearchResult
    }
  | {
      readonly ok: true
      readonly selector: 'external'
      readonly text: string
      readonly external: ExternalOutcome
      /**
       * Present (and `true`) when the project's config file had a structural
       * error, so it proposed nothing. The reply text already says so; the CLI
       * and the bin also print one stderr warning for it.
       */
      readonly projectConfigUnreadable?: true
    }
  | { readonly ok: false; readonly text: string }

/**
 * Whether a `superseded_by` value has the shape of a repo-root path into
 * `kind`: that kind's directory, a `.md` file, no `..` segment, and neither an
 * excluded file name nor an excluded directory. Every part comes from the
 * kind's table entry.
 */
export function isSuccessorPathForm(
  value: string,
  kind: DocumentKind = 'solution',
): boolean {
  const spec = KIND_TABLE[kind]
  if (!value.startsWith(`${spec.dir}/`)) return false
  if (!value.endsWith('.md')) return false
  const segments = value.split('/')
  if (segments.includes('..')) return false
  const name = segments[segments.length - 1]?.toLowerCase()
  if (
    name !== undefined &&
    (spec.excludedFiles as readonly string[]).includes(name)
  ) {
    return false
  }
  return !segments.some((segment) =>
    (spec.excludedDirs as readonly string[]).includes(segment),
  )
}

/** The first kind, in table order, whose form rule the link fits. */
export function successorFormKind(value: string): DocumentKind | undefined {
  return DOCUMENT_KINDS.find((kind) => isSuccessorPathForm(value, kind))
}

/**
 * Solutions compare their lifecycle status exactly, as they always have. The
 * other kinds were written by hand with mixed case and stray spaces, so their
 * `superseded` and `stale` triggers compare trimmed and lower-cased.
 */
function hasStatus(
  document: CorpusDocument,
  wanted: 'superseded' | 'stale',
): boolean {
  if (document.status === undefined) return false
  if (document.kind === 'solution') return document.status === wanted
  return document.status.trim().toLowerCase() === wanted
}

type SuccessorWalk =
  | { readonly outcome: 'unresolved' }
  | {
      readonly outcome: 'resolved'
      /** The first document that is not superseded, or the last same-kind one before a cross-kind link. */
      readonly document: CorpusDocument
      /** The cross-kind link the walk stopped at, if any. */
      readonly successorPath: string | undefined
    }

type SuccessorHop =
  | SuccessorWalk
  /** The link names a superseded same-kind document: keep walking from it. */
  | { readonly outcome: 'continue'; readonly next: CorpusDocument }

/** Read one `superseded_by` link of `current` and decide what it means. */
function stepSuccessor(
  current: CorpusDocument,
  byPath: ReadonlyMap<string, CorpusDocument>,
  visited: Set<string>,
): SuccessorHop {
  const link = current.supersededBy
  if (link.state !== 'value') return { outcome: 'unresolved' }
  if (!isSuccessorPathForm(link.value, current.kind)) {
    if (successorFormKind(link.value) === undefined) {
      return { outcome: 'unresolved' }
    }
    return { outcome: 'resolved', document: current, successorPath: link.value }
  }
  const target = byPath.get(link.value)
  if (target === undefined || visited.has(target.path)) {
    return { outcome: 'unresolved' }
  }
  visited.add(target.path)
  if (hasStatus(target, 'superseded'))
    return { outcome: 'continue', next: target }
  return { outcome: 'resolved', document: target, successorPath: undefined }
}

/**
 * Follow a superseded document's `superseded_by` chain. Each hop reads the
 * current document's link, and it must be a string. A link that fits the
 * current document's own kind has to name a loaded file of that kind that has
 * not been visited; a target that is not superseded ends the walk. A link that
 * fits another kind ends the walk at the current document without any
 * existence check, and the link is reported as `successorPath`. A link that
 * fits no kind, or a walk still superseded after `MAX_SUCCESSOR_HOPS` links, is
 * unresolved.
 */
function walkSuccessors(
  candidate: CorpusDocument,
  byPath: ReadonlyMap<string, CorpusDocument>,
): SuccessorWalk {
  const visited = new Set<string>([candidate.path])
  let current = candidate
  for (let hop = 1; hop <= MAX_SUCCESSOR_HOPS; hop++) {
    const step = stepSuccessor(current, byPath, visited)
    if (step.outcome !== 'continue') return step
    current = step.next
  }
  return { outcome: 'unresolved' }
}

/**
 * The document that replaces a superseded one, or `undefined` when the chain is
 * unresolvable or ends at a link into another kind (that case replaces
 * nothing: the walk keeps the last same-kind document and reports the link).
 */
export function resolveSuccessor(
  candidate: CorpusDocument,
  byPath: ReadonlyMap<string, CorpusDocument>,
): CorpusDocument | undefined {
  const walk = walkSuccessors(candidate, byPath)
  if (walk.outcome !== 'resolved' || walk.successorPath !== undefined) {
    return undefined
  }
  return walk.document
}

export interface ResolvedEntry {
  /** The document to show: the candidate, or the successor standing in for it. */
  readonly document: CorpusDocument
  /** Root-relative paths this entry replaces, in code-unit order. */
  readonly supersedes: readonly string[]
  /** True for a superseded document returned because its successor is unresolved. */
  readonly unresolved: boolean
  /** The link into another kind that ended the walk at `document`, if any. */
  readonly successor: string | undefined
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/**
 * Resolve the lifecycle of a ranked list, best first. A superseded candidate
 * is replaced by its successor; a successor takes the best rank among itself
 * and the documents it replaces; duplicates merge. An unresolvable superseded
 * candidate stays at its own rank, and so does one whose successor is in
 * another kind (with that link attached). `documents` is the whole loaded
 * corpus, because a successor does not have to be a match.
 */
export function resolveLifecycle(
  ranked: readonly CorpusDocument[],
  documents: readonly CorpusDocument[],
): ResolvedEntry[] {
  const byPath = new Map(documents.map((doc) => [doc.path, doc]))
  const order: string[] = []
  const entries = new Map<
    string,
    {
      document: CorpusDocument
      replaced: Set<string>
      unresolved: boolean
      successor: string | undefined
    }
  >()

  for (const candidate of ranked) {
    let target = candidate
    let replaces: string | undefined
    let unresolved = false
    let successor: string | undefined
    if (hasStatus(candidate, 'superseded')) {
      const walk = walkSuccessors(candidate, byPath)
      if (walk.outcome === 'unresolved') unresolved = true
      else {
        target = walk.document
        successor = walk.successorPath
        if (target.path !== candidate.path) replaces = candidate.path
      }
    }
    let entry = entries.get(target.path)
    if (entry === undefined) {
      entry = { document: target, replaced: new Set(), unresolved, successor }
      entries.set(target.path, entry)
      order.push(target.path)
    }
    if (replaces !== undefined) entry.replaced.add(replaces)
  }

  return order.flatMap((path) => {
    const entry = entries.get(path)
    if (entry === undefined) return []
    return [
      {
        document: entry.document,
        supersedes: [...entry.replaced].sort(compareCodeUnits),
        unresolved: entry.unresolved,
        successor: entry.successor,
      },
    ]
  })
}

/**
 * The status a hit prints. A solution keeps its three computed values. The
 * other kinds print the recorded status as written, or `unspecified`.
 */
export function entryStatus(entry: ResolvedEntry): SearchHitStatus {
  const { document } = entry
  if (document.kind !== 'solution') {
    const { status } = document
    return status !== undefined && status.trim() !== ''
      ? status
      : UNSPECIFIED_STATUS
  }
  if (entry.unresolved || entry.successor !== undefined) return 'superseded'
  return document.status === 'stale' ? 'stale' : 'active'
}

/** The `Supersedes:`, `Successor:` and `Caution:` lines for one entry, in print order. */
export function lifecycleLines(entry: ResolvedEntry): string[] {
  const lines: string[] = []
  if (entry.supersedes.length > 0) {
    lines.push(`${SUPERSEDES_LABEL} ${entry.supersedes.join(', ')}`)
  }
  if (entry.successor !== undefined) {
    lines.push(`${SUCCESSOR_LABEL} ${entry.successor}`)
  }
  if (entry.unresolved) {
    lines.push(`${CAUTION_LABEL} ${SUCCESSOR_UNRESOLVED_TEXT}`)
  } else if (hasStatus(entry.document, 'stale')) {
    const reason = sanitizeInline(
      entry.document.staleReason ?? '',
      MAX_STALE_REASON_CHARS,
    )
    lines.push(
      reason === ''
        ? `${CAUTION_LABEL} ${STALE_CAUTION_TEXT}`
        : `${CAUTION_LABEL} ${STALE_CAUTION_TEXT}: ${reason}`,
    )
  }
  return lines
}

function toLexicalDocument(document: CorpusDocument): LexicalDocument {
  return {
    id: document.path,
    fields: {
      title: document.title,
      tags: document.tags.join(' '),
      module: document.module ?? '',
      symptoms: document.symptoms.join('\n'),
      applies_when: document.appliesWhen.join('\n'),
      component: document.component ?? '',
      problem_type: document.problemType ?? '',
      body: document.body,
    },
  }
}

type Validated =
  | {
      readonly ok: true
      readonly scope: 'builtin'
      readonly query: string
      /** The kinds to load, in table order. One for a single kind, every kind for `all`. */
      readonly kinds: readonly DocumentKind[]
      readonly limit: number
    }
  | {
      readonly ok: true
      readonly scope: 'external'
      readonly query: string
      readonly limit: number
    }
  | { readonly ok: false; readonly error: string }

/** An omitted `kind` means `solution`; `all` is a selector for every table kind. */
function requestedKinds(value: unknown): readonly DocumentKind[] | undefined {
  if (value === undefined) return ['solution']
  if (value === KIND_SELECTOR_ALL) return DOCUMENT_KINDS
  return isDocumentKind(value) ? [value] : undefined
}

/** The checked limit, `DEFAULT_LIMIT` when omitted, or `undefined` for a bad value. */
function requestedLimit(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_LIMIT
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_LIMIT ||
    value > MAX_LIMIT
  ) {
    return undefined
  }
  return value
}

function validate(request: SearchRequest): Validated {
  const { query } = request
  if (typeof query !== 'string' || query.trim() === '') {
    return { ok: false, error: SEARCH_ERRORS.queryEmpty }
  }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: SEARCH_ERRORS.queryTooLong }
  }

  const external = request.kind === KIND_SELECTOR_EXTERNAL
  const kinds = external ? [] : requestedKinds(request.kind)
  if (kinds === undefined) {
    return { ok: false, error: SEARCH_ERRORS.kindUnknown }
  }

  const limit = requestedLimit(request.limit)
  if (limit === undefined) {
    return { ok: false, error: SEARCH_ERRORS.limitInvalid }
  }
  return external
    ? { ok: true, scope: 'external', query, limit }
    : { ok: true, scope: 'builtin', query, kinds, limit }
}

interface KindLoad {
  readonly kind: DocumentKind
  readonly load: CorpusLoad
}

const SKIPPED_PREFIX = 'skipped '

/** The reason of a per-file `skipped <path>: <reason>` warning, or `undefined` for any other warning. */
function skipReason(warning: string): string | undefined {
  if (!warning.startsWith(SKIPPED_PREFIX)) return undefined
  const colon = warning.lastIndexOf(': ')
  return colon === -1 ? undefined : warning.slice(colon + 2)
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

/** `docs/plans: skipped 7 files (5 invalid frontmatter, 2 larger than 262144 bytes)`. */
function skipSummary(
  dir: string,
  reasons: ReadonlyMap<string, number>,
): string {
  const parts = [...reasons]
    .sort(([a, x], [b, y]) => y - x || compareCodeUnits(a, b))
    .map(([reason, count]) => `${count} ${reason}`)
  const total = [...reasons.values()].reduce((sum, count) => sum + count, 0)
  return `${dir}: skipped ${plural(total, 'file')} (${parts.join(', ')})`
}

/**
 * One line per kind for per-file skips, counted by reason, instead of one line
 * per file. Every other warning is structural (an unreadable or escaping
 * directory, a cap reached) and keeps its exact text; those come first, in
 * kind order.
 */
function aggregateWarnings(loads: readonly KindLoad[]): string[] {
  const structural: string[] = []
  const summaries: string[] = []
  for (const { kind, load } of loads) {
    const reasons = new Map<string, number>()
    for (const warning of load.warnings) {
      const reason = skipReason(warning)
      if (reason === undefined) structural.push(warning)
      else reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
    if (reasons.size > 0) {
      summaries.push(skipSummary(KIND_TABLE[kind].dir, reasons))
    }
  }
  return [...structural, ...summaries]
}

function kindCorpus({ kind, load }: KindLoad): KindCorpus {
  const docCount = load.documents.length
  let state: KindCorpus['state'] = 'docs'
  if (load.state === 'none') state = 'none'
  else if (docCount === 0) state = 'empty'
  return { kind, dir: KIND_TABLE[kind].dir, state, docCount }
}

/** `none` when no searched directory exists, `docs` when any kind holds a document, else `empty`. */
function combinedState(
  kinds: readonly KindCorpus[],
): SearchResult['corpus']['state'] {
  if (kinds.some((report) => report.state === 'docs')) return 'docs'
  return kinds.every((report) => report.state === 'none') ? 'none' : 'empty'
}

/**
 * Validate, search, resolve the lifecycle and render. Never throws on bad
 * input: a bad request comes back as `{ ok: false }` with a fixed error text.
 * The loader runs once per requested kind, in table order; the documents are
 * merged in code-unit path order and ranked as one corpus, so a single-kind
 * request ranks exactly as it does alone.
 */
export async function runSearch(
  request: SearchRequest,
  options: SearchOptions,
): Promise<SearchResponse> {
  // `external` is decided before validation: with no project there is nothing
  // to search, whatever the query and limit hold.
  if (
    request.kind === KIND_SELECTOR_EXTERNAL &&
    !hasCheckout(options.startDir)
  ) {
    return externalFixedReply({ kind: 'no-project' }, request.query, options)
  }
  const checked = validate(request)
  if (!checked.ok) return { ok: false, text: checked.error }
  if (checked.scope === 'external') return runExternalSearch(checked, options)
  const { query, kinds, limit } = checked

  const root = resolveSearchRoot(options.startDir)
  const loader = options.corpusLoader ?? loadCorpus
  const loads = kinds.map((kind) => ({ kind, load: loader(root, kind) }))
  const reports = loads.map(kindCorpus)
  const corpus = {
    state: combinedState(reports),
    docCount: reports.reduce((sum, report) => sum + report.docCount, 0),
    kinds: reports,
  }
  const { terms, truncated } = uniqueQueryTerms(query)

  const base = {
    query,
    queryTerms: terms,
    warnings: aggregateWarnings(loads),
  }
  const noteList: string[] = [...(options.notes ?? [])]
  if (truncated) noteList.push('query cut to its first 64 distinct terms')

  const finish = (result: SearchResult): SearchResponse => ({
    ok: true,
    selector: 'builtin',
    text: renderSearchResult(result),
    result,
  })

  if (corpus.state !== 'docs') {
    return finish({ ...base, corpus, hits: [], notes: noteList })
  }

  const documents = loads
    .flatMap(({ load }) => load.documents)
    .sort((a, b) => compareCodeUnits(a.path, b.path))
  const index = buildLexicalIndex(
    documents.map(toLexicalDocument),
    options.lexicalParams ?? BM25F_PARAMS,
  )
  const lexical = searchLexical(index, terms)

  const byPath = new Map(documents.map((doc) => [doc.path, doc]))
  const candidates: CorpusDocument[] = []
  // Every lexical hit goes through the lifecycle merge, and the limit applies
  // after it: merges shrink the list, so a window cut first could return fewer
  // than `limit` hits and leave a `Supersedes:` list incomplete. The corpus is
  // capped at `MAX_FILES` per kind, so this is bounded.
  for (const hit of lexical) {
    const document = byPath.get(hit.id)
    if (document !== undefined) candidates.push(document)
  }

  const hits: SearchHit[] = resolveLifecycle(candidates, documents)
    .slice(0, limit)
    .map((entry, position) => ({
      rank: position + 1,
      document: entry.document,
      status: entryStatus(entry),
      lifecycle: lifecycleLines(entry),
    }))

  return finish({ ...base, corpus, hits, notes: noteList })
}

// --- kind: "external" --------------------------------------------------------

/**
 * Whether the start directory has a `.git` ancestor. `resolveSearchRoot` falls
 * back to the start directory when there is none, so it cannot say; the entry
 * at the root it returns can.
 */
function hasCheckout(startDir: string): boolean {
  try {
    const root = resolveSearchRoot(startDir)
    return (
      fs.lstatSync(path.join(root, '.git'), { throwIfNoEntry: false }) !==
      undefined
    )
  } catch {
    return false
  }
}

/** Notes ahead of the core's own; a per-call `config unreadable` joins the registration one without repeating it. */
function externalNotes(
  options: SearchOptions,
  userConfigUnreadable: boolean,
): string[] {
  const notes = [...(options.notes ?? [])]
  if (userConfigUnreadable && !notes.includes(SEARCH_CONFIG_UNREADABLE_NOTE)) {
    notes.push(SEARCH_CONFIG_UNREADABLE_NOTE)
  }
  return notes
}

function externalFixedReply(
  reply: ExternalFixedReply,
  query: unknown,
  options: SearchOptions,
  resolution?: ExternalSourcesResolution,
): SearchResponse {
  const notes = externalNotes(
    options,
    resolution?.userConfigUnreadable === true,
  )
  return {
    ok: true,
    selector: 'external',
    text: renderExternalFixedReply(reply, {
      query,
      notes,
      warnings: resolution?.warnings ?? [],
      project: resolution?.project,
    }),
    external: { kind: 'fixed', reply },
    ...projectUnreadableFlag(resolution),
  }
}

function projectUnreadableFlag(
  resolution: ExternalSourcesResolution | undefined,
): { readonly projectConfigUnreadable?: true } {
  return resolution?.project.kind === 'config-unreadable'
    ? { projectConfigUnreadable: true }
    : {}
}

interface ActiveLoad {
  readonly source: ActiveSource
  readonly load: SourceLoad
}

function compareSections(a: ExternalSection, b: ExternalSection): number {
  return (
    compareCodeUnits(a.name, b.name) || compareCodeUnits(a.origin, b.origin)
  )
}

/**
 * Rank every source on its own and build the sections, ordered by name in
 * code-unit order (then origin). Scores are not comparable across sources, so
 * each source gets its own lexical index: `title` to title, `node_type` to
 * tags and `body` to body. Hits within a section come best first with ties by
 * path, capped at `limit` and at `MAX_EXTERNAL_HITS_PER_SOURCE`. A source that
 * loaded no record is a state-only section.
 */
export function rankExternalSources(
  entries: readonly ActiveLoad[],
  queryTerms: readonly string[],
  limit: number,
  params: Bm25fParams = BM25F_PARAMS,
): ExternalSection[] {
  const cap = Math.min(limit, MAX_EXTERNAL_HITS_PER_SOURCE)
  return entries
    .map(({ source, load }): ExternalSection => {
      const records = new Map(
        load.records.map((record) => [record.path, record]),
      )
      const index = buildLexicalIndex(
        load.records.map((record) => ({
          id: record.path,
          fields: {
            title: record.title,
            tags: record.nodeType ?? '',
            body: record.body,
          },
        })),
        params,
      )
      const hits = searchLexical(index, queryTerms)
        .flatMap((hit) => {
          const record = records.get(hit.id)
          return record === undefined ? [] : [record]
        })
        .slice(0, cap)
        .map((record, position) => ({ rank: position + 1, record }))
      return {
        name: source.name,
        origin: source.origin,
        roots: source.roots,
        state: load.state,
        recordCount: load.records.length,
        hits,
      }
    })
    .sort(compareSections)
}

/**
 * Warnings in print order. A dropped source's own warnings lead, because a
 * source that was not read is the most useful thing to know; then the
 * resolver's, then the other sources'.
 */
function externalWarnings(
  resolution: ExternalSourcesResolution,
  loads: readonly SourceLoad[],
): string[] {
  const dropped = loads.filter(({ state }) => state === 'dropped')
  const others = loads.filter(({ state }) => state !== 'dropped')
  return [
    ...dropped.flatMap(({ warnings }) => warnings),
    ...resolution.warnings,
    ...others.flatMap(({ warnings }) => warnings),
  ]
}

async function runExternalSearch(
  checked: Extract<Validated, { scope: 'external' }>,
  options: SearchOptions,
): Promise<SearchResponse> {
  const { query, limit } = checked
  const resolver = options.externalResolver ?? defaultExternalResolver
  const resolution = resolver({
    startDir: options.startDir,
    configOptions: options.configOptions,
  })

  if (resolution.sources.length === 0) {
    const { project } = resolution
    const reply: ExternalFixedReply =
      project.kind === 'not-allowed'
        ? {
            kind: 'not-allowed',
            proposals: project.proposals,
            mainRoot: project.mainRoot,
          }
        : { kind: 'no-active-source' }
    return externalFixedReply(reply, query, options, resolution)
  }

  const loads = loadExternalSources({
    sources: resolution.sources,
    checkoutRoot: resolveSearchRoot(options.startDir),
  })
  const { terms, truncated } = uniqueQueryTerms(query)
  const entries = resolution.sources.flatMap((source, position) => {
    const load = loads[position]
    return load === undefined ? [] : [{ source, load }]
  })
  const sections = rankExternalSources(
    entries,
    terms,
    limit,
    options.lexicalParams ?? BM25F_PARAMS,
  )
  const notes = externalNotes(options, resolution.userConfigUnreadable)
  if (truncated) notes.push('query cut to its first 64 distinct terms')
  const warnings = externalWarnings(resolution, loads)
  const external: ExternalSearchResult = {
    query,
    queryTerms: terms,
    homeDir: resolveUserLevelConfigDirs(options.configOptions).homeDir,
    project: resolution.project,
    sections,
    notes,
    warnings,
  }
  return {
    ok: true,
    selector: 'external',
    text: renderExternalResult(external),
    external: { kind: 'sections', result: external },
    ...projectUnreadableFlag(resolution),
  }
}
