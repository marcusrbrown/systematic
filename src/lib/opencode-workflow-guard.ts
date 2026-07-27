import { randomBytes } from 'node:crypto'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from 'zod'
import { INTERNAL_AGENT_SIGNATURES } from './bootstrap.js'
import type {
  OpencodeOperationObserver,
  OperationObserverRemoteResult,
  OperationObserverRemoteSnapshot,
  OperationObserverResult,
  OperationObserverSnapshot,
  RemoteOperation,
} from './opencode-operation-observer.js'
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
  type ReceiptClassification,
  type ReceiptEnvelope,
  type ReceiptLedger,
  type ReceiptOperation,
} from './receipt-ledger.js'
import {
  extractReceiptReadbackSeed,
  projectReceiptMintMarker,
  projectReceiptProgressionMarker,
} from './receipt-readback.js'
import {
  createWorkflowGuard,
  type EvidenceObservationResult,
  type RuntimeUnitPolicy,
  type StartUnitResult,
  type TransitionFinalizeResult,
  type TransitionPrepareResult,
  type TransitionTarget,
  type WorkflowGuard,
  type WorkflowReasonCode,
  type WorkflowStatus,
} from './workflow-guard.js'

const MARKER_OPEN = '<SYSTEMATIC_WORKFLOW_GUARD>'
const MARKER_CLOSE = '</SYSTEMATIC_WORKFLOW_GUARD>'
const MARKER_PROTOCOL_VERSION = 1
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
  'receipt-mismatch',
  'rejected-operation',
  'resource-mismatch',
  'running-operation',
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
}

export interface OpencodeWorkflowChildSession {
  readonly sessionId: string
  readonly parentID?: string
}

export interface OpencodeWorkflowHostReadback {
  readSessionParts(sessionID: string): Promise<ReadonlyArray<unknown>>
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
}

interface SessionRuntime {
  readonly ledger?: ReceiptLedger
  initialize(sessionID: string, allowFresh?: boolean): Promise<void>
  readonly hooks: OpencodeWorkflowGuardHooks
  status(): WorkflowStatus
  readStatus(): WorkflowStatus
  refreshReadback(): Promise<void>
  observeReceipt(input: unknown): EvidenceObservationResult
  prepareTransition(input: unknown): TransitionPrepareResult
  startUnit(input: unknown, policy?: RuntimeUnitPolicy): unknown
  control(sessionID: string, input: unknown): ToolResultContent
  markUnavailable(): void
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
  before: OperationObserverSnapshot
  remoteOperation?: RemoteOperation
  remoteBefore?: OperationObserverRemoteResult
}

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

interface TerminalComplete {
  target: TransitionTarget
  status: 'rejected' | 'unavailable'
  reasonCode: WorkflowReasonCode
}

type OperationCompletionResult =
  | { status: 'accepted'; operation: ReceiptOperation }
  | { status: 'deferred' | 'ignored' | 'unavailable' }

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

function parseHostOutput(output: unknown): HostOutput | undefined {
  if (!isRecord(output)) return undefined
  const title = output.title === undefined ? '' : output.title
  const result = output.output === undefined ? '' : output.output
  if (
    typeof title !== 'string' ||
    title.length > MAX_STATUS_LENGTH ||
    typeof result !== 'string' ||
    result.length > MAX_HOST_OUTPUT_LENGTH ||
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

function normalizeSkill(tool: string, args: unknown): string | undefined {
  if (tool !== 'systematic_skill' && tool !== 'skill') return undefined
  if (!isRecord(args) || !boundedString(args.name, MAX_SKILL_LENGTH)) {
    return undefined
  }
  const names: Record<string, string> = {
    'ce:work': 'ce-work',
    'git-commit': 'git-commit',
    'systematic:git-commit': 'git-commit',
    'git-commit-push-pr': 'git-commit-push-pr',
    'systematic:git-commit-push-pr': 'git-commit-push-pr',
  }
  return names[args.name] ?? 'ce-work'
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

type LocalOperationTool = 'write' | 'edit' | 'apply_patch' | 'bash'

function isLocalOperationTool(tool: string): tool is LocalOperationTool {
  return (
    tool === 'write' ||
    tool === 'edit' ||
    tool === 'apply_patch' ||
    tool === 'bash'
  )
}

function serializeStableArray(
  value: readonly unknown[],
  depth: number,
  budget: number,
): string | undefined {
  const entries: string[] = []
  let remaining = budget
  for (const entry of value) {
    const serialized = stableSerialize(entry, depth + 1, remaining)
    if (serialized === undefined) return undefined
    entries.push(serialized)
    remaining -= serialized.length
  }
  return `[${entries.join(',')}]`
}

function serializeStableRecord(
  value: Record<string, unknown>,
  depth: number,
  budget: number,
): string | undefined {
  const entries: string[] = []
  let remaining = budget
  for (const key of Object.keys(value).sort()) {
    const serialized = stableSerialize(value[key], depth + 1, remaining)
    if (serialized === undefined) return undefined
    const entry = `${JSON.stringify(key)}:${serialized}`
    entries.push(entry)
    remaining -= entry.length
  }
  return `{${entries.join(',')}}`
}

function stableSerialize(
  value: unknown,
  depth = 0,
  budget = 8192,
): string | undefined {
  if (budget <= 0 || depth > 8) return undefined
  if (value === null) return 'null'
  if (typeof value === 'string') {
    if (value.length > budget) return undefined
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return serializeStableArray(value, depth, budget)
  if (!isRecord(value)) return undefined
  return serializeStableRecord(value, depth, budget)
}

function argsFingerprint(
  ledger: ReturnType<typeof createReceiptLedger>,
  args: unknown,
): string | undefined {
  const serialized = stableSerialize(args)
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
  return (
    operation === 'implementation' ||
    operation === 'verification' ||
    operation === 'commit'
  )
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

function statusForTool(status: WorkflowStatus): string {
  return JSON.stringify({
    state: status.state,
    reasonCode: status.reasonCode,
    ...(status.repair ? { repair: status.repair } : {}),
    satisfiedOperations: status.satisfiedOperations,
    missingOperations: status.missingOperations,
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
  return {
    disabled: 0,
    protected: 1,
    waiting: 2,
    rejected: 3,
    unavailable: 4,
  }[state]
}

function isWorkflowState(value: unknown): value is WorkflowStatus['state'] {
  return (
    value === 'protected' ||
    value === 'waiting' ||
    value === 'rejected' ||
    value === 'disabled' ||
    value === 'unavailable'
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
    if (parsed.protocolVersion !== MARKER_PROTOCOL_VERSION) return undefined
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
): SessionRuntime {
  let ledger!: ReceiptLedger
  let guard!: WorkflowGuard
  let initialized = false
  let initializationPromise: Promise<void> | undefined
  let retryableEmptyHistory = false
  const pendingSkills = new Map<string, PendingSkill>()
  const completedSkillCalls = new Map<string, string>()
  const pendingStarts = new Map<string, PendingStart>()
  const pendingCompletes = new Map<string, PendingComplete>()
  const finalizedCompletes = new Map<string, PendingComplete>()
  const abandonedCompletes = new Map<string, TransitionTarget>()
  const blockedCompletes = new Map<string, TransitionTarget>()
  const terminalCompletes = new Map<string, TerminalComplete>()
  const callBindings = new Map<string, { kind: string; fingerprint: string }>()
  const pendingOperations = new Map<string, PendingOperation>()
  const sealedOperations = new Map<string, SealedOperation>()
  const abandonedOperations = new Map<string, SealedOperation>()
  const rolledUpChildren = new Set<string>()
  const questionAttestation = createQuestionAttestation()
  const pendingQuestionChallenges = new Map<string, PendingQuestionChallenge>()
  const blockedQuestionCalls = new Map<string, string>()
  const consumedQuestionTargets = new Set<TransitionTarget>()

  function questionResource(target: TransitionTarget): string {
    const status = guard.status()
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

  function containsGuardHistory(value: unknown): boolean {
    if (!isRecord(value)) return false
    if (
      value.tool === 'systematic_workflow_start' ||
      value.tool === 'systematic_workflow_status' ||
      value.tool === 'systematic_workflow_complete' ||
      value.tool === 'systematic_workflow_control'
    ) {
      return true
    }
    return (
      Array.isArray(value.parts) &&
      value.parts.some((part) => containsGuardHistory(part))
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

  function publishUnavailable(): void {
    ledger = createReceiptLedger({
      capabilityFlags: ['workflow-guard'],
      registrationIdentity: options.registrationIdentity,
      sessionSalt: options.sessionSalt
        ? new Uint8Array(options.sessionSalt)
        : randomBytes(32),
    })
    guard = createGuard(ledger)
    if (options.config.mode !== 'disabled')
      guard.setMode({ mode: 'unavailable' })
    initialized = true
  }

  function publishFresh(): void {
    ledger = createReceiptLedger({
      capabilityFlags: ['workflow-guard'],
      registrationIdentity: options.registrationIdentity,
      sessionSalt: options.sessionSalt
        ? new Uint8Array(options.sessionSalt)
        : randomBytes(32),
    })
    guard = createGuard(ledger)
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

  function recoverPersistedMarkers(markers: readonly unknown[]): boolean {
    const seed = extractReceiptReadbackSeed(markers)
    if (seed.status !== 'ready') return false
    let recoveredLedger: ReceiptLedger
    try {
      recoveredLedger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity: options.registrationIdentity,
        sessionSalt: seed.sessionSalt,
      })
    } catch {
      return false
    }
    if (!seedAgrees(recoveredLedger, seed)) {
      return false
    }
    const recovered = recoveredLedger.recoverReadback(markers)
    if (recovered.status === 'rejected') {
      return false
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
      return false
    }
    ledger = recoveredLedger
    guard = recoveredGuard
    initialized = true
    return true
  }

  async function initializeSession(
    sessionID: string,
    allowFresh: boolean,
  ): Promise<void> {
    const reader = options.hostReadback?.readSessionParts
    if (!reader) {
      publishFresh()
      return
    }
    let parts: ReadonlyArray<unknown>
    try {
      parts = await reader(sessionID)
    } catch {
      publishUnavailable()
      return
    }
    const markers: unknown[] = []
    for (const part of parts) collectReceiptMarkers(part, markers)
    if (markers.length === 0) {
      if (allowFresh && !parts.some((part) => containsGuardHistory(part))) {
        publishFresh()
      } else {
        retryableEmptyHistory = true
        publishUnavailable()
      }
      return
    }
    if (!recoverPersistedMarkers(markers)) publishUnavailable()
  }

  async function recoverFromHost(
    sessionID: string,
    allowFresh = true,
  ): Promise<void> {
    if (initializationPromise) {
      await initializationPromise
      if (!retryableEmptyHistory || !allowFresh) return
      initializationPromise = undefined
      initialized = false
    }
    retryableEmptyHistory = false
    initializationPromise = initializeSession(sessionID, allowFresh)
    await initializationPromise
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
    const children = await options.hostReadback.listChildren(host.sessionID)
    if (
      !children.some(
        (child) =>
          child.sessionId === childSessionID &&
          child.parentID === host.sessionID,
      )
    ) {
      markUnavailable()
      return
    }
    let parts: ReadonlyArray<unknown>
    try {
      parts = await options.hostReadback.readSessionParts(childSessionID)
    } catch {
      markUnavailable()
      return
    }
    const markers: unknown[] = []
    for (const part of parts) collectReceiptMarkers(part, markers)
    if (markers.length === 0) return
    const seed = extractReceiptReadbackSeed(markers)
    if (seed.status !== 'ready') {
      markUnavailable()
      return
    }
    const childLedger = createReceiptLedger({
      capabilityFlags: ['workflow-guard'],
      registrationIdentity: options.registrationIdentity,
      sessionSalt: seed.sessionSalt,
    })
    if (!seedAgrees(childLedger, seed)) {
      markUnavailable()
      return
    }
    const recovered = childLedger.recoverReadback(markers)
    if (recovered.status === 'rejected') {
      markUnavailable()
      return
    }
    const current = await options.observer?.snapshot()
    if (!current || current.status === 'unavailable') {
      markUnavailable()
      return
    }
    const currentStatus = guard.status()
    if (!currentStatus.epoch || !currentStatus.unit) return
    const expectedWorkspace = ledger.digestIdentity(
      'workspace',
      options.workspaceIdentity,
    )
    const expectedRepository = ledger.digestIdentity(
      'repository',
      options.repositoryIdentity ?? current.snapshot.repositoryRevisionDigest,
    )
    const expectedWorktree = ledger.digestIdentity(
      'worktree',
      options.worktreeIdentity ?? current.snapshot.worktreeRevisionDigest,
    )
    let minted = false
    for (const childReceipt of recovered.receipts) {
      const operation = childReceipt.canonical.operation
      if (!localOperation(operation)) continue
      if (
        childReceipt.canonical.workspaceDigest !== expectedWorkspace ||
        childReceipt.canonical.repositoryDigest !== expectedRepository ||
        childReceipt.canonical.worktreeDigest !== expectedWorktree
      ) {
        markUnavailable()
        return
      }
      const callID = `task-${host.callID}-${childReceipt.canonical.receiptId}`
      const observation = {
        callId: callID,
        operation,
        tool: 'write' as const,
        context: {
          epochId: currentStatus.epoch.epochId,
          unitId: currentStatus.unit.unitId,
          workspaceIdentity: options.workspaceIdentity,
          repositoryIdentity:
            operation === 'commit'
              ? (options.repositoryIdentity ??
                current.snapshot.repositoryRevisionDigest)
              : current.snapshot.repositoryRevisionDigest,
          worktreeIdentity:
            operation === 'implementation'
              ? (options.worktreeIdentity ??
                current.snapshot.worktreeRevisionDigest)
              : current.snapshot.worktreeRevisionDigest,
        },
        after: {
          workspaceIdentity: options.workspaceIdentity,
          repositoryIdentity: current.snapshot.repositoryRevisionDigest,
          worktreeIdentity: current.snapshot.worktreeRevisionDigest,
        },
        terminal: {
          status: 'success' as const,
          output: 'non-empty' as const,
          noOp: false,
        },
      }
      const result = await guard.observeOperation(observation)
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

  function markUnavailable(): void {
    if (options.config.mode === 'disabled') return
    guard.setMode({ mode: 'unavailable' })
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
    markUnavailable()
    return 'conflict'
  }

  function abandonPending(): void {
    for (const [callDigest, pending] of pendingCompletes) {
      guard.abandonTransition({
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
  }

  function readStatus(): WorkflowStatus {
    abandonPending()
    return guard.status()
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
        guard.setMode({ mode: 'disabled' })
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

  async function refreshReadback(): Promise<void> {
    abandonPending()
    if (!options.observer) return
    let result: OperationObserverResult
    try {
      result = await options.observer.snapshot()
    } catch {
      markUnavailable()
      return
    }
    if (result.status === 'unavailable') {
      markUnavailable()
      return
    }
    if (result.snapshot.targetDigest !== options.workspaceIdentity) {
      markUnavailable()
      return
    }
    const observed = guard.observeReadback({
      workspaceIdentity: options.workspaceIdentity,
      repositoryIdentity: result.snapshot.repositoryRevisionDigest,
      worktreeIdentity: result.snapshot.worktreeRevisionDigest,
    })
    if (
      (observed.status === 'rejected' &&
        observed.reasonCode === 'workspace-mismatch') ||
      !(await refreshRemoteReadbacks(result.snapshot))
    ) {
      markUnavailable()
    }
  }

  async function refreshRemoteReadbacks(
    local: OperationObserverSnapshot,
  ): Promise<boolean> {
    const remoteOperations = guard
      .status()
      .satisfiedOperations.filter(remoteOperation)
    if (remoteOperations.length === 0) return true
    const remoteSnapshot = options.observer?.remoteSnapshot
    if (!remoteSnapshot) return false
    for (const operation of remoteOperations) {
      const result = await readRemoteScope(remoteSnapshot, operation)
      if (result?.status !== 'available') return false
      const observed = guard.observeReadback(
        remoteReadbackInput(
          operation,
          local,
          options.workspaceIdentity,
          result.snapshot,
        ),
      )
      if (observed.status === 'rejected') return false
    }
    return true
  }

  function currentMarkerSource(): MarkerSource {
    const status = guard.status()
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
      result.status = source.debug.status
    }
    return result
  }

  function writeStartResult(output: unknown, result: StartUnitResult): void {
    if (!isRecord(output)) return
    if (result.status === 'started') {
      output.title = 'Workflow unit started'
      output.output = JSON.stringify({ status: 'started' })
      output.metadata = {
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
      ...metadata(),
      workflowGuard: {
        status: 'rejected',
        reasonCode,
      },
    }
  }

  function writeCompletionResult(
    output: unknown,
    result: TransitionFinalizeResult | TerminalComplete,
    target: TransitionTarget,
  ): void {
    if (!isRecord(output)) return
    if (result.status === 'completed' || result.status === 'duplicate') {
      output.title = 'Workflow transition completed'
      output.output = `workflow guard completed ${target}`
      output.metadata = {
        ...metadata(),
        workflowGuard: { status: 'completed', target },
      }
      return
    }
    const reasonCode =
      'reasonCode' in result ? result.reasonCode : 'guard-unavailable'
    const resultStatus =
      result.status === 'waiting' ? 'unavailable' : result.status
    output.title = 'Workflow transition unavailable'
    output.output = JSON.stringify({
      status: resultStatus,
      reasonCode,
    })
    output.metadata = {
      ...metadata(),
      workflowGuard: {
        status: resultStatus,
        target,
        reasonCode,
      },
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
      markUnavailable()
      return true
    }
    if (options.config.mode === 'protected') {
      throw createWorkflowGuardBlockedError('guard-unavailable')
    }
    blockedCompletes.set(callDigest, target)
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
    const status = guard.status()
    if (gateCompleteWithQuestion(host, target, callDigest, status)) return
    const prepared = guard.prepareTransition({ callId: host.callID, target })
    if (prepared.status === 'allowed') {
      pendingCompletes.set(callDigest, {
        callID: host.callID,
        target,
        transitionId: prepared.transitionId,
      })
      return
    }
    if (options.config.mode === 'protected') {
      throw createWorkflowGuardBlockedError(prepared.reasonCode)
    }
    blockedCompletes.set(callDigest, target)
  }

  async function remoteIntentForOperation(
    host: HostToolBefore,
    args: unknown,
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
    const remoteSnapshot = options.observer?.remoteSnapshot
    if (!remoteSnapshot) return { operation: classification.category }
    try {
      return {
        operation: classification.category,
        before: await remoteSnapshot(classification.category, 'before'),
      }
    } catch {
      return { operation: classification.category }
    }
  }

  async function prepareOperation(
    host: HostToolBefore,
    args: unknown,
  ): Promise<void> {
    if (!options.observer || !isLocalOperationTool(host.tool)) return
    const fingerprint = argsFingerprint(ledger, args)
    if (!fingerprint) {
      markUnavailable()
      return
    }
    const callDigest = digestCall(ledger, host.callID)
    if (
      bindCall(callDigest, 'operation', `${host.tool}:${fingerprint}`) !== 'new'
    ) {
      return
    }
    let result: OperationObserverResult
    try {
      result = await options.observer.snapshot()
    } catch {
      markUnavailable()
      return
    }
    if (result.status === 'unavailable') {
      markUnavailable()
      return
    }
    if (result.snapshot.targetDigest !== options.workspaceIdentity) {
      markUnavailable()
      return
    }
    const remote = await remoteIntentForOperation(host, args)
    pendingOperations.set(callDigest, {
      callID: host.callID,
      tool: host.tool,
      argsFingerprint: fingerprint,
      before: result.snapshot,
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
      markUnavailable()
    }
  }

  async function seedRemoteScopes(
    operations: readonly ReceiptOperation[],
  ): Promise<boolean> {
    const remoteOperations = operations.filter(remoteOperation)
    if (remoteOperations.length === 0) return true
    const remoteSnapshot = options.observer?.remoteSnapshot
    if (!remoteSnapshot || !options.observer) return false
    let local: OperationObserverResult
    try {
      local = await options.observer.snapshot()
    } catch {
      return false
    }
    if (local.status === 'unavailable') return false
    for (const operation of remoteOperations) {
      if (!(await seedRemoteScope(remoteSnapshot, operation, local.snapshot))) {
        return false
      }
    }
    return true
  }

  async function seedRemoteScope(
    reader: NonNullable<OpencodeOperationObserver['remoteSnapshot']>,
    operation: RemoteOperation,
    local: OperationObserverSnapshot,
  ): Promise<boolean> {
    const result = await readRemoteScope(reader, operation, 'before')
    if (!result) return false
    if (result.status === 'missing-resource') {
      return (
        operation === 'pr-creation' ||
        operation === 'check-readback' ||
        operation === 'review-readback'
      )
    }
    if (result.status !== 'available') return false
    const observed = guard.observeReadback(
      remoteReadbackInput(
        operation,
        local,
        options.workspaceIdentity,
        result.snapshot,
        operation !== 'pr-creation',
      ),
    )
    return observed.status !== 'rejected'
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
      if (completedSkill !== finalSkill) markUnavailable()
      return
    }
    const pending = pendingSkills.get(callDigest)
    if (!pending) return
    pendingSkills.delete(callDigest)
    if (!finalSkill || finalSkill !== pending.skill) {
      markUnavailable()
      return
    }
    if (!isSuccessfulAfter(output)) return
    completedSkillCalls.set(callDigest, pending.skill)
    await activateCompletedSkill(pending.skill)
    const status = guard.status()
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
          resourceScopes: [],
          state: 'started',
          transitionDigest: ledger.digestIdentity('call', host.callID),
        }),
      )
    }
  }

  async function activateCompletedSkill(skill: string): Promise<void> {
    const activation = guard.activate({
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
      const status = guard.status()
      if (!status.unit || status.unit.status === 'completed') {
        guard.startUnit({}, runtimePolicy)
        if (!(await seedRemoteScopes(runtimePolicy.requiredOperations ?? []))) {
          markUnavailable()
        }
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
      markUnavailable()
      return
    }
    const normalized = normalizeStartInput(host.args)
    if (
      normalized === undefined ||
      JSON.stringify(normalized) !== pending.fingerprint
    ) {
      markUnavailable()
      return
    }
    if (!isSuccessfulAfter(output)) return
    const result = guard.startUnit(pending.input, runtimePolicy)
    if (
      result.status === 'rejected' &&
      (result.reasonCode === 'guard-unavailable' ||
        result.reasonCode === 'invalid-configuration')
    ) {
      markUnavailable()
    }
    if (
      result.status === 'started' &&
      !(await seedRemoteScopes(runtimePolicy.requiredOperations ?? []))
    ) {
      markUnavailable()
    }
    if (result.status === 'started') {
      const startedStatus = guard.status()
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
          resourceScopes: [],
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
    guard.finalizeTransition({
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
      guard.abandonTransition({
        callId: pending.callID,
        transitionId: pending.transitionId,
      })
      return
    }
    const result = guard.finalizeTransition({
      callId: pending.callID,
      transitionId: pending.transitionId,
      ...(readbacks ? { readbacks } : {}),
    })
    if (result.status === 'completed' || result.status === 'duplicate') {
      finalizedCompletes.set(callDigest, pending)
      writeCompletionResult(output, result, pending.target)
      return
    }
    markUnavailable()
    const reasonCode =
      'reasonCode' in result ? result.reasonCode : 'guard-unavailable'
    const terminal: TerminalComplete = {
      target: pending.target,
      status: result.status === 'waiting' ? 'unavailable' : result.status,
      reasonCode,
    }
    abandonedCompletes.set(callDigest, pending.target)
    terminalCompletes.set(callDigest, terminal)
    writeCompletionResult(output, terminal, pending.target)
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
    const replay = finalizedCompletes.get(callDigest)
    const abandonedTarget = abandonedCompletes.get(callDigest)
    const blockedTarget = blockedCompletes.get(callDigest)
    const terminal = terminalCompletes.get(callDigest)
    const expectedTarget = replay?.target ?? abandonedTarget ?? blockedTarget
    if (!expectedTarget) return false
    if (finalTarget !== expectedTarget) {
      markUnavailable()
      return true
    }
    if (replay) replayComplete(callDigest)
    if (terminal) writeCompletionResult(output, terminal, expectedTarget)
    blockedCompletes.delete(callDigest)
    return true
  }

  function abandonComplete(
    callDigest: string,
    pending: PendingComplete,
    remember: boolean,
  ): void {
    pendingCompletes.delete(callDigest)
    guard.abandonTransition({
      callId: pending.callID,
      transitionId: pending.transitionId,
    })
    if (remember) abandonedCompletes.set(callDigest, pending.target)
  }

  async function completionReadbacks(): Promise<
    | { status: 'none' }
    | { status: 'unavailable' }
    | { status: 'ready'; readbacks: readonly unknown[] }
  > {
    if (!options.observer) return { status: 'none' }
    let result: OperationObserverResult
    try {
      result = await options.observer.snapshot()
    } catch {
      return { status: 'unavailable' }
    }
    if (
      result.status === 'unavailable' ||
      result.snapshot.targetDigest !== options.workspaceIdentity
    ) {
      return { status: 'unavailable' }
    }
    const remoteReadbacks = await completionRemoteReadbacks()
    if (!remoteReadbacks) return { status: 'unavailable' }
    let finalResult: OperationObserverResult
    try {
      finalResult = await options.observer.snapshot()
    } catch {
      return { status: 'unavailable' }
    }
    if (
      finalResult.status === 'unavailable' ||
      finalResult.snapshot.targetDigest !== result.snapshot.targetDigest ||
      finalResult.snapshot.repositoryRevisionDigest !==
        result.snapshot.repositoryRevisionDigest ||
      finalResult.snapshot.worktreeRevisionDigest !==
        result.snapshot.worktreeRevisionDigest
    ) {
      return { status: 'unavailable' }
    }
    return {
      status: 'ready',
      readbacks: [
        {
          workspaceIdentity: options.workspaceIdentity,
          repositoryIdentity: finalResult.snapshot.repositoryRevisionDigest,
          worktreeIdentity: finalResult.snapshot.worktreeRevisionDigest,
        },
        ...remoteReadbacks.map(({ operation, snapshot }) =>
          remoteReadbackInput(
            operation,
            finalResult.snapshot,
            options.workspaceIdentity,
            snapshot,
          ),
        ),
      ],
    }
  }

  async function completionRemoteReadbacks(): Promise<
    | readonly {
        operation: RemoteOperation
        snapshot: OperationObserverRemoteSnapshot
      }[]
    | undefined
  > {
    const remoteOperations = guard
      .status()
      .satisfiedOperations.filter(remoteOperation)
    if (remoteOperations.length === 0) return []
    const remoteSnapshot = options.observer?.remoteSnapshot
    if (!remoteSnapshot) return undefined
    const readbacks: Array<{
      operation: RemoteOperation
      snapshot: OperationObserverRemoteSnapshot
    }> = []
    for (const operation of remoteOperations) {
      const result = await readRemoteScope(remoteSnapshot, operation)
      if (result?.status !== 'available') return undefined
      readbacks.push({ operation, snapshot: result.snapshot })
    }
    return readbacks
  }

  async function finishComplete(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    const callDigest = digestCall(ledger, host.callID)
    const pending = pendingCompletes.get(callDigest)
    const finalTarget = normalizeTarget(host.args)
    if (pending && (!finalTarget || finalTarget !== pending.target)) {
      abandonComplete(callDigest, pending, false)
      markUnavailable()
      return
    }
    if (!pending) {
      if (replayTerminalComplete(callDigest, finalTarget, output)) return
      markUnavailable()
      return
    }
    if (!options.observer) {
      finalizeComplete(callDigest, pending, output)
      return
    }
    const readbacks = await completionReadbacks()
    if (readbacks.status === 'unavailable') {
      abandonComplete(callDigest, pending, true)
      markUnavailable()
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
      markUnavailable()
      return undefined
    }
    pendingOperations.delete(callDigest)
    if (
      pending.tool !== host.tool ||
      fingerprint === undefined ||
      fingerprint !== pending.argsFingerprint
    ) {
      sealOperation(callDigest, pending, true)
      markUnavailable()
      return undefined
    }
    return pending
  }

  async function captureAfterOperation(): Promise<
    OperationObserverSnapshot | undefined
  > {
    if (!options.observer) return undefined
    let result: OperationObserverResult
    try {
      result = await options.observer.snapshot()
    } catch {
      return undefined
    }
    return result.status === 'available' &&
      result.snapshot.targetDigest === options.workspaceIdentity
      ? result.snapshot
      : undefined
  }

  async function captureRemoteAfter(
    operation: RemoteOperation,
  ): Promise<OperationObserverRemoteSnapshot | undefined> {
    const remoteSnapshot = options.observer?.remoteSnapshot
    if (!remoteSnapshot) return undefined
    let result: OperationObserverRemoteResult
    try {
      result = await remoteSnapshot(operation, 'after')
    } catch {
      return undefined
    }
    return result.status === 'available' ? result.snapshot : undefined
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
        epochId: current.epoch.epochId,
        unitId: current.unit.unitId,
        workspaceIdentity: options.workspaceIdentity,
        repositoryIdentity: pending.before.repositoryRevisionDigest,
        worktreeIdentity: pending.before.worktreeRevisionDigest,
        ...(pending.remoteBefore?.status === 'available'
          ? {
              resourceIdentity: pending.remoteBefore.snapshot.resourceIdentity,
              resourceRevisionIdentity:
                pending.remoteBefore.snapshot.resourceRevisionIdentity,
            }
          : operation === 'pr-creation' && remoteAfter
            ? { resourceIdentity: remoteAfter.resourceIdentity }
            : {}),
      },
      after: {
        workspaceIdentity: options.workspaceIdentity,
        repositoryIdentity: after.repositoryRevisionDigest,
        worktreeIdentity: after.worktreeRevisionDigest,
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
    | { status: 'unavailable' }
    | { status: 'deferred' }
    | { status: 'ready'; observation: ReceiptOperationObservation }
  > {
    const classify = options.classifier?.classifyOperation
    if (!classify) return { status: 'unavailable' }
    let classification: ReceiptClassification
    try {
      classification = await classify(observation)
    } catch {
      return { status: 'unavailable' }
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
        : { status: 'unavailable' }
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
      return await guard.observeOperation(observation)
    } catch {
      return undefined
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the ordered fail-closed pipeline must remain atomic
  async function completeOperationObservation(
    callDigest: string,
    host: HostToolAfter,
    pending: PendingOperation,
    output: unknown,
  ): Promise<OperationCompletionResult> {
    const parsedOutput = parseHostOutput(output)
    if (!parsedOutput) {
      sealOperation(callDigest, pending, true)
      return { status: 'unavailable' }
    }
    const afterSnapshot = await captureAfterOperation()
    if (!afterSnapshot) {
      sealOperation(callDigest, pending, true)
      return { status: 'unavailable' }
    }
    const observation = buildOperationObservation(
      host,
      pending,
      afterSnapshot,
      guard.status(),
      parsedOutput,
    )
    if (!observation) {
      sealOperation(callDigest, pending, true)
      return { status: 'ignored' }
    }
    const classification = await classifyLocalObservation(observation)
    if (classification.status !== 'ready') {
      sealOperation(callDigest, pending, true)
      return { status: classification.status }
    }
    let finalObservation = classification.observation
    if (remoteOperation(finalObservation.operation)) {
      const remoteAfter = await captureRemoteAfter(finalObservation.operation)
      if (!remoteAfter) {
        sealOperation(callDigest, pending, true)
        return { status: 'unavailable' }
      }
      const rebuilt = buildOperationObservation(
        host,
        pending,
        afterSnapshot,
        guard.status(),
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
        pending.remoteBefore?.status !== 'available'
      ) {
        const seeded = guard.observeReadback({
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
          return { status: 'unavailable' }
        }
      }
    }
    const observed = await observeClassifiedOperation(finalObservation)
    if (!observed) {
      sealOperation(callDigest, pending, true)
      return { status: 'unavailable' }
    }
    sealOperation(callDigest, pending, observed.status !== 'accepted')
    if (observed.status === 'unavailable') {
      return { status: 'unavailable' }
    }
    if (observed.status !== 'accepted') return { status: 'ignored' }
    return { status: 'accepted', operation: observed.operation }
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
    output.metadata = {
      ...output.metadata,
      [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: marker,
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

  async function finishOperation(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    if (!options.observer || !isLocalOperationTool(host.tool)) return
    const callDigest = digestCall(ledger, host.callID)
    const fingerprint = argsFingerprint(ledger, host.args)
    if (isSealedOperationReplay(callDigest, host, fingerprint)) return
    const pending = takePendingOperation(callDigest, host, fingerprint)
    if (!pending) return
    const result = await completeOperationObservation(
      callDigest,
      host,
      pending,
      output,
    )
    if (result.status === 'unavailable') {
      markUnavailable()
      return
    }
    if (result.status === 'accepted') {
      const receipt = receiptForOperation(host.callID, result.operation)
      if (receipt) mergeReceiptMarker(output, receipt)
    }
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
      markUnavailable()
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
      return initialized ? guard.status() : unavailableWorkflowStatus()
    },
    readStatus,
    refreshReadback,
    observeReceipt: (input) => {
      ensureSynchronousRuntime()
      return initialized
        ? guard.observeReceipt(input)
        : { status: 'unavailable', reasonCode: 'guard-unavailable' }
    },
    prepareTransition: (input) => {
      ensureSynchronousRuntime()
      return initialized
        ? guard.prepareTransition(input)
        : { status: 'unavailable', reasonCode: 'guard-unavailable' }
    },
    startUnit: (input, policy) => {
      ensureSynchronousRuntime()
      return initialized
        ? guard.startUnit(input, policy)
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
          runtime.markUnavailable()
        }
      }
      try {
        metadata = runtime.metadata()
      } catch {
        runtime.markUnavailable()
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

  function sessionRuntimeFor(sessionID: string): SessionRuntime {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const runtime = createSessionRuntime({
      ...options,
      registrationIdentity: options.registrationIdentity,
      sessionSalt: options.sessionSalt,
    })
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
        await runtime.refreshReadback()
        return {
          title: 'Workflow guard status',
          output: statusToolSchema.safeParse(input).success
            ? statusForTool(runtime.readStatus())
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
    const runtime = sessionRuntimeFor(host.sessionID)
    try {
      await runtime.hooks['tool.execute.before'](input, output)
    } catch (error) {
      if (isWorkflowGuardBlockedError(error)) throw error
      runtime.markUnavailable()
    }
  }

  async function after(input: unknown, output: unknown): Promise<void> {
    const host = parseHostAfter(input)
    if (!host) return
    const runtime = sessionRuntimeFor(host.sessionID)
    try {
      await runtime.hooks['tool.execute.after'](input, output)
    } catch {
      runtime.markUnavailable()
    }
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
      runtime.markUnavailable()
    }
  }

  async function transform(input: unknown, output: unknown): Promise<void> {
    if (!isRecord(input) || !boundedString(input.sessionID, 256)) return
    const runtime = sessionRuntimeFor(input.sessionID)
    try {
      await runtime.hooks['experimental.chat.system.transform'](input, output)
    } catch {
      runtime.markUnavailable()
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
  }
}
