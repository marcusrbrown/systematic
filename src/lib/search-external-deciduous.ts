/**
 * The Deciduous reader behind `format: "deciduous"` external sources: turns a
 * sync folder (`nodes/<change_id>.json` and `edges/<edge_id>.json`) into
 * decision-shaped records with edge rationale as searchable text (KTD15).
 *
 * It has its own scan instead of the shared `min(candidates, MAX_FILES)` cut:
 * `nodes/` first and then `edges/`, in that explicit order and not a path sort.
 * `MAX_DISCOVERED_FILES` bounds the files scanned, `MAX_FILES` bounds the kept
 * records, and the byte caps still apply, so edge files and filtered nodes
 * never use up the record cap.
 *
 * Trust. File contents are untrusted. A file is opened only by a path built
 * from a directory listing whose file stem passed the id charset, never from an
 * id read out of content, and a display path is built only from that stem.
 * Content ids (`change_id`, edge endpoints) are keys in maps and sets and
 * nothing else. Symlinks are skipped at every depth. Reads files only.
 *
 * Import rule: node builtins and `search-corpus.ts` only. It never imports the
 * dispatcher (`search-external.ts`), which adapts its result.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  cleanForWarning,
  compareCodeUnits,
  isInside,
  MAX_DISCOVERED_FILES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  narrowNonEmptyString,
  safeLstat,
  safeReaddir,
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

interface FolderScan {
  /** False when the folder is absent, not a real directory, a symlink or unreadable. */
  readonly present: boolean
  readonly candidates: FileCandidate[]
  /** True when the scan stopped at its ceiling, so counts are lower bounds. */
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

const ABSENT_FOLDER: FolderScan = {
  present: false,
  candidates: [],
  truncated: false,
}

/**
 * List one folder directly (no recursion) in code-unit order. A symlink, a
 * directory, a non-`.json` name and anything that is not a regular file is
 * ignored; a symlink is counted. A stem outside the id charset is counted and
 * never opened. Stops after `limit` candidates.
 */
function scanFolder(
  rootReal: string,
  folder: 'nodes' | 'edges',
  limit: number,
  skips: Skips,
): FolderScan {
  const directory = path.join(rootReal, folder)
  const stat = safeLstat(directory)
  if (stat === null) return ABSENT_FOLDER
  if (stat.isSymbolicLink()) {
    skips.symlinks++
    return ABSENT_FOLDER
  }
  const names = stat.isDirectory() ? safeReaddir(directory) : null
  if (names === null) return ABSENT_FOLDER
  names.sort(compareCodeUnits)

  const candidates: FileCandidate[] = []
  for (const name of names) {
    const candidate = classifyJsonEntry(directory, folder, name, skips)
    if (candidate === undefined) continue
    if (candidates.length >= limit) {
      return { present: true, candidates, truncated: true }
    }
    candidates.push(candidate)
  }
  return { present: true, candidates, truncated: false }
}

/** What walking every root found, merged: nodes first, then edges. */
interface Gathered {
  readonly nodes: FileCandidate[]
  readonly edges: FileCandidate[]
  readonly rootsFound: number
  readonly anyNodesFolder: boolean
  readonly anyEdgesFolder: boolean
  readonly truncated: boolean
  /** True when some root was unreadable, for the state of a source that found none. */
  readonly unreadable: boolean
}

type GatherResult =
  | { readonly kind: 'dropped' }
  | { readonly kind: 'gathered'; readonly gathered: Gathered }

function gather(
  input: DeciduousLoadInput,
  skips: Skips,
  warnings: string[],
): GatherResult {
  const { name, containedIn } = input
  const nodes = new Map<string, FileCandidate>()
  const edges = new Map<string, FileCandidate>()
  let rootsFound = 0
  let anyNodesFolder = false
  let anyEdgesFolder = false
  let truncated = false
  let unreadable = false

  const take = (into: Map<string, FileCandidate>, scan: FolderScan): void => {
    truncated = truncated || scan.truncated
    for (const candidate of scan.candidates) {
      if (into.has(candidate.relative)) skips.sharedPaths++
      else into.set(candidate.relative, candidate)
    }
  }

  for (const root of input.roots) {
    if (containedIn !== undefined && safeLstat(root)?.isSymbolicLink()) {
      warnings.push(`${name}: a project root is a symlink; source dropped`)
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
    rootsFound++
    // Nodes first, then edges, with one ceiling across both folders.
    const nodeScan = scanFolder(
      probe.real,
      'nodes',
      Math.max(MAX_DISCOVERED_FILES - nodes.size - edges.size, 0),
      skips,
    )
    anyNodesFolder = anyNodesFolder || nodeScan.present
    take(nodes, nodeScan)
    const edgeScan = scanFolder(
      probe.real,
      'edges',
      Math.max(MAX_DISCOVERED_FILES - nodes.size - edges.size, 0),
      skips,
    )
    anyEdgesFolder = anyEdgesFolder || edgeScan.present
    take(edges, edgeScan)
  }
  return {
    kind: 'gathered',
    gathered: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      rootsFound,
      anyNodesFolder,
      anyEdgesFolder,
      truncated,
      unreadable,
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
  /** Files not opened because the per-source byte ceiling was reached. */
  budgetSkipped: number
}

/** Read one file within the per-file and per-source byte caps; `undefined` when skipped. */
function readCandidate(
  candidate: FileCandidate,
  input: DeciduousLoadInput,
  reader: Reader,
  skips: Skips,
): JsonObject | undefined {
  if (candidate.size > input.maxFileBytes) {
    skips.tooLarge++
    return undefined
  }
  if (reader.bytesUsed + candidate.size > MAX_TOTAL_BYTES) {
    reader.budgetSkipped++
    return undefined
  }
  reader.bytesUsed += candidate.size
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(candidate.absolute)
  } catch {
    skips.unreadable++
    return undefined
  }
  // The file may have grown since lstat.
  if (bytes.byteLength > input.maxFileBytes) {
    skips.tooLarge++
    return undefined
  }
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
      `${name}: text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped ${plural(cuts.budgetSkipped, 'file')}`,
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
  if (!gathered.anyNodesFolder || gathered.nodes.length === 0) {
    if (!gathered.anyNodesFolder) {
      warnings.push(`${name}: no nodes/ folder; nothing to index`)
    }
    warnings.push(...skipWarnings(name, skips, input.maxFileBytes))
    return nothing('empty', warnings.map(cleanForWarning))
  }

  // Drop whole: check the sum against what is left before any file is read.
  let needed = 0
  for (const candidate of [...gathered.nodes, ...gathered.edges]) {
    if (candidate.size <= input.maxFileBytes) needed += candidate.size
  }
  if (needed > input.remainingBytes) {
    warnings.push(
      `${name}: needs ${needed} bytes but only ${Math.max(input.remainingBytes, 0)} bytes of the read budget are left; source dropped`,
    )
    return nothing('dropped', warnings.map(cleanForWarning))
  }

  const reader: Reader = { bytesUsed: 0, budgetSkipped: 0 }
  const scan = readNodes(gathered.nodes, input, reader, skips)
  readEdges(gathered.edges, scan, input, reader, skips)

  if (!gathered.anyEdgesFolder) {
    warnings.push(`${name}: no edges/ folder; records carry no rationale`)
  }
  warnings.push(
    ...skipWarnings(name, skips, input.maxFileBytes),
    ...limitWarnings(name, {
      scanTruncated: gathered.truncated,
      recordCapSkipped: scan.recordCapSkipped,
      budgetSkipped: reader.budgetSkipped,
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
