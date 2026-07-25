import { randomBytes } from 'node:crypto'

import type {
  ReceiptEnvelope,
  ReceiptLedger,
  ReceiptOperation,
  ReceiptReasonCode,
} from './receipt-ledger.js'

export type WorkflowMode = 'protected' | 'disabled' | 'unavailable'
export type WorkflowState =
  | 'protected'
  | 'waiting'
  | 'rejected'
  | 'disabled'
  | 'unavailable'
export type RepairKind =
  | 'fresh-readback'
  | 'rerun-operation'
  | 'question-attestation'
export type TransitionTarget = 'unit' | 'epoch'
export type EpochFamily = 'work' | 'shipping'

export type WorkflowReasonCode =
  | 'abandoned-transition'
  | 'call-context-conflict'
  | 'cancelled-operation'
  | 'consumed-receipt'
  | 'disabled'
  | 'epoch-completed'
  | 'failed-operation'
  | 'family-conflict'
  | 'finalization-failed'
  | 'foreign-registration'
  | 'forbidden-field'
  | 'guard-unavailable'
  | 'incompatible-receipt'
  | 'invalid-configuration'
  | 'invalid-control'
  | 'invalid-receipt'
  | 'invalid-transition'
  | 'missing-evidence'
  | 'no-supported-repair'
  | 'no-active-epoch'
  | 'no-active-unit'
  | 'no-op-operation'
  | 'operation-not-required'
  | 'receipt-mismatch'
  | 'rejected-operation'
  | 'resource-mismatch'
  | 'running-operation'
  | 'stale-receipt'
  | 'transition-finalized'
  | 'transition-terminal'
  | 'transition-replayed'
  | 'unattributed-operation'
  | 'unit-active'
  | 'unit-completed'
  | 'unit-incomplete'
  | 'unit-ready'
  | 'workspace-mismatch'
  | 'runtime-scope-conflict'

export interface WorkflowGuardOptions {
  ledger: ReceiptLedger
  workspaceIdentity: string
  repositoryIdentity?: string
  worktreeIdentity?: string
  supportedRepairs?: readonly RepairKind[]
  questionEligibleOperations?: readonly ReceiptOperation[]
  runtimeRequiredOperations?: readonly ReceiptOperation[]
  runtimeResourceScopes?: Readonly<Record<string, string>>
  mode?: WorkflowMode
  maxReceiptAgeMs?: number
  clock?: () => number
}

export interface RuntimeUnitPolicy {
  requiredOperations?: readonly ReceiptOperation[]
  resourceScopes?: Readonly<Record<string, string>>
}

export interface EpochSnapshot {
  epochId: string
  family: EpochFamily
  status: 'active' | 'completed'
}

export interface UnitSnapshot {
  unitId: string
  status: 'active' | 'completed'
  requiredOperations: readonly ReceiptOperation[]
  requiredResourceOperations: readonly ReceiptOperation[]
}

export interface WorkflowStatus {
  state: WorkflowState
  reasonCode: WorkflowReasonCode
  repair?: RepairKind
  statusKey: string
  epoch: EpochSnapshot | null
  unit: UnitSnapshot | null
  satisfiedOperations: readonly ReceiptOperation[]
  missingOperations: readonly ReceiptOperation[]
}

export type ActivationResult =
  | { status: 'activated' | 'reused' | 'attached'; epoch: EpochSnapshot }
  | { status: 'ignored'; reasonCode: WorkflowReasonCode }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }

export type StartUnitResult =
  | { status: 'started'; unit: UnitSnapshot }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }

export type EvidenceObservationResult =
  | { status: 'accepted'; operation: ReceiptOperation }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }
  | { status: 'unavailable'; reasonCode: WorkflowReasonCode }

export type TransitionPrepareResult =
  | { status: 'allowed'; transitionId: string }
  | {
      status: 'waiting' | 'rejected' | 'unavailable'
      reasonCode: WorkflowReasonCode
    }

export type TransitionFinalizeResult =
  | {
      status: 'completed' | 'duplicate'
      target: TransitionTarget
      transitionId: string
    }
  | {
      status: 'waiting' | 'rejected' | 'unavailable'
      reasonCode: WorkflowReasonCode
    }

export type AbandonTransitionResult =
  | { status: 'abandoned' }
  | { status: 'duplicate'; reasonCode: 'abandoned-transition' }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }

export type ControlResult =
  | { status: 'changed' | 'unchanged'; mode: WorkflowMode }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }

export interface WorkflowGuard {
  activate(input: unknown): ActivationResult
  startUnit(input: unknown, policy?: RuntimeUnitPolicy): StartUnitResult
  observeReceipt(input: unknown): EvidenceObservationResult
  observeAttempt(input: unknown): EvidenceObservationResult
  status(): WorkflowStatus
  prepareTransition(input: unknown): TransitionPrepareResult
  finalizeTransition(input: unknown): TransitionFinalizeResult
  abandonTransition(input: unknown): AbandonTransitionResult
  setMode(input: unknown): ControlResult
}

type AttemptOutcome =
  | 'cancelled'
  | 'failed'
  | 'no-op'
  | 'rejected'
  | 'running'
  | 'unattributed'
  | 'unavailable'

interface ParsedActivation {
  family: EpochFamily
}

interface ParsedUnitRequest {
  expectedOperations: readonly ReceiptOperation[]
  resourceScopes: ReadonlyMap<ReceiptOperation, string>
}

interface ParsedAttempt {
  operation: ReceiptOperation
  outcome: AttemptOutcome
}

interface ParsedTransition {
  callId: string
  target: TransitionTarget
}

interface ParsedFinalization {
  callId: string
  transitionId: string
}

interface ParsedControl {
  mode: WorkflowMode
}

interface EpochState {
  epochId: string
  family: EpochFamily
  status: 'active' | 'completed'
  unit?: UnitState
}

interface UnitState {
  unitId: string
  status: 'active' | 'completed'
  requiredOperations: readonly ReceiptOperation[]
  resourceScopes: ReadonlyMap<ReceiptOperation, string>
  evidence: Map<ReceiptOperation, ReceiptEnvelope>
  issues: Map<ReceiptOperation, Issue>
}

interface Issue {
  kind: 'rejected' | 'unavailable'
  reasonCode: WorkflowReasonCode
  repair?: RepairKind
}

interface PreparedTransition {
  callDigest: string
  target: TransitionTarget
  transitionId?: string
  state: 'prepared' | 'abandoned' | 'terminal'
  prepareResult?: TransitionPrepareResult
  terminalResult?: TransitionFinalizeResult
}

interface Qualification {
  operation: ReceiptOperation
  envelope?: ReceiptEnvelope
  reasonCode?: WorkflowReasonCode
}

interface EnvelopeRead {
  envelope?: ReceiptEnvelope
  reasonCode?: WorkflowReasonCode
}

interface ReadyDecision {
  ready: true
  envelopes: readonly ReceiptEnvelope[]
}

interface BlockedDecision {
  ready: false
  status: 'waiting' | 'rejected' | 'unavailable'
  reasonCode: WorkflowReasonCode
}

type TransitionDecision = ReadyDecision | BlockedDecision

const MANDATORY_OPERATIONS = ['implementation', 'verification'] as const
const ALL_OPERATIONS: ReadonlySet<string> = new Set([
  'implementation',
  'verification',
  'commit',
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
])
const REPAIR_SET: ReadonlySet<string> = new Set([
  'fresh-readback',
  'rerun-operation',
  'question-attestation',
])
const MODE_SET: ReadonlySet<string> = new Set([
  'protected',
  'disabled',
  'unavailable',
])
const MAX_INPUT_LENGTH = 1024
const MAX_OPERATIONS = 7
const MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_REPAIRS: readonly RepairKind[] = [
  'fresh-readback',
  'rerun-operation',
  'question-attestation',
]
const FORBIDDEN_UNIT_FIELDS = new Set([
  'completed',
  'consumed',
  'declaration',
  'receiptIds',
  'status',
  'unitId',
  'family',
])
const OPTION_KEYS = new Set([
  'ledger',
  'workspaceIdentity',
  'repositoryIdentity',
  'worktreeIdentity',
  'supportedRepairs',
  'questionEligibleOperations',
  'runtimeRequiredOperations',
  'runtimeResourceScopes',
  'mode',
  'maxReceiptAgeMs',
  'clock',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_INPUT_LENGTH
  )
}

function isOperation(value: unknown): value is ReceiptOperation {
  return typeof value === 'string' && ALL_OPERATIONS.has(value)
}

function isRepair(value: unknown): value is RepairKind {
  return typeof value === 'string' && REPAIR_SET.has(value)
}

function isMode(value: unknown): value is WorkflowMode {
  return typeof value === 'string' && MODE_SET.has(value)
}

function hasOnlyFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(input).every((field) => allowed.has(field))
}

function hasForbiddenField(
  input: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  return [...fields].some((field) => field in input)
}

function randomId(): string {
  return randomBytes(16).toString('hex')
}

function cloneEpoch(epoch: EpochState): EpochSnapshot {
  return Object.freeze({
    epochId: epoch.epochId,
    family: epoch.family,
    status: epoch.status,
  })
}

function cloneUnit(unit: UnitState): UnitSnapshot {
  return Object.freeze({
    unitId: unit.unitId,
    status: unit.status,
    requiredOperations: unit.requiredOperations,
    requiredResourceOperations: Object.freeze(
      unit.requiredOperations.filter((operation) =>
        unit.resourceScopes.has(operation),
      ),
    ),
  })
}

function familyForSkill(skill: unknown): EpochFamily | undefined {
  if (skill === 'ce-work') return 'work'
  if (skill === 'git-commit' || skill === 'git-commit-push-pr') {
    return 'shipping'
  }
  return undefined
}

function parseActivation(input: unknown): ParsedActivation | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['event', 'skill', 'outcome'])) ||
    input.event !== 'guarded-skill' ||
    input.outcome !== 'success'
  ) {
    return undefined
  }
  const family = familyForSkill(input.skill)
  return family ? { family } : undefined
}

function parseExpectedOperations(
  value: unknown,
): readonly ReceiptOperation[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_OPERATIONS) return undefined
  const result: ReceiptOperation[] = []
  for (const operation of value) {
    if (!isOperation(operation)) return undefined
    if (!result.includes(operation)) result.push(operation)
  }
  return result
}

function parseResourceScopes(
  value: unknown,
): ReadonlyMap<ReceiptOperation, string> | undefined {
  const result = new Map<ReceiptOperation, string>()
  if (value === undefined) return result
  if (!isRecord(value)) return undefined
  for (const [operation, resource] of Object.entries(value)) {
    if (!isOperation(operation) || !isBoundedString(resource)) return undefined
    result.set(operation, resource)
  }
  return result
}

function parseUnitRequest(input: unknown): ParsedUnitRequest | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['expectedOperations', 'resourceScopes'])) ||
    hasForbiddenField(input, FORBIDDEN_UNIT_FIELDS)
  ) {
    return undefined
  }
  const expectedOperations = parseExpectedOperations(input.expectedOperations)
  const resourceScopes = parseResourceScopes(input.resourceScopes)
  if (!expectedOperations || !resourceScopes) return undefined
  return { expectedOperations, resourceScopes }
}

function parseRuntimeUnitPolicy(input: unknown): ParsedUnitRequest | undefined {
  if (input === undefined)
    return { expectedOperations: [], resourceScopes: new Map() }
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['requiredOperations', 'resourceScopes']))
  ) {
    return undefined
  }
  const requiredOperations = parseExpectedOperations(input.requiredOperations)
  const resourceScopes = parseResourceScopes(input.resourceScopes)
  if (!requiredOperations || !resourceScopes) return undefined
  return { expectedOperations: requiredOperations, resourceScopes }
}

function parseAttempt(input: unknown): ParsedAttempt | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['operation', 'outcome'])) ||
    !isOperation(input.operation)
  ) {
    return undefined
  }
  const outcomes: readonly AttemptOutcome[] = [
    'cancelled',
    'failed',
    'no-op',
    'rejected',
    'running',
    'unattributed',
    'unavailable',
  ]
  return outcomes.includes(input.outcome as AttemptOutcome)
    ? { operation: input.operation, outcome: input.outcome as AttemptOutcome }
    : undefined
}

function parseTransition(input: unknown): ParsedTransition | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['callId', 'target'])) ||
    !isBoundedString(input.callId)
  ) {
    return undefined
  }
  return input.target === 'unit' || input.target === 'epoch'
    ? { callId: input.callId, target: input.target }
    : undefined
}

function parseFinalization(input: unknown): ParsedFinalization | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['callId', 'transitionId'])) ||
    !isBoundedString(input.callId) ||
    !isBoundedString(input.transitionId)
  ) {
    return undefined
  }
  return { callId: input.callId, transitionId: input.transitionId }
}

function parseControl(input: unknown): ParsedControl | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(['mode'])) ||
    !isMode(input.mode)
  ) {
    return undefined
  }
  return { mode: input.mode }
}

function normalizeRepairs(input: unknown): readonly RepairKind[] {
  const candidates = input === undefined ? DEFAULT_REPAIRS : input
  if (
    !Array.isArray(candidates) ||
    candidates.some((repair) => !isRepair(repair))
  ) {
    throw new Error('invalid-workflow-repairs')
  }
  return Object.freeze([...new Set(candidates)])
}

function normalizeOperations(input: unknown): readonly ReceiptOperation[] {
  const candidates = input === undefined ? [] : input
  if (
    !Array.isArray(candidates) ||
    candidates.length > MAX_OPERATIONS ||
    candidates.some((operation) => !isOperation(operation))
  ) {
    throw new Error('invalid-workflow-operations')
  }
  return Object.freeze([...new Set(candidates)])
}

function normalizeResourceScopes(
  input: unknown,
): ReadonlyMap<ReceiptOperation, string> {
  const parsed = parseResourceScopes(input)
  if (!parsed) throw new Error('invalid-workflow-resource-scopes')
  return parsed
}

function validateOptions(
  options: unknown,
): asserts options is WorkflowGuardOptions {
  if (!isRecord(options) || !hasOnlyFields(options, OPTION_KEYS)) {
    throw new Error('invalid-workflow-options')
  }
  if (!options.ledger || typeof options.ledger !== 'object') {
    throw new Error('invalid-workflow-options')
  }
  if (!isBoundedString(options.workspaceIdentity)) {
    throw new Error('invalid-workflow-options')
  }
  validateOptionalIdentities(options)
  validateOptionPolicies(options)
}

function validateOptionalIdentities(options: Record<string, unknown>): void {
  for (const identity of [
    options.repositoryIdentity,
    options.worktreeIdentity,
  ]) {
    if (identity !== undefined && !isBoundedString(identity)) {
      throw new Error('invalid-workflow-options')
    }
  }
}

function validateOptionPolicies(options: Record<string, unknown>): void {
  normalizeRepairs(options.supportedRepairs)
  normalizeOperations(options.questionEligibleOperations)
  normalizeOperations(options.runtimeRequiredOperations)
  normalizeResourceScopes(options.runtimeResourceScopes)
  validateOptionMode(options.mode)
  validateOptionAge(options.maxReceiptAgeMs, options.clock)
}

function validateOptionMode(mode: unknown): void {
  if (mode !== undefined && !isMode(mode)) {
    throw new Error('invalid-workflow-options')
  }
}

function validateOptionAge(maxAge: unknown, clock: unknown): void {
  if (
    maxAge !== undefined &&
    (typeof maxAge !== 'number' ||
      !Number.isFinite(maxAge) ||
      maxAge <= 0 ||
      maxAge > MAX_RECEIPT_AGE_MS)
  ) {
    throw new Error('invalid-workflow-options')
  }
  if (clock !== undefined && typeof clock !== 'function') {
    throw new Error('invalid-workflow-options')
  }
}

function attemptReason(outcome: AttemptOutcome): WorkflowReasonCode {
  switch (outcome) {
    case 'cancelled':
      return 'cancelled-operation'
    case 'failed':
      return 'failed-operation'
    case 'no-op':
      return 'no-op-operation'
    case 'running':
      return 'running-operation'
    case 'unattributed':
      return 'unattributed-operation'
    case 'unavailable':
      return 'guard-unavailable'
    case 'rejected':
      return 'rejected-operation'
  }
}

function issueKey(issue: Issue | undefined): string {
  return issue
    ? `${issue.kind}:${issue.reasonCode}:${issue.repair ?? '-'}`
    : '-'
}

export function createWorkflowGuard(
  options: WorkflowGuardOptions,
): WorkflowGuard {
  validateOptions(options)
  const repairs = normalizeRepairs(options.supportedRepairs)
  const questionEligible = new Set(
    normalizeOperations(options.questionEligibleOperations),
  )
  const runtimeRequired = normalizeOperations(options.runtimeRequiredOperations)
  const runtimeScopes = normalizeResourceScopes(options.runtimeResourceScopes)
  let mode = options.mode ?? 'protected'
  let epoch: EpochState | undefined
  let globalIssue: Issue | undefined
  const transitionsByCall = new Map<string, PreparedTransition>()
  const clock = options.clock ?? Date.now

  function currentResource(
    unit: UnitState,
    operation: ReceiptOperation,
  ): string | undefined {
    return unit.resourceScopes.get(operation)
  }

  function eligibleRepairKinds(
    operation: ReceiptOperation | undefined,
    reasonCode: WorkflowReasonCode,
  ): readonly RepairKind[] {
    if (reasonCode === 'guard-unavailable') return []
    if (reasonCode === 'missing-evidence') {
      const kinds: RepairKind[] = ['fresh-readback', 'rerun-operation']
      if (operation && questionEligible.has(operation)) {
        kinds.push('question-attestation')
      }
      return kinds
    }
    if (reasonCode === 'running-operation') return ['fresh-readback']
    if (
      reasonCode === 'incompatible-receipt' ||
      reasonCode === 'foreign-registration' ||
      reasonCode === 'resource-mismatch' ||
      reasonCode === 'workspace-mismatch' ||
      reasonCode === 'receipt-mismatch' ||
      reasonCode === 'stale-receipt' ||
      reasonCode === 'invalid-receipt'
    ) {
      return ['fresh-readback']
    }
    return ['rerun-operation']
  }

  function repairFor(
    operation: ReceiptOperation | undefined,
    reasonCode: WorkflowReasonCode,
  ): RepairKind | undefined {
    const eligible = eligibleRepairKinds(operation, reasonCode)
    return eligible.find((repair) => repairs.includes(repair))
  }

  function setIssue(
    unit: UnitState,
    operation: ReceiptOperation,
    reasonCode: WorkflowReasonCode,
  ): void {
    const issue: Issue = {
      kind: issueKind(reasonCode),
      reasonCode,
      repair: repairFor(operation, reasonCode),
    }
    if (issueKey(unit.issues.get(operation)) !== issueKey(issue)) {
      unit.issues.set(operation, issue)
    }
  }

  function clearIssue(unit: UnitState, operation: ReceiptOperation): void {
    unit.issues.delete(operation)
  }

  function mapEnvelopeReason(
    reasonCode: ReceiptReasonCode,
  ): WorkflowReasonCode {
    if (reasonCode === 'cross-registration-disputed')
      return 'foreign-registration'
    if (
      reasonCode === 'incomplete-envelope' ||
      reasonCode === 'unknown-envelope'
    ) {
      return 'invalid-receipt'
    }
    return 'incompatible-receipt'
  }

  function readCurrentEnvelope(input: unknown): EnvelopeRead {
    const validation = options.ledger.validateEnvelope(input)
    if (validation.compatibility !== 'compatible') {
      return { reasonCode: mapEnvelopeReason(validation.reasonCode) }
    }
    const current = options.ledger.getEnvelope(
      validation.envelope.canonical.receiptId,
    )
    if (!current) return { reasonCode: 'incompatible-receipt' }
    const currentValidation = options.ledger.validateEnvelope(current)
    if (currentValidation.compatibility !== 'compatible') {
      return { reasonCode: 'incompatible-receipt' }
    }
    return { envelope: currentValidation.envelope }
  }

  function compareReceiptScope(
    envelope: ReceiptEnvelope,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    if (!epoch) return 'no-active-epoch'
    if (
      envelope.canonical.epochDigest !==
      options.ledger.digestIdentity('epoch', epoch.epochId)
    ) {
      return 'receipt-mismatch'
    }
    if (
      envelope.canonical.unitDigest !==
      options.ledger.digestIdentity('unit', unit.unitId)
    ) {
      return 'receipt-mismatch'
    }
    if (
      envelope.canonical.workspaceDigest !==
      options.ledger.digestIdentity('workspace', options.workspaceIdentity)
    ) {
      return 'workspace-mismatch'
    }
    return compareReceiptResources(envelope, unit)
  }

  function compareReceiptResources(
    envelope: ReceiptEnvelope,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    const expectedRepository = options.repositoryIdentity
      ? options.ledger.digestIdentity('repository', options.repositoryIdentity)
      : undefined
    const expectedWorktree = options.worktreeIdentity
      ? options.ledger.digestIdentity('worktree', options.worktreeIdentity)
      : undefined
    if (envelope.canonical.repositoryDigest !== expectedRepository) {
      return 'receipt-mismatch'
    }
    if (envelope.canonical.worktreeDigest !== expectedWorktree) {
      return 'receipt-mismatch'
    }
    const resourceIdentity = currentResource(unit, envelope.canonical.operation)
    if (!resourceIdentity) {
      return envelope.canonical.resourceDigest === undefined
        ? undefined
        : 'resource-mismatch'
    }
    return envelope.canonical.resourceDigest ===
      options.ledger.digestIdentity('resource', resourceIdentity)
      ? undefined
      : 'resource-mismatch'
  }

  function receiptOutcomeReason(
    envelope: ReceiptEnvelope,
  ): WorkflowReasonCode | undefined {
    if (envelope.canonical.result !== 'success') return 'rejected-operation'
    if (envelope.canonical.source !== 'runtime-verified') {
      return 'unattributed-operation'
    }
    if (envelope.canonical.consumption !== 'available') {
      return 'consumed-receipt'
    }
    return receiptAgeReason(envelope)
  }

  function receiptAgeReason(
    envelope: ReceiptEnvelope,
  ): WorkflowReasonCode | undefined {
    if (options.maxReceiptAgeMs === undefined) return undefined
    let now: number
    try {
      now = clock()
    } catch {
      return 'guard-unavailable'
    }
    if (!Number.isFinite(now)) return 'guard-unavailable'
    return now - envelope.canonical.timestamp > options.maxReceiptAgeMs
      ? 'stale-receipt'
      : undefined
  }

  function qualifyEnvelope(
    envelope: ReceiptEnvelope,
    unit: UnitState,
  ): Qualification {
    const operation = envelope.canonical.operation
    if (!unit.requiredOperations.includes(operation)) {
      return { operation, reasonCode: 'operation-not-required' }
    }
    const scopeReason = compareReceiptScope(envelope, unit)
    if (scopeReason) return { operation, reasonCode: scopeReason }
    const outcomeReason = receiptOutcomeReason(envelope)
    if (outcomeReason) return { operation, reasonCode: outcomeReason }
    return { operation, envelope }
  }

  function qualifyReceipt(input: unknown, unit: UnitState): Qualification {
    const read = readCurrentEnvelope(input)
    return read.envelope
      ? qualifyEnvelope(read.envelope, unit)
      : { operation: 'implementation', reasonCode: read.reasonCode }
  }

  function refreshIssues(unit: UnitState): void {
    for (const [operation, envelope] of unit.evidence) {
      const qualification = qualifyReceipt(envelope, unit)
      if (qualification.envelope) {
        clearIssue(unit, operation)
      } else if (qualification.reasonCode) {
        setIssue(unit, operation, qualification.reasonCode)
      }
    }
  }

  function evidenceLists(): {
    satisfied: ReceiptOperation[]
    missing: ReceiptOperation[]
  } {
    const unit = epoch?.unit
    if (!unit) return { satisfied: [], missing: [] }
    if (unit.status === 'completed') {
      return {
        satisfied: unit.requiredOperations.filter((operation) =>
          unit.evidence.has(operation),
        ),
        missing: [],
      }
    }
    const satisfied: ReceiptOperation[] = []
    const missing: ReceiptOperation[] = []
    for (const operation of unit.requiredOperations) {
      const envelope = unit.evidence.get(operation)
      if (envelope && qualifyReceipt(envelope, unit).envelope) {
        satisfied.push(operation)
      } else {
        missing.push(operation)
      }
    }
    return { satisfied, missing }
  }

  function issueKind(reasonCode: WorkflowReasonCode): Issue['kind'] {
    return reasonCode === 'incompatible-receipt' ||
      reasonCode === 'guard-unavailable'
      ? 'unavailable'
      : 'rejected'
  }

  function makeStatus(
    state: WorkflowState,
    reasonCode: WorkflowReasonCode,
    repair?: RepairKind,
    satisfied: readonly ReceiptOperation[] = [],
    missing: readonly ReceiptOperation[] = [],
  ): WorkflowStatus {
    const epochSnapshot = epoch ? cloneEpoch(epoch) : null
    const unitSnapshot = epoch?.unit ? cloneUnit(epoch.unit) : null
    const statusKey = [
      state,
      reasonCode,
      repair ?? '-',
      epochSnapshot?.epochId ?? '-',
      epochSnapshot?.family ?? '-',
      epochSnapshot?.status ?? '-',
      unitSnapshot?.unitId ?? '-',
      unitSnapshot?.status ?? '-',
      satisfied.join(','),
      missing.join(','),
    ].join('|')
    return Object.freeze({
      state,
      reasonCode,
      ...(repair ? { repair } : {}),
      statusKey,
      epoch: epochSnapshot,
      unit: unitSnapshot,
      satisfiedOperations: Object.freeze([...satisfied]),
      missingOperations: Object.freeze([...missing]),
    })
  }

  function projectUnitIssue(
    issue: Issue,
    lists: { satisfied: ReceiptOperation[]; missing: ReceiptOperation[] },
  ): WorkflowStatus {
    const state =
      issue.kind === 'unavailable' || !issue.repair ? 'unavailable' : 'rejected'
    return makeStatus(
      state,
      issue.repair || issue.kind === 'unavailable'
        ? issue.reasonCode
        : 'no-supported-repair',
      issue.repair,
      lists.satisfied,
      lists.missing,
    )
  }

  function projectMissingEvidence(lists: {
    satisfied: ReceiptOperation[]
    missing: ReceiptOperation[]
  }): WorkflowStatus {
    const repair = repairFor(lists.missing[0], 'missing-evidence')
    const missing = lists.missing.length > 0
    return makeStatus(
      missing ? (repair ? 'waiting' : 'unavailable') : 'protected',
      missing
        ? repair
          ? 'missing-evidence'
          : 'no-supported-repair'
        : 'unit-ready',
      repair,
      lists.satisfied,
      lists.missing,
    )
  }

  function activeProjection(): WorkflowStatus {
    const unit = epoch?.unit
    const lists = evidenceLists()
    if (!unit)
      return makeStatus(
        'unavailable',
        'no-active-unit',
        undefined,
        lists.satisfied,
        lists.missing,
      )
    if (unit.status === 'completed') {
      return makeStatus(
        'protected',
        'unit-completed',
        undefined,
        lists.satisfied,
        lists.missing,
      )
    }
    refreshIssues(unit)
    const issue = unit.requiredOperations
      .map((operation) => unit.issues.get(operation))
      .find((candidate): candidate is Issue => candidate !== undefined)
    return issue
      ? projectUnitIssue(issue, lists)
      : projectMissingEvidence(lists)
  }

  function projectControl(
    state: 'disabled' | 'unavailable',
    reasonCode: WorkflowReasonCode,
    lists: { satisfied: ReceiptOperation[]; missing: ReceiptOperation[] },
  ): WorkflowStatus {
    return makeStatus(
      state,
      reasonCode,
      undefined,
      lists.satisfied,
      lists.missing,
    )
  }

  function projectGlobalIssue(
    issue: Issue,
    lists: { satisfied: ReceiptOperation[]; missing: ReceiptOperation[] },
  ): WorkflowStatus {
    return makeStatus(
      !issue.repair || issueKind(issue.reasonCode) === 'unavailable'
        ? 'unavailable'
        : 'rejected',
      issue.repair || issueKind(issue.reasonCode) === 'unavailable'
        ? issue.reasonCode
        : 'no-supported-repair',
      issue.repair,
      lists.satisfied,
      lists.missing,
    )
  }

  function projection(): WorkflowStatus {
    const lists = evidenceLists()
    if (mode === 'disabled')
      return projectControl('disabled', 'disabled', lists)
    if (mode === 'unavailable') {
      return projectControl('unavailable', 'guard-unavailable', lists)
    }
    if (globalIssue) return projectGlobalIssue(globalIssue, lists)
    if (!epoch) return makeStatus('unavailable', 'no-active-epoch')
    if (epoch.status === 'completed') {
      return makeStatus(
        'protected',
        'epoch-completed',
        undefined,
        lists.satisfied,
        lists.missing,
      )
    }
    return activeProjection()
  }

  function blockedByCurrentStatus(
    reasonCode: WorkflowReasonCode,
  ): BlockedDecision {
    const state = projection().state
    return {
      ready: false,
      status:
        state === 'unavailable'
          ? 'unavailable'
          : state === 'waiting'
            ? 'waiting'
            : 'rejected',
      reasonCode,
    }
  }

  function decideEpochTransition(unit: UnitState): TransitionDecision {
    return unit.status === 'completed'
      ? { ready: true, envelopes: [] }
      : { ready: false, status: 'waiting', reasonCode: 'unit-incomplete' }
  }

  function decideUnitTransition(unit: UnitState): TransitionDecision {
    if (unit.status === 'completed') {
      return { ready: false, status: 'rejected', reasonCode: 'unit-completed' }
    }
    refreshIssues(unit)
    const envelopes: ReceiptEnvelope[] = []
    for (const operation of unit.requiredOperations) {
      const envelope = unit.evidence.get(operation)
      if (!envelope) return blockedByCurrentStatus('missing-evidence')
      const qualification = qualifyReceipt(envelope, unit)
      if (!qualification.envelope) {
        return blockedByCurrentStatus(
          qualification.reasonCode ?? 'incompatible-receipt',
        )
      }
      envelopes.push(qualification.envelope)
    }
    return { ready: true, envelopes }
  }

  function transitionDecision(target: TransitionTarget): TransitionDecision {
    if (globalIssue) return blockedByCurrentStatus(globalIssue.reasonCode)
    if (!epoch) {
      return {
        ready: false,
        status: 'unavailable',
        reasonCode: 'no-active-epoch',
      }
    }
    if (epoch.status === 'completed') {
      return { ready: false, status: 'rejected', reasonCode: 'epoch-completed' }
    }
    if (!epoch.unit) {
      return {
        ready: false,
        status: 'unavailable',
        reasonCode: 'no-active-unit',
      }
    }
    return target === 'epoch'
      ? decideEpochTransition(epoch.unit)
      : decideUnitTransition(epoch.unit)
  }

  function consumeContext(
    unit: UnitState,
    operation: ReceiptOperation,
  ): {
    epochId: string
    unitId: string
    workspaceIdentity: string
    repositoryIdentity?: string
    worktreeIdentity?: string
    resourceIdentity?: string
  } {
    if (!epoch) throw new Error('missing-epoch')
    return {
      epochId: epoch.epochId,
      unitId: unit.unitId,
      workspaceIdentity: options.workspaceIdentity,
      repositoryIdentity: options.repositoryIdentity,
      worktreeIdentity: options.worktreeIdentity,
      resourceIdentity: currentResource(unit, operation),
    }
  }

  function finalizePrepared(
    lifecycle: PreparedTransition,
    decision: ReadyDecision,
  ): TransitionFinalizeResult {
    if (!epoch) return { status: 'unavailable', reasonCode: 'no-active-epoch' }
    if (!lifecycle.transitionId) {
      return { status: 'unavailable', reasonCode: 'finalization-failed' }
    }
    const transitionId = lifecycle.transitionId
    if (lifecycle.target === 'epoch') {
      epoch.status = 'completed'
      return {
        status: 'completed',
        target: lifecycle.target,
        transitionId,
      }
    }
    if (!epoch.unit)
      return { status: 'unavailable', reasonCode: 'no-active-unit' }
    for (const envelope of decision.envelopes) {
      const result = options.ledger.consumeReceipt(
        envelope.canonical.receiptId,
        consumeContext(epoch.unit, envelope.canonical.operation),
      )
      if (result.status !== 'consumed') {
        return { status: 'unavailable', reasonCode: 'finalization-failed' }
      }
    }
    epoch.unit.status = 'completed'
    return {
      status: 'completed',
      target: lifecycle.target,
      transitionId,
    }
  }

  function recordGlobalEvidenceIssue(
    reasonCode: WorkflowReasonCode,
  ): EvidenceObservationResult {
    globalIssue = {
      kind: issueKind(reasonCode),
      reasonCode,
      repair: repairFor(undefined, reasonCode),
    }
    return {
      status:
        issueKind(reasonCode) === 'unavailable' ? 'unavailable' : 'rejected',
      reasonCode,
    }
  }

  function recordUnitEvidenceIssue(
    unit: UnitState,
    operation: ReceiptOperation,
    reasonCode: WorkflowReasonCode,
  ): EvidenceObservationResult {
    setIssue(unit, operation, reasonCode)
    return {
      status:
        issueKind(reasonCode) === 'unavailable' ? 'unavailable' : 'rejected',
      reasonCode,
    }
  }

  function observeReceiptForUnit(
    input: unknown,
    unit: UnitState,
  ): EvidenceObservationResult {
    const read = readCurrentEnvelope(input)
    if (!read.envelope) {
      return recordGlobalEvidenceIssue(read.reasonCode ?? 'invalid-receipt')
    }
    const operation = read.envelope.canonical.operation
    const qualification = qualifyEnvelope(read.envelope, unit)
    if (!unit.requiredOperations.includes(operation)) {
      return { status: 'rejected', reasonCode: 'operation-not-required' }
    }
    if (!qualification.envelope) {
      return recordUnitEvidenceIssue(
        unit,
        operation,
        qualification.reasonCode ?? 'incompatible-receipt',
      )
    }
    const previous = unit.evidence.get(operation)
    if (previous?.canonical.receiptId === read.envelope.canonical.receiptId) {
      return { status: 'accepted', operation }
    }
    unit.evidence.set(operation, read.envelope)
    clearIssue(unit, operation)
    globalIssue = undefined
    return { status: 'accepted', operation }
  }

  function activationModeResult(): ActivationResult | undefined {
    if (mode === 'disabled')
      return { status: 'ignored', reasonCode: 'disabled' }
    if (mode === 'unavailable') {
      return { status: 'rejected', reasonCode: 'guard-unavailable' }
    }
    return undefined
  }

  function evidenceModeResult():
    | { status: 'rejected'; reasonCode: WorkflowReasonCode }
    | undefined {
    if (mode === 'disabled')
      return { status: 'rejected', reasonCode: 'disabled' }
    if (mode === 'unavailable') {
      return { status: 'rejected', reasonCode: 'guard-unavailable' }
    }
    return undefined
  }

  function transitionModeResult(): TransitionPrepareResult | undefined {
    if (mode === 'disabled')
      return { status: 'rejected', reasonCode: 'disabled' }
    if (mode === 'unavailable') {
      return { status: 'rejected', reasonCode: 'guard-unavailable' }
    }
    return undefined
  }

  function mergeResourceScopes(
    trustedPolicy: ParsedUnitRequest,
    modelScopes: ReadonlyMap<ReceiptOperation, string>,
  ): ReadonlyMap<ReceiptOperation, string> | undefined {
    const result = new Map(runtimeScopes)
    for (const scopes of [trustedPolicy.resourceScopes, modelScopes]) {
      for (const [operation, resource] of scopes) {
        const existing = result.get(operation)
        if (existing && existing !== resource) return undefined
        result.set(operation, existing ?? resource)
      }
    }
    return result
  }

  function requiredOperationsFor(
    trustedPolicy: ParsedUnitRequest,
    model: ParsedUnitRequest,
    resourceScopes: ReadonlyMap<ReceiptOperation, string>,
  ): readonly ReceiptOperation[] {
    return Object.freeze([
      ...new Set([
        ...MANDATORY_OPERATIONS,
        ...runtimeRequired,
        ...trustedPolicy.expectedOperations,
        ...model.expectedOperations,
        ...resourceScopes.keys(),
      ]),
    ])
  }

  function startParsedUnit(
    parsed: ParsedUnitRequest,
    trustedPolicy: ParsedUnitRequest,
  ): StartUnitResult {
    if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
    if (epoch.unit?.status === 'active') {
      return { status: 'rejected', reasonCode: 'unit-active' }
    }
    const resourceScopes = mergeResourceScopes(
      trustedPolicy,
      parsed.resourceScopes,
    )
    if (!resourceScopes) {
      return { status: 'rejected', reasonCode: 'runtime-scope-conflict' }
    }
    const requiredOperations = requiredOperationsFor(
      trustedPolicy,
      parsed,
      resourceScopes,
    )
    epoch.unit = {
      unitId: randomId(),
      status: 'active',
      requiredOperations,
      resourceScopes,
      evidence: new Map(),
      issues: new Map(),
    }
    return { status: 'started', unit: cloneUnit(epoch.unit) }
  }

  function observeParsedAttempt(
    parsed: ParsedAttempt,
    unit: UnitState,
  ): EvidenceObservationResult {
    if (!unit.requiredOperations.includes(parsed.operation)) {
      return { status: 'rejected', reasonCode: 'operation-not-required' }
    }
    const reasonCode = attemptReason(parsed.outcome)
    setIssue(unit, parsed.operation, reasonCode)
    const repair = repairFor(parsed.operation, reasonCode)
    if (repair) {
      const issue = unit.issues.get(parsed.operation)
      if (issue) issue.repair = repair
    }
    return {
      status: reasonCode === 'guard-unavailable' ? 'unavailable' : 'rejected',
      reasonCode,
    }
  }

  function prepareForCall(parsed: ParsedTransition): TransitionPrepareResult {
    const callDigest = options.ledger.digestIdentity('call', parsed.callId)
    const existing = transitionsByCall.get(callDigest)
    if (existing) return replayPrepare(existing, parsed.target)
    const decision = transitionDecision(parsed.target)
    if (!decision.ready) {
      const result: TransitionPrepareResult = {
        status: decision.status,
        reasonCode: decision.reasonCode,
      }
      transitionsByCall.set(callDigest, {
        callDigest,
        target: parsed.target,
        state: 'terminal',
        prepareResult: result,
      })
      return result
    }
    const transitionId = randomId()
    const lifecycle: PreparedTransition = {
      callDigest,
      target: parsed.target,
      transitionId,
      state: 'prepared',
    }
    transitionsByCall.set(callDigest, lifecycle)
    return { status: 'allowed', transitionId }
  }

  function replayPrepare(
    existing: PreparedTransition,
    target: TransitionTarget,
  ): TransitionPrepareResult {
    if (existing.target !== target) {
      return { status: 'rejected', reasonCode: 'call-context-conflict' }
    }
    if (existing.prepareResult) return existing.prepareResult
    if (existing.state === 'prepared' && existing.transitionId) {
      return { status: 'allowed', transitionId: existing.transitionId }
    }
    return {
      status: 'rejected',
      reasonCode:
        existing.state === 'abandoned'
          ? 'abandoned-transition'
          : 'transition-terminal',
    }
  }

  return {
    activate(input: unknown): ActivationResult {
      const modeResult = activationModeResult()
      if (modeResult) return modeResult
      const parsed = parseActivation(input)
      if (!parsed)
        return { status: 'ignored', reasonCode: 'invalid-transition' }
      if (epoch?.status === 'completed') {
        epoch = { epochId: randomId(), family: parsed.family, status: 'active' }
        globalIssue = undefined
        return { status: 'activated', epoch: cloneEpoch(epoch) }
      }
      if (!epoch) {
        epoch = { epochId: randomId(), family: parsed.family, status: 'active' }
        return { status: 'activated', epoch: cloneEpoch(epoch) }
      }
      if (epoch.family === 'shipping' && parsed.family === 'work') {
        return { status: 'rejected', reasonCode: 'family-conflict' }
      }
      return {
        status:
          parsed.family === 'shipping' && epoch.family === 'work'
            ? 'attached'
            : 'reused',
        epoch: cloneEpoch(epoch),
      }
    },

    startUnit(input: unknown, policy?: RuntimeUnitPolicy): StartUnitResult {
      const modeResult = evidenceModeResult()
      if (modeResult)
        return { status: 'rejected', reasonCode: modeResult.reasonCode }
      if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
      if (epoch.status === 'completed') {
        return { status: 'rejected', reasonCode: 'epoch-completed' }
      }
      const parsed = parseUnitRequest(input)
      if (!parsed) return { status: 'rejected', reasonCode: 'forbidden-field' }
      const trustedPolicy = parseRuntimeUnitPolicy(policy)
      if (!trustedPolicy) {
        return { status: 'rejected', reasonCode: 'invalid-configuration' }
      }
      return startParsedUnit(parsed, trustedPolicy)
    },

    observeReceipt(input: unknown): EvidenceObservationResult {
      const modeResult = evidenceModeResult()
      if (modeResult) return modeResult
      if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
      if (!epoch.unit)
        return { status: 'rejected', reasonCode: 'no-active-unit' }
      if (epoch.unit.status === 'completed') {
        return { status: 'rejected', reasonCode: 'unit-completed' }
      }
      return observeReceiptForUnit(input, epoch.unit)
    },

    observeAttempt(input: unknown): EvidenceObservationResult {
      const modeResult = evidenceModeResult()
      if (modeResult) return modeResult
      if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
      if (!epoch.unit)
        return { status: 'rejected', reasonCode: 'no-active-unit' }
      if (epoch.unit.status === 'completed') {
        return { status: 'rejected', reasonCode: 'unit-completed' }
      }
      const parsed = parseAttempt(input)
      if (!parsed) return { status: 'rejected', reasonCode: 'invalid-receipt' }
      return observeParsedAttempt(parsed, epoch.unit)
    },

    status(): WorkflowStatus {
      return projection()
    },

    prepareTransition(input: unknown): TransitionPrepareResult {
      const modeResult = transitionModeResult()
      if (modeResult) return modeResult
      const parsed = parseTransition(input)
      if (!parsed)
        return { status: 'rejected', reasonCode: 'invalid-transition' }
      return prepareForCall(parsed)
    },

    finalizeTransition(input: unknown): TransitionFinalizeResult {
      const parsed = parseFinalization(input)
      if (!parsed)
        return { status: 'rejected', reasonCode: 'invalid-transition' }
      const callDigest = options.ledger.digestIdentity('call', parsed.callId)
      const lifecycle = transitionsByCall.get(callDigest)
      if (!lifecycle || lifecycle.transitionId !== parsed.transitionId) {
        return { status: 'rejected', reasonCode: 'invalid-transition' }
      }
      if (lifecycle.state === 'abandoned') {
        return { status: 'rejected', reasonCode: 'abandoned-transition' }
      }
      if (lifecycle.state === 'terminal' && lifecycle.terminalResult) {
        if (lifecycle.terminalResult.status === 'completed') {
          return {
            status: 'duplicate',
            target: lifecycle.terminalResult.target,
            transitionId: lifecycle.terminalResult.transitionId,
          }
        }
        return lifecycle.terminalResult
      }
      const decision = transitionDecision(lifecycle.target)
      if (!decision.ready) {
        const result: TransitionFinalizeResult = {
          status: decision.status,
          reasonCode: decision.reasonCode,
        }
        lifecycle.state = 'terminal'
        lifecycle.terminalResult = result
        return result
      }
      const result = finalizePrepared(lifecycle, decision)
      lifecycle.state = 'terminal'
      lifecycle.terminalResult = result
      return result
    },

    abandonTransition(input: unknown): AbandonTransitionResult {
      if (
        !isRecord(input) ||
        !hasOnlyFields(input, new Set(['callId', 'transitionId'])) ||
        !isBoundedString(input.callId) ||
        !isBoundedString(input.transitionId)
      ) {
        return { status: 'rejected', reasonCode: 'invalid-transition' }
      }
      const callDigest = options.ledger.digestIdentity('call', input.callId)
      const lifecycle = transitionsByCall.get(callDigest)
      if (!lifecycle || lifecycle.transitionId !== input.transitionId) {
        return { status: 'rejected', reasonCode: 'invalid-transition' }
      }
      if (lifecycle.state === 'abandoned') {
        return { status: 'duplicate', reasonCode: 'abandoned-transition' }
      }
      if (lifecycle.state === 'terminal') {
        return { status: 'rejected', reasonCode: 'transition-terminal' }
      }
      lifecycle.state = 'abandoned'
      return { status: 'abandoned' }
    },

    setMode(input: unknown): ControlResult {
      const parsed = parseControl(input)
      if (!parsed) return { status: 'rejected', reasonCode: 'invalid-control' }
      if (parsed.mode === mode) return { status: 'unchanged', mode }
      mode = parsed.mode
      for (const lifecycle of transitionsByCall.values()) {
        if (lifecycle.state === 'prepared') lifecycle.state = 'abandoned'
      }
      return { status: 'changed', mode }
    },
  }
}
