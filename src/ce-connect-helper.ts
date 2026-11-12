import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyTicks,
  type CiOptions,
  type RenderRequest,
  readReportBody,
  renderReport,
} from './lib/connect-ci.js'
import {
  type AllowEntryMissReason,
  type ConnectConfigOptions,
  checkHostSupport,
  HOST_SUPPORT_TABLE,
  type HostSupportRow,
  loadConnectAllowList,
  resolveAllowEntry,
  resolveAllowList,
} from './lib/connect-config.js'
import {
  CONNECT_BOUNDS,
  type ConnectBounds,
  type InventoryFile,
  type InventoryRole,
  inventoryProject,
  readContainedFile,
  reportProjectCitations,
  UNSAFE_PATH_CHARACTER,
} from './lib/connect-evidence.js'
import {
  BATCH_VERSION,
  type Batch,
  type Coverage,
  checkCandidate,
  checkCoverage,
  cleanWorkRoot,
  type DigestCandidate,
  type DigestModel,
  type DigestProject,
  type DroppedCandidate,
  extractRule,
  findRecorded,
  findRenamedEntries,
  isWorkName,
  nameDropped,
  type Offer,
  type ProjectFacts,
  type ProvenanceIndexEntry,
  parseBatch,
  planOffer,
  prepareWorkDir,
  projectKey,
  projectName,
  type RecordedConnection,
  type RuleEntry,
  readWorkFile,
  removeWorkDir,
  renderDigest,
  renderSummary,
  resolveSelection,
  resolveStateRoot,
  ruleIdFor,
  type Selection,
  type SelectionProject,
  type StaleCitation,
  type Standing,
  type SweepProgress,
  scanProvenance,
  selectionNamespace,
  sweepBefore,
  sweepProgress,
  toCandidateRecord,
  toProjectFacts,
  type ValidationContext,
  type ValidCandidate,
  workDirPath,
  writeWorkFile,
} from './lib/connect-helper-core.js'
import {
  type ImportAccepted,
  type ImportedCandidate,
  type ImportModel,
  type ImportProvenance,
  type ImportRefusal,
  type LocalCheckout,
  readImportRecord,
  renderImportDigest,
  renderImportSummary,
  type SkippedCandidate,
  type Verification,
  verifyRecord,
} from './lib/connect-import.js'
import { readRepoIdentity } from './lib/connect-repo-identity.js'
import {
  acquireLock,
  type CandidateRecord,
  type CandidateStanding,
  type CoverageRecord,
  candidateIdentity,
  classifyCandidate,
  clearLedger,
  type DecideInput,
  decideLedgerEntry,
  forceUnlock,
  type ImportInsertResult,
  type ImportPlan,
  type InvocationProject,
  type InvocationWriteOptions,
  insertImportRun,
  type Ledger,
  type LedgerEntry,
  type LockHandle,
  type LockReclaim,
  newImportRunId,
  newRunId,
  type ProcessTable,
  type PublishOptions,
  prepareStateRoot,
  pruneRuns,
  publishRun,
  readCiRunMarker,
  readInvocationRecord,
  readLedger,
  readRunRecord,
  releaseLock,
  rewriteRunFiles,
  writeInvocationRecord,
} from './lib/connect-state.js'
import { isMainModule } from './lib/main-module.js'

/**
 * Entry point for the generated, self-contained `ce:connect` helper
 * (`skills/ce-connect/scripts/connect.mjs`).
 *
 * The helper owns a run from the lock to its release. The skill dispatches the
 * researcher between two helper calls: `begin` takes the lock and indexes the
 * allowed projects, `validate` checks the researcher's batch files against that
 * index, and `publish` writes the digest, the run record and the ledger and
 * releases the lock. Each call is a separate short process, so the lock holder
 * is a long-lived ancestor of the helper, not the helper itself.
 *
 * Every operation reads one JSON request on stdin, never prompts, and answers
 * one line of JSON. The researcher's batch never travels on stdin: it is a
 * file the skill writes in the run's work directory, read here through the
 * bounded reader as a regular file.
 */

export const CE_CONNECT_USAGE =
  'Usage: node connect.mjs <begin|validate|publish|decide|import|apply-ticks|render-report|ledger show [--offset N]|ledger clear|ledger unlock>'

// ── Types ───────────────────────────────────────────────────────────────────

export interface HelperDeps {
  /** Environment for `XDG_STATE_HOME`. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  /** Where the allow list is read from. */
  readonly config?: ConnectConfigOptions
  readonly now?: () => number
  readonly processes?: ProcessTable
  /** The pid recorded as the lock holder. Defaults to the nearest non-shell ancestor. */
  readonly holderPid?: number
  readonly hostTable?: readonly HostSupportRow[]
  readonly gitBinary?: string
  readonly bounds?: Partial<ConnectBounds>
  readonly inspector?: ProcessInspector
  /** Seams in the middle of a publish, for tests of a crash or a failed write. */
  readonly publishHooks?: NonNullable<PublishOptions['hooks']>
  /** Seams in the write of the invocation record, for tests of a failed write. */
  readonly invocationHooks?: InvocationWriteOptions
}

export interface HelperResult {
  readonly ok: boolean
  readonly body: Record<string, unknown>
}

type Json = Record<string, unknown>

const OPS = [
  'begin',
  'validate',
  'publish',
  'decide',
  'import',
  'apply-ticks',
  'render-report',
  'ledger-show',
  'ledger-clear',
  'ledger-unlock',
] as const
type Op = (typeof OPS)[number]

function isOp(value: string): value is Op {
  return (OPS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failure(op: string, reason: string, extra: Json = {}): HelperResult {
  return {
    ok: false,
    body: { ok: false, op, outcome: 'failed', reason, ...extra },
  }
}

function success(op: string, body: Json): HelperResult {
  return { ok: true, body: { ok: true, op, ...body } }
}

// ── The lock holder ─────────────────────────────────────────────────────────

/** What the helper needs to know about its ancestors. A seam for tests. */
export interface ProcessInspector {
  parentOf(pid: number): number | undefined
  commandOf(pid: number): string | undefined
}

const PS_TIMEOUT_MS = 5000
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'ash',
])
const MAX_ANCESTOR_DEPTH = 8

function psField(pid: number, field: 'ppid' | 'comm'): string | undefined {
  try {
    const probe = spawnSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { LC_ALL: 'C', LANG: 'C' },
    })
    if (probe.status !== 0) return undefined
    const value = probe.stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function procStat(pid: number): string[] | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return close < 0
      ? undefined
      : stat
          .slice(close + 1)
          .trim()
          .split(/\s+/)
  } catch {
    return undefined
  }
}

/** Parents and command names from `/proc` on Linux and `ps` on macOS. */
export const systemProcessInspector: ProcessInspector = {
  parentOf(pid) {
    const raw =
      process.platform === 'linux' ? procStat(pid)?.[1] : psField(pid, 'ppid')
    const parent = raw === undefined ? NaN : Number(raw)
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined
  },
  commandOf(pid) {
    if (process.platform === 'linux') {
      try {
        return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined
      } catch {
        return undefined
      }
    }
    return psField(pid, 'comm')
  },
}

export interface HolderChoice {
  readonly pid: number
  readonly basis: 'configured' | 'ancestor' | 'parent'
}

function isShell(command: string): boolean {
  return SHELLS.has(path.basename(command).replace(/^-/, ''))
}

/**
 * The process that stands for a run: the nearest ancestor that is not a shell.
 * The helper exits after each call, and the shell that launched it exits right
 * after, so neither could hold a lock across the researcher's turns. The host
 * (or the terminal) outlives the run. If the host dies, the lock is reclaimed;
 * if it lives on after a crashed run, `ledger unlock` clears the lock.
 */
export function findHolderPid(
  inspector: ProcessInspector,
  from: number = process.pid,
): HolderChoice {
  let pid = inspector.parentOf(from)
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (pid === undefined || pid <= 1) break
    const command = inspector.commandOf(pid)
    if (command !== undefined && !isShell(command)) {
      return { pid, basis: 'ancestor' }
    }
    pid = inspector.parentOf(pid)
  }
  return { pid: process.ppid > 0 ? process.ppid : process.pid, basis: 'parent' }
}

function chooseHolder(deps: HelperDeps): HolderChoice {
  if (deps.holderPid !== undefined) {
    return { pid: deps.holderPid, basis: 'configured' }
  }
  return findHolderPid(deps.inspector ?? systemProcessInspector)
}

// ── Environment ─────────────────────────────────────────────────────────────

interface Environment {
  readonly homeDir: string
  readonly stateRoot: string
  readonly allowedRoots: readonly string[]
  readonly resolved: ReturnType<typeof resolveAllowList>
  /** The merged `connect.groups` of the user config. */
  readonly groups: Readonly<Record<string, readonly string[]>>
  readonly warnings: readonly string[]
  readonly configUnreadable: boolean
}

function bounds(deps: HelperDeps): ConnectBounds {
  return { ...CONNECT_BOUNDS, ...deps.bounds }
}

function describeEnvironment(deps: HelperDeps): Environment {
  const homeDir = deps.homeDir ?? os.homedir()
  const load = loadConnectAllowList(deps.config)
  const resolved = resolveAllowList(load.allowProjects, { homeDir })
  return {
    homeDir,
    stateRoot: resolveStateRoot(deps.env ?? process.env, homeDir),
    allowedRoots: resolved.resolved.map((item) => item.mainRoot),
    resolved,
    groups: load.groups,
    warnings: load.warnings,
    configUnreadable: load.unreadable,
  }
}

type Prepared =
  | {
      readonly ok: true
      readonly root: string
      readonly environment: Environment
    }
  | { readonly ok: false; readonly result: HelperResult }

function prepare(op: string, deps: HelperDeps): Prepared {
  const environment = describeEnvironment(deps)
  const state = prepareStateRoot(environment.stateRoot, {
    allowedRoots: environment.allowedRoots,
  })
  if (state.status === 'refused') {
    return {
      ok: false,
      result: failure(op, 'state-root-refused', { detail: state.reason }),
    }
  }
  return { ok: true, root: state.root, environment }
}

// ── Request parsing ─────────────────────────────────────────────────────────

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_TEXT = 200
const MAX_BATCH_PATHS = 64
const MAX_BATCH_BYTES = 1024 * 1024
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_STATE_BYTES = 16 * 1024 * 1024
const RESERVED_WORK_FILES = new Set([
  'begin.json',
  'rules.json',
  'files.tsv',
  'rules.tsv',
  'validated.json',
])

const CONTROL_IN_PATH = /\p{Cc}|\p{Cf}/u
const CONTROL_RUN = /[\p{Cc}\p{Cf}]+/gu

function oneCell(text: string): string {
  return text.replace(CONTROL_RUN, ' ').trim()
}

/**
 * One tab-separated line per rule: id, project name, path, title, the
 * `applies_when` items and whether this run is offered the rule (`offered`) or
 * leaves it to a later run (`later`). The offered rules come first, in the
 * order they were offered. The skill groups the offered rules into families
 * from this, so it never has to read every rule's sections.
 */
function rulesOverview(rules: readonly RuleEntry[], offer: Offer): string {
  const byId = new Map(rules.map((rule) => [rule.id, rule]))
  const offered = new Set(offer.offered)
  const lines: string[] = []
  for (const id of offer.order) {
    const rule = byId.get(id)
    if (rule === undefined) continue
    lines.push(
      [
        rule.id,
        projectName(rule.project),
        rule.path,
        oneCell(rule.title ?? ''),
        oneCell(rule.appliesWhen.map(oneCell).join(' | ')),
        offered.has(id) ? 'offered' : 'later',
      ].join('\t'),
    )
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * One tab-separated line per inventoried file: fingerprint, role, project root,
 * path. The researcher has read and search tools only, and a read tool cuts a
 * line at about 2000 characters, so it looks a fingerprint up here instead of
 * in the one-line snapshot. A path with a control character cannot be cited,
 * so it has no line (and cannot break the format).
 */
function fingerprintIndex(projects: readonly SnapshotProject[]): string {
  const lines: string[] = []
  for (const project of projects) {
    for (const file of project.inventory) {
      if (CONTROL_IN_PATH.test(file.path)) continue
      lines.push([file.sha256, file.role, project.root, file.path].join('\t'))
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

function parseLock(value: unknown): { nonce: string; pid: number } | undefined {
  if (!isRecord(value)) return undefined
  const { nonce, pid } = value
  if (typeof nonce !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(nonce)) {
    return undefined
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined
  }
  return { nonce, pid }
}

function parseRunRequest(request: unknown):
  | {
      readonly runId: string
      readonly lock: { nonce: string; pid: number }
      readonly record: Record<string, unknown>
    }
  | undefined {
  if (!isRecord(request)) return undefined
  const { runId } = request
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return undefined
  if (runId.endsWith('.tmp')) return undefined
  const lock = parseLock(request.lock)
  return lock === undefined ? undefined : { runId, lock, record: request }
}

// ── The run snapshot ────────────────────────────────────────────────────────

interface SnapshotProject extends DigestProject {
  readonly key: string
  readonly entry: string
  /** `owner/repo` of the GitHub `origin` remote, when the checkout has one. */
  readonly repo?: string
  /** The commit HEAD names, when it can be read. */
  readonly commit?: string
  /** Citations the check examined. */
  readonly citationsChecked: number
  /** The citation cap stopped the check. Reported, and not a reason to degrade. */
  readonly citationsTruncated: boolean
  readonly inventory: ReadonlyArray<{
    readonly path: string
    readonly role: InventoryRole
    readonly sha256: string
  }>
}

interface HostRecord {
  readonly supported: boolean
  readonly host: string
  readonly version?: string
  readonly consented?: boolean
}

/** Which projects a run read in full, and the rules it left alone on purpose. */
interface CoverageScope {
  /** Keys of the projects whose inventory was read in full. */
  readonly prunable: readonly string[]
  /** Rules whose file was skipped or changed during the scan. */
  readonly retain: readonly string[]
  /** False when any project was not read in full. */
  readonly pruneUnattributed: boolean
}

interface Snapshot {
  readonly version: 1
  readonly runId: string
  readonly createdAt: string
  readonly mode: 'interactive' | 'headless'
  readonly host: HostRecord
  readonly lock: { readonly nonce: string; readonly pid: number }
  readonly holder: HolderChoice
  readonly reclaimed?: LockReclaim
  readonly pruned: {
    readonly runs: number
    readonly staging: number
    readonly failed: number
  }
  readonly projects: readonly SnapshotProject[]
  readonly unmatched: ReadonlyArray<{ entry: string; reason: string }>
  readonly degradeReasons: readonly string[]
  readonly unread: readonly string[]
  /** Every indexed rule id. A candidate may cite any of them. */
  readonly ruleIds: readonly string[]
  /** The hash of each indexed rule's learning, kept as coverage when a run commits. */
  readonly ruleVersions: ReadonlyArray<{
    id: string
    sha256: string
    /** The key of the rule's project. */
    project?: string
  }>
  /** What the run was narrowed to. */
  readonly selection?: Selection
  /** What the run could not see in full, so its coverage is not pruned there. */
  readonly coverageScope?: CoverageScope
  /** What the run was offered, and where the sweep stood when it began. */
  readonly offer: Pick<
    Offer,
    'offered' | 'fresh' | 'total' | 'coveredBefore' | 'sliceSize'
  >
  readonly provenance: readonly ProvenanceIndexEntry[]
  readonly undecidedProvenance: ReadonlyArray<{
    project: string
    path: string
    cites: number
  }>
  readonly staleCitations: readonly StaleCitation[]
}

function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.runId === 'string' &&
    isRecord(value.lock) &&
    typeof value.lock.nonce === 'string' &&
    Array.isArray(value.projects) &&
    Array.isArray(value.ruleIds) &&
    Array.isArray(value.ruleVersions) &&
    isRecord(value.offer) &&
    Array.isArray(value.offer.offered) &&
    Array.isArray(value.offer.fresh) &&
    Array.isArray(value.provenance) &&
    Array.isArray(value.degradeReasons) &&
    Array.isArray(value.unread)
  )
}

interface AcceptedCandidate {
  readonly id: string
  readonly standing: Standing
  readonly refreshPointer?: string
  readonly possibleMatches: readonly string[]
  readonly candidate: ValidCandidate
}

interface BatchSummary {
  readonly family: string
  readonly complete: boolean
  readonly ruleIds: number
  readonly files: readonly string[]
  readonly searches: readonly string[]
}

interface ValidatedState {
  readonly version: 1
  readonly runId: string
  readonly degradeReasons: readonly string[]
  readonly unread: readonly string[]
  readonly dropped: Readonly<Record<string, number>>
  readonly droppedCandidates: readonly DroppedCandidate[]
  readonly discardedIncomplete: number
  readonly suppressed: number
  readonly unresolved: number
  readonly coverage: Coverage
  /** Offered rules that a complete family covered. */
  readonly coveredRuleIds: readonly string[]
  /** Offered rules a complete family named but whose evidence changed or vanished during the run. */
  readonly heldBackRuleIds: readonly string[]
  readonly sweep: SweepProgress
  readonly accepted: readonly AcceptedCandidate[]
  readonly recorded: readonly RecordedConnection[]
  readonly batches: readonly BatchSummary[]
}

function isValidated(value: unknown): value is ValidatedState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.runId === 'string' &&
    Array.isArray(value.accepted) &&
    Array.isArray(value.recorded) &&
    Array.isArray(value.droppedCandidates) &&
    Array.isArray(value.coveredRuleIds) &&
    isRecord(value.sweep) &&
    Array.isArray(value.degradeReasons)
  )
}

function readJsonFile<T>(
  dir: string,
  name: string,
  maxBytes: number,
  guard: (value: unknown) => value is T,
): T | undefined {
  const read = readWorkFile(dir, name, maxBytes)
  if (read.kind !== 'bytes') return undefined
  try {
    const parsed: unknown = JSON.parse(read.bytes.toString('utf8'))
    return guard(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

// ── The invocation record ───────────────────────────────────────────────────

/**
 * A CI run is a run whose workflow wrote `ci-run.json` into the state root. Its
 * marker tags `invocation.json`, which the helper writes on every path from
 * `begin` onward, so the workflow reads the outcome from one file that names
 * this run and not from whatever else the state root holds. A local run has no
 * such file and writes no record.
 */
function ciRunMarker(deps: HelperDeps): string | undefined {
  return readCiRunMarker(
    resolveStateRoot(deps.env ?? process.env, deps.homeDir ?? os.homedir()),
  )
}

function invocationProjects(
  projects: readonly SnapshotProject[],
): InvocationProject[] {
  return projects.map((project) => ({
    key: project.key,
    name: project.name,
    ...(project.repo === undefined ? {} : { repo: project.repo }),
    ...(project.commit === undefined ? {} : { commit: project.commit }),
  }))
}

interface InvocationEnd {
  readonly outcome: 'complete' | 'degraded' | 'busy' | 'failed'
  readonly reason?: string
  readonly runId?: string
  readonly projects?: readonly InvocationProject[]
}

/** The projects the begun record of this run named, for a record that ends a run without its snapshot. */
function beganWith(
  root: string,
  marker: string,
  runId: string | undefined,
): readonly InvocationProject[] | undefined {
  if (runId === undefined) return undefined
  const began = readInvocationRecord(root)
  return began?.marker === marker && began.runId === runId
    ? began.projects
    : undefined
}

function writeTerminal(
  root: string,
  marker: string,
  end: InvocationEnd,
  deps: HelperDeps,
): 'written' | 'unwritten' {
  const projects = end.projects ?? beganWith(root, marker, end.runId)
  const result = writeInvocationRecord(
    root,
    {
      version: 1,
      marker,
      phase: 'terminal',
      outcome: end.outcome,
      finalLine: `Connect ${end.outcome}`,
      ...(end.reason === undefined ? {} : { reason: end.reason }),
      ...(end.runId === undefined ? {} : { runId: end.runId }),
      ...(projects === undefined ? {} : { projects }),
    },
    deps.invocationHooks,
  )
  return result === 'written' ? 'written' : 'unwritten'
}

/**
 * End a CI invocation that stopped before or without a publish. The state root
 * is prepared under its usual refusal rules; no lock is taken and nothing but
 * the record is written. A record that cannot be written is said so in the
 * answer, and the workflow then reads the missing or `begun` record as a run
 * with no final line.
 */
function endInvocation(
  marker: string,
  result: HelperResult,
  end: InvocationEnd,
  deps: HelperDeps,
): HelperResult {
  const prepared = prepare('invocation', deps)
  const written = prepared.ok
    ? writeTerminal(prepared.root, marker, end, deps)
    : 'unwritten'
  return written === 'written'
    ? result
    : { ok: result.ok, body: { ...result.body, invocationRecord: 'unwritten' } }
}

/** The record for a failure answer: busy is its own outcome, and every other stop is failed. */
function endOfFailure(result: HelperResult, runId?: string): InvocationEnd {
  const { outcome, reason } = result.body
  return {
    outcome: outcome === 'busy' ? 'busy' : 'failed',
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(runId === undefined ? {} : { runId }),
  }
}

/** The run id a request names, when it is a plain run id. */
function requestRunId(request: unknown): string | undefined {
  if (!isRecord(request)) return undefined
  const { runId } = request
  return typeof runId === 'string' &&
    RUN_ID.test(runId) &&
    !runId.endsWith('.tmp')
    ? runId
    : undefined
}

// ── begin ───────────────────────────────────────────────────────────────────

interface BeginRequest {
  readonly host: string
  readonly version: string | undefined
  readonly mode: 'interactive' | 'headless'
  readonly consent: boolean
  /** The `group:` and `projects:` words the skill collected, unparsed. */
  readonly selection: readonly string[]
}

function parseSelectionWords(value: unknown): readonly string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const words: string[] = []
  for (const word of value as unknown[]) {
    if (typeof word !== 'string') return undefined
    words.push(word)
  }
  return words
}

function parseBeginRequest(request: unknown): BeginRequest | undefined {
  if (!isRecord(request)) return undefined
  const { host, version, mode, consent } = request
  const selection = parseSelectionWords(request.selection)
  if (selection === undefined) return undefined
  if (typeof host !== 'string' || host === '' || host.length > MAX_TEXT) {
    return undefined
  }
  if (
    version !== undefined &&
    (typeof version !== 'string' || version.length > MAX_TEXT)
  ) {
    return undefined
  }
  if (mode !== 'interactive' && mode !== 'headless') return undefined
  if (consent !== undefined && typeof consent !== 'boolean') return undefined
  return { host, version, mode, consent: consent === true, selection }
}

const CORPUS_PREFIXES = ['docs/solutions/', 'docs/plans/', 'docs/brainstorms/']
const MAX_STALE_RECORDED = 200

interface ScannedProject {
  /** Whether every file of the project was either read or named as skipped, so a rule absent from it is gone. */
  readonly prunable: boolean
  /** Rules of learnings that were skipped or changed during the scan. */
  readonly retain: string[]
  readonly digest: SnapshotProject
  readonly rules: RuleEntry[]
  readonly provenance: ProvenanceIndexEntry[]
  readonly stale: StaleCitation[]
  readonly degrade: string[]
  readonly unread: string[]
}

type InventoryOk = Extract<
  ReturnType<typeof inventoryProject>,
  { status: 'ok' }
>

interface Corpus {
  readonly documents: Array<{ path: string; text: string }>
  readonly rules: RuleEntry[]
  readonly provenance: ProvenanceIndexEntry[]
  /** Documents that could not be read, or changed since they were hashed. */
  readonly changed: number
  /** Their paths. */
  readonly heldPaths: string[]
}

function isCorpusRole(role: InventoryRole): boolean {
  return role === 'learning' || role === 'plan' || role === 'brainstorm'
}

/** Read the corpus documents once: rules and provenance from learnings, text for the citation check. */
function readCorpus(inventory: InventoryOk, limits: ConnectBounds): Corpus {
  const corpus: Corpus = {
    documents: [],
    rules: [],
    provenance: [],
    changed: 0,
    heldPaths: [],
  }
  let changed = 0
  for (const file of inventory.files.filter((f) => isCorpusRole(f.role))) {
    const read = readContainedFile(inventory.mainRoot, file.path, {
      maxBytes: limits.maxFileBytes,
    })
    if (read.kind === 'refused' || read.sha256 !== file.sha256) {
      changed++
      corpus.heldPaths.push(file.path)
      continue
    }
    const text = read.bytes.toString('utf8')
    corpus.documents.push({ path: file.path, text })
    if (file.role !== 'learning') continue
    const source = {
      project: inventory.mainRoot,
      path: file.path,
      sha256: file.sha256,
    }
    corpus.rules.push(extractRule(text, source))
    const found = scanProvenance(text)
    if (found.cites.length > 0 || found.ruleIds.length > 0) {
      corpus.provenance.push({
        project: inventory.mainRoot,
        path: file.path,
        cites: found.cites,
        ruleIds: found.ruleIds,
      })
    }
  }
  return { ...corpus, changed }
}

/** The citations that no longer hold. A citation naming no symbol cannot be judged and is not listed. */
function staleCitationsOf(
  name: string,
  report: ReturnType<typeof reportProjectCitations>,
): StaleCitation[] {
  const stale: StaleCitation[] = []
  for (const item of report.citations) {
    const { result } = item
    if (result.verdict === 'passed') continue
    if (result.verdict === 'unchecked' && result.reason === 'no-symbol') {
      continue
    }
    if (stale.length >= MAX_STALE_RECORDED) break
    stale.push({
      project: name,
      document: item.document,
      line: item.line,
      path: item.citation.path,
      start: item.citation.start,
      end: item.citation.end,
      result: result.verdict,
      ...(result.verdict === 'not-in-span'
        ? { foundElsewhere: result.foundElsewhere }
        : { reason: result.reason }),
    })
  }
  return stale
}

function hasCorpusSkips(inventory: InventoryOk): boolean {
  return (
    inventory.skipped.some((file) =>
      CORPUS_PREFIXES.some((prefix) => file.path.startsWith(prefix)),
    ) || inventory.skippedCount > inventory.skipped.length
  )
}

/** Which bounds and gaps make this project's scan incomplete. */
function scanGaps(
  name: string,
  inventory: InventoryOk,
  report: ReturnType<typeof reportProjectCitations>,
  changed: number,
): { degrade: string[]; unread: string[] } {
  const degrade: string[] = []
  const unread: string[] = []
  if (inventory.truncated.files || inventory.truncated.hashCap) {
    degrade.push('inventory-truncated')
    unread.push(
      `${name}: the file inventory reached a bound; files past it were not read`,
    )
  }
  // Reported, not degrading: the cap only limits the stale-citation check, so
  // it leaves no rule unread. A project with more citations than the cap
  // reaches it on every run, and a degraded outcome there says nothing.
  if (report.truncated) {
    unread.push(
      `${name}: the citation check reached its cap (${report.citations.length} checked, the rest not)`,
    )
  }
  const unsafe = inventory.skipped.filter(
    (file) => file.reason === 'unsafe-path-character',
  ).length
  if (unsafe > 0) {
    unread.push(
      `${name}: ${unsafe} file(s) skipped: a path with a quote, a dollar sign or a backtick cannot be cited`,
    )
  }
  const corpusSkipped = hasCorpusSkips(inventory)
  if (corpusSkipped || changed > 0) {
    degrade.push('corpus-files-skipped')
    unread.push(
      `${name}: some documents could not be read or changed during the scan`,
    )
  }
  return { degrade, unread }
}

function scanProject(
  entry: string,
  root: string,
  deps: HelperDeps,
  limits: ConnectBounds,
): ScannedProject | { readonly failed: string } {
  // The promotion step quotes a project root in a shell word, so a root with
  // such a character cannot be cited from.
  if (UNSAFE_PATH_CHARACTER.test(root))
    return { failed: 'unsafe-path-character' }
  const inventory = inventoryProject(root, {
    bounds: limits,
    ...(deps.gitBinary === undefined ? {} : { gitBinary: deps.gitBinary }),
  })
  if (inventory.status !== 'ok') {
    return {
      failed:
        inventory.status === 'unmatched'
          ? `unmatched:${inventory.reason}`
          : inventory.reason,
    }
  }
  const name = projectName(inventory.mainRoot)
  const corpus = readCorpus(inventory, limits)
  const report = reportProjectCitations(inventory.mainRoot, corpus.documents, {
    bounds: limits,
    maxBytes: limits.maxFileBytes,
  })
  const gaps = scanGaps(name, inventory, report, corpus.changed)
  const held = [
    ...inventory.skipped.map((file) => file.path),
    ...corpus.heldPaths,
  ].filter((rel) => CORPUS_PREFIXES.some((prefix) => rel.startsWith(prefix)))

  return {
    // A truncated inventory, or skipped files that are not all named, leave
    // rules unseen that the run cannot account for. Then nothing is pruned.
    prunable:
      !(inventory.truncated.files || inventory.truncated.hashCap) &&
      inventory.skippedCount <= inventory.skipped.length,
    retain: held.map((rel) => ruleIdFor(inventory.mainRoot, rel)),
    digest: {
      name,
      root: inventory.mainRoot,
      key: projectKey(inventory.mainRoot),
      entry,
      ...readRepoIdentity(inventory.mainRoot),
      files: inventory.files.length,
      citationsUnsupported: report.unsupported,
      citationsChecked: report.citations.length,
      citationsTruncated: report.truncated,
      truncated: inventory.truncated.files || inventory.truncated.hashCap,
      inventory: inventory.files.map((file: InventoryFile) => ({
        path: file.path,
        role: file.role,
        sha256: file.sha256,
      })),
    },
    rules: corpus.rules,
    provenance: corpus.provenance,
    stale: staleCitationsOf(name, report),
    degrade: gaps.degrade,
    unread: gaps.unread,
  }
}

function undecidedMarkers(
  index: readonly ProvenanceIndexEntry[],
  ledger: Ledger,
): Array<{ project: string; path: string; cites: number }> {
  const out: Array<{ project: string; path: string; cites: number }> = []
  for (const item of index) {
    const undecided = item.cites.filter(
      (cite) =>
        !ledger.entries.some(
          (entry) =>
            entry.target === item.project &&
            entry.status !== 'candidate' &&
            entry.sources.some(
              (source) =>
                source.path === cite.path &&
                source.fingerprint === cite.fingerprint,
            ),
        ),
    )
    if (undecided.length > 0) {
      out.push({
        project: item.project,
        path: item.path,
        cites: undecided.length,
      })
    }
  }
  return out
}

function releaseAndFail(
  op: string,
  lock: LockHandle,
  root: string,
  runId: string | undefined,
  reason: string,
  extra: Json = {},
): HelperResult {
  const released = releaseLock(lock)
  if (runId !== undefined) removeWorkDir(root, runId)
  return failure(op, reason, {
    ...extra,
    lockReleased: released === 'released',
  })
}

function hostPhrase(host: string, version: string | undefined): string {
  return version === undefined ? host : `${host} ${version}`
}

/** Whether the host may run at all: a refusal or a consent request, else the verdict. */
function gateHost(
  parsed: BeginRequest,
  deps: HelperDeps,
): HelperResult | ReturnType<typeof checkHostSupport> {
  const verdict = checkHostSupport(
    parsed.host,
    parsed.version,
    deps.hostTable ?? HOST_SUPPORT_TABLE,
  )
  if (verdict.supported) return verdict
  if (parsed.mode === 'headless') {
    return failure('begin', 'unsupported-host', {
      host: parsed.host,
      version: parsed.version ?? null,
      hostSupport: verdict.reason,
    })
  }
  if (parsed.consent) return verdict
  return {
    ok: false,
    body: {
      ok: false,
      op: 'begin',
      outcome: 'consent-required',
      host: parsed.host,
      version: parsed.version ?? null,
      hostSupport: verdict.reason,
      warning: `The tool limits for ${hostPhrase(parsed.host, parsed.version)} have not been verified, so the guarantee that the researcher cannot write or run commands cannot be given. Run only if the user agrees.`,
    },
  }
}

function isResult(
  value: HelperResult | ReturnType<typeof checkHostSupport>,
): value is HelperResult {
  return 'body' in value
}

interface Scans {
  readonly scans: ScannedProject[]
  readonly degradeReasons: string[]
  readonly unread: string[]
  readonly coverageScope: CoverageScope
}

/**
 * Scan every selected project. One that cannot be read degrades the run. A run
 * with a selection never prunes a coverage record it cannot attribute to a
 * project, whether or not its members are the whole allow list.
 */
function scanAll(
  environment: Environment,
  selection: Selection,
  projects: readonly SelectionProject[],
  deps: HelperDeps,
  limits: ConnectBounds,
  unmatched: ReadonlyArray<{ entry: string; reason: string }>,
): Scans {
  const degradeReasons: string[] = []
  const unread: string[] = []
  if (unmatched.length > 0) addUnique(degradeReasons, 'unmatched-entry')
  if (environment.configUnreadable) {
    addUnique(degradeReasons, 'config-unreadable')
    unread.push('some allow-list files could not be read and were ignored')
  }
  const scans: ScannedProject[] = []
  let allRead = unmatched.length === 0 && !environment.configUnreadable
  for (const item of projects) {
    const scanned = scanProject(item.entry, item.mainRoot, deps, limits)
    if ('failed' in scanned) {
      allRead = false
      addUnique(degradeReasons, 'project-unreadable')
      unread.push(`${projectName(item.mainRoot)}: not read (${scanned.failed})`)
      continue
    }
    for (const reason of scanned.degrade) addUnique(degradeReasons, reason)
    unread.push(...scanned.unread)
    scans.push(scanned)
  }
  const coverageScope: CoverageScope = {
    prunable: scans
      .filter((scan) => scan.prunable)
      .map((scan) => scan.digest.key),
    retain: scans.flatMap((scan) => scan.retain),
    pruneUnattributed:
      selection.kind === 'all' &&
      allRead &&
      scans.every((scan) => scan.prunable),
  }
  return { scans, degradeReasons, unread, coverageScope }
}

/** `{ selection }` for a run with a selection, so its coverage is kept apart. */
function selectionOf(selection: Selection): { selection?: string } {
  const id = selectionNamespace(selection)
  return id === undefined ? {} : { selection: id }
}

interface RunSetup {
  readonly parsed: BeginRequest
  readonly verdict: ReturnType<typeof checkHostSupport>
  readonly environment: Environment
  readonly selection: Selection
  /** The projects the run reads: the selection, or the whole resolved allow list. */
  readonly projects: readonly SelectionProject[]
  /** Allow-list entries that matched no project. Empty for a run with a selection. */
  readonly unmatched: ReadonlyArray<{ entry: string; reason: string }>
  readonly root: string
  readonly now: () => number
  readonly holder: HolderChoice
  readonly lock: LockHandle
  readonly reclaimed: LockReclaim | undefined
  /** The marker of the CI run, when the workflow wrote one. */
  readonly ciMarker: string | undefined
}

function prunedCounts(
  pruned: ReturnType<typeof pruneRuns>,
): Snapshot['pruned'] {
  return pruned.status === 'pruned'
    ? {
        runs: pruned.removedRuns.length,
        staging: pruned.removedStaging.length,
        failed: pruned.failed.length,
      }
    : { runs: 0, staging: 0, failed: 0 }
}

function beginResponse(
  setup: RunSetup,
  snapshot: Snapshot,
  scans: readonly ScannedProject[],
  workDir: string,
  limits: ConnectBounds,
): HelperResult {
  return success('begin', {
    status: 'begun',
    runId: snapshot.runId,
    stateRoot: setup.root,
    workDir,
    rulesFile: path.join(workDir, 'rules.json'),
    filesIndex: path.join(workDir, 'files.tsv'),
    rulesOverview: path.join(workDir, 'rules.tsv'),
    offeredRuleIds: snapshot.offer.offered,
    offeredCount: snapshot.offer.offered.length,
    sweep: {
      total: snapshot.offer.total,
      covered: snapshot.offer.coveredBefore,
      sliceSize: snapshot.offer.sliceSize,
      runsLeft: sweepBefore(snapshot.offer).runsLeft,
    },
    lock: snapshot.lock,
    holder: setup.holder,
    ...(setup.reclaimed === undefined ? {} : { reclaimed: setup.reclaimed }),
    host: snapshot.host,
    mode: setup.parsed.mode,
    selection: setup.selection,
    projects: scans.map((scan) => ({
      root: scan.digest.root,
      name: scan.digest.name,
      key: scan.digest.key,
      files: scan.digest.files,
      rules: scan.rules.length,
      citationsUnsupported: scan.digest.citationsUnsupported,
      citationsChecked: scan.digest.citationsChecked,
      citationsTruncated: scan.digest.citationsTruncated,
      truncated: scan.digest.truncated,
    })),
    unmatched: setup.unmatched,
    ruleCount: snapshot.ruleIds.length,
    undecidedProvenance: snapshot.undecidedProvenance,
    degradeReasons: snapshot.degradeReasons,
    unread: snapshot.unread,
    configWarnings: setup.environment.warnings,
    pruned: snapshot.pruned,
    bounds: {
      maxRulesPerFamily: limits.maxRulesPerFamily,
      maxCandidatesPerBatch: limits.maxCandidatesPerBatch,
      maxFamiliesPerRun: limits.maxFamiliesPerRun,
    },
    batchVersion: BATCH_VERSION,
  })
}

/** The part of `begin` that runs under the lock. */
function indexRun(setup: RunSetup, deps: HelperDeps): HelperResult {
  const { root, lock, now } = setup
  const ledger = readLedger(root)
  if (ledger.status !== 'ok') {
    return releaseAndFail('begin', lock, root, undefined, 'ledger-unreadable')
  }
  const pruned = pruneRuns(root, lock, { now })
  cleanWorkRoot(root)

  const limits = bounds(deps)
  const { scans, degradeReasons, unread, coverageScope } = scanAll(
    setup.environment,
    setup.selection,
    setup.projects,
    deps,
    limits,
    setup.unmatched,
  )
  if (scans.length === 0) {
    return releaseAndFail('begin', lock, root, undefined, 'no-trustworthy-scan')
  }

  const runId = newRunId(now())
  const workDir = prepareWorkDir(root, runId)
  if (workDir === undefined) {
    return releaseAndFail('begin', lock, root, runId, 'work-dir-failed')
  }
  try {
    const rules = scans.flatMap((scan) => scan.rules)
    const provenance = scans.flatMap((scan) => scan.provenance)
    const offer = planOffer({
      rules,
      coverage: ledger.ledger.coverage ?? [],
      size: limits.maxFamiliesPerRun * limits.maxRulesPerFamily,
      ...selectionOf(setup.selection),
    })
    const { parsed, verdict } = setup
    const snapshot: Snapshot = {
      version: 1,
      runId,
      createdAt: new Date(now()).toISOString(),
      mode: parsed.mode,
      host: {
        supported: verdict.supported,
        host: parsed.host,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        ...(verdict.supported ? {} : { consented: true }),
      },
      lock: { nonce: lock.nonce, pid: lock.pid },
      holder: setup.holder,
      ...(setup.reclaimed === undefined ? {} : { reclaimed: setup.reclaimed }),
      pruned: prunedCounts(pruned),
      projects: scans.map((scan) => scan.digest),
      unmatched: setup.unmatched,
      degradeReasons,
      unread,
      selection: setup.selection,
      ruleIds: rules.map((rule) => rule.id),
      ruleVersions: rules.map((rule) => ({
        id: rule.id,
        sha256: rule.sha256,
        project: projectKey(rule.project),
      })),
      coverageScope,
      offer: {
        offered: offer.offered,
        fresh: offer.fresh,
        total: offer.total,
        coveredBefore: offer.coveredBefore,
        sliceSize: offer.sliceSize,
      },
      provenance,
      undecidedProvenance: undecidedMarkers(provenance, ledger.ledger),
      staleCitations: scans.flatMap((scan) => scan.stale),
    }
    writeWorkFile(workDir, 'begin.json', JSON.stringify(snapshot))
    writeWorkFile(
      workDir,
      'rules.json',
      JSON.stringify({ version: 1, runId, rules }, null, 1),
    )
    writeWorkFile(workDir, 'files.tsv', fingerprintIndex(snapshot.projects))
    writeWorkFile(workDir, 'rules.tsv', rulesOverview(rules, offer))
    if (setup.ciMarker !== undefined) {
      const recorded = writeInvocationRecord(
        root,
        {
          version: 1,
          marker: setup.ciMarker,
          phase: 'begun',
          runId,
          projects: invocationProjects(snapshot.projects),
        },
        deps.invocationHooks,
      )
      if (recorded === 'failed') {
        return releaseAndFail(
          'begin',
          lock,
          root,
          runId,
          'invocation-write-failed',
        )
      }
    }
    return beginResponse(setup, snapshot, scans, workDir, limits)
  } catch {
    return releaseAndFail('begin', lock, root, runId, 'internal-error')
  }
}

/**
 * Narrow the allow list to what the request selected, or refuse. A refusal
 * names its reason and what it concerns. Nothing is locked or written yet.
 */
function selectProjects(
  words: readonly string[],
  environment: Environment,
):
  | {
      readonly ok: true
      readonly selection: Selection
      readonly projects: readonly SelectionProject[]
    }
  | { readonly ok: false; readonly result: HelperResult } {
  const resolution = resolveSelection({
    words,
    groups: environment.groups,
    allowed: environment.resolved.resolved,
    resolveMember: (entry) =>
      resolveAllowEntry(entry, { homeDir: environment.homeDir }),
  })
  if (resolution.status === 'invalid') {
    return { ok: false, result: failure('begin', 'invalid-request') }
  }
  if (resolution.status === 'refused') {
    const { reason, ...detail } = resolution.refusal
    return { ok: false, result: failure('begin', reason, detail) }
  }
  return {
    ok: true,
    selection: resolution.selection,
    projects: resolution.projects,
  }
}

function begin(request: unknown, deps: HelperDeps): HelperResult {
  const ciMarker = ciRunMarker(deps)
  const result = beginRun(request, deps, ciMarker)
  // A consent request is a question, not an end: the same call comes again.
  if (
    ciMarker === undefined ||
    result.ok ||
    result.body.outcome === 'consent-required'
  ) {
    return result
  }
  return endInvocation(ciMarker, result, endOfFailure(result), deps)
}

function beginRun(
  request: unknown,
  deps: HelperDeps,
  ciMarker: string | undefined,
): HelperResult {
  const parsed = parseBeginRequest(request)
  if (parsed === undefined) return failure('begin', 'invalid-request')

  const environment = describeEnvironment(deps)
  // A bad selection is refused before the host gate, so a user is never asked
  // for consent to a run that cannot start.
  const chosen = selectProjects(parsed.selection, environment)
  if (!chosen.ok) return chosen.result
  const verdict = gateHost(parsed, deps)
  if (isResult(verdict)) return verdict

  const { selection, projects } = chosen
  // An allow-list entry the selection does not name is not touched, so one
  // that matches nothing does not degrade a narrowed run.
  const unmatched =
    selection.kind === 'all'
      ? environment.resolved.unmatched.map((item) => ({
          entry: item.entry,
          reason: item.reason as AllowEntryMissReason,
        }))
      : []
  if (projects.length === 0) {
    return failure('begin', 'no-allowed-projects', {
      unmatched,
      configWarnings: environment.warnings,
    })
  }
  const state = prepareStateRoot(environment.stateRoot, {
    allowedRoots: environment.allowedRoots,
  })
  if (state.status === 'refused') {
    return failure('begin', 'state-root-refused', { detail: state.reason })
  }
  const now = deps.now ?? Date.now
  const holder = chooseHolder(deps)
  const acquired = acquireLock(state.root, {
    pid: holder.pid,
    ...(deps.processes === undefined ? {} : { processes: deps.processes }),
    now,
  })
  if (acquired.status === 'busy') {
    return {
      ok: false,
      body: {
        ok: false,
        op: 'begin',
        outcome: 'busy',
        reason: acquired.reason,
        hint: 'Another run holds the lock. If no run is active, `ledger unlock` clears it.',
      },
    }
  }
  if (acquired.status === 'failed') {
    return failure('begin', 'lock-failed', { detail: acquired.reason })
  }
  const setup: RunSetup = {
    parsed,
    verdict,
    environment,
    selection,
    projects,
    unmatched,
    root: state.root,
    now,
    holder,
    lock: acquired.lock,
    reclaimed: acquired.reclaimed,
    ciMarker,
  }
  try {
    return indexRun(setup, deps)
  } catch {
    return releaseAndFail(
      'begin',
      acquired.lock,
      state.root,
      undefined,
      'internal-error',
    )
  }
}

// ── validate ────────────────────────────────────────────────────────────────

function batchReadFailure(reason: string): string {
  return `batch-${reason}`
}

type BatchRead =
  | { readonly ok: true; readonly batches: Batch[] }
  | { readonly ok: false; readonly reason: string }

function readBatches(
  workDir: string,
  runId: string,
  requested: readonly string[],
): BatchRead {
  const batches: Batch[] = []
  for (const given of requested) {
    let name: string
    if (path.isAbsolute(given)) {
      if (path.dirname(path.resolve(given)) !== workDir) {
        return { ok: false, reason: 'batch-outside-work-dir' }
      }
      name = path.basename(given)
    } else {
      name = given
    }
    if (!isWorkName(name) || name !== path.basename(name)) {
      return { ok: false, reason: 'batch-outside-work-dir' }
    }
    if (RESERVED_WORK_FILES.has(name)) {
      return { ok: false, reason: 'batch-outside-work-dir' }
    }
    const read = readWorkFile(workDir, name, MAX_BATCH_BYTES)
    if (read.kind === 'refused') {
      return { ok: false, reason: batchReadFailure(read.reason) }
    }
    const parsed = parseBatch(read.bytes.toString('utf8'), runId)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    batches.push(parsed.batch)
  }
  return { ok: true, batches }
}

function parseValidateRequest(request: unknown):
  | {
      readonly runId: string
      readonly lock: { nonce: string; pid: number }
      readonly batches: string[]
    }
  | undefined {
  const base = parseRunRequest(request)
  if (base === undefined) return undefined
  const { batches } = base.record
  if (!Array.isArray(batches) || batches.length > MAX_BATCH_PATHS) {
    return undefined
  }
  if (
    !(batches as unknown[]).every(
      (item) => typeof item === 'string' && item !== '' && item.length <= 4096,
    )
  ) {
    return undefined
  }
  return { runId: base.runId, lock: base.lock, batches: batches as string[] }
}

function contextFrom(snapshot: Snapshot): ValidationContext {
  const projects = new Map<string, ProjectFacts>()
  for (const project of snapshot.projects) {
    projects.set(
      project.root,
      toProjectFacts(
        project.root,
        project.inventory.map((file) => ({
          path: file.path,
          role: file.role,
          bytes: 0,
          sha256: file.sha256,
        })),
      ),
    )
  }
  return { projects, ruleIds: new Set(snapshot.ruleIds) }
}

interface Classified {
  readonly accepted: AcceptedCandidate[]
  readonly recorded: RecordedConnection[]
  readonly dropped: Record<string, number>
  /** Each dropped candidate by name, up to `droppedListLimit`; `dropped` holds the full counts. */
  readonly droppedCandidates: DroppedCandidate[]
  readonly droppedListLimit: number
  suppressed: number
  unresolved: number
  discardedIncomplete: number
  readonly degrade: string[]
  /** Rules whose candidate was lost to evidence that changed or vanished during the run. */
  readonly heldBackRuleIds: Set<string>
}

function count(table: Record<string, number>, key: string, by = 1): void {
  table[key] = (table[key] ?? 0) + by
}

/** Count a dropped candidate by reason and name it, while the list has room. */
function recordDrop(
  result: Classified,
  family: string,
  raw: unknown,
  reason: string,
): void {
  count(result.dropped, reason)
  noteDropped(result, family, raw, reason)
}

function noteDropped(
  result: Classified,
  family: string,
  raw: unknown,
  reason: string,
): void {
  if (result.droppedCandidates.length >= result.droppedListLimit) return
  result.droppedCandidates.push(nameDropped(family, raw, reason))
}

function standingOf(
  outcome: CandidateStanding,
):
  | { standing: Standing; refreshPointer?: string; possible: string[] }
  | 'skip' {
  if (outcome.standing === 'new') {
    return { standing: 'new', possible: [...outcome.possibleMatches] }
  }
  if (outcome.standing === 'reopened') {
    return {
      standing: outcome.reason,
      possible: [],
      ...(outcome.refreshPointer === undefined
        ? {}
        : { refreshPointer: outcome.refreshPointer }),
    }
  }
  return 'skip'
}

/** What the ledger says about a candidate that is not a duplicate or already recorded. */
function classifyAgainstLedger(
  candidate: ValidCandidate,
  record: CandidateRecord,
  ledger: Ledger,
  result: Classified,
): void {
  const outcome = classifyCandidate(ledger, record)
  const standing = standingOf(outcome)
  if (standing === 'skip') {
    if (outcome.standing === 'unresolved') result.unresolved++
    else result.suppressed++
    return
  }
  const possibleMatches =
    standing.standing === 'new'
      ? [
          ...new Set([
            ...standing.possible,
            ...findRenamedEntries(ledger, record, outcome.id),
          ]),
        ]
      : standing.possible
  result.accepted.push({
    id: outcome.id,
    standing: standing.standing,
    ...(standing.refreshPointer === undefined
      ? {}
      : { refreshPointer: standing.refreshPointer }),
    possibleMatches,
    candidate,
  })
}

interface ClassifyInput {
  readonly ctx: ValidationContext
  readonly snapshot: Snapshot
  readonly ledger: Ledger
}

function reopensForChangedSources(
  record: CandidateRecord,
  input: ClassifyInput,
): boolean {
  const outcome = classifyCandidate(input.ledger, record)
  return outcome.standing === 'reopened' && outcome.reason === 'sources changed'
}

/** Keep the rule of a candidate that could not be checked out of the covered set. */
function holdBack(
  raw: unknown,
  input: ClassifyInput,
  result: Classified,
): void {
  const ruleId = isRecord(raw) ? raw.ruleId : undefined
  if (typeof ruleId === 'string' && input.ctx.ruleIds.has(ruleId)) {
    result.heldBackRuleIds.add(ruleId)
  }
}

function classifyOne(
  raw: unknown,
  family: string,
  input: ClassifyInput,
  seen: Set<string>,
  result: Classified,
): void {
  const check = checkCandidate(raw, input.ctx)
  if (check.status === 'dropped') {
    recordDrop(result, family, raw, check.reason)
    // Unlike a plain rejection, this says nothing about the candidate: the
    // evidence moved under the run, so the rule was not really examined.
    if (check.reason === 'changed-since-begin') {
      addUnique(result.degrade, 'evidence-changed')
      holdBack(raw, input, result)
    }
    return
  }
  if (check.status === 'unresolved') {
    result.unresolved++
    holdBack(raw, input, result)
    return
  }
  const record = toCandidateRecord(check.candidate)
  const identity = candidateIdentity(record)
  if (seen.has(identity)) {
    recordDrop(result, family, raw, 'duplicate-candidate')
    return
  }
  seen.add(identity)
  // A promoted learning cites its source by project and path, so it still
  // matches after the source changed. A changed source reopens the connection
  // for refresh (with the pointer to the promoted learning) and is not recorded.
  const recorded = findRecorded(check.candidate, input.snapshot.provenance)
  if (recorded !== undefined && !reopensForChangedSources(record, input)) {
    result.recorded.push({
      pointer: recorded.pointer,
      candidate: check.candidate,
    })
    return
  }
  classifyAgainstLedger(check.candidate, record, input.ledger, result)
}

function classifyBatches(
  batches: readonly Batch[],
  input: ClassifyInput,
  limits: ConnectBounds,
): Classified {
  const result: Classified = {
    accepted: [],
    recorded: [],
    dropped: {},
    droppedCandidates: [],
    droppedListLimit: limits.maxFamiliesPerRun * limits.maxCandidatesPerBatch,
    suppressed: 0,
    unresolved: 0,
    discardedIncomplete: 0,
    degrade: [],
    heldBackRuleIds: new Set(),
  }
  const seen = new Set<string>()
  const overflow: Array<{ family: string; raw: unknown }> = []
  for (const batch of batches) {
    if (batch.ruleIds.length > limits.maxRulesPerFamily) {
      addUnique(result.degrade, 'family-bound')
    }
    if (!batch.complete) {
      result.discardedIncomplete += batch.candidates.length
      continue
    }
    const considered = batch.candidates.slice(0, limits.maxCandidatesPerBatch)
    const over = batch.candidates.length - considered.length
    if (over > 0) {
      count(result.dropped, 'over-batch-cap', over)
      addUnique(result.degrade, 'candidate-bound')
    }
    for (const raw of considered) {
      classifyOne(raw, batch.family, input, seen, result)
    }
    for (const raw of batch.candidates.slice(considered.length)) {
      overflow.push({ family: batch.family, raw })
    }
  }
  // Named after every batch's checked candidates, so the overflow of one
  // oversized batch cannot crowd out a rejection that was actually checked.
  for (const item of overflow) {
    noteDropped(result, item.family, item.raw, 'over-batch-cap')
  }
  return result
}

const MAX_UNREAD_LINES = 50

function coverageLines(
  coverage: Coverage,
  snapshot: Snapshot,
  classified: Classified,
): string[] {
  const lines: string[] = []
  for (const id of coverage.uncoveredRuleIds.slice(0, MAX_UNREAD_LINES)) {
    lines.push(`rule ${id} was not covered by a complete family`)
  }
  if (coverage.uncoveredRuleIds.length > MAX_UNREAD_LINES) {
    lines.push(
      `${coverage.uncoveredRuleIds.length - MAX_UNREAD_LINES} more rules were not covered`,
    )
  }
  for (const root of coverage.untouchedProjects) {
    const name = snapshot.projects.find((p) => p.root === root)?.name ?? root
    lines.push(`project ${name} was not read by any family`)
  }
  for (const family of coverage.incompleteFamilies) {
    lines.push(`family ${family} did not finish`)
  }
  if (classified.unresolved > 0) {
    lines.push(
      `${classified.unresolved} candidate(s) held back because a cited file vanished during the run`,
    )
  }
  return lines
}

/** Why a run is degraded, beyond what `begin` already found. */
function coverageReasons(coverage: Coverage, unresolved: number): string[] {
  const reasons: string[] = []
  if (coverage.uncoveredRuleIds.length > 0) reasons.push('uncovered-rules')
  if (coverage.untouchedProjects.length > 0) reasons.push('untouched-project')
  if (coverage.incompleteFamilies.length > 0) reasons.push('incomplete-batch')
  if (unresolved > 0) reasons.push('unresolved-source')
  return reasons
}

function validateResponse(
  runId: string,
  state: ValidatedState,
  classified: Classified,
): HelperResult {
  const droppedTotal = Object.values(classified.dropped).reduce(
    (sum, n) => sum + n,
    0,
  )
  return success('validate', {
    status: 'validated',
    runId,
    pendingOutcome: state.degradeReasons.length > 0 ? 'degraded' : 'complete',
    degradeReasons: state.degradeReasons,
    accepted: classified.accepted.map((item) => ({
      id: item.id,
      kind: item.candidate.kind,
      standing: item.standing,
      title: item.candidate.title,
      target: item.candidate.target,
      possibleMatches: item.possibleMatches,
      ...(item.refreshPointer === undefined
        ? {}
        : { refreshPointer: item.refreshPointer }),
    })),
    recorded: classified.recorded.map((item) => ({
      pointer: item.pointer,
      ruleId: item.candidate.ruleId,
      target: item.candidate.target,
    })),
    suppressed: classified.suppressed,
    unresolved: classified.unresolved,
    dropped: classified.dropped,
    droppedTotal,
    droppedCandidates: classified.droppedCandidates,
    discardedIncomplete: classified.discardedIncomplete,
    coverage: state.coverage,
    offered:
      state.coveredRuleIds.length +
      state.heldBackRuleIds.length +
      state.coverage.uncoveredRuleIds.length,
    sweep: state.sweep,
  })
}

/** Load the snapshot of a run and check that the caller holds its lock. */
function loadRun(
  op: string,
  workDir: string,
  runId: string,
  nonce: string,
): Snapshot | HelperResult {
  const snapshot = readJsonFile(
    workDir,
    'begin.json',
    MAX_SNAPSHOT_BYTES,
    isSnapshot,
  )
  if (snapshot === undefined || snapshot.runId !== runId) {
    return failure(op, 'unknown-run')
  }
  return snapshot.lock.nonce === nonce ? snapshot : failure(op, 'lock-mismatch')
}

function isSnapshotValue(value: Snapshot | HelperResult): value is Snapshot {
  return 'runId' in value
}

function runValidation(
  snapshot: Snapshot,
  workDir: string,
  batchesRead: readonly Batch[],
  ledger: Ledger,
  deps: HelperDeps,
): HelperResult {
  const limits = bounds(deps)
  const degradeReasons = [...snapshot.degradeReasons]
  const batches = batchesRead.slice(0, limits.maxFamiliesPerRun)
  if (batchesRead.length > batches.length) {
    addUnique(degradeReasons, 'family-bound')
  }
  const classified = classifyBatches(
    batches,
    { ctx: contextFrom(snapshot), snapshot, ledger },
    limits,
  )
  // Only the rules the run was offered must be covered. The rest of the index
  // waits for a later run and is not a reason to degrade this one.
  const coverage = checkCoverage({
    ruleIds: snapshot.offer.offered,
    projects: snapshot.projects.map((project) => project.root),
    batches,
  })
  // A rule whose candidate was lost to changed evidence is not covered, even
  // when a complete family named it: nothing was learned about it this run.
  const uncovered = new Set(coverage.uncoveredRuleIds)
  const heldBackRuleIds = snapshot.offer.offered.filter(
    (id) => !uncovered.has(id) && classified.heldBackRuleIds.has(id),
  )
  const heldBack = new Set(heldBackRuleIds)
  const coveredRuleIds = snapshot.offer.offered.filter(
    (id) => !uncovered.has(id) && !heldBack.has(id),
  )
  for (const reason of [
    ...classified.degrade,
    ...coverageReasons(coverage, classified.unresolved),
  ]) {
    addUnique(degradeReasons, reason)
  }
  const state: ValidatedState = {
    version: 1,
    runId: snapshot.runId,
    degradeReasons,
    unread: [
      ...snapshot.unread,
      ...coverageLines(coverage, snapshot, classified),
      ...heldBackRuleIds.map(
        (id) =>
          `rule ${id} is not counted as covered because evidence for a candidate about it changed during the run`,
      ),
    ],
    dropped: classified.dropped,
    droppedCandidates: classified.droppedCandidates,
    discardedIncomplete: classified.discardedIncomplete,
    suppressed: classified.suppressed,
    unresolved: classified.unresolved,
    coverage,
    coveredRuleIds,
    heldBackRuleIds,
    sweep: sweepProgress(snapshot.offer, coveredRuleIds),
    accepted: classified.accepted,
    recorded: classified.recorded,
    batches: batches.map((batch) => ({
      family: batch.family,
      complete: batch.complete,
      ruleIds: batch.ruleIds.length,
      files: batch.files,
      searches: batch.searches,
    })),
  }
  writeWorkFile(workDir, 'validated.json', JSON.stringify(state))
  return validateResponse(snapshot.runId, state, classified)
}

/**
 * A validate request that cannot be used. The caller took the lock at `begin`
 * and no later call may come for this run, so when the request still names a
 * lock handle the lock is released here. The reply says whether it was.
 */
function refuseValidate(request: unknown, deps: HelperDeps): HelperResult {
  const lock = isRecord(request) ? parseLock(request.lock) : undefined
  if (lock === undefined) {
    return failure('validate', 'invalid-request', { lockReleased: false })
  }
  const root = resolveStateRoot(
    deps.env ?? process.env,
    deps.homeDir ?? os.homedir(),
  )
  const runId =
    isRecord(request) &&
    typeof request.runId === 'string' &&
    RUN_ID.test(request.runId) &&
    !request.runId.endsWith('.tmp')
      ? request.runId
      : undefined
  return releaseAndFail(
    'validate',
    { root, nonce: lock.nonce, pid: lock.pid },
    root,
    runId,
    'invalid-request',
  )
}

function validate(request: unknown, deps: HelperDeps): HelperResult {
  const ciMarker = ciRunMarker(deps)
  const result = validateRun(request, deps)
  // A failure that released the lock ended the run; one that did not leaves
  // the lock to its holder, and the run is still going.
  if (
    ciMarker === undefined ||
    result.ok ||
    result.body.lockReleased !== true
  ) {
    return result
  }
  return endInvocation(
    ciMarker,
    result,
    endOfFailure(result, requestRunId(request)),
    deps,
  )
}

function validateRun(request: unknown, deps: HelperDeps): HelperResult {
  const parsed = parseValidateRequest(request)
  if (parsed === undefined) return refuseValidate(request, deps)
  const root = resolveStateRoot(
    deps.env ?? process.env,
    deps.homeDir ?? os.homedir(),
  )
  const workDir = workDirPath(root, parsed.runId)
  const snapshot = loadRun('validate', workDir, parsed.runId, parsed.lock.nonce)
  if (!isSnapshotValue(snapshot)) {
    // The run or the lock is not this caller's, so nothing was released.
    return { ok: false, body: { ...snapshot.body, lockReleased: false } }
  }
  const handle: LockHandle = {
    root,
    nonce: parsed.lock.nonce,
    pid: parsed.lock.pid,
  }
  const fail = (reason: string): HelperResult =>
    releaseAndFail('validate', handle, root, parsed.runId, reason)

  try {
    const read = readBatches(workDir, parsed.runId, parsed.batches)
    if (!read.ok) return fail(read.reason)
    const ledger = readLedger(root)
    if (ledger.status !== 'ok') return fail('ledger-unreadable')
    return runValidation(snapshot, workDir, read.batches, ledger.ledger, deps)
  } catch {
    return fail('internal-error')
  }
}

// ── publish ─────────────────────────────────────────────────────────────────

function buildCandidateBlock(accepted: readonly AcceptedCandidate[]): Json {
  return {
    schemaVersion: 1,
    candidates: accepted.map((item) => ({
      id: item.id,
      status: 'candidate',
      standing: item.standing,
      ...(item.refreshPointer === undefined
        ? {}
        : { refreshPointer: item.refreshPointer }),
      possibleMatches: item.possibleMatches,
      kind: item.candidate.kind,
      ruleId: item.candidate.ruleId,
      target: item.candidate.target,
      targetName: item.candidate.targetName,
      title: item.candidate.title,
      summary: item.candidate.summary,
      nextStep: item.candidate.nextStep,
      overlapCheck: item.candidate.overlapCheck,
      sources: item.candidate.sources,
      targetEvidence: item.candidate.targetEvidence,
      counterevidence: item.candidate.counterevidence,
    })),
  }
}

function digestModel(
  snapshot: Snapshot,
  state: ValidatedState,
  outcome: 'complete' | 'degraded',
  degradeReasons: readonly string[],
): DigestModel {
  const digestCandidates: DigestCandidate[] = state.accepted.map((item) => ({
    id: item.id,
    standing: item.standing,
    ...(item.refreshPointer === undefined
      ? {}
      : { refreshPointer: item.refreshPointer }),
    possibleMatches: item.possibleMatches,
    candidate: item.candidate,
  }))
  const projects: DigestProject[] = snapshot.projects.map((project) => ({
    name: project.name,
    root: project.root,
    files: project.files,
    citationsUnsupported: project.citationsUnsupported,
    truncated: project.truncated,
  }))
  return {
    runId: snapshot.runId,
    outcome,
    generatedAt: snapshot.createdAt,
    mode: snapshot.mode,
    hostSupport: snapshot.host,
    degradeReasons,
    ...(snapshot.selection === undefined
      ? {}
      : { selection: snapshot.selection }),
    sweep: state.sweep,
    projects,
    unmatched: snapshot.unmatched,
    unread: state.unread,
    dropped: state.dropped,
    droppedCandidates: state.droppedCandidates,
    discardedIncomplete: state.discardedIncomplete,
    candidates: digestCandidates,
    recorded: state.recorded,
    suppressed: state.suppressed,
    staleCitations: snapshot.staleCitations,
    undecidedProvenance: snapshot.undecidedProvenance,
  }
}

function runRecord(
  snapshot: Snapshot,
  state: ValidatedState,
  outcome: 'complete' | 'degraded',
  degradeReasons: readonly string[],
): Json {
  const droppedTotal = Object.values(state.dropped).reduce((a, b) => a + b, 0)
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    createdAt: snapshot.createdAt,
    outcome,
    degradeReasons,
    mode: snapshot.mode,
    host: snapshot.host,
    ...(snapshot.reclaimed === undefined
      ? {}
      : { lockReclaim: snapshot.reclaimed }),
    pruned: snapshot.pruned,
    selection: snapshot.selection ?? { kind: 'all' },
    projects: snapshot.projects.map((project) => ({
      name: project.name,
      root: project.root,
      key: project.key,
      ...(project.repo === undefined ? {} : { repo: project.repo }),
      ...(project.commit === undefined ? {} : { commit: project.commit }),
      files: project.files,
      citationsUnsupported: project.citationsUnsupported,
      citationsChecked: project.citationsChecked,
      citationsTruncated: project.citationsTruncated,
      truncated: project.truncated,
    })),
    unmatched: snapshot.unmatched,
    unread: state.unread,
    sweep: state.sweep,
    counts: {
      rules: snapshot.ruleIds.length,
      offered: snapshot.offer.offered.length,
      families: state.batches.length,
      candidates: state.accepted.length,
      recorded: state.recorded.length,
      suppressed: state.suppressed,
      unresolved: state.unresolved,
      dropped: state.dropped,
      droppedTotal,
      discardedIncomplete: state.discardedIncomplete,
    },
    droppedCandidates: state.droppedCandidates,
    coverage: state.coverage,
    batches: state.batches,
    candidateBlock: buildCandidateBlock(state.accepted),
    alreadyRecorded: state.recorded.map((item) => ({
      pointer: item.pointer,
      countsInPrecisionDenominator: true,
      ruleId: item.candidate.ruleId,
      target: item.candidate.target,
      targetName: item.candidate.targetName,
      kind: item.candidate.kind,
      title: item.candidate.title,
      sources: item.candidate.sources.map((source) => ({
        project: source.project,
        projectName: source.projectName,
        path: source.path,
        fingerprint: source.fingerprint,
      })),
      suggestedRefresh: `${item.candidate.target}/${item.pointer}`,
    })),
    staleCitations: snapshot.staleCitations,
    undecidedProvenance: snapshot.undecidedProvenance,
  }
}

function abortRun(
  handle: LockHandle,
  root: string,
  runId: string,
): HelperResult {
  const released = releaseLock(handle)
  removeWorkDir(root, runId)
  if (released === 'lost') return failure('publish', 'lock-lost')
  return success('publish', {
    outcome: 'aborted',
    runId,
    lockReleased: released === 'released',
    finalLine: 'Connect failed',
  })
}

function runFiles(
  snapshot: Snapshot,
  state: ValidatedState,
  outcome: 'complete' | 'degraded',
  degradeReasons: readonly string[],
): { model: DigestModel; files: Record<string, string> } {
  const model = digestModel(snapshot, state, outcome, degradeReasons)
  return {
    model,
    files: {
      'digest.md': renderDigest(model),
      'run.json': `${JSON.stringify(runRecord(snapshot, state, outcome, degradeReasons), null, 2)}\n`,
    },
  }
}

const LEDGER_NOT_WRITTEN =
  'the ledger could not be written; the candidates of this run may be proposed again'

/** Write the run and the ledger, then release the lock. */
function commitRun(
  snapshot: Snapshot,
  state: ValidatedState,
  handle: LockHandle,
  root: string,
  deps: HelperDeps,
  ciMarker: string | undefined,
): HelperResult {
  const degradeReasons = [...state.degradeReasons]
  const outcome = degradeReasons.length > 0 ? 'degraded' : 'complete'
  const first = runFiles(snapshot, state, outcome, degradeReasons)
  const scope = snapshot.coverageScope
  const published = publishRun(
    root,
    handle,
    {
      runId: snapshot.runId,
      files: first.files,
      candidates: state.accepted.map((item) =>
        toCandidateRecord(item.candidate),
      ),
      // The rename commits the run; coverage follows it in the same ledger write.
      coverage: {
        runId: snapshot.runId,
        indexed: snapshot.ruleVersions.map((rule) => ({
          ruleId: rule.id,
          hash: rule.sha256,
          ...(rule.project === undefined ? {} : { project: rule.project }),
        })),
        covered: state.coveredRuleIds,
        ...(snapshot.selection === undefined
          ? {}
          : selectionOf(snapshot.selection)),
        ...(scope === undefined
          ? {}
          : {
              prunable: scope.prunable,
              retain: scope.retain,
              pruneUnattributed: scope.pruneUnattributed,
            }),
      },
    },
    {
      now: deps.now ?? Date.now,
      ...(deps.publishHooks === undefined ? {} : { hooks: deps.publishHooks }),
    },
  )
  if (published.status === 'failed') {
    return releaseAndFail(
      'publish',
      handle,
      root,
      snapshot.runId,
      `publish-${published.reason}`,
    )
  }
  // The run is committed. A ledger that could not be written means its
  // candidates are proposed again next time, so the outcome is degraded, and
  // the committed digest and run record are rewritten to say so before the
  // lock is released.
  const ledgerWritten = published.ledger.written
  let final = first
  let recordsCurrent = true
  if (!ledgerWritten) {
    addUnique(degradeReasons, 'ledger-write-failed')
    final = runFiles(
      snapshot,
      { ...state, unread: [...state.unread, LEDGER_NOT_WRITTEN] },
      'degraded',
      degradeReasons,
    )
    recordsCurrent =
      rewriteRunFiles(root, handle, snapshot.runId, final.files) === 'rewritten'
  }
  const released = releaseLock(handle)
  removeWorkDir(root, snapshot.runId)
  const finalOutcome = ledgerWritten ? outcome : 'degraded'
  const digestPath = path.join(published.runDir, 'digest.md')
  // The run is committed and the lock is gone, so this is the last write. If
  // it fails, the begun record stays and reads as a run with no final line.
  const recorded =
    ciMarker === undefined
      ? 'written'
      : writeTerminal(
          root,
          ciMarker,
          {
            outcome: finalOutcome,
            runId: snapshot.runId,
            projects: invocationProjects(snapshot.projects),
          },
          deps,
        )
  return success('publish', {
    outcome: finalOutcome,
    finalLine: `Connect ${finalOutcome}`,
    runId: snapshot.runId,
    runDir: published.runDir,
    digestPath,
    runRecordPath: path.join(published.runDir, 'run.json'),
    ledger: published.ledger,
    ...(recordsCurrent ? {} : { runRecordCurrent: false }),
    ...(recorded === 'written' ? {} : { invocationRecord: 'unwritten' }),
    lockReleased: released === 'released',
    degradeReasons,
    candidates: state.accepted.length,
    recorded: state.recorded.length,
    summary: renderSummary(
      final.model,
      digestPath,
      path.join(published.runDir, 'run.json'),
    ),
  })
}

function publish(request: unknown, deps: HelperDeps): HelperResult {
  const ciMarker = ciRunMarker(deps)
  const result = publishRunOp(request, deps, ciMarker)
  if (ciMarker === undefined) return result
  const runId = requestRunId(request)
  // A published run recorded itself. An abort is the one other way to end a
  // run well; a failure that released the lock ended it badly. A failure that
  // did not release the lock leaves the lock, and the run, to its holder.
  if (result.ok) {
    return result.body.outcome === 'aborted'
      ? endInvocation(
          ciMarker,
          result,
          { outcome: 'failed', reason: 'aborted', runId },
          deps,
        )
      : result
  }
  return result.body.lockReleased === true
    ? endInvocation(ciMarker, result, endOfFailure(result, runId), deps)
    : result
}

function publishRunOp(
  request: unknown,
  deps: HelperDeps,
  ciMarker: string | undefined,
): HelperResult {
  const parsed = parseRunRequest(request)
  if (parsed === undefined) return failure('publish', 'invalid-request')
  const root = resolveStateRoot(
    deps.env ?? process.env,
    deps.homeDir ?? os.homedir(),
  )
  const handle: LockHandle = {
    root,
    nonce: parsed.lock.nonce,
    pid: parsed.lock.pid,
  }
  if (parsed.record.abort === true) return abortRun(handle, root, parsed.runId)

  const workDir = workDirPath(root, parsed.runId)
  const snapshot = loadRun('publish', workDir, parsed.runId, parsed.lock.nonce)
  if (!isSnapshotValue(snapshot)) return snapshot
  try {
    const state = readJsonFile(
      workDir,
      'validated.json',
      MAX_STATE_BYTES,
      isValidated,
    )
    if (state === undefined || state.runId !== parsed.runId) {
      return releaseAndFail(
        'publish',
        handle,
        root,
        parsed.runId,
        'not-validated',
      )
    }
    return commitRun(snapshot, state, handle, root, deps, ciMarker)
  } catch {
    return releaseAndFail(
      'publish',
      handle,
      root,
      parsed.runId,
      'internal-error',
    )
  }
}

// ── decide and ledger ───────────────────────────────────────────────────────

function parseDecision(request: unknown): DecideInput | undefined {
  if (!isRecord(request)) return undefined
  const { id, status, reason, destination } = request
  if (typeof id !== 'string' || typeof reason !== 'string') return undefined
  if (status !== 'promoted' && status !== 'rejected') return undefined
  if (destination !== undefined && typeof destination !== 'string') {
    return undefined
  }
  return {
    id,
    status,
    reason,
    ...(destination === undefined ? {} : { destination }),
  }
}

function decisionResult(
  result: ReturnType<typeof decideLedgerEntry>,
): HelperResult {
  if (result.status === 'decided') {
    const { entry } = result
    return success('decide', {
      status: 'decided',
      entry: {
        id: entry.id,
        status: entry.status,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(entry.destination === undefined
          ? {}
          : { destination: entry.destination }),
      },
    })
  }
  if (result.status === 'busy') {
    return {
      ok: false,
      body: { ok: false, op: 'decide', outcome: 'busy', reason: result.reason },
    }
  }
  return failure('decide', result.reason)
}

function decide(request: unknown, deps: HelperDeps): HelperResult {
  const decision = parseDecision(request)
  if (decision === undefined) return failure('decide', 'invalid-request')
  const prepared = prepare('decide', deps)
  if (!prepared.ok) return prepared.result
  return decisionResult(
    decideLedgerEntry(prepared.root, decision, {
      ...(deps.processes === undefined ? {} : { processes: deps.processes }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  )
}

const MAX_LEDGER_ENTRIES_SHOWN = 500

/** `{ offset }` with a non-negative integer, or nothing. Anything else is not a request. */
function parseShowRequest(request: unknown): { offset: number } | undefined {
  if (!isRecord(request)) return undefined
  const { offset } = request
  if (offset === undefined) return { offset: 0 }
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return undefined
  }
  return { offset }
}

/** Namespaces listed by `ledger show`; the rest are counted. */
const MAX_COVERAGE_NAMESPACES_SHOWN = 50
const MAX_LABEL_PICKS = 32
const MAX_LABEL_TEXT = 100
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}]/u

function labelText(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LABEL_TEXT &&
    !LABEL_FORBIDDEN.test(value)
    ? value
    : undefined
}

/** `group:<name>` or `projects:<a>,<b>` from the selection a run record names, if it names one well. */
function selectionLabel(record: unknown): string | undefined {
  if (!isRecord(record) || !isRecord(record.selection)) return undefined
  const { kind, name, picks } = record.selection
  if (kind === 'group') {
    const text = labelText(name)
    return text === undefined ? undefined : `group:${text}`
  }
  if (kind !== 'projects' || !Array.isArray(picks)) return undefined
  if (picks.length === 0 || picks.length > MAX_LABEL_PICKS) return undefined
  const texts = picks.map(labelText)
  return texts.every((text) => text !== undefined)
    ? `projects:${texts.join(',')}`
    : undefined
}

interface NamespaceTally {
  readonly selection: string
  rules: number
  newest: CoverageRecord
}

/**
 * The coverage records counted per selection: the no-selection namespace
 * first, then the most recently covered. A selection is labelled from the run
 * record of its newest record when that run is still kept.
 */
function coverageNamespaces(
  root: string,
  coverage: readonly CoverageRecord[],
): { listed: Json[]; omitted: number } {
  const tallies = new Map<string, NamespaceTally>()
  for (const record of coverage) {
    const key = record.selection ?? 'all'
    const tally = tallies.get(key)
    if (tally === undefined) {
      tallies.set(key, { selection: key, rules: 1, newest: record })
      continue
    }
    tally.rules++
    const newer =
      record.at > tally.newest.at ||
      (record.at === tally.newest.at && record.runId > tally.newest.runId)
    if (newer) tally.newest = record
  }
  const ordered = [...tallies.values()].sort((a, b) => {
    if (a.selection === 'all' || b.selection === 'all') {
      return a.selection === 'all' ? -1 : 1
    }
    if (a.newest.at !== b.newest.at) return a.newest.at < b.newest.at ? 1 : -1
    return a.selection < b.selection ? -1 : 1
  })
  const shown = ordered.slice(0, MAX_COVERAGE_NAMESPACES_SHOWN)
  const listed = shown.map((tally): Json => {
    if (tally.selection === 'all')
      return { selection: 'all', rules: tally.rules }
    const label = selectionLabel(readRunRecord(root, tally.newest.runId))
    return {
      selection: tally.selection,
      rules: tally.rules,
      ...(label === undefined ? {} : { label }),
    }
  })
  return { listed, omitted: ordered.length - shown.length }
}

function ledgerShow(request: unknown, deps: HelperDeps): HelperResult {
  const page = parseShowRequest(request)
  if (page === undefined) return failure('ledger-show', 'invalid-request')
  const prepared = prepare('ledger-show', deps)
  if (!prepared.ok) return prepared.result
  const read = readLedger(prepared.root)
  if (read.status !== 'ok') {
    return failure('ledger-show', 'ledger-unreadable', { detail: read.reason })
  }
  const total = read.ledger.entries.length
  const end = page.offset + MAX_LEDGER_ENTRIES_SHOWN
  const entries = read.ledger.entries.slice(page.offset, end)
  const records = read.ledger.coverage ?? []
  const namespaces = coverageNamespaces(prepared.root, records)
  return success('ledger-show', {
    total,
    offset: page.offset,
    nextOffset: end < total ? end : null,
    coverage: {
      rules: records.length,
      namespaces: namespaces.listed,
      ...(namespaces.omitted > 0
        ? { namespacesOmitted: namespaces.omitted }
        : {}),
    },
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      target: entry.target,
      ruleId: entry.ruleId,
      status: entry.status,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.destination === undefined
        ? {}
        : { destination: entry.destination }),
      ...(entry.reopened === undefined ? {} : { reopened: entry.reopened }),
      sources: entry.sources.map((source) => ({
        role: source.role,
        path: source.path,
        fingerprint: source.fingerprint,
      })),
      targetEvidence: entry.targetEvidence,
      history: entry.history.length,
      recordedAt: entry.recordedAt,
    })),
  })
}

function ledgerClear(deps: HelperDeps): HelperResult {
  const prepared = prepare('ledger-clear', deps)
  if (!prepared.ok) return prepared.result
  const result = clearLedger(prepared.root, {
    ...(deps.processes === undefined ? {} : { processes: deps.processes }),
  })
  if (result.status === 'cleared') {
    return success('ledger-clear', { removed: result.removed })
  }
  if (result.status === 'busy') {
    return {
      ok: false,
      body: {
        ok: false,
        op: 'ledger-clear',
        outcome: 'busy',
        reason: result.reason,
      },
    }
  }
  return failure('ledger-clear', result.reason)
}

function ledgerUnlock(deps: HelperDeps): HelperResult {
  const prepared = prepare('ledger-unlock', deps)
  if (!prepared.ok) return prepared.result
  const result = forceUnlock(prepared.root)
  if (result.status === 'failed') return failure('ledger-unlock', result.reason)
  return success('ledger-unlock', {
    status: result.status,
    ...(result.status === 'unlocked' && result.holder !== undefined
      ? { previousHolder: result.holder }
      : {}),
  })
}

// ── import ──────────────────────────────────────────────────────────────────

const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const GITHUB_RUN_ID = /^[0-9]{1,20}$/
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_DIRECTORY_LENGTH = 4096

interface ImportRequest {
  readonly directory: string
  readonly provenance: ImportProvenance
}

/** The downloaded directory and where the run came from. The skill supplies both; neither comes from the record. */
function parseImportRequest(request: unknown): ImportRequest | undefined {
  if (!isRecord(request)) return undefined
  const { directory, provenance } = request
  if (
    typeof directory !== 'string' ||
    directory === '' ||
    directory.length > MAX_DIRECTORY_LENGTH ||
    CONTROL_IN_PATH.test(directory) ||
    !path.isAbsolute(directory)
  ) {
    return undefined
  }
  if (!isRecord(provenance)) return undefined
  const { repo, runId, commit } = provenance
  if (typeof repo !== 'string' || !GITHUB_REPO.test(repo)) return undefined
  if (typeof runId !== 'string' || !GITHUB_RUN_ID.test(runId)) return undefined
  if (
    commit !== undefined &&
    !(typeof commit === 'string' && COMMIT_ID.test(commit))
  ) {
    return undefined
  }
  return {
    directory,
    provenance: {
      repo,
      runId,
      ...(commit === undefined ? {} : { commit }),
    },
  }
}

function importFailure(reason: string, extra: Json = {}): HelperResult {
  return failure('import', reason, { finalLine: 'Connect failed', ...extra })
}

function importLocals(environment: Environment): LocalCheckout[] {
  return environment.resolved.resolved.map(({ mainRoot }) => ({
    root: mainRoot,
    key: projectKey(mainRoot),
    name: projectName(mainRoot),
    ...readRepoIdentity(mainRoot),
  }))
}

/** The tracked files of a local checkout, or nothing when it cannot be read. */
function importFacts(
  deps: HelperDeps,
): (root: string) => ProjectFacts | undefined {
  const limits = bounds(deps)
  return (root) => {
    // A root with such a character cannot be cited from, as in a local run.
    if (UNSAFE_PATH_CHARACTER.test(root)) return undefined
    const inventory = inventoryProject(root, {
      bounds: limits,
      ...(deps.gitBinary === undefined ? {} : { gitBinary: deps.gitBinary }),
    })
    return inventory.status === 'ok'
      ? toProjectFacts(inventory.mainRoot, inventory.files)
      : undefined
  }
}

/** A candidate to be written into the new import run. */
interface Fresh extends AcceptedCandidate {
  readonly kind: 'fresh'
  readonly record: CandidateRecord
}

/** A candidate already open in the ledger, with the import run that holds it. */
interface Open {
  readonly kind: 'open'
  readonly accepted: ImportAccepted
  readonly runRecordPath: string
}

interface Placement {
  readonly fresh: readonly Fresh[]
  readonly open: readonly Open[]
  readonly skipped: readonly SkippedCandidate[]
  /** The accepted candidates in record order. */
  readonly order: ReadonlyArray<Fresh | Open>
}

const NO_PLACEMENT: Placement = {
  fresh: [],
  open: [],
  skipped: [],
  order: [],
}

/**
 * What a candidate stands on: its target, sources, target evidence and
 * counterevidence. A kept record is the same candidate only when this matches,
 * because the id is the same across changed fingerprints.
 */
function evidenceOf(candidate: {
  readonly target?: unknown
  readonly sources?: unknown
  readonly targetEvidence?: unknown
  readonly counterevidence?: unknown
}): string {
  return JSON.stringify([
    candidate.target,
    candidate.sources,
    candidate.targetEvidence,
    candidate.counterevidence,
  ])
}

/** The evidence of each candidate a kept import run holds, by id, newest run first. */
function keptImportRuns(
  root: string,
  runs: readonly string[],
): Array<{ runId: string; evidence: ReadonlyMap<string, string> }> {
  const out: Array<{ runId: string; evidence: ReadonlyMap<string, string> }> =
    []
  for (const runId of runs) {
    const record = readRunRecord(root, runId)
    if (!isRecord(record) || record.kind !== 'import') continue
    const block = record.candidateBlock
    if (!isRecord(block) || !Array.isArray(block.candidates)) continue
    const evidence = new Map<string, string>()
    for (const item of block.candidates as unknown[]) {
      if (isRecord(item) && typeof item.id === 'string') {
        evidence.set(item.id, evidenceOf(item))
      }
    }
    out.push({ runId, evidence })
  }
  return out
}

function freshOf(
  item: ImportAccepted,
  standing: Standing,
  extra: {
    refreshPointer?: string
    possibleMatches?: readonly string[]
  } = {},
): Fresh {
  return {
    kind: 'fresh',
    id: item.id,
    standing,
    ...(extra.refreshPointer === undefined
      ? {}
      : { refreshPointer: extra.refreshPointer }),
    possibleMatches: extra.possibleMatches ?? [],
    candidate: item.candidate,
    record: item.record,
  }
}

/** A candidate decided here, named so it is skipped; a promoted one carries where it lives. */
function skippedOf(
  item: ImportAccepted,
  entry: LedgerEntry | undefined,
): SkippedCandidate | undefined {
  const title = item.candidate.title
  if (entry?.status === 'rejected') {
    return { id: item.id, title, reason: 'rejected-locally' }
  }
  if (entry?.status !== 'promoted') return undefined
  return {
    id: item.id,
    title,
    reason: 'promoted-locally',
    ...(entry.destination === undefined
      ? {}
      : { refreshPointer: entry.destination }),
  }
}

type Placed =
  | { readonly placed: Fresh | Open }
  | { readonly skipped: SkippedCandidate }

function placeOne(
  item: ImportAccepted,
  ledger: Ledger,
  heldIn: (item: ImportAccepted) => string | undefined,
): Placed {
  const outcome = classifyCandidate(ledger, item.record)
  if (outcome.standing === 'new') {
    return {
      placed: freshOf(item, 'new', {
        possibleMatches: [
          ...new Set([
            ...outcome.possibleMatches,
            ...findRenamedEntries(ledger, item.record, item.id),
          ]),
        ],
      }),
    }
  }
  if (outcome.standing === 'reopened') {
    return {
      placed: freshOf(
        item,
        outcome.reason,
        outcome.refreshPointer === undefined
          ? {}
          : { refreshPointer: outcome.refreshPointer },
      ),
    }
  }
  const skipped = skippedOf(
    item,
    ledger.entries.find((known) => known.id === item.id),
  )
  if (skipped !== undefined) return { skipped }
  const held = heldIn(item)
  return {
    placed:
      held === undefined
        ? freshOf(item, 'new')
        : { kind: 'open', accepted: item, runRecordPath: held },
  }
}

/**
 * Sort the accepted candidates by what the ledger says about each. A new or
 * reopened one is written. One decided here is skipped and named. One already
 * open is listed again with the import run that holds it; when no kept run
 * holds it with the evidence just verified it is written again, and its ledger
 * entry stays as it is.
 */
function placeCandidates(
  accepted: readonly ImportAccepted[],
  ledger: Ledger,
  root: string,
  runs: readonly string[],
): Placement {
  let kept: ReturnType<typeof keptImportRuns> | undefined
  const heldIn = (item: ImportAccepted): string | undefined => {
    kept ??= keptImportRuns(root, runs)
    const current = evidenceOf(item.candidate)
    const holder = kept.find((run) => run.evidence.get(item.id) === current)
    return holder === undefined
      ? undefined
      : path.join(root, 'runs', holder.runId, 'run.json')
  }
  const fresh: Fresh[] = []
  const open: Open[] = []
  const skipped: SkippedCandidate[] = []
  const order: Array<Fresh | Open> = []
  for (const item of accepted) {
    const result = placeOne(item, ledger, heldIn)
    if ('skipped' in result) {
      skipped.push(result.skipped)
      continue
    }
    order.push(result.placed)
    if (result.placed.kind === 'fresh') fresh.push(result.placed)
    else open.push(result.placed)
  }
  return { fresh, open, skipped, order }
}

function countByReason(
  refused: readonly ImportRefusal[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of refused) count(counts, item.reason)
  return counts
}

function importRunRecord(
  model: ImportModel,
  createdAt: string,
  verified: Verification,
  placement: Placement,
): Json {
  return {
    schemaVersion: 1,
    runId: model.runId,
    createdAt,
    kind: 'import',
    outcome: model.outcome,
    degradeReasons: model.degradeReasons,
    provenance: model.provenance,
    source: { runId: model.sourceRunId },
    projects: verified.projects,
    counts: {
      candidates: placement.fresh.length,
      alreadyImported: placement.open.length,
      skipped: placement.skipped.length,
      refused: model.refused.length,
    },
    refused: model.refused,
    skipped: placement.skipped,
    candidateBlock: buildCandidateBlock(placement.fresh),
  }
}

/** What the answer and the digest say, with the run record each candidate sits in. */
function importModel(
  parsed: ImportRequest,
  sourceRunId: string,
  verified: Verification,
  placement: Placement,
  runId: string | undefined,
  newRecordPath: string,
): ImportModel {
  const candidates: ImportedCandidate[] = placement.order.map((entry) =>
    entry.kind === 'fresh'
      ? { item: entry, runRecordPath: newRecordPath }
      : {
          item: {
            id: entry.accepted.id,
            standing: 'new',
            possibleMatches: [],
            candidate: entry.accepted.candidate,
          },
          runRecordPath: entry.runRecordPath,
        },
  )
  return {
    runId,
    outcome: verified.refused.length > 0 ? 'degraded' : 'complete',
    degradeReasons: verified.refused.length > 0 ? ['candidates-refused'] : [],
    provenance: parsed.provenance,
    sourceRunId,
    projects: verified.projects,
    imported: placement.fresh.length,
    candidates,
    skipped: placement.skipped,
    refused: verified.refused,
  }
}

function importAnswer(
  model: ImportModel,
  verified: Verification,
  written: { runDir: string } | undefined,
): HelperResult {
  const runRecordPath =
    written === undefined ? undefined : path.join(written.runDir, 'run.json')
  const digestPath =
    written === undefined ? undefined : path.join(written.runDir, 'digest.md')
  return success('import', {
    outcome: model.outcome,
    finalLine: `Connect ${model.outcome}`,
    ...(written === undefined || model.runId === undefined
      ? {}
      : {
          runId: model.runId,
          runDir: written.runDir,
          runRecordPath,
          digestPath,
        }),
    imported: model.imported,
    alreadyImported: model.candidates.length - model.imported,
    candidates: model.candidates.map(({ item, runRecordPath: held }) => ({
      id: item.id,
      kind: item.candidate.kind,
      title: item.candidate.title,
      standing: item.standing,
      runRecordPath: held,
    })),
    skipped: model.skipped,
    refused: model.refused,
    refusedBy: countByReason(model.refused),
    projects: verified.projects,
    provenance: model.provenance,
    degradeReasons: model.degradeReasons,
    summary: renderImportSummary(model, digestPath),
  })
}

/** The busy lock, a failed insert and a ledger that was not written, each as the answer. */
function insertFailure(inserted: ImportInsertResult): HelperResult | undefined {
  if (inserted.status === 'busy') {
    return {
      ok: false,
      body: {
        ok: false,
        op: 'import',
        outcome: 'busy',
        reason: inserted.reason,
        finalLine: 'Connect busy',
        hint: 'Another run holds the lock. If no run is active, `ledger unlock` clears it.',
      },
    }
  }
  if (inserted.status === 'failed') {
    return importFailure(
      inserted.reason === 'lock-failed' ||
        inserted.reason === 'ledger-unreadable'
        ? inserted.reason
        : `publish-${inserted.reason}`,
    )
  }
  if (inserted.status === 'published' && !inserted.ledger.written) {
    return importFailure('ledger-write-failed', {
      runDir: inserted.runDir,
      ...(inserted.runRecordCurrent === false
        ? { runRecordCurrent: false }
        : {}),
    })
  }
  return undefined
}

/** Place the verified candidates under the lock and write the import run, if there is one to write. */
function importWrite(
  parsed: ImportRequest,
  sourceRunId: string,
  verified: Verification,
  root: string,
  deps: HelperDeps,
): HelperResult {
  const now = deps.now ?? Date.now
  let placement: Placement = NO_PLACEMENT
  let localRunId: string | undefined
  const inserted = insertImportRun(
    root,
    (view): ImportPlan => {
      placement = placeCandidates(
        verified.accepted,
        view.ledger,
        root,
        view.importRuns,
      )
      if (placement.fresh.length === 0) return { publish: false }
      const runId = newImportRunId(now())
      localRunId = runId
      const createdAt = new Date(now()).toISOString()
      const model = importModel(
        parsed,
        sourceRunId,
        verified,
        placement,
        runId,
        path.join(root, 'runs', runId, 'run.json'),
      )
      const filesOf = (shown: ImportModel): Record<string, string> => ({
        'digest.md': renderImportDigest(shown, placement.fresh, createdAt),
        'run.json': `${JSON.stringify(importRunRecord(shown, createdAt, verified, placement), null, 2)}\n`,
      })
      return {
        publish: true,
        runId,
        files: filesOf(model),
        candidates: placement.fresh.map((item) => item.record),
        // The run is committed before the ledger is written, so a ledger that
        // cannot be written leaves a run that must not say it is complete.
        onLedgerWriteFailed: () =>
          filesOf({
            ...model,
            outcome: 'degraded',
            degradeReasons: [...model.degradeReasons, 'ledger-write-failed'],
          }),
      }
    },
    {
      now,
      ...(deps.processes === undefined ? {} : { processes: deps.processes }),
      ...(deps.publishHooks === undefined ? {} : { hooks: deps.publishHooks }),
    },
  )
  const failed = insertFailure(inserted)
  if (failed !== undefined) return failed
  const written =
    inserted.status === 'published' ? { runDir: inserted.runDir } : undefined
  return importAnswer(
    importModel(
      parsed,
      sourceRunId,
      verified,
      placement,
      localRunId,
      written === undefined ? '' : path.join(written.runDir, 'run.json'),
    ),
    verified,
    written,
  )
}

/**
 * Import the candidates of a scheduled run's record. Everything before the
 * lock only reads: the record, then the local checkouts. A request or a record
 * that cannot be used changes no state, and neither does an import that has
 * nothing to write.
 */
function importRun(request: unknown, deps: HelperDeps): HelperResult {
  const parsed = parseImportRequest(request)
  if (parsed === undefined) return importFailure('invalid-request')
  const read = readImportRecord(parsed.directory)
  if (read.status === 'failed') return importFailure(read.reason)
  const environment = describeEnvironment(deps)
  if (environment.resolved.resolved.length === 0) {
    return importFailure('no-allowed-projects', {
      unmatched: environment.resolved.unmatched,
      configWarnings: environment.warnings,
    })
  }
  const verified = verifyRecord({
    record: read.record,
    locals: importLocals(environment),
    factsFor: importFacts(deps),
  })
  const sourceRunId = read.record.runId
  if (verified.accepted.length === 0) {
    return importAnswer(
      importModel(parsed, sourceRunId, verified, NO_PLACEMENT, undefined, ''),
      verified,
      undefined,
    )
  }

  const state = prepareStateRoot(environment.stateRoot, {
    allowedRoots: environment.allowedRoots,
  })
  if (state.status === 'refused') {
    return importFailure('state-root-refused', { detail: state.reason })
  }
  return importWrite(parsed, sourceRunId, verified, state.root, deps)
}

// ── apply-ticks and render-report ───────────────────────────────────────────

const ISSUE_DIGITS = /^[0-9]{1,10}$/

interface TicksRequest {
  readonly bodyFile: string
  readonly issue: number
}

/** The report body as a file and the report's issue number, as a number or a string of digits. */
function parseTicksRequest(request: unknown): TicksRequest | undefined {
  if (!isRecord(request)) return undefined
  const { bodyFile, issue } = request
  if (
    typeof bodyFile !== 'string' ||
    bodyFile === '' ||
    bodyFile.length > MAX_DIRECTORY_LENGTH ||
    CONTROL_IN_PATH.test(bodyFile) ||
    !path.isAbsolute(bodyFile)
  ) {
    return undefined
  }
  const number =
    typeof issue === 'string' && ISSUE_DIGITS.test(issue)
      ? Number(issue)
      : issue
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    return undefined
  }
  return number < 1 ? undefined : { bodyFile, issue: number }
}

/** The date, the GitHub run and attempt, and whether a cache came back. Their values are checked by the renderer. */
function parseRenderRequest(request: unknown): RenderRequest | undefined {
  if (!isRecord(request)) return undefined
  const { date, runId, attempt, cacheRestored } = request
  if (
    typeof date !== 'string' ||
    typeof runId !== 'string' ||
    typeof attempt !== 'string' ||
    typeof cacheRestored !== 'boolean'
  ) {
    return undefined
  }
  return { date, runId, attempt, cacheRestored }
}

function ciOptions(deps: HelperDeps): CiOptions {
  return {
    ...(deps.processes === undefined ? {} : { processes: deps.processes }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }
}

function busyAnswer(
  op: string,
  reason: string,
  extra: Json = {},
): HelperResult {
  return {
    ok: false,
    body: { ok: false, op, outcome: 'busy', reason, ...extra },
  }
}

/**
 * Record the ticks of a posted report body. The body is a file the workflow
 * fetched; the manifest it names is looked up in the state root. A tick that
 * cannot be matched to it is reported, never fatal, and nothing is recorded
 * from a body that does not name a stored manifest.
 */
function applyTicksOp(request: unknown, deps: HelperDeps): HelperResult {
  const parsed = parseTicksRequest(request)
  if (parsed === undefined) return failure('apply-ticks', 'invalid-request')
  const read = readReportBody(parsed.bodyFile)
  if (read.status === 'failed') return failure('apply-ticks', read.reason)
  const prepared = prepare('apply-ticks', deps)
  if (!prepared.ok) return prepared.result
  const result = applyTicks(
    prepared.root,
    { body: read.body, issue: parsed.issue },
    ciOptions(deps),
  )
  if (result.status === 'busy') {
    return busyAnswer('apply-ticks', result.reason, {
      accepted: result.accepted,
    })
  }
  if (result.status === 'failed') {
    return failure('apply-ticks', result.reason, { accepted: result.accepted })
  }
  return success('apply-ticks', {
    report: parsed.issue,
    section: result.section,
    accepted: result.accepted,
    skipped: result.skipped,
    unresolved: result.unresolved,
  })
}

/**
 * Render the report body into `report.md` in the state root. The answer holds
 * the facts about the body (counts, the manifest hash, the outcome, whether
 * the job should end red and whether the stores were updated) and never the
 * body itself.
 */
function renderReportOp(request: unknown, deps: HelperDeps): HelperResult {
  const parsed = parseRenderRequest(request)
  if (parsed === undefined) return failure('render-report', 'invalid-request')
  const prepared = prepare('render-report', deps)
  if (!prepared.ok) return prepared.result
  const result = renderReport(prepared.root, parsed, ciOptions(deps))
  if (result.status === 'busy')
    return busyAnswer('render-report', result.reason)
  if (result.status === 'failed') {
    return failure('render-report', result.reason)
  }
  return success('render-report', {
    bodyFile: result.bodyFile,
    bodyChars: result.body.length,
    manifest: result.manifest,
    open: result.open,
    shown: result.shown,
    hidden: result.hidden,
    fresh: result.fresh,
    runs: result.runs,
    outcome: result.outcome,
    red: result.red,
    stateUpdated: result.stateUpdated,
  })
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Run one operation. Never throws: an unexpected error is an `internal-error`
 * failure that names the operation and nothing else.
 */
export function runHelperOp(
  op: string,
  request: unknown,
  deps: HelperDeps = {},
): HelperResult {
  if (!isOp(op)) return failure(op, 'unknown-op')
  try {
    switch (op) {
      case 'begin':
        return begin(request, deps)
      case 'validate':
        return validate(request, deps)
      case 'publish':
        return publish(request, deps)
      case 'decide':
        return decide(request, deps)
      case 'import':
        return importRun(request, deps)
      case 'apply-ticks':
        return applyTicksOp(request, deps)
      case 'render-report':
        return renderReportOp(request, deps)
      case 'ledger-show':
        return ledgerShow(request, deps)
      case 'ledger-clear':
        return ledgerClear(deps)
      case 'ledger-unlock':
        return ledgerUnlock(deps)
    }
  } catch {
    return failure(op, 'internal-error')
  }
}

// ── Command line ────────────────────────────────────────────────────────────

const MAX_REQUEST_BYTES = 256 * 1024
const STDIN_CHUNK = 64 * 1024

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

/** One read of stdin: bytes, 0 at the end, or a retry marker when the pipe has nothing yet. */
function readStdinChunk(chunk: Buffer): number | 'retry' | 'unreadable' {
  try {
    return fs.readSync(0, chunk, 0, chunk.length, null)
  } catch (error) {
    const code = errorCodeOf(error)
    if (code === 'EOF') return 0
    if (code !== 'EAGAIN') return 'unreadable'
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    return 'retry'
  }
}

function readStdinBounded(): string | 'too-large' | 'unreadable' {
  const chunks: Buffer[] = []
  let total = 0
  const chunk = Buffer.alloc(STDIN_CHUNK)
  for (;;) {
    const read = readStdinChunk(chunk)
    if (read === 'unreadable') return 'unreadable'
    if (read === 'retry') continue
    if (read === 0) break
    total += read
    if (total > MAX_REQUEST_BYTES) return 'too-large'
    chunks.push(Buffer.from(chunk.subarray(0, read)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface CliOptions {
  readonly argv: readonly string[]
  readonly deps?: HelperDeps
  /** Replaces reading stdin; for tests. */
  readonly readRequest?: () => string | 'too-large' | 'unreadable'
  readonly isTTY?: boolean
  readonly outputSink?: (line: string) => void
  readonly errorSink?: (line: string) => void
}

const REQUEST_OPS = new Set<Op>([
  'begin',
  'validate',
  'publish',
  'decide',
  'import',
  'apply-ticks',
  'render-report',
])

function resolveCliOp(argv: readonly string[]): Op | undefined {
  const [first, second] = argv
  if (first === 'ledger') {
    const op = `ledger-${second ?? ''}`
    return isOp(op) ? op : undefined
  }
  return first !== undefined && isOp(first) && !first.startsWith('ledger')
    ? first
    : undefined
}

/** `ledger show [--offset N]`: the paging request, with nothing read from stdin. */
function showRequestFromArgv(argv: readonly string[]): unknown {
  const rest = argv.slice(2)
  if (rest.length === 0) return {}
  const [flag, value] = rest
  if (rest.length !== 2 || flag !== '--offset') return { offset: null }
  return /^\d+$/.test(value ?? '')
    ? { offset: Number(value) }
    : { offset: value }
}

type CliRequest =
  | { readonly ok: true; readonly request: unknown }
  | { readonly ok: false; readonly exitCode: 2 }

/**
 * The answer for a `begin` whose request could not be read. A CI run still
 * ends with a terminal `failed` record, as every other stop of `begin` does;
 * a local run has no run file and writes nothing.
 */
function refusedBegin(result: HelperResult, options: CliOptions): HelperResult {
  const deps = options.deps ?? {}
  const marker = ciRunMarker(deps)
  return marker === undefined
    ? result
    : endInvocation(marker, result, endOfFailure(result), deps)
}

/** Read the request of an operation that takes one: JSON on stdin, bounded. */
function readCliRequest(
  op: Op,
  options: CliOptions,
  out: (line: string) => void,
  err: (line: string) => void,
): CliRequest {
  if (!REQUEST_OPS.has(op)) return { ok: true, request: {} }
  if ((options.isTTY ?? process.stdin.isTTY) === true) {
    err(
      `${op} reads one JSON request from stdin; interactive input is not supported`,
    )
    if (op === 'begin') {
      refusedBegin(failure(op, 'request-interactive'), options)
    }
    return { ok: false, exitCode: 2 }
  }
  const text = (options.readRequest ?? readStdinBounded)()
  const refuse = (reason: string): CliRequest => {
    // The request is the only place the lock handle is, and it was not read.
    const refused = failure(
      op,
      reason,
      op === 'validate' ? { lockReleased: false } : {},
    )
    out(
      JSON.stringify(
        (op === 'begin' ? refusedBegin(refused, options) : refused).body,
      ),
    )
    return { ok: false, exitCode: 2 }
  }
  if (text === 'too-large' || text === 'unreadable') {
    return refuse(`request-${text}`)
  }
  if (text.trim() === '') return { ok: true, request: {} }
  try {
    return { ok: true, request: JSON.parse(text) as unknown }
  } catch {
    return refuse('request-not-json')
  }
}

/** Run the command line. Returns the exit code: 0 ok, 1 not ok, 2 usage or an unreadable request. */
export function runConnectHelper(options: CliOptions): number {
  const out =
    options.outputSink ?? ((line) => process.stdout.write(`${line}\n`))
  const err = options.errorSink ?? ((line) => process.stderr.write(`${line}\n`))
  const op = resolveCliOp(options.argv)
  if (op === undefined) {
    err(CE_CONNECT_USAGE)
    return 2
  }
  const read = readCliRequest(op, options, out, err)
  if (!read.ok) return read.exitCode
  const request =
    op === 'ledger-show' ? showRequestFromArgv(options.argv) : read.request
  const result = runHelperOp(op, request, options.deps ?? {})
  out(JSON.stringify(result.body))
  return result.ok ? 0 : 1
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runConnectHelper({ argv: process.argv.slice(2) })
}
