import { randomBytes } from 'node:crypto'

import {
  parseReceiptOperationAfter,
  parseReceiptOperationObservation,
  type ReceiptClassifier,
  type ReceiptOperationAfter,
  type ReceiptOperationContext,
  type ReceiptOperationObservation,
} from './receipt-classifier.js'
import type {
  ReceiptClassification,
  ReceiptContext,
  ReceiptEnvelope,
  ReceiptLedger,
  ReceiptObservationAfter,
  ReceiptOperation,
  ReceiptReasonCode,
} from './receipt-ledger.js'
import type {
  ReceiptEpochProgressionSnapshot,
  ReceiptReadbackProgression,
  ReceiptResourceScope,
  ReceiptUnitProgressionSnapshot,
} from './receipt-readback.js'

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
  | 'epoch-mismatch'
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
  | 'unit-mismatch'
  | 'unit-ready'
  | 'workspace-mismatch'
  | 'runtime-scope-conflict'
  | 'invalid-recovery'
  | 'recovery-conflict'
  | 'fork-copy-not-lineage'

export interface WorkflowGuardOptions {
  ledger: ReceiptLedger
  classifier?: ReceiptClassifier
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
  resourceScopes: readonly ReceiptResourceScope[]
}

export interface CurrentOperationContext {
  readonly workspaceIdentity: string
  readonly repositoryIdentity?: string
  readonly worktreeIdentity?: string
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

export type ReadbackObservationResult =
  | { status: 'accepted'; changed: boolean }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }

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

export type WorkflowRecoveryResult =
  | {
      status: 'restored' | 'duplicate'
      provenance: 'restart'
      epoch: EpochSnapshot
      unit: UnitSnapshot | null
    }
  | { status: 'rejected'; reasonCode: WorkflowReasonCode }

export interface WorkflowGuard {
  activate(input: unknown): ActivationResult
  startUnit(input: unknown, policy?: RuntimeUnitPolicy): StartUnitResult
  observeReceipt(input: unknown): EvidenceObservationResult
  observeAttempt(input: unknown): EvidenceObservationResult
  observeOperation(input: unknown): Promise<EvidenceObservationResult>
  /**
   * Internal recovery seam. Callers MUST validate host lineage, own
   * registration/seed/readback, stable workspace, and current mutable
   * revisions before using this classifier-bypassing path.
   */
  observeTrustedRecoveredOperation(
    input: unknown,
  ): Promise<EvidenceObservationResult>
  observeReadback(input: unknown): ReadbackObservationResult
  currentOperationContext(): CurrentOperationContext
  status(): WorkflowStatus
  prepareTransition(input: unknown): TransitionPrepareResult
  finalizeTransition(input: unknown): TransitionFinalizeResult
  abandonTransition(input: unknown): AbandonTransitionResult
  restore(input: unknown): WorkflowRecoveryResult
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

type ParsedOperationObservation = ReceiptOperationObservation

interface ParsedReadback {
  operation?: ReceiptOperation
  workspaceIdentity: string
  repositoryIdentity?: string
  worktreeIdentity?: string
  resourceIdentity?: string
  resourceRevisionIdentity?: string
  pullRequest?: ReceiptOperationAfter['pullRequest']
  checkState?: ReceiptOperationAfter['checkState']
  reviewDecision?: ReceiptOperationAfter['reviewDecision']
}

interface OperationState {
  fingerprint: string
}

interface ParsedTransition {
  callId: string
  target: TransitionTarget
}

interface ParsedFinalization {
  callId: string
  transitionId: string
  readback?: ParsedReadback
  readbacks?: readonly ParsedReadback[]
}

const MAX_FINAL_READBACKS = 8
const RESOURCE_FINAL_READBACK_OPERATIONS = [
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
] as const

interface ParsedControl {
  mode: WorkflowMode
}

interface ParsedRecoveryInput {
  provenance: 'restart' | 'fork-copy'
  state: ParsedRecoveryState
}

interface ParsedRecoveryState {
  registrationDigest: string
  receipts: readonly unknown[]
  progression: ReceiptReadbackProgression
}

interface RecoveryCandidate {
  epoch: EpochState
  resourceIdentities: Map<ReceiptOperation, string>
  fingerprint: string
}

interface RecoveryParts {
  resources: {
    resourceScopes: Map<ReceiptOperation, string>
    current: Map<ReceiptOperation, string>
  }
  receiptSet: {
    receipts: readonly ReceiptEnvelope[]
    matching: readonly ReceiptEnvelope[]
  }
}

const RECOVERY_EPOCH_KEYS = new Set([
  'target',
  'state',
  'epochId',
  'epochDigest',
  'family',
  'transitionDigest',
])
const RECOVERY_UNIT_KEYS = new Set([
  'target',
  'state',
  'epochId',
  'epochDigest',
  'unitId',
  'unitDigest',
  'family',
  'requiredOperations',
  'resourceScopes',
  'transitionDigest',
])
const RECOVERY_STATE_KEYS = new Set([
  'registrationDigest',
  'receipts',
  'progression',
])
const RECOVERY_INPUT_KEYS = new Set(['provenance', 'state'])
const RECOVERY_OPERATION_ORDER: readonly ReceiptOperation[] = [
  'implementation',
  'verification',
  'commit',
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
]
const RECOVERY_ID_PATTERN = /^[0-9a-f]{32}$/
const RECOVERY_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const MAX_RECOVERY_RECEIPTS = 128

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
  declaredResourceOperations: readonly ReceiptOperation[]
  resourceScopes: ReadonlyMap<ReceiptOperation, string>
  evidence: Map<ReceiptOperation, ReceiptEnvelope>
  issues: Map<ReceiptOperation, Issue>
  staleReceiptIds: Set<string>
  recoveredReceiptIds: Set<string>
  operationStates: Map<ReceiptOperation, OperationState>
  ledgerContexts: Map<string, ReceiptContext>
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
  'classifier',
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

function isFamily(value: unknown): value is EpochFamily {
  return value === 'work' || value === 'shipping'
}

function hasOnlyFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(input).every((field) => allowed.has(field))
}

function isRecoveryId(value: unknown): value is string {
  return typeof value === 'string' && RECOVERY_ID_PATTERN.test(value)
}

function isRecoveryDigest(value: unknown): value is string {
  return typeof value === 'string' && RECOVERY_DIGEST_PATTERN.test(value)
}

function parseRecoveryOperations(
  value: unknown,
): readonly ReceiptOperation[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPERATIONS) return undefined
  const operations = value.filter(isOperation)
  if (operations.length !== value.length) return undefined
  if (new Set(operations).size !== operations.length) return undefined
  const canonical = RECOVERY_OPERATION_ORDER.filter((operation) =>
    operations.includes(operation),
  )
  return canonical.length === operations.length &&
    canonical.every((operation, index) => operation === operations[index])
    ? Object.freeze([...canonical])
    : undefined
}

function parseRecoveryResourceScopes(
  value: unknown,
): readonly ReceiptResourceScope[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPERATIONS) return undefined
  const scopes: ReceiptResourceScope[] = []
  const identities = new Set<string>()
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyFields(item, new Set(['operation', 'resourceIdentity'])) ||
      !isOperation(item.operation) ||
      !isRecoveryDigest(item.resourceIdentity)
    ) {
      return undefined
    }
    const key = `${item.operation}/${item.resourceIdentity}`
    if (identities.has(key)) return undefined
    identities.add(key)
    scopes.push({
      operation: item.operation,
      resourceIdentity: item.resourceIdentity,
    })
  }
  const canonical = [...scopes].sort((first, second) => {
    const firstIndex = RECOVERY_OPERATION_ORDER.indexOf(first.operation)
    const secondIndex = RECOVERY_OPERATION_ORDER.indexOf(second.operation)
    return (
      firstIndex - secondIndex ||
      first.resourceIdentity.localeCompare(second.resourceIdentity)
    )
  })
  return canonical.every((scope, index) => {
    const original = scopes[index]
    return (
      original?.operation === scope.operation &&
      original.resourceIdentity === scope.resourceIdentity
    )
  })
    ? Object.freeze(canonical.map((scope) => ({ ...scope })))
    : undefined
}

function parseRecoveryEpoch(
  value: unknown,
): ReceiptEpochProgressionSnapshot | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasOnlyFields(value, RECOVERY_EPOCH_KEYS))
    return undefined
  if (
    value.target !== 'epoch' ||
    (value.state !== 'started' && value.state !== 'completed') ||
    !isRecoveryId(value.epochId) ||
    !isRecoveryDigest(value.epochDigest) ||
    !isFamily(value.family) ||
    !isRecoveryDigest(value.transitionDigest)
  ) {
    return undefined
  }
  return {
    target: 'epoch',
    state: value.state,
    epochId: value.epochId,
    epochDigest: value.epochDigest,
    family: value.family,
    transitionDigest: value.transitionDigest,
  }
}

function parseRecoveryUnit(
  value: unknown,
): ReceiptUnitProgressionSnapshot | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasOnlyFields(value, RECOVERY_UNIT_KEYS))
    return undefined
  const requiredOperations = parseRecoveryOperations(value.requiredOperations)
  const resourceScopes = parseRecoveryResourceScopes(value.resourceScopes)
  if (
    value.target !== 'unit' ||
    (value.state !== 'started' && value.state !== 'completed') ||
    !isRecoveryId(value.epochId) ||
    !isRecoveryDigest(value.epochDigest) ||
    !isRecoveryId(value.unitId) ||
    !isRecoveryDigest(value.unitDigest) ||
    !isFamily(value.family) ||
    !requiredOperations ||
    !resourceScopes ||
    !isRecoveryDigest(value.transitionDigest)
  ) {
    return undefined
  }
  return {
    target: 'unit',
    state: value.state,
    epochId: value.epochId,
    epochDigest: value.epochDigest,
    unitId: value.unitId,
    unitDigest: value.unitDigest,
    family: value.family,
    requiredOperations,
    resourceScopes,
    transitionDigest: value.transitionDigest,
  }
}

function parseRecoveryState(value: unknown): ParsedRecoveryState | undefined {
  if (!isRecord(value) || !hasOnlyFields(value, RECOVERY_STATE_KEYS))
    return undefined
  if (
    !isRecoveryDigest(value.registrationDigest) ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > MAX_RECOVERY_RECEIPTS ||
    !isRecord(value.progression) ||
    !hasOnlyFields(value.progression, new Set(['epoch', 'unit']))
  ) {
    return undefined
  }
  const epoch = parseRecoveryEpoch(value.progression.epoch)
  const unit = parseRecoveryUnit(value.progression.unit)
  if (epoch === undefined || unit === undefined) return undefined
  return {
    registrationDigest: value.registrationDigest,
    receipts: [...value.receipts],
    progression: { epoch, unit },
  }
}

function parseRecoveryInput(input: unknown): ParsedRecoveryInput | undefined {
  if (!isRecord(input) || !hasOnlyFields(input, RECOVERY_INPUT_KEYS))
    return undefined
  if (input.provenance !== 'restart' && input.provenance !== 'fork-copy')
    return undefined
  const state = parseRecoveryState(input.state)
  return state ? { provenance: input.provenance, state } : undefined
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
    requiredResourceOperations: Object.freeze([
      ...unit.declaredResourceOperations,
    ]),
    resourceScopes: Object.freeze(
      [...unit.resourceScopes].map(([operation, resourceIdentity]) => ({
        operation,
        resourceIdentity,
      })),
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

function parseReadback(input: unknown): ParsedReadback | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(
      input,
      new Set([
        'operation',
        'workspaceIdentity',
        'repositoryIdentity',
        'worktreeIdentity',
        'resourceIdentity',
        'resourceRevisionIdentity',
        'pullRequest',
        'checkState',
        'reviewDecision',
      ]),
    ) ||
    !isBoundedString(input.workspaceIdentity) ||
    (input.operation !== undefined && !isOperation(input.operation))
  ) {
    return undefined
  }
  const after = parseLegacyReadbackAfter({
    workspaceIdentity: input.workspaceIdentity,
    repositoryIdentity: input.repositoryIdentity,
    worktreeIdentity: input.worktreeIdentity,
    resourceIdentity: input.resourceIdentity,
    resourceRevisionIdentity: input.resourceRevisionIdentity,
    pullRequest: input.pullRequest,
    checkState: input.checkState,
    reviewDecision: input.reviewDecision,
  })
  if (!after) return undefined
  return {
    operation: input.operation,
    workspaceIdentity: after.workspaceIdentity,
    repositoryIdentity: after.repositoryIdentity,
    worktreeIdentity: after.worktreeIdentity,
    resourceIdentity: after.resourceIdentity,
    resourceRevisionIdentity: after.resourceRevisionIdentity,
    pullRequest: after.pullRequest,
    checkState: after.checkState,
    reviewDecision: after.reviewDecision,
  }
}

function parseLegacyReadbackAfter(
  input: unknown,
): ReceiptOperationAfter | undefined {
  if (!isRecord(input) || !isBoundedString(input.workspaceIdentity)) {
    return undefined
  }
  const repositoryIdentity = parseOptionalReadbackIdentity(
    input.repositoryIdentity,
  )
  const worktreeIdentity = parseOptionalReadbackIdentity(input.worktreeIdentity)
  const resourceIdentity = parseOptionalReadbackIdentity(input.resourceIdentity)
  const resourceRevisionIdentity = parseOptionalReadbackIdentity(
    input.resourceRevisionIdentity,
  )
  if (
    !isOptionalReadbackIdentity(input.repositoryIdentity, repositoryIdentity) ||
    !isOptionalReadbackIdentity(input.worktreeIdentity, worktreeIdentity) ||
    !isOptionalReadbackIdentity(input.resourceIdentity, resourceIdentity) ||
    !isOptionalReadbackIdentity(
      input.resourceRevisionIdentity,
      resourceRevisionIdentity,
    )
  ) {
    return undefined
  }
  const pullRequest = parseLegacyPullRequest(input.pullRequest)
  if (pullRequest === null) return undefined
  if (!isReadbackCheckState(input.checkState)) return undefined
  if (!isReadbackReviewDecision(input.reviewDecision)) return undefined
  return {
    workspaceIdentity: input.workspaceIdentity,
    ...(repositoryIdentity ? { repositoryIdentity } : {}),
    ...(worktreeIdentity ? { worktreeIdentity } : {}),
    ...(resourceIdentity ? { resourceIdentity } : {}),
    ...(resourceRevisionIdentity ? { resourceRevisionIdentity } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(input.checkState !== undefined ? { checkState: input.checkState } : {}),
    ...(input.reviewDecision !== undefined
      ? { reviewDecision: input.reviewDecision }
      : {}),
  }
}

function parseOptionalReadbackIdentity(value: unknown): string | undefined {
  return value === undefined || !isBoundedString(value) ? undefined : value
}

function isOptionalReadbackIdentity(
  input: unknown,
  parsed: string | undefined,
): boolean {
  return input === undefined || parsed !== undefined
}

function parseLegacyPullRequest(
  value: unknown,
): ReceiptOperationAfter['pullRequest'] | null | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, new Set(['identity', 'state'])) ||
    !isBoundedString(value.identity) ||
    !isReadbackPullRequestState(value.state)
  ) {
    return null
  }
  return { identity: value.identity, state: value.state }
}

function isReadbackPullRequestState(
  value: unknown,
): value is NonNullable<ReceiptOperationAfter['pullRequest']>['state'] {
  return value === 'open' || value === 'closed' || value === 'merged'
}

function isReadbackCheckState(
  value: unknown,
): value is ReceiptOperationAfter['checkState'] {
  return (
    value === undefined ||
    value === 'completed-success' ||
    value === 'completed-failure' ||
    value === 'pending'
  )
}

function isReadbackReviewDecision(
  value: unknown,
): value is ReceiptOperationAfter['reviewDecision'] {
  return (
    value === undefined ||
    value === 'approved' ||
    value === 'changes-requested' ||
    value === 'commented' ||
    value === 'pending'
  )
}

function ledgerResourceIdentity(
  operation: ReceiptOperation,
  resourceIdentity: string | undefined,
  resourceRevisionIdentity: string | undefined,
): string | undefined {
  if (
    (operation !== 'push' && operation !== 'pr-creation') ||
    resourceIdentity === undefined ||
    resourceRevisionIdentity === undefined
  ) {
    return resourceIdentity
  }
  return `${resourceIdentity}:${resourceRevisionIdentity}`
}

function toLedgerContext(
  operation: ReceiptOperation,
  context: ReceiptOperationContext,
): ReceiptContext {
  const {
    resourceRevisionIdentity: _resourceRevisionIdentity,
    ...ledgerContext
  } = context
  return {
    ...ledgerContext,
    resourceIdentity: ledgerResourceIdentity(
      operation,
      context.resourceIdentity,
      context.resourceRevisionIdentity,
    ),
  }
}

function toLedgerAfter(
  operation: ReceiptOperation,
  after: ReceiptOperationAfter,
): ReceiptObservationAfter {
  const {
    resourceRevisionIdentity: _resourceRevisionIdentity,
    pullRequest: _pullRequest,
    checkState: _checkState,
    reviewDecision: _reviewDecision,
    ...ledgerAfter
  } = after
  return {
    ...ledgerAfter,
    resourceIdentity: ledgerResourceIdentity(
      operation,
      after.resourceIdentity,
      after.resourceRevisionIdentity,
    ),
  }
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
    !hasOnlyFields(
      input,
      new Set(['callId', 'transitionId', 'readback', 'readbacks']),
    ) ||
    !isBoundedString(input.callId) ||
    !isBoundedString(input.transitionId)
  ) {
    return undefined
  }
  if (input.readback !== undefined && input.readbacks !== undefined) {
    return undefined
  }
  const readback =
    input.readback === undefined ? undefined : parseReadback(input.readback)
  if (input.readback !== undefined && !readback) return undefined
  const readbacks =
    input.readbacks === undefined
      ? undefined
      : parseFinalReadbackBundle(input.readbacks)
  if (input.readbacks !== undefined && !readbacks) return undefined
  return {
    callId: input.callId,
    transitionId: input.transitionId,
    ...(readback ? { readback } : {}),
    ...(readbacks ? { readbacks } : {}),
  }
}

function parseFinalReadbackBundle(
  input: unknown,
): readonly ParsedReadback[] | undefined {
  if (!Array.isArray(input) || input.length > MAX_FINAL_READBACKS) {
    return undefined
  }
  const seen = new Set<string>()
  const readbacks: ParsedReadback[] = []
  for (const item of input) {
    const parsed = parseU4Readback(item)
    if (!parsed) return undefined
    const key = parsed.operation ?? 'global'
    if (seen.has(key)) return undefined
    seen.add(key)
    readbacks.push(parsed)
  }
  return readbacks
}

function parseU4Readback(input: unknown): ParsedReadback | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyFields(
      input,
      new Set([
        'operation',
        'workspaceIdentity',
        'repositoryIdentity',
        'worktreeIdentity',
        'resourceIdentity',
        'resourceRevisionIdentity',
        'pullRequest',
        'checkState',
        'reviewDecision',
      ]),
    ) ||
    (input.operation !== undefined && !isOperation(input.operation))
  ) {
    return undefined
  }
  const { operation: _operation, ...afterInput } = input
  const after = parseReceiptOperationAfter(afterInput)
  if (!after) return undefined
  return {
    operation: input.operation,
    workspaceIdentity: after.workspaceIdentity,
    repositoryIdentity: after.repositoryIdentity,
    worktreeIdentity: after.worktreeIdentity,
    resourceIdentity: after.resourceIdentity,
    resourceRevisionIdentity: after.resourceRevisionIdentity,
    pullRequest: after.pullRequest,
    checkState: after.checkState,
    reviewDecision: after.reviewDecision,
  }
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
  if (
    options.classifier !== undefined &&
    (!options.classifier || typeof options.classifier !== 'object')
  ) {
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
  const terminalOperationCalls = new Map<string, ReceiptOperation | undefined>()
  let currentWorkspaceIdentity = options.workspaceIdentity
  let currentRepositoryIdentity = options.repositoryIdentity
  let currentWorktreeIdentity = options.worktreeIdentity
  let currentPullRequestFingerprint: string | undefined
  const currentResourceIdentities = new Map(runtimeScopes)
  const currentResourceRevisionIdentities = new Map<
    ReceiptOperation,
    string | undefined
  >()
  const initialResourceIdentities = new Map(currentResourceIdentities)
  const initialWorkspaceIdentity = currentWorkspaceIdentity
  const initialRepositoryIdentity = currentRepositoryIdentity
  const initialWorktreeIdentity = currentWorktreeIdentity
  const clock = options.clock ?? Date.now
  let recoveryFingerprint: string | undefined

  function currentResource(
    unit: UnitState,
    operation: ReceiptOperation,
  ): string | undefined {
    return (
      unit.resourceScopes.get(operation) ??
      currentResourceIdentities.get(operation)
    )
  }

  function operationUsesResource(operation: ReceiptOperation): boolean {
    return (
      operation === 'push' ||
      operation === 'pr-creation' ||
      operation === 'check-readback' ||
      operation === 'review-readback'
    )
  }

  function stateFingerprint(
    operation: ReceiptOperation,
    state: ReceiptOperationAfter,
  ): string {
    const value = [
      operation,
      state.workspaceIdentity,
      state.repositoryIdentity ?? '-',
      state.worktreeIdentity ?? '-',
      state.resourceIdentity ?? '-',
      state.resourceRevisionIdentity ?? '-',
      state.pullRequest?.identity ?? '-',
      state.pullRequest?.state ?? '-',
      state.checkState ?? '-',
      state.reviewDecision ?? '-',
    ].join('|')
    return options.ledger.digestIdentity('resource', value)
  }

  function operationBeforeReason(
    input: ParsedOperationObservation,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    if (!epoch || input.context.epochId !== epoch.epochId)
      return 'epoch-mismatch'
    if (input.context.unitId !== unit.unitId) return 'unit-mismatch'
    return (
      currentIdentityReason(input.context) ?? resourceBeforeReason(input, unit)
    )
  }

  function currentIdentityReason(
    context: ReceiptOperationContext,
  ): WorkflowReasonCode | undefined {
    if (context.workspaceIdentity !== currentWorkspaceIdentity)
      return 'workspace-mismatch'
    if (context.repositoryIdentity !== currentRepositoryIdentity)
      return 'receipt-mismatch'
    return context.worktreeIdentity !== currentWorktreeIdentity
      ? 'receipt-mismatch'
      : undefined
  }

  function currentOperationContext(): CurrentOperationContext {
    return Object.freeze({
      workspaceIdentity: currentWorkspaceIdentity,
      ...(currentRepositoryIdentity === undefined
        ? {}
        : { repositoryIdentity: currentRepositoryIdentity }),
      ...(currentWorktreeIdentity === undefined
        ? {}
        : { worktreeIdentity: currentWorktreeIdentity }),
    })
  }

  function resourceBeforeReason(
    input: ParsedOperationObservation,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    if (!operationUsesResource(input.operation)) return undefined
    const expected = currentResource(unit, input.operation)
    if (!expected || input.context.resourceIdentity !== expected) {
      return 'resource-mismatch'
    }
    return resourceRevisionBeforeReason(input)
  }

  function resourceRevisionBeforeReason(
    input: ParsedOperationObservation,
  ): WorkflowReasonCode | undefined {
    const expected = currentResourceRevisionIdentities.get(input.operation)
    return expected === undefined ||
      input.context.resourceRevisionIdentity === expected
      ? undefined
      : 'resource-mismatch'
  }

  function operationAfterReason(
    input: ParsedOperationObservation,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    if (!input.after) return 'invalid-receipt'
    if (input.after.workspaceIdentity !== input.context.workspaceIdentity) {
      return 'workspace-mismatch'
    }
    return resourceAfterReason(input, unit)
  }

  function resourceAfterReason(
    input: ParsedOperationObservation,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    if (!operationUsesResource(input.operation)) return undefined
    const expected = currentResource(unit, input.operation)
    if (
      !expected ||
      input.after?.resourceIdentity !== input.context.resourceIdentity ||
      input.after?.resourceIdentity !== expected
    ) {
      return 'resource-mismatch'
    }
    return revisionAfterReason(input)
  }

  function revisionAfterReason(
    input: ParsedOperationObservation,
  ): WorkflowReasonCode | undefined {
    if (!input.after) return 'invalid-receipt'
    const revision = input.after.resourceRevisionIdentity
    if (input.operation === 'push')
      return pushRevisionReason(
        input.context.resourceRevisionIdentity,
        revision,
      )
    if (input.operation === 'pr-creation')
      return prRevisionReason(input.context.resourceRevisionIdentity, revision)
    return revision ? undefined : 'resource-mismatch'
  }

  function pushRevisionReason(
    before: string | undefined,
    after: string | undefined,
  ): WorkflowReasonCode | undefined {
    return before && after && before !== after ? undefined : 'no-op-operation'
  }

  function prRevisionReason(
    before: string | undefined,
    after: string | undefined,
  ): WorkflowReasonCode | undefined {
    return after && (before === undefined || before !== after)
      ? undefined
      : 'no-op-operation'
  }

  interface RevisionChanges {
    changedWorkspace: boolean
    changedRepository: boolean
    changedWorktree: boolean
    changedStableResource: boolean
    changedResourceRevision: boolean
    resourceOperation?: ReceiptOperation
    changedPullRequest: boolean
  }

  function resourceRevisionAffects(
    operation: ReceiptOperation,
    source: ReceiptOperation | undefined,
  ): boolean {
    if (!source) return operationUsesResource(operation)
    if (source === 'push') {
      return operation === 'push' || operationUsesResource(operation)
    }
    if (source === 'pr-creation') {
      return (
        operation === 'pr-creation' ||
        operation === 'check-readback' ||
        operation === 'review-readback'
      )
    }
    if (source === 'check-readback') {
      return operation === 'check-readback' || operation === 'review-readback'
    }
    if (source === 'review-readback') return operation === 'review-readback'
    return false
  }

  function staleForChange(
    operation: ReceiptOperation,
    changes: RevisionChanges,
  ): boolean {
    if (changes.changedWorkspace || changes.changedWorktree) return true
    if (changes.changedRepository) {
      return operation === 'commit' || operationUsesResource(operation)
    }
    if (
      changes.changedStableResource &&
      resourceRevisionAffects(operation, changes.resourceOperation)
    ) {
      return true
    }
    if (
      changes.changedResourceRevision &&
      resourceRevisionAffects(operation, changes.resourceOperation)
    ) {
      return true
    }
    return (
      changes.changedPullRequest &&
      resourceRevisionAffects(operation, 'pr-creation')
    )
  }

  function markStaleReceipts(unit: UnitState, changes: RevisionChanges): void {
    for (const [operation, envelope] of unit.evidence) {
      if (staleForChange(operation, changes)) {
        unit.staleReceiptIds.add(envelope.canonical.receiptId)
      }
    }
  }

  interface ResourceChanges {
    changedStableResource: boolean
    changedResourceRevision: boolean
  }

  function observeResource(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): ResourceChanges {
    if (readback.resourceIdentity === undefined) {
      return { changedStableResource: false, changedResourceRevision: false }
    }
    const changedStableResource = readback.operation
      ? observeOperationResource(readback, unit)
      : observeGlobalResource(readback.resourceIdentity)
    if (
      !readback.operation ||
      readback.resourceRevisionIdentity === undefined
    ) {
      return { changedStableResource, changedResourceRevision: false }
    }
    const previous = currentResourceRevisionIdentities.get(readback.operation)
    const changedResourceRevision =
      previous !== undefined && previous !== readback.resourceRevisionIdentity
    currentResourceRevisionIdentities.set(
      readback.operation,
      readback.resourceRevisionIdentity,
    )
    return { changedStableResource, changedResourceRevision }
  }

  function observeOperationResource(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): boolean {
    if (!readback.operation || !readback.resourceIdentity) return false
    const expected = unit
      ? currentResource(unit, readback.operation)
      : currentResourceIdentities.get(readback.operation)
    const changed = readback.resourceIdentity !== expected
    currentResourceIdentities.set(readback.operation, readback.resourceIdentity)
    if (readback.operation === 'pr-creation' && unit) {
      propagatePullRequestScope(unit, readback.resourceIdentity)
    }
    return changed
  }

  function propagatePullRequestScope(
    unit: UnitState,
    resourceIdentity: string,
  ): void {
    for (const operation of ['check-readback', 'review-readback'] as const) {
      if (
        !unit.resourceScopes.has(operation) &&
        !currentResourceIdentities.has(operation)
      ) {
        currentResourceIdentities.set(operation, resourceIdentity)
      }
    }
  }

  function observeGlobalResource(resourceIdentity: string): boolean {
    let changed = false
    for (const [operation, current] of currentResourceIdentities) {
      changed ||= current !== resourceIdentity
      currentResourceIdentities.set(operation, resourceIdentity)
    }
    return changed
  }

  function observeState(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): boolean {
    if (!unit || !readback.operation || !hasMutableReadbackState(readback))
      return false
    return (
      unit.operationStates.get(readback.operation)?.fingerprint !==
      stateFingerprint(readback.operation, readback)
    )
  }

  function hasMutableReadbackState(readback: ParsedReadback): boolean {
    return (
      readback.checkState !== undefined ||
      readback.reviewDecision !== undefined ||
      readback.pullRequest !== undefined
    )
  }

  function pullRequestFingerprint(
    readback: ParsedReadback,
  ): string | undefined {
    return readback.pullRequest
      ? options.ledger.digestIdentity(
          'resource',
          `${readback.pullRequest.identity}|${readback.pullRequest.state}`,
        )
      : undefined
  }

  function revisionIdentityChanges(readback: ParsedReadback): {
    changedWorkspace: boolean
    changedRepository: boolean
    changedWorktree: boolean
  } {
    return {
      changedWorkspace: readback.workspaceIdentity !== currentWorkspaceIdentity,
      changedRepository:
        readback.repositoryIdentity !== undefined &&
        readback.repositoryIdentity !== currentRepositoryIdentity,
      changedWorktree:
        readback.worktreeIdentity !== undefined &&
        readback.worktreeIdentity !== currentWorktreeIdentity,
    }
  }

  function applyRevisionChanges(
    unit: UnitState | undefined,
    changes: RevisionChanges,
  ): void {
    if (unit) markStaleReceipts(unit, changes)
  }

  function clearRecoveredResourceStale(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): void {
    if (!unit || !readback.operation || readback.resourceIdentity === undefined)
      return
    if (unit.resourceScopes.has(readback.operation)) return
    const envelope = unit.evidence.get(readback.operation)
    if (!envelope) return
    if (!unit.recoveredReceiptIds.has(envelope.canonical.receiptId)) return
    const expected = ledgerResourceIdentity(
      readback.operation,
      readback.resourceIdentity,
      readback.resourceRevisionIdentity,
    )
    if (
      expected &&
      envelope.canonical.resourceDigest ===
        options.ledger.digestIdentity('resource', expected)
    ) {
      unit.staleReceiptIds.delete(envelope.canonical.receiptId)
    }
    const context = unit.ledgerContexts.get(envelope.canonical.receiptId)
    if (context) {
      unit.ledgerContexts.set(envelope.canonical.receiptId, {
        ...context,
        resourceIdentity: expected,
      })
    }
  }

  function clearRecoveredRevisionStale(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): void {
    if (!unit) return
    const expectedRepositoryDigest = readback.repositoryIdentity
      ? options.ledger.digestIdentity('repository', readback.repositoryIdentity)
      : undefined
    const expectedWorktreeDigest = readback.worktreeIdentity
      ? options.ledger.digestIdentity('worktree', readback.worktreeIdentity)
      : undefined
    for (const [operation, envelope] of unit.evidence) {
      if (!unit.recoveredReceiptIds.has(envelope.canonical.receiptId)) continue
      if (
        envelope.canonical.repositoryDigest === expectedRepositoryDigest &&
        envelope.canonical.worktreeDigest === expectedWorktreeDigest
      ) {
        unit.staleReceiptIds.delete(envelope.canonical.receiptId)
        clearIssue(unit, operation)
      }
    }
  }

  function updateCurrentIdentities(
    readback: ParsedReadback,
    nextPullRequestFingerprint: string | undefined,
  ): void {
    currentWorkspaceIdentity = readback.workspaceIdentity
    if (readback.repositoryIdentity !== undefined) {
      currentRepositoryIdentity = readback.repositoryIdentity
    }
    if (readback.worktreeIdentity !== undefined) {
      currentWorktreeIdentity = readback.worktreeIdentity
    }
    if (nextPullRequestFingerprint !== undefined) {
      currentPullRequestFingerprint = nextPullRequestFingerprint
    }
  }

  function storeOperationState(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): void {
    if (unit && readback.operation) {
      unit.operationStates.set(readback.operation, {
        fingerprint: stateFingerprint(readback.operation, readback),
      })
    }
  }

  function pullRequestChanged(next: string | undefined): boolean {
    return (
      next !== undefined &&
      currentPullRequestFingerprint !== undefined &&
      next !== currentPullRequestFingerprint
    )
  }

  function observeRevision(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): ReadbackObservationResult {
    const identityChanges = revisionIdentityChanges(readback)
    const resourceChanges = observeResource(readback, unit)
    const changedState = observeState(readback, unit)
    const nextPullRequestFingerprint = pullRequestFingerprint(readback)
    const changedPullRequest = pullRequestChanged(nextPullRequestFingerprint)
    applyRevisionChanges(unit, {
      ...identityChanges,
      changedStableResource: resourceChanges.changedStableResource,
      changedResourceRevision:
        resourceChanges.changedResourceRevision || changedState,
      resourceOperation: readback.operation,
      changedPullRequest,
    })
    clearRecoveredResourceStale(readback, unit)
    clearRecoveredRevisionStale(readback, unit)
    updateCurrentIdentities(readback, nextPullRequestFingerprint)
    storeOperationState(readback, unit)
    return {
      status: 'accepted',
      changed:
        identityChanges.changedWorkspace ||
        identityChanges.changedRepository ||
        identityChanges.changedWorktree ||
        resourceChanges.changedStableResource ||
        resourceChanges.changedResourceRevision ||
        changedState,
    }
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
    if (reasonCode === 'consumed-receipt') return ['fresh-readback']
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
    const historicalImplementation =
      envelope.canonical.operation === 'implementation' &&
      unit.evidence.get('implementation')?.canonical.receiptId ===
        envelope.canonical.receiptId
    if (!historicalImplementation) {
      if (
        envelope.canonical.workspaceDigest !==
        options.ledger.digestIdentity('workspace', currentWorkspaceIdentity)
      ) {
        return 'workspace-mismatch'
      }
    }
    return compareReceiptResources(envelope, unit)
  }

  function compareReceiptResources(
    envelope: ReceiptEnvelope,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    const scopeReason = compareReceiptRepositoryScope(envelope)
    if (scopeReason) return scopeReason
    return compareReceiptResourceDigest(envelope, unit)
  }

  function compareReceiptRepositoryScope(
    envelope: ReceiptEnvelope,
  ): WorkflowReasonCode | undefined {
    const operation = envelope.canonical.operation
    const expectedRepository = currentRepositoryIdentity
      ? options.ledger.digestIdentity('repository', currentRepositoryIdentity)
      : undefined
    if (
      operation !== 'implementation' &&
      operation !== 'verification' &&
      envelope.canonical.repositoryDigest !== expectedRepository
    ) {
      return 'receipt-mismatch'
    }
    const expectedWorktree = currentWorktreeIdentity
      ? options.ledger.digestIdentity('worktree', currentWorktreeIdentity)
      : undefined
    return operation !== 'implementation' &&
      envelope.canonical.worktreeDigest !== expectedWorktree
      ? 'receipt-mismatch'
      : undefined
  }

  function compareReceiptResourceDigest(
    envelope: ReceiptEnvelope,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    const resourceIdentity = currentResource(unit, envelope.canonical.operation)
    if (!resourceIdentity) {
      return envelope.canonical.resourceDigest === undefined
        ? undefined
        : 'resource-mismatch'
    }
    const expectedResource = ledgerResourceIdentity(
      envelope.canonical.operation,
      resourceIdentity,
      currentResourceRevisionIdentities.get(envelope.canonical.operation),
    )
    if (!expectedResource) return 'resource-mismatch'
    return envelope.canonical.resourceDigest ===
      options.ledger.digestIdentity('resource', expectedResource)
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
    if (unit.staleReceiptIds.has(envelope.canonical.receiptId)) {
      return { operation, reasonCode: 'stale-receipt' }
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
    envelope: ReceiptEnvelope,
  ): {
    epochId: string
    unitId: string
    workspaceIdentity: string
    repositoryIdentity?: string
    worktreeIdentity?: string
    resourceIdentity?: string
  } {
    const storedContext = unit.ledgerContexts.get(envelope.canonical.receiptId)
    if (storedContext) return storedContext
    if (!epoch) throw new Error('missing-epoch')
    return {
      epochId: epoch.epochId,
      unitId: unit.unitId,
      workspaceIdentity: currentWorkspaceIdentity,
      repositoryIdentity: currentRepositoryIdentity,
      worktreeIdentity: currentWorktreeIdentity,
      resourceIdentity: ledgerResourceIdentity(
        operation,
        currentResource(unit, operation),
        currentResourceRevisionIdentities.get(operation),
      ),
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
        consumeContext(epoch.unit, envelope.canonical.operation, envelope),
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

  function operationReadback(
    operation: ReceiptOperation,
    after: ReceiptOperationAfter,
  ): ParsedReadback {
    return {
      operation,
      workspaceIdentity: after.workspaceIdentity,
      repositoryIdentity: after.repositoryIdentity,
      worktreeIdentity: after.worktreeIdentity,
      resourceIdentity: after.resourceIdentity,
      resourceRevisionIdentity: after.resourceRevisionIdentity,
      pullRequest: after.pullRequest,
      checkState: after.checkState,
      reviewDecision: after.reviewDecision,
    }
  }

  function operationFailureReason(
    classification: ReceiptClassification,
  ): WorkflowReasonCode {
    switch (classification.reasonCode) {
      case 'terminal-cancelled':
        return 'cancelled-operation'
      case 'terminal-failure':
        return 'failed-operation'
      case 'terminal-running':
        return 'running-operation'
      case 'successful-no-op':
      case 'unchanged-worktree':
      case 'no-op-resource':
        return 'no-op-operation'
      case 'parser-asset-unavailable':
      case 'grammar-incompatible':
      case 'parser-failure':
        return 'guard-unavailable'
      case 'workspace-mismatch':
        return 'workspace-mismatch'
      case 'cross-registration-disputed':
        return 'foreign-registration'
      default:
        return classification.outcome === 'unavailable'
          ? 'guard-unavailable'
          : 'rejected-operation'
    }
  }

  function markTerminalOperation(
    parsed: ParsedOperationObservation | undefined,
    input: unknown,
  ): void {
    if (parsed) {
      terminalOperationCalls.set(
        options.ledger.digestIdentity('call', parsed.callId),
        parsed.operation,
      )
      return
    }
    if (!isRecord(input) || !isBoundedString(input.callId)) return
    terminalOperationCalls.set(
      options.ledger.digestIdentity('call', input.callId),
      isOperation(input.operation) ? input.operation : undefined,
    )
  }

  function terminalOperationResult(
    input: unknown,
  ): EvidenceObservationResult | undefined {
    if (!isRecord(input) || !isBoundedString(input.callId)) return undefined
    const callDigest = options.ledger.digestIdentity('call', input.callId)
    const existing = terminalOperationCalls.get(callDigest)
    if (existing === undefined && !terminalOperationCalls.has(callDigest)) {
      return undefined
    }
    if (
      existing !== undefined &&
      isOperation(input.operation) &&
      existing !== input.operation
    ) {
      return { status: 'rejected', reasonCode: 'call-context-conflict' }
    }
    return { status: 'rejected', reasonCode: 'rejected-operation' }
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
    existingScopes?: ReadonlyMap<ReceiptOperation, string>,
  ): ReadonlyMap<ReceiptOperation, string> | undefined {
    const result = new Map(existingScopes ?? runtimeScopes)
    const scopesToMerge = existingScopes
      ? [runtimeScopes, trustedPolicy.resourceScopes, modelScopes]
      : [trustedPolicy.resourceScopes, modelScopes]
    for (const scopes of scopesToMerge) {
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
    existingOperations: readonly ReceiptOperation[] = [],
  ): readonly ReceiptOperation[] {
    return Object.freeze([
      ...new Set([
        ...MANDATORY_OPERATIONS,
        ...runtimeRequired,
        ...existingOperations,
        ...trustedPolicy.expectedOperations,
        ...model.expectedOperations,
        ...resourceScopes.keys(),
      ]),
    ])
  }

  function resourceIdentitiesMatchUnit(unit: UnitState): boolean {
    const expected = new Map(runtimeScopes)
    for (const [operation, resource] of unit.resourceScopes) {
      expected.set(operation, resource)
    }
    if (currentResourceIdentities.size !== expected.size) return false
    for (const [operation, resource] of expected) {
      if (currentResourceIdentities.get(operation) !== resource) return false
    }
    return true
  }

  function pristineActiveUnit(unit: UnitState): boolean {
    return (
      unit.evidence.size === 0 &&
      unit.issues.size === 0 &&
      unit.staleReceiptIds.size === 0 &&
      unit.recoveredReceiptIds.size === 0 &&
      unit.operationStates.size === 0 &&
      unit.ledgerContexts.size === 0 &&
      globalIssue === undefined &&
      transitionsByCall.size === 0 &&
      terminalOperationCalls.size === 0 &&
      currentResourceRevisionIdentities.size === 0 &&
      currentPullRequestFingerprint === undefined &&
      currentWorkspaceIdentity === initialWorkspaceIdentity &&
      currentRepositoryIdentity === initialRepositoryIdentity &&
      currentWorktreeIdentity === initialWorktreeIdentity &&
      resourceIdentitiesMatchUnit(unit)
    )
  }

  function declarationChanged(
    unit: UnitState,
    requiredOperations: readonly ReceiptOperation[],
    resourceScopes: ReadonlyMap<ReceiptOperation, string>,
  ): boolean {
    if (
      JSON.stringify(unit.requiredOperations) !==
      JSON.stringify(requiredOperations)
    ) {
      return true
    }
    if (unit.resourceScopes.size !== resourceScopes.size) return true
    for (const [operation, resource] of resourceScopes) {
      if (unit.resourceScopes.get(operation) !== resource) return true
    }
    return false
  }

  function startActiveUnit(
    parsed: ParsedUnitRequest,
    trustedPolicy: ParsedUnitRequest,
    unit: UnitState,
  ): StartUnitResult {
    if (!pristineActiveUnit(unit)) {
      return { status: 'rejected', reasonCode: 'unit-active' }
    }
    const resourceScopes = mergeResourceScopes(
      trustedPolicy,
      parsed.resourceScopes,
      unit.resourceScopes,
    )
    if (!resourceScopes) {
      return { status: 'rejected', reasonCode: 'runtime-scope-conflict' }
    }
    const requiredOperations = requiredOperationsFor(
      trustedPolicy,
      parsed,
      resourceScopes,
      unit.requiredOperations,
    )
    if (!declarationChanged(unit, requiredOperations, resourceScopes)) {
      return { status: 'rejected', reasonCode: 'unit-active' }
    }
    unit.requiredOperations = requiredOperations
    unit.declaredResourceOperations = Object.freeze([...resourceScopes.keys()])
    unit.resourceScopes = resourceScopes
    for (const [operation, resource] of resourceScopes) {
      currentResourceIdentities.set(operation, resource)
    }
    return { status: 'started', unit: cloneUnit(unit) }
  }

  function startParsedUnit(
    parsed: ParsedUnitRequest,
    trustedPolicy: ParsedUnitRequest,
  ): StartUnitResult {
    if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
    if (epoch.unit?.status === 'active') {
      return startActiveUnit(parsed, trustedPolicy, epoch.unit)
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
    currentResourceIdentities.clear()
    for (const [operation, resource] of resourceScopes) {
      currentResourceIdentities.set(operation, resource)
    }
    currentResourceRevisionIdentities.clear()
    currentPullRequestFingerprint = undefined
    epoch.unit = {
      unitId: randomId(),
      status: 'active',
      requiredOperations,
      declaredResourceOperations: Object.freeze([...resourceScopes.keys()]),
      resourceScopes,
      evidence: new Map(),
      issues: new Map(),
      staleReceiptIds: new Set(),
      recoveredReceiptIds: new Set(),
      operationStates: new Map(),
      ledgerContexts: new Map(),
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

  async function processOperation(
    input: unknown,
    parsed: ParsedOperationObservation,
    unit: UnitState,
    trustedClassification?: ReceiptClassification,
  ): Promise<EvidenceObservationResult> {
    if (!unit.requiredOperations.includes(parsed.operation)) {
      markTerminalOperation(parsed, input)
      return { status: 'rejected', reasonCode: 'operation-not-required' }
    }
    const beforeReason = operationBeforeReason(parsed, unit)
    if (beforeReason)
      return rejectParsedOperation(parsed, input, unit, beforeReason)
    const afterReason = operationAfterReason(parsed, unit)
    if (afterReason)
      return rejectParsedOperation(parsed, input, unit, afterReason)
    const prepared = options.ledger.prepareObservation({
      callId: parsed.callId,
      operation: parsed.operation,
      context: toLedgerContext(parsed.operation, parsed.context),
    })
    if (prepared.status !== 'prepared') {
      return prepared.reasonCode === 'call-context-conflict'
        ? { status: 'rejected', reasonCode: 'call-context-conflict' }
        : { status: 'rejected', reasonCode: 'rejected-operation' }
    }
    const classification =
      trustedClassification ??
      (await classifyPreparedOperation(parsed, input, unit))
    return classification
      ? finalizeOperation(parsed, input, unit, classification)
      : { status: 'rejected', reasonCode: 'guard-unavailable' }
  }

  function rejectParsedOperation(
    parsed: ParsedOperationObservation,
    input: unknown,
    unit: UnitState,
    reasonCode: WorkflowReasonCode,
  ): EvidenceObservationResult {
    markTerminalOperation(parsed, input)
    return recordUnitEvidenceIssue(unit, parsed.operation, reasonCode)
  }

  async function classifyPreparedOperation(
    parsed: ParsedOperationObservation,
    input: unknown,
    unit: UnitState,
  ): Promise<ReceiptClassification | undefined> {
    const classifyOperation = options.classifier?.classifyOperation
    if (!classifyOperation) {
      abandonPreparedOperation(parsed)
      markTerminalOperation(parsed, input)
      recordUnitEvidenceIssue(unit, parsed.operation, 'guard-unavailable')
      return undefined
    }
    try {
      return await classifyOperation(input)
    } catch {
      abandonPreparedOperation(parsed)
      markTerminalOperation(parsed, input)
      recordUnitEvidenceIssue(unit, parsed.operation, 'guard-unavailable')
      return undefined
    }
  }

  function abandonPreparedOperation(parsed: ParsedOperationObservation): void {
    options.ledger.abandonObservation({
      callId: parsed.callId,
      context: toLedgerContext(parsed.operation, parsed.context),
    })
  }

  function finalizeOperation(
    parsed: ParsedOperationObservation,
    input: unknown,
    unit: UnitState,
    classification: ReceiptClassification,
  ): EvidenceObservationResult {
    if (!parsed.after) {
      abandonPreparedOperation(parsed)
      markTerminalOperation(parsed, input)
      return recordUnitEvidenceIssue(unit, parsed.operation, 'invalid-receipt')
    }
    const finalized = options.ledger.finalizeObservation({
      callId: parsed.callId,
      context: toLedgerContext(parsed.operation, parsed.context),
      after: toLedgerAfter(parsed.operation, parsed.after),
      classification,
      terminal: parsed.terminal,
    })
    if (finalized.status !== 'finalized') {
      markTerminalOperation(parsed, input)
      return recordUnitEvidenceIssue(
        unit,
        parsed.operation,
        operationFailureReason(classification),
      )
    }
    storeOperationLedgerContext(parsed, finalized.receipt, unit)
    observeRevision(operationReadback(parsed.operation, parsed.after), unit)
    markTerminalOperation(parsed, input)
    return observeReceiptForUnit(finalized.receipt, unit)
  }

  function storeOperationLedgerContext(
    parsed: ParsedOperationObservation,
    envelope: ReceiptEnvelope,
    unit: UnitState,
  ): void {
    if (!parsed.after) return
    unit.ledgerContexts.set(
      envelope.canonical.receiptId,
      toLedgerContext(parsed.operation, {
        ...parsed.context,
        workspaceIdentity: parsed.after.workspaceIdentity,
        repositoryIdentity: parsed.after.repositoryIdentity,
        worktreeIdentity: parsed.after.worktreeIdentity,
        resourceIdentity: parsed.after.resourceIdentity,
        resourceRevisionIdentity: parsed.after.resourceRevisionIdentity,
      }),
    )
  }

  function requiresFreshFinalReadbacks(unit: UnitState): boolean {
    return unit.ledgerContexts.size > 0
  }

  function finalReadbackReason(
    parsed: ParsedFinalization,
    unit: UnitState | undefined,
  ): WorkflowReasonCode | undefined {
    if (!unit || !requiresFreshFinalReadbacks(unit)) {
      return parsed.readback
        ? observeFinalReadback(parsed.readback, unit)
        : undefined
    }
    if (!parsed.readbacks) return 'missing-evidence'
    const coverageReason = validateFinalReadbackCoverage(parsed.readbacks, unit)
    if (coverageReason) return coverageReason
    return applyFinalReadbackBundle(parsed.readbacks, unit)
  }

  function validateFinalReadbackCoverage(
    readbacks: readonly ParsedReadback[],
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    const global = readbacks.find((readback) => !readback.operation)
    if (!global?.repositoryIdentity || !global.worktreeIdentity) {
      return 'invalid-receipt'
    }
    const required = RESOURCE_FINAL_READBACK_OPERATIONS.filter((operation) =>
      unit.evidence.has(operation),
    )
    for (const operation of required) {
      const readback = readbacks.find((item) => item.operation === operation)
      const reason = validateResourceFinalReadback(readback, global, unit)
      if (reason) return reason
    }
    return undefined
  }

  function validateResourceFinalReadback(
    readback: ParsedReadback | undefined,
    global: ParsedReadback,
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    if (!readback?.operation) return 'missing-evidence'
    if (!sameRevisionScope(readback, global)) return 'workspace-mismatch'
    const expected = currentResource(unit, readback.operation)
    return readback.resourceIdentity === expected
      ? undefined
      : 'resource-mismatch'
  }

  function sameRevisionScope(
    readback: ParsedReadback,
    global: ParsedReadback,
  ): boolean {
    return (
      readback.workspaceIdentity === global.workspaceIdentity &&
      readback.repositoryIdentity === global.repositoryIdentity &&
      readback.worktreeIdentity === global.worktreeIdentity
    )
  }

  function applyFinalReadbackBundle(
    readbacks: readonly ParsedReadback[],
    unit: UnitState,
  ): WorkflowReasonCode | undefined {
    const global = readbacks.find((readback) => !readback.operation)
    if (!global) return 'invalid-receipt'
    const globalReason = observeFinalReadback(global, unit)
    if (globalReason) return globalReason
    for (const readback of readbacks) {
      if (readback.operation) {
        const reason = observeFinalReadback(readback, unit)
        if (reason) return reason
      }
    }
    return undefined
  }

  function observeFinalReadback(
    readback: ParsedReadback,
    unit: UnitState | undefined,
  ): WorkflowReasonCode | undefined {
    const result = observeRevision(readback, unit)
    return result.status === 'rejected' ? result.reasonCode : undefined
  }

  function finalizeTransitionCall(
    parsed: ParsedFinalization,
    lifecycle: PreparedTransition,
  ): TransitionFinalizeResult {
    if (lifecycle.state === 'abandoned') {
      return { status: 'rejected', reasonCode: 'abandoned-transition' }
    }
    if (lifecycle.state === 'terminal' && lifecycle.terminalResult) {
      return lifecycle.terminalResult.status === 'completed'
        ? {
            status: 'duplicate',
            target: lifecycle.terminalResult.target,
            transitionId: lifecycle.terminalResult.transitionId,
          }
        : lifecycle.terminalResult
    }
    const readbackReason = finalReadbackReason(parsed, epoch?.unit)
    if (readbackReason) {
      return terminalizeTransition(lifecycle, {
        status: 'rejected',
        reasonCode: readbackReason,
      })
    }
    const decision = transitionDecision(lifecycle.target)
    if (!decision.ready) {
      return terminalizeTransition(lifecycle, {
        status: decision.status,
        reasonCode: decision.reasonCode,
      })
    }
    return terminalizeTransition(
      lifecycle,
      finalizePrepared(lifecycle, decision),
    )
  }

  function terminalizeTransition(
    lifecycle: PreparedTransition,
    result: TransitionFinalizeResult,
  ): TransitionFinalizeResult {
    lifecycle.state = 'terminal'
    lifecycle.terminalResult = result
    return result
  }

  function isFreshForRecovery(): boolean {
    if (
      epoch ||
      globalIssue ||
      transitionsByCall.size > 0 ||
      terminalOperationCalls.size > 0 ||
      currentResourceRevisionIdentities.size > 0 ||
      currentPullRequestFingerprint !== undefined ||
      currentWorkspaceIdentity !== initialWorkspaceIdentity ||
      currentRepositoryIdentity !== initialRepositoryIdentity ||
      currentWorktreeIdentity !== initialWorktreeIdentity ||
      currentResourceIdentities.size !== initialResourceIdentities.size
    ) {
      return false
    }
    for (const [operation, resource] of initialResourceIdentities) {
      if (currentResourceIdentities.get(operation) !== resource) return false
    }
    return true
  }

  function recoveryProgressionReason(
    state: ParsedRecoveryState,
  ): WorkflowReasonCode | undefined {
    const progression = state.progression
    const current = options.ledger.getProgressionState()
    if (JSON.stringify(current) !== JSON.stringify(progression))
      return 'invalid-recovery'
    if (!progression.epoch) return 'invalid-recovery'
    if (
      progression.epoch.epochDigest !==
      options.ledger.digestIdentity('epoch', progression.epoch.epochId)
    ) {
      return 'invalid-recovery'
    }
    return recoveryUnitProgressionReason(progression)
  }

  function recoveryUnitProgressionReason(
    progression: ReceiptReadbackProgression,
  ): WorkflowReasonCode | undefined {
    const epoch = progression.epoch
    const unit = progression.unit
    if (!epoch) return 'invalid-recovery'
    if (!unit) {
      return epoch.state === 'completed' ? 'invalid-recovery' : undefined
    }
    const declarationFailure = recoveryUnitDeclarationReason(epoch, unit)
    if (declarationFailure) return declarationFailure
    return unit.resourceScopes.some(
      (scope) => !unit.requiredOperations.includes(scope.operation),
    )
      ? 'invalid-recovery'
      : recoveryCompletedPairReason(epoch, unit)
  }

  function recoveryUnitDeclarationReason(
    epoch: ReceiptEpochProgressionSnapshot,
    unit: ReceiptUnitProgressionSnapshot,
  ): WorkflowReasonCode | undefined {
    return unit.epochId === epoch.epochId &&
      unit.epochDigest === epoch.epochDigest &&
      unit.unitDigest === options.ledger.digestIdentity('unit', unit.unitId) &&
      unit.family === epoch.family
      ? undefined
      : 'invalid-recovery'
  }

  function recoveryCompletedPairReason(
    epoch: ReceiptEpochProgressionSnapshot,
    unit: ReceiptUnitProgressionSnapshot,
  ): WorkflowReasonCode | undefined {
    return epoch.state === 'completed' && unit.state !== 'completed'
      ? 'invalid-recovery'
      : undefined
  }

  function recoveryBoundaryReason(
    envelope: ReceiptEnvelope,
  ): WorkflowReasonCode | undefined {
    if (
      envelope.canonical.workspaceDigest !==
      options.ledger.digestIdentity('workspace', currentWorkspaceIdentity)
    ) {
      return 'workspace-mismatch'
    }
    return undefined
  }

  function resourceScopeMatches(
    operation: ReceiptOperation,
    persisted: string,
    trusted: string,
  ): boolean {
    return (
      persisted === trusted ||
      persisted === options.ledger.digestIdentity('resource', trusted) ||
      persisted ===
        options.ledger.digestIdentity(
          'resource',
          ledgerResourceIdentity(
            operation,
            trusted,
            currentResourceRevisionIdentities.get(operation),
          ) ?? trusted,
        )
    )
  }

  function recoveryResourceIdentities(progression: ReceiptReadbackProgression):
    | {
        resourceScopes: Map<ReceiptOperation, string>
        current: Map<ReceiptOperation, string>
      }
    | undefined {
    const current = new Map(initialResourceIdentities)
    const resourceScopes = new Map<ReceiptOperation, string>()
    const unit = progression.unit
    if (!unit) return { resourceScopes, current }
    for (const scope of unit.resourceScopes) {
      const trusted = current.get(scope.operation)
      if (!trusted) continue
      if (
        !resourceScopeMatches(scope.operation, scope.resourceIdentity, trusted)
      )
        return undefined
      resourceScopes.set(scope.operation, trusted)
      current.set(scope.operation, trusted)
    }
    return { resourceScopes, current }
  }

  function recoveryContext(
    progression: ReceiptReadbackProgression,
    envelope: ReceiptEnvelope,
    resourceScopes: ReadonlyMap<ReceiptOperation, string>,
  ): ReceiptContext {
    const epochState = progression.epoch
    const unitState = progression.unit
    return {
      epochId: epochState?.epochId ?? '',
      unitId: unitState?.unitId ?? '',
      workspaceIdentity: currentWorkspaceIdentity,
      repositoryIdentity: currentRepositoryIdentity,
      worktreeIdentity: currentWorktreeIdentity,
      resourceIdentity: resourceScopes.get(envelope.canonical.operation),
    }
  }

  function recoveryReceiptSet(state: ParsedRecoveryState):
    | {
        receipts: readonly ReceiptEnvelope[]
        matching: readonly ReceiptEnvelope[]
      }
    | undefined {
    const ledgerReceipts = options.ledger.listReceipts()
    const byId = new Map(
      ledgerReceipts.map((envelope) => [
        envelope.canonical.receiptId,
        envelope,
      ]),
    )
    const stateReceipts = recoveryStateReceipts(state.receipts, byId)
    if (!stateReceipts) return undefined
    const progression = state.progression
    if (!progression.epoch) return undefined
    const matching = ledgerReceipts.filter(
      (envelope) =>
        envelope.canonical.epochDigest === progression.epoch?.epochDigest &&
        (progression.unit === null ||
          envelope.canonical.unitDigest === progression.unit.unitDigest),
    )
    return matching.every((envelope) =>
      stateReceipts.ids.has(envelope.canonical.receiptId),
    )
      ? { receipts: stateReceipts.receipts, matching }
      : undefined
  }

  function recoveryStateReceipts(
    inputs: readonly unknown[],
    byId: ReadonlyMap<string, ReceiptEnvelope>,
  ):
    | { receipts: readonly ReceiptEnvelope[]; ids: ReadonlySet<string> }
    | undefined {
    const receipts: ReceiptEnvelope[] = []
    const ids = new Set<string>()
    for (const input of inputs) {
      const validation = options.ledger.validateEnvelope(input)
      if (validation.compatibility !== 'compatible') return undefined
      const envelope = byId.get(validation.envelope.canonical.receiptId)
      if (
        !envelope ||
        JSON.stringify(envelope) !== JSON.stringify(validation.envelope)
      )
        return undefined
      if (ids.has(envelope.canonical.receiptId)) return undefined
      ids.add(envelope.canonical.receiptId)
      receipts.push(envelope)
    }
    return { receipts, ids }
  }

  function recoveryCompletionReason(
    progression: ReceiptReadbackProgression,
    matching: readonly ReceiptEnvelope[],
  ): WorkflowReasonCode | undefined {
    return (
      recoveryUnitCompletionReason(progression.unit, matching) ??
      recoveryEpochCompletionReason(progression.epoch, matching)
    )
  }

  function recoveryUnitCompletionReason(
    unit: ReceiptUnitProgressionSnapshot | null,
    matching: readonly ReceiptEnvelope[],
  ): WorkflowReasonCode | undefined {
    if (unit?.state !== 'completed') return undefined
    for (const operation of unit.requiredOperations) {
      const receipts = matching.filter(
        (envelope) => envelope.canonical.operation === operation,
      )
      if (
        receipts.length === 0 ||
        receipts.some(
          (envelope) => envelope.canonical.consumption !== 'consumed',
        )
      ) {
        return 'invalid-recovery'
      }
    }
    return undefined
  }

  function recoveryEpochCompletionReason(
    epoch: ReceiptEpochProgressionSnapshot | null,
    matching: readonly ReceiptEnvelope[],
  ): WorkflowReasonCode | undefined {
    if (epoch?.state !== 'completed') return undefined
    return matching.length > 0 &&
      matching.every(
        (envelope) => envelope.canonical.consumption === 'consumed',
      )
      ? undefined
      : 'invalid-recovery'
  }

  function buildRecoveryCandidate(
    state: ParsedRecoveryState,
  ): RecoveryCandidate | WorkflowRecoveryResult {
    if (state.registrationDigest !== options.ledger.metadata.registrationDigest)
      return { status: 'rejected', reasonCode: 'foreign-registration' }
    const progressionFailure = recoveryProgressionReason(state)
    if (progressionFailure)
      return { status: 'rejected', reasonCode: progressionFailure }
    const parts = validateRecoveryParts(state)
    if ('status' in parts) return parts

    const progression = state.progression
    if (!progression.epoch)
      return { status: 'rejected', reasonCode: 'invalid-recovery' }
    const recoveredUnit = progression.unit
      ? recoveredUnitState(
          progression,
          parts.receiptSet.matching,
          parts.resources.resourceScopes,
        )
      : undefined
    const recoveredEpoch: EpochState = {
      epochId: progression.epoch.epochId,
      family: progression.epoch.family,
      status: progression.epoch.state === 'completed' ? 'completed' : 'active',
      unit: recoveredUnit,
    }
    return {
      epoch: recoveredEpoch,
      resourceIdentities: parts.resources.current,
      fingerprint: JSON.stringify({
        registrationDigest: state.registrationDigest,
        receipts: parts.receiptSet.receipts,
        progression,
      }),
    }
  }

  function validateRecoveryParts(
    state: ParsedRecoveryState,
  ): RecoveryParts | WorkflowRecoveryResult {
    const resources = recoveryResourceIdentities(state.progression)
    if (!resources)
      return { status: 'rejected', reasonCode: 'resource-mismatch' }
    const receiptSet = recoveryReceiptSet(state)
    if (!receiptSet)
      return { status: 'rejected', reasonCode: 'invalid-recovery' }
    const boundaryFailure = receiptSet.matching
      .map(recoveryBoundaryReason)
      .find((reason): reason is WorkflowReasonCode => reason !== undefined)
    if (boundaryFailure)
      return { status: 'rejected', reasonCode: boundaryFailure }
    const completionFailure = recoveryCompletionReason(
      state.progression,
      receiptSet.matching,
    )
    if (completionFailure)
      return { status: 'rejected', reasonCode: completionFailure }
    return { resources, receiptSet }
  }

  function recoveredUnitState(
    progression: ReceiptReadbackProgression,
    matching: readonly ReceiptEnvelope[],
    resourceScopes: ReadonlyMap<ReceiptOperation, string>,
  ): UnitState | undefined {
    const snapshot = progression.unit
    if (!snapshot) return undefined
    const unit: UnitState = {
      unitId: snapshot.unitId,
      status: snapshot.state === 'completed' ? 'completed' : 'active',
      requiredOperations: Object.freeze([...snapshot.requiredOperations]),
      declaredResourceOperations: Object.freeze(
        snapshot.resourceScopes.map((scope) => scope.operation),
      ),
      resourceScopes: new Map(resourceScopes),
      evidence: new Map(),
      issues: new Map(),
      staleReceiptIds: new Set(),
      recoveredReceiptIds: new Set(
        matching.map((envelope) => envelope.canonical.receiptId),
      ),
      operationStates: new Map(),
      ledgerContexts: new Map(),
    }
    for (const envelope of matching) {
      if (!unit.requiredOperations.includes(envelope.canonical.operation))
        continue
      unit.evidence.set(envelope.canonical.operation, envelope)
      unit.ledgerContexts.set(
        envelope.canonical.receiptId,
        recoveryContext(progression, envelope, resourceScopes),
      )
      if (
        unit.status === 'active' &&
        envelope.canonical.consumption === 'consumed'
      ) {
        unit.evidence.delete(envelope.canonical.operation)
        unit.issues.set(envelope.canonical.operation, {
          kind: 'rejected',
          reasonCode: 'consumed-receipt',
          repair: repairFor(envelope.canonical.operation, 'consumed-receipt'),
        })
      }
    }
    return unit
  }

  function duplicateRecovery(
    state: ParsedRecoveryState,
  ): WorkflowRecoveryResult | undefined {
    if (recoveryFingerprint === undefined) return undefined
    const repeated = buildRecoveryCandidate(state)
    if (
      !('status' in repeated) &&
      repeated.fingerprint === recoveryFingerprint
    ) {
      return {
        status: 'duplicate',
        provenance: 'restart',
        epoch: cloneEpoch(repeated.epoch),
        unit: repeated.epoch.unit ? cloneUnit(repeated.epoch.unit) : null,
      }
    }
    return { status: 'rejected', reasonCode: 'recovery-conflict' }
  }

  function commitRecovery(
    candidate: RecoveryCandidate,
  ): WorkflowRecoveryResult {
    epoch = candidate.epoch
    globalIssue = undefined
    currentResourceIdentities.clear()
    for (const [operation, resource] of candidate.resourceIdentities) {
      currentResourceIdentities.set(operation, resource)
    }
    currentResourceRevisionIdentities.clear()
    currentPullRequestFingerprint = undefined
    recoveryFingerprint = candidate.fingerprint
    return {
      status: 'restored',
      provenance: 'restart',
      epoch: cloneEpoch(candidate.epoch),
      unit: candidate.epoch.unit ? cloneUnit(candidate.epoch.unit) : null,
    }
  }

  function restore(input: unknown): WorkflowRecoveryResult {
    if (mode === 'disabled')
      return { status: 'rejected', reasonCode: 'disabled' }
    if (mode === 'unavailable')
      return { status: 'rejected', reasonCode: 'guard-unavailable' }
    const parsed = parseRecoveryInput(input)
    if (!parsed) return { status: 'rejected', reasonCode: 'invalid-recovery' }
    if (parsed.provenance === 'fork-copy')
      return { status: 'rejected', reasonCode: 'fork-copy-not-lineage' }
    const duplicate = duplicateRecovery(parsed.state)
    if (duplicate) return duplicate
    if (!isFreshForRecovery())
      return { status: 'rejected', reasonCode: 'recovery-conflict' }
    const candidate = buildRecoveryCandidate(parsed.state)
    if ('status' in candidate) return candidate
    return commitRecovery(candidate)
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

    async observeOperation(input: unknown): Promise<EvidenceObservationResult> {
      const modeResult = evidenceModeResult()
      if (modeResult) return modeResult
      if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
      if (!epoch.unit)
        return { status: 'rejected', reasonCode: 'no-active-unit' }
      if (epoch.unit.status === 'completed') {
        return { status: 'rejected', reasonCode: 'unit-completed' }
      }

      const terminalResult = terminalOperationResult(input)
      if (terminalResult) return terminalResult

      const parsed = parseReceiptOperationObservation(input)
      if (!parsed) {
        markTerminalOperation(undefined, input)
        return recordGlobalEvidenceIssue('invalid-receipt')
      }
      return processOperation(input, parsed, epoch.unit)
    },

    /**
     * Trusted host-recovery callers have already validated lineage, ownership,
     * seed/readback integrity, stable workspace, and current mutable revisions.
     * Keep this path internal and do not expose it as a host/model tool.
     */
    async observeTrustedRecoveredOperation(
      input: unknown,
    ): Promise<EvidenceObservationResult> {
      const modeResult = evidenceModeResult()
      if (modeResult) return modeResult
      if (!epoch) return { status: 'rejected', reasonCode: 'no-active-epoch' }
      if (!epoch.unit)
        return { status: 'rejected', reasonCode: 'no-active-unit' }
      if (epoch.unit.status === 'completed') {
        return { status: 'rejected', reasonCode: 'unit-completed' }
      }

      const terminalResult = terminalOperationResult(input)
      if (terminalResult) return terminalResult

      const parsed = parseReceiptOperationObservation(input)
      if (!parsed) {
        markTerminalOperation(undefined, input)
        return recordGlobalEvidenceIssue('invalid-receipt')
      }
      const classification: ReceiptClassification = {
        outcome: 'accepted',
        category: parsed.operation,
        attribution: 'runtime-verified',
        result: 'success',
        sideEffect:
          parsed.operation === 'verification' ||
          parsed.operation === 'check-readback' ||
          parsed.operation === 'review-readback'
            ? 'not-required'
            : 'required',
        reasonCode: 'recognized-command',
      }
      return processOperation(input, parsed, epoch.unit, classification)
    },

    observeReadback(input: unknown): ReadbackObservationResult {
      const parsed = parseReadback(input)
      if (!parsed) return { status: 'rejected', reasonCode: 'invalid-receipt' }
      return observeRevision(parsed, epoch?.unit)
    },

    currentOperationContext(): CurrentOperationContext {
      return currentOperationContext()
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
      return finalizeTransitionCall(parsed, lifecycle)
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

    restore,

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
