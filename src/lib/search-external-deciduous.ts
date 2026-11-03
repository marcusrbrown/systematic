/**
 * The Deciduous reader behind `format: "deciduous"` external sources: turns a
 * sync folder (`nodes/<change_id>.json` and `edges/<edge_id>.json`) into
 * decision-shaped records with edge rationale as searchable text.
 *
 * It has its own scan instead of the shared `min(candidates, MAX_FILES)` cut:
 * every root is probed first, then `nodes/` of every root in root order and
 * then `edges/` of every root, in that explicit order and not a path sort.
 * `MAX_DISCOVERED_FILES` bounds the files scanned, `MAX_LISTED_ENTRIES` bounds
 * the entries one listing examines, `MAX_FILES` bounds the kept records, and
 * the byte caps still apply, so edge files and filtered nodes never use up the
 * record cap.
 *
 * Trust. File contents are untrusted. A file is opened only by a path built
 * from a directory listing whose file stem passed the id charset, never from an
 * id read out of content, and a display path is built only from that stem.
 * Content ids (`change_id`, edge endpoints) are keys in maps and sets and
 * nothing else. Symlinks are skipped at every depth. Reads files only.
 *
 * Import rule: node builtins, `search-bounded-read.ts` and `search-corpus.ts`
 * only. It never imports the dispatcher (`search-external.ts`), which adapts
 * its result.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readBytesBounded } from './search-bounded-read.js'
import {
  cleanForWarning,
  compareCodeUnits,
  type EntryBudget,
  isInside,
  listDirectoryWithin,
  MAX_DISCOVERED_FILES,
  MAX_FILES,
  MAX_LISTED_ENTRIES,
  MAX_TOTAL_BYTES,
  narrowNonEmptyString,
  newEntryBudget,
  type ReadBound,
  readAllowance,
  safeLstat,
  symlinkedComponent,
} from './search-corpus.js'

/** Only these node types become records; `action` and `observation` never do. */
const RECORD_NODE_TYPES: ReadonlySet<string> = new Set([
  'decision',
  'option',
  'outcome',
  'goal',
])
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const JSON_SUFFIX = '.json'

/** Longest rationale one edge adds to one node, in characters. */
const MAX_RATIONALE_CHARS_PER_EDGE = 300
/** Most edges that add rationale to one node. */
const MAX_RATIONALE_EDGES_PER_NODE = 20
/** Most rationale characters one node takes in total. */
const MAX_RATIONALE_CHARS_PER_NODE = 2048

export type DeciduousState =
  | 'loaded'
  | 'empty'
  | 'missing'
  | 'unreadable'
  | 'dropped'

/** A record as the dispatcher receives it; the dispatcher adds the source and origin. */
export interface DeciduousRecord {
  /** `<source>/nodes/<id>.json`, built from a validated file stem. */
  readonly path: string
  readonly title: string
  readonly nodeType: string
  readonly body: string
}

export interface DeciduousLoad {
  readonly state: DeciduousState
  readonly records: readonly DeciduousRecord[]
  /** Bounded, sanitised, in deterministic order. They name the source, never a file or link target. */
  readonly warnings: readonly string[]
  /** Stat bytes of the files opened, the figure a shared read budget draws on. */
  readonly bytesUsed: number
}

export interface DeciduousLoadInput {
  readonly name: string
  readonly roots: readonly string[]
  /** The checkout root a project source must stay inside; unset for a user source. */
  readonly containedIn?: string | undefined
  /** Bytes the source may open; a source that needs more is dropped whole, unread. */
  readonly remainingBytes: number
  /** Largest single file read, in bytes. */
  readonly maxFileBytes: number
  /** Directory entries the source may examine in total. Defaults to `MAX_LISTED_ENTRIES`. */
  readonly entryLimit?: number | undefined
}

interface FileCandidate {
  /** `nodes/<stem>.json` or `edges/<stem>.json`. */
  readonly relative: string
  readonly stem: string
  readonly absolute: string
  readonly size: number
}

/** Why files were left out, counted and reported once each. */
interface Skips {
  badIds: number
  symlinks: number
  invalid: number
  unreadable: number
  tooLarge: number
  duplicates: number
  sharedPaths: number
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function isAbsence(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

type RootProbe =
  | { readonly kind: 'ok'; readonly real: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'outside' }

/** Realpath one root and check it is a directory, and inside `containedIn` when that is set. */
function probeRoot(root: string, containedIn: string | undefined): RootProbe {
  let real: string
  let container: string | undefined
  try {
    real = fs.realpathSync(root)
    container =
      containedIn === undefined ? undefined : fs.realpathSync(containedIn)
  } catch (error) {
    return { kind: isAbsence(error) ? 'missing' : 'unreadable' }
  }
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(real, { throwIfNoEntry: false })
  } catch (error) {
    return { kind: isAbsence(error) ? 'missing' : 'unreadable' }
  }
  if (stat === undefined || !stat.isDirectory()) return { kind: 'missing' }
  if (container !== undefined && !isInside(container, real)) {
    return { kind: 'outside' }
  }
  return { kind: 'ok', real }
}

type FolderStatus = 'listed' | 'absent' | 'unreadable'

interface FolderScan {
  /**
   * `absent`: the folder is missing, not a directory or a symlink.
   * `unreadable`: it exists but could not be inspected or listed.
   */
  readonly status: FolderStatus
  readonly candidates: FileCandidate[]
  /** True when the scan stopped at its file ceiling, so counts are lower bounds. */
  readonly truncated: boolean
}

/**
 * Classify one directory entry without following symlinks: a candidate, or
 * `undefined` for what is ignored. A symlink and a stem outside the id charset
 * are counted; neither is ever opened.
 */
function classifyJsonEntry(
  directory: string,
  folder: 'nodes' | 'edges',
  name: string,
  skips: Skips,
): FileCandidate | undefined {
  if (!name.endsWith(JSON_SUFFIX)) return undefined
  const absolute = path.join(directory, name)
  const entry = safeLstat(absolute)
  if (entry === null) return undefined
  if (entry.isSymbolicLink()) {
    skips.symlinks++
    return undefined
  }
  if (!entry.isFile()) return undefined
  const stem = name.slice(0, -JSON_SUFFIX.length)
  if (!ID_PATTERN.test(stem)) {
    skips.badIds++
    return undefined
  }
  return { relative: `${folder}/${name}`, stem, absolute, size: entry.size }
}

function folderScan(status: Exclude<FolderStatus, 'listed'>): FolderScan {
  return { status, candidates: [], truncated: false }
}

type FolderStat =
  | { readonly kind: 'stat'; readonly stat: fs.Stats }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' }

/** `lstat` that tells nothing-there apart from an access or I/O failure. */
function statFolder(directory: string): FolderStat {
  try {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
    return stat === undefined ? { kind: 'absent' } : { kind: 'stat', stat }
  } catch (error) {
    return { kind: isAbsence(error) ? 'absent' : 'failed' }
  }
}

/**
 * List one folder directly (no recursion) in code-unit order. A symlink, a
 * directory, a non-`.json` name and anything that is not a regular file is
 * ignored; a symlink is counted. A stem outside the id charset is counted and
 * never opened. The listing takes its entries from the source's budget and the
 * scan stops after `limit` candidates. A folder that exists but cannot be
 * inspected or listed is `unreadable`, not absent.
 */
function scanFolder(
  rootReal: string,
  folder: 'nodes' | 'edges',
  limit: number,
  skips: Skips,
  budget: EntryBudget,
): FolderScan {
  const directory = path.join(rootReal, folder)
  const probed = statFolder(directory)
  if (probed.kind === 'absent') return folderScan('absent')
  if (probed.kind === 'failed') return folderScan('unreadable')
  if (probed.stat.isSymbolicLink()) {
    skips.symlinks++
    return folderScan('absent')
  }
  if (!probed.stat.isDirectory()) return folderScan('absent')
  const listing = listDirectoryWithin(directory, budget)
  if (listing === null) return folderScan('unreadable')
  const { names } = listing
  names.sort(compareCodeUnits)

  const candidates: FileCandidate[] = []
  for (const name of names) {
    const candidate = classifyJsonEntry(directory, folder, name, skips)
    if (candidate === undefined) continue
    if (candidates.length >= limit) {
      return { status: 'listed', candidates, truncated: true }
    }
    candidates.push(candidate)
  }
  return { status: 'listed', candidates, truncated: false }
}

/** What walking every root found, merged: nodes first, then edges. */
interface Gathered {
  readonly nodes: FileCandidate[]
  readonly edges: FileCandidate[]
  readonly rootsFound: number
  readonly anyNodesFolder: boolean
  readonly anyEdgesFolder: boolean
  /** A `nodes/` folder exists in some root and could not be listed. */
  readonly nodesUnreadable: boolean
  /** An `edges/` folder exists in some root and could not be listed. */
  readonly edgesUnreadable: boolean
  readonly truncated: boolean
  /** True when some root was unreadable, for the state of a source that found none. */
  readonly unreadable: boolean
}

type GatherResult =
  | { readonly kind: 'dropped' }
  | { readonly kind: 'gathered'; readonly gathered: Gathered }

type RootsResult =
  | { readonly kind: 'dropped' }
  | {
      readonly kind: 'probed'
      readonly reals: readonly string[]
      readonly unreadable: boolean
    }

/**
 * Probe every root before any folder is listed, so one root's scan cannot use
 * up the shared ceiling ahead of a later root's probe. A bad root drops the
 * source: a project root that is a symlink, passes through a symlink below the
 * checkout, or resolves outside it.
 */
function probeRoots(
  input: DeciduousLoadInput,
  warnings: string[],
): RootsResult {
  const { name, containedIn } = input
  const reals: string[] = []
  let unreadable = false
  for (const root of input.roots) {
    const symlinked =
      containedIn === undefined
        ? undefined
        : symlinkedComponent(containedIn, root)
    if (symlinked === 'root') {
      warnings.push(`${name}: a project root is a symlink; source dropped`)
      return { kind: 'dropped' }
    }
    if (symlinked === 'ancestor') {
      warnings.push(
        `${name}: a project root passes through a symlink; source dropped`,
      )
      return { kind: 'dropped' }
    }
    const probe = probeRoot(root, containedIn)
    if (probe.kind === 'outside') {
      warnings.push(`${name} resolves outside the project root; not loaded`)
      return { kind: 'dropped' }
    }
    if (probe.kind === 'unreadable') {
      warnings.push(`could not read ${name}; not loaded`)
      unreadable = true
      continue
    }
    if (probe.kind === 'missing') continue
    reals.push(probe.real)
  }
  return { kind: 'probed', reals, unreadable }
}

/** What scanning one folder name across every root found. */
interface FolderTally {
  readonly files: Map<string, FileCandidate>
  /** The folder was listed in some root. */
  listed: boolean
  /** The folder exists in some root and could not be listed. */
  unreadable: boolean
  /** A scan stopped at the shared file ceiling. */
  truncated: boolean
}

function newTally(): FolderTally {
  return {
    files: new Map(),
    listed: false,
    unreadable: false,
    truncated: false,
  }
}

function scanRoots(
  reals: readonly string[],
  folder: 'nodes' | 'edges',
  tally: FolderTally,
  otherCount: number,
  skips: Skips,
  budget: EntryBudget,
): void {
  for (const real of reals) {
    const scan = scanFolder(
      real,
      folder,
      Math.max(MAX_DISCOVERED_FILES - otherCount - tally.files.size, 0),
      skips,
      budget,
    )
    tally.listed = tally.listed || scan.status === 'listed'
    tally.unreadable = tally.unreadable || scan.status === 'unreadable'
    tally.truncated = tally.truncated || scan.truncated
    for (const candidate of scan.candidates) {
      if (tally.files.has(candidate.relative)) skips.sharedPaths++
      else tally.files.set(candidate.relative, candidate)
    }
  }
}

function folderWarnings(
  name: string,
  folder: 'nodes' | 'edges',
  tally: FolderTally,
): string[] {
  const lines: string[] = []
  if (tally.unreadable) {
    lines.push(
      folder === 'nodes'
        ? `${name}: could not read a nodes/ folder`
        : `${name}: could not read an edges/ folder; records load without its rationale`,
    )
  }
  return lines
}

function gather(
  input: DeciduousLoadInput,
  skips: Skips,
  warnings: string[],
): GatherResult {
  const probed = probeRoots(input, warnings)
  if (probed.kind === 'dropped') return { kind: 'dropped' }
  const { reals } = probed

  // `nodes/` of every root in root order, then `edges/` of every root, with
  // one file ceiling across all of them.
  // One entry budget covers every folder of every root of this source.
  const limit = input.entryLimit ?? MAX_LISTED_ENTRIES
  const budget = newEntryBudget(limit)
  const nodes = newTally()
  const edges = newTally()
  scanRoots(reals, 'nodes', nodes, 0, skips, budget)
  scanRoots(reals, 'edges', edges, nodes.files.size, skips, budget)
  warnings.push(
    ...folderWarnings(input.name, 'nodes', nodes),
    ...folderWarnings(input.name, 'edges', edges),
  )
  if (budget.exhausted) {
    warnings.push(
      `${input.name}: entry limit of ${limit} reached; some entries were not examined`,
    )
  }
  return {
    kind: 'gathered',
    gathered: {
      nodes: [...nodes.files.values()],
      edges: [...edges.files.values()],
      rootsFound: reals.length,
      anyNodesFolder: nodes.listed,
      anyEdgesFolder: edges.listed,
      nodesUnreadable: nodes.unreadable,
      edgesUnreadable: edges.unreadable,
      truncated: nodes.truncated || edges.truncated,
      unreadable: probed.unreadable,
    },
  }
}

// --- parsing -------------------------------------------------------------------

type JsonObject = Readonly<Record<string, unknown>>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    )
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A string with something in it, trimmed; anything else is `undefined`. */
function trimmedText(value: unknown): string | undefined {
  return narrowNonEmptyString(value)?.trim()
}

/** A tombstone carries a `deleted_at` that is not null, empty or false. */
function isTombstone(data: JsonObject): boolean {
  const deletedAt = data.deleted_at
  return (
    deletedAt !== undefined &&
    deletedAt !== null &&
    deletedAt !== '' &&
    deletedAt !== false
  )
}

function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/** A kept node, collecting rationale until the edges have been read. */
interface NodeEntry {
  readonly path: string
  readonly title: string
  readonly nodeType: string
  readonly description: string
  readonly rationale: string[]
  rationaleChars: number
}

function addRationale(entry: NodeEntry, text: string): void {
  if (
    entry.rationale.length >= MAX_RATIONALE_EDGES_PER_NODE ||
    entry.rationaleChars >= MAX_RATIONALE_CHARS_PER_NODE
  ) {
    return
  }
  const room = MAX_RATIONALE_CHARS_PER_NODE - entry.rationaleChars
  const capped = text.slice(0, Math.min(MAX_RATIONALE_CHARS_PER_EDGE, room))
  entry.rationale.push(capped)
  entry.rationaleChars += capped.length
}

function bodyOf(entry: NodeEntry): string {
  if (entry.rationale.length === 0) return entry.description
  const rationale = entry.rationale.join('\n')
  return entry.description === ''
    ? rationale
    : `${entry.description}\n\n${rationale}`
}

// --- reading -------------------------------------------------------------------

interface Reader {
  bytesUsed: number
  /** Files not read because a byte budget was reached. */
  budgetSkipped: number
  /** Which budget the files not read ran into. */
  budgetBound: ReadBound
  /** Set once a file crossed a budget while being read: nothing after it is read. */
  exhausted: boolean
}

/** Count a file left unread for a budget; `exhaust` also stops every later read. */
function skipForBudget(
  reader: Reader,
  bound: ReadBound,
  exhaust: boolean,
): undefined {
  reader.budgetSkipped++
  reader.budgetBound = bound
  if (exhaust) reader.exhausted = true
  return undefined
}

/**
 * Read one file within the per-file cap and what is left of the per-source and
 * shared budgets; `undefined` when skipped. A file that grew past the budget
 * since discovery is rejected, charged what was left, and ends all reading.
 */
function readCandidate(
  candidate: FileCandidate,
  input: DeciduousLoadInput,
  reader: Reader,
  skips: Skips,
): JsonObject | undefined {
  if (reader.exhausted) return skipForBudget(reader, reader.budgetBound, true)
  if (candidate.size > input.maxFileBytes) {
    skips.tooLarge++
    return undefined
  }
  if (reader.bytesUsed + candidate.size > MAX_TOTAL_BYTES) {
    return skipForBudget(reader, 'source', false)
  }
  if (reader.bytesUsed + candidate.size > input.remainingBytes) {
    return skipForBudget(reader, 'shared', false)
  }
  // The size came from an earlier lstat and can be out of date. The read is
  // limited to what the budgets leave, and charged the bytes read.
  const allowance = readAllowance(
    reader.bytesUsed,
    input.maxFileBytes,
    input.remainingBytes,
  )
  const read = readBytesBounded(candidate.absolute, allowance.limit)
  if (read.kind === 'too-large') {
    if (allowance.bound !== 'file') {
      reader.bytesUsed += allowance.limit
      return skipForBudget(reader, allowance.bound, true)
    }
    reader.bytesUsed += read.bytesRead
    skips.tooLarge++
    return undefined
  }
  if (read.kind !== 'bytes') {
    skips.unreadable++
    return undefined
  }
  const bytes = read.bytes
  reader.bytesUsed += bytes.byteLength
  const data = parseJsonObject(bytes.toString('utf8'))
  if (data === undefined) skips.invalid++
  return data
}

interface NodeScanResult {
  /** Kept records in file-name order, keyed by change_id. */
  readonly entries: Map<string, NodeEntry>
  /** The change_id of every live node of any type: the endpoints rationale may come from. */
  readonly live: Set<string>
  readonly recordCapSkipped: number
}

/** The unique, live id of a node file, or `undefined` when the file is skipped (and counted). */
function liveNodeId(
  data: JsonObject,
  candidate: FileCandidate,
  live: Set<string>,
  skips: Skips,
): string | undefined {
  // The id comes from content only as a key; the stem already passed the charset.
  const changeId =
    data.change_id === undefined ? candidate.stem : data.change_id
  if (typeof changeId !== 'string' || !ID_PATTERN.test(changeId)) {
    skips.badIds++
    return undefined
  }
  if (live.has(changeId)) {
    skips.duplicates++
    return undefined
  }
  live.add(changeId)
  return changeId
}

function readNodes(
  nodes: readonly FileCandidate[],
  input: DeciduousLoadInput,
  reader: Reader,
  skips: Skips,
): NodeScanResult {
  const entries = new Map<string, NodeEntry>()
  const live = new Set<string>()
  let recordCapSkipped = 0
  for (const candidate of nodes) {
    const data = readCandidate(candidate, input, reader, skips)
    if (data === undefined || isTombstone(data)) continue
    const changeId = liveNodeId(data, candidate, live, skips)
    if (changeId === undefined) continue
    const nodeType = trimmedText(data.node_type)
    if (nodeType === undefined || !RECORD_NODE_TYPES.has(nodeType)) continue
    if (entries.size >= MAX_FILES) {
      recordCapSkipped++
      continue
    }
    const description = trimmedText(data.description) ?? ''
    entries.set(changeId, {
      path: `${input.name}/${candidate.relative}`,
      title: trimmedText(data.title) ?? firstLine(description) ?? changeId,
      nodeType,
      description,
      rationale: [],
      rationaleChars: 0,
    })
  }
  return { entries, live, recordCapSkipped }
}

/** Add an edge's rationale to each kept endpoint whose other endpoint is a live node. */
function applyEdge(
  scan: NodeScanResult,
  from: string,
  to: string,
  rationale: string,
): void {
  const { entries, live } = scan
  const fromEntry = entries.get(from)
  if (fromEntry !== undefined && live.has(to))
    addRationale(fromEntry, rationale)
  if (from === to) return
  const toEntry = entries.get(to)
  if (toEntry !== undefined && live.has(from)) addRationale(toEntry, rationale)
}

function readEdges(
  edges: readonly FileCandidate[],
  scan: NodeScanResult,
  input: DeciduousLoadInput,
  reader: Reader,
  skips: Skips,
): void {
  for (const candidate of edges) {
    const data = readCandidate(candidate, input, reader, skips)
    if (data === undefined || isTombstone(data)) continue
    const from = data.from_change_id
    const to = data.to_change_id
    if (typeof from !== 'string' || typeof to !== 'string') {
      skips.invalid++
      continue
    }
    const rationale = trimmedText(data.rationale)?.replace(/\s+/g, ' ')
    if (rationale !== undefined) applyEdge(scan, from, to, rationale)
  }
}

// --- warnings ------------------------------------------------------------------

function skipWarnings(
  name: string,
  skips: Skips,
  maxFileBytes: number,
): string[] {
  const lines: [number, string][] = [
    [
      skips.sharedPaths,
      `${plural(skips.sharedPaths, 'file')} whose path is already provided by an earlier root`,
    ],
    [
      skips.badIds,
      `${plural(skips.badIds, 'file')} with an id outside [A-Za-z0-9_-]{1,64}`,
    ],
    [skips.symlinks, plural(skips.symlinks, 'symlink')],
    [skips.invalid, `${plural(skips.invalid, 'file')} with invalid JSON`],
    [
      skips.duplicates,
      `${plural(skips.duplicates, 'node')} with a duplicate change_id`,
    ],
    [
      skips.unreadable,
      `${plural(skips.unreadable, 'file')} that could not be read`,
    ],
    [
      skips.tooLarge,
      `${plural(skips.tooLarge, 'file')} larger than ${maxFileBytes} bytes`,
    ],
  ]
  return lines
    .filter(([count]) => count > 0)
    .map(([, text]) => `${name}: skipped ${text}`)
}

/** The warnings for a cut at a ceiling: scan, record and text budget. */
function limitWarnings(
  name: string,
  cuts: {
    readonly scanTruncated: boolean
    readonly recordCapSkipped: number
    readonly budgetSkipped: number
    readonly budgetBound: ReadBound
  },
): string[] {
  const lines: string[] = []
  if (cuts.scanTruncated) {
    lines.push(
      `${name}: scan limit of ${MAX_DISCOVERED_FILES} files reached; some files were not scanned`,
    )
  }
  if (cuts.recordCapSkipped > 0) {
    lines.push(
      `${name}: record limit of ${MAX_FILES} reached; skipped ${plural(cuts.recordCapSkipped, 'record')}`,
    )
  }
  if (cuts.budgetSkipped > 0) {
    lines.push(
      cuts.budgetBound === 'shared'
        ? `${name}: read budget of this call reached; skipped ${plural(cuts.budgetSkipped, 'file')}`
        : `${name}: text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped ${plural(cuts.budgetSkipped, 'file')}`,
    )
  }
  return lines
}

function emptySkips(): Skips {
  return {
    badIds: 0,
    symlinks: 0,
    invalid: 0,
    unreadable: 0,
    tooLarge: 0,
    duplicates: 0,
    sharedPaths: 0,
  }
}

function nothing(
  state: Exclude<DeciduousState, 'loaded'>,
  warnings: readonly string[],
): DeciduousLoad {
  return { state, records: [], warnings, bytesUsed: 0 }
}

/** What a source with no node to read is: `unreadable` when a `nodes/` folder exists but could not be listed and none was, else `empty`. */
function nodelessState(gathered: Gathered): 'unreadable' | 'empty' | undefined {
  if (!gathered.anyNodesFolder && gathered.nodesUnreadable) return 'unreadable'
  if (!gathered.anyNodesFolder || gathered.nodes.length === 0) return 'empty'
  return undefined
}

/** The stat bytes of the files inside the per-file cap, which the read would open. */
function bytesToRead(gathered: Gathered, maxFileBytes: number): number {
  let needed = 0
  for (const candidate of [...gathered.nodes, ...gathered.edges]) {
    if (candidate.size <= maxFileBytes) needed += candidate.size
  }
  return needed
}

/**
 * Load one Deciduous source: scan `nodes/` then `edges/` of every root, read
 * the nodes, keep the decision-shaped live ones, then fold edge rationale into
 * the kept nodes. Never throws: a failure becomes a state and a bounded
 * warning.
 */
export function loadDeciduousRecords(input: DeciduousLoadInput): DeciduousLoad {
  const { name } = input
  const warnings: string[] = []
  const skips = emptySkips()

  const result = gather(input, skips, warnings)
  if (result.kind === 'dropped') return nothing('dropped', warnings)
  const { gathered } = result
  if (gathered.rootsFound === 0) {
    return nothing(gathered.unreadable ? 'unreadable' : 'missing', warnings)
  }
  const nodeless = nodelessState(gathered)
  if (nodeless === 'unreadable') {
    return nothing('unreadable', warnings.map(cleanForWarning))
  }
  if (nodeless === 'empty') {
    if (!gathered.anyNodesFolder) {
      warnings.push(`${name}: no nodes/ folder; nothing to index`)
    }
    warnings.push(...skipWarnings(name, skips, input.maxFileBytes))
    return nothing('empty', warnings.map(cleanForWarning))
  }

  // Drop whole: check the sum against what is left before any file is read.
  const needed = bytesToRead(gathered, input.maxFileBytes)
  if (needed > input.remainingBytes) {
    warnings.push(
      `${name}: needs ${needed} bytes but only ${Math.max(input.remainingBytes, 0)} bytes of the read budget are left; source dropped`,
    )
    return nothing('dropped', warnings.map(cleanForWarning))
  }

  const reader: Reader = {
    bytesUsed: 0,
    budgetSkipped: 0,
    budgetBound: 'source',
    exhausted: false,
  }
  const scan = readNodes(gathered.nodes, input, reader, skips)
  readEdges(gathered.edges, scan, input, reader, skips)

  if (!gathered.anyEdgesFolder && !gathered.edgesUnreadable) {
    warnings.push(`${name}: no edges/ folder; records carry no rationale`)
  }
  warnings.push(
    ...skipWarnings(name, skips, input.maxFileBytes),
    ...limitWarnings(name, {
      scanTruncated: gathered.truncated,
      recordCapSkipped: scan.recordCapSkipped,
      budgetSkipped: reader.budgetSkipped,
      budgetBound: reader.budgetBound,
    }),
  )

  const records = [...scan.entries.values()].map(
    (entry): DeciduousRecord => ({
      path: entry.path,
      title: entry.title,
      nodeType: entry.nodeType,
      body: bodyOf(entry),
    }),
  )
  return {
    state: records.length === 0 ? 'empty' : 'loaded',
    records,
    warnings: warnings.map(cleanForWarning),
    bytesUsed: reader.bytesUsed,
  }
}
