import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from 'zod'
import { INTERNAL_AGENT_SIGNATURES } from './bootstrap.js'
import {
  createReceiptLedger,
  type ReceiptLedger,
  type ReceiptOperation,
} from './receipt-ledger.js'
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

const OPERATIONS: readonly ReceiptOperation[] = [
  'implementation',
  'verification',
  'commit',
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
]

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

export class WorkflowGuardBlockedError extends Error {
  readonly code = 'workflow-guard-blocked' as const
  readonly reasonCode: WorkflowReasonCode

  constructor(reasonCode: WorkflowReasonCode) {
    super('workflow guard blocked')
    this.name = 'WorkflowGuardBlockedError'
    this.reasonCode = reasonCode
  }
}

export function isWorkflowGuardBlockedError(
  value: unknown,
): value is WorkflowGuardBlockedError {
  return value instanceof WorkflowGuardBlockedError
}

export interface OpencodeWorkflowGuardOptions {
  config: OpencodeWorkflowGuardConfig
  workspaceIdentity: string
  repositoryIdentity?: string
  worktreeIdentity?: string
}

export interface OpencodeWorkflowGuardHooks {
  'tool.execute.before': (input: unknown, output: unknown) => Promise<void>
  'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
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
  readonly ledger: ReceiptLedger
  readonly hooks: OpencodeWorkflowGuardHooks
  status(): WorkflowStatus
  readStatus(): WorkflowStatus
  observeReceipt(input: unknown): EvidenceObservationResult
  prepareTransition(input: unknown): TransitionPrepareResult
  startUnit(input: unknown, policy?: RuntimeUnitPolicy): unknown
  markUnavailable(): void
  metadata(): Record<string, unknown>
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

interface TerminalComplete {
  target: TransitionTarget
  status: 'rejected' | 'unavailable'
  reasonCode: WorkflowReasonCode
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
  if (
    typeof output.title !== 'string' ||
    output.title.length > MAX_STATUS_LENGTH ||
    typeof output.output !== 'string' ||
    output.output.length > 1024 ||
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
  if (output.output.length === 0) return undefined
  return {
    title: output.title,
    output: output.output,
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
  return names[args.name]
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
  const ledger = createReceiptLedger({ capabilityFlags: ['workflow-guard'] })
  const guard: WorkflowGuard = createWorkflowGuard({
    ledger,
    workspaceIdentity: options.workspaceIdentity,
    repositoryIdentity: options.repositoryIdentity,
    worktreeIdentity: options.worktreeIdentity,
    mode: options.config.mode === 'disabled' ? 'disabled' : 'protected',
  })
  const pendingSkills = new Map<string, PendingSkill>()
  const completedSkillCalls = new Map<string, string>()
  const pendingStarts = new Map<string, PendingStart>()
  const pendingCompletes = new Map<string, PendingComplete>()
  const finalizedCompletes = new Map<string, PendingComplete>()
  const abandonedCompletes = new Map<string, TransitionTarget>()
  const blockedCompletes = new Map<string, TransitionTarget>()
  const terminalCompletes = new Map<string, TerminalComplete>()
  const callBindings = new Map<string, { kind: string; fingerprint: string }>()

  const runtimePolicy: RuntimeUnitPolicy = {
    requiredOperations: [],
    resourceScopes: {},
  }

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
  }

  function readStatus(): WorkflowStatus {
    abandonPending()
    return guard.status()
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

  function prepareComplete(host: HostToolBefore, args: unknown): void {
    const target = normalizeTarget(args)
    if (!target) return
    const callDigest = digestCall(ledger, host.callID)
    if (bindCall(callDigest, 'complete', target) === 'conflict') {
      if (options.config.mode === 'protected') {
        throw new WorkflowGuardBlockedError('guard-unavailable')
      }
      return
    }
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
      throw new WorkflowGuardBlockedError(prepared.reasonCode)
    }
    blockedCompletes.set(callDigest, target)
  }

  async function before(input: unknown, output: unknown): Promise<void> {
    try {
      const host = parseHostBefore(input)
      if (!host || !isRecord(output)) return
      if (host.tool === 'systematic_skill' || host.tool === 'skill') {
        prepareSkill(host, output.args)
      } else if (host.tool === 'systematic_workflow_start') {
        prepareStart(host, output.args)
      } else if (host.tool === 'systematic_workflow_complete') {
        prepareComplete(host, output.args)
      }
    } catch (error) {
      if (isWorkflowGuardBlockedError(error)) throw error
      markUnavailable()
    }
  }

  function finishSkill(host: HostToolAfter, output: unknown): void {
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
    activateCompletedSkill(pending.skill)
  }

  function activateCompletedSkill(skill: string): void {
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
      const status = guard.status()
      if (!status.unit || status.unit.status === 'completed') {
        guard.startUnit({}, runtimePolicy)
      }
    }
  }

  function finishStart(host: HostToolAfter, output: unknown): void {
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

  function finishComplete(host: HostToolAfter, output: unknown): void {
    const callDigest = digestCall(ledger, host.callID)
    const pending = pendingCompletes.get(callDigest)
    const finalTarget = normalizeTarget(host.args)
    if (pending && (!finalTarget || finalTarget !== pending.target)) {
      pendingCompletes.delete(callDigest)
      guard.abandonTransition({
        callId: pending.callID,
        transitionId: pending.transitionId,
      })
      markUnavailable()
      return
    }
    if (!pending) {
      if (replayTerminalComplete(callDigest, finalTarget, output)) return
      markUnavailable()
      return
    }
    finalizeComplete(callDigest, pending, output)
  }

  async function after(input: unknown, output: unknown): Promise<void> {
    try {
      const host = parseHostAfter(input)
      if (!host) return
      if (host.tool === 'systematic_skill' || host.tool === 'skill') {
        finishSkill(host, output)
      } else if (host.tool === 'systematic_workflow_start') {
        finishStart(host, output)
      } else if (host.tool === 'systematic_workflow_complete') {
        finishComplete(host, output)
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
    abandonPending()
    if (!isRecord(output) || !Array.isArray(output.system)) return
    const existingSystem = output.system.filter(
      (entry): entry is string => typeof entry === 'string',
    )
    if (isInternalSystem(existingSystem)) return
    if (!isRecord(input) || !boundedString(input.sessionID, 256)) return
    const parsed = extractMarkerSources(existingSystem)
    const current = currentMarkerSource()
    const marker = buildMarker(parsed.sources, parsed.malformed, current)
    for (let index = 0; index < parsed.entries.length; index += 1) {
      output.system[index] = parsed.entries[index]
    }
    appendMarker(output, marker)
  }

  return {
    ledger,
    hooks: {
      'tool.execute.before': before,
      'tool.execute.after': after,
      'experimental.chat.system.transform': transform,
    },
    status: () => guard.status(),
    readStatus,
    observeReceipt: (input) => guard.observeReceipt(input),
    prepareTransition: (input) => guard.prepareTransition(input),
    startUnit: (input, policy) => guard.startUnit(input, policy),
    markUnavailable,
    metadata,
  }
}

function parseExecutionSession(context: unknown): string | undefined {
  if (!isRecord(context)) return undefined
  return boundedString(context.sessionID, 256) ? context.sessionID : undefined
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
  execute: (runtime: SessionRuntime, input: unknown) => ToolResultContent,
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
      let content = execute(runtime, input)
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
    const runtime = createSessionRuntime(options)
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
      (runtime, input) => ({
        title: 'Workflow guard status',
        output: statusToolSchema.safeParse(input).success
          ? statusForTool(runtime.readStatus())
          : unavailableToolResult(),
      }),
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
      (_runtime, input) =>
        controlToolSchema.safeParse(input).success
          ? {
              title: 'Workflow guard control unavailable',
              output: JSON.stringify({
                status: 'unavailable',
                reasonCode: 'control-not-enabled',
              }),
            }
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
