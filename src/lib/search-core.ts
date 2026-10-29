/**
 * The one host-neutral composition behind durable-output search.
 *
 * `runSearch` validates the request, resolves the project root, loads the
 * corpus, runs the lexical lane, hands the ranked list to an optional semantic
 * stage, resolves the solution lifecycle, and renders. Every adapter (OpenCode
 * v1 and v2, Pi, the CLI and the standalone search bin) calls it and does only host
 * I/O: the start directory, the settings, and mapping the response to its
 * host's return shape. Adapters never format text themselves.
 *
 * This module also owns the `SearchSettings` type, the tool name and argument
 * constants, and the lifecycle constants and resolver. The resolver follows
 * the learnings-researcher's rules: at most 5 hops, a visited set, and a form
 * rule for the successor path. A superseded doc whose successor cannot be
 * resolved is returned at its own rank with `Caution: successor unresolved`.
 * Nothing is dropped.
 */

import {
  type CorpusDocument,
  type CorpusLoad,
  type DocumentKind,
  isDocumentKind,
  KIND_TABLE,
  loadCorpus,
  resolveSearchRoot,
} from './search-corpus.js'
import {
  BM25F_PARAMS,
  type Bm25fParams,
  buildLexicalIndex,
  type LexicalDocument,
  type LexicalHit,
  searchLexical,
  uniqueQueryTerms,
} from './search-lexical.js'
import {
  renderSearchResult,
  type SearchHit,
  type SearchHitStatus,
  type SearchLane,
  type SearchResult,
  sanitizeInline,
} from './search-render.js'

export type { SearchHit, SearchLane, SearchResult } from './search-render.js'

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

/**
 * The tool text every host surface shows the model. `limit` is a plain integer
 * in every host schema, so its range is stated here and nowhere else: the core
 * owns the out-of-range error and a host never pre-empts it.
 */
export const SEARCH_TOOL_DESCRIPTION =
  "Search this project's durable outputs (the docs/solutions learnings) by symptom, error text, module or topic. Returns ranked hits with path, title, snippet, tags and status. A superseded learning is replaced by its successor, and a stale one carries a caution. Read a hit's path for the full text. Use it before debugging a failure or planning work a past learning may already cover."
export const SEARCH_ARG_DESCRIPTIONS = {
  query: `What to look for: a symptom, error message, module or topic, in plain words. At most ${MAX_QUERY_CHARS} characters.`,
  kind: 'Optional. The kind of durable output to search. Only "solution" (docs/solutions/) exists today, and it is the default.',
  limit: `Optional. How many hits to return, an integer from ${MIN_LIMIT} to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
} as const

/** One-line texts an adapter returns when it cannot reach the core. They carry no detail from the failure. */
export const SEARCH_NOTICES = {
  failed: 'Error: search failed.',
  noProject:
    'No project directory is available for this session, so there is nothing to search.',
} as const
/** The lexical lane returns about this many times the limit, because merges shrink the list. */
export const OVERFETCH_FACTOR = 2

/** Most `superseded_by` links followed from one candidate. */
export const MAX_SUCCESSOR_HOPS = 5
/** A successor path must start with this and name a loaded file. */
export const SUCCESSOR_PATH_PREFIX = `${KIND_TABLE.solution.dir}/`
export const SUPERSEDES_LABEL = 'Supersedes:'
export const CAUTION_LABEL = 'Caution:'
export const SUCCESSOR_UNRESOLVED_TEXT = 'successor unresolved'
export const STALE_CAUTION_TEXT = 'marked stale'
const MAX_STALE_REASON_CHARS = 200

/** Fixed validation errors. They never echo the rejected value. */
export const SEARCH_ERRORS = {
  queryEmpty: 'Error: query must be a non-empty string.',
  queryTooLong: `Error: query must be at most ${MAX_QUERY_CHARS} characters.`,
  kindUnknown: `Error: kind must be one of: ${Object.keys(KIND_TABLE).join(', ')}.`,
  limitInvalid: `Error: limit must be an integer from ${MIN_LIMIT} to ${MAX_LIMIT}.`,
} as const

export interface SearchEmbeddingsSettings {
  readonly provider: 'ollama' | 'openai-compatible'
  readonly base_url: string
  readonly model: string
  readonly dimensions?: number | undefined
  readonly api_key_env?: string | undefined
  readonly query_prefix?: string | undefined
  readonly document_prefix?: string | undefined
  readonly timeout_ms?: number | undefined
}

/** User-level search settings. The zod schema's output type must stay assignable to this. */
export interface SearchSettings {
  readonly enabled?: boolean | undefined
  readonly embeddings?: SearchEmbeddingsSettings | undefined
}

export interface SearchRequest {
  /** Raw host values: the core validates them. */
  readonly query: unknown
  readonly kind?: unknown
  readonly limit?: unknown
}

/** What the semantic stage sees. */
export interface SemanticStageInput {
  readonly query: string
  readonly terms: readonly string[]
  readonly root: string
  readonly kind: DocumentKind
  readonly documents: readonly CorpusDocument[]
  readonly lexical: readonly LexicalHit[]
  readonly settings: SearchSettings | undefined
}

/**
 * What the semantic stage returns: the final fused order (best first), the
 * lanes that contributed to each document, the lanes that ran, and notes.
 */
export interface SemanticStageOutput {
  readonly ranked: ReadonlyArray<{
    readonly id: string
    readonly lanes: readonly SearchLane[]
  }>
  readonly lanes: readonly SearchLane[]
  readonly notes: readonly string[]
}

/**
 * The optional second lane. Absent until the semantic lane lands, and a stage
 * that resolves `undefined` leaves the lexical result alone.
 */
export type SemanticStage = (
  input: SemanticStageInput,
) => Promise<SemanticStageOutput | undefined>

export interface SearchOptions {
  /** The directory the root walk-up starts from. */
  readonly startDir: string
  readonly settings?: SearchSettings | undefined
  readonly semantic?: SemanticStage | undefined
  /** Override the BM25F table. The recall tuning uses this; hosts do not. */
  readonly lexicalParams?: Bm25fParams | undefined
  /** Replace the disk loader. Tests use this to control load order. */
  readonly corpusLoader?:
    | ((root: string, kind: DocumentKind) => CorpusLoad)
    | undefined
}

export type SearchResponse =
  | { readonly ok: true; readonly text: string; readonly result: SearchResult }
  | { readonly ok: false; readonly text: string }

/** Whether a `superseded_by` value has the shape of a repo-root solution path. */
export function isSuccessorPathForm(value: string): boolean {
  if (!value.startsWith(SUCCESSOR_PATH_PREFIX)) return false
  if (!value.endsWith('.md')) return false
  const segments = value.split('/')
  if (segments.includes('..')) return false
  const name = segments[segments.length - 1]?.toLowerCase()
  if (name === 'readme.md') return false
  if (segments.includes('_archived')) return false
  return true
}

/**
 * Follow a superseded document's `superseded_by` chain. Returns the first
 * document that is not superseded, or `undefined` when the chain is
 * unresolvable: a link that is not a string, fails the form rule, names a file
 * outside the loaded corpus, revisits a document, or is still superseded after
 * `MAX_SUCCESSOR_HOPS` links.
 */
export function resolveSuccessor(
  candidate: CorpusDocument,
  byPath: ReadonlyMap<string, CorpusDocument>,
): CorpusDocument | undefined {
  const visited = new Set<string>([candidate.path])
  let current = candidate
  for (let hop = 1; hop <= MAX_SUCCESSOR_HOPS; hop++) {
    const link = current.supersededBy
    if (link.state !== 'value' || !isSuccessorPathForm(link.value)) {
      return undefined
    }
    if (visited.has(link.value)) return undefined
    const target = byPath.get(link.value)
    if (target === undefined) return undefined
    visited.add(target.path)
    if (target.status !== 'superseded') return target
    current = target
  }
  return undefined
}

export interface ResolvedEntry {
  /** The document to show: the candidate, or the successor standing in for it. */
  readonly document: CorpusDocument
  /** Root-relative paths this entry replaces, in code-unit order. */
  readonly supersedes: readonly string[]
  /** True for a superseded document returned because its successor is unresolved. */
  readonly unresolved: boolean
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/**
 * Resolve the lifecycle of a ranked list, best first. A superseded candidate
 * is replaced by its successor; a successor takes the best rank among itself
 * and the documents it replaces; duplicates merge. An unresolvable superseded
 * candidate stays at its own rank. `documents` is the whole loaded corpus,
 * because a successor does not have to be a match.
 */
export function resolveLifecycle(
  ranked: readonly CorpusDocument[],
  documents: readonly CorpusDocument[],
): ResolvedEntry[] {
  const byPath = new Map(documents.map((doc) => [doc.path, doc]))
  const order: string[] = []
  const entries = new Map<
    string,
    { document: CorpusDocument; replaced: Set<string>; unresolved: boolean }
  >()

  for (const candidate of ranked) {
    let target = candidate
    let replaces: string | undefined
    let unresolved = false
    if (candidate.status === 'superseded') {
      const successor = resolveSuccessor(candidate, byPath)
      if (successor === undefined) unresolved = true
      else {
        target = successor
        replaces = candidate.path
      }
    }
    let entry = entries.get(target.path)
    if (entry === undefined) {
      entry = { document: target, replaced: new Set(), unresolved }
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
      },
    ]
  })
}

export function entryStatus(entry: ResolvedEntry): SearchHitStatus {
  if (entry.unresolved) return 'superseded'
  return entry.document.status === 'stale' ? 'stale' : 'active'
}

/**
 * The lanes behind one hit: those that matched the document itself and, for a
 * successor standing in for matched docs, those that matched the docs it
 * replaces. A successor that matched nothing and replaces nothing falls back
 * to the lanes that ran. Listed in a fixed order.
 */
function hitLanes(
  entry: ResolvedEntry,
  lanesByPath: ReadonlyMap<string, readonly SearchLane[]>,
  ran: readonly SearchLane[],
): SearchLane[] {
  const seen = new Set<SearchLane>()
  for (const path of [entry.document.path, ...entry.supersedes]) {
    for (const lane of lanesByPath.get(path) ?? []) seen.add(lane)
  }
  if (seen.size === 0) return [...ran]
  return (['lexical', 'semantic'] as const).filter((lane) => seen.has(lane))
}

/** The `Supersedes:` and `Caution:` lines for one entry, in print order. */
export function lifecycleLines(entry: ResolvedEntry): string[] {
  const lines: string[] = []
  if (entry.supersedes.length > 0) {
    lines.push(`${SUPERSEDES_LABEL} ${entry.supersedes.join(', ')}`)
  }
  if (entry.unresolved) {
    lines.push(`${CAUTION_LABEL} ${SUCCESSOR_UNRESOLVED_TEXT}`)
  } else if (entry.document.status === 'stale') {
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
      readonly query: string
      readonly kind: DocumentKind
      readonly limit: number
    }
  | { readonly ok: false; readonly error: string }

function validate(request: SearchRequest): Validated {
  const { query } = request
  if (typeof query !== 'string' || query.trim() === '') {
    return { ok: false, error: SEARCH_ERRORS.queryEmpty }
  }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: SEARCH_ERRORS.queryTooLong }
  }

  let kind: DocumentKind = 'solution'
  if (request.kind !== undefined) {
    if (!isDocumentKind(request.kind)) {
      return { ok: false, error: SEARCH_ERRORS.kindUnknown }
    }
    kind = request.kind
  }

  let limit = DEFAULT_LIMIT
  if (request.limit !== undefined) {
    const value = request.limit
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < MIN_LIMIT ||
      value > MAX_LIMIT
    ) {
      return { ok: false, error: SEARCH_ERRORS.limitInvalid }
    }
    limit = value
  }
  return { ok: true, query, kind, limit }
}

/**
 * Validate, search, resolve the lifecycle and render. Never throws on bad
 * input: a bad request comes back as `{ ok: false }` with a fixed error text.
 */
export async function runSearch(
  request: SearchRequest,
  options: SearchOptions,
): Promise<SearchResponse> {
  const checked = validate(request)
  if (!checked.ok) return { ok: false, text: checked.error }
  const { query, kind, limit } = checked

  const root = resolveSearchRoot(options.startDir)
  const load = (options.corpusLoader ?? loadCorpus)(root, kind)
  const { terms, truncated } = uniqueQueryTerms(query)

  const base = {
    query,
    queryTerms: terms,
    warnings: load.warnings,
  }
  const noteList: string[] = []
  if (truncated) noteList.push('query cut to its first 64 distinct terms')

  const finish = (result: SearchResult): SearchResponse => ({
    ok: true,
    text: renderSearchResult(result),
    result,
  })

  if (load.state === 'none') {
    return finish({
      ...base,
      corpus: { state: 'none', docCount: 0 },
      lanes: [],
      hits: [],
      notes: noteList,
    })
  }
  if (load.documents.length === 0) {
    return finish({
      ...base,
      corpus: { state: 'empty', docCount: 0 },
      lanes: [],
      hits: [],
      notes: noteList,
    })
  }

  const index = buildLexicalIndex(
    load.documents.map(toLexicalDocument),
    options.lexicalParams ?? BM25F_PARAMS,
  )
  const lexical = searchLexical(index, terms)
  let ordering: ReadonlyArray<{
    readonly id: string
    readonly lanes: readonly SearchLane[]
  }> = lexical.map((hit) => ({ id: hit.id, lanes: ['lexical'] as const }))
  const lanes: SearchLane[] = ['lexical']

  if (options.semantic !== undefined) {
    const semantic = await options.semantic({
      query,
      terms,
      root,
      kind,
      documents: load.documents,
      lexical,
      settings: options.settings,
    })
    if (semantic !== undefined) {
      ordering = semantic.ranked
      lanes.splice(0, lanes.length, ...semantic.lanes)
      noteList.push(...semantic.notes)
    }
  }

  const byPath = new Map(load.documents.map((doc) => [doc.path, doc]))
  const lanesByPath = new Map<string, readonly SearchLane[]>()
  const candidates: CorpusDocument[] = []
  for (const entry of ordering.slice(0, limit * OVERFETCH_FACTOR)) {
    const document = byPath.get(entry.id)
    if (document === undefined) continue
    candidates.push(document)
    lanesByPath.set(document.path, entry.lanes)
  }

  const hits: SearchHit[] = resolveLifecycle(candidates, load.documents)
    .slice(0, limit)
    .map((entry, position) => ({
      rank: position + 1,
      document: entry.document,
      lanes: hitLanes(entry, lanesByPath, lanes),
      status: entryStatus(entry),
      lifecycle: lifecycleLines(entry),
    }))

  return finish({
    ...base,
    corpus: { state: 'docs', docCount: load.documents.length },
    lanes,
    hits,
    notes: noteList,
  })
}
