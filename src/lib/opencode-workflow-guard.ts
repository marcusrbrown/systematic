import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from 'zod'
import { INTERNAL_AGENT_SIGNATURES } from './bootstrap.js'
import type {
  OpencodeOperationObserver,
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
  type TransitionFinalizeResult,
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
  readonly targetDirectory?: string
  readonly sessionLocation?: string
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
  targetRoot: string
  targetIdentity: string
  registeredWorktreeIdentity: string
  observer: OpencodeOperationObserver
  before: OperationObserverSnapshot
  remoteOperation?: RemoteOperation
  remoteBefore?: OperationObserverRemoteResult
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

interface TerminalComplete {
  target: TransitionTarget
  status: 'rejected' | 'unavailable'
  reasonCode: WorkflowReasonCode
}

type OperationCompletionResult =
  | {
      status: 'accepted'
      operation: ReceiptOperation
      after: OperationObserverSnapshot
    }
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

export type LocalOperationTool = 'write' | 'edit' | 'apply_patch' | 'bash'

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

function canonicalPatchText(
  patchText: string,
  sessionLocation: string,
): string | undefined {
  if (patchTextFileTargets(patchText) === undefined) return undefined
  const segments = patchText.split(/(\r?\n)/)
  for (let index = 0; index < segments.length; index += 1) {
    const line = segments[index]
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
  if (tool !== 'apply_patch' || !isRecord(args)) return args
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

  function effectiveOperationObserver():
    | EffectiveOperationObserver
    | undefined {
    const parentObserver = options.observer
    if (!parentObserver) return undefined
    const pinnedTargetIdentity =
      guard.status().unit?.pinnedOperationTargetIdentity
    if (
      pinnedTargetIdentity === undefined ||
      pinnedTargetIdentity === options.workspaceIdentity
    ) {
      return {
        observer: parentObserver,
        targetIdentity: options.workspaceIdentity,
        pinned: false,
      }
    }
    const registration = operationObserverRegistration(pinnedTargetIdentity)
    if (!registration) return undefined
    let validation: RegisteredWorktreeValidationResult
    try {
      validation = parentObserver.validateRegisteredWorktree(
        registration.targetRoot,
      )
    } catch {
      return undefined
    }
    if (
      validation.status !== 'ok' ||
      validation.targetRoot !== registration.targetRoot ||
      registeredWorktreeIdentity(validation) !==
        registration.registeredWorktreeIdentity ||
      registration.observer.targetDigest !== pinnedTargetIdentity
    ) {
      return undefined
    }
    return {
      observer: registration.observer,
      targetIdentity: pinnedTargetIdentity,
      pinned: true,
    }
  }

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

  function recoverPersistedMarkers(markers: readonly unknown[]): boolean {
    // Callers must pass pre-filtered (own-registration) markers.
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
    if (allowFresh && !parts.some((part) => containsGuardHistory(part))) {
      publishFresh()
    } else {
      retryableEmptyHistory = true
      publishUnavailable()
    }
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
    const classification = classifyMarkersFromParts(parts)
    if (classification.kind === 'ambiguous') {
      // Cannot determine whether markers include corrupted own state → fail closed.
      // Do NOT use retryableEmptyHistory here; this is a corruption signal, not a
      // transient empty-history state.
      publishUnavailable()
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
    if (!recoverPersistedMarkers(classification.markers)) publishUnavailable()
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
    // Capture the parent's operation-before identities before reading child
    // history. These are guard-owned digests, not boot-time path values.
    const parentBefore = guard.currentOperationContext()
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
    // Classify child session markers: own (filter and recover), foreign-empty
    // (benign no-op — no receipts to roll up), or ambiguous (corrupted/seedless
    // markers that cannot be verified as foreign → fail closed).
    const classification = classifyMarkersFromParts(parts)
    if (classification.kind === 'foreign-empty') return
    if (classification.kind === 'ambiguous') {
      markUnavailable()
      return
    }
    const ownMarkers = classification.markers
    const seed = extractReceiptReadbackSeed(ownMarkers)
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
    const recovered = childLedger.recoverReadback(ownMarkers)
    if (recovered.status === 'rejected') {
      markUnavailable()
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
    const currentStatus = guard.status()
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
        markUnavailable()
        return
      }

      const targetIdentity = childReceipt.canonical.operationTargetIdentity
      if (!targetIdentity) {
        markUnavailable()
        return
      }
      if (
        batchTargetIdentity !== undefined &&
        targetIdentity !== batchTargetIdentity
      ) {
        markUnavailable()
        return
      }
      batchTargetIdentity = targetIdentity

      const registration = operationObserverRegistration(targetIdentity)
      if (!registration || !options.observer) {
        markUnavailable()
        return
      }
      let validation: RegisteredWorktreeValidationResult
      try {
        validation = options.observer.validateRegisteredWorktree(
          registration.targetRoot,
        )
      } catch {
        markUnavailable()
        return
      }
      if (
        validation.status === 'error' ||
        validation.targetRoot !== registration.targetRoot ||
        registeredWorktreeIdentity(validation) !==
          registration.registeredWorktreeIdentity ||
        registration.observer.targetDigest !== targetIdentity
      ) {
        markUnavailable()
        return
      }

      let targetResult: OperationObserverResult
      try {
        targetResult = await registration.observer.snapshot()
      } catch {
        markUnavailable()
        return
      }
      if (
        targetResult.status === 'unavailable' ||
        targetResult.snapshot.targetDigest !== targetIdentity
      ) {
        markUnavailable()
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
        markUnavailable()
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
      const parentContext = guard.currentOperationContext()
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
      const result = await guard.observeTrustedRecoveredOperation(observation)
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
    const effective = effectiveOperationObserver()
    if (!effective) {
      markUnavailable()
      return
    }
    let result: OperationObserverResult
    try {
      result = await effective.observer.snapshot()
    } catch {
      markUnavailable()
      return
    }
    if (
      result.status === 'unavailable' ||
      result.snapshot.targetDigest !== effective.targetIdentity
    ) {
      markUnavailable()
      return
    }
    const observed = guard.observeReadback({
      workspaceIdentity: options.workspaceIdentity,
      repositoryIdentity: result.snapshot.repositoryRevisionDigest,
      worktreeIdentity: result.snapshot.worktreeRevisionDigest,
      ...(effective.pinned
        ? { operationTargetIdentity: effective.targetIdentity }
        : {}),
    })
    if (
      (observed.status === 'rejected' &&
        observed.reasonCode === 'workspace-mismatch') ||
      !(await refreshRemoteReadbacks(effective.observer, result.snapshot))
    ) {
      markUnavailable()
    }
  }

  async function refreshRemoteReadbacks(
    observer: OpencodeOperationObserver,
    local: OperationObserverSnapshot,
  ): Promise<boolean> {
    const remoteOperations = guard
      .status()
      .satisfiedOperations.filter(remoteOperation)
    if (remoteOperations.length === 0) return true
    const remoteSnapshot = observer.remoteSnapshot
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
        ...existingMetadata,
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
      ...existingMetadata,
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
      return {
        operation: classification.category,
        before: await remoteSnapshot(classification.category, 'before'),
      }
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
    const { parentTargetRoot, sessionLocation } = effectiveTargetContext()
    const fingerprint = argsFingerprint(
      ledger,
      host.tool,
      args,
      sessionLocation,
    )
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
    const target = deriveOpencodeOperationTarget(host.tool, args, {
      parentTargetRoot,
      sessionLocation,
      validateRegisteredWorktree: options.observer.validateRegisteredWorktree,
    })
    if (target.status === 'unavailable') {
      markUnavailable()
      return
    }
    let registeredTarget: RegisteredWorktreeValidationResult
    try {
      registeredTarget = options.observer.validateRegisteredWorktree(
        target.targetRoot,
      )
    } catch {
      markUnavailable()
      return
    }
    const registeredIdentity = registeredWorktreeIdentity(registeredTarget)
    if (
      registeredTarget.status !== 'ok' ||
      registeredIdentity === undefined ||
      registeredTarget.targetRoot !== target.targetRoot
    ) {
      markUnavailable()
      return
    }
    const canonicalParentTargetRoot = canonicalExistingPath(
      parentTargetRoot,
      fs.realpathSync,
    )
    if (!canonicalParentTargetRoot) {
      markUnavailable()
      return
    }
    const operationObserver =
      target.targetRoot === canonicalParentTargetRoot
        ? options.observer
        : ([...operationObservers.values()].find(
            (registration) => registration.targetRoot === target.targetRoot,
          )?.observer ??
          createOpencodeOperationObserver({
            targetDirectory: target.targetRoot,
          }))
    let result: OperationObserverResult
    try {
      result = await operationObserver.snapshot()
    } catch {
      markUnavailable()
      return
    }
    if (result.status === 'unavailable') {
      markUnavailable()
      return
    }
    if (result.snapshot.targetDigest !== operationObserver.targetDigest) {
      markUnavailable()
      return
    }
    rememberOperationObserver({
      targetRoot: target.targetRoot,
      registeredWorktreeIdentity: registeredIdentity,
      observer: operationObserver,
    })
    const remote = await remoteIntentForOperation(host, args, operationObserver)
    pendingOperations.set(callDigest, {
      callID: host.callID,
      tool: host.tool,
      argsFingerprint: fingerprint,
      targetRoot: target.targetRoot,
      targetIdentity: operationObserver.targetDigest,
      registeredWorktreeIdentity: registeredIdentity,
      observer: operationObserver,
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
          resourceScopes: progressionResourceScopes(status.unit),
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed effective-observer selection and readback bundle construction must remain a single ordered pipeline
  async function completionReadbacks(): Promise<
    | { status: 'none' }
    | { status: 'unavailable' }
    | { status: 'ready'; readbacks: readonly unknown[] }
  > {
    if (!options.observer) return { status: 'none' }
    let parentResult: OperationObserverResult
    try {
      parentResult = await options.observer.snapshot()
    } catch {
      return { status: 'unavailable' }
    }
    if (
      parentResult.status === 'unavailable' ||
      parentResult.snapshot.targetDigest !== options.workspaceIdentity
    ) {
      return { status: 'unavailable' }
    }
    const effective = effectiveOperationObserver()
    if (!effective) return { status: 'unavailable' }
    let effectiveSnapshot = parentResult.snapshot
    if (effective.pinned) {
      let pinnedResult: OperationObserverResult
      try {
        pinnedResult = await effective.observer.snapshot()
      } catch {
        return { status: 'unavailable' }
      }
      if (
        pinnedResult.status === 'unavailable' ||
        pinnedResult.snapshot.targetDigest !== effective.targetIdentity
      ) {
        return { status: 'unavailable' }
      }
      effectiveSnapshot = pinnedResult.snapshot
    }
    const initialEffectiveSnapshot = effectiveSnapshot
    const remoteReadbacks = await completionRemoteReadbacks(effective.observer)
    if (!remoteReadbacks) return { status: 'unavailable' }
    let finalParentResult: OperationObserverResult
    try {
      finalParentResult = await options.observer.snapshot()
    } catch {
      return { status: 'unavailable' }
    }
    if (
      finalParentResult.status === 'unavailable' ||
      finalParentResult.snapshot.targetDigest !==
        parentResult.snapshot.targetDigest ||
      finalParentResult.snapshot.repositoryRevisionDigest !==
        parentResult.snapshot.repositoryRevisionDigest ||
      finalParentResult.snapshot.worktreeRevisionDigest !==
        parentResult.snapshot.worktreeRevisionDigest
    ) {
      return { status: 'unavailable' }
    }
    let finalEffective = effective
    if (effective.pinned) {
      const revalidated = effectiveOperationObserver()
      if (!revalidated) return { status: 'unavailable' }
      finalEffective = revalidated
      if (
        finalEffective.observer !== effective.observer ||
        finalEffective.targetIdentity !== effective.targetIdentity ||
        !finalEffective.pinned
      ) {
        return { status: 'unavailable' }
      }
      let pinnedResult: OperationObserverResult
      try {
        pinnedResult = await finalEffective.observer.snapshot()
      } catch {
        return { status: 'unavailable' }
      }
      if (
        pinnedResult.status === 'unavailable' ||
        pinnedResult.snapshot.targetDigest !== finalEffective.targetIdentity
      ) {
        return { status: 'unavailable' }
      }
      effectiveSnapshot = pinnedResult.snapshot
      if (
        effectiveSnapshot.repositoryRevisionDigest !==
          initialEffectiveSnapshot.repositoryRevisionDigest ||
        effectiveSnapshot.worktreeRevisionDigest !==
          initialEffectiveSnapshot.worktreeRevisionDigest
      ) {
        return { status: 'unavailable' }
      }
    } else {
      effectiveSnapshot = finalParentResult.snapshot
    }
    return {
      status: 'ready',
      readbacks: [
        {
          workspaceIdentity: options.workspaceIdentity,
          repositoryIdentity: effectiveSnapshot.repositoryRevisionDigest,
          worktreeIdentity: effectiveSnapshot.worktreeRevisionDigest,
          operationTargetIdentity: finalEffective.targetIdentity,
        },
        ...remoteReadbacks.map(({ operation, snapshot }) =>
          remoteReadbackInput(
            operation,
            effectiveSnapshot,
            options.workspaceIdentity,
            snapshot,
          ),
        ),
      ],
    }
  }

  async function completionRemoteReadbacks(
    observer: OpencodeOperationObserver,
  ): Promise<
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
    const remoteSnapshot = observer.remoteSnapshot
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

  async function captureAfterOperation(
    pending: PendingOperation,
  ): Promise<OperationObserverSnapshot | undefined> {
    if (!options.observer) return undefined
    let validation: RegisteredWorktreeValidationResult
    try {
      validation = options.observer.validateRegisteredWorktree(
        pending.targetRoot,
      )
    } catch {
      return undefined
    }
    if (
      validation.status === 'error' ||
      validation.targetRoot !== pending.targetRoot ||
      registeredWorktreeIdentity(validation) !==
        pending.registeredWorktreeIdentity
    ) {
      return undefined
    }
    let result: OperationObserverResult
    try {
      result = await pending.observer.snapshot()
    } catch {
      return undefined
    }
    return result.status === 'available' &&
      result.snapshot.targetDigest === pending.targetIdentity
      ? result.snapshot
      : undefined
  }

  async function captureRemoteAfter(
    operation: RemoteOperation,
    observer: OpencodeOperationObserver,
  ): Promise<OperationObserverRemoteSnapshot | undefined> {
    const remoteSnapshot = observer.remoteSnapshot
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
        ...(localOperation(operation)
          ? { operationTargetIdentity: pending.targetIdentity }
          : {}),
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
    const afterSnapshot = await captureAfterOperation(pending)
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
      const remoteAfter = await captureRemoteAfter(
        finalObservation.operation,
        pending.observer,
      )
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

  async function finishOperation(
    host: HostToolAfter,
    output: unknown,
  ): Promise<void> {
    if (!options.observer || !isLocalOperationTool(host.tool)) return
    const callDigest = digestCall(ledger, host.callID)
    const { sessionLocation } = effectiveTargetContext()
    const fingerprint = argsFingerprint(
      ledger,
      host.tool,
      host.args,
      sessionLocation,
    )
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
  const operationObservers: OperationObserverRegistry = new Map()
  const recoveredOperationContexts: RecoveredOperationRegistry = new Map()

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
