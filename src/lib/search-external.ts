/**
 * The external source loader behind `kind: "external"`: turns the active
 * sources of one call into bounded records, one load per source.
 *
 * It shares the corpus loader's walk (`discoverSourceFiles`), symlink rule and
 * caps through `search-corpus.ts`, so a symlink is skipped at every depth and
 * a source never reads past the file and byte limits. Sources only read files:
 * nothing here spawns a process, opens a network connection or writes.
 *
 * Bounds: an external file may be 1 MB (built-in kinds stay at 256
 * KiB), a source keeps the per-source `MAX_FILES` and `MAX_TOTAL_BYTES` caps,
 * and every file the loader opens draws on one 32 MB budget shared by the
 * sources of the call. A source that does not fit the remaining budget is
 * dropped whole, before any of its files is read, and later, smaller sources
 * are still tried.
 *
 * Import rule: node builtins, `search-corpus.ts`, the exclude matcher
 * (`search-exclude.ts`) and the Deciduous reader
 * (`search-external-deciduous.ts`), plus types. The Deciduous reader imports the
 * corpus helpers and never this module. The loader holds no state, so each
 * call re-reads the stores.
 */

import path from 'node:path'
import {
  compareCodeUnits,
  discoverSourceFiles,
  MAX_FILES,
  MAX_LISTED_ENTRIES,
  narrowNonEmptyString,
  newEntryBudget,
  type ParsedSourceFile,
  PROJECT_ROOT_REJECTION_REASONS,
  parseMarkdownFrontmatter,
  readSourceFiles,
  rejectedProjectRoot,
  type SourceDiscovery,
  type SourceFileCandidate,
} from './search-corpus.js'
import { compileExcludePatterns } from './search-exclude.js'
import { loadDeciduousRecords } from './search-external-deciduous.js'
import type { ActiveSource, SourceOrigin } from './search-external-sources.js'

/** Largest single external file read, in bytes. Built-in kinds keep `MAX_FILE_BYTES`. */
export const EXTERNAL_MAX_FILE_BYTES = 1024 * 1024
/** Bytes all sources of one call may open between them. */
export const EXTERNAL_TOTAL_BUDGET_BYTES = 32 * 1024 * 1024

/**
 * One searchable external record. `nodeType` is set by the Deciduous loader
 * only; `status` is the recorded status string, never inferred.
 */
export interface ExternalRecord {
  readonly source: string
  readonly origin: SourceOrigin
  /** `<source>/<path relative to the root>`, with `/` separators. */
  readonly path: string
  readonly title: string
  readonly status?: string
  readonly nodeType?: string
  readonly body: string
}

/**
 * What loading one source found.
 *
 * - `loaded`: at least one record.
 * - `empty`: the root exists and holds no readable record.
 * - `missing`: no root exists (quiet).
 * - `unreadable`: no root could be read for an access or I/O reason.
 * - `dropped`: the source was not read: a bad root or no room in the shared
 *   budget. A named warning says which.
 */
export type SourceState =
  | 'loaded'
  | 'empty'
  | 'missing'
  | 'unreadable'
  | 'dropped'

export interface SourceLoad {
  readonly name: string
  readonly origin: SourceOrigin
  readonly state: SourceState
  readonly records: readonly ExternalRecord[]
  /** Bounded, sanitised, in deterministic order. They name the source, never a link target. */
  readonly warnings: readonly string[]
}

export interface LoadExternalSourcesInput {
  /** The active sources in the order the resolver returned them; also the order of the result and of budget use. */
  readonly sources: readonly ActiveSource[]
  /** The checkout root project roots must stay inside. */
  readonly checkoutRoot: string
  /** Bytes the sources may open between them. Defaults to the 32 MB budget; tests inject a small one. */
  readonly budgetBytes?: number | undefined
  /** Directory entries each source may examine. Defaults to `MAX_LISTED_ENTRIES`; tests inject a small one. */
  readonly entryBudget?: number | undefined
}

interface SourceOutcome extends SourceLoad {
  /** Stat bytes of the files opened, taken from the shared budget. */
  readonly bytesUsed: number
}

interface LoadContext {
  readonly checkoutRoot: string
  readonly remainingBytes: number
  readonly entryLimit: number
}

type SourceLoader = (
  source: ActiveSource,
  context: LoadContext,
) => SourceOutcome

const MARKDOWN_WALK = { excludedFiles: [], excludedDirs: [] } as const

/** Everything but the state is empty: the source produced nothing and read nothing. */
function nothing(
  source: ActiveSource,
  state: Exclude<SourceState, 'loaded'>,
  warnings: readonly string[],
): SourceOutcome {
  return {
    name: source.name,
    origin: source.origin,
    state,
    records: [],
    warnings,
    bytesUsed: 0,
  }
}

const HEADING = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The first level-1 ATX heading outside a fenced code block, or `undefined`. */
function firstHeading(body: string): string | undefined {
  let fence: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const opening = FENCE.exec(line)?.[1]
    if (opening !== undefined) {
      if (fence === undefined) fence = opening
      else if (opening[0] === fence[0] && opening.length >= fence.length) {
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) continue
    const heading = HEADING.exec(line)?.[1]?.trim()
    if (heading) return heading
  }
  return undefined
}

/**
 * Parse one Markdown file into a record. The frontmatter step is the
 * corpus parser's own, so a BOM, a missing trailing newline, invalid YAML and a
 * non-mapping block behave the same. The title is a string `title`, then the
 * first H1, then the file name; the status is a string `status` and nothing
 * else.
 */
function parseMarkdownRecord(
  source: ActiveSource,
  displayPath: string,
  content: string,
): ParsedSourceFile<ExternalRecord> {
  const parsed = parseMarkdownFrontmatter(content)
  if (!parsed.ok) return parsed
  const fileName = displayPath.slice(displayPath.lastIndexOf('/') + 1)
  const status = narrowNonEmptyString(parsed.data.status)
  return {
    ok: true,
    value: {
      source: source.name,
      origin: source.origin,
      path: displayPath,
      title:
        narrowNonEmptyString(parsed.data.title) ??
        firstHeading(parsed.body) ??
        fileName.replace(/\.md$/i, ''),
      ...(status === undefined ? {} : { status }),
      body: parsed.body,
    },
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** What walking every root of a source found, merged into one candidate set. */
type Gathered =
  | { readonly kind: 'done'; readonly outcome: SourceOutcome }
  | {
      readonly kind: 'gathered'
      /** Sorted by relative path in code-unit order, one entry per path. */
      readonly candidates: SourceFileCandidate[]
      readonly truncated: boolean
    }

/** The roots of one source, walked and merged. */
interface Merge {
  readonly candidates: Map<string, SourceFileCandidate>
  truncated: boolean
  found: boolean
  unreadable: boolean
  duplicates: number
}

function mergeDiscovery(
  merge: Merge,
  discovery: SourceDiscovery & { readonly state: 'found' },
): void {
  merge.found = true
  merge.truncated = merge.truncated || discovery.truncated
  for (const candidate of discovery.candidates) {
    if (merge.candidates.has(candidate.relative)) merge.duplicates++
    else merge.candidates.set(candidate.relative, candidate)
  }
}

/** Turn the merged roots into a sorted candidate set, or into the state of a source that found none. */
function finishGather(
  source: ActiveSource,
  merge: Merge,
  warnings: string[],
): Gathered {
  if (!merge.found) {
    const state = merge.unreadable ? 'unreadable' : 'missing'
    return { kind: 'done', outcome: nothing(source, state, warnings) }
  }
  if (merge.duplicates > 0) {
    warnings.push(
      `${source.name}: skipped ${plural(merge.duplicates, 'file')} whose path is already provided by an earlier root`,
    )
  }
  const candidates = [...merge.candidates.values()].sort((a, b) =>
    compareCodeUnits(a.relative, b.relative),
  )
  return { kind: 'gathered', candidates, truncated: merge.truncated }
}

/** The warning for a project root that drops its source before it is walked, or `undefined`. */
function projectRootWarning(
  source: ActiveSource,
  context: LoadContext,
  root: string,
): string | undefined {
  if (source.origin !== 'project') return undefined
  const rejection = rejectedProjectRoot(context.checkoutRoot, root)
  if (rejection === undefined) return undefined
  return rejection === 'outside'
    ? `${source.name} resolves outside the project root; not loaded`
    : `${source.name}: ${PROJECT_ROOT_REJECTION_REASONS[rejection]}; source dropped`
}

/**
 * Walk every root and merge the candidates into one set, so every cap and the
 * budget check apply to the source as a whole. The first root to provide a
 * path keeps it. A bad root (a project root that is a symlink, passes through
 * one below the checkout, or lies outside the checkout) drops the source; a
 * missing or unreadable root only matters when no root is found.
 */
function gatherCandidates(
  source: ActiveSource,
  context: LoadContext,
  warnings: string[],
): Gathered {
  const { name, origin } = source
  const merge: Merge = {
    candidates: new Map(),
    truncated: false,
    found: false,
    unreadable: false,
    duplicates: 0,
  }
  const drop = (): Gathered => ({
    kind: 'done',
    outcome: nothing(source, 'dropped', warnings),
  })
  // One budget covers every directory of every root of this source.
  const entryBudget = newEntryBudget(context.entryLimit)
  const isExcluded = compileExcludePatterns(source.exclude)
  for (const root of source.roots) {
    const rootWarning = projectRootWarning(source, context, root)
    if (rootWarning !== undefined) {
      warnings.push(rootWarning)
      return drop()
    }
    const discovery = discoverSourceFiles(
      {
        directory: root,
        containedIn: origin === 'project' ? context.checkoutRoot : undefined,
        walk: MARKDOWN_WALK,
        entryBudget,
        isExcluded,
        label: name,
      },
      warnings,
    )
    if (discovery.state === 'outside') return drop()
    if (discovery.state === 'unreadable') merge.unreadable = true
    if (discovery.state === 'found') mergeDiscovery(merge, discovery)
  }
  if (entryBudget.exhausted) {
    warnings.push(
      `${name}: entry limit of ${context.entryLimit} reached; some entries were not examined`,
    )
  }
  return finishGather(source, merge, warnings)
}

/**
 * The bytes the read would open: stat sizes of the files inside the file limit
 * and the per-file cap. A file over the cap is skipped unopened, so it costs
 * nothing.
 */
function bytesToRead(candidates: readonly SourceFileCandidate[]): number {
  let needed = 0
  for (const candidate of candidates.slice(0, MAX_FILES)) {
    if (candidate.size <= EXTERNAL_MAX_FILE_BYTES) needed += candidate.size
  }
  return needed
}

function loadMarkdownSource(
  source: ActiveSource,
  context: LoadContext,
): SourceOutcome {
  const { name, origin } = source
  const warnings: string[] = []
  const gathered = gatherCandidates(source, context, warnings)
  if (gathered.kind === 'done') return gathered.outcome
  const { candidates, truncated } = gathered
  if (candidates.length === 0) return nothing(source, 'empty', warnings)

  // Drop whole: check the sum against what is left before reading any file.
  const needed = bytesToRead(candidates)
  if (needed > context.remainingBytes) {
    warnings.push(
      `${name}: needs ${needed} bytes but only ${Math.max(context.remainingBytes, 0)} bytes of the read budget are left; source dropped`,
    )
    return nothing(source, 'dropped', warnings)
  }

  const read = readSourceFiles<ExternalRecord>(
    {
      displayPrefix: name,
      label: name,
      maxFileBytes: EXTERNAL_MAX_FILE_BYTES,
      sharedBytes: context.remainingBytes,
      parse: (displayPath, content) =>
        parseMarkdownRecord(source, displayPath, content),
    },
    candidates,
    truncated,
    warnings,
  )
  return {
    name,
    origin,
    state: read.items.length === 0 ? 'empty' : 'loaded',
    records: read.items,
    warnings,
    bytesUsed: read.bytesRead,
  }
}

/**
 * The Deciduous reader owns its scan. A project source stays inside the
 * checkout; the reader's result gains the source and origin here.
 */
function loadDeciduousSource(
  source: ActiveSource,
  context: LoadContext,
): SourceOutcome {
  const { name, origin } = source
  const load = loadDeciduousRecords({
    name,
    roots: source.roots,
    containedIn: origin === 'project' ? context.checkoutRoot : undefined,
    remainingBytes: context.remainingBytes,
    maxFileBytes: EXTERNAL_MAX_FILE_BYTES,
    entryLimit: context.entryLimit,
    isExcluded: compileExcludePatterns(source.exclude),
  })
  return {
    name,
    origin,
    state: load.state,
    records: load.records.map(
      (record): ExternalRecord => ({ source: name, origin, ...record }),
    ),
    warnings: load.warnings,
    bytesUsed: load.bytesUsed,
  }
}

/** One loader per format. */
const LOADERS: { readonly [format in ActiveSource['format']]: SourceLoader } = {
  markdown: loadMarkdownSource,
  deciduous: loadDeciduousSource,
}

function loadSource(source: ActiveSource, context: LoadContext): SourceOutcome {
  return LOADERS[source.format](source, context)
}

/**
 * Load every active source, in order, against one shared read budget. Never
 * throws: a failure becomes a state and a bounded warning, and the other
 * sources still load.
 */
export function loadExternalSources(
  input: LoadExternalSourcesInput,
): SourceLoad[] {
  const checkoutRoot = path.resolve(input.checkoutRoot)
  let remainingBytes = input.budgetBytes ?? EXTERNAL_TOTAL_BUDGET_BYTES
  const loads: SourceLoad[] = []
  for (const source of input.sources) {
    const { bytesUsed, ...load } = loadSource(source, {
      checkoutRoot,
      remainingBytes,
      entryLimit: input.entryBudget ?? MAX_LISTED_ENTRIES,
    })
    remainingBytes -= bytesUsed
    loads.push(load)
  }
  return loads
}
