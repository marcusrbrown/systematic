/**
 * The CI side of `ce:connect`: the report a scheduled run posts, and the ticks
 * an operator leaves on it. One module defines the report format, so what
 * `render-report` writes is exactly what `apply-ticks` reads.
 *
 * Trust: every file read here is untrusted input, including the state the CI
 * run itself wrote. The run record, the invocation record, the candidate
 * payload store, the manifest store and the report body each get bounded
 * reads, typed fields and named keys only. Model text reaches the report in
 * fences only, with mentions, issue references and comment delimiters broken
 * so nothing in it can notify, link or write a marker.
 *
 * A decision comes from one place: a checkbox line the renderer generated,
 * inside the single delimited section, outside any code fence, whose id is in
 * the manifest of the report that was read and whose candidate is still open.
 * The manifest of a report is stored under the hash its body carries, so a
 * report that was posted keeps its own manifest even when a later render
 * failed to post or posted something else.
 *
 * Import rule: node builtins and the `connect-*` modules. The `ce:connect`
 * helper bundles this module, so it must never import zod, `config.ts` or
 * `config-schema.ts`.
 *
 * Layout in the state root, next to the ledger:
 *
 *     ci-payloads.json   the text of each open candidate (the ledger holds none)
 *     ci-manifests.json  the candidate ids of the last fourteen reports
 *     report.md          the report body the last render wrote
 *
 * Neither operation reads the network or the clock: the date and the GitHub
 * run come from the caller.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readContainedFile } from './connect-evidence.js'
import { renderSweepLine, sanitizeText } from './connect-helper-core.js'
import {
  acquireLock,
  decideLedgerEntry,
  type InvocationRecord,
  type LedgerEntry,
  type LockBusyReason,
  type LockOptions,
  type ProcessTable,
  readInvocationRecord,
  readLedger,
  readRunRecord,
  releaseLock,
} from './connect-state.js'

// ── Format ──────────────────────────────────────────────────────────────────

/** A report body is never longer than this many characters. */
export const REPORT_MAX_CHARS = 60_000

/** The manifests kept: the newest reports a person can still be looking at. */
export const MANIFESTS_KEPT = 14

export const REPORT_FILE = 'report.md'
export const PAYLOAD_FILE = 'ci-payloads.json'
export const MANIFEST_FILE = 'ci-manifests.json'

export const DECISIONS_BEGIN = '<!-- connect-decisions:begin -->'
export const DECISIONS_END = '<!-- connect-decisions:end -->'

export type DecisionStatus = 'promoted' | 'rejected'

const STATUS_LABEL: Readonly<Record<DecisionStatus, string>> = {
  promoted: 'Promoted',
  rejected: 'Rejected',
}

const MANIFEST_HASH_LENGTH = 16
const CANDIDATE_ID = /^[0-9a-f]{64}$/
const MANIFEST_HASH = /^[0-9a-f]{16}$/
const DIGITS = /^[0-9]{1,20}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/
const TOKEN = /^[a-z][a-z0-9-]{0,39}$/

/** `<!-- connect-manifest:<hash> -->`: which stored manifest this body was rendered with. */
export function manifestMarker(hash: string): string {
  return `<!-- connect-manifest:${hash} -->`
}

/** One generated checkbox line. The marker carries the id; nothing else on the line is read. */
export function decisionLine(
  id: string,
  status: DecisionStatus,
  ticked: boolean,
): string {
  return `- [${ticked ? 'x' : ' '}] ${STATUS_LABEL[status]} <!-- connect-decision:${status}:${id} -->`
}

const MANIFEST_LINE = /^<!-- connect-manifest:([0-9a-f]{16}) -->[ \t]*$/
const DECISION_LINE =
  /^- \[([ xX])\] (Promoted|Rejected) <!-- connect-decision:(promoted|rejected):([0-9a-f]{64}) -->[ \t]*$/
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// ── Small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCandidateId(value: unknown): value is string {
  return typeof value === 'string' && CANDIDATE_ID.test(value)
}

function isDigits(value: unknown): value is string {
  return typeof value === 'string' && DIGITS.test(value)
}

function validDate(text: string): boolean {
  if (!DATE.test(text)) return false
  const parsed = new Date(`${text}T00:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text)
  )
}

function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('').trimEnd()
}

/** One display-safe line, at most `max` characters, or nothing. */
function lineOf(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = clip(sanitizeText(value).replaceAll('\n', ' ').trim(), max)
  return text === '' ? undefined : text
}

/** Display-safe text with its line breaks, at most `max` characters, or nothing. */
function paragraphOf(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = clip(sanitizeText(value).trim(), max)
  return text === '' ? undefined : text
}

function tokenOf(value: unknown): string {
  return typeof value === 'string' && TOKEN.test(value) ? value : 'unknown'
}

function lockOptions(options: CiOptions): LockOptions {
  return {
    ...(options.processes === undefined
      ? {}
      : { processes: options.processes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
}

/** Replace a file with a temporary sibling and a rename, owner-only. */
function writeFileAtomic(target: string, data: string): void {
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, target)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

/** What reading a store file found: no file, a file that cannot be used, or its parsed JSON. */
type FileRead =
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'ok'; readonly value: unknown }

/**
 * The parsed JSON of a bounded regular file in the state root. A file that is
 * not there is `missing`; one that is there and cannot be read (a symlink, a
 * directory, over the bound, not JSON) is `unreadable`.
 */
function readJsonFile(root: string, name: string, maxBytes: number): FileRead {
  const read = readContainedFile(root, name, { maxBytes })
  if (read.kind === 'refused') {
    return read.reason === 'missing'
      ? { status: 'missing' }
      : { status: 'unreadable' }
  }
  try {
    return { status: 'ok', value: JSON.parse(read.bytes.toString('utf8')) }
  } catch {
    return { status: 'unreadable' }
  }
}

/**
 * A store that is missing starts empty. One that is there and cannot be used
 * is `unreadable`, so a caller that would rewrite it stops instead of
 * replacing what it could not read.
 */
type StoreRead<T> =
  | { readonly status: 'ok'; readonly items: T }
  | { readonly status: 'unreadable' }

export interface CiOptions {
  readonly processes?: ProcessTable
  readonly now?: () => number
}

// ── Neutralising model text ─────────────────────────────────────────────────

const ZERO_WIDTH = '\u200b'

/**
 * Make model text inert in a GitHub issue. Control and format characters go,
 * and a zero-width space breaks each thing the page would act on: `@` (a
 * mention), `#` before a digit and `GH-` before a digit (an issue reference,
 * alone or after `owner/repo`), and the delimiters of an HTML comment, so
 * text cannot write a marker. Removing the zero-width spaces gives back the
 * original text.
 */
export function neutraliseText(text: string): string {
  return sanitizeText(text)
    .replaceAll('@', `@${ZERO_WIDTH}`)
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH}`)
    .replace(/(gh-)(?=\d)/gi, `$1${ZERO_WIDTH}`)
    .replaceAll('<!--', `<!${ZERO_WIDTH}--`)
    .replaceAll('-->', `--${ZERO_WIDTH}>`)
}

function longestBacktickRun(text: string): number {
  let longest = 0
  let current = 0
  for (const char of text) {
    current = char === '`' ? current + 1 : 0
    if (current > longest) longest = current
  }
  return longest
}

/** Neutralised text in a fenced block whose fence is longer than any backtick run inside it. */
export function fenceText(text: string): string {
  const clean = neutraliseText(text)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(clean) + 1))
  return `${fence}\n${clean}\n${fence}`
}

// ── Parsing a report body ───────────────────────────────────────────────────

export type BodySection = 'ok' | 'missing' | 'malformed'

export interface ParsedBox {
  readonly id: string
  readonly status: DecisionStatus
  readonly ticked: boolean
}

export interface ParsedBody {
  /** The hash in the manifest marker, when the body has exactly one. */
  readonly manifest: string | undefined
  readonly section: BodySection
  /** The generated checkbox lines inside the section, in document order. */
  readonly boxes: readonly ParsedBox[]
}

/** An open code fence: the character it was opened with and how many it used. */
interface Fence {
  readonly char: '`' | '~'
  readonly length: number
}

interface Scan {
  fence: Fence | undefined
  inside: boolean
  begins: number
  ends: number
  ordered: boolean
  manifests: string[]
  boxes: ParsedBox[]
}

/**
 * Track a code fence the way Markdown does: a backtick or tilde fence closes
 * only on a line of the same character, at least as long as the opening one,
 * with nothing after it. A backtick fence cannot have a backtick in its info
 * string. Returns true when the line belongs to fence syntax or content.
 */
function inFence(scan: Scan, line: string): boolean {
  const match = FENCE_LINE.exec(line)
  const run = match?.[1]
  const info = match?.[2] ?? ''
  const char = run?.startsWith('~') ? '~' : '`'
  if (scan.fence !== undefined) {
    if (
      run !== undefined &&
      char === scan.fence.char &&
      run.length >= scan.fence.length &&
      info.trim() === ''
    ) {
      scan.fence = undefined
    }
    return true
  }
  if (run !== undefined && !(char === '`' && info.includes('`'))) {
    scan.fence = { char, length: run.length }
    return true
  }
  return false
}

function boxOf(line: string): ParsedBox | undefined {
  const match = DECISION_LINE.exec(line)
  if (match === null) return undefined
  const [, mark, label, status, id] = match
  if (id === undefined || label === undefined || mark === undefined) {
    return undefined
  }
  if (status !== 'promoted' && status !== 'rejected') return undefined
  if (STATUS_LABEL[status] !== label) return undefined
  return { id, status, ticked: mark !== ' ' }
}

function scanLine(scan: Scan, line: string): void {
  if (inFence(scan, line)) return
  const text = line.trimEnd()
  if (text === DECISIONS_BEGIN) {
    scan.begins++
    if (scan.ends > 0) scan.ordered = false
    scan.inside = true
    return
  }
  if (text === DECISIONS_END) {
    scan.ends++
    if (scan.begins === 0) scan.ordered = false
    scan.inside = false
    return
  }
  const manifest = MANIFEST_LINE.exec(line)?.[1]
  if (manifest !== undefined) scan.manifests.push(manifest)
  if (!scan.inside) return
  const box = boxOf(line)
  if (box !== undefined) scan.boxes.push(box)
}

/**
 * Read a report body. Only exact generated lines count, only inside the one
 * delimited section, and never inside a code fence. A body with a delimiter
 * missing, repeated or out of order has no section, and a body with no marker
 * or more than one marker has no manifest.
 */
export function parseReportBody(body: string): ParsedBody {
  const scan: Scan = {
    fence: undefined,
    inside: false,
    begins: 0,
    ends: 0,
    ordered: true,
    manifests: [],
    boxes: [],
  }
  for (const line of body.split(/\r?\n/)) scanLine(scan, line)
  const manifest = scan.manifests.length === 1 ? scan.manifests[0] : undefined
  if (scan.begins === 0 && scan.ends === 0) {
    return { manifest, section: 'missing', boxes: [] }
  }
  const whole = scan.begins === 1 && scan.ends === 1 && scan.ordered
  return whole
    ? { manifest, section: 'ok', boxes: scan.boxes }
    : { manifest, section: 'malformed', boxes: [] }
}

// ── Reading a body file ─────────────────────────────────────────────────────

/** GitHub holds an issue body to 65,536 characters; this leaves room for multi-byte text. */
const MAX_BODY_BYTES = 512 * 1024

export type BodyRead =
  | { readonly status: 'ok'; readonly body: string }
  | {
      readonly status: 'failed'
      readonly reason:
        | 'body-missing'
        | 'body-symlink'
        | 'body-not-regular'
        | 'body-too-large'
        | 'body-unreadable'
    }

/** Read a report body from a file: one bounded regular file, never a symlink. */
export function readReportBody(file: string): BodyRead {
  let directory: string
  try {
    directory = fs.realpathSync.native(path.dirname(file))
  } catch {
    return { status: 'failed', reason: 'body-unreadable' }
  }
  const read = readContainedFile(directory, path.basename(file), {
    maxBytes: MAX_BODY_BYTES,
  })
  if (read.kind === 'bytes') {
    return { status: 'ok', body: read.bytes.toString('utf8') }
  }
  switch (read.reason) {
    case 'missing':
      return { status: 'failed', reason: 'body-missing' }
    case 'symlink':
      return { status: 'failed', reason: 'body-symlink' }
    case 'not-regular':
      return { status: 'failed', reason: 'body-not-regular' }
    case 'too-large':
      return { status: 'failed', reason: 'body-too-large' }
    default:
      return { status: 'failed', reason: 'body-unreadable' }
  }
}

// ── Candidate payloads ──────────────────────────────────────────────────────

const LIMITS = Object.freeze({
  title: 160,
  summary: 800,
  name: 100,
  path: 300,
  excerpt: 240,
  sources: 8,
  reason: 200,
  reasons: 20,
})

/** The payload store is bounded by bytes, not by count: it holds one entry per open candidate. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_MANIFEST_IDS = 1000
const MAX_PROJECTS = 64
const MAX_CANDIDATES = 200

interface PayloadSource {
  readonly projectName: string
  readonly path: string
  readonly excerpt?: string
}

/** The text of one open candidate, kept bounded and display-safe. */
interface Payload {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly kind: string
  readonly nextStep: string
  readonly targetName: string
  readonly repo?: string
  readonly sources: readonly PayloadSource[]
  /** The UTC date the candidate was first listed. Absent until it is listed. */
  readonly firstShown?: string
  /** The GitHub run and attempt whose artifact holds the candidate's evidence. */
  readonly runId: string
  readonly attempt: string
}

type PayloadText = Pick<
  Payload,
  'title' | 'summary' | 'kind' | 'nextStep' | 'targetName' | 'sources'
>

function sourceOf(item: unknown): PayloadSource | undefined {
  if (!isRecord(item)) return undefined
  const sourcePath = lineOf(item.path, LIMITS.path)
  if (sourcePath === undefined) return undefined
  const excerpt = lineOf(item.excerpt, LIMITS.excerpt)
  return {
    projectName: lineOf(item.projectName, LIMITS.name) ?? 'unknown',
    path: sourcePath,
    ...(excerpt === undefined ? {} : { excerpt }),
  }
}

/** The display fields of a candidate, from a run record or from the store. */
function payloadText(raw: unknown): PayloadText | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) return undefined
  const title = lineOf(raw.title, LIMITS.title)
  const summary = paragraphOf(raw.summary, LIMITS.summary)
  if (title === undefined || summary === undefined) return undefined
  const sources = (raw.sources as unknown[])
    .slice(0, LIMITS.sources)
    .flatMap((item) => sourceOf(item) ?? [])
  return {
    title,
    summary,
    kind: tokenOf(raw.kind),
    nextStep: tokenOf(raw.nextStep),
    targetName: lineOf(raw.targetName, LIMITS.name) ?? 'unknown',
    sources,
  }
}

function payloadFromStore(raw: unknown): Payload | undefined {
  if (!isRecord(raw) || !isCandidateId(raw.id)) return undefined
  const text = payloadText(raw)
  if (text === undefined) return undefined
  if (!isDigits(raw.runId) || !isDigits(raw.attempt)) return undefined
  const { repo, firstShown } = raw
  return {
    id: raw.id,
    ...text,
    ...(typeof repo === 'string' && REPO.test(repo) ? { repo } : {}),
    ...(typeof firstShown === 'string' && validDate(firstShown)
      ? { firstShown }
      : {}),
    runId: raw.runId,
    attempt: raw.attempt,
  }
}

function readPayloadStore(root: string): StoreRead<Map<string, Payload>> {
  const out = new Map<string, Payload>()
  const read = readJsonFile(root, PAYLOAD_FILE, MAX_PAYLOAD_BYTES)
  if (read.status === 'missing') return { status: 'ok', items: out }
  const value = read.status === 'ok' ? read.value : undefined
  if (!isRecord(value) || value.version !== 1) return { status: 'unreadable' }
  if (!Array.isArray(value.payloads)) return { status: 'unreadable' }
  for (const item of value.payloads as unknown[]) {
    const payload = payloadFromStore(item)
    if (payload !== undefined && !out.has(payload.id)) {
      out.set(payload.id, payload)
    }
  }
  return { status: 'ok', items: out }
}

/** The text of the payload store: one entry per payload, named fields only. */
function payloadStoreText(payloads: readonly Payload[]): string {
  const stored = payloads.map((payload) => ({
    id: payload.id,
    title: payload.title,
    summary: payload.summary,
    kind: payload.kind,
    nextStep: payload.nextStep,
    targetName: payload.targetName,
    ...(payload.repo === undefined ? {} : { repo: payload.repo }),
    sources: payload.sources,
    ...(payload.firstShown === undefined
      ? {}
      : { firstShown: payload.firstShown }),
    runId: payload.runId,
    attempt: payload.attempt,
  }))
  return `${JSON.stringify({ version: 1, payloads: stored }, null, 2)}\n`
}

// ── Manifests ───────────────────────────────────────────────────────────────

interface Manifest {
  readonly hash: string
  readonly ids: readonly string[]
}

/** The hash a body names its manifest by: a prefix of a sha256 over the ids it lists. */
function manifestHash(ids: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['connect-manifest-v1', ids]))
    .digest('hex')
    .slice(0, MANIFEST_HASH_LENGTH)
}

/**
 * A stored manifest is trusted to bind ticks, so it is read strictly: an
 * entry with any other key, a malformed id or a hash that does not match its
 * ids is refused, and the entries around it are kept.
 */
function manifestFrom(raw: unknown): Manifest | undefined {
  if (!isRecord(raw)) return undefined
  if (Object.keys(raw).some((key) => key !== 'hash' && key !== 'ids')) {
    return undefined
  }
  const { hash, ids } = raw
  if (typeof hash !== 'string' || !MANIFEST_HASH.test(hash)) return undefined
  if (!Array.isArray(ids) || ids.length > MAX_MANIFEST_IDS) return undefined
  if (!ids.every(isCandidateId)) return undefined
  const list = ids as string[]
  return manifestHash(list) === hash ? { hash, ids: list } : undefined
}

function readManifestStore(root: string): StoreRead<Manifest[]> {
  const read = readJsonFile(root, MANIFEST_FILE, MAX_MANIFEST_BYTES)
  if (read.status === 'missing') return { status: 'ok', items: [] }
  const value = read.status === 'ok' ? read.value : undefined
  if (!isRecord(value) || value.version !== 1) return { status: 'unreadable' }
  if (!Array.isArray(value.manifests)) return { status: 'unreadable' }
  const items = (value.manifests as unknown[])
    .slice(-MANIFESTS_KEPT)
    .flatMap((item) => manifestFrom(item) ?? [])
  return { status: 'ok', items }
}

/** Add a manifest as the newest. One with the same hash is the same ids, so it moves up instead of being copied. */
function withManifest(
  stored: readonly Manifest[],
  added: Manifest,
): Manifest[] {
  return [...stored.filter((item) => item.hash !== added.hash), added].slice(
    -MANIFESTS_KEPT,
  )
}

function writeManifestStore(
  root: string,
  manifests: readonly Manifest[],
): void {
  writeFileAtomic(
    path.join(root, MANIFEST_FILE),
    `${JSON.stringify({ version: 1, manifests }, null, 2)}\n`,
  )
}

// ── The run record ──────────────────────────────────────────────────────────

/** What a report says about the run, taken from its untrusted record. */
interface RunSummary {
  readonly degradeReasons: readonly string[]
  readonly selection?: string
  readonly sweep?: string
  /** The `owner/repo` of each project, by the root the candidates name. */
  readonly repoByRoot: ReadonlyMap<string, string>
  readonly candidates: readonly unknown[]
}

function selectionLabel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'all') return 'all allowed projects'
  if (value.kind === 'group') {
    const name = lineOf(value.name, LIMITS.name)
    return name === undefined ? undefined : `group ${name}`
  }
  if (value.kind !== 'projects' || !Array.isArray(value.picks)) {
    return undefined
  }
  const picks = (value.picks as unknown[])
    .slice(0, 32)
    .flatMap((pick) => lineOf(pick, LIMITS.name) ?? [])
  return picks.length === 0 ? undefined : `projects ${picks.join(', ')}`
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function sweepLabel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const total = count(value.total)
  const covered = count(value.covered)
  const coveredThisRun = count(value.coveredThisRun)
  const runsLeft = count(value.runsLeft)
  if (
    total === undefined ||
    covered === undefined ||
    coveredThisRun === undefined ||
    runsLeft === undefined
  ) {
    return undefined
  }
  const line = renderSweepLine({ total, covered, coveredThisRun, runsLeft })
  return line === '' ? undefined : line
}

function repoMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(value)) return out
  for (const item of (value as unknown[]).slice(0, MAX_PROJECTS)) {
    if (!isRecord(item)) continue
    const { root, repo } = item
    if (
      typeof root === 'string' &&
      typeof repo === 'string' &&
      REPO.test(repo)
    ) {
      out.set(root, repo)
    }
  }
  return out
}

function candidatesOf(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return []
  return (value.candidates as unknown[]).slice(0, MAX_CANDIDATES)
}

function readRunSummary(root: string, runId: string): RunSummary | undefined {
  const record = readRunRecord(root, runId)
  if (!isRecord(record)) return undefined
  const reasons = Array.isArray(record.degradeReasons)
    ? (record.degradeReasons as unknown[])
        .slice(0, LIMITS.reasons)
        .flatMap((reason) => lineOf(reason, LIMITS.reason) ?? [])
    : []
  const selection = selectionLabel(record.selection)
  const sweep = sweepLabel(record.sweep)
  return {
    degradeReasons: reasons,
    ...(selection === undefined ? {} : { selection }),
    ...(sweep === undefined ? {} : { sweep }),
    repoByRoot: repoMap(record.projects),
    candidates: candidatesOf(record.candidateBlock),
  }
}

// ── Outcome ─────────────────────────────────────────────────────────────────

export type ReportOutcome =
  | 'complete'
  | 'degraded'
  | 'busy'
  | 'failed'
  | 'no-final-line'

function outcomeOf(invocation: InvocationRecord): ReportOutcome {
  return invocation.phase === 'begun' ? 'no-final-line' : invocation.outcome
}

const OUTCOME_SENTENCE: Readonly<Record<ReportOutcome, string>> = {
  complete: 'Connect complete.',
  degraded: 'Connect degraded.',
  busy: 'Connect busy: another run held the lock, so nothing was read.',
  failed: 'Connect failed.',
  'no-final-line':
    'The run ended with no final line: it began and never reported an outcome.',
}

/** The workflow job is red for these. */
function isRed(outcome: ReportOutcome): boolean {
  return outcome === 'failed' || outcome === 'no-final-line'
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface RenderRequest {
  /** The UTC date of the report, `YYYY-MM-DD`. */
  readonly date: string
  /** The GitHub run id and attempt of this workflow run. */
  readonly runId: string
  readonly attempt: string
  /** Whether an Actions cache was restored for this run. */
  readonly cacheRestored: boolean
}

export type RenderResult =
  | {
      readonly status: 'rendered'
      readonly body: string
      readonly bodyFile: string
      /** The hash in the body's manifest marker. */
      readonly manifest: string
      readonly open: number
      readonly shown: number
      readonly hidden: number
      /** Candidates listed for the first time on this date. */
      readonly fresh: number
      /** The `<run>.<attempt>` fetch words of the listed candidates, in the order they appear. */
      readonly fetches: readonly string[]
      readonly outcome: ReportOutcome
      /** The workflow job turns red after posting. */
      readonly red: boolean
      /** False when the report was rendered without the lock and recorded no payload or manifest. */
      readonly stateUpdated: boolean
    }
  | { readonly status: 'busy'; readonly reason: LockBusyReason }
  | {
      readonly status: 'failed'
      readonly reason:
        | 'invalid-request'
        | 'lock-failed'
        | 'ledger-unreadable'
        | 'no-invocation'
        | 'payload-store-unreadable'
        | 'payload-store-too-large'
        | 'manifest-store-unreadable'
        | 'write-failed'
    }

interface Row {
  readonly id: string
  readonly payload: Payload | undefined
  readonly isNew: boolean
  readonly block: string
}

interface BodyInput {
  readonly outcome: ReportOutcome
  readonly facts: readonly string[]
  readonly cacheRestored: boolean
  /** The report was rendered without the lock, so no payload or manifest was recorded. */
  readonly stateUpdated: boolean
  readonly rows: readonly Row[]
}

interface Assembled {
  readonly body: string
  readonly ids: readonly string[]
  readonly hash: string
  readonly fetches: readonly string[]
  readonly fresh: number
}

function validRequest(request: RenderRequest): boolean {
  return (
    validDate(request.date) &&
    isDigits(request.runId) &&
    isDigits(request.attempt)
  )
}

function factsOf(id: string, payload: Payload): string {
  const target =
    payload.repo === undefined
      ? payload.targetName
      : `${payload.targetName} (${payload.repo})`
  const lines = [
    `Id: ${id}`,
    `Kind: ${payload.kind}`,
    `Target: ${target}`,
    `Title: ${payload.title}`,
    `Summary: ${payload.summary}`,
    `Next step: ${payload.nextStep}`,
  ]
  if (payload.sources.length > 0) lines.push('Sources:')
  for (const source of payload.sources) {
    lines.push(`- ${source.projectName} ${source.path}`)
    if (source.excerpt !== undefined) lines.push(`  Excerpt: ${source.excerpt}`)
  }
  return lines.join('\n')
}

/** `<run>.<attempt>`: the artifact of the attempt that listed the candidate. A bare run would read the newest attempt. */
function fetchWord(payload: Payload): string {
  return `${payload.runId}.${payload.attempt}`
}

function blockOf(
  position: number,
  id: string,
  payload: Payload | undefined,
  isNew: boolean,
): string {
  const lines = [`### Candidate ${position}${isNew ? ' (new)' : ''}`, '']
  if (payload === undefined) {
    lines.push(`Details unavailable for \`${id}\`.`)
  } else {
    lines.push(
      `- Fetch: \`/ce:connect fetch:${fetchWord(payload)}\` (run ${payload.runId}, attempt ${payload.attempt})`,
      '',
      fenceText(factsOf(id, payload)),
    )
  }
  lines.push(
    '',
    decisionLine(id, 'promoted', false),
    decisionLine(id, 'rejected', false),
    '',
  )
  return lines.join('\n')
}

/** `1-3, 5`: ascending positions as ranges. */
function ranges(positions: readonly number[]): string {
  const spans: Array<[number, number]> = []
  for (const position of positions) {
    const last = spans.at(-1)
    if (last !== undefined && position === last[1] + 1) last[1] = position
    else spans.push([position, position])
  }
  return spans
    .map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`))
    .join(', ')
}

function fetchLines(rows: readonly Row[]): {
  fetches: string[]
  lines: string[]
} {
  const byFetch = new Map<string, number[]>()
  rows.forEach((row, index) => {
    if (row.payload === undefined) return
    const word = fetchWord(row.payload)
    const list = byFetch.get(word) ?? []
    list.push(index + 1)
    byFetch.set(word, list)
  })
  const lines = [...byFetch].map(
    ([word, positions]) =>
      `- \`/ce:connect fetch:${word}\` for candidates ${ranges(positions)}`,
  )
  return { fetches: [...byFetch.keys()], lines }
}

const RESET_NOTICE =
  '> **Ledger reset.** No cache was restored for this run, so the ledger and the sweep started fresh. Earlier decisions are not remembered, and a tick for a candidate the ledger no longer knows is reported as unresolved.'

const STATE_NOT_UPDATED_NOTICE =
  '> **State not updated.** Another run held the lock, so this report was rendered from the ledger as it stands and recorded nothing. A tick on it is read only when an earlier report listed the same candidates.'

const HOW_TO_TICK =
  'Tick **Promoted** after you have promoted a candidate, or **Rejected** to dismiss it, one box per candidate. Ticking both boxes for one candidate is ignored. The next run reads the ticks, and a settled candidate leaves this list.'

function headOf(input: BodyInput): string[] {
  const lines = ['## ce:connect report', '']
  lines.push(`**Outcome:** ${OUTCOME_SENTENCE[input.outcome]}`, '')
  if (input.facts.length > 0) lines.push(fenceText(input.facts.join('\n')), '')
  if (!input.cacheRestored) lines.push(RESET_NOTICE, '')
  if (!input.stateUpdated) lines.push(STATE_NOT_UPDATED_NOTICE, '')
  return lines
}

function hiddenLine(hidden: number): string {
  const noun = hidden === 1 ? 'candidate is' : 'candidates are'
  return `**${hidden} open ${noun} not shown.** They stay open and appear here, oldest first, as the ones above are settled.`
}

function assemble(input: BodyInput, shown: number): Assembled {
  const rows = input.rows.slice(0, shown)
  const ids = rows.map((row) => row.id)
  const hash = manifestHash(ids)
  const fetch = fetchLines(rows)
  const fresh = rows.filter((row) => row.isNew).length
  const open = input.rows.length
  const out = [manifestMarker(hash), '', ...headOf(input)]
  if (fetch.lines.length > 0) {
    out.push(
      '## Fetch',
      '',
      'Run one of these in a local checkout to bring the evidence in before you promote:',
      ...fetch.lines,
      '',
    )
  }
  out.push('## Open candidates', '')
  out.push(
    `${open} open, ${shown} listed${fresh > 0 ? `, ${fresh} new` : ''}.`,
    '',
    HOW_TO_TICK,
    '',
    DECISIONS_BEGIN,
    '',
  )
  for (const row of rows) out.push(row.block)
  out.push(DECISIONS_END, '')
  if (shown < open) out.push(hiddenLine(open - shown), '')
  return { body: out.join('\n'), ids, hash, fetches: fetch.fetches, fresh }
}

/** The most candidates whose report fits the cap: the oldest, whole, and never a block cut. */
function fit(input: BodyInput): number {
  const total = input.rows.length
  if (assemble(input, total).body.length <= REPORT_MAX_CHARS) return total
  // With a hidden line the length only grows with the count, so a search works.
  let low = 0
  let high = total - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (assemble(input, middle).body.length <= REPORT_MAX_CHARS) low = middle
    else high = middle - 1
  }
  return low
}

function openOldestFirst(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries
    .filter((entry) => entry.status === 'candidate')
    .sort((a, b) => {
      if (a.recordedAt !== b.recordedAt)
        return a.recordedAt < b.recordedAt ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
}

/** Payloads this run proposes for candidates the ledger shows open. */
function proposed(
  run: RunSummary | undefined,
  open: ReadonlySet<string>,
  request: RenderRequest,
): Map<string, Payload> {
  const out = new Map<string, Payload>()
  for (const raw of run?.candidates ?? []) {
    if (!isRecord(raw) || !isCandidateId(raw.id) || !open.has(raw.id)) continue
    const text = payloadText(raw)
    if (text === undefined) continue
    const target = typeof raw.target === 'string' ? raw.target : undefined
    const repo = target === undefined ? undefined : run?.repoByRoot.get(target)
    out.set(raw.id, {
      id: raw.id,
      ...text,
      ...(repo === undefined ? {} : { repo }),
      runId: request.runId,
      attempt: request.attempt,
    })
  }
  return out
}

/**
 * The payload of each open candidate: this run's text when it proposes the
 * candidate, otherwise the stored text. A settled candidate has none.
 */
function mergedPayloads(
  open: readonly LedgerEntry[],
  stored: ReadonlyMap<string, Payload>,
  fresh: ReadonlyMap<string, Payload>,
): Map<string, Payload> {
  const out = new Map<string, Payload>()
  for (const entry of open) {
    const earlier = stored.get(entry.id)
    const current = fresh.get(entry.id)
    const merged =
      current === undefined
        ? earlier
        : {
            ...current,
            ...(earlier?.firstShown === undefined
              ? {}
              : { firstShown: earlier.firstShown }),
          }
    if (merged !== undefined) out.set(entry.id, merged)
  }
  return out
}

function factLines(
  invocation: InvocationRecord,
  run: RunSummary | undefined,
): string[] {
  const lines: string[] = []
  if (run?.selection !== undefined) lines.push(`Selection: ${run.selection}`)
  if (run?.sweep !== undefined) lines.push(run.sweep)
  const reason = invocation.phase === 'terminal' ? invocation.reason : undefined
  if (reason !== undefined) lines.push(`Reason: ${reason}`)
  if (run !== undefined && run.degradeReasons.length > 0) {
    lines.push('Degrade reasons:', ...run.degradeReasons.map((r) => `- ${r}`))
  }
  return lines
}

function rowsOf(
  open: readonly LedgerEntry[],
  payloads: ReadonlyMap<string, Payload>,
  date: string,
): Row[] {
  return open.map((entry, index) => {
    const payload = payloads.get(entry.id)
    const isNew = payload !== undefined && (payload.firstShown ?? date) === date
    return {
      id: entry.id,
      payload,
      isNew,
      block: blockOf(index + 1, entry.id, payload, isNew),
    }
  })
}

interface Stores {
  readonly payloads: ReadonlyMap<string, Payload>
  /** The stored manifests; absent when the render records nothing. */
  readonly manifests: readonly Manifest[] | undefined
}

/**
 * The stores a render reads. A render that records state stops on a store it
 * cannot use, so it never replaces what it could not read. One that records
 * nothing reads an unusable payload store as empty and leaves the manifest
 * store alone.
 */
function loadStores(
  root: string,
  recordState: boolean,
):
  | { readonly status: 'ok'; readonly stores: Stores }
  | {
      readonly status: 'failed'
      readonly reason: 'payload-store-unreadable' | 'manifest-store-unreadable'
    } {
  const payloads = readPayloadStore(root)
  if (payloads.status !== 'ok' && recordState) {
    return { status: 'failed', reason: 'payload-store-unreadable' }
  }
  const manifests = recordState ? readManifestStore(root) : undefined
  if (manifests !== undefined && manifests.status !== 'ok') {
    return { status: 'failed', reason: 'manifest-store-unreadable' }
  }
  return {
    status: 'ok',
    stores: {
      payloads: payloads.status === 'ok' ? payloads.items : new Map(),
      manifests: manifests?.status === 'ok' ? manifests.items : undefined,
    },
  }
}

/**
 * The report for the state in `root`. With `recordState` it also records the
 * payload and manifest stores, so the lock must be held and an unusable store
 * stops the render. Without it nothing but the body is written.
 */
function renderState(
  root: string,
  request: RenderRequest,
  recordState: boolean,
): RenderResult {
  const read = readLedger(root)
  if (read.status !== 'ok')
    return { status: 'failed', reason: 'ledger-unreadable' }
  const invocation = readInvocationRecord(root)
  if (invocation?.marker !== `${request.runId}-${request.attempt}`) {
    return { status: 'failed', reason: 'no-invocation' }
  }
  const run =
    invocation.runId === undefined
      ? undefined
      : readRunSummary(root, invocation.runId)
  const loaded = loadStores(root, recordState)
  if (loaded.status === 'failed') return loaded
  const open = openOldestFirst(read.ledger.entries)
  const payloads = mergedPayloads(
    open,
    loaded.stores.payloads,
    proposed(run, new Set(open.map((entry) => entry.id)), request),
  )
  const outcome = outcomeOf(invocation)
  const input: BodyInput = {
    outcome,
    facts: factLines(invocation, run),
    cacheRestored: request.cacheRestored,
    stateUpdated: recordState,
    rows: rowsOf(open, payloads, request.date),
  }
  const shown = fit(input)
  const result = assemble(input, shown)
  for (const id of result.ids) {
    const payload = payloads.get(id)
    if (payload !== undefined && payload.firstShown === undefined) {
      payloads.set(id, { ...payload, firstShown: request.date })
    }
  }
  const storeText = payloadStoreText([...payloads.values()])
  if (recordState && Buffer.byteLength(storeText) > MAX_PAYLOAD_BYTES) {
    return { status: 'failed', reason: 'payload-store-too-large' }
  }
  const bodyFile = path.join(root, REPORT_FILE)
  try {
    if (loaded.stores.manifests !== undefined) {
      writeFileAtomic(path.join(root, PAYLOAD_FILE), storeText)
      writeManifestStore(
        root,
        withManifest(loaded.stores.manifests, {
          hash: result.hash,
          ids: result.ids,
        }),
      )
    }
    writeFileAtomic(bodyFile, result.body)
  } catch {
    return { status: 'failed', reason: 'write-failed' }
  }
  return {
    status: 'rendered',
    body: result.body,
    bodyFile,
    manifest: result.hash,
    open: open.length,
    shown,
    hidden: open.length - shown,
    fresh: result.fresh,
    fetches: result.fetches,
    outcome,
    red: isRed(outcome),
    stateUpdated: recordState,
  }
}

/**
 * Render a run that ended `busy` while a live holder still has the lock. That
 * run read nothing, so the report only has to say so and list the open
 * candidates; it needs no state of its own. Any other run is not rendered
 * without the lock.
 */
function renderBusyRun(
  root: string,
  request: RenderRequest,
): RenderResult | undefined {
  const invocation = readInvocationRecord(root)
  if (
    invocation?.marker !== `${request.runId}-${request.attempt}` ||
    outcomeOf(invocation) !== 'busy'
  ) {
    return undefined
  }
  try {
    return renderState(root, request, false)
  } catch {
    return { status: 'failed', reason: 'write-failed' }
  }
}

/**
 * Render the report body for the state in `root`: the open candidates of the
 * ledger, oldest first, as many as fit under the cap, each with its two
 * boxes. Updates the payload store and the manifest store and writes the body
 * to `report.md`. It needs this workflow run's invocation record (the marker
 * `<run>-<attempt>`); without one it writes nothing. A run that ended `busy`
 * is still reported when a live holder keeps the lock: the ledger is read
 * without it, only `report.md` is written, and the body says the state was
 * not updated.
 */
export function renderReport(
  root: string,
  request: RenderRequest,
  options: CiOptions = {},
): RenderResult {
  if (!validRequest(request))
    return { status: 'failed', reason: 'invalid-request' }
  const acquired = acquireLock(root, lockOptions(options))
  if (acquired.status === 'busy') {
    return (
      renderBusyRun(root, request) ?? {
        status: 'busy',
        reason: acquired.reason,
      }
    )
  }
  if (acquired.status === 'failed') {
    return { status: 'failed', reason: 'lock-failed' }
  }
  try {
    return renderState(root, request, true)
  } catch {
    return { status: 'failed', reason: 'write-failed' }
  } finally {
    releaseLock(acquired.lock)
  }
}

// ── Applying ticks ──────────────────────────────────────────────────────────

export interface TickOptions extends CiOptions {
  readonly hooks?: {
    /** Runs after the ticks are sorted and before the first one is recorded. */
    readonly afterTriage?: () => void
  }
}

export interface TickRequest {
  /** The report body as the issue holds it now. */
  readonly body: string
  /** The report's issue number; it goes into the reason a decision records. */
  readonly issue: number
}

export interface AcceptedTick {
  readonly id: string
  readonly status: DecisionStatus
}

export type SkipReason =
  | 'conflict'
  | 'not-in-manifest'
  | 'not-open'
  | 'already-recorded'

export interface SkippedTick {
  readonly id: string
  readonly status?: DecisionStatus
  readonly reason: SkipReason
}

export type UnresolvedReason = 'manifest-missing' | 'unknown-candidate'

export interface UnresolvedTick {
  readonly id: string
  readonly status: DecisionStatus
  readonly reason: UnresolvedReason
}

export type TickResult =
  | {
      readonly status: 'applied'
      readonly section: BodySection
      readonly accepted: readonly AcceptedTick[]
      readonly skipped: readonly SkippedTick[]
      readonly unresolved: readonly UnresolvedTick[]
    }
  | {
      readonly status: 'busy'
      readonly reason: LockBusyReason
      readonly accepted: readonly AcceptedTick[]
    }
  | {
      readonly status: 'failed'
      readonly reason:
        | 'invalid-request'
        | 'ledger-unreadable'
        | 'lock-failed'
        | 'write-failed'
      readonly accepted: readonly AcceptedTick[]
    }

interface Tick {
  readonly id: string
  readonly status: DecisionStatus
}

/** Each ticked (id, status) once, in document order. */
function tickedBoxes(boxes: readonly ParsedBox[]): Tick[] {
  const seen = new Set<string>()
  const out: Tick[] = []
  for (const box of boxes) {
    const key = `${box.id}:${box.status}`
    if (!box.ticked || seen.has(key)) continue
    seen.add(key)
    out.push({ id: box.id, status: box.status })
  }
  return out
}

function emptyApplied(section: BodySection): TickResult {
  return {
    status: 'applied',
    section,
    accepted: [],
    skipped: [],
    unresolved: [],
  }
}

function groupById(ticks: readonly Tick[]): Map<string, DecisionStatus[]> {
  const byId = new Map<string, DecisionStatus[]>()
  for (const tick of ticks) {
    byId.set(tick.id, [...(byId.get(tick.id) ?? []), tick.status])
  }
  return byId
}

interface Triage {
  readonly record: Tick[]
  readonly skipped: SkippedTick[]
  readonly unresolved: UnresolvedTick[]
}

type Verdict =
  | { readonly kind: 'record'; readonly tick: Tick }
  | { readonly kind: 'skip'; readonly skipped: SkippedTick }
  | { readonly kind: 'unresolved'; readonly unresolved: UnresolvedTick }

/** What to do with the ticks one candidate has, given the manifest and the ledger. */
function judge(
  id: string,
  statuses: readonly DecisionStatus[],
  manifest: Manifest,
  entry: LedgerEntry | undefined,
  reason: string,
): Verdict | undefined {
  const [status] = statuses
  if (status === undefined) return undefined
  const skip = (why: SkipReason): Verdict => ({
    kind: 'skip',
    skipped: { id, status, reason: why },
  })
  if (statuses.length > 1) {
    return { kind: 'skip', skipped: { id, reason: 'conflict' } }
  }
  if (!manifest.ids.includes(id)) return skip('not-in-manifest')
  if (entry === undefined) {
    return {
      kind: 'unresolved',
      unresolved: { id, status, reason: 'unknown-candidate' },
    }
  }
  if (entry.status === status && entry.reason === reason) {
    return skip('already-recorded')
  }
  if (entry.status !== 'candidate') return skip('not-open')
  return { kind: 'record', tick: { id, status } }
}

function triage(
  ticks: readonly Tick[],
  manifest: Manifest | undefined,
  entries: readonly LedgerEntry[],
  reason: string,
): Triage {
  const out: Triage = { record: [], skipped: [], unresolved: [] }
  if (manifest === undefined) {
    for (const tick of ticks) {
      out.unresolved.push({ ...tick, reason: 'manifest-missing' })
    }
    return out
  }
  for (const [id, statuses] of groupById(ticks)) {
    const entry = entries.find((item) => item.id === id)
    const verdict = judge(id, statuses, manifest, entry, reason)
    if (verdict?.kind === 'record') out.record.push(verdict.tick)
    else if (verdict?.kind === 'skip') out.skipped.push(verdict.skipped)
    else if (verdict?.kind === 'unresolved') {
      out.unresolved.push(verdict.unresolved)
    }
  }
  return out
}

/** The reasons a decision can fail that a caller can act on; the rest are a write that did not happen. */
function failureOf(
  reason: string,
): 'ledger-unreadable' | 'lock-failed' | 'write-failed' {
  return reason === 'ledger-unreadable' || reason === 'lock-failed'
    ? reason
    : 'write-failed'
}

/**
 * Record the ticks of a report body. A tick counts when its box is a generated
 * line in the section of the body, its id is in the manifest the body names,
 * and the candidate is open; a decision already recorded with the same reason
 * is left as it is, so a second pass changes nothing. Each decision is made
 * only if the candidate is still open under the lock, so one recorded since
 * the ledger was read is skipped as `not-open`, never overwritten.
 */
export function applyTicks(
  root: string,
  request: TickRequest,
  options: TickOptions = {},
): TickResult {
  if (!Number.isSafeInteger(request.issue) || request.issue < 1) {
    return { status: 'failed', reason: 'invalid-request', accepted: [] }
  }
  const parsed = parseReportBody(request.body)
  const ticks = tickedBoxes(parsed.boxes)
  if (parsed.section !== 'ok' || ticks.length === 0) {
    return emptyApplied(parsed.section)
  }
  const stored = readManifestStore(root)
  const manifest =
    stored.status === 'ok'
      ? stored.items.find((item) => item.hash === parsed.manifest)
      : undefined
  const read = readLedger(root)
  if (read.status !== 'ok') {
    return { status: 'failed', reason: 'ledger-unreadable', accepted: [] }
  }
  const reason = `settled in report #${request.issue}`
  const sorted = triage(ticks, manifest, read.ledger.entries, reason)
  options.hooks?.afterTriage?.()
  const accepted: AcceptedTick[] = []
  const skipped = [...sorted.skipped]
  for (const tick of sorted.record) {
    const decided = decideLedgerEntry(
      root,
      { id: tick.id, status: tick.status, reason, onlyIfOpen: true },
      lockOptions(options),
    )
    if (decided.status === 'busy') {
      return { status: 'busy', reason: decided.reason, accepted }
    }
    if (decided.status === 'failed' && decided.reason === 'not-open') {
      skipped.push({ id: tick.id, status: tick.status, reason: 'not-open' })
      continue
    }
    if (decided.status === 'failed') {
      return { status: 'failed', reason: failureOf(decided.reason), accepted }
    }
    accepted.push(tick)
  }
  return {
    status: 'applied',
    section: parsed.section,
    accepted,
    skipped,
    unresolved: sorted.unresolved,
  }
}
