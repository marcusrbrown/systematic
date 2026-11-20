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
 * the manifest of the report that was read, whose candidate is still open and
 * whose revision is the one the line was generated for.
 * The manifest of a report is stored under the hash its body carries, so a
 * report that was posted keeps its own manifest even when a later render
 * failed to post or posted something else.
 *
 * Every line names the revision of its candidate as `:r<12 hex>`: a hash of
 * the fingerprints a decision reviews, so it changes when the candidate's
 * learning, target or evidence does, and the same content always has the same
 * revision. A tick made against another revision is skipped as stale and never
 * recorded, so it cannot settle a candidate nobody has decided. A line without
 * one is from a report before revisions and is skipped as `unversioned`: the
 * operator ticks the revision-tagged box of the current report instead.
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
import {
  CANDIDATE_LIMITS,
  MISMATCH_REASONS,
  renderSweepLine,
  sanitizeText,
} from './connect-helper-core.js'
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
  revisionOf,
} from './connect-state.js'

// ── Format ──────────────────────────────────────────────────────────────────

/** A report body is never longer than this many characters. */
export const REPORT_MAX_CHARS = 60_000

/** The most candidate ids the section for rows with no verified details names; the rest are counted. */
export const MAX_UNVERIFIED_IDS = 20

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
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** `<!-- connect-manifest:<hash> -->`: which stored manifest this body was rendered with. */
export function manifestMarker(hash: string): string {
  return `<!-- connect-manifest:${hash} -->`
}

/**
 * One generated checkbox line. The marker carries the id and the revision as
 * `:r<12 hex>`; nothing else on the line is read. A line made without a
 * revision is the one reports used before revisions.
 */
export function decisionLine(
  id: string,
  status: DecisionStatus,
  ticked: boolean,
  revision?: string,
): string {
  const suffix = revision === undefined ? '' : `:r${revision}`
  return `- [${ticked ? 'x' : ' '}] ${STATUS_LABEL[status]} <!-- connect-decision:${status}:${id}${suffix} -->`
}

const MANIFEST_LINE = /^<!-- connect-manifest:([0-9a-f]{16}) -->[ \t]*$/
const DECISION_LINE =
  /^- \[([ xX])\] (Promoted|Rejected) <!-- connect-decision:(promoted|rejected):([0-9a-f]{64})(?::r([0-9a-f]{12}))? -->[ \t]*$/
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
  /** The revision the line names; absent for a line from before revisions. */
  readonly revision: string | undefined
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
  const [, mark, label, status, id, named] = match
  if (id === undefined || label === undefined || mark === undefined) {
    return undefined
  }
  if (status !== 'promoted' && status !== 'rejected') return undefined
  if (STATUS_LABEL[status] !== label) return undefined
  return { id, status, ticked: mark !== ' ', revision: named }
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

/**
 * A file a `code-mismatch` candidate cites as evidence: where it is and the
 * checkout HEAD its project had when the run read it. The excerpt is not kept;
 * `fetch:` brings it in.
 */
interface PayloadEvidence {
  readonly projectName: string
  /**
   * The `owner/repo` the file belongs to, so the visibility rechecks can name
   * a repository only this candidate cites. Absent when it could not be named.
   */
  readonly repo?: string
  readonly path: string
  readonly start?: number
  readonly end?: number
  readonly head?: string
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
  /** Why a `code-mismatch` learning is a candidate. Absent for every other kind. */
  readonly reason?: string
  /** The evidence a `code-mismatch` candidate cites. Absent for every other kind. */
  readonly evidence?: readonly PayloadEvidence[]
  /** The UTC date the candidate was first listed. Absent until it is listed. */
  readonly firstShown?: string
  /** The GitHub run and attempt whose artifact holds the candidate's evidence. */
  readonly runId: string
  readonly attempt: string
  /**
   * The revision this text describes: what the run that proposed it recorded.
   * Absent in a store from before revisions, and then no box is rendered for
   * it until a run stores text with a revision. A box is rendered only when it
   * equals the entry's revision, so a proposal that was never committed can
   * never sit above another revision's box.
   */
  readonly revision?: string
}

type PayloadText = Pick<
  Payload,
  | 'title'
  | 'summary'
  | 'kind'
  | 'nextStep'
  | 'targetName'
  | 'sources'
  | 'reason'
  | 'evidence'
>

/** Each project's recorded checkout HEAD, by the root a candidate names it by. */
type Heads = ReadonlyMap<string, string>

/** Each project's `owner/repo`, by the same root. */
type Repos = ReadonlyMap<string, string>

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

function spanOf(
  start: unknown,
  end: unknown,
): { start: number; end: number } | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return undefined
  }
  const from = start as number
  const to = end as number
  return from >= 1 && to >= from ? { start: from, end: to } : undefined
}

function evidenceItemOf(
  item: unknown,
  heads: Heads,
  repos: Repos,
): PayloadEvidence | undefined {
  if (!isRecord(item)) return undefined
  const evidencePath = lineOf(item.path, LIMITS.path)
  if (evidencePath === undefined) return undefined
  const span = spanOf(item.start, item.end)
  // A stored item carries its HEAD; an item of a run record names its project by root.
  const head =
    typeof item.head === 'string' && OBJECT_ID.test(item.head)
      ? item.head
      : typeof item.project === 'string'
        ? heads.get(item.project)
        : undefined
  const repo =
    typeof item.repo === 'string' && REPO.test(item.repo)
      ? item.repo
      : typeof item.project === 'string'
        ? repos.get(item.project)
        : undefined
  return {
    projectName: lineOf(item.projectName, LIMITS.name) ?? 'unknown',
    ...(repo === undefined ? {} : { repo }),
    path: evidencePath,
    ...(span === undefined ? {} : span),
    ...(head === undefined ? {} : { head }),
  }
}

/** The reason and evidence of a `code-mismatch` candidate. Another kind has neither. */
function mismatchFields(
  raw: Record<string, unknown>,
  kind: string,
  heads: Heads,
  repos: Repos,
): Pick<PayloadText, 'reason' | 'evidence'> {
  if (kind !== 'code-mismatch') return {}
  const reason = MISMATCH_REASONS.find((known) => known === raw.reason)
  // A run record names its evidence `counterevidence`; the store names it `evidence`.
  const list = Array.isArray(raw.evidence) ? raw.evidence : raw.counterevidence
  const evidence = Array.isArray(list)
    ? (list as unknown[])
        .slice(0, CANDIDATE_LIMITS.counterevidence)
        .flatMap((item) => evidenceItemOf(item, heads, repos) ?? [])
    : []
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(evidence.length === 0 ? {} : { evidence }),
  }
}

/** The display fields of a candidate, from a run record or from the store. */
function payloadText(
  raw: unknown,
  heads: Heads,
  repos: Repos,
): PayloadText | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) return undefined
  const title = lineOf(raw.title, LIMITS.title)
  const summary = paragraphOf(raw.summary, LIMITS.summary)
  if (title === undefined || summary === undefined) return undefined
  const sources = (raw.sources as unknown[])
    .slice(0, LIMITS.sources)
    .flatMap((item) => sourceOf(item) ?? [])
  const kind = tokenOf(raw.kind)
  return {
    title,
    summary,
    kind,
    nextStep: tokenOf(raw.nextStep),
    targetName: lineOf(raw.targetName, LIMITS.name) ?? 'unknown',
    sources,
    ...mismatchFields(raw, kind, heads, repos),
  }
}

const REVISION = /^[0-9a-f]{12}$/

function revisionField(value: unknown): { revision?: string } {
  const revision = revisionFrom(value)
  return revision === undefined ? {} : { revision }
}

/** A revision read from a store or a run record: 12 lowercase hex characters, else none. */
function revisionFrom(value: unknown): string | undefined {
  return typeof value === 'string' && REVISION.test(value) ? value : undefined
}

function payloadFromStore(raw: unknown): Payload | undefined {
  if (!isRecord(raw) || !isCandidateId(raw.id)) return undefined
  const text = payloadText(raw, new Map(), new Map())
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
    ...revisionField(raw.revision),
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
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.evidence === undefined ? {} : { evidence: payload.evidence }),
    ...(payload.firstShown === undefined
      ? {}
      : { firstShown: payload.firstShown }),
    runId: payload.runId,
    attempt: payload.attempt,
    ...(payload.revision === undefined ? {} : { revision: payload.revision }),
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
  /** The checkout HEAD of each project, by the same root. */
  readonly commitByRoot: Heads
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

function commitMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(value)) return out
  for (const item of (value as unknown[]).slice(0, MAX_PROJECTS)) {
    if (!isRecord(item)) continue
    const { root, commit } = item
    if (
      typeof root === 'string' &&
      typeof commit === 'string' &&
      OBJECT_ID.test(commit)
    ) {
      out.set(root, commit)
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
    commitByRoot: commitMap(record.projects),
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
  /**
   * The `owner/repo` that called the workflow. Absent, or Systematic itself
   * (ignoring case), the fetch words stay bare: a bare word always means
   * Systematic. Any other repository is named in every fetch word.
   */
  readonly repo?: string
}

export type RenderResult =
  | {
      readonly status: 'rendered'
      readonly body: string
      readonly bodyFile: string
      /** The hash in the body's manifest marker. */
      readonly manifest: string
      /** Every open candidate, listed or not. */
      readonly open: number
      readonly shown: number
      /** The listable candidates the size cap left out. */
      readonly hidden: number
      /** The open candidates with no bundle for their live revision, counted in one section. */
      readonly unverified: number
      /** Candidates listed for the first time on this date. */
      readonly fresh: number
      /** The fetch words of the listed candidates, in the order they appear: `<run>.<attempt>`, or `<owner>/<repo>:<run>.<attempt>` for a caller other than Systematic. */
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

export interface Row {
  readonly id: string
  readonly payload: Payload
  readonly isNew: boolean
  readonly block: string
}

export interface BodyInput {
  readonly outcome: ReportOutcome
  readonly facts: readonly string[]
  readonly cacheRestored: boolean
  /** The report was rendered without the lock, so no payload or manifest was recorded. */
  readonly stateUpdated: boolean
  /** The open entries that have a bundle for their live revision: the only rows with boxes. */
  readonly rows: readonly Row[]
  /** The ids of the other open entries, oldest first. */
  readonly unverified: readonly string[]
  /** The caller repository the fetch words name; absent for Systematic, whose words are bare. */
  readonly fetchRepo?: string
}

export interface Assembled {
  readonly body: string
  readonly ids: readonly string[]
  readonly hash: string
  readonly fetches: readonly string[]
  readonly fresh: number
}

/** A GitHub owner: 1 to 39 letters, digits and hyphens, with no hyphen at either end. */
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
/** A GitHub repository name: 1 to 100 letters, digits, `.`, `_` and `-`. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

/** The repository whose fetch words stay bare. */
const SYSTEMATIC_REPO = 'marcusrbrown/systematic'

/** `owner/repo`, shaped as GitHub allows and nothing else: it is printed into a command the report asks a person to run. */
function validRepo(repo: string): boolean {
  const parts = repo.split('/')
  const [owner, name] = parts
  return (
    parts.length === 2 &&
    owner !== undefined &&
    name !== undefined &&
    OWNER_NAME.test(owner) &&
    REPO_NAME.test(name) &&
    name !== '.' &&
    name !== '..'
  )
}

function validRequest(request: RenderRequest): boolean {
  return (
    validDate(request.date) &&
    isDigits(request.runId) &&
    isDigits(request.attempt) &&
    (request.repo === undefined || validRepo(request.repo))
  )
}

/** The repository the fetch words name: the caller, unless it is Systematic or none was sent. */
function fetchRepoOf(request: RenderRequest): string | undefined {
  const { repo } = request
  return repo === undefined || repo.toLowerCase() === SYSTEMATIC_REPO
    ? undefined
    : repo
}

function factsOf(id: string, payload: Payload): string {
  const target =
    payload.repo === undefined
      ? payload.targetName
      : `${payload.targetName} (${payload.repo})`
  const lines = [
    `Id: ${id}`,
    `Kind: ${payload.kind}`,
    ...(payload.reason === undefined ? [] : [`Reason: ${payload.reason}`]),
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
  if (payload.evidence !== undefined) lines.push('Evidence:')
  for (const item of payload.evidence ?? []) {
    const span =
      item.start === undefined || item.end === undefined
        ? '?'
        : `${item.start}-${item.end}`
    lines.push(
      `- ${item.projectName}:${item.path}:${span}:${item.head ?? 'unavailable'}`,
    )
  }
  return lines.join('\n')
}

/**
 * `<run>.<attempt>`: the artifact of the attempt that listed the candidate. A
 * bare run would read the newest attempt. A caller other than Systematic gets
 * `<owner>/<repo>:` in front, because a bare word always means Systematic. The
 * repository is not stored with the payload: a caller's store holds that
 * caller's rows alone, so the one the request names applies to all of them.
 */
function fetchWord(payload: Payload, repo: string | undefined): string {
  const run = `${payload.runId}.${payload.attempt}`
  return repo === undefined ? run : `${repo}:${run}`
}

function blockOf(
  position: number,
  entry: LedgerEntry,
  revision: string,
  payload: Payload,
  isNew: boolean,
  fetchRepo: string | undefined,
): string {
  const { id } = entry
  const marks = [
    ...(isNew ? ['new'] : []),
    ...(entry.reopened === undefined ? [] : ['reopened']),
  ]
  const lines = [
    `### Candidate ${position}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`,
    '',
  ]
  lines.push(
    `- Fetch: \`/ce:connect fetch:${fetchWord(payload, fetchRepo)}\` (run ${payload.runId}, attempt ${payload.attempt})`,
    '',
    fenceText(factsOf(id, payload)),
  )
  lines.push(
    '',
    decisionLine(id, 'promoted', false, revision),
    decisionLine(id, 'rejected', false, revision),
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

function fetchLines(
  rows: readonly Row[],
  repo: string | undefined,
): {
  fetches: string[]
  lines: string[]
} {
  const byFetch = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const word = fetchWord(row.payload, repo)
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

/**
 * The one section for open entries with no bundle for their live revision.
 * They have no boxes, so they are only counted, and up to `named` ids are
 * listed, oldest first, with the rest as `and N more`. With `named` at 0 it is
 * the count alone. It is bounded, so it can be measured whole and the rows
 * fitted into what it leaves.
 */
function unverifiedSection(ids: readonly string[], named: number): string[] {
  if (ids.length === 0) return []
  const listed = ids.slice(0, named).map((id) => `\`${id}\``)
  const more = ids.length - listed.length
  const count =
    ids.length === 1
      ? '1 open candidate has'
      : `${ids.length} open candidates have`
  const list =
    listed.length === 0
      ? ''
      : ` Oldest first: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`
  return [
    UNVERIFIED_HEADING,
    '',
    `${count} no verified details for the current revision, so there is nothing to tick.${list}`,
    '',
  ]
}

const UNVERIFIED_HEADING = '## No verified details'

/**
 * The report with its first `shown` rows and the section naming `named`
 * unverified ids. Exported for the tests of the size budget.
 */
export function assembleReport(
  input: BodyInput,
  shown: number,
  named: number,
): Assembled {
  const rows = input.rows.slice(0, shown)
  const ids = rows.map((row) => row.id)
  const hash = manifestHash(ids)
  const fetch = fetchLines(rows, input.fetchRepo)
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
  out.push(...unverifiedSection(input.unverified, named))
  return { body: out.join('\n'), ids, hash, fetches: fetch.fetches, fresh }
}

/** How many rows fit, oldest first and whole, when the section names `named` ids. */
function rowsThatFit(input: BodyInput, named: number): number {
  const total = input.rows.length
  const fits = (count: number): boolean =>
    assembleReport(input, count, named).body.length <= REPORT_MAX_CHARS
  if (fits(total)) return total
  // With a hidden line the length only grows with the count, so a search works.
  let low = 0
  let high = total - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * The most rows the cap leaves room for beside the section for the rows that
 * cannot be settled, and how many of those ids the section names. The section
 * is bounded and counts against the cap like everything else, so the whole
 * body stays under `REPORT_MAX_CHARS`, which is what leaves the workflow room
 * for the one line it may add. The full id list is tried first; when it would
 * leave no room for the oldest row, the list is halved down to the count alone.
 * Exported for the tests of the size budget.
 */
export function fitReport(input: BodyInput): {
  readonly shown: number
  readonly named: number
} {
  const wanted = Math.min(1, input.rows.length)
  for (
    let named = Math.min(MAX_UNVERIFIED_IDS, input.unverified.length);
    named > 0;
    named = Math.floor(named / 2)
  ) {
    const shown = rowsThatFit(input, named)
    if (shown >= wanted) return { shown, named }
  }
  return { shown: rowsThatFit(input, 0), named: 0 }
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

/**
 * The bundles this run proposes for candidates the ledger shows open. A bundle
 * is the text, the revision and the run and attempt that hold the evidence,
 * all of the one proposal: this run's record is the only place its parts come
 * from together.
 */
function proposed(
  run: RunSummary | undefined,
  open: ReadonlySet<string>,
  request: RenderRequest,
): Map<string, Payload> {
  const out = new Map<string, Payload>()
  for (const raw of run?.candidates ?? []) {
    if (!isRecord(raw) || !isCandidateId(raw.id) || !open.has(raw.id)) continue
    const text = payloadText(
      raw,
      run?.commitByRoot ?? new Map(),
      run?.repoByRoot ?? new Map(),
    )
    if (text === undefined) continue
    const target = typeof raw.target === 'string' ? raw.target : undefined
    const repo = target === undefined ? undefined : run?.repoByRoot.get(target)
    out.set(raw.id, {
      id: raw.id,
      ...text,
      ...(repo === undefined ? {} : { repo }),
      runId: request.runId,
      attempt: request.attempt,
      ...revisionField(raw.revision),
    })
  }
  return out
}

/**
 * The bundle kept for each open candidate: whichever of this run's proposal
 * and the stored one has the revision the ledger holds (this run's first), so
 * its text, revision and fetch origin always come from one proposal. When
 * neither does, one is kept under its own revision, where it can match only
 * the content it describes, and the report shows no details for the entry. A
 * bundle with no revision (from before revisions) matches none. A settled
 * candidate has none.
 */
function mergedPayloads(
  open: readonly LedgerEntry[],
  stored: ReadonlyMap<string, Payload>,
  fresh: ReadonlyMap<string, Payload>,
): Map<string, Payload> {
  const out = new Map<string, Payload>()
  for (const entry of open) {
    const live = revisionOf(entry)
    const earlier = stored.get(entry.id)
    const proposedNow = fresh.get(entry.id)
    const chosen =
      [proposedNow, earlier].find((bundle) => bundle?.revision === live) ??
      proposedNow ??
      earlier
    if (chosen === undefined) continue
    // The date a candidate was first listed belongs to the candidate, not to a bundle.
    const firstShown = chosen.firstShown ?? earlier?.firstShown
    out.set(entry.id, {
      ...chosen,
      ...(firstShown === undefined ? {} : { firstShown }),
    })
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
  fetchRepo: string | undefined,
): { rows: Row[]; unverified: string[] } {
  const rows: Row[] = []
  const unverified: string[] = []
  for (const entry of open) {
    const held = payloads.get(entry.id)
    const revision = revisionOf(entry)
    // A row, with its fetch link and boxes, comes only from a bundle for the
    // revision the ledger holds. Any other entry is counted in one section.
    if (held === undefined || held.revision !== revision) {
      unverified.push(entry.id)
      continue
    }
    const isNew = (held.firstShown ?? date) === date
    rows.push({
      id: entry.id,
      payload: held,
      isNew,
      block: blockOf(rows.length + 1, entry, revision, held, isNew, fetchRepo),
    })
  }
  return { rows, unverified }
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
  const fetchRepo = fetchRepoOf(request)
  const { rows, unverified } = rowsOf(open, payloads, request.date, fetchRepo)
  const input: BodyInput = {
    outcome,
    facts: factLines(invocation, run),
    cacheRestored: request.cacheRestored,
    stateUpdated: recordState,
    rows,
    unverified,
    ...(fetchRepo === undefined ? {} : { fetchRepo }),
  }
  const { shown, named } = fitReport(input)
  const result = assembleReport(input, shown, named)
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
    hidden: rows.length - shown,
    unverified: unverified.length,
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
  /** The tick was made against another revision of the candidate than the ledger holds. */
  | 'stale'
  /** The tick is on a box with no revision, from a report before revisions: tick the revision-tagged box on the current report. */
  | 'unversioned'

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
  /** The revision the line names; none for a line from before revisions. */
  readonly revision: string | undefined
}

/**
 * Each ticked (id, status, revision) once, in document order. The same
 * candidate ticked at two revisions is two ticks, which the candidate's
 * triage reads as a conflict.
 */
function tickedBoxes(boxes: readonly ParsedBox[]): Tick[] {
  const seen = new Set<string>()
  const out: Tick[] = []
  for (const box of boxes) {
    const key = `${box.id}:${box.status}:${box.revision ?? ''}`
    if (!box.ticked || seen.has(key)) continue
    seen.add(key)
    out.push({ id: box.id, status: box.status, revision: box.revision })
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

function groupById(ticks: readonly Tick[]): Map<string, Tick[]> {
  const byId = new Map<string, Tick[]>()
  for (const tick of ticks) {
    byId.set(tick.id, [...(byId.get(tick.id) ?? []), tick])
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
  ticks: readonly Tick[],
  manifest: Manifest,
  entry: LedgerEntry | undefined,
  reason: string,
): Verdict | undefined {
  const [first] = ticks
  if (first === undefined) return undefined
  const { status } = first
  const skip = (why: SkipReason): Verdict => ({
    kind: 'skip',
    skipped: { id, status, reason: why },
  })
  if (ticks.length > 1) {
    return { kind: 'skip', skipped: { id, reason: 'conflict' } }
  }
  if (!manifest.ids.includes(id)) return skip('not-in-manifest')
  if (entry === undefined) {
    return {
      kind: 'unresolved',
      unresolved: { id, status, reason: 'unknown-candidate' },
    }
  }
  // A tick settles the revision it was made against. A line that names none is
  // from before revisions, and nothing can show which content it was made for.
  if (first.revision === undefined) return skip('unversioned')
  const current = revisionOf(entry)
  if (first.revision !== current) return skip('stale')
  if (entry.status === status && entry.reason === reason) {
    return skip('already-recorded')
  }
  if (entry.status !== 'candidate') return skip('not-open')
  return { kind: 'record', tick: { ...first, revision: current } }
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
      out.unresolved.push({
        id: tick.id,
        status: tick.status,
        reason: 'manifest-missing',
      })
    }
    return out
  }
  for (const [id, group] of groupById(ticks)) {
    const entry = entries.find((item) => item.id === id)
    const verdict = judge(id, group, manifest, entry, reason)
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

/** Why a decision the lock refused leaves the tick skipped: the candidate moved on since the ledger was read. */
function skipReasonOf(reason: string): SkipReason | undefined {
  if (reason === 'not-open') return 'not-open'
  return reason === 'stale-revision' ? 'stale' : undefined
}

/**
 * Record the ticks of a report body. A tick counts when its box is a generated
 * line in the section of the body, its id is in the manifest the body names,
 * and the candidate is open at the revision the line names; a tick for any
 * other revision is skipped as `stale`, and a line from before revisions as
 * `unversioned`. A decision already recorded with
 * the same reason is left as it is, so a second pass changes nothing. Each
 * decision is made only if the candidate is still open at that revision under
 * the lock, so one recorded since the ledger was read is skipped as
 * `not-open`, and a candidate whose content changed since is skipped as
 * `stale`, never overwritten.
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
      {
        id: tick.id,
        status: tick.status,
        reason,
        onlyIfOpen: true,
        revision: tick.revision,
      },
      lockOptions(options),
    )
    if (decided.status === 'busy') {
      return { status: 'busy', reason: decided.reason, accepted }
    }
    if (decided.status === 'failed') {
      const why = skipReasonOf(decided.reason)
      if (why === undefined) {
        return { status: 'failed', reason: failureOf(decided.reason), accepted }
      }
      skipped.push({ id: tick.id, status: tick.status, reason: why })
      continue
    }
    accepted.push({ id: tick.id, status: tick.status })
  }
  return {
    status: 'applied',
    section: parsed.section,
    accepted,
    skipped,
    unresolved: sorted.unresolved,
  }
}
