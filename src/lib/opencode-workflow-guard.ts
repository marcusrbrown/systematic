import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from 'zod'
import { INTERNAL_AGENT_SIGNATURES } from './bootstrap.js'
import type {
  OpencodeOperationObserver,
  OperationObserverReasonCode,
  OperationObserverRemoteResult,
  OperationObserverRemoteSnapshot,
  OperationObserverResult,
  OperationObserverSnapshot,
  RegisteredWorktreeValidationResult,
  RemoteOperation,
} from './opencode-operation-observer.js'
import { createOpencodeOperationObserver } from './opencode-operation-observer.js'
import {
  classifyQuestionAnswer,
  createQuestionAttestation,
  type QuestionAttestationProjection,
  type QuestionChallengeRecord,
} from './question-attestation.js'
import type {
  ReceiptClassifier,
  ReceiptOperationObservation,
} from './receipt-classifier.js'
import {
  createReceiptLedger,
  isLocalOperation,
  type ReceiptClassification,
  type ReceiptEnvelope,
  type ReceiptLedger,
  type ReceiptOperation,
} from './receipt-ledger.js'
import {
  extractReceiptReadbackSeed,
  filterMarkersByRegistration,
  projectReceiptMintMarker,
  projectReceiptProgressionMarker,
  validateReceiptMarker,
} from './receipt-readback.js'
import {
  createWorkflowGuard,
  type EvidenceObservationResult,
  type RuntimeUnitPolicy,
  type StartUnitResult,
  type TransitionPrepareResult,
  type TransitionTarget,
  type WorkflowGuard,
  type WorkflowReasonCode,
  type WorkflowStatus,
} from './workflow-guard.js'

const MARKER_OPEN = '<SYSTEMATIC_WORKFLOW_GUARD>'
const MARKER_CLOSE = '</SYSTEMATIC_WORKFLOW_GUARD>'
const MARKER_PROTOCOL_VERSION = 2
// v1 markers are structurally identical to v2 (the v2 bump was coordinated
// with the receipt-envelope schema bump; MarkerSource itself gained no new
// fields), so a persisted v1 marker recovers cleanly under v2 parsing.
const LEGACY_MARKER_PROTOCOL_VERSION = 1
const MAX_MARKER_LENGTH = 4096
const MAX_MARKER_SOURCES = 8
const MAX_CALL_ID_LENGTH = 256
const MAX_SKILL_LENGTH = 128
const MAX_STATUS_LENGTH = 128
const MAX_HOST_OUTPUT_LENGTH = 32_768
export const SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY =
  'systematic_workflow_receipt'

const OPERATIONS: readonly ReceiptOperation[] = [
  'implementation',
  'verification',
  'commit',
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
]

const MANDATORY_REQUIRED_OPERATIONS: readonly ReceiptOperation[] = [
  'implementation',
  'verification',
]

const TRUSTED_SKILL_POLICIES: Readonly<
  Record<string, readonly ReceiptOperation[]>
> = Object.freeze({
  'ce-work': MANDATORY_REQUIRED_OPERATIONS,
  'git-commit': [...MANDATORY_REQUIRED_OPERATIONS, 'commit'],
  'git-commit-push-pr': [
    ...MANDATORY_REQUIRED_OPERATIONS,
    'commit',
    'push',
    'pr-creation',
    'check-readback',
    'review-readback',
  ],
})

const REPAIR_KINDS = new Set([
  'fresh-readback',
  'rerun-operation',
  'question-attestation',
])
const REASON_CODES = new Set([
  'abandoned-transition',
  'call-context-conflict',
  'cancelled-operation',
  'consumed-receipt',
  'disabled',
  'epoch-completed',
  'failed-operation',
  'family-conflict',
  'finalization-failed',
  'foreign-registration',
  'forbidden-field',
  'guard-unavailable',
  'incompatible-receipt',
  'invalid-configuration',
  'invalid-control',
  'invalid-receipt',
  'invalid-transition',
  'missing-evidence',
  'no-supported-repair',
  'no-active-epoch',
  'no-active-unit',
  'no-op-operation',
  'operation-not-required',
  'operation-target-mismatch',
  'readback-timeout',
  'receipt-mismatch',
  'rejected-operation',
  'resource-mismatch',
  'running-operation',
  'snapshot-blocked',
  'stale-receipt',
  'transition-finalized',
  'transition-terminal',
  'transition-replayed',
  'unattributed-operation',
  'unit-active',
  'unit-completed',
  'unit-incomplete',
  'unit-ready',
  'workspace-mismatch',
  'runtime-scope-conflict',
])

export interface OpencodeWorkflowGuardConfig {
  mode: 'observe' | 'protected' | 'disabled'
  debug: boolean
}

const WORKFLOW_GUARD_BLOCKED_ERROR_NAME = 'WorkflowGuardBlockedError'
const WORKFLOW_GUARD_BLOCKED_ERROR_CODE = 'workflow-guard-blocked'

export type WorkflowGuardBlockedError = Error & {
  readonly code: typeof WORKFLOW_GUARD_BLOCKED_ERROR_CODE
  readonly reasonCode: WorkflowReasonCode
}

export function createWorkflowGuardBlockedError(
  reasonCode: WorkflowReasonCode,
): WorkflowGuardBlockedError {
  const error = new Error('workflow guard blocked') as WorkflowGuardBlockedError
  error.name = WORKFLOW_GUARD_BLOCKED_ERROR_NAME
  Object.assign(error, {
    code: WORKFLOW_GUARD_BLOCKED_ERROR_CODE,
    reasonCode,
  })
  return error
}

export function isWorkflowGuardBlockedError(
  value: unknown,
): value is WorkflowGuardBlockedError {
  if (!(value instanceof Error)) return false
  if (value.name !== WORKFLOW_GUARD_BLOCKED_ERROR_NAME) return false
  const candidate = value as Error & {
    code?: unknown
    reasonCode?: unknown
  }
  if (candidate.code !== WORKFLOW_GUARD_BLOCKED_ERROR_CODE) return false
  return (
    typeof candidate.reasonCode === 'string' &&
    REASON_CODES.has(candidate.reasonCode)
  )
}

export interface OpencodeWorkflowGuardOptions {
  config: OpencodeWorkflowGuardConfig
  workspaceIdentity: string
  repositoryIdentity?: string
  worktreeIdentity?: string
  observer?: OpencodeOperationObserver
  classifier?: ReceiptClassifier
  runtimeRequiredOperations?: readonly ReceiptOperation[]
  hostReadback?: OpencodeWorkflowHostReadback
  readonly registrationIdentity?: string
  readonly sessionSalt?: Uint8Array
  readonly targetDirectory?: string
  readonly sessionLocation?: string
  /** Injectable clock (epoch milliseconds); defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Injectable factory for the observer of a registered linked-worktree target;
   * defaults to `createOpencodeOperationObserver`. A test seam: it lets tests
   * control a pinned worktree observer's snapshots.
   */
  readonly createTargetObserver?: (
    targetDirectory: string,
  ) => OpencodeOperationObserver
}

export interface OpencodeWorkflowChildSession {
  readonly sessionId: string
  readonly parentID?: string
}

export interface OpencodeWorkflowHostReadback {
  /**
   * Lenient read, used for child-session rollup: a host error or malformed
   * payload may be reported as `[]` (nothing to roll up), and only a thrown
   * read marks the parent unavailable.
   */
  readSessionParts(sessionID: string): Promise<ReadonlyArray<unknown>>
  /**
   * Strict read of the session's OWN history, used for initialization and
   * recovery. Must throw on a host error or malformed payload so a failed read
   * can never be mistaken for empty history. Optional only so injected readers
   * need no mass edits; when absent, initialization falls back to
   * `readSessionParts`, which then carries the same obligation to throw on
   * failure.
   */
  readSessionPartsStrict?(sessionID: string): Promise<ReadonlyArray<unknown>>
  listChildren(
    sessionID: string,
  ): Promise<ReadonlyArray<OpencodeWorkflowChildSession>>
}

export interface OpencodeWorkflowGuardHooks {
  'tool.execute.before': (input: unknown, output: unknown) => Promise<void>
  'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
  event: (input: unknown) => Promise<void>
  'experimental.chat.system.transform': (
    input: unknown,
    output: unknown,
  ) => Promise<void>
}

export interface OpencodeWorkflowGuard {
  readonly tools: Readonly<Record<string, ToolDefinition>>
  readonly hooks: OpencodeWorkflowGuardHooks
  status(sessionID: unknown): WorkflowStatus
  ledger(sessionID: unknown): ReceiptLedger | undefined
  observeReceipt(sessionID: unknown, input: unknown): EvidenceObservationResult
  prepareTransition(sessionID: unknown, input: unknown): TransitionPrepareResult
  startUnit(
    sessionID: unknown,
    input: unknown,
    policy?: RuntimeUnitPolicy,
  ): unknown
  /** @internal Test seam for the snapshot-block helpers. */
  snapshotBlock(sessionID: unknown): SnapshotBlockControls
}

function defaultTargetObserver(
  targetDirectory: string,
): OpencodeOperationObserver {
  return createOpencodeOperationObserver({ targetDirectory })
}

// The one ok/timeout/fatal split shared by every probe read (snapshots and
// effective-observer lookups) in both status refresh and completion. `timeout`
// is a `command-timeout` per `isProbeTimeout`; `fatal` is every other failure
// and carries the observer's reason code when one is known (a throw, target
// mismatch, or drift has none).
type ProbeFailure =
  | { readonly status: 'timeout' }
  | {
      readonly status: 'fatal'
      readonly reasonCode?: GuardUnavailableCause['reasonCode']
    }

type ProbeRead<T> = { readonly status: 'ok'; readonly value: T } | ProbeFailure

type CompletionRemoteOutcome =
  | {
      readonly status: 'ready'
      readonly readbacks: readonly {
        operation: RemoteOperation
        snapshot: OperationObserverRemoteSnapshot
      }[]
    }
  | ProbeFailure

// `none`: no observer. `timeout`: a probe timed out, so the attempt is
// retryable. `fatal`: any other readback failure.
type CompletionReadbackOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly readbacks: readonly unknown[] }
  | ProbeFailure

interface SessionRuntime {
  readonly ledger?: ReceiptLedger
  initialize(sessionID: string, allowFresh?: boolean): Promise<void>
  readonly hooks: OpencodeWorkflowGuardHooks
  status(): WorkflowStatus
  readStatus(): WorkflowStatus
  unavailableCause(): GuardUnavailableCause | undefined
  seedDeferrals(): readonly SeedDeferral[]
  readonly snapshotBlock: SnapshotBlockControls
  refreshReadback(): Promise<readonly UnconfirmedReadback[]>
  observeReceipt(input: unknown): EvidenceObservationResult
  prepareTransition(input: unknown): TransitionPrepareResult
  startUnit(input: unknown, policy?: RuntimeUnitPolicy): unknown
  control(sessionID: string, input: unknown): ToolResultContent
  markUnavailable(cause: GuardUnavailableCause): void
  metadata(): Record<string, unknown>
  recover(sessionID: string, allowFresh?: boolean): Promise<void>
}

interface HostToolBefore {
  tool: string
  sessionID: string
  callID: string
}

interface HostToolAfter extends HostToolBefore {
  args: unknown
}

interface HostOutput {
  title: string
  output: string
  metadata: unknown
}

interface PendingSkill {
  callID: string
  skill: string
}

interface PendingStart {
  callID: string
  input: unknown
  fingerprint: string
}

interface PendingComplete {
  callID: string
  target: TransitionTarget
  transitionId: string
}

interface PendingOperation {
  callID: string
  tool: 'write' | 'edit' | 'apply_patch' | 'bash'
  argsFingerprint: string
  targetRoot: string
  targetIdentity: string
  registeredWorktreeIdentity: string
  observer: OpencodeOperationObserver
  before: OperationObserverSnapshot
  /** Epoch and unit active when the before-hook began, before any await. */
  initiator?: OperationInitiator
  remoteOperation?: RemoteOperation
  remoteBefore?: OperationObserverRemoteResult
}

/**
 * Identifies the declaration an operation began under. The IDs alone cannot:
 * a redeclaration of a pristine active unit keeps both while resetting its
 * deferrals, so `generation` counts every successful unit start.
 */
interface OperationInitiator {
  readonly epochId: string
  readonly unitId: string
  readonly generation: number
}

interface OperationObserverRegistration {
  readonly targetRoot: string
  readonly registeredWorktreeIdentity: string
  readonly observer: OpencodeOperationObserver
}

interface EffectiveOperationObserver {
  readonly observer: OpencodeOperationObserver
  readonly targetIdentity: string
  readonly pinned: boolean
}

// A status-refresh probe that timed out and was skipped instead of failing
// the session. Status-only and enum-only: never carried in markers, receipts,
// tool metadata, or digests. At most six entries (local/pinned + four remote).
interface UnconfirmedReadback {
  readonly probe: 'local' | 'pinned' | RemoteOperation
  readonly reasonCode: 'command-timeout'
}

function unconfirmedReadback(
  probe: UnconfirmedReadback['probe'],
): UnconfirmedReadback {
  return { probe, reasonCode: 'command-timeout' }
}

// Remote probes that were skipped on a timeout. `fatal` is the first
// non-timeout failure, which stops the loop; the probes skipped before it are
// still reported.
type RemoteReadbackOutcome =
  | {
      readonly kind: 'ok'
      readonly unconfirmed: readonly UnconfirmedReadback[]
    }
  | {
      readonly kind: 'fatal'
      readonly unconfirmed: readonly UnconfirmedReadback[]
      readonly reasonCode?: GuardUnavailableCause['reasonCode']
    }

type OperationObserverRegistry = Map<string, OperationObserverRegistration>

interface RecoveredOperationContext {
  readonly targetIdentity: string
  readonly before: OperationObserverSnapshot
  readonly after: OperationObserverSnapshot
}

type RecoveredOperationRegistry = Map<string, RecoveredOperationContext>

interface PendingQuestionChallenge {
  readonly challenge: QuestionChallengeRecord
  readonly purpose: 'transition' | 'session-disablement'
  readonly resource: string
  readonly transition: string
  questionCallID?: string
  requestID?: string
}

interface SealedOperation {
  tool: PendingOperation['tool']
  argsFingerprint: string
}

// A call the observation gate skipped. It never took a snapshot or computed
// a fingerprint, so a replay is recognized by its call digest alone.
interface SkippedOperation {
  readonly skipped: true
}

interface BlockedComplete {
  target: TransitionTarget
  reasonCode: WorkflowReasonCode
}

interface TerminalComplete {
  // Optional: some terminal outcomes (see `finishUnreplayableComplete()`)
  // are recorded without ever having observed a real target. `target` is
  // not read back out of this record by `writeTerminalCompletionResult()`
  // — the target actually written to the tool result always comes from
  // that function's own `target` parameter — so leaving it unset here
  // costs nothing and avoids a fabricated placeholder in the evidence
  // record.
  target?: TransitionTarget
  status: 'rejected' | 'unavailable'
  reasonCode: WorkflowReasonCode
  // When true, a replay of this terminal outcome must only correct the
  // metadata (`writeAbandonedCompletionMetadata()`), never rewrite the
  // tool result's title/output. Set for outcomes where the host tool's
  // own title/output is evidence that must survive replay untouched.
  metadataOnly?: boolean
  // Title the first write used, when it was not the generic one, so a
  // replay reproduces the identical result.
  title?: string
}

type OperationCompletionResult =
  | {
      status: 'accepted'
      operation: ReceiptOperation
      after: OperationObserverSnapshot
    }
  | { status: 'deferred' | 'ignored' }
  | OperationFailure

// A typed after-hook failure: the pipeline stopped and says why. The cause is
// enum-only and is committed by `finishOperation` via `markUnavailable`.
interface OperationFailure {
  status: 'unavailable'
  cause: GuardUnavailableCause
}

interface MarkerSource {
  source: string
  state: WorkflowStatus['state']
  reasonCode: string
  repair?: string
  enforcement: OpencodeWorkflowGuardConfig['mode']
  statusDigest: string
  debug?: {
    operations: readonly ReceiptOperation[]
    satisfiedCount: number
    missingCount: number
    family: 'work' | 'shipping' | null
    status: 'active' | 'completed' | null
  }
}

interface MarkerDocument {
  protocolVersion: typeof MARKER_PROTOCOL_VERSION
  sources: readonly MarkerSource[]
  aggregate: {
    state: WorkflowStatus['state']
    reasonCode: string
    repair?: string
    enforcement: OpencodeWorkflowGuardConfig['mode']
    statusDigest: string
  }
}

// Bounded first-cause diagnostic for a failure that led to the guard going
// `unavailable`: a `seedRemoteScopes`/`seedRemoteScope` failure, a session
// initialization/recovery failure, or an observer readback failure.
// Enum-only: no call IDs, tool names, paths, or free text. Side-channel only: surfaced on
// `systematic_workflow_status` tool output (see `statusForTool`), never on a
// receipt envelope, marker envelope, or anything covered by an integrity
// digest. Never carries raw command output, paths, or tokens.
type GuardUnavailableCauseKind =
  | 'observer-not-configured'
  | 'local-snapshot-error'
  | 'local-snapshot-unavailable'
  | 'remote-scope-unreadable'
  | 'remote-scope-unavailable'
  | 'remote-readback-rejected'
  | 'history-read-failed'
  | 'markers-malformed-or-incompatible'
  | 'markers-ambiguous'
  | 'recovery-rejected'
  | 'markerless-guard-history'
  | 'observer-readback-failed'
  | 'operation-input-invalid'
  | 'operation-target-mismatch'
  | 'call-lifecycle-mismatch'
  | 'operation-classifier-unavailable'
  | 'operation-observation-rejected'
  | 'hook-threw'
  | 'transition-finalize-rejected'
  | 'initialization-threw'
  | 'unit-start-rejected'

// A remote operation whose activation seeding was deferred instead of
// failing the session. Status-only, enum-only, and bound to the unit that
// recorded it; never carried in markers, receipts, tool metadata, or digests.
type SeedDeferralReason = 'command-timeout' | 'missing-resource'

const SNAPSHOT_BLOCKING_REASONS = [
  'file-limit',
  'file-output-limit',
  'command-output-limit',
  'worktree-unstable',
] as const satisfies readonly OperationObserverReasonCode[]

// The observer reasons a worktree can cause on purpose: a local snapshot of
// the unit's effective target that fails with one of them blocks the unit
// instead of making the guard unavailable.
export type SnapshotBlockReason = (typeof SNAPSHOT_BLOCKING_REASONS)[number]

/** @internal Exported for tests; production call sites use it unexported. */
export function isSnapshotBlockingReason(
  reasonCode: unknown,
): reasonCode is SnapshotBlockReason {
  return (
    typeof reasonCode === 'string' &&
    (SNAPSHOT_BLOCKING_REASONS as readonly string[]).includes(reasonCode)
  )
}

// Per-unit runtime record of a snapshot block. Status-only and enum-only:
// never carried in markers, receipts, tool metadata, or digests.
interface SnapshotBlockRecord {
  readonly unitId: string
  readonly unitGeneration: number
  readonly targetIdentity: string
  readonly reasonCode: SnapshotBlockReason
}

// Outcome of trying to clear a block with a clean local snapshot. `timeout`
// leaves the decision to the caller; `fatal` means the guard has already been
// marked unavailable.
export type SnapshotBlockClearResult =
  | { readonly status: 'not-blocked' }
  | { readonly status: 'cleared' }
  | {
      readonly status: 'still-blocked'
      readonly reasonCode: SnapshotBlockReason
    }
  | { readonly status: 'stale' }
  | { readonly status: 'timeout' }
  | { readonly status: 'fatal' }

/**
 * @internal Test seam: drives the snapshot-block helpers of one session
 * without a hook that sets the block. `set` records a block on the unit's
 * effective target and returns false when there is no active unit.
 */
export interface SnapshotBlockControls {
  set(reasonCode: SnapshotBlockReason): boolean
  current(): { readonly reasonCode: SnapshotBlockReason } | undefined
  clear(): Promise<SnapshotBlockClearResult>
}

interface SeedDeferral {
  readonly operation: RemoteOperation
  readonly reasonCode: SeedDeferralReason
}

// A recorded deferral plus the observer and target the seed read from. Only a
// before-read from that same observer and target may bind the baseline.
interface DeferredSeed extends SeedDeferral {
  readonly observer: OpencodeOperationObserver
  readonly targetIdentity: string
}

type RemoteSeedOutcome =
  | { readonly kind: 'seeded' }
  | { readonly kind: 'tolerated' }
  | { readonly kind: 'deferred'; readonly reasonCode: SeedDeferralReason }
  | { readonly kind: 'fatal'; readonly cause: GuardUnavailableCause }

type GuardHookCauseSite =
  | 'tool-before'
  | 'tool-after'
  | 'event'
  | 'transform'
  | 'tool-execute'

interface GuardUnavailableCause {
  readonly site:
    | 'seed-remote-scopes'
    | 'seed-remote-scope'
    | 'initialize-session'
    | 'refresh-readback'
    | 'complete-readback'
    | GuardHookCauseSite
  readonly kind: GuardUnavailableCauseKind
  readonly operation?: RemoteOperation
  readonly reasonCode?:
    | OperationObserverReasonCode
    | WorkflowReasonCode
    | SeedDeferralReason
  readonly timedOut: boolean
}

function initializationCause(
  kind: Extract<
    GuardUnavailableCauseKind,
    | 'history-read-failed'
    | 'markers-malformed-or-incompatible'
    | 'markers-ambiguous'
    | 'recovery-rejected'
    | 'markerless-guard-history'
    | 'initialization-threw'
  >,
): GuardUnavailableCause {
  return { site: 'initialize-session', kind, timedOut: false }
}

// Builds the refresh-path cause. `reasonCode` is the observer's own reason when
// one is known; a throw has none. `timedOut` mirrors a `command-timeout`.
function observerReadbackFailedCause(
  reasonCode?: GuardUnavailableCause['reasonCode'],
  site: 'refresh-readback' | 'complete-readback' = 'refresh-readback',
): GuardUnavailableCause {
  return {
    site,
    kind: 'observer-readback-failed',
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    timedOut: reasonCode === 'command-timeout',
  }
}

// Builds a hook-path cause. `reasonCode` is an enum the failing check itself
// supplied (an observer or validation reason); a throw or a pure mismatch has
// none. `timedOut` mirrors a `command-timeout`.
function hookCause(
  site: GuardHookCauseSite,
  kind: GuardUnavailableCauseKind,
  reasonCode?: GuardUnavailableCause['reasonCode'],
): GuardUnavailableCause {
  return {
    site,
    kind,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    timedOut: reasonCode === 'command-timeout',
  }
}

function beforeCause(
  kind: GuardUnavailableCauseKind,
  reasonCode?: GuardUnavailableCause['reasonCode'],
): GuardUnavailableCause {
  return hookCause('tool-before', kind, reasonCode)
}

function afterCause(
  kind: GuardUnavailableCauseKind,
  reasonCode?: GuardUnavailableCause['reasonCode'],
): GuardUnavailableCause {
  return hookCause('tool-after', kind, reasonCode)
}

function afterFailure(
  kind: GuardUnavailableCauseKind,
  reasonCode?: GuardUnavailableCause['reasonCode'],
): OperationFailure {
  return { status: 'unavailable', cause: afterCause(kind, reasonCode) }
}

// A throw (`undefined`) has no reason code.
function remoteFailureReason(
  result: OperationObserverRemoteResult | undefined,
): GuardUnavailableCause['reasonCode'] {
  if (result?.status === 'missing-resource') return 'missing-resource'
  if (result?.status === 'unavailable') return result.reasonCode
  return undefined
}

// Reads one observer's local snapshot as a `ProbeRead`. When an expected
// target identity is given, a snapshot for any other target is fatal. A
// failure carries the observer's reason code when it supplied one; a throw or
// a target mismatch has none.
async function readSnapshot(
  observer: OpencodeOperationObserver,
  expectedTargetIdentity?: string,
): Promise<ProbeRead<OperationObserverSnapshot>> {
  let result: OperationObserverResult
  try {
    result = await observer.snapshot()
  } catch {
    return { status: 'fatal' }
  }
  if (isProbeTimeout(result)) return { status: 'timeout' }
  if (result.status === 'unavailable') {
    return { status: 'fatal', reasonCode: result.reasonCode }
  }
  if (
    expectedTargetIdentity !== undefined &&
    result.snapshot.targetDigest !== expectedTargetIdentity
  ) {
    return { status: 'fatal' }
  }
  return { status: 'ok', value: result.snapshot }
}

// The only probe outcomes that count as a transient timeout: an observer
// snapshot or remote readback that is `unavailable` with `command-timeout`, or
// a worktree-registration lookup that is an `error` with `command-timeout`.
// Everything else (other reasons, `missing-resource`, `undefined`) is not.
function isProbeTimeout(
  result:
    | OperationObserverResult
    | OperationObserverRemoteResult
    | RegisteredWorktreeValidationResult
    | undefined,
): boolean {
  if (result === undefined) return false
  if (result.status !== 'unavailable' && result.status !== 'error') {
    return false
  }
  return result.reasonCode === 'command-timeout'
}

const startToolShape = {
  expected_operations: z
    .array(z.enum(OPERATIONS as [ReceiptOperation, ...ReceiptOperation[]]))
    .optional(),
  resource_scopes: z.record(z.string(), z.string()).optional(),
}
const completeToolShape = { target: z.enum(['unit', 'epoch']) }
const controlToolShape = {
  mode: z.enum(['protected', 'disabled', 'unavailable']),
}
const statusToolShape = {}
const startToolSchema = z.object(startToolShape).strict()
const completeToolSchema = z.object(completeToolShape).strict()
const controlToolSchema = z.object(controlToolShape).strict()
const statusToolSchema = z.object(statusToolShape).strict()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decodes a 64-char lowercase hex session salt string to Uint8Array. */
function decodeSessionSaltBytes(hex: string): Uint8Array | undefined {
  if (typeof hex !== 'string' || hex.length !== 64 || !/^[0-9a-f]+$/.test(hex))
    return undefined
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  )
}

function parseHostBefore(input: unknown): HostToolBefore | undefined {
  if (!isRecord(input)) return undefined
  if (
    !boundedString(input.tool, 128) ||
    !boundedString(input.sessionID, 256) ||
    !boundedString(input.callID, MAX_CALL_ID_LENGTH)
  ) {
    return undefined
  }
  return {
    tool: input.tool,
    sessionID: input.sessionID,
    callID: input.callID,
  }
}

function parseHostAfter(input: unknown): HostToolAfter | undefined {
  const before = parseHostBefore(input)
  if (!before || !isRecord(input) || !('args' in input)) return undefined
  return { ...before, args: input.args }
}

interface ParseHostOutputOptions {
  /** Upper bound on `output.output` length; defaults to `MAX_HOST_OUTPUT_LENGTH`. */
  readonly maxOutputLength?: number
}

function parseHostOutput(
  output: unknown,
  options?: ParseHostOutputOptions,
): HostOutput | undefined {
  if (!isRecord(output)) return undefined
  const title = output.title === undefined ? '' : output.title
  const result = output.output === undefined ? '' : output.output
  const maxOutputLength = options?.maxOutputLength ?? MAX_HOST_OUTPUT_LENGTH
  if (
    typeof title !== 'string' ||
    title.length > MAX_STATUS_LENGTH ||
    typeof result !== 'string' ||
    result.length > maxOutputLength ||
    !('metadata' in output)
  ) {
    return undefined
  }
  if (isRecord(output.metadata)) {
    const status = output.metadata.status
    if (status === 'failure' || status === 'cancelled' || status === 'error') {
      return undefined
    }
  }
  return {
    title,
    output: result,
    metadata: output.metadata,
  }
}

// Allowlist of skill names that activate a guard epoch. A Map keeps lookups
// to own entries, so inherited names such as `constructor` or `__proto__`
// never resolve. Unlisted skills are deliberately not guarded.
const GUARDED_SKILL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['ce:work', 'ce-work'],
  ['systematic:ce:work', 'ce-work'],
  ['git-commit', 'git-commit'],
  ['systematic:git-commit', 'git-commit'],
  ['git-commit-push-pr', 'git-commit-push-pr'],
  ['systematic:git-commit-push-pr', 'git-commit-push-pr'],
])

function normalizeSkill(tool: string, args: unknown): string | undefined {
  if (tool !== 'systematic_skill' && tool !== 'skill') return undefined
  if (!isRecord(args) || !boundedString(args.name, MAX_SKILL_LENGTH)) {
    return undefined
  }
  return GUARDED_SKILL_ALIASES.get(args.name)
}

function trustedSkillPolicy(
  skill: string,
  additional: readonly ReceiptOperation[] = [],
): RuntimeUnitPolicy {
  const requiredOperations = [
    ...(TRUSTED_SKILL_POLICIES[skill] ?? MANDATORY_REQUIRED_OPERATIONS),
    ...additional,
  ]
  return {
    requiredOperations: [...new Set(requiredOperations)],
    resourceScopes: {},
  }
}

function normalizeStartInput(args: unknown): unknown {
  const parsed = startToolSchema.safeParse(args)
  if (!parsed.success) return undefined
  return {
    expectedOperations: parsed.data.expected_operations,
    resourceScopes: parsed.data.resource_scopes,
  }
}

function normalizeTarget(args: unknown): TransitionTarget | undefined {
  const parsed = completeToolSchema.safeParse(args)
  return parsed.success ? parsed.data.target : undefined
}

function digestCall(
  ledger: ReturnType<typeof createReceiptLedger>,
  callID: string,
): string {
  return ledger.digestIdentity('call', callID)
}

export type LocalOperationTool = 'write' | 'edit' | 'apply_patch' | 'bash'

type LocalOperationAfter = HostToolAfter & { tool: LocalOperationTool }

function isLocalOperationAfter(
  host: HostToolAfter,
): host is LocalOperationAfter {
  return isLocalOperationTool(host.tool)
}

function isLocalOperationTool(tool: string): tool is LocalOperationTool {
  return (
    tool === 'write' ||
    tool === 'edit' ||
    tool === 'apply_patch' ||
    tool === 'bash'
  )
}

export interface OpencodeOperationTargetDerivationOptions {
  readonly parentTargetRoot: string
  readonly sessionLocation?: string
  readonly validateRegisteredWorktree: (
    candidateDirectory: string,
  ) => RegisteredWorktreeValidationResult
  readonly realPath?: (filePath: string) => string
}

export type OpencodeOperationTargetDerivationResult =
  | { readonly status: 'available'; readonly targetRoot: string }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: 'target-unavailable'
    }

function unavailableOperationTarget(): OpencodeOperationTargetDerivationResult {
  return { status: 'unavailable', reasonCode: 'target-unavailable' }
}

function canonicalExistingPath(
  filePath: string,
  realPath: (filePath: string) => string,
): string | undefined {
  try {
    return realPath(filePath)
  } catch {
    return undefined
  }
}

function registeredWorktreeIdentity(
  validation: RegisteredWorktreeValidationResult,
): string | undefined {
  return validation.status === 'ok'
    ? `${validation.gitDir}\n${validation.commonDir}`
    : undefined
}

function canonicalFileTarget(
  filePath: string,
  realPath: (filePath: string) => string,
): string | undefined {
  const existing = canonicalExistingPath(filePath, realPath)
  if (existing) return existing
  const parent = canonicalExistingPath(path.dirname(filePath), realPath)
  const basename = path.basename(filePath)
  return parent && basename && basename !== '.' && basename !== '..'
    ? path.join(parent, basename)
    : undefined
}

function pathWithinOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function targetIsGitAdminStorage(
  targetPath: string,
  validation: Extract<
    RegisteredWorktreeValidationResult,
    { readonly status: 'ok' }
  >,
): boolean {
  return (
    pathWithinOrEqual(path.join(validation.targetRoot, '.git'), targetPath) ||
    pathWithinOrEqual(validation.gitDir, targetPath) ||
    pathWithinOrEqual(validation.commonDir, targetPath)
  )
}

function targetResultFromValidation(
  candidatePath: string,
  validation: RegisteredWorktreeValidationResult,
): OpencodeOperationTargetDerivationResult {
  if (validation.status === 'error') return unavailableOperationTarget()
  if (!pathWithinOrEqual(validation.targetRoot, candidatePath)) {
    return unavailableOperationTarget()
  }
  if (targetIsGitAdminStorage(candidatePath, validation)) {
    return unavailableOperationTarget()
  }
  return { status: 'available', targetRoot: validation.targetRoot }
}

function trustedParentTarget(
  parentTargetRoot: string,
  candidatePath: string,
): OpencodeOperationTargetDerivationResult | undefined {
  if (!pathWithinOrEqual(parentTargetRoot, candidatePath)) return undefined
  if (pathWithinOrEqual(path.join(parentTargetRoot, '.git'), candidatePath)) {
    return unavailableOperationTarget()
  }
  return { status: 'available', targetRoot: parentTargetRoot }
}

function validationForCandidate(
  candidatePath: string,
  options: OpencodeOperationTargetDerivationOptions,
  targetPath = candidatePath,
): OpencodeOperationTargetDerivationResult {
  try {
    return targetResultFromValidation(
      targetPath,
      options.validateRegisteredWorktree(candidatePath),
    )
  } catch {
    return unavailableOperationTarget()
  }
}

function deriveFileTarget(
  rawPath: string,
  baseDirectory: string,
  parentTargetRoot: string,
  options: OpencodeOperationTargetDerivationOptions,
  realPath: (filePath: string) => string,
  allowParentFastPath = true,
): OpencodeOperationTargetDerivationResult {
  const resolvedPath = path.resolve(baseDirectory, rawPath)
  const canonicalPath = canonicalFileTarget(resolvedPath, realPath)
  if (!canonicalPath) return unavailableOperationTarget()
  const parentResult =
    allowParentFastPath && !path.isAbsolute(rawPath)
      ? trustedParentTarget(parentTargetRoot, canonicalPath)
      : undefined
  if (parentResult) return parentResult
  return validationForCandidate(
    path.dirname(canonicalPath),
    options,
    canonicalPath,
  )
}

interface DerivedDirectoryTarget {
  readonly targetRoot: string
  readonly resolvedPath: string
}

function sharedTargetRoot(
  targets: readonly OpencodeOperationTargetDerivationResult[],
  extraRoots: readonly string[] = [],
): string | undefined {
  const roots = [...extraRoots]
  for (const target of targets) {
    if (target.status === 'unavailable') return undefined
    roots.push(target.targetRoot)
  }
  const targetRoot = roots[0]
  return targetRoot && roots.every((root) => root === targetRoot)
    ? targetRoot
    : undefined
}

function deriveDirectoryTarget(
  rawPath: string,
  baseDirectory: string,
  parentTargetRoot: string,
  options: OpencodeOperationTargetDerivationOptions,
  realPath: (filePath: string) => string,
):
  | { readonly status: 'available'; readonly target: DerivedDirectoryTarget }
  | { readonly status: 'unavailable' } {
  const resolvedPath = canonicalExistingPath(
    path.resolve(baseDirectory, rawPath),
    realPath,
  )
  if (!resolvedPath) return { status: 'unavailable' }
  const parentResult = path.isAbsolute(rawPath)
    ? undefined
    : trustedParentTarget(parentTargetRoot, resolvedPath)
  if (parentResult?.status === 'unavailable') {
    return { status: 'unavailable' }
  }
  if (parentResult) {
    return {
      status: 'available',
      target: { targetRoot: parentResult.targetRoot, resolvedPath },
    }
  }
  const validated = validationForCandidate(resolvedPath, options)
  return validated.status === 'available'
    ? {
        status: 'available',
        target: { targetRoot: validated.targetRoot, resolvedPath },
      }
    : { status: 'unavailable' }
}

const PATCH_FILE_PREFIXES = [
  '*** Add File:',
  '*** Delete File:',
  '*** Update File:',
  '*** Move to:',
] as const

function patchTextFileTargets(
  patchText: string,
): readonly string[] | undefined {
  const paths: string[] = []
  for (const line of patchText.split(/\r?\n/)) {
    const prefix = PATCH_FILE_PREFIXES.find((candidate) =>
      line.startsWith(candidate),
    )
    if (!prefix) continue
    const filePath = line.slice(prefix.length).trim()
    if (!filePath) return undefined
    paths.push(filePath)
  }
  return paths
}

function hunkFileTargets(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const paths: string[] = []
  for (const hunk of value) {
    if (!isRecord(hunk) || typeof hunk.path !== 'string' || !hunk.path) {
      return undefined
    }
    paths.push(hunk.path)
    if (hunk.move_path === undefined) continue
    if (typeof hunk.move_path !== 'string' || !hunk.move_path) return undefined
    paths.push(hunk.move_path)
  }
  return paths
}

function patchFileTargets(
  args: Record<string, unknown>,
): readonly string[] | undefined {
  const patchValue = args.patchText ?? args.patch
  if (typeof patchValue === 'string') return patchTextFileTargets(patchValue)
  if (patchValue !== undefined) return undefined
  return args.hunks === undefined ? [] : hunkFileTargets(args.hunks)
}

function fileTargetArguments(
  args: Record<string, unknown>,
): string[] | undefined {
  const paths: string[] = []
  for (const key of ['filePath', 'path'] as const) {
    if (!(key in args)) continue
    if (typeof args[key] !== 'string' || args[key].length === 0) {
      return undefined
    }
    paths.push(args[key])
  }
  return paths.length > 0 ? paths : undefined
}

function deriveFileOperationTarget(
  args: Record<string, unknown>,
  sessionLocation: string,
  parentTargetRoot: string,
  options: OpencodeOperationTargetDerivationOptions,
  realPath: (filePath: string) => string,
): OpencodeOperationTargetDerivationResult {
  const paths = fileTargetArguments(args)
  if (!paths) return unavailableOperationTarget()
  const targets = paths.map((rawPath) =>
    deriveFileTarget(
      rawPath,
      sessionLocation,
      parentTargetRoot,
      options,
      realPath,
    ),
  )
  const targetRoot = sharedTargetRoot(targets)
  return targetRoot
    ? { status: 'available', targetRoot }
    : unavailableOperationTarget()
}

function deriveApplyPatchTarget(
  args: Record<string, unknown>,
  sessionLocation: string,
  parentTargetRoot: string,
  options: OpencodeOperationTargetDerivationOptions,
  realPath: (filePath: string) => string,
): OpencodeOperationTargetDerivationResult {
  if (
    args.workdir !== undefined &&
    (typeof args.workdir !== 'string' || args.workdir.length === 0)
  ) {
    return unavailableOperationTarget()
  }
  const patchPaths = patchFileTargets(args)
  if (!patchPaths) return unavailableOperationTarget()
  const workdir =
    args.workdir === undefined
      ? {
          status: 'available' as const,
          target: {
            targetRoot: parentTargetRoot,
            resolvedPath: sessionLocation,
          },
        }
      : deriveDirectoryTarget(
          args.workdir,
          sessionLocation,
          parentTargetRoot,
          options,
          realPath,
        )
  if (workdir.status === 'unavailable') return unavailableOperationTarget()
  const targets = patchPaths.map((rawPath) =>
    deriveFileTarget(
      rawPath,
      workdir.target.resolvedPath,
      parentTargetRoot,
      options,
      realPath,
      args.workdir === undefined,
    ),
  )
  // When workdir is absent and the patch names files, those targets alone
  // determine the shared root (consistent with deriveFileOperationTarget).
  // Seeding the parent root here would reject absolute paths into a registered
  // worktree (#743). An explicit workdir — or a patch with no file targets —
  // still contributes the workdir root, preserving the spanning guard and the
  // parent fallback for fileless patches.
  const seedWorkdirRoot = args.workdir !== undefined || targets.length === 0
  const targetRoot = sharedTargetRoot(
    targets,
    seedWorkdirRoot ? [workdir.target.targetRoot] : [],
  )
  return targetRoot
    ? { status: 'available', targetRoot }
    : unavailableOperationTarget()
}

function deriveBashTarget(
  args: Record<string, unknown>,
  sessionLocation: string,
  parentTargetRoot: string,
  options: OpencodeOperationTargetDerivationOptions,
  realPath: (filePath: string) => string,
): OpencodeOperationTargetDerivationResult {
  if (args.workdir === undefined) {
    return { status: 'available', targetRoot: parentTargetRoot }
  }
  if (typeof args.workdir !== 'string' || args.workdir.length === 0) {
    return unavailableOperationTarget()
  }
  const candidatePath = canonicalExistingPath(
    path.resolve(sessionLocation, args.workdir),
    realPath,
  )
  if (!candidatePath) return unavailableOperationTarget()
  const parentResult = path.isAbsolute(args.workdir)
    ? undefined
    : trustedParentTarget(parentTargetRoot, candidatePath)
  return parentResult ?? validationForCandidate(candidatePath, options)
}

export function deriveOpencodeOperationTarget(
  tool: LocalOperationTool,
  args: unknown,
  options: OpencodeOperationTargetDerivationOptions,
): OpencodeOperationTargetDerivationResult {
  const realPath = options.realPath ?? fs.realpathSync
  const parentTargetRoot = canonicalExistingPath(
    options.parentTargetRoot,
    realPath,
  )
  if (!parentTargetRoot) return unavailableOperationTarget()

  if (!isRecord(args)) return unavailableOperationTarget()

  const sessionLocation = canonicalExistingPath(
    options.sessionLocation ?? parentTargetRoot,
    realPath,
  )
  if (!sessionLocation) return unavailableOperationTarget()

  if (tool === 'write' || tool === 'edit') {
    return deriveFileOperationTarget(
      args,
      sessionLocation,
      parentTargetRoot,
      options,
      realPath,
    )
  }
  if (tool === 'apply_patch') {
    return deriveApplyPatchTarget(
      args,
      sessionLocation,
      parentTargetRoot,
      options,
      realPath,
    )
  }
  return tool === 'bash'
    ? deriveBashTarget(
        args,
        sessionLocation,
        parentTargetRoot,
        options,
        realPath,
      )
    : unavailableOperationTarget()
}

function serializeStableArray(
  value: readonly unknown[],
  depth: number,
): string | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined
  const entries: string[] = []
  for (const entry of value) {
    const serialized = stableSerialize(entry, depth + 1)
    if (serialized === undefined) return undefined
    entries.push(serialized)
  }
  return `[${entries.join(',')}]`
}

function serializeStableRecord(
  value: Record<string, unknown>,
  depth: number,
): string | undefined {
  const entries: string[] = []
  for (const key of Object.keys(value).sort()) {
    const serialized = stableSerialize(value[key], depth + 1)
    if (serialized === undefined) return undefined
    entries.push(`${JSON.stringify(key)}:${serialized}`)
  }
  return `{${entries.join(',')}}`
}

// Accepts an object whose prototype is null or whose prototype's prototype is
// null (ordinary and cross-realm plain objects). A prototype that is itself a
// null-prototype object also passes; its inherited keys are not fingerprinted.
function isPlainObject(value: object): boolean {
  const prototype: object | null = Object.getPrototypeOf(value)
  if (prototype === null) return true
  const parent: object | null = Object.getPrototypeOf(prototype)
  return parent === null
}

function stableSerialize(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return serializeStableArray(value, depth)
  if (!isRecord(value) || !isPlainObject(value)) return undefined
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined
  return serializeStableRecord(value, depth)
}

function canonicalPatchText(
  patchText: string,
  sessionLocation: string,
): string | undefined {
  if (patchTextFileTargets(patchText) === undefined) return undefined
  const segments = patchText.split(/(\r?\n)/)
  for (const [index, line] of segments.entries()) {
    if (line === '\n' || line === '\r\n') continue
    const prefix = PATCH_FILE_PREFIXES.find((candidate) =>
      line.startsWith(candidate),
    )
    if (!prefix) continue
    const filePath = line.slice(prefix.length).trim()
    if (!filePath) return undefined
    segments[index] = `${prefix}${path.resolve(sessionLocation, filePath)}`
  }
  return segments.join('')
}

function canonicalHunks(
  value: unknown,
  sessionLocation: string,
): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined
  const hunks: Record<string, unknown>[] = []
  for (const hunk of value) {
    if (!isRecord(hunk) || typeof hunk.path !== 'string' || !hunk.path) {
      return undefined
    }
    const canonical: Record<string, unknown> = {
      ...hunk,
      path: path.resolve(sessionLocation, hunk.path),
    }
    if (hunk.move_path !== undefined) {
      if (typeof hunk.move_path !== 'string' || !hunk.move_path) {
        return undefined
      }
      canonical.move_path = path.resolve(sessionLocation, hunk.move_path)
    }
    hunks.push(canonical)
  }
  return hunks
}

function canonicalOperationArgs(
  tool: LocalOperationTool,
  args: unknown,
  sessionLocation: string,
): unknown {
  if (tool !== 'apply_patch' || !isRecord(args) || !isPlainObject(args)) {
    return args
  }
  const patchPaths = patchFileTargets(args)
  if (patchPaths === undefined) return args
  const patchValue = args.patchText ?? args.patch
  if (typeof patchValue === 'string') {
    const canonical = canonicalPatchText(patchValue, sessionLocation)
    if (canonical === undefined) return args
    const patchKey = typeof args.patchText === 'string' ? 'patchText' : 'patch'
    return { ...args, [patchKey]: canonical }
  }
  if (patchPaths.length === 0) return args
  const hunks = canonicalHunks(args.hunks, sessionLocation)
  return hunks === undefined ? args : { ...args, hunks }
}

function argsFingerprint(
  ledger: ReturnType<typeof createReceiptLedger>,
  tool: LocalOperationTool,
  args: unknown,
  sessionLocation: string,
): string | undefined {
  // Canonicalization copies into fresh plain objects, which would launder
  // non-plain hunks and hidden symbol keys; reject those on the original first.
  if (stableSerialize(args) === undefined) return undefined
  const serialized = stableSerialize(
    canonicalOperationArgs(tool, args, sessionLocation),
  )
  return serialized === undefined
    ? undefined
    : ledger.digestIdentity('call', serialized)
}

function bashCommand(args: unknown): string | undefined {
  return isRecord(args) &&
    typeof args.command === 'string' &&
    args.command.length > 0
    ? args.command
    : undefined
}

function operationCandidate(tool: LocalOperationTool): ReceiptOperation {
  return tool === 'bash' ? 'verification' : 'implementation'
}

async function classifyCommandIntent(
  classifier: ReceiptClassifier | undefined,
  command: string,
): Promise<ReceiptClassification | undefined> {
  if (!classifier) return undefined
  try {
    return await classifier.classify({
      command,
      terminal: { status: 'success', output: 'non-empty', noOp: false },
    })
  } catch {
    return undefined
  }
}

function terminalForOutput(
  tool: LocalOperationTool,
  output: HostOutput,
): ReceiptOperationObservation['terminal'] {
  if (tool === 'bash') {
    const exit = isRecord(output.metadata) ? output.metadata.exit : undefined
    return {
      status:
        typeof exit === 'number'
          ? exit === 0
            ? 'success'
            : 'failure'
          : 'unknown',
      output: output.output.length === 0 ? 'empty' : 'non-empty',
      noOp: false,
    }
  }
  return {
    status: 'success',
    output: 'non-empty',
    noOp: false,
  }
}

function localOperation(
  operation: ReceiptOperation | null,
): operation is 'implementation' | 'verification' | 'commit' {
  return operation !== null && isLocalOperation(operation)
}

function remoteOperation(
  operation: ReceiptOperation | null,
): operation is RemoteOperation {
  return (
    operation === 'push' ||
    operation === 'pr-creation' ||
    operation === 'check-readback' ||
    operation === 'review-readback'
  )
}

function remoteReadbackInput(
  operation: RemoteOperation,
  local: OperationObserverSnapshot,
  workspaceIdentity: string,
  snapshot: OperationObserverRemoteSnapshot,
  includeRevision = true,
): Record<string, unknown> {
  return {
    operation,
    workspaceIdentity,
    repositoryIdentity: local.repositoryRevisionDigest,
    worktreeIdentity: local.worktreeRevisionDigest,
    resourceIdentity: snapshot.resourceIdentity,
    ...(includeRevision
      ? { resourceRevisionIdentity: snapshot.resourceRevisionIdentity }
      : {}),
    ...(snapshot.pullRequest ? { pullRequest: snapshot.pullRequest } : {}),
    ...(snapshot.checkState ? { checkState: snapshot.checkState } : {}),
    ...(snapshot.reviewDecision
      ? { reviewDecision: snapshot.reviewDecision }
      : {}),
  }
}

function isSuccessfulAfter(output: unknown): output is HostOutput {
  return parseHostOutput(output) !== undefined
}

/**
 * `isSuccessfulAfter` without the output length cap: skill bodies routinely
 * exceed it, and skill completion needs only the success signal.
 */
function isSuccessfulSkillAfter(output: unknown): output is HostOutput {
  return (
    parseHostOutput(output, { maxOutputLength: Number.POSITIVE_INFINITY }) !==
    undefined
  )
}

function statusForTool(
  status: WorkflowStatus,
  unavailableCause?: GuardUnavailableCause,
  seedDeferrals: readonly SeedDeferral[] = [],
  unconfirmedReadbacks: readonly UnconfirmedReadback[] = [],
  snapshotBlock?: { readonly reasonCode: SnapshotBlockReason },
): string {
  return JSON.stringify({
    state: status.state,
    reasonCode: status.reasonCode,
    ...(status.repair ? { repair: status.repair } : {}),
    satisfiedOperations: status.satisfiedOperations,
    missingOperations: status.missingOperations,
    // Mode has no path back to 'protected', but 'unavailable' -> 'disabled'
    // is reachable via attested control. Emit only while still unavailable
    // so the field doesn't outlive the state it describes.
    ...(unavailableCause && status.state === 'unavailable'
      ? { firstUnavailableCause: unavailableCause }
      : {}),
    // Operations whose activation seeding was deferred for the current unit;
    // shown in any state.
    ...(seedDeferrals.length > 0 ? { seedDeferrals } : {}),
    // The unit's active snapshot block; shown in any state, never persisted.
    ...(snapshotBlock ? { snapshotBlock } : {}),
    // Status-refresh probes skipped on a timeout in this call; shown in any
    // state, never persisted.
    ...(unconfirmedReadbacks.length > 0 ? { unconfirmedReadbacks } : {}),
  })
}

interface ToolResult {
  title: string
  output: string
  metadata: Record<string, unknown>
}

interface ToolResultContent {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

function markerStatusRank(state: WorkflowStatus['state']): number {
  const ranks = {
    disabled: 0,
    inactive: 1,
    protected: 2,
    waiting: 3,
    rejected: 4,
    unavailable: 5,
  } satisfies Record<WorkflowStatus['state'], number>
  return ranks[state]
}

function isWorkflowState(value: unknown): value is WorkflowStatus['state'] {
  return (
    value === 'protected' ||
    value === 'waiting' ||
    value === 'rejected' ||
    value === 'disabled' ||
    value === 'unavailable' ||
    value === 'inactive'
  )
}

function parseMarkerDebug(value: unknown): MarkerSource['debug'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !Array.isArray(value.operations)) return undefined
  const satisfiedCount = value.satisfiedCount
  const missingCount = value.missingCount
  if (
    value.operations.length > OPERATIONS.length ||
    value.operations.some(
      (operation) => !OPERATIONS.includes(operation as ReceiptOperation),
    ) ||
    typeof satisfiedCount !== 'number' ||
    !Number.isInteger(satisfiedCount) ||
    typeof missingCount !== 'number' ||
    !Number.isInteger(missingCount) ||
    (typeof value.family !== 'string' && value.family !== null) ||
    (value.family !== null &&
      value.family !== 'work' &&
      value.family !== 'shipping') ||
    (typeof value.status !== 'string' && value.status !== null) ||
    (value.status !== null &&
      value.status !== 'active' &&
      value.status !== 'completed')
  ) {
    return undefined
  }
  return {
    operations: Object.freeze([...value.operations] as ReceiptOperation[]),
    satisfiedCount,
    missingCount,
    family: value.family,
    status: value.status,
  }
}

function parseMarkerSource(value: unknown): MarkerSource | undefined {
  if (!isRecord(value)) return undefined
  if (
    !boundedString(value.source, 256) ||
    !isWorkflowState(value.state) ||
    !boundedString(value.reasonCode, MAX_STATUS_LENGTH) ||
    !REASON_CODES.has(value.reasonCode) ||
    !(
      value.enforcement === 'observe' ||
      value.enforcement === 'protected' ||
      value.enforcement === 'disabled'
    ) ||
    !boundedString(value.statusDigest, 256)
  ) {
    return undefined
  }
  const result: MarkerSource = {
    source: value.source,
    state: value.state,
    reasonCode: value.reasonCode,
    enforcement: value.enforcement,
    statusDigest: value.statusDigest,
  }
  if (
    value.repair !== undefined &&
    (!boundedString(value.repair, MAX_STATUS_LENGTH) ||
      !REPAIR_KINDS.has(value.repair))
  ) {
    return undefined
  }
  if (value.repair !== undefined) result.repair = value.repair
  if (value.debug !== undefined) {
    const debug = parseMarkerDebug(value.debug)
    if (!debug) return undefined
    result.debug = debug
  }
  return result
}

function parseMarkerBody(body: string): MarkerSource[] | undefined {
  if (body.length > MAX_MARKER_LENGTH) return undefined
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (
      parsed.protocolVersion !== MARKER_PROTOCOL_VERSION &&
      parsed.protocolVersion !== LEGACY_MARKER_PROTOCOL_VERSION
    ) {
      return undefined
    }
    if (
      !Array.isArray(parsed.sources) ||
      parsed.sources.length > MAX_MARKER_SOURCES
    ) {
      return undefined
    }
    const sources = parsed.sources.map(parseMarkerSource)
    return sources.every(
      (source): source is MarkerSource => source !== undefined,
    )
      ? sources
      : undefined
  } catch {
    return undefined
  }
}

function removeMarkersFromEntry(entry: string): {
  entry: string
  sources: MarkerSource[]
  malformed: boolean
} {
  const sources: MarkerSource[] = []
  let result = ''
  let cursor = 0
  let malformed = false
  while (cursor < entry.length) {
    const start = entry.indexOf(MARKER_OPEN, cursor)
    if (start === -1) {
      result += entry.slice(cursor)
      break
    }
    result += entry.slice(cursor, start)
    const bodyStart = start + MARKER_OPEN.length
    const close = entry.indexOf(MARKER_CLOSE, bodyStart)
    if (close === -1) {
      malformed = true
      result += entry.slice(bodyStart)
      break
    }
    const parsed = parseMarkerBody(entry.slice(bodyStart, close))
    if (parsed === undefined) {
      malformed = true
    } else {
      sources.push(...parsed)
    }
    cursor = close + MARKER_CLOSE.length
  }
  return { entry: result, sources, malformed }
}

function extractMarkerSources(system: readonly string[]): {
  sources: MarkerSource[]
  entries: string[]
  malformed: boolean
} {
  const extracted = system.map(removeMarkersFromEntry)
  return {
    sources: extracted.flatMap((result) => result.sources),
    entries: extracted.map((result) => result.entry),
    malformed: extracted.some((result) => result.malformed),
  }
}

function selectMarkerSources(
  sources: readonly MarkerSource[],
  current: MarkerSource,
): { sources: MarkerSource[]; overflow: boolean; worst: MarkerSource } {
  const bySource = new Map(sources.map((source) => [source.source, source]))
  bySource.set(current.source, current)
  const allSources = [...bySource.values()].sort(
    (left, right) =>
      markerStatusRank(right.state) - markerStatusRank(left.state) ||
      left.source.localeCompare(right.source),
  )
  const worst = allSources[0] ?? current
  if (allSources.length <= MAX_MARKER_SOURCES) {
    return {
      sources: [...allSources].sort((left, right) =>
        left.source.localeCompare(right.source),
      ),
      overflow: false,
      worst,
    }
  }
  const selected = new Map<string, MarkerSource>()
  selected.set(current.source, current)
  selected.set(worst.source, worst)
  for (const source of allSources) {
    if (selected.size >= MAX_MARKER_SOURCES) break
    selected.set(source.source, source)
  }
  return {
    sources: [...selected.values()].sort((left, right) =>
      left.source.localeCompare(right.source),
    ),
    overflow: true,
    worst,
  }
}

function buildMarker(
  sources: readonly MarkerSource[],
  malformed: boolean,
  current: MarkerSource,
): string {
  const selected = selectMarkerSources(sources, current)
  const aggregate =
    malformed || selected.overflow
      ? {
          state: 'unavailable' as const,
          reasonCode: 'guard-unavailable',
          enforcement: selected.worst.enforcement,
          statusDigest: selected.worst.statusDigest,
        }
      : {
          state: selected.worst.state,
          reasonCode: selected.worst.reasonCode,
          ...(selected.worst.repair ? { repair: selected.worst.repair } : {}),
          enforcement: selected.worst.enforcement,
          statusDigest: selected.worst.statusDigest,
        }
  const document: MarkerDocument = {
    protocolVersion: MARKER_PROTOCOL_VERSION,
    sources: selected.sources,
    aggregate,
  }
  return `${MARKER_OPEN}${JSON.stringify(document)}${MARKER_CLOSE}`
}

function createSessionRuntime(
  options: OpencodeWorkflowGuardOptions,
  operationObservers: OperationObserverRegistry,
  recoveredOperationContexts: RecoveredOperationRegistry,
  runtimeStartedAt: number,
): SessionRuntime {
  let ledger!: ReceiptLedger
  let guard: WorkflowGuard | undefined
  let initialized = false
  let initializationPromise: Promise<void> | undefined
  let retryableEmptyHistory = false
  const pendingSkills = new Map<string, PendingSkill>()
  const completedSkillCalls = new Map<string, string>()
  const pendingStarts = new Map<string, PendingStart>()
  const pendingCompletes = new Map<string, PendingComplete>()
  const finalizedCompletes = new Map<string, PendingComplete>()
  const abandonedCompletes = new Map<string, TransitionTarget>()
  const blockedCompletes = new Map<string, BlockedComplete>()
  const terminalCompletes = new Map<string, TerminalComplete>()
  const callBindings = new Map<string, { kind: string; fingerprint: string }>()
  const pendingOperations = new Map<string, PendingOperation>()
  const sealedOperations = new Map<string, SealedOperation>()
  // Digests of operation calls whose before-hook decided not to observe.
  // The after-hook consults this first and stays silent, whatever the guard
  // state has become in between. Entries outlive their first after-hook so a
  // duplicate stays silent, and move to `abandonedOperations` at the transform.
  const skippedOperations = new Set<string>()
  const abandonedOperations = new Map<
    string,
    SealedOperation | SkippedOperation
  >()
  const rolledUpChildren = new Set<string>()
  const questionAttestation = createQuestionAttestation()
  const pendingQuestionChallenges = new Map<string, PendingQuestionChallenge>()
  const blockedQuestionCalls = new Map<string, string>()
  const consumedQuestionTargets = new Set<TransitionTarget>()
  let firstUnavailableCause: GuardUnavailableCause | undefined
  // Cause from a `markUnavailable` that arrived before a guard was published;
  // committed first-wins on publish.
  let pendingUnavailableCause: GuardUnavailableCause | undefined
  // Deferred activation seedings, keyed by the unit that recorded them and
  // cleared at every unit start. Runtime-only; never persisted.
  let seedDeferralRecord:
    | { readonly unitId: string; readonly entries: DeferredSeed[] }
    | undefined
  // The active unit's snapshot block, replaced on every set and deleted on
  // clear. Runtime-only: never persisted, and never part of the core status,
  // markers, or receipts.
  let snapshotBlockRecord: SnapshotBlockRecord | undefined
  // Incremented on every successful unit start or declaration (see
  // `startFreshUnit`); operations capture it to prove they are still current.
  let unitStartGeneration = 0

  // Single choke point for every `guard.startUnit()` call. The reset below is
  // currently unreachable: mode has no path back to 'protected' ('disabled'
  // is reachable but startUnit rejects there too). Here so the diagnostic
  // stays correct if mode recovery is ever added.
  function startFreshUnit(
    input: unknown,
    policy?: RuntimeUnitPolicy,
  ): StartUnitResult {
    const previousUnitId = requireGuard().status().unit?.unitId
    const result = requireGuard().startUnit(input, policy)
    if (result.status === 'started') {
      unitStartGeneration += 1
      firstUnavailableCause = undefined
      // A redeclaration of the same unit keeps its runtime records; only a
      // different unit starts with none.
      if (result.unit.unitId !== previousUnitId) {
        seedDeferralRecord = undefined
        snapshotBlockRecord = undefined
      }
    }
    return result
  }

  // Shared first-cause-wins recorder: the cause is stored only when THIS call
  // flips `target`'s mode to 'unavailable' and none is stored yet. Both
  // `markUnavailable` and `publishUnavailable` commit through here so the
  // runtime and initialization paths cannot disagree.
  function recordUnavailable(
    target: WorkflowGuard,
    cause: GuardUnavailableCause,
  ): void {
    const result = target.setMode({ mode: 'unavailable' })
    if (result.status === 'changed' && !firstUnavailableCause) {
      firstUnavailableCause = cause
    }
  }

  function effectiveTargetContext(): {
    parentTargetRoot: string
    sessionLocation: string
  } {
    const parentTargetRoot = options.targetDirectory ?? process.cwd()
    return {
      parentTargetRoot,
      sessionLocation: options.sessionLocation ?? parentTargetRoot,
    }
  }

  function rememberOperationObserver(
    registration: OperationObserverRegistration,
  ): void {
    const existing = operationObservers.get(registration.observer.targetDigest)
    if (existing && existing.targetRoot !== registration.targetRoot) return
    operationObservers.set(registration.observer.targetDigest, registration)
  }

  function parentObserverRegistration():
    | OperationObserverRegistration
    | undefined {
    if (!options.observer) return undefined
    const targetRoot = canonicalExistingPath(
      options.targetDirectory ?? process.cwd(),
      fs.realpathSync,
    )
    if (!targetRoot) return undefined
    let validation: RegisteredWorktreeValidationResult
    try {
      validation = options.observer.validateRegisteredWorktree(targetRoot)
    } catch {
      return undefined
    }
    const registeredIdentity = registeredWorktreeIdentity(validation)
    if (
      validation.status !== 'ok' ||
      registeredIdentity === undefined ||
      validation.targetRoot !== targetRoot
    ) {
      return undefined
    }
    const registration = {
      targetRoot,
      registeredWorktreeIdentity: registeredIdentity,
      observer: options.observer,
    }
    rememberOperationObserver(registration)
    return registration
  }

  function operationObserverRegistration(
    targetIdentity: string,
  ): OperationObserverRegistration | undefined {
    const existing = operationObservers.get(targetIdentity)
    if (existing) return existing
    if (options.observer?.targetDigest !== targetIdentity) return undefined
    return parentObserverRegistration()
  }

  // Typed lookup of the observer for the pinned (or parent) target. A pinned
  // worktree validation that times out is `timeout`; every other failure,
  // including a throw, is `fatal` (with the observer's reason code if any).
  function resolveEffectiveObserver(): ProbeRead<EffectiveOperationObserver> {
    const parentObserver = options.observer
    if (!parentObserver) return { status: 'fatal' }
    const pinnedTargetIdentity =
      requireGuard().status().unit?.pinnedOperationTargetIdentity
    if (
      pinnedTargetIdentity === undefined ||
      pinnedTargetIdentity === options.workspaceIdentity
    ) {
      return {
        status: 'ok',
        value: {
          observer: parentObserver,
          targetIdentity: options.workspaceIdentity,
          pinned: false,
        },
      }
    }
    const registration = operationObserverRegistration(pinnedTargetIdentity)
    if (!registration) return { status: 'fatal' }
    return resolvePinnedObserver(
      parentObserver,
      registration,
      pinnedTargetIdentity,
    )
  }

  function resolvePinnedObserver(
    parentObserver: OpencodeOperationObserver,
    registration: OperationObserverRegistration,
    pinnedTargetIdentity: string,
  ): ProbeRead<EffectiveOperationObserver> {
    let validation: RegisteredWorktreeValidationResult
    try {
      validation = parentObserver.validateRegisteredWorktree(
        registration.targetRoot,
      )
    } catch {
      return { status: 'fatal' }
    }
    if (isProbeTimeout(validation)) return { status: 'timeout' }
    if (validation.status !== 'ok') {
      return { status: 'fatal', reasonCode: validation.reasonCode }
    }
    if (
      validation.targetRoot !== registration.targetRoot ||
      registeredWorktreeIdentity(validation) !==
        registration.registeredWorktreeIdentity ||
      registration.observer.targetDigest !== pinnedTargetIdentity
    ) {
      return { status: 'fatal' }
    }
    return {
      status: 'ok',
      value: {
        observer: registration.observer,
        targetIdentity: pinnedTargetIdentity,
        pinned: true,
      },
    }
  }

  function questionResource(target: TransitionTarget): string {
    const status = requireGuard().status()
    return `workflow/${target}/${status.unit?.unitId ?? status.epoch?.epochId ?? 'unknown'}`
  }

  function questionProjection(): QuestionAttestationProjection {
    const pending = [...pendingQuestionChallenges.values()][0]
    if (!pending) return { status: 'unknown', reasonCode: 'unknown-challenge' }
    return questionAttestation.status({
      challengeId: pending.challenge.challengeId,
    })
  }

  function strictQuestionAnswer(value: unknown): 'yes' | 'confirm' | 'no' {
    if (!Array.isArray(value) || value.length !== 1) return 'no'
    const answerSet = value[0]
    if (!Array.isArray(answerSet) || answerSet.length !== 1) return 'no'
    const answer = answerSet[0]
    return classifyQuestionAnswer(answer) === 'affirmative'
      ? (answer as 'yes' | 'confirm')
      : 'no'
  }

  function challengeForTransition(
    sessionID: string,
    target: TransitionTarget,
  ): PendingQuestionChallenge | undefined {
    const existing = [...pendingQuestionChallenges.values()].find(
      (pending) =>
        pending.purpose === 'transition' && pending.transition === target,
    )
    if (existing) return existing
    const resource = questionResource(target)
    const result = questionAttestation.challenge({
      sessionId: sessionID,
      resource,
      transition: target,
      purpose: 'transition',
    })
    if (result.status !== 'pending') return undefined
    const pending: PendingQuestionChallenge = {
      challenge: result.challenge,
      purpose: 'transition',
      resource,
      transition: target,
    }
    pendingQuestionChallenges.set(result.challenge.challengeId, pending)
    return pending
  }

  function challengeForDisablement(
    sessionID: string,
  ): PendingQuestionChallenge | undefined {
    const existing = [...pendingQuestionChallenges.values()].find(
      (pending) => pending.purpose === 'session-disablement',
    )
    if (existing) return existing
    const resource = `session/${sessionID}`
    const result = questionAttestation.challenge({
      sessionId: sessionID,
      resource,
      transition: 'disable',
      purpose: 'session-disablement',
    })
    if (result.status !== 'pending') return undefined
    const pending: PendingQuestionChallenge = {
      challenge: result.challenge,
      purpose: 'session-disablement',
      resource,
      transition: 'disable',
    }
    pendingQuestionChallenges.set(result.challenge.challengeId, pending)
    return pending
  }

  function questionInstruction(
    pending: PendingQuestionChallenge,
  ): ToolResultContent {
    const questions = canonicalQuestionArgs(pending).questions
    return {
      title: 'Workflow guard confirmation required',
      output: JSON.stringify({
        status: 'rejected',
        reasonCode: 'question-attestation',
        action: 'invoke-native-question',
        challengeId: pending.challenge.challengeId,
        purpose: pending.purpose,
        question: pending.challenge.question.wording,
        questions,
      }),
      metadata: {
        ...metadata(),
        questionAttestation: {
          status: 'pending',
          challengeId: pending.challenge.challengeId,
          purpose: pending.purpose,
          resourceDigest: pending.challenge.resourceDigest,
          transitionKey: pending.challenge.transitionKey,
        },
      },
    }
  }

  function canonicalQuestionArgs(pending: PendingQuestionChallenge): {
    questions: readonly [
      {
        header: 'Confirm'
        question: string
        options: readonly [
          { label: 'yes'; description: 'Confirm the guarded transition.' },
          { label: 'no'; description: 'Decline the guarded transition.' },
        ]
      },
    ]
  } {
    return {
      questions: [
        {
          question: pending.challenge.question.wording,
          header: 'Confirm',
          options: [
            { label: 'yes', description: 'Confirm the guarded transition.' },
            { label: 'no', description: 'Decline the guarded transition.' },
          ],
        },
      ],
    }
  }

  function writeToolResult(output: unknown, result: ToolResultContent): void {
    if (!isRecord(output)) return
    output.title = result.title
    output.output = result.output
    if (result.metadata !== undefined) output.metadata = result.metadata
  }

  function consumeQuestion(pending: PendingQuestionChallenge): boolean {
    if (!pending.requestID) return false
    return (
      questionAttestation.consumeAttestation({
        purpose: pending.purpose,
        sessionId: pending.challenge.sessionId,
        resource: pending.resource,
        transition: pending.transition,
        requestId: pending.requestID,
      }).status === 'consumed'
    )
  }

  function appendReceiptMarkers(value: unknown, markers: unknown[]): void {
    if (!isRecord(value)) return
    const marker = value[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    if (Array.isArray(marker)) markers.push(...marker)
    else if (marker !== undefined) markers.push(marker)
  }

  function collectReceiptMarkers(value: unknown, markers: unknown[]): void {
    if (!isRecord(value)) return
    appendReceiptMarkers(value.metadata, markers)
    if (isRecord(value.state))
      appendReceiptMarkers(value.state.metadata, markers)
    if (Array.isArray(value.parts)) {
      for (const part of value.parts) collectReceiptMarkers(part, markers)
    }
  }

  // True when the guard itself recorded a no-epoch rejection on this part.
  // Structured fields only; the guard writes `workflowGuard` onto the tool
  // result metadata, which the host persists on `state.metadata`. The
  // part-level `metadata` is checked too.
  function hasNoEpochRejection(part: Record<string, unknown>): boolean {
    const carriers = [
      part.metadata,
      isRecord(part.state) && part.state.metadata,
    ]
    return carriers.some(
      (carrier) =>
        isRecord(carrier) &&
        isRecord(carrier.workflowGuard) &&
        carrier.workflowGuard.status === 'rejected' &&
        carrier.workflowGuard.reasonCode === 'no-active-epoch',
    )
  }

  // Chronology is established from `info.time.created`, not array position:
  // the newest message is the one with the greatest created time. Any entry
  // without a finite created time, or a tie for the newest, means the newest
  // message cannot be identified and nothing is exempt.
  function newestMessage(
    history: ReadonlyArray<unknown>,
  ): Record<string, unknown> | undefined {
    let newest: Record<string, unknown> | undefined
    let newestCreated = Number.NEGATIVE_INFINITY
    let tied = false
    for (const entry of history) {
      const created = messageCreated(entry)
      if (!isRecord(entry) || created === undefined) return undefined
      if (created > newestCreated) {
        newest = entry
        newestCreated = created
        tied = false
      } else if (created === newestCreated) {
        tied = true
      }
    }
    return tied ? undefined : newest
  }

  function messageInfo(entry: unknown): Record<string, unknown> | undefined {
    return isRecord(entry) && isRecord(entry.info) ? entry.info : undefined
  }

  function messageCreated(entry: unknown): number | undefined {
    const info = messageInfo(entry)
    const time = info && isRecord(info.time) ? info.time : undefined
    return typeof time?.created === 'number' && Number.isFinite(time.created)
      ? time.created
      : undefined
  }

  // The current turn is the newest message, provided it is an unfinished
  // assistant message created during this process's lifetime.
  function isCurrentTurn(message: Record<string, unknown>): boolean {
    const info = messageInfo(message)
    const time = info && isRecord(info.time) ? info.time : undefined
    const created = messageCreated(message)
    return (
      info?.role === 'assistant' &&
      (time?.completed === undefined || time.completed === null) &&
      created !== undefined &&
      created >= runtimeStartedAt
    )
  }

  // Pending/running guard mutation parts of the current turn, by identity.
  // These belong to the call now executing, whose host part is persisted
  // before its before-hook runs; they carry no evidence yet.
  function currentTurnExemptParts(
    history: ReadonlyArray<unknown>,
  ): ReadonlySet<unknown> {
    const exempt = new Set<unknown>()
    const newest = newestMessage(history)
    if (!newest || !isCurrentTurn(newest) || !Array.isArray(newest.parts)) {
      return exempt
    }
    for (const part of newest.parts) {
      if (
        isRecord(part) &&
        (part.tool === 'systematic_workflow_start' ||
          part.tool === 'systematic_workflow_complete' ||
          part.tool === 'systematic_workflow_control') &&
        isRecord(part.state) &&
        (part.state.status === 'pending' || part.state.status === 'running')
      ) {
        exempt.add(part)
      }
    }
    return exempt
  }

  // Guard-owned parts that carry no evidence and never mutate guard state:
  // status reads (any state), COMPLETED start/complete calls the guard
  // itself rejected with `no-active-epoch`, and the pending/running guard
  // mutation parts of the current turn. Everything else stays history.
  function isExemptGuardPart(
    part: Record<string, unknown>,
    currentTurn: ReadonlySet<unknown>,
  ): boolean {
    if (part.tool === 'systematic_workflow_status') return true
    if (currentTurn.has(part)) return true
    if (
      part.tool !== 'systematic_workflow_start' &&
      part.tool !== 'systematic_workflow_complete'
    ) {
      return false
    }
    return (
      isRecord(part.state) &&
      part.state.status === 'completed' &&
      hasNoEpochRejection(part)
    )
  }

  function containsGuardHistory(
    value: unknown,
    currentTurn: ReadonlySet<unknown>,
  ): boolean {
    if (!isRecord(value)) return false
    if (
      value.tool === 'systematic_workflow_start' ||
      value.tool === 'systematic_workflow_status' ||
      value.tool === 'systematic_workflow_complete' ||
      value.tool === 'systematic_workflow_control'
    ) {
      return !isExemptGuardPart(value, currentTurn)
    }
    return (
      Array.isArray(value.parts) &&
      value.parts.some((part) => containsGuardHistory(part, currentTurn))
    )
  }

  function createGuard(nextLedger: ReceiptLedger): WorkflowGuard {
    return createWorkflowGuard({
      ledger: nextLedger,
      classifier: options.classifier,
      workspaceIdentity: options.workspaceIdentity,
      repositoryIdentity: options.repositoryIdentity,
      worktreeIdentity: options.worktreeIdentity,
      supportedRepairs: [
        'fresh-readback',
        'rerun-operation',
        'question-attestation',
      ],
      questionEligibleOperations: [
        'implementation',
        'verification',
        'commit',
        'push',
        'pr-creation',
        'check-readback',
        'review-readback',
      ],
      runtimeRequiredOperations: options.runtimeRequiredOperations,
      mode: options.config.mode === 'disabled' ? 'disabled' : 'protected',
    })
  }

  function mintLedger(): ReceiptLedger {
    return createReceiptLedger({
      capabilityFlags: ['workflow-guard'],
      registrationIdentity: options.registrationIdentity,
      sessionSalt: options.sessionSalt
        ? new Uint8Array(options.sessionSalt)
        : randomBytes(32),
    })
  }

  // The empty-history retry runs on every host event; reuse one ledger so the
  // marker's `source` (its registration digest) stays stable across requests.
  let emptyHistoryLedger: ReceiptLedger | undefined
  function emptyHistoryLedgerForRetry(): ReceiptLedger {
    emptyHistoryLedger ??= mintLedger()
    return emptyHistoryLedger
  }

  // The publish's own cause wins over a pending one.
  function publishUnavailable(
    cause: GuardUnavailableCause,
    reusableLedger?: ReceiptLedger,
  ): void {
    ledger = reusableLedger ?? mintLedger()
    const published = createGuard(ledger)
    guard = published
    if (options.config.mode !== 'disabled') recordUnavailable(published, cause)
    pendingUnavailableCause = undefined
    initialized = true
  }

  // Applies the pending cause to the newly published guard and cancels the
  // provisional-history retry, so a later fresh publish cannot clear it.
  function commitPendingUnavailable(): void {
    const cause = pendingUnavailableCause
    pendingUnavailableCause = undefined
    if (cause && options.config.mode !== 'disabled') {
      recordUnavailable(requireGuard(), cause)
      retryableEmptyHistory = false
    }
  }

  function publishFresh(reusableLedger?: ReceiptLedger): void {
    ledger = reusableLedger ?? mintLedger()
    guard = createGuard(ledger)
    firstUnavailableCause = undefined
    commitPendingUnavailable()
    initialized = true
  }

  function ensureSynchronousRuntime(): void {
    if (!initialized && !options.hostReadback) publishFresh()
  }

  function seedAgrees(
    nextLedger: ReceiptLedger,
    seed: Extract<
      ReturnType<typeof extractReceiptReadbackSeed>,
      { status: 'ready' }
    >,
  ): boolean {
    return (
      nextLedger.metadata.registrationDigest === seed.registrationDigest &&
      JSON.stringify(nextLedger.metadata.capabilityFlags) ===
        JSON.stringify(['workflow-guard'])
    )
  }

  /** Extract a candidate { salt, digest } from a seeded marker, or undefined. */
  function candidateSeedFromMarker(
    input: unknown,
  ): { salt: Uint8Array; digest: string } | undefined {
    const validation = validateReceiptMarker(input)
    if (validation.status !== 'valid') return undefined
    const marker = validation.marker
    if (marker.kind === 'mint') {
      const salt = decodeSessionSaltBytes(marker.sessionSalt)
      return salt
        ? { salt, digest: marker.envelope.registrationDigest }
        : undefined
    }
    if (marker.kind === 'control' && marker.control === 'progression') {
      const salt = decodeSessionSaltBytes(marker.sessionSalt)
      return salt ? { salt, digest: marker.registrationDigest } : undefined
    }
    return undefined
  }

  /** Test whether a candidate salt agrees with this registration's identity. */
  function candidateAgreesWithOwnIdentity(
    salt: Uint8Array,
    digest: string,
  ): boolean {
    try {
      const probe = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity: options.registrationIdentity,
        sessionSalt: salt,
      })
      return probe.metadata.registrationDigest === digest
    } catch {
      return false
    }
  }

  /**
   * Finds the registrationDigest that belongs to THIS registration by scanning
   * validated markers for candidate seeds and checking which one agrees with
   * options.registrationIdentity. Returns undefined if no own seed is found.
   *
   * Known limitation: if the same canonical plugin source registers twice with
   * different session salts (producing two distinct (identity, salt) → digest pairs
   * for the same registrationIdentity string), this function picks whichever seed
   * appears first in the markers array. This is sound for the primary dual-registration
   * scenario where the two registrations have distinct canonical identities (different
   * `options.registrationIdentity` values, e.g. published package vs repo path).
   * Multiple-salt registration from a single canonical identity is a known limitation
   * of this design and is not addressed here.
   */
  function resolveOwnRegistrationDigest(
    markers: readonly unknown[],
  ): string | undefined {
    const seenDigests = new Set<string>()
    for (const input of markers) {
      const candidate = candidateSeedFromMarker(input)
      if (!candidate || seenDigests.has(candidate.digest)) continue
      seenDigests.add(candidate.digest)
      if (candidateAgreesWithOwnIdentity(candidate.salt, candidate.digest)) {
        return candidate.digest
      }
    }
    return undefined
  }

  // Returns undefined on success, otherwise the cause of the failure.
  function recoverPersistedMarkers(
    markers: readonly unknown[],
  ): GuardUnavailableCause | undefined {
    // Callers must pass pre-filtered (own-registration) markers.
    const seed = extractReceiptReadbackSeed(markers)
    if (seed.status !== 'ready') {
      return initializationCause('markers-malformed-or-incompatible')
    }
    let recoveredLedger: ReceiptLedger
    try {
      recoveredLedger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity: options.registrationIdentity,
        sessionSalt: seed.sessionSalt,
      })
    } catch {
      return initializationCause('markers-malformed-or-incompatible')
    }
    if (!seedAgrees(recoveredLedger, seed)) {
      return initializationCause('markers-malformed-or-incompatible')
    }
    const recovered = recoveredLedger.recoverReadback(markers)
    if (recovered.status === 'rejected') {
      return initializationCause('recovery-rejected')
    }
    const recoveredGuard = createGuard(recoveredLedger)
    const restored = recoveredGuard.restore({
      provenance: 'restart',
      state: {
        registrationDigest: recoveredLedger.metadata.registrationDigest,
        receipts: recovered.receipts,
        progression: recovered.progression,
      },
    })
    if (restored.status === 'rejected') {
      return initializationCause('recovery-rejected')
    }
    ledger = recoveredLedger
    guard = recoveredGuard
    firstUnavailableCause = undefined
    commitPendingUnavailable()
    initialized = true
    return undefined
  }

  type OwnMarkersClassification =
    | { readonly kind: 'own'; readonly markers: readonly unknown[] }
    | { readonly kind: 'foreign-empty' }
    | { readonly kind: 'ambiguous' }

  /**
   * Classifies markers collected from session parts into three outcomes:
   *
   * - 'own': at least one valid own seed marker found; contains filtered own markers.
   * - 'foreign-empty': every marker is a valid, salt-bearing marker that does NOT
   *   agree with this registration's identity. Safe to treat as empty history.
   * - 'ambiguous': own digest unresolvable AND ≥1 marker is malformed/invalid OR
   *   seedless (consume). Cannot prove the markers don't include corrupted own state.
   *   Must fail closed — never degrade to publishFresh / benign no-op.
   *
   * This correctly distinguishes genuinely-foreign marker arrays (safe → fresh) from
   * own-state-loss / corruption scenarios (unsafe → fail closed).
   */
  function classifyMarkersFromParts(
    parts: ReadonlyArray<unknown>,
  ): OwnMarkersClassification {
    const allMarkers: unknown[] = []
    for (const part of parts) collectReceiptMarkers(part, allMarkers)
    if (allMarkers.length === 0) return { kind: 'foreign-empty' }

    const ownDigest = resolveOwnRegistrationDigest(allMarkers)
    if (ownDigest !== undefined) {
      return {
        kind: 'own',
        markers: filterMarkersByRegistration(allMarkers, ownDigest),
      }
    }

    // Own digest not resolvable. Determine if every marker is provably foreign, or
    // if any is ambiguous (malformed or seedless) and therefore could be corrupted own.
    //
    // Provably foreign: passes validateReceiptMarker AND is seed-bearing (mint or
    //   progression — has a sessionSalt) AND candidateAgreesWithOwnIdentity is false.
    //   Since resolveOwnRegistrationDigest found no match, every valid seed-bearing
    //   marker already failed the agreement check.
    //
    // Ambiguous: malformed/invalid (cannot read) OR valid but seedless (consume
    //   marker — carries registrationDigest but no sessionSalt, so we cannot run
    //   the identity agreement check). Ambiguous markers MUST trigger fail-closed.
    for (const input of allMarkers) {
      const validation = validateReceiptMarker(input)
      if (validation.status !== 'valid') {
        // Malformed/invalid: could be a corrupted own marker → fail closed
        return { kind: 'ambiguous' }
      }
      const candidate = candidateSeedFromMarker(input)
      if (candidate === undefined) {
        // Valid but seedless (consume marker, kind='control' control='consume'):
        // registrationDigest is present but sessionSalt is absent — cannot verify
        // ownership without a salt → fail closed
        return { kind: 'ambiguous' }
      }
      // Valid seed-bearing (mint/progression): since resolveOwnRegistrationDigest
      // returned undefined, this marker's (salt, digest) does not agree with our
      // identity → provably foreign. Continue scanning.
    }

    // Every marker was valid, seed-bearing, and provably foreign.
    return { kind: 'foreign-empty' }
  }

  function publishEmptyMarkers(
    parts: ReadonlyArray<unknown>,
    allowFresh: boolean,
  ): void {
    const reusableLedger = emptyHistoryLedgerForRetry()
    const currentTurn = currentTurnExemptParts(parts)
    if (parts.some((part) => containsGuardHistory(part, currentTurn))) {
      // Evidence-bearing guard history without markers can never become
      // recoverable, so this unavailable is final (not retryable).
      publishUnavailable(
        initializationCause('markerless-guard-history'),
        reusableLedger,
      )
      return
    }
    if (allowFresh) {
      publishFresh(reusableLedger)
      return
    }
    // Deferred fresh: no guard history, but this pass may not confirm fresh.
    // Publish a provisional inactive guard (same ledger, so the marker is
    // stable) and stay retryable: the next allow-fresh recovery re-reads the
    // history and either confirms it, restores from late own markers, or
    // fails closed on guard history.
    retryableEmptyHistory = true
    publishFresh(reusableLedger)
  }

  // A throw after the host read publishes `unavailable` with `initialization-threw`.
  async function initializeSession(
    sessionID: string,
    allowFresh: boolean,
  ): Promise<void> {
    try {
      await initializeSessionSteps(sessionID, allowFresh)
    } catch {
      retryableEmptyHistory = false
      publishUnavailable(initializationCause('initialization-threw'))
    }
  }

  async function initializeSessionSteps(
    sessionID: string,
    allowFresh: boolean,
  ): Promise<void> {
    const reader =
      options.hostReadback?.readSessionPartsStrict ??
      options.hostReadback?.readSessionParts
    if (!reader) {
      publishFresh()
      return
    }
    let parts: ReadonlyArray<unknown>
    try {
      parts = await reader(sessionID)
    } catch {
      publishUnavailable(initializationCause('history-read-failed'))
      return
    }
    const classification = classifyMarkersFromParts(parts)
    if (classification.kind === 'ambiguous') {
      // Cannot determine whether markers include corrupted own state → fail closed.
      // Do NOT use retryableEmptyHistory here; this is a corruption signal, not a
      // transient empty-history state.
      publishUnavailable(initializationCause('markers-ambiguous'))
      return
    }
    if (classification.kind === 'foreign-empty') {
      // No own markers: either no history at all, or all markers are provably
      // foreign (dual-registration, other registrations only). Use the normal
      // empty-history path (publishFresh or publishUnavailable based on history check).
      publishEmptyMarkers(parts, allowFresh)
      return
    }
    // kind === 'own': recover from filtered own markers.
    const failure = recoverPersistedMarkers(classification.markers)
    if (failure) publishUnavailable(failure)
  }

  async function recoverFromHost(
    sessionID: string,
    allowFresh = true,
  ): Promise<void> {
    // Waiter protocol: no hook proceeds while an initialization is in flight.
    // After awaiting promise P a waiter re-checks that P is still the current
    // initialization; if another waiter already started a newer one, this
    // waiter awaits that one too. Only the waiter that STARTS a re-init
    // resets the retry state and the published guard.
    let reinitialize = false
    while (initializationPromise) {
      const seen = initializationPromise
      await seen
      if (initializationPromise !== seen) continue
      if (!retryableEmptyHistory || !allowFresh) return
      reinitialize = true
      break
    }
    if (reinitialize) initialized = false
    retryableEmptyHistory = false
    const next = initializeSession(sessionID, allowFresh)
    initializationPromise = next
    await next
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: lineage verification and parent minting must remain atomic
  async function rollupForegroundTask(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    if (!options.hostReadback || !isRecord(output)) return
    if (!isRecord(output.metadata)) return
    const childSessionID =
      typeof output.metadata.sessionId === 'string' &&
      output.metadata.sessionId.length <= 256
        ? output.metadata.sessionId
        : undefined
    if (!childSessionID) return
    const rollupKey = `${host.sessionID}:${host.callID}:${childSessionID}`
    if (rolledUpChildren.has(rollupKey)) return
    // Capture the parent's operation-before identities before reading child
    // history. These are guard-owned digests, not boot-time path values.
    const parentBefore = requireGuard().currentOperationContext()
    const children = await options.hostReadback.listChildren(host.sessionID)
    if (
      !children.some(
        (child) =>
          child.sessionId === childSessionID &&
          child.parentID === host.sessionID,
      )
    ) {
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return
    }
    let parts: ReadonlyArray<unknown>
    try {
      parts = await options.hostReadback.readSessionParts(childSessionID)
    } catch {
      markUnavailable(afterCause('history-read-failed'))
      return
    }
    // Classify child session markers: own (filter and recover), foreign-empty
    // (benign no-op — no receipts to roll up), or ambiguous (corrupted/seedless
    // markers that cannot be verified as foreign → fail closed).
    const classification = classifyMarkersFromParts(parts)
    if (classification.kind === 'foreign-empty') return
    if (classification.kind === 'ambiguous') {
      markUnavailable(afterCause('markers-ambiguous'))
      return
    }
    const ownMarkers = classification.markers
    const seed = extractReceiptReadbackSeed(ownMarkers)
    if (seed.status !== 'ready') {
      markUnavailable(afterCause('recovery-rejected'))
      return
    }
    const childLedger = createReceiptLedger({
      capabilityFlags: ['workflow-guard'],
      registrationIdentity: options.registrationIdentity,
      sessionSalt: seed.sessionSalt,
    })
    if (!seedAgrees(childLedger, seed)) {
      markUnavailable(afterCause('recovery-rejected'))
      return
    }
    const recovered = childLedger.recoverReadback(ownMarkers)
    if (recovered.status === 'rejected') {
      markUnavailable(afterCause('recovery-rejected'))
      return
    }
    // Touch the fixed parent observer for the stable workspace path, but do
    // not use its mutable repository/worktree revisions for child validation.
    // A nested worktree can make the parent-root scan unavailable while its
    // own authenticated target remains valid and independently observable.
    try {
      await options.observer?.snapshot()
    } catch {
      // Target-specific validation below remains authoritative.
    }
    const currentStatus = requireGuard().status()
    if (!currentStatus.epoch || !currentStatus.unit) return
    const expectedWorkspace = childLedger.digestIdentity(
      'workspace',
      parentBefore.workspaceIdentity,
    )
    let batchTargetIdentity = currentStatus.unit.pinnedOperationTargetIdentity
    const candidates: Array<{
      readonly receipt: (typeof recovered.receipts)[number]
      readonly snapshot: OperationObserverSnapshot
      readonly before?: OperationObserverSnapshot
    }> = []
    for (const childReceipt of recovered.receipts) {
      const operation = childReceipt.canonical.operation
      if (!localOperation(operation)) continue
      if (childReceipt.canonical.workspaceDigest !== expectedWorkspace) {
        markUnavailable(afterCause('operation-observation-rejected'))
        return
      }

      const targetIdentity = childReceipt.canonical.operationTargetIdentity
      if (!targetIdentity) {
        markUnavailable(afterCause('operation-input-invalid'))
        return
      }
      if (
        batchTargetIdentity !== undefined &&
        targetIdentity !== batchTargetIdentity
      ) {
        markUnavailable(afterCause('operation-target-mismatch'))
        return
      }
      batchTargetIdentity = targetIdentity

      const registration = operationObserverRegistration(targetIdentity)
      if (!registration || !options.observer) {
        markUnavailable(afterCause('operation-input-invalid'))
        return
      }
      let validation: RegisteredWorktreeValidationResult
      try {
        validation = options.observer.validateRegisteredWorktree(
          registration.targetRoot,
        )
      } catch {
        markUnavailable(afterCause('operation-input-invalid'))
        return
      }
      if (
        validation.status === 'error' ||
        validation.targetRoot !== registration.targetRoot ||
        registeredWorktreeIdentity(validation) !==
          registration.registeredWorktreeIdentity ||
        registration.observer.targetDigest !== targetIdentity
      ) {
        markUnavailable(
          afterCause(
            'operation-input-invalid',
            validation.status === 'error' ? validation.reasonCode : undefined,
          ),
        )
        return
      }

      let targetResult: OperationObserverResult
      try {
        targetResult = await registration.observer.snapshot()
      } catch {
        markUnavailable(afterCause('local-snapshot-error'))
        return
      }
      if (targetResult.status === 'unavailable') {
        markUnavailable(
          afterCause('local-snapshot-unavailable', targetResult.reasonCode),
        )
        return
      }
      if (targetResult.snapshot.targetDigest !== targetIdentity) {
        markUnavailable(afterCause('operation-target-mismatch'))
        return
      }

      const recoveredContext = recoveredOperationContexts.get(
        childReceipt.canonical.receiptId,
      )
      if (
        (recoveredContext &&
          recoveredContext.targetIdentity !== targetIdentity) ||
        (targetIdentity !== options.observer.targetDigest && !recoveredContext)
      ) {
        markUnavailable(afterCause('operation-target-mismatch'))
        return
      }

      const expectedRepository = childLedger.digestIdentity(
        'repository',
        targetResult.snapshot.repositoryRevisionDigest,
      )
      const expectedWorktree = childLedger.digestIdentity(
        'worktree',
        targetResult.snapshot.worktreeRevisionDigest,
      )
      if (
        childReceipt.canonical.repositoryDigest !== expectedRepository ||
        childReceipt.canonical.worktreeDigest !== expectedWorktree
      ) {
        // Stale relative to the authenticated target's current snapshot
        // (repository or worktree revision moved since this receipt was
        // minted) — skip without minting, but keep evaluating later
        // chronological receipts from the same child rollup.
        continue
      }
      candidates.push({
        receipt: childReceipt,
        snapshot: targetResult.snapshot,
        before: recoveredContext?.before,
      })
    }

    let minted = false
    for (const candidate of candidates) {
      const childReceipt = candidate.receipt
      const targetSnapshot = candidate.snapshot
      const operation = childReceipt.canonical.operation
      const parentContext = requireGuard().currentOperationContext()
      const beforeSnapshot = candidate.before
      const callID = `task-${host.callID}-${childReceipt.canonical.receiptId}`
      const observation = {
        callId: callID,
        operation,
        tool: 'write' as const,
        context: {
          epochId: currentStatus.epoch.epochId,
          unitId: currentStatus.unit.unitId,
          workspaceIdentity: parentContext.workspaceIdentity,
          operationTargetIdentity:
            childReceipt.canonical.operationTargetIdentity,
          repositoryIdentity:
            beforeSnapshot?.repositoryRevisionDigest ??
            parentContext.repositoryIdentity ??
            targetSnapshot.repositoryRevisionDigest,
          worktreeIdentity:
            beforeSnapshot?.worktreeRevisionDigest ??
            parentContext.worktreeIdentity ??
            targetSnapshot.worktreeRevisionDigest,
        },
        after: {
          workspaceIdentity: parentContext.workspaceIdentity,
          operationTargetIdentity:
            childReceipt.canonical.operationTargetIdentity,
          repositoryIdentity: targetSnapshot.repositoryRevisionDigest,
          worktreeIdentity: targetSnapshot.worktreeRevisionDigest,
        },
        terminal: {
          status: 'success' as const,
          output: 'non-empty' as const,
          noOp: false,
        },
      }
      const result =
        await requireGuard().observeTrustedRecoveredOperation(observation)
      if (result.status === 'accepted') {
        const receipt = receiptForOperation(callID, operation)
        if (receipt) mergeReceiptMarker(output, receipt)
        minted = true
      }
    }
    if (minted) rolledUpChildren.add(rollupKey)
  }

  let runtimePolicy = trustedSkillPolicy(
    'unknown',
    options.runtimeRequiredOperations ?? [],
  )

  // `cause` is only recorded if THIS call is the one that actually flips
  // mode to 'unavailable' (setMode returns 'changed', not 'unchanged') and
  // no cause is stored yet. This binds the diagnostic to the real transition
  // instead of to whichever concurrent caller finished computing a cause
  // first, so a failure suspended mid-seed can never overwrite (or follow)
  // an unrelated cause that already won the race.
  function markUnavailable(cause: GuardUnavailableCause): void {
    if (options.config.mode === 'disabled') return
    const published = guard
    if (!published) {
      // No guard yet: hold the cause until one is published.
      pendingUnavailableCause ??= cause
      return
    }
    recordUnavailable(published, cause)
  }

  function guardPublished(): boolean {
    return guard !== undefined
  }

  function requireGuard(): WorkflowGuard {
    if (!guard) throw new Error('workflow guard used before it was published')
    return guard
  }

  function bindCall(
    callDigest: string,
    kind: string,
    fingerprint: string,
  ): 'new' | 'duplicate' | 'conflict' {
    const existing = callBindings.get(callDigest)
    if (!existing) {
      callBindings.set(callDigest, { kind, fingerprint })
      return 'new'
    }
    if (existing.kind === kind && existing.fingerprint === fingerprint) {
      return 'duplicate'
    }
    markUnavailable(beforeCause('call-lifecycle-mismatch'))
    return 'conflict'
  }

  function abandonPending(): void {
    for (const [callDigest, pending] of pendingCompletes) {
      requireGuard().abandonTransition({
        callId: pending.callID,
        transitionId: pending.transitionId,
      })
      pendingCompletes.delete(callDigest)
      abandonedCompletes.set(callDigest, pending.target)
    }
    pendingStarts.clear()
    pendingSkills.clear()
    for (const [callDigest, pending] of pendingOperations) {
      abandonedOperations.set(callDigest, {
        tool: pending.tool,
        argsFingerprint: pending.argsFingerprint,
      })
      pendingOperations.delete(callDigest)
    }
    for (const callDigest of skippedOperations) {
      abandonedOperations.set(callDigest, { skipped: true })
    }
    skippedOperations.clear()
  }

  // A status read must not touch sibling calls' pending work: pending
  // entries are only cleared at the request boundary (the transform).
  function readStatus(): WorkflowStatus {
    return guard ? guard.status() : unavailableWorkflowStatus()
  }

  function control(sessionID: string, input: unknown): ToolResultContent {
    if (!isRecord(input) || input.mode !== 'disabled') {
      return {
        title: 'Workflow guard control unavailable',
        output: JSON.stringify({
          status: 'unavailable',
          reasonCode: 'control-not-enabled',
        }),
      }
    }
    if (options.config.mode === 'disabled') {
      return {
        title: 'Workflow guard disabled',
        output: JSON.stringify({ status: 'disabled' }),
      }
    }
    const pending = challengeForDisablement(sessionID)
    if (!pending) return questionUnavailableResult()
    if (pending.requestID && questionProjection().status === 'attested') {
      if (consumeQuestion(pending)) {
        requireGuard().setMode({ mode: 'disabled' })
        return {
          title: 'Workflow guard disabled',
          output: JSON.stringify({ status: 'disabled' }),
        }
      }
    }
    return questionInstruction(pending)
  }

  function questionUnavailableResult(): ToolResultContent {
    return {
      title: 'Workflow guard unavailable',
      output: JSON.stringify({
        status: 'unavailable',
        reasonCode: 'question-attestation',
      }),
    }
  }

  // Operations are observed only while guarded work can use the evidence: an
  // active epoch, or an allowlisted skill call still pending that may activate
  // one. Disabled and unavailable guards never consume operation evidence.
  function operationObservationApplies(): boolean {
    const current = readStatus()
    if (current.state === 'disabled' || current.state === 'unavailable') {
      return false
    }
    return current.epoch?.status === 'active' || pendingSkills.size > 0
  }

  // Without an epoch there is nothing to protect with observer readback:
  // skip every observer read, identity update, and unavailable transition.
  function observerReadbackApplies(): boolean {
    return (
      options.observer !== undefined && requireGuard().status().epoch !== null
    )
  }

  // The local or pinned probe was skipped, so no remote probe runs either. List
  // it first, then every satisfied remote operation that was left unprobed (in
  // the same order a refresh would have probed them), so none looks verified.
  function skippedWithRemoteTail(
    head: 'local' | 'pinned',
  ): readonly UnconfirmedReadback[] {
    return [
      unconfirmedReadback(head),
      ...requireGuard()
        .status()
        .satisfiedOperations.filter(remoteOperation)
        .map((operation) => unconfirmedReadback(operation)),
    ]
  }

  // A probe that times out is skipped: no readback is applied for it and no
  // existing staleness is cleared. The skipped probes are returned by value for
  // the status tool. Every non-timeout failure stays fatal.
  async function refreshReadback(): Promise<readonly UnconfirmedReadback[]> {
    if (!observerReadbackApplies()) return []
    const lookup = resolveEffectiveObserver()
    if (lookup.status === 'timeout') return skippedWithRemoteTail('pinned')
    if (lookup.status === 'fatal') {
      markUnavailable(observerReadbackFailedCause(lookup.reasonCode))
      return []
    }
    const effective = lookup.value
    const read = await readSnapshot(
      effective.observer,
      effective.targetIdentity,
    )
    if (read.status === 'timeout') {
      return skippedWithRemoteTail(effective.pinned ? 'pinned' : 'local')
    }
    if (read.status === 'fatal') {
      markUnavailable(observerReadbackFailedCause(read.reasonCode))
      return []
    }
    return applyReadbackAndProbeRemote(effective, read.value)
  }

  async function applyReadbackAndProbeRemote(
    effective: EffectiveOperationObserver,
    snapshot: OperationObserverSnapshot,
  ): Promise<readonly UnconfirmedReadback[]> {
    const observed = requireGuard().observeReadback({
      workspaceIdentity: options.workspaceIdentity,
      repositoryIdentity: snapshot.repositoryRevisionDigest,
      worktreeIdentity: snapshot.worktreeRevisionDigest,
      ...(effective.pinned
        ? { operationTargetIdentity: effective.targetIdentity }
        : {}),
    })
    if (
      observed.status === 'rejected' &&
      observed.reasonCode === 'workspace-mismatch'
    ) {
      markUnavailable(observerReadbackFailedCause())
      return []
    }
    const remote = await refreshRemoteReadbacks(effective.observer, snapshot)
    if (remote.kind === 'fatal') {
      markUnavailable(observerReadbackFailedCause(remote.reasonCode))
    }
    return remote.unconfirmed
  }

  async function refreshRemoteReadbacks(
    observer: OpencodeOperationObserver,
    local: OperationObserverSnapshot,
  ): Promise<RemoteReadbackOutcome> {
    const remoteOperations = requireGuard()
      .status()
      .satisfiedOperations.filter(remoteOperation)
    if (remoteOperations.length === 0) return { kind: 'ok', unconfirmed: [] }
    const remoteSnapshot = observer.remoteSnapshot
    if (!remoteSnapshot) return { kind: 'fatal', unconfirmed: [] }
    const unconfirmed: UnconfirmedReadback[] = []
    for (const operation of remoteOperations) {
      const result = await readRemoteScope(remoteSnapshot, operation)
      if (isProbeTimeout(result)) {
        unconfirmed.push(unconfirmedReadback(operation))
        continue
      }
      if (result?.status !== 'available') {
        return {
          kind: 'fatal',
          unconfirmed,
          reasonCode: remoteFailureReason(result),
        }
      }
      const observed = requireGuard().observeReadback(
        remoteReadbackInput(
          operation,
          local,
          options.workspaceIdentity,
          result.snapshot,
        ),
      )
      if (observed.status === 'rejected') return { kind: 'fatal', unconfirmed }
    }
    return { kind: 'ok', unconfirmed }
  }

  function currentMarkerSource(): MarkerSource {
    const status = requireGuard().status()
    const statusDigest = ledger.digestIdentity(
      'resource',
      JSON.stringify({
        state: status.state,
        reasonCode: status.reasonCode,
        repair: status.repair,
        satisfied: status.satisfiedOperations,
        missing: status.missingOperations,
      }),
    )
    const source: MarkerSource = {
      source: ledger.metadata.registrationDigest,
      state: status.state,
      reasonCode: status.reasonCode,
      ...(status.repair ? { repair: status.repair } : {}),
      enforcement: options.config.mode,
      statusDigest,
    }
    if (options.config.debug) {
      source.debug = {
        operations: status.unit?.requiredOperations ?? [],
        satisfiedCount: status.satisfiedOperations.length,
        missingCount: status.missingOperations.length,
        family: status.epoch?.family ?? null,
        status: status.epoch?.status ?? null,
      }
    }
    return source
  }

  // A conditional metadata key from an earlier `metadata()` call — notably
  // `questionAttestation` — must not silently outlive the result that
  // produced it: `metadata()` only adds keys when the current guard state
  // warrants them, it never deletes stale ones, and every writer below
  // spreads `existingMetadata` first (lowest precedence) then the current
  // `metadata()` read. Stripping known conditional keys from the carried-
  // over metadata before that spread lets the current metadata() call
  // reinstate them when still valid and drop them otherwise, instead of a
  // stale value leaking forward into a result that no longer emits it.
  function withoutStaleConditionalMetadata(
    existingMetadata: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!('questionAttestation' in existingMetadata)) return existingMetadata
    // `existingMetadata` may belong to the host tool's own raw metadata, or
    // to ANOTHER guard instance sharing this `output` reference (see the
    // cross-instance sharing note on writeAbandonedCompletionMetadata()) —
    // never safe to strip from. `sourceDigest` is this instance's
    // `ledger.metadata.registrationDigest`: fixed for the instance's
    // lifetime, and distinct per instance (random unless
    // `registrationIdentity` is pinned). Matching it against the existing
    // metadata's own `sourceDigest` is how "did THIS instance write this"
    // is verified before deleting anything from it.
    if (existingMetadata.sourceDigest !== currentMarkerSource().source) {
      return existingMetadata
    }
    const { questionAttestation: _stale, ...rest } = existingMetadata
    return rest
  }

  function metadata(): Record<string, unknown> {
    const source = currentMarkerSource()
    const result: Record<string, unknown> = {
      protocolVersion: MARKER_PROTOCOL_VERSION,
      sourceDigest: source.source,
      statusDigest: source.statusDigest,
      state: source.state,
      reasonCode: source.reasonCode,
      enforcement: source.enforcement,
    }
    const attestation = questionProjection()
    if (attestation.status !== 'unknown') {
      result.questionAttestation = {
        status: attestation.status,
        challengeId: attestation.challengeId,
        purpose: attestation.purpose,
        resourceDigest: attestation.resourceDigest,
        transitionKey: attestation.transitionKey,
        ...(attestation.requestId ? { requestId: attestation.requestId } : {}),
        ...(attestation.consumption
          ? { consumption: attestation.consumption }
          : {}),
      }
    }
    if (options.config.debug && source.debug) {
      result.operations = source.debug.operations
      result.satisfiedCount = source.debug.satisfiedCount
      result.missingCount = source.debug.missingCount
      result.family = source.debug.family
      // Guard-owned name, not a bare `status`: a bare key here would
      // collide with (and in debug mode silently overwrite) a host tool's
      // own `status` field — the exact field `isSuccessfulAfter()` reads
      // to detect a failed host result (see parseHostOutput()).
      result.debugEpochStatus = source.debug.status
    }
    return result
  }

  function progressionResourceScopes(
    unit: NonNullable<WorkflowStatus['unit']>,
  ): readonly { operation: ReceiptOperation; resourceIdentity: string }[] {
    return [...unit.resourceScopes]
      .sort((first, second) => first.operation.localeCompare(second.operation))
      .map((scope) => ({
        operation: scope.operation,
        resourceIdentity: ledger.digestIdentity(
          'resource',
          scope.resourceIdentity,
        ),
      }))
  }

  function writeStartResult(output: unknown, result: StartUnitResult): void {
    if (!isRecord(output)) return
    const existingMetadata = isRecord(output.metadata) ? output.metadata : {}
    if (result.status === 'started') {
      output.title = 'Workflow unit started'
      output.output = JSON.stringify({ status: 'started' })
      output.metadata = {
        ...withoutStaleConditionalMetadata(existingMetadata),
        ...metadata(),
        workflowGuard: { status: 'started' },
      }
      return
    }
    const reasonCode =
      'reasonCode' in result ? result.reasonCode : 'guard-unavailable'
    output.title = 'Workflow unit rejected'
    output.output = JSON.stringify({
      status: 'rejected',
      reasonCode,
    })
    output.metadata = {
      ...withoutStaleConditionalMetadata(existingMetadata),
      ...metadata(),
      workflowGuard: {
        status: 'rejected',
        reasonCode,
      },
    }
  }

  // Only the terminal writer below can ever see `target === undefined`
  // (via `finishUnreplayableComplete()`, where the target is genuinely
  // unknown). Omitted from the returned fragment rather than filled with a
  // placeholder so the written record never claims to know a target it
  // does not.
  function targetMetadataField(
    target: TransitionTarget | undefined,
  ): { target: TransitionTarget } | Record<string, never> {
    return target ? { target } : {}
  }

  // A successful completion always has a real, known target — this is the
  // ONLY writer `finalizeComplete()`'s `completed`/`duplicate` branch calls,
  // and that branch is only ever reached with a concrete `pending.target`.
  // Requiring `target: TransitionTarget` here (not `| undefined`) makes
  // that invariant a compile error to violate, instead of a comment next
  // to a type that allowed both.
  function writeSuccessfulCompletionResult(
    output: unknown,
    target: TransitionTarget,
  ): void {
    if (!isRecord(output)) return
    const existingMetadata = isRecord(output.metadata) ? output.metadata : {}
    output.title = 'Workflow transition completed'
    output.output = `workflow guard completed ${target}`
    output.metadata = {
      ...withoutStaleConditionalMetadata(existingMetadata),
      ...metadata(),
      workflowGuard: { status: 'completed', target },
    }
  }

  // Every non-success completion outcome (abandoned, mismatched target,
  // failed readback, or a finalizeTransition rejection) shares this shape.
  // `result: TerminalComplete` — not `TransitionFinalizeResult |
  // TerminalComplete` — means the type system, not a runtime `if`, rules
  // out ever being called with a `completed`/`duplicate` result:
  // `TerminalComplete.status` cannot hold those values.
  function writeTerminalCompletionResult(
    output: unknown,
    result: TerminalComplete,
    target: TransitionTarget | undefined,
    title = 'Workflow transition unavailable',
  ): void {
    if (!isRecord(output)) return
    const existingMetadata = isRecord(output.metadata) ? output.metadata : {}
    output.title = title
    output.output = JSON.stringify({
      status: result.status,
      reasonCode: result.reasonCode,
    })
    output.metadata = {
      ...withoutStaleConditionalMetadata(existingMetadata),
      ...metadata(),
      workflowGuard: {
        status: result.status,
        ...targetMetadataField(target),
        reasonCode: result.reasonCode,
      },
    }
  }

  // Writes the guard-owned result for a completion that was requested with no
  // epoch. The guard is re-read at write time: a skill earlier in the same
  // message batch may have activated an epoch since the before-hook, in which
  // case claiming `no-active-epoch` would be false and the current status is
  // reported instead. The outcome is recorded as this call's terminal result,
  // so a duplicate after-hook replays exactly what was written here.
  function writeNoEpochBlockedResult(
    callDigest: string,
    output: unknown,
    target: TransitionTarget,
  ): void {
    const current = requireGuard().status()
    const terminal: TerminalComplete = !current.epoch
      ? {
          target,
          status: 'rejected',
          reasonCode: 'no-active-epoch',
          title: 'Workflow transition rejected',
        }
      : current.state === 'unavailable'
        ? { target, status: 'unavailable', reasonCode: current.reasonCode }
        : {
            target,
            status: 'rejected',
            reasonCode: current.reasonCode,
            title: 'Workflow transition rejected',
          }
    terminalCompletes.set(callDigest, terminal)
    writeTerminalCompletionResult(output, terminal, target, terminal.title)
  }

  // Only the no-epoch block is guard-owned output; every other blocked
  // reason keeps writing nothing here.
  function writeBlockedCompleteResult(
    callDigest: string,
    output: unknown,
    blocked: BlockedComplete | undefined,
  ): void {
    if (blocked?.reasonCode === 'no-active-epoch') {
      writeNoEpochBlockedResult(callDigest, output, blocked.target)
    }
  }

  // A completion that never reached `guard.finalizeTransition` (mismatched
  // target, no replayable transition, or a failed readback bundle) must not
  // leave the tool result carrying whatever pre-finalization metadata was
  // written earlier in the request. Writes a full terminal result through
  // `writeTerminalCompletionResult()` so the shape and reason-code
  // vocabulary match every other non-success completion outcome.
  function writeAbandonedCompletionResult(
    output: unknown,
    target: TransitionTarget | undefined,
    reasonCode: WorkflowReasonCode,
  ): void {
    writeTerminalCompletionResult(
      output,
      { target, status: 'unavailable', reasonCode },
      target,
    )
  }

  // Companion to writeAbandonedCompletionResult() for the case where the
  // HOST tool itself failed: the output already carries the host's own
  // error title/text, which is evidence and must not be destroyed. Only the
  // metadata is corrected, using a fresh metadata() read taken after
  // guard.abandonTransition() so it reflects the corrected guard state.
  //
  // The host's existing metadata is preserved (spread first, lowest
  // precedence) rather than replaced outright: on this path the host's own
  // metadata carries the failure sentinel (`status: 'error' | 'failure' |
  // 'cancelled'`) that `isSuccessfulAfter()` reads. Guard instances share
  // the `output` reference across `tool.execute.after` calls, so replacing
  // the metadata wholesale would erase that sentinel for any later
  // instance and make it misclassify the call as successful — the exact
  // fail-open inversion this fix exists to prevent.
  function writeAbandonedCompletionMetadata(
    output: unknown,
    target: TransitionTarget,
    reasonCode: WorkflowReasonCode,
  ): void {
    if (!isRecord(output)) return
    const existingMetadata = isRecord(output.metadata) ? output.metadata : {}
    output.metadata = {
      ...withoutStaleConditionalMetadata(existingMetadata),
      ...metadata(),
      workflowGuard: { status: 'unavailable', target, reasonCode },
    }
  }

  function prepareSkill(host: HostToolBefore, args: unknown): void {
    const skill = normalizeSkill(host.tool, args)
    if (!skill) return
    const callDigest = digestCall(ledger, host.callID)
    if (bindCall(callDigest, 'skill', skill) !== 'new') return
    pendingSkills.set(callDigest, { callID: host.callID, skill })
  }

  function prepareStart(host: HostToolBefore, args: unknown): void {
    const normalized = normalizeStartInput(args)
    if (normalized === undefined) return
    const callDigest = digestCall(ledger, host.callID)
    const fingerprint = JSON.stringify(normalized)
    if (bindCall(callDigest, 'start', fingerprint) !== 'new') return
    pendingStarts.set(callDigest, {
      callID: host.callID,
      input: normalized,
      fingerprint,
    })
  }

  function gateCompleteWithQuestion(
    host: HostToolBefore,
    target: TransitionTarget,
    callDigest: string,
    status: WorkflowStatus,
  ): boolean {
    const transitionChallenge = [...pendingQuestionChallenges.values()].find(
      (pending) =>
        pending.purpose === 'transition' && pending.transition === target,
    )
    if (
      transitionChallenge &&
      questionProjection().status === 'attested' &&
      consumeQuestion(transitionChallenge)
    ) {
      consumedQuestionTargets.add(target)
    }
    if (
      status.reasonCode !== 'missing-evidence' ||
      status.missingOperations.length === 0 ||
      consumedQuestionTargets.has(target)
    ) {
      return false
    }
    const challenge = challengeForTransition(host.sessionID, target)
    if (!challenge) {
      markUnavailable(hookCause('tool-before', 'call-lifecycle-mismatch'))
      return true
    }
    if (options.config.mode === 'protected') {
      throw createWorkflowGuardBlockedError('guard-unavailable')
    }
    blockedCompletes.set(callDigest, {
      target,
      reasonCode: status.reasonCode,
    })
    blockedQuestionCalls.set(callDigest, challenge.challenge.challengeId)
    return true
  }

  function prepareComplete(host: HostToolBefore, args: unknown): void {
    const target = normalizeTarget(args)
    if (!target) return
    const callDigest = digestCall(ledger, host.callID)
    if (bindCall(callDigest, 'complete', target) === 'conflict') {
      if (options.config.mode === 'protected') {
        throw createWorkflowGuardBlockedError('guard-unavailable')
      }
      return
    }
    const status = requireGuard().status()
    if (gateCompleteWithQuestion(host, target, callDigest, status)) return
    const prepared = requireGuard().prepareTransition({
      callId: host.callID,
      target,
    })
    if (prepared.status === 'allowed') {
      pendingCompletes.set(callDigest, {
        callID: host.callID,
        target,
        transitionId: prepared.transitionId,
      })
      return
    }
    // A completion requested before any epoch exists is a guard-owned
    // rejection recorded for the after-hook, in protected mode too. Every
    // other blocked reason keeps the protected-mode throw.
    if (
      options.config.mode === 'protected' &&
      prepared.reasonCode !== 'no-active-epoch'
    ) {
      throw createWorkflowGuardBlockedError(prepared.reasonCode)
    }
    blockedCompletes.set(callDigest, {
      target,
      reasonCode: prepared.reasonCode,
    })
  }

  async function remoteIntentForOperation(
    host: HostToolBefore,
    args: unknown,
    observer: OpencodeOperationObserver,
  ): Promise<
    | {
        operation: RemoteOperation
        before?: OperationObserverRemoteResult
      }
    | undefined
  > {
    if (host.tool !== 'bash' || !isRecord(args)) return undefined
    const command = bashCommand(args)
    if (!command) return undefined
    const classification = await classifyCommandIntent(
      options.classifier,
      command,
    )
    if (!classification || !remoteOperation(classification.category))
      return undefined
    const remoteSnapshot = observer.remoteSnapshot
    if (!remoteSnapshot) return { operation: classification.category }
    try {
      let before = await remoteSnapshot(classification.category, 'before')
      // A deferred operation gets one immediate retry on a probe timeout.
      if (
        before.status === 'unavailable' &&
        before.reasonCode === 'command-timeout' &&
        deferredSeedFor(classification.category)
      ) {
        before = await remoteSnapshot(classification.category, 'before')
      }
      return { operation: classification.category, before }
    } catch {
      return { operation: classification.category }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: target derivation, registered-worktree validation, and observer registration must stay atomic on the before hook
  async function prepareOperation(
    host: HostToolBefore,
    args: unknown,
  ): Promise<void> {
    if (!options.observer || !isLocalOperationTool(host.tool)) return
    // Decided before any argument work: fingerprinting can fail on large
    // arguments, and a skipped call must not depend on it.
    if (!operationObservationApplies()) {
      skippedOperations.add(digestCall(ledger, host.callID))
      return
    }
    // Captured before the first await: the unit can change while the
    // snapshot and remote probes are in flight.
    const initiator = currentInitiator()
    const { parentTargetRoot, sessionLocation } = effectiveTargetContext()
    const fingerprint = argsFingerprint(
      ledger,
      host.tool,
      args,
      sessionLocation,
    )
    if (!fingerprint) {
      markUnavailable(beforeCause('operation-input-invalid'))
      return
    }
    const callDigest = digestCall(ledger, host.callID)
    if (
      bindCall(callDigest, 'operation', `${host.tool}:${fingerprint}`) !== 'new'
    ) {
      return
    }
    const target = deriveOpencodeOperationTarget(host.tool, args, {
      parentTargetRoot,
      sessionLocation,
      validateRegisteredWorktree: options.observer.validateRegisteredWorktree,
    })
    if (target.status === 'unavailable') {
      markUnavailable(beforeCause('operation-input-invalid', target.reasonCode))
      return
    }
    let registeredTarget: RegisteredWorktreeValidationResult
    try {
      registeredTarget = options.observer.validateRegisteredWorktree(
        target.targetRoot,
      )
    } catch {
      markUnavailable(beforeCause('operation-input-invalid'))
      return
    }
    const registeredIdentity = registeredWorktreeIdentity(registeredTarget)
    if (
      registeredTarget.status !== 'ok' ||
      registeredIdentity === undefined ||
      registeredTarget.targetRoot !== target.targetRoot
    ) {
      markUnavailable(
        beforeCause(
          'operation-input-invalid',
          registeredTarget.status === 'error'
            ? registeredTarget.reasonCode
            : undefined,
        ),
      )
      return
    }
    const canonicalParentTargetRoot = canonicalExistingPath(
      parentTargetRoot,
      fs.realpathSync,
    )
    if (!canonicalParentTargetRoot) {
      markUnavailable(beforeCause('operation-input-invalid'))
      return
    }
    const operationObserver =
      target.targetRoot === canonicalParentTargetRoot
        ? options.observer
        : ([...operationObservers.values()].find(
            (registration) => registration.targetRoot === target.targetRoot,
          )?.observer ??
          (options.createTargetObserver ?? defaultTargetObserver)(
            target.targetRoot,
          ))
    let result: OperationObserverResult
    try {
      result = await operationObserver.snapshot()
    } catch {
      markUnavailable(beforeCause('local-snapshot-error'))
      return
    }
    if (result.status === 'unavailable') {
      markUnavailable(
        beforeCause('local-snapshot-unavailable', result.reasonCode),
      )
      return
    }
    if (result.snapshot.targetDigest !== operationObserver.targetDigest) {
      markUnavailable(beforeCause('operation-target-mismatch'))
      return
    }
    rememberOperationObserver({
      targetRoot: target.targetRoot,
      registeredWorktreeIdentity: registeredIdentity,
      observer: operationObserver,
    })
    const remote = await remoteIntentForOperation(host, args, operationObserver)
    if (remote) {
      bindDeferredBaseline(
        remote.operation,
        remote.before,
        operationObserver,
        initiator,
      )
    }
    pendingOperations.set(callDigest, {
      callID: host.callID,
      tool: host.tool,
      argsFingerprint: fingerprint,
      targetRoot: target.targetRoot,
      targetIdentity: operationObserver.targetDigest,
      registeredWorktreeIdentity: registeredIdentity,
      observer: operationObserver,
      before: result.snapshot,
      ...(initiator ? { initiator } : {}),
      ...(remote
        ? { remoteOperation: remote.operation, remoteBefore: remote.before }
        : {}),
    })
  }

  async function prepareHostCall(
    host: HostToolBefore,
    args: unknown,
  ): Promise<void> {
    if (host.tool === 'systematic_skill' || host.tool === 'skill') {
      prepareSkill(host, args)
    } else if (host.tool === 'systematic_workflow_start') {
      prepareStart(host, args)
    } else if (host.tool === 'systematic_workflow_complete') {
      prepareComplete(host, args)
    } else if (isLocalOperationTool(host.tool)) {
      await prepareOperation(host, args)
    }
  }

  function interceptQuestion(host: HostToolBefore, output: unknown): void {
    if (!isRecord(output)) return
    const pending = [...pendingQuestionChallenges.values()].find(
      (candidate) => candidate.questionCallID === undefined,
    )
    if (!pending) return
    pending.questionCallID = host.callID
    output.args = canonicalQuestionArgs(pending)
  }

  async function handleQuestionAsked(
    properties: Record<string, unknown>,
  ): Promise<void> {
    const tool = isRecord(properties.tool) ? properties.tool : undefined
    const callID =
      tool && boundedString(tool.callID, MAX_CALL_ID_LENGTH)
        ? tool.callID
        : undefined
    const requestID = boundedString(properties.id, MAX_CALL_ID_LENGTH)
      ? properties.id
      : undefined
    if (!callID || !requestID) return
    const pending = [...pendingQuestionChallenges.values()].find(
      (candidate) => candidate.questionCallID === callID,
    )
    if (!pending) return
    const result = questionAttestation.bindAsked({
      challengeId: pending.challenge.challengeId,
      callId: callID,
      requestId: requestID,
    })
    if (result.status === 'bound') pending.requestID = requestID
  }

  function handleQuestionReplied(
    sessionID: string,
    properties: Record<string, unknown>,
  ): void {
    const requestID = boundedString(properties.requestID, MAX_CALL_ID_LENGTH)
      ? properties.requestID
      : undefined
    if (!requestID) return
    questionAttestation.observeReply({
      sessionId: sessionID,
      requestId: requestID,
      answer: strictQuestionAnswer(properties.answers),
    })
  }

  function handleQuestionRejected(
    sessionID: string,
    properties: Record<string, unknown>,
  ): void {
    const requestID = boundedString(properties.requestID, MAX_CALL_ID_LENGTH)
      ? properties.requestID
      : undefined
    if (!requestID) return
    questionAttestation.observeReject({
      sessionId: sessionID,
      requestId: requestID,
    })
  }

  async function routeQuestionEvent(
    eventType: string,
    sessionID: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (eventType === 'question.asked') {
      await handleQuestionAsked(properties)
      return
    }
    if (eventType === 'question.replied') {
      handleQuestionReplied(sessionID, properties)
      return
    }
    if (eventType === 'question.rejected') {
      handleQuestionRejected(sessionID, properties)
    }
  }

  async function event(input: unknown): Promise<void> {
    if (!isRecord(input) || !isRecord(input.event)) return
    const hostEvent = input.event
    const eventType = boundedString(hostEvent.type, 128)
      ? hostEvent.type
      : undefined
    const properties = isRecord(hostEvent.properties)
      ? hostEvent.properties
      : undefined
    const sessionID =
      properties && boundedString(properties.sessionID, 256)
        ? properties.sessionID
        : undefined
    if (!eventType || !sessionID || !properties) return
    await recoverFromHost(sessionID)
    await routeQuestionEvent(eventType, sessionID, properties)
  }

  async function before(input: unknown, output: unknown): Promise<void> {
    try {
      const host = parseHostBefore(input)
      if (!host || !isRecord(output)) return
      await recoverFromHost(host.sessionID)
      if (host.tool === 'question') interceptQuestion(host, output)
      await prepareHostCall(host, output.args)
    } catch (error) {
      if (isWorkflowGuardBlockedError(error)) throw error
      markUnavailable(hookCause('tool-before', 'hook-threw'))
      // With no guard there is nothing to enforce or observe the call, so
      // protected mode must not let it run.
      if (options.config.mode === 'protected' && !guardPublished()) {
        throw createWorkflowGuardBlockedError('guard-unavailable')
      }
    }
  }

  // Returns the cause on failure instead of writing it directly: the caller
  // must pass it to markUnavailable(cause), which is the only place that
  // commits it, atomically with the mode transition. Never write
  // firstUnavailableCause from here — see markUnavailable().
  async function seedRemoteScopes(
    operations: readonly ReceiptOperation[],
  ): Promise<GuardUnavailableCause | undefined> {
    const remoteOperations = operations.filter(remoteOperation)
    if (remoteOperations.length === 0) return undefined
    const remoteSnapshot = options.observer?.remoteSnapshot
    if (!remoteSnapshot || !options.observer) {
      return {
        site: 'seed-remote-scopes',
        kind: 'observer-not-configured',
        timedOut: false,
      }
    }
    let local: OperationObserverResult
    try {
      local = await options.observer.snapshot()
    } catch {
      return {
        site: 'seed-remote-scopes',
        kind: 'local-snapshot-error',
        timedOut: false,
      }
    }
    if (local.status === 'unavailable') {
      return {
        site: 'seed-remote-scopes',
        kind: 'local-snapshot-unavailable',
        reasonCode: local.reasonCode,
        timedOut: local.reasonCode === 'command-timeout',
      }
    }
    return seedEachRemoteScope(remoteOperations, remoteSnapshot, local.snapshot)
  }

  // Continues past deferrals; only a fatal outcome stops seeding.
  async function seedEachRemoteScope(
    operations: readonly RemoteOperation[],
    reader: NonNullable<OpencodeOperationObserver['remoteSnapshot']>,
    local: OperationObserverSnapshot,
  ): Promise<GuardUnavailableCause | undefined> {
    for (const operation of operations) {
      const outcome = await seedRemoteScope(reader, operation, local)
      if (outcome.kind === 'fatal') return outcome.cause
      // A redeclaration of the same unit keeps its deferral record, so each
      // fresh seed of an operation supersedes what an earlier seed recorded.
      clearSeedDeferral(operation)
      if (outcome.kind === 'deferred') {
        recordSeedDeferral(operation, outcome.reasonCode)
      }
    }
    return undefined
  }

  // A deferral is recorded only when the core has no baseline for the
  // operation yet (neither declared on the unit nor propagated from PR
  // creation): with a baseline there is nothing left to defer.
  function recordSeedDeferral(
    operation: RemoteOperation,
    reasonCode: SeedDeferralReason,
  ): void {
    if (requireGuard().hasResourceBaseline(operation)) return
    const observer = options.observer
    if (!observer) return
    seedDeferralEntries(true).push({
      operation,
      reasonCode,
      observer,
      targetIdentity: observer.targetDigest,
    })
  }

  // The active unit's deferral entries. A record left by another unit is
  // never returned; with `reset` it is replaced by an empty one for the
  // active unit. With no active unit nothing is recorded: the returned array
  // is a throwaway.
  function seedDeferralEntries(reset = false): DeferredSeed[] {
    const unitId = requireGuard().status().unit?.unitId
    if (!unitId) return []
    if (seedDeferralRecord?.unitId === unitId) return seedDeferralRecord.entries
    if (!reset) return []
    seedDeferralRecord = { unitId, entries: [] }
    return seedDeferralRecord.entries
  }

  function deferredSeedFor(
    operation: RemoteOperation,
  ): DeferredSeed | undefined {
    return seedDeferralEntries().find((entry) => entry.operation === operation)
  }

  function clearSeedDeferral(operation: RemoteOperation): void {
    if (!seedDeferralRecord) return
    const index = seedDeferralRecord.entries.findIndex(
      (entry) => entry.operation === operation,
    )
    if (index !== -1) seedDeferralRecord.entries.splice(index, 1)
  }

  // Binds a deferred baseline from the operation's own before-read, and only
  // from the observer and target the seed used. The readback names its
  // operation and carries the resource identity (plus revision for push)
  // only: no repository or worktree identities, and no PR-scope propagation.
  // The one exception is a `missing-resource` before-read for pr-creation,
  // which clears the deferral without binding because creation seeds its
  // baseline from the after-read. For every other operation, including
  // push, check-readback, and review-readback, anything that does not bind
  // leaves the deferral in place; nothing here marks the session unavailable
  // (the receipt fails closed instead).
  function bindDeferredBaseline(
    operation: RemoteOperation,
    before: OperationObserverRemoteResult | undefined,
    observer: OpencodeOperationObserver,
    initiator: OperationInitiator | undefined,
  ): void {
    // A read that began under another unit (or none) must not satisfy the
    // deferral of the unit that is active now.
    if (!initiator || !isCurrentInitiator(initiator)) return
    const deferred = deferredSeedFor(operation)
    if (!deferred) return
    // A baseline established since the deferral was recorded (for example
    // propagated from a PR-creation self-seed) makes it obsolete. Never
    // overwrite it; admission compares the operation against it.
    if (requireGuard().hasResourceBaseline(operation)) {
      clearSeedDeferral(operation)
      return
    }
    if (!before || !sameSeedObserver(deferred, observer)) return
    bindFromBeforeRead(operation, before)
  }

  function bindFromBeforeRead(
    operation: RemoteOperation,
    before: OperationObserverRemoteResult,
  ): void {
    if (before.status === 'missing-resource') {
      if (operation === 'pr-creation') clearSeedDeferral(operation)
      return
    }
    if (before.status !== 'available') return
    const observed = requireGuard().observeReadback(
      deferredBaselineReadback(operation, before.snapshot),
    )
    if (observed.status !== 'rejected') clearSeedDeferral(operation)
  }

  function currentInitiator(): OperationInitiator | undefined {
    const current = requireGuard().status()
    return current.epoch && current.unit
      ? {
          epochId: current.epoch.epochId,
          unitId: current.unit.unitId,
          generation: unitStartGeneration,
        }
      : undefined
  }

  function isCurrentInitiator(initiator: OperationInitiator): boolean {
    const current = currentInitiator()
    return (
      current !== undefined &&
      current.epochId === initiator.epochId &&
      current.unitId === initiator.unitId &&
      current.generation === initiator.generation
    )
  }

  function sameSeedObserver(
    deferred: DeferredSeed,
    observer: OpencodeOperationObserver,
  ): boolean {
    return (
      observer === deferred.observer &&
      observer.targetDigest === deferred.targetIdentity
    )
  }

  function deferredBaselineReadback(
    operation: RemoteOperation,
    snapshot: OperationObserverRemoteSnapshot,
  ): Record<string, unknown> {
    return {
      operation,
      workspaceIdentity: options.workspaceIdentity,
      resourceIdentity: snapshot.resourceIdentity,
      ...(operation === 'push'
        ? { resourceRevisionIdentity: snapshot.resourceRevisionIdentity }
        : {}),
      ...(operation === 'pr-creation' ? { propagate: false } : {}),
    }
  }

  // The unit's effective target: its pinned worktree, else the parent
  // checkout. Same rule as `resolveEffectiveObserver`, without the lookup.
  function currentEffectiveTargetIdentity(): string {
    return (
      requireGuard().status().unit?.pinnedOperationTargetIdentity ??
      options.workspaceIdentity
    )
  }

  // A record left by another unit is never returned.
  function currentSnapshotBlock(): SnapshotBlockRecord | undefined {
    const unitId = requireGuard().status().unit?.unitId
    return snapshotBlockRecord && snapshotBlockRecord.unitId === unitId
      ? snapshotBlockRecord
      : undefined
  }

  // With no active unit nothing is recorded: inactive sessions never block.
  function setSnapshotBlock(
    reasonCode: SnapshotBlockReason,
    targetIdentity: string,
  ): boolean {
    const unitId = requireGuard().status().unit?.unitId
    if (!unitId) return false
    snapshotBlockRecord = {
      unitId,
      unitGeneration: unitStartGeneration,
      targetIdentity,
      reasonCode,
    }
    return true
  }

  interface SnapshotBlockCapture {
    readonly record: SnapshotBlockRecord
    readonly generation: number
  }

  // A set replaces the record object and a unit start bumps the generation,
  // so a clear that began before either cannot commit afterwards.
  function snapshotBlockStillCurrent(capture: SnapshotBlockCapture): boolean {
    return (
      snapshotBlockRecord === capture.record &&
      unitStartGeneration === capture.generation &&
      currentEffectiveTargetIdentity() === capture.record.targetIdentity
    )
  }

  type SnapshotBlockFailureCause = (
    reasonCode?: GuardUnavailableCause['reasonCode'],
  ) => GuardUnavailableCause

  // Clears the unit's block with a clean local snapshot of its effective
  // target. The record and generation are captured in the same synchronous
  // segment as the `snapshot()` call; the commit runs only if both are
  // unchanged. `failureCause` builds the cause for every fatal outcome, which
  // this helper commits itself; `timeout` is left to the caller.
  async function clearSnapshotBlock(
    effective: EffectiveOperationObserver,
    failureCause: SnapshotBlockFailureCause,
  ): Promise<SnapshotBlockClearResult> {
    const record = currentSnapshotBlock()
    if (!record) return { status: 'not-blocked' }
    const capture = { record, generation: unitStartGeneration }
    if (record.targetIdentity !== effective.targetIdentity) {
      return { status: 'stale' }
    }
    const read = await readSnapshot(
      effective.observer,
      effective.targetIdentity,
    )
    if (read.status === 'timeout') return { status: 'timeout' }
    if (read.status === 'fatal') {
      return settleFailedBlockSnapshot(read.reasonCode, capture, failureCause)
    }
    if (!snapshotBlockStillCurrent(capture)) return { status: 'stale' }
    return commitSnapshotBlockClear(effective, read.value, failureCause)
  }

  function settleFailedBlockSnapshot(
    reasonCode: GuardUnavailableCause['reasonCode'],
    capture: SnapshotBlockCapture,
    failureCause: SnapshotBlockFailureCause,
  ): SnapshotBlockClearResult {
    if (isSnapshotBlockingReason(reasonCode)) {
      return snapshotBlockStillCurrent(capture)
        ? { status: 'still-blocked', reasonCode }
        : { status: 'stale' }
    }
    markUnavailable(failureCause(reasonCode))
    return { status: 'fatal' }
  }

  // One synchronous segment: the readback applies to the core locally (no
  // remote probe) so drift made while blocked marks receipts stale, then the
  // record is deleted.
  function commitSnapshotBlockClear(
    effective: EffectiveOperationObserver,
    snapshot: OperationObserverSnapshot,
    failureCause: SnapshotBlockFailureCause,
  ): SnapshotBlockClearResult {
    const observed = requireGuard().observeReadback({
      workspaceIdentity: options.workspaceIdentity,
      repositoryIdentity: snapshot.repositoryRevisionDigest,
      worktreeIdentity: snapshot.worktreeRevisionDigest,
      ...(effective.pinned
        ? { operationTargetIdentity: effective.targetIdentity }
        : {}),
    })
    if (
      observed.status === 'rejected' &&
      observed.reasonCode === 'workspace-mismatch'
    ) {
      markUnavailable(failureCause())
      return { status: 'fatal' }
    }
    snapshotBlockRecord = undefined
    return { status: 'cleared' }
  }

  const snapshotBlockControls: SnapshotBlockControls = {
    set: (reasonCode) => {
      ensureSynchronousRuntime()
      return setSnapshotBlock(reasonCode, currentEffectiveTargetIdentity())
    },
    current: () => {
      ensureSynchronousRuntime()
      const record = currentSnapshotBlock()
      return record ? { reasonCode: record.reasonCode } : undefined
    },
    clear: async () => {
      ensureSynchronousRuntime()
      const lookup = resolveEffectiveObserver()
      if (lookup.status === 'timeout') return { status: 'timeout' }
      if (lookup.status === 'fatal') {
        markUnavailable(observerReadbackFailedCause(lookup.reasonCode))
        return { status: 'fatal' }
      }
      return clearSnapshotBlock(lookup.value, observerReadbackFailedCause)
    },
  }

  function currentSeedDeferrals(): readonly SeedDeferral[] {
    return seedDeferralEntries().map(({ operation, reasonCode }) => ({
      operation,
      reasonCode,
    }))
  }

  function fatalSeed(cause: GuardUnavailableCause): RemoteSeedOutcome {
    return { kind: 'fatal', cause }
  }

  async function seedRemoteScope(
    reader: NonNullable<OpencodeOperationObserver['remoteSnapshot']>,
    operation: RemoteOperation,
    local: OperationObserverSnapshot,
  ): Promise<RemoteSeedOutcome> {
    const result = await readRemoteScope(reader, operation, 'before')
    if (!result) {
      return fatalSeed({
        site: 'seed-remote-scope',
        kind: 'remote-scope-unreadable',
        operation,
        timedOut: false,
      })
    }
    if (result.status === 'missing-resource') {
      if (operation === 'push') {
        return { kind: 'deferred', reasonCode: 'missing-resource' }
      }
      return { kind: 'tolerated' }
    }
    if (result.status !== 'available') {
      if (result.reasonCode === 'command-timeout') {
        return { kind: 'deferred', reasonCode: 'command-timeout' }
      }
      return fatalSeed({
        site: 'seed-remote-scope',
        kind: 'remote-scope-unavailable',
        operation,
        reasonCode: result.reasonCode,
        timedOut: false,
      })
    }
    const observed = requireGuard().observeReadback(
      remoteReadbackInput(
        operation,
        local,
        options.workspaceIdentity,
        result.snapshot,
        operation !== 'pr-creation',
      ),
    )
    if (observed.status === 'rejected') {
      return fatalSeed({
        site: 'seed-remote-scope',
        kind: 'remote-readback-rejected',
        operation,
        reasonCode: observed.reasonCode,
        timedOut: false,
      })
    }
    return { kind: 'seeded' }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: host skill completion preserves ordering and marker projection
  async function finishSkill(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    const callDigest = digestCall(ledger, host.callID)
    const finalSkill = normalizeSkill(host.tool, host.args)
    const completedSkill = completedSkillCalls.get(callDigest)
    if (completedSkill) {
      if (completedSkill !== finalSkill) {
        markUnavailable(afterCause('call-lifecycle-mismatch'))
      }
      return
    }
    const pending = pendingSkills.get(callDigest)
    if (!pending) return
    pendingSkills.delete(callDigest)
    if (!finalSkill || finalSkill !== pending.skill) {
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return
    }
    if (!isSuccessfulSkillAfter(output)) return
    completedSkillCalls.set(callDigest, pending.skill)
    await activateCompletedSkill(pending.skill)
    const status = requireGuard().status()
    if (status.epoch) {
      mergeProgressionMarker(
        output,
        projectReceiptProgressionMarker(ledger, {
          target: 'epoch',
          epochId: status.epoch.epochId,
          family: status.epoch.family,
          state: 'started',
          transitionDigest: ledger.digestIdentity('call', host.callID),
        }),
      )
    }
    if (status.epoch && status.unit) {
      mergeProgressionMarker(
        output,
        projectReceiptProgressionMarker(ledger, {
          target: 'unit',
          epochId: status.epoch.epochId,
          unitId: status.unit.unitId,
          family: status.epoch.family,
          requiredOperations: status.unit.requiredOperations,
          resourceScopes: progressionResourceScopes(status.unit),
          state: 'started',
          transitionDigest: ledger.digestIdentity('call', host.callID),
        }),
      )
    }
  }

  async function activateCompletedSkill(skill: string): Promise<void> {
    const activation = requireGuard().activate({
      event: 'guarded-skill',
      skill,
      outcome: 'success',
    })
    if (
      activation.status === 'activated' ||
      activation.status === 'reused' ||
      activation.status === 'attached'
    ) {
      runtimePolicy = trustedSkillPolicy(
        skill,
        options.runtimeRequiredOperations ?? [],
      )
      const status = requireGuard().status()
      if (!status.unit || status.unit.status === 'completed') {
        startFreshUnit({}, runtimePolicy)
        const cause = await seedRemoteScopes(
          runtimePolicy.requiredOperations ?? [],
        )
        if (cause) markUnavailable(cause)
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: host start completion preserves ordering and marker projection
  async function finishStart(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    const callDigest = digestCall(ledger, host.callID)
    const pending = pendingStarts.get(callDigest)
    pendingStarts.delete(callDigest)
    if (!pending) {
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return
    }
    const normalized = normalizeStartInput(host.args)
    if (
      normalized === undefined ||
      JSON.stringify(normalized) !== pending.fingerprint
    ) {
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return
    }
    if (!isSuccessfulAfter(output)) return
    const result = startFreshUnit(pending.input, runtimePolicy)
    if (
      result.status === 'rejected' &&
      (result.reasonCode === 'guard-unavailable' ||
        result.reasonCode === 'invalid-configuration')
    ) {
      markUnavailable(afterCause('unit-start-rejected', result.reasonCode))
    }
    if (result.status === 'started') {
      const cause = await seedRemoteScopes(
        runtimePolicy.requiredOperations ?? [],
      )
      if (cause) markUnavailable(cause)
    }
    if (result.status === 'started') {
      const startedStatus = requireGuard().status()
      const epoch = startedStatus.epoch
      const unit = startedStatus.unit
      if (!epoch || !unit) return
      mergeProgressionMarker(
        output,
        projectReceiptProgressionMarker(ledger, {
          target: 'unit',
          epochId: epoch.epochId,
          unitId: unit.unitId,
          family: epoch.family,
          requiredOperations: unit.requiredOperations,
          resourceScopes: progressionResourceScopes(unit),
          state: 'started',
          transitionDigest: ledger.digestIdentity('call', host.callID),
        }),
      )
    }
    writeStartResult(output, result)
  }

  function replayComplete(callDigest: string): boolean {
    const replay = finalizedCompletes.get(callDigest)
    if (!replay) return false
    requireGuard().finalizeTransition({
      callId: replay.callID,
      transitionId: replay.transitionId,
    })
    return true
  }

  function finalizeComplete(
    callDigest: string,
    pending: PendingComplete,
    output: unknown,
    readbacks?: readonly unknown[],
  ): void {
    pendingCompletes.delete(callDigest)
    if (!isSuccessfulAfter(output)) {
      requireGuard().abandonTransition({
        callId: pending.callID,
        transitionId: pending.transitionId,
      })
      writeAbandonedCompletionMetadata(
        output,
        pending.target,
        'failed-operation',
      )
      // Remembered so a replay of this callID reproduces the same
      // 'failed-operation' reason code instead of falling through to
      // finishUnreplayableComplete()'s generic 'guard-unavailable'.
      // metadataOnly: true because the host tool's own title/output are
      // evidence here and a replay must correct only the metadata, the
      // same way this first pass did.
      abandonedCompletes.set(callDigest, pending.target)
      terminalCompletes.set(callDigest, {
        target: pending.target,
        status: 'unavailable',
        reasonCode: 'failed-operation',
        metadataOnly: true,
      })
      return
    }
    const result = requireGuard().finalizeTransition({
      callId: pending.callID,
      transitionId: pending.transitionId,
      ...(readbacks ? { readbacks } : {}),
    })
    if (result.status === 'completed' || result.status === 'duplicate') {
      finalizedCompletes.set(callDigest, pending)
      writeSuccessfulCompletionResult(output, pending.target)
      return
    }
    const reasonCode =
      'reasonCode' in result ? result.reasonCode : 'guard-unavailable'
    markUnavailable(afterCause('transition-finalize-rejected', reasonCode))
    const terminal: TerminalComplete = {
      target: pending.target,
      status: result.status === 'waiting' ? 'unavailable' : result.status,
      reasonCode,
    }
    abandonedCompletes.set(callDigest, pending.target)
    terminalCompletes.set(callDigest, terminal)
    writeTerminalCompletionResult(output, terminal, pending.target)
  }

  // metadataOnly outcomes (see TerminalComplete) came from a branch where
  // the host's own title/output are evidence and must not be rewritten by
  // writeTerminalCompletionResult()'s generic terminal-result shape — only
  // the metadata is corrected, matching the first pass.
  function writeTerminalReplay(
    output: unknown,
    terminal: TerminalComplete,
    target: TransitionTarget,
  ): void {
    if (terminal.metadataOnly) {
      writeAbandonedCompletionMetadata(output, target, terminal.reasonCode)
      return
    }
    writeTerminalCompletionResult(output, terminal, target, terminal.title)
  }

  function replayTerminalComplete(
    callDigest: string,
    finalTarget: TransitionTarget | undefined,
    output: unknown,
  ): boolean {
    const questionChallengeID = blockedQuestionCalls.get(callDigest)
    if (questionChallengeID) {
      const pending = pendingQuestionChallenges.get(questionChallengeID)
      if (pending) {
        writeToolResult(output, questionInstruction(pending))
        return true
      }
    }
    // A recorded TerminalComplete means THIS call digest already reached a
    // terminal, non-success outcome (invalid-transition, failed-operation,
    // or any other non-`completed`/`duplicate` finalizeTransition result).
    // Unlike `replay` (a finalized success, replayed by re-driving the
    // real transition) and `blockedTarget` (a still-live question gate),
    // there is no live transition left here for a mismatched `finalTarget`
    // to hijack into: writeTerminalReplay() can only ever reproduce the
    // same non-success result, never a success one, and consumes nothing.
    // So the target that PRODUCED this terminal (`terminal.target`) is
    // used to replay it, without gating on whatever `finalTarget` this
    // particular delivery happens to carry.
    const terminal = terminalCompletes.get(callDigest)
    if (terminal?.target) {
      writeTerminalReplay(output, terminal, terminal.target)
      blockedCompletes.delete(callDigest)
      return true
    }
    const replay = finalizedCompletes.get(callDigest)
    const abandonedTarget = abandonedCompletes.get(callDigest)
    const blocked = blockedCompletes.get(callDigest)
    const expectedTarget = replay?.target ?? abandonedTarget ?? blocked?.target
    if (!expectedTarget) return false
    if (finalTarget !== expectedTarget) {
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return true
    }
    if (replay) replayComplete(callDigest)
    blockedCompletes.delete(callDigest)
    writeBlockedCompleteResult(callDigest, output, blocked)
    return true
  }

  function abandonComplete(
    callDigest: string,
    pending: PendingComplete,
    remember: boolean,
  ): void {
    pendingCompletes.delete(callDigest)
    requireGuard().abandonTransition({
      callId: pending.callID,
      transitionId: pending.transitionId,
    })
    if (remember) abandonedCompletes.set(callDigest, pending.target)
  }

  // The first stage that is not ok ends the attempt. A `command-timeout` at
  // any stage is `timeout` (retryable); throws, `undefined`, target mismatch,
  // revision drift, an invalid pinned lookup, and every other reason are
  // `fatal`.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed effective-observer selection and readback bundle construction must remain a single ordered pipeline
  async function completionReadbacks(): Promise<CompletionReadbackOutcome> {
    const observer = options.observer
    if (!observer) return { status: 'none' }
    const parent = await readSnapshot(observer, options.workspaceIdentity)
    if (parent.status !== 'ok') return parent
    const lookup = resolveEffectiveObserver()
    if (lookup.status !== 'ok') return lookup
    const effective = lookup.value
    let initialEffective = parent.value
    if (effective.pinned) {
      const pinned = await readSnapshot(
        effective.observer,
        effective.targetIdentity,
      )
      if (pinned.status !== 'ok') return pinned
      initialEffective = pinned.value
    }
    const remote = await completionRemoteReadbacks(effective.observer)
    if (remote.status !== 'ready') return remote
    const finalParent = await readSnapshot(observer)
    if (finalParent.status !== 'ok') return finalParent
    if (completionParentDrifted(parent.value, finalParent.value)) {
      return { status: 'fatal' }
    }
    const final = effective.pinned
      ? await revalidatePinnedCompletion(effective, initialEffective)
      : { status: 'ready' as const, effective, snapshot: finalParent.value }
    if (final.status !== 'ready') return final
    return {
      status: 'ready',
      readbacks: [
        {
          workspaceIdentity: options.workspaceIdentity,
          repositoryIdentity: final.snapshot.repositoryRevisionDigest,
          worktreeIdentity: final.snapshot.worktreeRevisionDigest,
          operationTargetIdentity: final.effective.targetIdentity,
        },
        ...remote.readbacks.map(({ operation, snapshot }) =>
          remoteReadbackInput(
            operation,
            final.snapshot,
            options.workspaceIdentity,
            snapshot,
          ),
        ),
      ],
    }
  }

  function completionParentDrifted(
    initial: OperationObserverSnapshot,
    final: OperationObserverSnapshot,
  ): boolean {
    return (
      final.targetDigest !== initial.targetDigest ||
      final.repositoryRevisionDigest !== initial.repositoryRevisionDigest ||
      final.worktreeRevisionDigest !== initial.worktreeRevisionDigest
    )
  }

  // Second lookup and snapshot of the pinned target. The observer, target, and
  // revision digests must be exactly what the first pass saw.
  async function revalidatePinnedCompletion(
    effective: EffectiveOperationObserver,
    initial: OperationObserverSnapshot,
  ): Promise<
    | {
        readonly status: 'ready'
        readonly effective: EffectiveOperationObserver
        readonly snapshot: OperationObserverSnapshot
      }
    | ProbeFailure
  > {
    const lookup = resolveEffectiveObserver()
    if (lookup.status !== 'ok') return lookup
    const revalidated = lookup.value
    if (
      revalidated.observer !== effective.observer ||
      revalidated.targetIdentity !== effective.targetIdentity ||
      !revalidated.pinned
    ) {
      return { status: 'fatal' }
    }
    const pinned = await readSnapshot(
      revalidated.observer,
      revalidated.targetIdentity,
    )
    if (pinned.status !== 'ok') return pinned
    if (
      pinned.value.repositoryRevisionDigest !==
        initial.repositoryRevisionDigest ||
      pinned.value.worktreeRevisionDigest !== initial.worktreeRevisionDigest
    ) {
      return { status: 'fatal' }
    }
    return {
      status: 'ready',
      effective: revalidated,
      snapshot: pinned.value,
    }
  }

  async function completionRemoteReadbacks(
    observer: OpencodeOperationObserver,
  ): Promise<CompletionRemoteOutcome> {
    const remoteOperations = requireGuard()
      .status()
      .satisfiedOperations.filter(remoteOperation)
    if (remoteOperations.length === 0) return { status: 'ready', readbacks: [] }
    const remoteSnapshot = observer.remoteSnapshot
    if (!remoteSnapshot) return { status: 'fatal' }
    const readbacks: Array<{
      operation: RemoteOperation
      snapshot: OperationObserverRemoteSnapshot
    }> = []
    for (const operation of remoteOperations) {
      const result = await readRemoteScope(remoteSnapshot, operation)
      if (isProbeTimeout(result)) return { status: 'timeout' }
      if (result?.status !== 'available') {
        return { status: 'fatal', reasonCode: remoteFailureReason(result) }
      }
      readbacks.push({ operation, snapshot: result.snapshot })
    }
    return { status: 'ready', readbacks }
  }

  function finishMismatchedTarget(
    callDigest: string,
    pending: PendingComplete,
    output: unknown,
  ): void {
    // remember=true (and the paired terminalCompletes entry below) so a
    // replay of this callID reproduces 'invalid-transition' instead of
    // falling through to finishUnreplayableComplete()'s generic
    // 'guard-unavailable'.
    abandonComplete(callDigest, pending, true)
    terminalCompletes.set(callDigest, {
      target: pending.target,
      status: 'unavailable',
      reasonCode: 'invalid-transition',
    })
    markUnavailable(afterCause('call-lifecycle-mismatch'))
    writeAbandonedCompletionResult(output, pending.target, 'invalid-transition')
  }

  function finishUnreplayableComplete(
    finalTarget: TransitionTarget | undefined,
    output: unknown,
  ): void {
    markUnavailable(afterCause('call-lifecycle-mismatch'))
    // No pending transition and nothing replayable: `finalTarget` is
    // whatever normalizeTarget() could read out of this call's own args
    // (real, when the args named a valid target) and is passed through
    // as-is. When it is also undefined the target is genuinely unknown,
    // and writeAbandonedCompletionResult()/writeTerminalCompletionResult()
    // omit the `target` key entirely rather than guessing one.
    writeAbandonedCompletionResult(output, finalTarget, 'guard-unavailable')
  }

  // A fatal completion readback. The terminal entry makes a duplicate
  // after-hook replay exactly the result written here, and the transition
  // records its cause (first-wins: a session that was already unavailable keeps
  // its earlier cause).
  function finishUnavailableReadback(
    callDigest: string,
    pending: PendingComplete,
    output: unknown,
    reasonCode?: GuardUnavailableCause['reasonCode'],
  ): void {
    abandonComplete(callDigest, pending, true)
    terminalCompletes.set(callDigest, {
      target: pending.target,
      status: 'unavailable',
      reasonCode: 'finalization-failed',
    })
    markUnavailable(
      observerReadbackFailedCause(reasonCode, 'complete-readback'),
    )
    writeAbandonedCompletionResult(
      output,
      pending.target,
      'finalization-failed',
    )
  }

  // A session that went unavailable while the probe was in flight is not
  // retryable: it takes the fatal path.
  function finishReadbackTimeout(
    callDigest: string,
    pending: PendingComplete,
    output: unknown,
  ): void {
    if (requireGuard().status().state === 'unavailable') {
      finishUnavailableReadback(callDigest, pending, output, 'command-timeout')
    } else {
      finishRetryableReadback(callDigest, pending, output)
    }
  }

  // A probe timed out: reject this attempt as retryable. Nothing is consumed
  // and the session is NOT marked unavailable. The terminal entry makes a
  // duplicate after-hook replay exactly what is written here.
  function finishRetryableReadback(
    callDigest: string,
    pending: PendingComplete,
    output: unknown,
  ): void {
    abandonComplete(callDigest, pending, true)
    const terminal: TerminalComplete = {
      target: pending.target,
      status: 'rejected',
      reasonCode: 'readback-timeout',
      title: 'Workflow readback timed out',
    }
    terminalCompletes.set(callDigest, terminal)
    writeTerminalCompletionResult(
      output,
      terminal,
      pending.target,
      terminal.title,
    )
  }

  async function finishComplete(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    const callDigest = digestCall(ledger, host.callID)
    const pending = pendingCompletes.get(callDigest)
    const finalTarget = normalizeTarget(host.args)
    if (pending && (!finalTarget || finalTarget !== pending.target)) {
      finishMismatchedTarget(callDigest, pending, output)
      return
    }
    if (!pending) {
      if (replayTerminalComplete(callDigest, finalTarget, output)) return
      finishUnreplayableComplete(finalTarget, output)
      return
    }
    const readbacks = await completionReadbacks()
    if (readbacks.status === 'fatal') {
      finishUnavailableReadback(
        callDigest,
        pending,
        output,
        readbacks.reasonCode,
      )
      return
    }
    if (readbacks.status === 'timeout') {
      finishReadbackTimeout(callDigest, pending, output)
      return
    }
    finalizeComplete(
      callDigest,
      pending,
      output,
      readbacks.status === 'ready' ? readbacks.readbacks : undefined,
    )
  }

  function sealOperation(
    callDigest: string,
    operation: PendingOperation,
    abandoned = false,
  ): void {
    const sealed = {
      tool: operation.tool,
      argsFingerprint: operation.argsFingerprint,
    }
    if (abandoned) abandonedOperations.set(callDigest, sealed)
    else sealedOperations.set(callDigest, sealed)
  }

  function isSealedOperationReplay(
    callDigest: string,
    host: HostToolAfter,
    fingerprint: string | undefined,
  ): boolean {
    const sealed = sealedOperations.get(callDigest)
    const abandoned = abandonedOperations.get(callDigest)
    const prior = sealed ?? abandoned
    if (prior !== undefined && 'skipped' in prior) return true
    return (
      prior !== undefined &&
      fingerprint !== undefined &&
      prior.tool === host.tool &&
      prior.argsFingerprint === fingerprint
    )
  }

  function takePendingOperation(
    callDigest: string,
    host: HostToolAfter,
    fingerprint: string | undefined,
  ): PendingOperation | undefined {
    const pending = pendingOperations.get(callDigest)
    if (!pending) {
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return undefined
    }
    pendingOperations.delete(callDigest)
    if (
      pending.tool !== host.tool ||
      fingerprint === undefined ||
      fingerprint !== pending.argsFingerprint
    ) {
      sealOperation(callDigest, pending, true)
      markUnavailable(afterCause('call-lifecycle-mismatch'))
      return undefined
    }
    return pending
  }

  // Re-validates the registered worktree the operation began under. Returns
  // the typed failure when it no longer matches.
  function afterTargetFailure(
    observer: OpencodeOperationObserver,
    pending: PendingOperation,
  ): OperationFailure | undefined {
    let validation: RegisteredWorktreeValidationResult
    try {
      validation = observer.validateRegisteredWorktree(pending.targetRoot)
    } catch {
      return afterFailure('operation-input-invalid')
    }
    if (
      validation.status === 'error' ||
      validation.targetRoot !== pending.targetRoot ||
      registeredWorktreeIdentity(validation) !==
        pending.registeredWorktreeIdentity
    ) {
      return afterFailure(
        'operation-input-invalid',
        validation.status === 'error' ? validation.reasonCode : undefined,
      )
    }
    return undefined
  }

  async function captureAfterOperation(
    pending: PendingOperation,
  ): Promise<
    | { status: 'available'; snapshot: OperationObserverSnapshot }
    | OperationFailure
  > {
    if (!options.observer) return afterFailure('operation-input-invalid')
    const targetFailure = afterTargetFailure(options.observer, pending)
    if (targetFailure) return targetFailure
    let result: OperationObserverResult
    try {
      result = await pending.observer.snapshot()
    } catch {
      return afterFailure('local-snapshot-error')
    }
    if (result.status === 'unavailable') {
      return afterFailure('local-snapshot-unavailable', result.reasonCode)
    }
    return result.snapshot.targetDigest === pending.targetIdentity
      ? { status: 'available', snapshot: result.snapshot }
      : afterFailure('operation-target-mismatch')
  }

  async function captureRemoteAfter(
    operation: RemoteOperation,
    observer: OpencodeOperationObserver,
  ): Promise<
    | { status: 'available'; snapshot: OperationObserverRemoteSnapshot }
    | OperationFailure
  > {
    const remoteSnapshot = observer.remoteSnapshot
    if (!remoteSnapshot) return afterFailure('operation-observation-rejected')
    let result: OperationObserverRemoteResult
    try {
      result = await remoteSnapshot(operation, 'after')
    } catch {
      return afterFailure('operation-observation-rejected')
    }
    return result.status === 'available'
      ? { status: 'available', snapshot: result.snapshot }
      : afterFailure(
          'operation-observation-rejected',
          remoteFailureReason(result),
        )
  }

  async function readRemoteScope(
    reader: NonNullable<OpencodeOperationObserver['remoteSnapshot']>,
    operation: RemoteOperation,
    phase: 'before' | 'after' = 'after',
  ): Promise<OperationObserverRemoteResult | undefined> {
    try {
      return await reader(operation, phase)
    } catch {
      return undefined
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: field projection is kept centralized for fail-closed observation construction
  function buildOperationObservation(
    host: HostToolAfter,
    pending: PendingOperation,
    after: OperationObserverSnapshot,
    current: WorkflowStatus,
    output: HostOutput,
    operation = operationCandidate(host.tool as LocalOperationTool),
    remoteAfter?: OperationObserverRemoteSnapshot,
  ): ReceiptOperationObservation | undefined {
    if (!current.epoch || !current.unit || !isLocalOperationTool(host.tool)) {
      return undefined
    }
    const command = host.tool === 'bash' ? bashCommand(host.args) : undefined
    return {
      callId: host.callID,
      operation,
      tool: host.tool,
      ...(command ? { command } : {}),
      context: {
        // The unit the operation began under, not whichever is current now.
        epochId: pending.initiator?.epochId ?? current.epoch.epochId,
        unitId: pending.initiator?.unitId ?? current.unit.unitId,
        workspaceIdentity: options.workspaceIdentity,
        repositoryIdentity: pending.before.repositoryRevisionDigest,
        worktreeIdentity: pending.before.worktreeRevisionDigest,
        ...(localOperation(operation)
          ? { operationTargetIdentity: pending.targetIdentity }
          : {}),
        ...(pending.remoteBefore?.status === 'available'
          ? {
              resourceIdentity: pending.remoteBefore.snapshot.resourceIdentity,
              resourceRevisionIdentity:
                pending.remoteBefore.snapshot.resourceRevisionIdentity,
            }
          : operation === 'pr-creation' &&
              remoteAfter &&
              pending.remoteBefore?.status === 'missing-resource'
            ? { resourceIdentity: remoteAfter.resourceIdentity }
            : {}),
      },
      after: {
        workspaceIdentity: options.workspaceIdentity,
        repositoryIdentity: after.repositoryRevisionDigest,
        worktreeIdentity: after.worktreeRevisionDigest,
        ...(localOperation(operation)
          ? { operationTargetIdentity: pending.targetIdentity }
          : {}),
        commitClosure: after.commitClosure,
        ...(remoteAfter
          ? {
              resourceIdentity: remoteAfter.resourceIdentity,
              resourceRevisionIdentity: remoteAfter.resourceRevisionIdentity,
              ...(remoteAfter.pullRequest
                ? { pullRequest: remoteAfter.pullRequest }
                : {}),
              ...(remoteAfter.checkState
                ? { checkState: remoteAfter.checkState }
                : {}),
              ...(remoteAfter.reviewDecision
                ? { reviewDecision: remoteAfter.reviewDecision }
                : {}),
            }
          : {}),
      },
      terminal: terminalForOutput(host.tool, output),
    }
  }

  async function classifyLocalObservation(
    observation: ReceiptOperationObservation,
  ): Promise<
    | OperationFailure
    | { status: 'deferred' }
    | { status: 'ready'; observation: ReceiptOperationObservation }
  > {
    const classify = options.classifier?.classifyOperation
    if (!classify) return afterFailure('operation-classifier-unavailable')
    let classification: ReceiptClassification
    try {
      classification = await classify(observation)
    } catch {
      return afterFailure('operation-classifier-unavailable')
    }
    if (!localOperation(classification.category)) {
      if (remoteOperation(classification.category)) {
        return {
          status: 'ready',
          observation: {
            ...observation,
            operation: classification.category,
          },
        }
      }
      return classification.category === null
        ? { status: 'deferred' }
        : afterFailure('operation-classifier-unavailable')
    }
    return {
      status: 'ready',
      observation: { ...observation, operation: classification.category },
    }
  }

  async function observeClassifiedOperation(
    observation: ReceiptOperationObservation,
  ): Promise<EvidenceObservationResult | undefined> {
    try {
      return await requireGuard().observeOperation(observation)
    } catch {
      return undefined
    }
  }

  // True while the unit the operation began under is still the current
  // declaration. An operation with no captured initiator (it began before any
  // unit existed) is not tied to one.
  function ownsOperation(pending: PendingOperation): boolean {
    return !pending.initiator || isCurrentInitiator(pending.initiator)
  }

  // Ownership is revalidated after every await in the pipeline below and
  // before any self-seed or admission: the unit can complete and a successor
  // (or a redeclaration) can start while an after-read is in flight. A lost
  // operation mints nothing, seeds nothing, and propagates nothing.
  function sealLostOperation(
    callDigest: string,
    pending: PendingOperation,
  ): OperationCompletionResult {
    sealOperation(callDigest, pending, true)
    return { status: 'ignored' }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the ordered fail-closed pipeline must remain atomic
  async function completeOperationObservation(
    callDigest: string,
    host: HostToolAfter,
    pending: PendingOperation,
    output: unknown,
  ): Promise<OperationCompletionResult> {
    if (!ownsOperation(pending)) return sealLostOperation(callDigest, pending)
    const parsedOutput = parseHostOutput(output)
    if (!parsedOutput) {
      sealOperation(callDigest, pending, true)
      return afterFailure('operation-input-invalid')
    }
    const capture = await captureAfterOperation(pending)
    if (!ownsOperation(pending)) return sealLostOperation(callDigest, pending)
    if (capture.status === 'unavailable') {
      sealOperation(callDigest, pending, true)
      return capture
    }
    const afterSnapshot = capture.snapshot
    const observation = buildOperationObservation(
      host,
      pending,
      afterSnapshot,
      requireGuard().status(),
      parsedOutput,
    )
    if (!observation) {
      sealOperation(callDigest, pending, true)
      return { status: 'ignored' }
    }
    const classification = await classifyLocalObservation(observation)
    if (!ownsOperation(pending)) return sealLostOperation(callDigest, pending)
    if (classification.status !== 'ready') {
      sealOperation(callDigest, pending, true)
      return classification
    }
    let finalObservation = classification.observation
    if (remoteOperation(finalObservation.operation)) {
      const remoteCapture = await captureRemoteAfter(
        finalObservation.operation,
        pending.observer,
      )
      if (!ownsOperation(pending)) {
        return sealLostOperation(callDigest, pending)
      }
      if (remoteCapture.status === 'unavailable') {
        sealOperation(callDigest, pending, true)
        return remoteCapture
      }
      const remoteAfter = remoteCapture.snapshot
      const rebuilt = buildOperationObservation(
        host,
        pending,
        afterSnapshot,
        requireGuard().status(),
        parsedOutput,
        finalObservation.operation,
        remoteAfter,
      )
      if (!rebuilt) {
        sealOperation(callDigest, pending, true)
        return { status: 'ignored' }
      }
      finalObservation = rebuilt
      if (
        finalObservation.operation === 'pr-creation' &&
        pending.remoteBefore?.status === 'missing-resource'
      ) {
        const seeded = requireGuard().observeReadback({
          operation: 'pr-creation',
          workspaceIdentity: options.workspaceIdentity,
          repositoryIdentity: afterSnapshot.repositoryRevisionDigest,
          worktreeIdentity: afterSnapshot.worktreeRevisionDigest,
          resourceIdentity: remoteAfter.resourceIdentity,
          ...(remoteAfter.pullRequest
            ? { pullRequest: remoteAfter.pullRequest }
            : {}),
        })
        if (seeded.status === 'rejected') {
          sealOperation(callDigest, pending, true)
          return afterFailure(
            'operation-observation-rejected',
            seeded.reasonCode,
          )
        }
      }
    }
    // No await separates the last ownership check from the admission call
    // below, whose synchronous prefix reads the guard state.
    if (!ownsOperation(pending)) return sealLostOperation(callDigest, pending)
    const observed = await observeClassifiedOperation(finalObservation)
    if (!observed) {
      sealOperation(callDigest, pending, true)
      return afterFailure('operation-observation-rejected')
    }
    sealOperation(callDigest, pending, observed.status !== 'accepted')
    if (observed.status === 'unavailable') {
      return afterFailure('operation-observation-rejected', observed.reasonCode)
    }
    if (observed.status !== 'accepted') return { status: 'ignored' }
    return {
      status: 'accepted',
      operation: observed.operation,
      after: afterSnapshot,
    }
  }

  function receiptForOperation(callID: string, operation: ReceiptOperation) {
    const callDigest = digestCall(ledger, callID)
    return ledger
      .listReceipts()
      .find(
        (receipt) =>
          receipt.canonical.callDigest === callDigest &&
          receipt.canonical.operation === operation &&
          receipt.canonical.consumption === 'available',
      )
  }

  function mergeReceiptMarker(output: unknown, receipt: ReceiptEnvelope): void {
    if (!isRecord(output) || !isRecord(output.metadata)) return
    const marker = projectReceiptMintMarker(receipt, ledger.getSessionSalt())
    if (!marker) return
    const existing = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    output.metadata = {
      ...output.metadata,
      [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: existing
        ? Array.isArray(existing)
          ? [...existing, marker]
          : [existing, marker]
        : marker,
    }
  }

  function mergeProgressionMarker(output: unknown, marker: unknown): void {
    if (!isRecord(output) || !isRecord(output.metadata) || !marker) return
    const existing = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    output.metadata = {
      ...output.metadata,
      [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: existing
        ? Array.isArray(existing)
          ? [...existing, marker]
          : [existing, marker]
        : marker,
    }
  }

  // The pending record for an after-hook, or undefined when the call must be
  // silent: skipped by the observation gate, or a replay of a sealed call.
  function takeOperationToFinish(
    callDigest: string,
    host: LocalOperationAfter,
  ): PendingOperation | undefined {
    if (skippedOperations.has(callDigest)) return undefined
    const { sessionLocation } = effectiveTargetContext()
    const fingerprint = argsFingerprint(
      ledger,
      host.tool,
      host.args,
      sessionLocation,
    )
    if (isSealedOperationReplay(callDigest, host, fingerprint)) return undefined
    return takePendingOperation(callDigest, host, fingerprint)
  }

  async function finishOperation(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    if (!options.observer || !isLocalOperationAfter(host)) return
    const callDigest = digestCall(ledger, host.callID)
    const pending = takeOperationToFinish(callDigest, host)
    if (!pending) return
    const result = await completeOperationObservation(
      callDigest,
      host,
      pending,
      output,
    )
    if (result.status === 'unavailable') {
      markUnavailable(result.cause)
      return
    }
    if (result.status !== 'accepted') return
    const receipt = receiptForOperation(host.callID, result.operation)
    if (!receipt) return
    if (localOperation(result.operation)) {
      recoveredOperationContexts.set(receipt.canonical.receiptId, {
        targetIdentity: pending.targetIdentity,
        before: pending.before,
        after: result.after,
      })
    }
    mergeReceiptMarker(output, receipt)
  }

  async function after(input: unknown, output: unknown): Promise<void> {
    try {
      const host = parseHostAfter(input)
      if (!host) return
      await recoverFromHost(host.sessionID)
      if (host.tool === 'systematic_skill' || host.tool === 'skill') {
        await finishSkill(host, output)
      } else if (host.tool === 'systematic_workflow_start') {
        await finishStart(host, output)
      } else if (host.tool === 'systematic_workflow_complete') {
        await finishComplete(host, output)
      } else if (host.tool === 'task') {
        await rollupForegroundTask(host, output)
      } else if (isLocalOperationTool(host.tool)) {
        await finishOperation(host, output)
      }
    } catch {
      markUnavailable(hookCause('tool-after', 'hook-threw'))
    }
  }

  function isInternalSystem(system: readonly string[]): boolean {
    return system.some((entry) =>
      INTERNAL_AGENT_SIGNATURES.some((signature) =>
        entry.toLowerCase().includes(signature.toLowerCase()),
      ),
    )
  }

  function appendMarker(output: Record<string, unknown>, marker: string): void {
    const system = output.system
    if (!Array.isArray(system)) return
    if (system.length === 0) {
      system.push(marker)
      return
    }
    const first = typeof system[0] === 'string' ? system[0] : ''
    system[0] = first.length > 0 ? `${first}\n\n${marker}` : marker
  }

  async function transform(input: unknown, output: unknown): Promise<void> {
    if (!isRecord(input) || !boundedString(input.sessionID, 256)) return
    await recoverFromHost(input.sessionID, false)
    abandonPending()
    // A disabled guard has nothing to attest; keep the marker out of the prompt.
    if (options.config.mode === 'disabled') return
    if (!isRecord(output) || !Array.isArray(output.system)) return
    const existingSystem = output.system.filter(
      (entry): entry is string => typeof entry === 'string',
    )
    if (isInternalSystem(existingSystem)) return
    const parsed = extractMarkerSources(existingSystem)
    const current = currentMarkerSource()
    const marker = buildMarker(parsed.sources, parsed.malformed, current)
    for (let index = 0; index < parsed.entries.length; index += 1) {
      output.system[index] = parsed.entries[index]
    }
    appendMarker(output, marker)
  }

  return {
    get ledger() {
      return initialized ? ledger : undefined
    },
    initialize: recoverFromHost,
    hooks: {
      'tool.execute.before': before,
      'tool.execute.after': after,
      event,
      'experimental.chat.system.transform': transform,
    },
    status: () => {
      ensureSynchronousRuntime()
      return initialized ? requireGuard().status() : unavailableWorkflowStatus()
    },
    readStatus,
    unavailableCause: () => firstUnavailableCause ?? pendingUnavailableCause,
    seedDeferrals: currentSeedDeferrals,
    snapshotBlock: snapshotBlockControls,
    refreshReadback,
    observeReceipt: (input) => {
      ensureSynchronousRuntime()
      return initialized
        ? requireGuard().observeReceipt(input)
        : { status: 'unavailable', reasonCode: 'guard-unavailable' }
    },
    prepareTransition: (input) => {
      ensureSynchronousRuntime()
      return initialized
        ? requireGuard().prepareTransition(input)
        : { status: 'unavailable', reasonCode: 'guard-unavailable' }
    },
    startUnit: (input, policy) => {
      ensureSynchronousRuntime()
      return initialized
        ? startFreshUnit(input, policy)
        : { status: 'rejected', reasonCode: 'guard-unavailable' }
    },
    control,
    markUnavailable,
    metadata,
    recover: recoverFromHost,
  }
}

function parseExecutionSession(context: unknown): string | undefined {
  if (!isRecord(context)) return undefined
  return boundedString(context.sessionID, 256) ? context.sessionID : undefined
}

function unavailableWorkflowStatus(): WorkflowStatus {
  return {
    state: 'unavailable',
    reasonCode: 'guard-unavailable',
    statusKey: 'unavailable:guard-unavailable',
    epoch: null,
    unit: null,
    satisfiedOperations: [],
    missingOperations: [],
  }
}

function unavailableToolResult(): string {
  return JSON.stringify({
    status: 'unavailable',
    reasonCode: 'guard-unavailable',
  })
}

function makeWorkflowTool(
  description: string,
  args: unknown,
  getRuntime: (sessionID: string) => SessionRuntime,
  execute: (
    runtime: SessionRuntime,
    input: unknown,
    sessionID: string,
  ) => ToolResultContent | Promise<ToolResultContent>,
): ToolDefinition {
  return {
    description,
    args: args as ToolDefinition['args'],
    async execute(input: unknown, context: unknown): Promise<ToolResult> {
      const sessionID = parseExecutionSession(context)
      if (!sessionID) {
        return {
          title: 'Workflow guard unavailable',
          output: unavailableToolResult(),
          metadata: {
            protocolVersion: MARKER_PROTOCOL_VERSION,
            state: 'unavailable',
            reasonCode: 'guard-unavailable',
          },
        }
      }
      const runtime = getRuntime(sessionID)
      await runtime.recover(sessionID)
      let content = await execute(runtime, input, sessionID)
      let metadata: Record<string, unknown>
      if (isRecord(context) && typeof context.metadata === 'function') {
        try {
          context.metadata({
            title: content.title,
            metadata: runtime.metadata(),
          })
        } catch {
          runtime.markUnavailable(hookCause('tool-execute', 'hook-threw'))
        }
      }
      try {
        metadata = runtime.metadata()
      } catch {
        runtime.markUnavailable(hookCause('tool-execute', 'hook-threw'))
        metadata = {
          protocolVersion: MARKER_PROTOCOL_VERSION,
          state: 'unavailable',
          reasonCode: 'guard-unavailable',
        }
        content = {
          title: 'Workflow guard unavailable',
          output: unavailableToolResult(),
        }
      }
      return { ...content, metadata }
    },
  } as unknown as ToolDefinition
}

export function createOpencodeWorkflowGuard(
  options: OpencodeWorkflowGuardOptions,
): OpencodeWorkflowGuard {
  const sessions = new Map<string, SessionRuntime>()
  const operationObservers: OperationObserverRegistry = new Map()
  const recoveredOperationContexts: RecoveredOperationRegistry = new Map()
  // Captured once per guard instance (the process's registration), not per
  // lazily created session runtime, so a turn the host created before the
  // first hook for a session ran still counts as this process's turn.
  const runtimeStartedAt = (options.now ?? Date.now)()

  function sessionRuntimeFor(sessionID: string): SessionRuntime {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const runtime = createSessionRuntime(
      {
        ...options,
        registrationIdentity: options.registrationIdentity,
        sessionSalt: options.sessionSalt,
      },
      operationObservers,
      recoveredOperationContexts,
      runtimeStartedAt,
    )
    sessions.set(sessionID, runtime)
    return runtime
  }

  const tools: Record<string, ToolDefinition> = {
    systematic_workflow_start: makeWorkflowTool(
      'Request the start of a guarded workflow unit.',
      startToolShape,
      sessionRuntimeFor,
      (_runtime, input) =>
        startToolSchema.safeParse(input).success
          ? {
              title: 'Workflow guard start pending',
              output: JSON.stringify({ status: 'pending', operation: 'start' }),
            }
          : {
              title: 'Workflow guard unavailable',
              output: unavailableToolResult(),
            },
    ),
    systematic_workflow_status: makeWorkflowTool(
      'Read the bounded guarded workflow status.',
      statusToolShape,
      sessionRuntimeFor,
      async (runtime, input) => {
        const unconfirmed = await runtime.refreshReadback()
        return {
          title: 'Workflow guard status',
          output: statusToolSchema.safeParse(input).success
            ? statusForTool(
                runtime.readStatus(),
                runtime.unavailableCause(),
                runtime.seedDeferrals(),
                unconfirmed,
                runtime.snapshotBlock.current(),
              )
            : unavailableToolResult(),
        }
      },
    ),
    systematic_workflow_complete: makeWorkflowTool(
      'Request completion of a guarded workflow unit or epoch.',
      completeToolShape,
      sessionRuntimeFor,
      (_runtime, input) =>
        completeToolSchema.safeParse(input).success
          ? {
              title: 'Workflow guard completion pending',
              output: JSON.stringify({
                status: 'pending',
                operation: 'complete',
              }),
            }
          : {
              title: 'Workflow guard unavailable',
              output: unavailableToolResult(),
            },
    ),
    systematic_workflow_control: makeWorkflowTool(
      'Report the future trusted workflow control surface.',
      controlToolShape,
      sessionRuntimeFor,
      (runtime, input, sessionID) =>
        controlToolSchema.safeParse(input).success
          ? runtime.control(sessionID, input)
          : {
              title: 'Workflow guard unavailable',
              output: unavailableToolResult(),
            },
    ),
  }

  async function before(input: unknown, output: unknown): Promise<void> {
    const host = parseHostBefore(input)
    if (!host) return
    // The runtime hook already converts every non-blocked exception into a
    // `hook-threw` cause; a blocked error propagates to the host unchanged.
    await sessionRuntimeFor(host.sessionID).hooks['tool.execute.before'](
      input,
      output,
    )
  }

  async function after(input: unknown, output: unknown): Promise<void> {
    const host = parseHostAfter(input)
    if (!host) return
    // The runtime hook already converts every exception into a `hook-threw`
    // cause.
    await sessionRuntimeFor(host.sessionID).hooks['tool.execute.after'](
      input,
      output,
    )
  }

  async function event(input: unknown): Promise<void> {
    if (!isRecord(input) || !isRecord(input.event)) return
    const properties = isRecord(input.event.properties)
      ? input.event.properties
      : undefined
    const sessionID =
      properties && boundedString(properties.sessionID, 256)
        ? properties.sessionID
        : undefined
    if (!sessionID) return
    const runtime = sessionRuntimeFor(sessionID)
    try {
      await runtime.hooks.event(input)
    } catch {
      runtime.markUnavailable(hookCause('event', 'hook-threw'))
    }
  }

  async function transform(input: unknown, output: unknown): Promise<void> {
    if (!isRecord(input) || !boundedString(input.sessionID, 256)) return
    const runtime = sessionRuntimeFor(input.sessionID)
    try {
      await runtime.hooks['experimental.chat.system.transform'](input, output)
    } catch {
      runtime.markUnavailable(hookCause('transform', 'hook-threw'))
    }
  }

  return {
    tools,
    hooks: {
      'tool.execute.before': before,
      'tool.execute.after': after,
      event,
      'experimental.chat.system.transform': transform,
    },
    status(sessionID: unknown): WorkflowStatus {
      if (!boundedString(sessionID, 256)) {
        return {
          state: 'unavailable',
          reasonCode: 'guard-unavailable',
          statusKey: 'unavailable:guard-unavailable',
          epoch: null,
          unit: null,
          satisfiedOperations: [],
          missingOperations: [],
        }
      }
      return sessionRuntimeFor(sessionID).status()
    },
    ledger(sessionID: unknown): ReceiptLedger | undefined {
      return boundedString(sessionID, 256)
        ? sessionRuntimeFor(sessionID).ledger
        : undefined
    },
    observeReceipt(
      sessionID: unknown,
      input: unknown,
    ): EvidenceObservationResult {
      if (!boundedString(sessionID, 256)) {
        return { status: 'unavailable', reasonCode: 'guard-unavailable' }
      }
      return sessionRuntimeFor(sessionID).observeReceipt(input)
    },
    prepareTransition(
      sessionID: unknown,
      input: unknown,
    ): TransitionPrepareResult {
      if (!boundedString(sessionID, 256)) {
        return { status: 'unavailable', reasonCode: 'guard-unavailable' }
      }
      return sessionRuntimeFor(sessionID).prepareTransition(input)
    },
    startUnit(
      sessionID: unknown,
      input: unknown,
      policy?: RuntimeUnitPolicy,
    ): unknown {
      if (!boundedString(sessionID, 256)) {
        return { status: 'rejected', reasonCode: 'guard-unavailable' }
      }
      return sessionRuntimeFor(sessionID).startUnit(input, policy)
    },
    snapshotBlock(sessionID: unknown): SnapshotBlockControls {
      return sessionRuntimeFor(String(sessionID)).snapshotBlock
    },
  }
}
