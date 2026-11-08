/**
 * The deterministic core of the `ce:connect` helper: the rule index, the
 * checks that decide which model-proposed candidates are published, the
 * coverage check, the deterministic "already recorded" test and the digest.
 *
 * Import rule: node builtins, `frontmatter.ts` (js-yaml only), and the
 * `connect-evidence.ts` and `connect-state.ts` modules. The `ce:connect` helper
 * bundles this module, so it must never import zod, `config.ts` or
 * `config-schema.ts`.
 *
 * Trust: the researcher is a model reading documents other people wrote, so a
 * candidate is a proposal and nothing more. A candidate is published only when
 * every path names a tracked, contained file of an allowed project, every
 * fingerprint equals the hash taken when the run began, every excerpt appears
 * verbatim in the file that is cited, every code citation still holds, and the
 * rule id is one the index issued. Text in a candidate is never read as an
 * instruction: it is length-capped, stripped of control characters and
 * rendered as quoted evidence.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CONNECT_BOUNDS,
  type ContainedRead,
  checkCitation,
  containsIdentifier,
  type InventoryFile,
  type InventoryRole,
  readContainedFile,
  UNSAFE_PATH_CHARACTER,
} from './connect-evidence.js'
import type {
  CandidateRecord,
  CoverageRecord,
  Ledger,
} from './connect-state.js'
import { parseFrontmatter } from './frontmatter.js'

// ── State root ──────────────────────────────────────────────────────────────

/**
 * Where run state lives: `systematic/connect` under an absolute, non-empty
 * `XDG_STATE_HOME`, else under `~/.local/state`. A relative `XDG_STATE_HOME`
 * is ignored, as the XDG specification says.
 */
export function resolveStateRoot(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const xdg = env.XDG_STATE_HOME
  const base =
    xdg !== undefined && xdg !== '' && path.isAbsolute(xdg)
      ? xdg
      : path.join(homeDir, '.local', 'state')
  return path.join(base, 'systematic', 'connect')
}

// ── Names and ids ───────────────────────────────────────────────────────────

const MAX_PROJECT_NAME = 100

/** A short, stable key for a project, from its main-root identity. */
export function projectKey(mainRoot: string): string {
  return createHash('sha256')
    .update(`connect-project-v1\0${mainRoot}`)
    .digest('hex')
    .slice(0, 12)
}

/** The directory name of a project, reduced to characters that survive a citation. */
export function projectName(mainRoot: string): string {
  const base = path.basename(mainRoot).replace(/[^A-Za-z0-9._-]+/g, '-')
  const trimmed = base.replace(/^[^A-Za-z0-9]+/, '').slice(0, MAX_PROJECT_NAME)
  return trimmed === '' ? 'project' : trimmed
}

/**
 * The id of a rule: one learning in one project. It depends on the project and
 * the path only, never on the content, so a changed file keeps its id and
 * reopens its ledger entry instead of making a new one.
 */
export function ruleIdFor(mainRoot: string, relPath: string): string {
  const digest = createHash('sha256')
    .update(`connect-rule-v1\0${mainRoot}\0${relPath}`)
    .digest('hex')
  return `rule-${digest.slice(0, 16)}`
}

// ── Rule index ──────────────────────────────────────────────────────────────

/** Characters kept from one section of a learning. */
export const SECTION_TEXT_CAP = 2000
const MAX_APPLIES_WHEN_ITEMS = 10
const MAX_APPLIES_WHEN_LENGTH = 300
const MAX_TITLE_LENGTH = 200

export interface RuleSection {
  readonly text: string
  /** 1-based line of the heading in the file. */
  readonly startLine: number
  readonly endLine: number
  readonly truncated: boolean
}

export type RuleMissing = 'applies_when' | 'guidance' | 'prevention'

export interface RuleEntry {
  readonly id: string
  /** The project's main root. */
  readonly project: string
  readonly path: string
  readonly sha256: string
  readonly title?: string
  readonly appliesWhen: readonly string[]
  readonly guidance?: RuleSection
  readonly prevention?: RuleSection
  readonly missing: readonly RuleMissing[]
  /** The frontmatter did not parse. The sections are still read. */
  readonly parseError: boolean
}

export interface RuleSource {
  readonly project: string
  readonly path: string
  readonly sha256: string
}

interface Heading {
  readonly level: number
  readonly title: string
  readonly line: number
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/

function trimmedOrUndefined(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

function readAppliesWhen(value: unknown): string[] {
  const items = Array.isArray(value) ? (value as unknown[]) : [value]
  const out: string[] = []
  for (const item of items) {
    const text = trimmedOrUndefined(item, MAX_APPLIES_WHEN_LENGTH)
    if (text !== undefined) out.push(text)
    if (out.length >= MAX_APPLIES_WHEN_ITEMS) break
  }
  return out
}

/** Headings outside fenced code, with 1-based file line numbers. */
function findHeadings(lines: readonly string[], firstLine: number): Heading[] {
  const headings: Heading[] = []
  let fence: string | undefined
  lines.forEach((text, index) => {
    const fenceMatch = FENCE_LINE.exec(text)
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1]
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined
      }
      return
    }
    if (fence !== undefined) return
    const match = HEADING.exec(text)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      headings.push({
        level: match[1].length,
        title: match[2],
        line: firstLine + index,
      })
    }
  })
  return headings
}

function readSection(
  lines: readonly string[],
  headings: readonly Heading[],
  firstLine: number,
  name: 'guidance' | 'prevention',
): RuleSection | undefined {
  const at = headings.findIndex((heading) =>
    new RegExp(`^${name}\\b`, 'i').test(heading.title),
  )
  const heading = headings[at]
  if (heading === undefined) return undefined
  const next = headings
    .slice(at + 1)
    .find((candidate) => candidate.level <= heading.level)
  const endLine =
    next === undefined ? firstLine + lines.length - 1 : next.line - 1
  const text = lines
    .slice(heading.line - firstLine + 1, endLine - firstLine + 1)
    .join('\n')
    .trim()
  if (text === '') return undefined
  return {
    text: text.slice(0, SECTION_TEXT_CAP),
    startLine: heading.line,
    endLine,
    truncated: text.length > SECTION_TEXT_CAP,
  }
}

/**
 * Index one learning: its title, `applies_when`, and the Guidance and
 * Prevention sections with their line bounds. What is missing and a
 * frontmatter parse error are reported, never hidden.
 */
export function extractRule(text: string, source: RuleSource): RuleEntry {
  const parsed = parseFrontmatter(text)
  const data: Record<string, unknown> = parsed.parseError ? {} : parsed.data
  const title = trimmedOrUndefined(data.title, MAX_TITLE_LENGTH)
  const appliesWhen =
    data.applies_when === undefined ? [] : readAppliesWhen(data.applies_when)

  const bodyOffset = parsed.hadFrontmatter
    ? text.split('\n').length - parsed.body.split('\n').length
    : 0
  const firstLine = bodyOffset + 1
  const lines = parsed.body.split('\n')
  const headings = findHeadings(lines, firstLine)
  const guidance = readSection(lines, headings, firstLine, 'guidance')
  const prevention = readSection(lines, headings, firstLine, 'prevention')

  const missing: RuleMissing[] = []
  if (appliesWhen.length === 0) missing.push('applies_when')
  if (guidance === undefined) missing.push('guidance')
  if (prevention === undefined) missing.push('prevention')

  return {
    id: ruleIdFor(source.project, source.path),
    project: source.project,
    path: source.path,
    sha256: source.sha256,
    ...(title === undefined ? {} : { title }),
    appliesWhen,
    ...(guidance === undefined ? {} : { guidance }),
    ...(prevention === undefined ? {} : { prevention }),
    missing,
    parseError: parsed.parseError,
  }
}

// ── Provenance ──────────────────────────────────────────────────────────────

export interface ProvenanceCite {
  /** The cited project's name, as `projectName` makes it. */
  readonly project: string
  readonly path: string
  readonly fingerprint: string
}

export interface ProvenanceIndexEntry {
  /** The main root of the project whose learning this is. */
  readonly project: string
  /** The learning's path in that project. */
  readonly path: string
  readonly cites: readonly ProvenanceCite[]
  readonly ruleIds: readonly string[]
}

const MAX_PROVENANCE_ITEMS = 200

const PROVENANCE_CITE =
  /(?<![\w./:@-])([A-Za-z0-9][\w.-]{0,99}):((?:[\w@+.-]+\/)*[\w@+.-]+)@([0-9a-f]{64})(?![0-9a-f])/g
const RULE_ID = /\brule-[0-9a-f]{16}\b/g

/** `<project>:<path>@<fingerprint>`: how a learning cites text from another project. */
export function formatProvenanceCitation(
  project: string,
  relPath: string,
  fingerprint: string,
): string {
  return `${project}:${relPath}@${fingerprint}`
}

/** The provenance citations and rule ids a learning's text carries. */
export function scanProvenance(text: string): {
  cites: ProvenanceCite[]
  ruleIds: string[]
} {
  const cites = new Map<string, ProvenanceCite>()
  for (const match of text.matchAll(PROVENANCE_CITE)) {
    const [, project, relPath, fingerprint] = match
    if (project === undefined || relPath === undefined) continue
    if (fingerprint === undefined) continue
    cites.set(`${project}\0${relPath}\0${fingerprint}`, {
      project,
      path: relPath,
      fingerprint,
    })
    if (cites.size >= MAX_PROVENANCE_ITEMS) break
  }
  const ruleIds = [...new Set(text.match(RULE_ID) ?? [])].slice(
    0,
    MAX_PROVENANCE_ITEMS,
  )
  return { cites: [...cites.values()], ruleIds }
}

// ── Batches ─────────────────────────────────────────────────────────────────

export const BATCH_VERSION = 1

const MAX_FAMILY_LENGTH = 120
const MAX_BATCH_RULE_IDS = 500
const MAX_BATCH_PROJECTS = 64
const MAX_BATCH_LIST = 50
const MAX_BATCH_ITEM_LENGTH = 300
const MAX_BATCH_CANDIDATES = 200

/** One rule family's report: what it covered and what it proposed. */
export interface Batch {
  readonly version: 1
  readonly runId: string
  readonly family: string
  readonly ruleIds: readonly string[]
  /** Main roots of the projects the family read. */
  readonly projects: readonly string[]
  readonly files: readonly string[]
  readonly searches: readonly string[]
  /** False when the family stopped before it covered its rules. */
  readonly complete: boolean
  readonly candidates: readonly unknown[]
}

export type BatchParse =
  | { readonly ok: true; readonly batch: Batch }
  | { readonly ok: false; readonly reason: 'malformed-batch' | 'batch-version' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CONTROL = /\p{Cc}|\p{Cf}/u

function stringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined
  const out: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.length > maxLength) return undefined
    if (CONTROL.test(item)) return undefined
    out.push(item)
  }
  return out
}

/** Parse one batch file. The run id must be the run's own. */
export function parseBatch(text: string, runId: string): BatchParse {
  const malformed = { ok: false, reason: 'malformed-batch' } as const
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return malformed
  }
  if (!isRecord(value)) return malformed
  if (value.version !== undefined && value.version !== BATCH_VERSION) {
    return typeof value.version === 'number'
      ? { ok: false, reason: 'batch-version' }
      : malformed
  }
  if (value.version !== BATCH_VERSION) return malformed
  if (value.runId !== runId) return malformed
  const { family, complete, candidates } = value
  if (
    typeof family !== 'string' ||
    family === '' ||
    family.length > MAX_FAMILY_LENGTH ||
    CONTROL.test(family)
  ) {
    return malformed
  }
  if (typeof complete !== 'boolean') return malformed
  if (!Array.isArray(candidates) || candidates.length > MAX_BATCH_CANDIDATES) {
    return malformed
  }
  const ruleIds = stringList(value.ruleIds, MAX_BATCH_RULE_IDS, 100)
  const projects = stringList(value.projects, MAX_BATCH_PROJECTS, 4096)
  const files = stringList(value.files, MAX_BATCH_LIST, MAX_BATCH_ITEM_LENGTH)
  const searches = stringList(
    value.searches,
    MAX_BATCH_LIST,
    MAX_BATCH_ITEM_LENGTH,
  )
  if (
    ruleIds === undefined ||
    projects === undefined ||
    files === undefined ||
    searches === undefined
  ) {
    return malformed
  }
  return {
    ok: true,
    batch: {
      version: BATCH_VERSION,
      runId,
      family,
      ruleIds,
      projects,
      files,
      searches,
      complete,
      candidates: candidates as unknown[],
    },
  }
}

// ── Coverage ────────────────────────────────────────────────────────────────

export interface Coverage {
  /** Indexed rules that no complete batch reported. */
  readonly uncoveredRuleIds: readonly string[]
  /** Allowed projects that no batch reported reading. */
  readonly untouchedProjects: readonly string[]
  /** Families that stopped before covering their rules. */
  readonly incompleteFamilies: readonly string[]
}

export interface CoverageInput {
  readonly ruleIds: readonly string[]
  readonly projects: readonly string[]
  readonly batches: readonly Batch[]
}

/**
 * Whether the batches cover what the index issued. A model that is told to
 * report nothing still has to name every rule id in a complete batch and every
 * project it read, so silence cannot pass for a clean scan. A run with no
 * rules has nothing to cover.
 */
export function checkCoverage(input: CoverageInput): Coverage {
  const incompleteFamilies = input.batches
    .filter((batch) => !batch.complete)
    .map((batch) => batch.family)
  if (input.ruleIds.length === 0) {
    return { uncoveredRuleIds: [], untouchedProjects: [], incompleteFamilies }
  }
  const covered = new Set(
    input.batches
      .filter((batch) => batch.complete)
      .flatMap((batch) => batch.ruleIds),
  )
  const touched = new Set(input.batches.flatMap((batch) => batch.projects))
  return {
    uncoveredRuleIds: input.ruleIds.filter((id) => !covered.has(id)),
    untouchedProjects: input.projects.filter((root) => !touched.has(root)),
    incompleteFamilies,
  }
}

// ── Rotation ────────────────────────────────────────────────────────────────

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/**
 * Rules from several projects, one project's rules per round: the first rule
 * of every project, then the second of every project, and so on. Projects are
 * in root order and rules in path order, so the result never depends on the
 * order the index was built in.
 */
function roundRobin(rules: readonly RuleEntry[]): RuleEntry[] {
  const byProject = new Map<string, RuleEntry[]>()
  for (const rule of rules) {
    const list = byProject.get(rule.project)
    if (list === undefined) byProject.set(rule.project, [rule])
    else list.push(rule)
  }
  const lists = [...byProject.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, list]) => list.sort((a, b) => compareText(a.path, b.path)))
  const out: RuleEntry[] = []
  for (let round = 0; out.length < rules.length; round++) {
    for (const list of lists) {
      const rule = list[round]
      if (rule !== undefined) out.push(rule)
    }
  }
  return out
}

export interface OfferInput {
  readonly rules: readonly RuleEntry[]
  readonly coverage: readonly CoverageRecord[]
  /** Rules one run is offered: families per run times rules per family. */
  readonly size: number
}

/** How a run was offered the index, and where the sweep stood when it began. */
export interface Offer {
  /** Every indexed rule id, in the order they are offered. */
  readonly order: readonly string[]
  /** The head of `order`: the rules this run covers. */
  readonly offered: readonly string[]
  /** Offered rules that were never covered, or changed since they were. */
  readonly fresh: readonly string[]
  readonly total: number
  /** Indexed rules covered at their current hash when the run began. */
  readonly coveredBefore: number
  readonly sliceSize: number
}

/**
 * Choose the rules a run covers. Every indexed rule is put in one order:
 * first the rules never covered or changed since they were covered, then the
 * covered rules from the least recently covered run to the most recent. Inside
 * each of those groups the order is round-robin across projects, then by path,
 * so a slice spans projects. The order depends on the index and the coverage
 * records only, never on the model, so repeated runs sweep the whole index
 * and then start over at the oldest.
 */
export function planOffer(input: OfferInput): Offer {
  const size = Math.max(1, Math.floor(input.size))
  const covered = new Map(input.coverage.map((item) => [item.ruleId, item]))
  const groups = new Map<string, RuleEntry[]>()
  let coveredBefore = 0
  for (const rule of input.rules) {
    const found = covered.get(rule.id)
    const record = found?.hash === rule.sha256 ? found : undefined
    if (record !== undefined) coveredBefore++
    // The empty key sorts before every time, so uncovered rules lead.
    const key = record === undefined ? '' : `${record.at}\u0000${record.runId}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [rule])
    else group.push(rule)
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .flatMap(([, rules]) => roundRobin(rules))
  const order = ordered.map((rule) => rule.id)
  const offered = order.slice(0, size)
  const never = new Set((groups.get('') ?? []).map((rule) => rule.id))
  return {
    order,
    offered,
    fresh: offered.filter((id) => never.has(id)),
    total: input.rules.length,
    coveredBefore,
    sliceSize: size,
  }
}

/** Where the sweep over the index stands. */
export interface SweepProgress {
  readonly total: number
  /** Rules covered at their current hash. */
  readonly covered: number
  readonly coveredThisRun: number
  /** Runs of the slice size still needed to cover every rule, about. */
  readonly runsLeft: number
}

function runsToCover(remaining: number, sliceSize: number): number {
  return Math.ceil(remaining / Math.max(1, sliceSize))
}

/** The sweep before a run covers anything. */
export function sweepBefore(
  offer: Pick<Offer, 'total' | 'coveredBefore' | 'sliceSize'>,
): SweepProgress {
  return {
    total: offer.total,
    covered: offer.coveredBefore,
    coveredThisRun: 0,
    runsLeft: runsToCover(offer.total - offer.coveredBefore, offer.sliceSize),
  }
}

/**
 * The sweep after a committed run. A covered rule that was already covered at
 * its current hash is covered this run but adds nothing to the total; an id
 * the run was not offered counts for neither.
 */
export function sweepProgress(
  offer: Pick<
    Offer,
    'offered' | 'fresh' | 'total' | 'coveredBefore' | 'sliceSize'
  >,
  coveredRuleIds: readonly string[],
): SweepProgress {
  const offered = new Set(offer.offered)
  const fresh = new Set(offer.fresh)
  const now = new Set(coveredRuleIds.filter((id) => offered.has(id)))
  let added = 0
  for (const id of now) if (fresh.has(id)) added++
  const covered = offer.coveredBefore + added
  return {
    total: offer.total,
    covered,
    coveredThisRun: now.size,
    runsLeft: runsToCover(offer.total - covered, offer.sliceSize),
  }
}

/** The one-line progress report of the digest header and the publish summary. */
export function renderSweepLine(progress: SweepProgress): string {
  if (progress.total === 0) return ''
  const head = `Sweep: covered ${progress.covered} of ${progress.total} rules (current hashes); this run covered ${progress.coveredThisRun};`
  if (progress.runsLeft === 0) {
    return `${head} the sweep is complete, and the next run starts again with the least recently covered rules.`
  }
  const runs = progress.runsLeft === 1 ? 'run' : 'runs'
  return `${head} about ${progress.runsLeft} ${runs} left in the sweep.`
}

// ── Candidates ──────────────────────────────────────────────────────────────

export const CANDIDATE_KINDS = ['contradiction', 'transferable-lesson'] as const
export type CandidateKind = (typeof CANDIDATE_KINDS)[number]

export const NEXT_STEPS = [
  'refresh-learning',
  'compound-learning',
  'investigate',
] as const
export type NextStep = (typeof NEXT_STEPS)[number]

/** Limits on a candidate's fields. */
export const CANDIDATE_LIMITS = Object.freeze({
  title: 160,
  summary: 800,
  note: 400,
  query: 200,
  queries: 8,
  excerptMin: 20,
  excerptMax: 1500,
  symbol: 200,
  sources: 8,
  targetEvidence: 8,
  counterevidence: 8,
  pathLength: 4096,
  spanLines: 400,
})

export interface ProjectFacts {
  /** The main root: the project's identity. */
  readonly root: string
  readonly name: string
  readonly key: string
  /** The files the run's inventory hashed. */
  readonly files: ReadonlyMap<
    string,
    { readonly sha256: string; readonly role: InventoryRole }
  >
}

export function toProjectFacts(
  root: string,
  files: readonly InventoryFile[],
): ProjectFacts {
  return {
    root,
    name: projectName(root),
    key: projectKey(root),
    files: new Map(
      files.map((file) => [
        file.path,
        { sha256: file.sha256, role: file.role },
      ]),
    ),
  }
}

export interface ValidationContext {
  readonly projects: ReadonlyMap<string, ProjectFacts>
  readonly ruleIds: ReadonlySet<string>
}

export interface ValidSource {
  readonly project: string
  readonly projectName: string
  readonly path: string
  readonly fingerprint: string
  readonly excerpt: string
  /** How a learning cites this text: `<project>:<path>@<fingerprint>`. */
  readonly cite: string
}

export interface ValidTargetEvidence {
  readonly path: string
  readonly start: number
  readonly end: number
  readonly symbol: string
  readonly fingerprint: string
  readonly excerpt: string
}

export interface OverlapCheck {
  readonly queries: readonly string[]
  readonly result: 'none-found' | 'found'
  readonly note?: string
}

export interface ValidCandidate {
  readonly kind: CandidateKind
  readonly ruleId: string
  /** The target project's main root. */
  readonly target: string
  readonly targetName: string
  readonly title: string
  readonly summary: string
  readonly nextStep: NextStep
  readonly overlapCheck: OverlapCheck
  readonly sources: readonly ValidSource[]
  readonly targetEvidence: readonly ValidTargetEvidence[]
  readonly counterevidence: readonly ValidSource[]
}

export type DropReason =
  | 'malformed-candidate'
  | 'unknown-kind'
  | 'unknown-rule-id'
  | 'rule-source-mismatch'
  | 'unknown-project'
  | 'absolute-path'
  | 'path-escape'
  | 'symlink-path'
  | 'untracked-path'
  | 'unsafe-path-character'
  | 'fingerprint-mismatch'
  | 'changed-since-begin'
  | 'excerpt-too-short'
  | 'excerpt-missing'
  | 'excerpt-lacks-symbol'
  | 'excerpt-outside-span'
  | 'citation-not-in-span'
  | 'citation-unchecked'
  | 'text-too-long'
  | 'invalid-text'
  | 'invalid-structure'
  | 'same-project-contradiction'
  | 'duplicate-candidate'
  | 'over-batch-cap'

export type CandidateCheck =
  | { readonly status: 'valid'; readonly candidate: ValidCandidate }
  | {
      readonly status: 'dropped'
      readonly reason: DropReason
      readonly detail?: string
    }
  /** A cited file is gone since the run began. The candidate is held back and the run degrades. */
  | { readonly status: 'unresolved'; readonly missing: readonly string[] }

type Drop = {
  readonly status: 'dropped'
  readonly reason: DropReason
  readonly detail?: string
}

type Unresolved = Extract<CandidateCheck, { status: 'unresolved' }>

/** Either way, checking stops at this candidate. */
type Halt = Drop | Unresolved

function isHalt(value: unknown): value is Halt {
  return (
    isRecord(value) &&
    (value.status === 'dropped' || value.status === 'unresolved')
  )
}

function drop(reason: DropReason, detail?: string): Drop {
  return {
    status: 'dropped',
    reason,
    ...(detail === undefined ? {} : { detail }),
  }
}

function isDrop(value: unknown): value is Drop {
  return isRecord(value) && value.status === 'dropped'
}

const PARAGRAPH_BREAK = /\n\s*\n/
const FINGERPRINT = /^[0-9a-f]{64}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const EXCERPT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]|\p{Cf}/u

/** A one-line field: a string within its cap with no control character. */
function lineField(value: unknown, max: number): string | Drop {
  if (typeof value !== 'string' || value.trim() === '') {
    return drop('malformed-candidate')
  }
  if (value.length > max) return drop('text-too-long')
  return CONTROL.test(value) ? drop('invalid-text') : value
}

/** A one-paragraph field: single line breaks only. */
function paragraphField(value: unknown, max: number): string | Drop {
  if (typeof value !== 'string' || value.trim() === '') {
    return drop('malformed-candidate')
  }
  if (value.length > max) return drop('text-too-long')
  if (PARAGRAPH_BREAK.test(value)) return drop('invalid-text')
  return CONTROL.test(value.replaceAll('\n', ' '))
    ? drop('invalid-text')
    : value
}

function parseOverlap(value: unknown): OverlapCheck | Drop {
  if (!isRecord(value)) return drop('malformed-candidate')
  const { queries, result, note } = value
  if (result !== 'none-found' && result !== 'found') {
    return drop('malformed-candidate')
  }
  if (!Array.isArray(queries)) return drop('malformed-candidate')
  if (queries.length > CANDIDATE_LIMITS.queries) return drop('text-too-long')
  const checked: string[] = []
  for (const query of queries as unknown[]) {
    const line = lineField(query, CANDIDATE_LIMITS.query)
    if (isDrop(line)) return line
    checked.push(line)
  }
  if (note === undefined) return { queries: checked, result }
  const text = paragraphField(note, CANDIDATE_LIMITS.note)
  if (isDrop(text)) return text
  return { queries: checked, result, note: text }
}

function pathProblem(rel: unknown): DropReason | undefined {
  if (typeof rel !== 'string' || rel === '') return 'malformed-candidate'
  if (rel.length > CANDIDATE_LIMITS.pathLength || CONTROL.test(rel)) {
    return 'malformed-candidate'
  }
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    return 'absolute-path'
  }
  if (rel.includes('\\')) return 'path-escape'
  if (UNSAFE_PATH_CHARACTER.test(rel)) return 'unsafe-path-character'
  const segments = rel.split('/')
  return segments.some((part) => part === '' || part === '.' || part === '..')
    ? 'path-escape'
    : undefined
}

function excerptProblem(excerpt: unknown): DropReason | undefined {
  if (typeof excerpt !== 'string') return 'malformed-candidate'
  if (excerpt.trim().length < CANDIDATE_LIMITS.excerptMin) {
    return 'excerpt-too-short'
  }
  if (excerpt.length > CANDIDATE_LIMITS.excerptMax) return 'text-too-long'
  return EXCERPT_CONTROL.test(excerpt) ? 'invalid-text' : undefined
}

/** A cited file as the researcher wrote it. Every field is checked before use. */
type FileRef = Readonly<Record<string, unknown>>

type Verified =
  | {
      readonly status: 'ok'
      readonly project: ProjectFacts
      readonly path: string
      readonly fingerprint: string
      readonly excerpt: string
      readonly role: InventoryRole
      readonly content: string
    }
  | Halt

/** Why a file the inventory does not list cannot be cited. The read only picks the reason. */
function unlistedReason(project: ProjectFacts, rel: string): Drop {
  const probe = readContainedFile(project.root, rel, { maxBytes: 1 })
  if (probe.kind === 'refused') {
    if (probe.reason === 'symlink') return drop('symlink-path')
    if (probe.reason === 'outside-root') return drop('path-escape')
  }
  return drop('untracked-path')
}

function fingerprintProblem(
  fingerprint: unknown,
  known: string,
): DropReason | undefined {
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) {
    return 'fingerprint-mismatch'
  }
  return fingerprint === known ? undefined : 'fingerprint-mismatch'
}

/** The file as it is now, which must still be the file that was hashed. */
function readCurrent(
  project: ProjectFacts,
  rel: string,
  sha256: string,
): string | Drop | Unresolved {
  const read = readContainedFile(project.root, rel)
  if (read.kind === 'refused') {
    if (read.reason === 'missing')
      return { status: 'unresolved', missing: [rel] }
    return drop(
      read.reason === 'symlink' ? 'symlink-path' : 'changed-since-begin',
    )
  }
  return read.sha256 === sha256
    ? read.bytes.toString('utf8')
    : drop('changed-since-begin')
}

/**
 * Check one cited file: the path, the fingerprint against the begin hash, the
 * file as it is now, and the excerpt against that file.
 */
function verifyFile(
  ctx: ValidationContext,
  projectRoot: unknown,
  ref: FileRef,
): Verified {
  if (typeof projectRoot !== 'string') return drop('malformed-candidate')
  const project = ctx.projects.get(projectRoot)
  if (project === undefined) return drop('unknown-project')

  const problem = pathProblem(ref.path)
  if (problem !== undefined) return drop(problem)
  const rel = ref.path as string

  const known = project.files.get(rel)
  if (known === undefined) return unlistedReason(project, rel)

  const fingerprint = fingerprintProblem(ref.fingerprint, known.sha256)
  if (fingerprint !== undefined) return drop(fingerprint)
  const excerptIssue = excerptProblem(ref.excerpt)
  if (excerptIssue !== undefined) return drop(excerptIssue)
  const excerpt = ref.excerpt as string

  const content = readCurrent(project, rel, known.sha256)
  if (typeof content !== 'string') return content
  if (!content.includes(excerpt)) return drop('excerpt-missing')
  return {
    status: 'ok',
    project,
    path: rel,
    fingerprint: known.sha256,
    excerpt,
    role: known.role,
    content,
  }
}

function listOf(value: unknown, max: number): unknown[] | Drop {
  if (value === undefined) return []
  if (!Array.isArray(value)) return drop('malformed-candidate')
  return value.length > max ? drop('invalid-structure') : (value as unknown[])
}

function lines(content: string): string[] {
  const out = content.split('\n')
  if (out.at(-1) === '') out.pop()
  return out
}

function isSpan(start: unknown, end: unknown): start is number {
  return (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    end >= start &&
    end - start < CANDIDATE_LIMITS.spanLines
  )
}

function validSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const symbol = value.trim().replace(/\(\)$/, '')
  if (symbol === '' || symbol.length > CANDIDATE_LIMITS.symbol) return undefined
  return /\s/.test(symbol) || CONTROL.test(symbol) ? undefined : symbol
}

function verifyTargetEvidence(
  ctx: ValidationContext,
  target: ProjectFacts,
  raw: unknown,
): ValidTargetEvidence | Halt {
  if (!isRecord(raw)) return drop('malformed-candidate')
  const verified = verifyFile(ctx, target.root, raw)
  if (verified.status !== 'ok') return verified
  const { start, end } = raw
  if (!isSpan(start, end)) return drop('malformed-candidate')
  const symbol = validSymbol(raw.symbol)
  if (symbol === undefined) return drop('malformed-candidate')
  // Held to the span the citation names, not just to the file.
  if (!containsIdentifier(verified.excerpt, symbol)) {
    return drop('excerpt-lacks-symbol')
  }
  const verdict = checkCitation(target.root, {
    path: verified.path,
    start,
    end: end as number,
    symbol,
  })
  if (verdict.verdict === 'not-in-span') {
    return drop(
      'citation-not-in-span',
      verdict.foundElsewhere ? 'found elsewhere' : 'absent from the file',
    )
  }
  if (verdict.verdict === 'unchecked') {
    return drop('citation-unchecked', verdict.reason)
  }
  const span = lines(verified.content)
    .slice(start - 1, end as number)
    .join('\n')
  if (!span.includes(verified.excerpt)) return drop('excerpt-outside-span')
  return {
    path: verified.path,
    start,
    end: end as number,
    symbol,
    fingerprint: verified.fingerprint,
    excerpt: verified.excerpt,
  }
}

function toValidSource(
  verified: Extract<Verified, { status: 'ok' }>,
): ValidSource {
  return {
    project: verified.project.root,
    projectName: verified.project.name,
    path: verified.path,
    fingerprint: verified.fingerprint,
    excerpt: verified.excerpt,
    cite: formatProvenanceCitation(
      verified.project.name,
      verified.path,
      verified.fingerprint,
    ),
  }
}

/**
 * A contradiction pairs the target's learning with another project's. Two
 * learnings of the target alone are that project's own business, not a
 * cross-project connection.
 */
function contradictionProblem(
  nextStep: NextStep,
  target: string,
  sourceCount: number,
  sourceProjects: ReadonlySet<string>,
): DropReason | undefined {
  if (sourceCount < 2 || !sourceProjects.has(target)) return 'invalid-structure'
  if (![...sourceProjects].some((project) => project !== target)) {
    return 'same-project-contradiction'
  }
  return nextStep === 'compound-learning' ? 'invalid-structure' : undefined
}

/** The shape rules that need no file: counts, project relations and the next step. */
function shapeProblem(
  kind: CandidateKind,
  nextStep: NextStep,
  target: string,
  sources: readonly unknown[],
  targetEvidenceCount: number,
): DropReason | undefined {
  if (sources.length < 1) return 'invalid-structure'
  const seen = new Set<string>()
  const sourceProjects = new Set<string>()
  for (const source of sources) {
    if (!isRecord(source)) return 'malformed-candidate'
    const key = `${String(source.project)}\0${String(source.path)}`
    if (seen.has(key)) return 'invalid-structure'
    seen.add(key)
    sourceProjects.add(String(source.project))
  }
  if (kind === 'contradiction') {
    return contradictionProblem(
      nextStep,
      target,
      sources.length,
      sourceProjects,
    )
  }
  if (sourceProjects.has(target) || targetEvidenceCount < 1) {
    return 'invalid-structure'
  }
  return nextStep === 'refresh-learning' ? 'invalid-structure' : undefined
}

function isKind(value: unknown): value is CandidateKind {
  return CANDIDATE_KINDS.some((kind) => kind === value)
}

function isNextStep(value: unknown): value is NextStep {
  return NEXT_STEPS.some((step) => step === value)
}

interface Header {
  readonly kind: CandidateKind
  readonly title: string
  readonly summary: string
  readonly overlapCheck: OverlapCheck
  readonly nextStep: NextStep
  readonly ruleId: string
  readonly target: ProjectFacts
}

/** The fields that need no file: kind, text, rule id and target. */
function parseHeader(
  raw: Record<string, unknown>,
  ctx: ValidationContext,
): Header | Drop {
  if (!isKind(raw.kind)) return drop('unknown-kind')
  const title = lineField(raw.title, CANDIDATE_LIMITS.title)
  if (isDrop(title)) return title
  const summary = paragraphField(raw.summary, CANDIDATE_LIMITS.summary)
  if (isDrop(summary)) return summary
  const overlapCheck = parseOverlap(raw.overlapCheck)
  if (isDrop(overlapCheck)) return overlapCheck
  if (!isNextStep(raw.nextStep) || typeof raw.ruleId !== 'string') {
    return drop('malformed-candidate')
  }
  if (!ctx.ruleIds.has(raw.ruleId)) return drop('unknown-rule-id')
  if (typeof raw.target !== 'string') return drop('malformed-candidate')
  const target = ctx.projects.get(raw.target)
  if (target === undefined) return drop('unknown-project')
  return {
    kind: raw.kind,
    title,
    summary,
    overlapCheck,
    nextStep: raw.nextStep,
    ruleId: raw.ruleId,
    target,
  }
}

function verifySource(
  ctx: ValidationContext,
  item: unknown,
  requireLearning: boolean,
): ValidSource | Halt {
  if (!isRecord(item)) return drop('malformed-candidate')
  const verified = verifyFile(ctx, item.project, item)
  if (verified.status !== 'ok') return verified
  if (requireLearning && verified.role !== 'learning') {
    return drop('invalid-structure')
  }
  return toValidSource(verified)
}

/** Verify every item in order; the first drop or vanished file stops the candidate. */
function verifyEach<T>(
  items: readonly unknown[],
  verify: (item: unknown) => T | Halt,
): T[] | Halt {
  const out: T[] = []
  for (const item of items) {
    const result = verify(item)
    if (isHalt(result)) return result
    out.push(result)
  }
  return out
}

/**
 * Check one candidate the researcher proposed. Fields the contract does not
 * name are never copied. The result is a validated candidate, a drop with its
 * reason, or `unresolved` when a cited file vanished after the run began.
 */
export function checkCandidate(
  raw: unknown,
  ctx: ValidationContext,
): CandidateCheck {
  if (!isRecord(raw)) return drop('malformed-candidate')
  const header = parseHeader(raw, ctx)
  if (isHalt(header)) return header

  const sources = listOf(raw.sources, CANDIDATE_LIMITS.sources)
  if (isDrop(sources)) return sources
  const evidence = listOf(raw.targetEvidence, CANDIDATE_LIMITS.targetEvidence)
  if (isDrop(evidence)) return evidence
  const counter = listOf(raw.counterevidence, CANDIDATE_LIMITS.counterevidence)
  if (isDrop(counter)) return counter

  const shape = shapeProblem(
    header.kind,
    header.nextStep,
    header.target.root,
    sources,
    evidence.length,
  )
  if (shape !== undefined) return drop(shape)

  const validSources = verifyEach(sources, (item) =>
    verifySource(ctx, item, true),
  )
  if (isHalt(validSources)) return validSources
  const bound = validSources.some(
    (source) => ruleIdFor(source.project, source.path) === header.ruleId,
  )
  if (!bound) return drop('rule-source-mismatch')

  const validEvidence = verifyEach(evidence, (item) =>
    verifyTargetEvidence(ctx, header.target, item),
  )
  if (isHalt(validEvidence)) return validEvidence
  const validCounter = verifyEach(counter, (item) =>
    verifySource(ctx, item, false),
  )
  if (isHalt(validCounter)) return validCounter

  return {
    status: 'valid',
    candidate: {
      kind: header.kind,
      ruleId: header.ruleId,
      target: header.target.root,
      targetName: header.target.name,
      title: header.title,
      summary: header.summary,
      nextStep: header.nextStep,
      overlapCheck: header.overlapCheck,
      sources: validSources,
      targetEvidence: validEvidence,
      counterevidence: validCounter,
    },
  }
}

/**
 * The record the ledger identifies a candidate by. A source's role carries the
 * project key, so the same relative path in two projects stays two sources.
 */
export function toCandidateRecord(candidate: ValidCandidate): CandidateRecord {
  return {
    kind: candidate.kind,
    target: candidate.target,
    ruleId: candidate.ruleId,
    sources: candidate.sources.map((source) => ({
      role: `source@${projectKey(source.project)}`,
      path: source.path,
      fingerprint: source.fingerprint,
    })),
    targetEvidence: candidate.targetEvidence.map((item) => ({
      path: item.path,
      fingerprint: item.fingerprint,
    })),
  }
}

const MAX_RENAME_MATCHES = 5

/**
 * Ledger entries for the same kind and target whose source text reappears under
 * another path. A rule id comes from the path, so a renamed learning is a new
 * identity and the old entry is only pointed at. A person decides; nothing is
 * matched or suppressed on this evidence.
 */
export function findRenamedEntries(
  ledger: Ledger,
  record: CandidateRecord,
  id: string,
): string[] {
  const matches: string[] = []
  for (const entry of ledger.entries) {
    if (entry.id === id) continue
    if (entry.kind !== record.kind || entry.target !== record.target) continue
    const moved = entry.sources.some((known) =>
      record.sources.some(
        (source) =>
          source.fingerprint === known.fingerprint &&
          source.path !== known.path,
      ),
    )
    if (moved) matches.push(entry.id)
    if (matches.length >= MAX_RENAME_MATCHES) break
  }
  return matches
}

/**
 * Whether the target already records the connection: one of its learnings
 * cites the same source path (by project name and path) or names the rule id.
 * The test is lexical and deterministic. Such a candidate is listed as already
 * recorded and is never proposed.
 */
export function findRecorded(
  candidate: ValidCandidate,
  index: readonly ProvenanceIndexEntry[],
): { readonly pointer: string } | undefined {
  const ownPaths = new Set(
    candidate.sources
      .filter((source) => source.project === candidate.target)
      .map((source) => source.path),
  )
  for (const entry of index) {
    if (entry.project !== candidate.target || ownPaths.has(entry.path)) continue
    const namesRule = entry.ruleIds.includes(candidate.ruleId)
    const citesSource = entry.cites.some((cite) =>
      candidate.sources.some(
        (source) =>
          source.projectName === cite.project && source.path === cite.path,
      ),
    )
    if (namesRule || citesSource) return { pointer: entry.path }
  }
  return undefined
}

// ── Digest ──────────────────────────────────────────────────────────────────

export type Standing = 'new' | 'sources changed' | 'target changed'

export interface DigestCandidate {
  readonly id: string
  readonly standing: Standing
  readonly refreshPointer?: string
  readonly possibleMatches: readonly string[]
  readonly candidate: ValidCandidate
}

export interface RecordedConnection {
  readonly pointer: string
  readonly candidate: ValidCandidate
}

export interface StaleCitation {
  readonly project: string
  readonly document: string
  readonly line: number
  readonly path: string
  readonly start: number
  readonly end: number
  readonly result: 'not-in-span' | 'unchecked'
  readonly foundElsewhere?: boolean
  readonly reason?: string
}

export interface DigestProject {
  readonly name: string
  readonly root: string
  readonly files: number
  /** No document holds a path-and-line citation, so none could be checked. */
  readonly citationsUnsupported: boolean
  /** A bound stopped the inventory. */
  readonly truncated: boolean
}

export interface DigestModel {
  readonly runId: string
  readonly outcome: 'complete' | 'degraded'
  readonly generatedAt: string
  readonly mode: 'interactive' | 'headless'
  readonly hostSupport: {
    readonly supported: boolean
    readonly host?: string
    readonly version?: string
    readonly consented?: boolean
  }
  readonly degradeReasons: readonly string[]
  /** Where the sweep over the rule index stands after this run. */
  readonly sweep?: SweepProgress
  readonly projects: readonly DigestProject[]
  readonly unmatched: ReadonlyArray<{
    readonly entry: string
    readonly reason: string
  }>
  readonly unread: readonly string[]
  readonly dropped: Readonly<Record<string, number>>
  readonly discardedIncomplete: number
  readonly candidates: readonly DigestCandidate[]
  readonly recorded: readonly RecordedConnection[]
  readonly suppressed: number
  readonly staleCitations: readonly StaleCitation[]
  readonly undecidedProvenance: ReadonlyArray<{
    readonly project: string
    readonly path: string
    readonly cites: number
  }>
}

/** Strip control and format characters. Line breaks stay; tabs become a space. */
export function sanitizeText(text: string): string {
  return text
    .replaceAll('\r', '')
    .replaceAll('\t', ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' ? '\n' : ''))
}

/** Render untrusted prose as a block quote, so it cannot become a heading or a list. */
function quote(text: string): string {
  return sanitizeText(text)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let current = 0
  for (const c of text) {
    current = c === char ? current + 1 : 0
    if (current > longest) longest = current
  }
  return longest
}

/** A fenced block whose fence is longer than any backtick run inside it. */
function fenced(text: string): string {
  const clean = sanitizeText(text)
  const fence = '`'.repeat(Math.max(3, longestRun(clean, '`') + 1))
  return `${fence}\n${clean}\n${fence}`
}

function inline(text: string): string {
  const clean = sanitizeText(text).replaceAll('\n', ' ')
  const fence = '`'.repeat(longestRun(clean, '`') + 1)
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${clean}${pad}${fence}`
}

function renderSourceBlock(
  heading: string,
  items: ReadonlyArray<{
    readonly projectName: string
    readonly path: string
    readonly fingerprint: string
    readonly excerpt: string
    readonly cite: string
  }>,
): string[] {
  if (items.length === 0) return []
  const out = [`${heading}`, '']
  for (const item of items) {
    out.push(
      `- ${inline(item.projectName)} ${inline(item.path)} fingerprint ${inline(item.fingerprint)}`,
      `  cite as ${inline(item.cite)}`,
      '',
      fenced(item.excerpt),
      '',
    )
  }
  return out
}

function renderCandidate(item: DigestCandidate, index: number): string[] {
  const { candidate } = item
  const out = [
    `### Candidate ${index + 1}: ${candidate.kind} (${item.standing})`,
    '',
    `- Id: ${inline(item.id)}`,
    `- Target: ${inline(candidate.targetName)} ${inline(candidate.target)}`,
    `- Rule: ${inline(candidate.ruleId)}`,
    `- Next step: ${candidate.nextStep}`,
    `- Status: candidate`,
  ]
  if (item.refreshPointer !== undefined) {
    out.push(`- Refresh pointer: ${inline(item.refreshPointer)}`)
  }
  if (item.possibleMatches.length > 0) {
    out.push(
      `- Possible earlier entries (the same text under another path; a person decides): ${item.possibleMatches.map(inline).join(', ')}`,
    )
  }
  out.push('', 'Title (untrusted text):', quote(candidate.title))
  out.push('', 'Summary (untrusted text):', quote(candidate.summary), '')
  out.push(...renderSourceBlock('Sources:', candidate.sources))
  if (candidate.targetEvidence.length > 0) {
    out.push('Target evidence:', '')
    for (const evidence of candidate.targetEvidence) {
      out.push(
        `- ${inline(`${evidence.path}:${evidence.start}-${evidence.end}`)} symbol ${inline(evidence.symbol)} fingerprint ${inline(evidence.fingerprint)}`,
        '',
        fenced(evidence.excerpt),
        '',
      )
    }
  }
  out.push(...renderSourceBlock('Counterevidence:', candidate.counterevidence))
  out.push(
    `Overlap check: ${candidate.overlapCheck.result}; searched ${candidate.overlapCheck.queries.length} quer${candidate.overlapCheck.queries.length === 1 ? 'y' : 'ies'}.`,
  )
  for (const query of candidate.overlapCheck.queries) {
    out.push(quote(query))
  }
  if (candidate.overlapCheck.note !== undefined) {
    out.push(quote(candidate.overlapCheck.note))
  }
  out.push('')
  return out
}

function hostLine(model: DigestModel): string {
  const host = model.hostSupport
  const name = inline(`${host.host ?? 'unknown'} ${host.version ?? ''}`.trim())
  if (host.supported) return `Host: ${name} (tool denies observed)`
  const agreed =
    host.consented === true ? '; the user agreed to run anyway' : ''
  return `Host: ${name} (tool denies NOT verified on this host${agreed})`
}

function droppedLines(model: DigestModel): string[] {
  const total = Object.values(model.dropped).reduce((a, b) => a + b, 0)
  const out = [`Dropped: ${total}`]
  for (const [reason, count] of Object.entries(model.dropped)) {
    out.push(`- ${reason}: ${count}`)
  }
  if (model.discardedIncomplete > 0) {
    out.push(
      `Candidates discarded because their family did not finish: ${model.discardedIncomplete}`,
    )
  }
  if (model.suppressed > 0) {
    out.push(`Suppressed as already decided or unchanged: ${model.suppressed}`)
  }
  return out
}

function projectLines(model: DigestModel): string[] {
  const out = ['', 'Projects:']
  for (const project of model.projects) {
    const flags = [
      ...(project.citationsUnsupported
        ? ['no path-and-line citations to check']
        : []),
      ...(project.truncated ? ['inventory reached a bound'] : []),
    ]
    const suffix = flags.length > 0 ? `; ${flags.join('; ')}` : ''
    out.push(
      `- ${inline(project.name)} ${inline(project.root)}: ${project.files} files${suffix}`,
    )
  }
  return out
}

/** A titled bullet list, or nothing when there are no items. */
function bulletSection(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ['', title, ...items.map((i) => `- ${i}`)]
}

function renderHeader(model: DigestModel): string[] {
  const out = [
    `# Connect digest ${inline(model.runId)}`,
    '',
    `Outcome: ${model.outcome}`,
    `Mode: ${model.mode}`,
    `Generated: ${model.generatedAt}`,
    hostLine(model),
  ]
  const sweep = model.sweep === undefined ? '' : renderSweepLine(model.sweep)
  if (sweep !== '') out.push(sweep)
  if (model.outcome === 'degraded') {
    out.push(
      `Degraded because: ${model.degradeReasons.join(', ')}. A degraded run is not proof of absence.`,
    )
  }
  out.push(...droppedLines(model), ...projectLines(model))
  out.push(
    ...bulletSection(
      'Allow-list entries that matched no project:',
      model.unmatched.map((item) => `${inline(item.entry)}: ${item.reason}`),
    ),
    ...bulletSection(
      'Not read or not covered:',
      model.unread.map((item) => sanitizeText(item).replaceAll('\n', ' ')),
    ),
    ...bulletSection(
      'Learnings that cite another project with no recorded decision:',
      model.undecidedProvenance.map(
        (item) =>
          `${inline(item.project)} ${inline(item.path)} (${item.cites} citation${item.cites === 1 ? '' : 's'})`,
      ),
    ),
  )
  out.push('')
  return out
}

const MAX_STALE_LISTED = 50

function renderStale(model: DigestModel): string[] {
  const out = ['## Stale citations', '']
  if (model.staleCitations.length === 0) {
    out.push(
      'No stale citation was found among the citations that could be checked.',
      '',
    )
    return out
  }
  for (const item of model.staleCitations.slice(0, MAX_STALE_LISTED)) {
    const where = `${inline(item.project)} ${inline(item.document)} line ${item.line}`
    const cited = inline(`${item.path}:${item.start}-${item.end}`)
    if (item.result === 'not-in-span') {
      out.push(
        `- ${where}: ${cited} no longer holds${item.foundElsewhere === true ? ' (the symbol is still in the file: found elsewhere)' : ' (the symbol is gone from the file)'}`,
      )
    } else {
      out.push(
        `- ${where}: ${cited} could not be checked (${sanitizeText(item.reason ?? 'unknown').replaceAll('\n', ' ')})`,
      )
    }
  }
  if (model.staleCitations.length > MAX_STALE_LISTED) {
    out.push(
      `- ${model.staleCitations.length - MAX_STALE_LISTED} more are in the run record.`,
    )
  }
  out.push('')
  return out
}

/**
 * Render the digest. All free text in it came from documents or from the
 * researcher, so it appears only as block quotes and fenced excerpts with
 * control characters removed. The digest is evidence for a person, and
 * nothing in it is an instruction.
 */
export function renderDigest(model: DigestModel): string {
  const out = renderHeader(model)
  out.push('## Candidates', '')
  if (model.candidates.length === 0 && model.recorded.length === 0) {
    out.push('Result: no candidate in searched scope.', '')
  } else if (model.candidates.length === 0) {
    out.push('No new candidate. See the connections already recorded.', '')
  }
  model.candidates.forEach((item, index) => {
    out.push(...renderCandidate(item, index))
  })
  out.push('## Connections already recorded', '')
  if (model.recorded.length === 0) {
    out.push('None.', '')
  }
  for (const item of model.recorded) {
    out.push(
      `- ${inline(item.candidate.targetName)} already records ${inline(item.candidate.ruleId)} in ${inline(item.pointer)}; counts in the precision denominator. To check it, run a scoped refresh of that learning.`,
      '',
      'Title (untrusted text):',
      quote(item.candidate.title),
      '',
    )
  }
  out.push(...renderStale(model))
  return `${out.join('\n').trimEnd()}\n`
}

const MAX_SUMMARY_TITLES = 10

/** A run record path that can be pasted as one `candidate:` token: no whitespace, no control character. */
function isPasteablePath(file: string): boolean {
  return !/\s/.test(file) && sanitizeText(file) === file
}

/** The quoted titles of a summary, each with its promotion tokens or a note when there is nothing to promote. */
function candidateLines(model: DigestModel, runRecordPath: string): string[] {
  const titles = model.candidates.slice(0, MAX_SUMMARY_TITLES)
  if (titles.length === 0) return []
  const pasteable = isPasteablePath(runRecordPath)
  const out = ['Candidates (untrusted text, quoted):']
  for (const item of titles) {
    out.push(quote(`${item.candidate.kind}: ${item.candidate.title}`))
    out.push(handoffLine(item, runRecordPath, pasteable))
  }
  const promotesLesson = titles.some(
    (item) =>
      item.candidate.kind === 'transferable-lesson' &&
      item.candidate.nextStep !== 'investigate',
  )
  if (!pasteable && promotesLesson) {
    out.push(
      `The run record path cannot be pasted as one word: ${sanitizeText(runRecordPath).replaceAll('\n', ' ')}`,
    )
  }
  const left = model.candidates.length - titles.length
  if (left > 0) out.push(`${left} more candidates are in the digest.`)
  return out
}

/** What `ce:compound-refresh` accepts as an exact path: a solutions document, plain characters only. */
const REFRESH_PATH = /^docs\/solutions\/[A-Za-z0-9._/-]+\.md$/

/**
 * The next step for one candidate, built from values the helper made and never
 * from candidate text. A lesson is promoted by `ce:compound` from its tokens. A
 * contradiction is promoted by `ce:compound-refresh` with the exact path of the
 * target's own learning, which `ce:compound` refuses. A candidate to
 * investigate has nothing to promote yet.
 */
function handoffLine(
  item: DigestModel['candidates'][number],
  runRecordPath: string,
  pasteable: boolean,
): string {
  const { candidate } = item
  if (candidate.nextStep === 'investigate') {
    // A token would invite a promotion the candidate's own next step rules out.
    return 'Investigate first: there is no promotion token for this candidate. See the digest for what to check.'
  }
  if (candidate.kind === 'contradiction') {
    const paths = [
      ...new Set(
        candidate.sources
          .filter((source) => source.project === candidate.target)
          .map((source) => source.path),
      ),
    ]
    if (paths.length === 0 || !paths.every((p) => REFRESH_PATH.test(p))) {
      return 'Review by hand: the target learning has a path that a refresh scope cannot take. See the digest.'
    }
    const scope = paths.map((p) => `path:${p}`).join(' ')
    return `Review in ${inline(candidate.targetName)}: /ce:compound-refresh ${scope}`
  }
  return pasteable
    ? `candidate:${runRecordPath} candidate-id:${item.id}`
    : `candidate-id:${item.id}`
}

/**
 * The short chat summary of a run. Candidate titles are untrusted text, so they
 * are quoted, one per line, and nothing in the summary reads as an instruction.
 * Under each title the helper prints the promotion tokens for that candidate:
 * `candidate:<run record path>` and `candidate-id:<id>` on one line, built from
 * values the helper made and never from candidate text. A contradiction gets
 * the `ce:compound-refresh` path scope of the target's learning instead, and a
 * candidate whose next step is `investigate` gets a plain note.
 */
export function renderSummary(
  model: DigestModel,
  digestPath: string,
  runRecordPath: string,
): string {
  const droppedTotal = Object.values(model.dropped).reduce((a, b) => a + b, 0)
  const out = [
    `Connect run ${sanitizeText(model.runId)}: ${model.outcome}.`,
    `Candidates: ${model.candidates.length}. Already recorded: ${model.recorded.length}. Dropped: ${droppedTotal}.`,
  ]
  const sweep = model.sweep === undefined ? '' : renderSweepLine(model.sweep)
  if (sweep !== '') out.push(sweep)
  if (model.outcome === 'degraded') {
    out.push(
      `Degraded because: ${model.degradeReasons.join(', ')}. This is not proof of absence.`,
    )
  }
  if (model.candidates.length === 0 && model.recorded.length === 0) {
    out.push('No candidate in searched scope.')
  }
  out.push(`Digest: ${sanitizeText(digestPath).replaceAll('\n', ' ')}`)
  out.push(...candidateLines(model, runRecordPath))
  return out.join('\n')
}

// ── Work directory ──────────────────────────────────────────────────────────

const WORK_DIR = 'work'
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const WORK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

export function isWorkName(name: string): boolean {
  return WORK_NAME.test(name)
}

/** `<state>/work/<runId>`: where one run keeps its snapshot and the researcher's batches. */
export function workDirPath(stateRoot: string, runId: string): string {
  return path.join(stateRoot, WORK_DIR, runId)
}

function ensurePrivateDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    if ((stat.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE)
    return true
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false
  }
  try {
    fs.mkdirSync(dir, { mode: DIR_MODE })
    fs.chmodSync(dir, DIR_MODE)
    return true
  } catch {
    return false
  }
}

/** Remove every work directory. The lock is held, so any that exist are leftovers. */
export function cleanWorkRoot(stateRoot: string): void {
  const work = path.join(stateRoot, WORK_DIR)
  try {
    const stat = fs.lstatSync(work)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.rmSync(work, { force: true })
      return
    }
    for (const name of fs.readdirSync(work)) {
      fs.rmSync(path.join(work, name), { recursive: true, force: true })
    }
  } catch {
    // Nothing to clean, or it cannot be cleaned; the next run tries again.
  }
}

/** Create `work/<runId>` at 0700. Returns the directory, or undefined when it cannot be made safely. */
export function prepareWorkDir(
  stateRoot: string,
  runId: string,
): string | undefined {
  if (!WORK_NAME.test(runId)) return undefined
  if (!ensurePrivateDirectory(path.join(stateRoot, WORK_DIR))) return undefined
  const dir = workDirPath(stateRoot, runId)
  try {
    fs.mkdirSync(dir, { mode: DIR_MODE })
    fs.chmodSync(dir, DIR_MODE)
    return dir
  } catch {
    return undefined
  }
}

export function removeWorkDir(stateRoot: string, runId: string): void {
  if (!WORK_NAME.test(runId)) return
  try {
    fs.rmSync(workDirPath(stateRoot, runId), { recursive: true, force: true })
  } catch {
    // The next run cleans leftovers.
  }
}

/** Write a work file at 0600 by temporary file and rename. Throws on failure. */
export function writeWorkFile(dir: string, name: string, data: string): void {
  if (!WORK_NAME.test(name)) throw new Error('invalid work file name')
  const target = path.join(dir, name)
  const temporary = `${target}.tmp-${randomUUID()}`
  const fd = fs.openSync(temporary, 'wx', FILE_MODE)
  try {
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(temporary, FILE_MODE)
    fs.renameSync(temporary, target)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

/** Read a work file through the bounded reader: a regular file only, never a symlink. */
export function readWorkFile(
  dir: string,
  name: string,
  maxBytes: number,
): ContainedRead {
  if (!WORK_NAME.test(name)) return { kind: 'refused', reason: 'outside-root' }
  return readContainedFile(dir, name, { maxBytes })
}

// ── Outcome ─────────────────────────────────────────────────────────────────

/** Bounds the helper enforces itself. */
export const BATCH_BOUNDS = Object.freeze({
  maxCandidatesPerBatch: CONNECT_BOUNDS.maxCandidatesPerBatch,
  maxRulesPerFamily: CONNECT_BOUNDS.maxRulesPerFamily,
  maxFamiliesPerRun: CONNECT_BOUNDS.maxFamiliesPerRun,
})
