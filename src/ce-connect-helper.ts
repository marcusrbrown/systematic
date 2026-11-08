import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type AllowEntryMissReason,
  type ConnectConfigOptions,
  checkHostSupport,
  HOST_SUPPORT_TABLE,
  type HostSupportRow,
  loadConnectAllowList,
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
  extractRule,
  findRecorded,
  findRenamedEntries,
  isWorkName,
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
  resolveStateRoot,
  type StaleCitation,
  type Standing,
  type SweepProgress,
  scanProvenance,
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
  acquireLock,
  type CandidateRecord,
  type CandidateStanding,
  candidateIdentity,
  classifyCandidate,
  clearLedger,
  type DecideInput,
  decideLedgerEntry,
  forceUnlock,
  type Ledger,
  type LockHandle,
  type LockReclaim,
  newRunId,
  type ProcessTable,
  prepareStateRoot,
  pruneRuns,
  publishRun,
  readLedger,
  releaseLock,
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
  'Usage: node connect.mjs <begin|validate|publish|decide|ledger show|ledger clear|ledger unlock>'

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
  readonly ruleVersions: ReadonlyArray<{ id: string; sha256: string }>
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

// ── begin ───────────────────────────────────────────────────────────────────

interface BeginRequest {
  readonly host: string
  readonly version: string | undefined
  readonly mode: 'interactive' | 'headless'
  readonly consent: boolean
}

function parseBeginRequest(request: unknown): BeginRequest | undefined {
  if (!isRecord(request)) return undefined
  const { host, version, mode, consent } = request
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
  return { host, version, mode, consent: consent === true }
}

const CORPUS_PREFIXES = ['docs/solutions/', 'docs/plans/', 'docs/brainstorms/']
const MAX_STALE_RECORDED = 200

interface ScannedProject {
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
  }
  let changed = 0
  for (const file of inventory.files.filter((f) => isCorpusRole(f.role))) {
    const read = readContainedFile(inventory.mainRoot, file.path, {
      maxBytes: limits.maxFileBytes,
    })
    if (read.kind === 'refused' || read.sha256 !== file.sha256) {
      changed++
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
  const corpusSkipped =
    inventory.skipped.some((file) =>
      CORPUS_PREFIXES.some((prefix) => file.path.startsWith(prefix)),
    ) || inventory.skippedCount > inventory.skipped.length
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

  return {
    digest: {
      name,
      root: inventory.mainRoot,
      key: projectKey(inventory.mainRoot),
      entry,
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
}

/** Scan every matched project. One that cannot be read degrades the run. */
function scanAll(
  environment: Environment,
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
  for (const item of environment.resolved.resolved) {
    const scanned = scanProject(item.entry, item.mainRoot, deps, limits)
    if ('failed' in scanned) {
      addUnique(degradeReasons, 'project-unreadable')
      unread.push(`${projectName(item.mainRoot)}: not read (${scanned.failed})`)
      continue
    }
    for (const reason of scanned.degrade) addUnique(degradeReasons, reason)
    unread.push(...scanned.unread)
    scans.push(scanned)
  }
  return { scans, degradeReasons, unread }
}

interface RunSetup {
  readonly parsed: BeginRequest
  readonly verdict: ReturnType<typeof checkHostSupport>
  readonly environment: Environment
  readonly unmatched: ReadonlyArray<{ entry: string; reason: string }>
  readonly root: string
  readonly now: () => number
  readonly holder: HolderChoice
  readonly lock: LockHandle
  readonly reclaimed: LockReclaim | undefined
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
  const { scans, degradeReasons, unread } = scanAll(
    setup.environment,
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
      ruleIds: rules.map((rule) => rule.id),
      ruleVersions: rules.map((rule) => ({ id: rule.id, sha256: rule.sha256 })),
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
    return beginResponse(setup, snapshot, scans, workDir, limits)
  } catch {
    return releaseAndFail('begin', lock, root, runId, 'internal-error')
  }
}

function begin(request: unknown, deps: HelperDeps): HelperResult {
  const parsed = parseBeginRequest(request)
  if (parsed === undefined) return failure('begin', 'invalid-request')
  const verdict = gateHost(parsed, deps)
  if (isResult(verdict)) return verdict

  const environment = describeEnvironment(deps)
  const unmatched = environment.resolved.unmatched.map((item) => ({
    entry: item.entry,
    reason: item.reason as AllowEntryMissReason,
  }))
  if (environment.resolved.resolved.length === 0) {
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
    unmatched,
    root: state.root,
    now,
    holder,
    lock: acquired.lock,
    reclaimed: acquired.reclaimed,
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
  input: ClassifyInput,
  seen: Set<string>,
  result: Classified,
): void {
  const check = checkCandidate(raw, input.ctx)
  if (check.status === 'dropped') {
    count(result.dropped, check.reason)
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
    count(result.dropped, 'duplicate-candidate')
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
    suppressed: 0,
    unresolved: 0,
    discardedIncomplete: 0,
    degrade: [],
    heldBackRuleIds: new Set(),
  }
  const seen = new Set<string>()
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
    for (const raw of considered) classifyOne(raw, input, seen, result)
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

function validate(request: unknown, deps: HelperDeps): HelperResult {
  const parsed = parseValidateRequest(request)
  if (parsed === undefined) return failure('validate', 'invalid-request')
  const root = resolveStateRoot(
    deps.env ?? process.env,
    deps.homeDir ?? os.homedir(),
  )
  const workDir = workDirPath(root, parsed.runId)
  const snapshot = loadRun('validate', workDir, parsed.runId, parsed.lock.nonce)
  if (!isSnapshotValue(snapshot)) return snapshot
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
    sweep: state.sweep,
    projects,
    unmatched: snapshot.unmatched,
    unread: state.unread,
    dropped: state.dropped,
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
    projects: snapshot.projects.map((project) => ({
      name: project.name,
      root: project.root,
      key: project.key,
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

/** Write the run and the ledger, then release the lock. */
function commitRun(
  snapshot: Snapshot,
  state: ValidatedState,
  handle: LockHandle,
  root: string,
  deps: HelperDeps,
): HelperResult {
  const degradeReasons = [...state.degradeReasons]
  const outcome = degradeReasons.length > 0 ? 'degraded' : 'complete'
  const model = digestModel(snapshot, state, outcome, degradeReasons)
  const published = publishRun(
    root,
    handle,
    {
      runId: snapshot.runId,
      files: {
        'digest.md': renderDigest(model),
        'run.json': `${JSON.stringify(runRecord(snapshot, state, outcome, degradeReasons), null, 2)}\n`,
      },
      candidates: state.accepted.map((item) =>
        toCandidateRecord(item.candidate),
      ),
      // The rename commits the run; coverage follows it in the same ledger write.
      coverage: {
        runId: snapshot.runId,
        indexed: snapshot.ruleVersions.map((rule) => ({
          ruleId: rule.id,
          hash: rule.sha256,
        })),
        covered: state.coveredRuleIds,
      },
    },
    { now: deps.now ?? Date.now },
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
  const released = releaseLock(handle)
  removeWorkDir(root, snapshot.runId)
  // The run is committed; a ledger that could not be written means its
  // candidates are proposed again next time, so the outcome is degraded.
  const ledgerWritten = published.ledger.written
  if (!ledgerWritten) addUnique(degradeReasons, 'ledger-write-failed')
  const finalOutcome = ledgerWritten ? outcome : 'degraded'
  const digestPath = path.join(published.runDir, 'digest.md')
  return success('publish', {
    outcome: finalOutcome,
    finalLine: `Connect ${finalOutcome}`,
    runId: snapshot.runId,
    runDir: published.runDir,
    digestPath,
    runRecordPath: path.join(published.runDir, 'run.json'),
    ledger: published.ledger,
    lockReleased: released === 'released',
    degradeReasons,
    candidates: state.accepted.length,
    recorded: state.recorded.length,
    summary: renderSummary(
      model,
      digestPath,
      path.join(published.runDir, 'run.json'),
    ),
  })
}

function publish(request: unknown, deps: HelperDeps): HelperResult {
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
    return commitRun(snapshot, state, handle, root, deps)
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

function ledgerShow(deps: HelperDeps): HelperResult {
  const prepared = prepare('ledger-show', deps)
  if (!prepared.ok) return prepared.result
  const read = readLedger(prepared.root)
  if (read.status !== 'ok') {
    return failure('ledger-show', 'ledger-unreadable', { detail: read.reason })
  }
  const entries = read.ledger.entries.slice(0, MAX_LEDGER_ENTRIES_SHOWN)
  return success('ledger-show', {
    total: read.ledger.entries.length,
    coverage: { rules: read.ledger.coverage?.length ?? 0 },
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
      case 'ledger-show':
        return ledgerShow(deps)
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

const REQUEST_OPS = new Set<Op>(['begin', 'validate', 'publish', 'decide'])

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

type CliRequest =
  | { readonly ok: true; readonly request: unknown }
  | { readonly ok: false; readonly exitCode: 2 }

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
    return { ok: false, exitCode: 2 }
  }
  const text = (options.readRequest ?? readStdinBounded)()
  const refuse = (reason: string): CliRequest => {
    out(JSON.stringify({ ok: false, op, outcome: 'failed', reason }))
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
  const result = runHelperOp(op, read.request, options.deps ?? {})
  out(JSON.stringify(result.body))
  return result.ok ? 0 : 1
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runConnectHelper({ argv: process.argv.slice(2) })
}
