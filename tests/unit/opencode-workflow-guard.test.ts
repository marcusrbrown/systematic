import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@opencode-ai/plugin'
import { z } from 'zod'

import type {
  OpencodeOperationObserver,
  OperationObserverReasonCode,
  OperationObserverRemoteResult,
  OperationObserverSnapshot,
  RemoteOperation,
} from '../../src/lib/opencode-operation-observer.js'
import { createOpencodeOperationObserver } from '../../src/lib/opencode-operation-observer.js'
import {
  createOpencodeWorkflowGuard,
  createWorkflowGuardBlockedError,
  deriveOpencodeOperationTarget,
  isWorkflowGuardBlockedError,
  type OpencodeWorkflowGuard,
  type OpencodeWorkflowHostReadback,
  SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY,
} from '../../src/lib/opencode-workflow-guard.js'
import {
  createReceiptClassifier,
  type ReceiptOperationObservation,
} from '../../src/lib/receipt-classifier.js'
import type {
  ReceiptLedger,
  ReceiptOperation,
} from '../../src/lib/receipt-ledger.js'
import { createReceiptLedger } from '../../src/lib/receipt-ledger.js'
import {
  projectReceiptConsumptionMarker,
  projectReceiptMintMarker,
  projectReceiptProgressionMarker,
} from '../../src/lib/receipt-readback.js'
import type { WorkflowStatus } from '../../src/lib/workflow-guard.js'

const SESSION_A = 'session-1'
const SESSION_B = 'session-2'

function status(
  adapter: OpencodeWorkflowGuard,
  sessionID = SESSION_A,
): WorkflowStatus {
  return adapter.status(sessionID)
}

function ledger(
  adapter: OpencodeWorkflowGuard,
  sessionID = SESSION_A,
): ReceiptLedger {
  const value = adapter.ledger(sessionID)
  if (!value) throw new Error('session ledger missing')
  return value
}

/**
 * Look up a registered guard tool by name. All names used in this suite are
 * always registered by `createOpencodeWorkflowGuard`; this narrows the
 * `Record<string, ToolDefinition>` index access to a real `ToolDefinition`
 * instead of silencing the possibly-undefined type.
 */
function getTool(adapter: OpencodeWorkflowGuard, name: string): ToolDefinition {
  const tool = adapter.tools[name]
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

/**
 * Local shape for a mutable `tool.execute.after` output fixture. The real
 * `ToolResult` from `@opencode-ai/plugin` is `string | {..., metadata?: {
 * [key: string]: any }}`; these fixtures always use the object variant and
 * read `metadata` back by bracket key after the hook mutates it in place, so
 * the field is typed as a real record instead of an inferred empty object.
 */
type RecordedToolOutput = {
  title?: string
  output: string
  metadata: Record<string, unknown>
}

/**
 * `ToolContext.execute()` returns `ToolResult`, a `string |
 * {output, metadata?, ...}` union. Every tool under test here always
 * returns the structured object variant; this narrows for `.output`/
 * `.metadata` access instead of casting.
 */
function expectToolOutput(result: ToolResult): Exclude<ToolResult, string> {
  if (typeof result === 'string') {
    throw new Error('expected a structured tool result, got a bare string')
  }
  return result
}

function toolContext(sessionID = SESSION_A): ToolContext {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: 'systematic',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

const SCOPE = {
  workspaceIdentity: 'workspace-current',
  repositoryIdentity: 'repository-current',
  worktreeIdentity: 'worktree-current',
}

const OPERATION_SCOPE = {
  workspaceIdentity: 'a'.repeat(64),
  repositoryIdentity: 'b'.repeat(64),
  worktreeIdentity: 'c'.repeat(64),
  operationTargetIdentity: 'a'.repeat(64),
}

interface TargetDerivationFixture {
  readonly parentRoot: string
  readonly linkedRoot: string
  readonly secondLinkedRoot: string
  readonly unrelatedRoot: string
  cleanup(): void
}

function runTargetFixtureGit(
  cwd: string,
  args: readonly string[],
): {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
} {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    status: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function createTargetDerivationFixture(): TargetDerivationFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-target-'))
  const parentRoot = path.join(root, 'parent')
  const linkedRoot = path.join(root, 'linked')
  const secondLinkedRoot = path.join(root, 'linked-second')
  const unrelatedRoot = path.join(root, 'unrelated')
  fs.mkdirSync(parentRoot)
  fs.mkdirSync(unrelatedRoot)

  const git = (cwd: string, args: readonly string[]) => {
    const result = runTargetFixtureGit(cwd, args)
    if (result.status !== 0) {
      throw new Error(`target fixture git setup failed: ${args.join(' ')}`)
    }
  }
  git(parentRoot, ['init', '--quiet'])
  git(parentRoot, ['config', 'user.email', 'target@example.invalid'])
  git(parentRoot, ['config', 'user.name', 'Target Test'])
  fs.writeFileSync(path.join(parentRoot, 'tracked.txt'), 'parent\n')
  fs.mkdirSync(path.join(parentRoot, 'nested'))
  git(parentRoot, ['add', '.'])
  git(parentRoot, ['commit', '--quiet', '-m', 'initial'])
  git(parentRoot, ['worktree', 'add', '--quiet', '-b', 'linked', linkedRoot])
  git(parentRoot, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    'linked-second',
    secondLinkedRoot,
  ])
  git(unrelatedRoot, ['init', '--quiet'])

  return {
    parentRoot,
    linkedRoot,
    secondLinkedRoot,
    unrelatedRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function deriveWithFixture(
  fixture: TargetDerivationFixture,
  tool: 'write' | 'edit' | 'apply_patch' | 'bash',
  args: Record<string, unknown>,
) {
  const observer = createOpencodeOperationObserver({
    targetDirectory: fixture.parentRoot,
  })
  return deriveOpencodeOperationTarget(tool, args, {
    parentTargetRoot: fixture.parentRoot,
    sessionLocation: fixture.parentRoot,
    validateRegisteredWorktree: observer.validateRegisteredWorktree,
  })
}

function sequenceObserver(
  snapshots: readonly OperationObserverSnapshot[],
  remoteResults: Readonly<
    Record<string, readonly OperationObserverRemoteResult[]>
  > = {},
): OpencodeOperationObserver {
  let index = 0
  const remoteIndexes = new Map<string, number>()
  return {
    targetDigest: snapshots[0]?.targetDigest ?? 'a'.repeat(64),
    validateRegisteredWorktree(candidateDirectory) {
      return {
        status: 'ok',
        targetRoot: candidateDirectory,
        gitDir: path.join(candidateDirectory, '.git'),
        commonDir: path.join(candidateDirectory, '.git'),
      }
    },
    async snapshot() {
      const snapshot = snapshots[Math.min(index++, snapshots.length - 1)]
      if (!snapshot) {
        return { status: 'unavailable', reasonCode: 'target-unavailable' }
      }
      return { status: 'available', snapshot }
    },
    async remoteSnapshot(operation, phase) {
      const key = `${operation}:${phase}`
      const values = remoteResults[key]
      if (!values || values.length === 0) {
        return { status: 'unavailable', reasonCode: 'remote-missing-field' }
      }
      const current = remoteIndexes.get(key) ?? 0
      remoteIndexes.set(key, current + 1)
      const result = values[Math.min(current, values.length - 1)]
      if (!result) {
        return { status: 'unavailable', reasonCode: 'remote-missing-field' }
      }
      return result
    },
  }
}

function remoteAvailable(
  resourceIdentity = 'd'.repeat(64),
  resourceRevisionIdentity = 'e'.repeat(64),
  extras: Record<string, unknown> = {},
): OperationObserverRemoteResult {
  return {
    status: 'available',
    snapshot: {
      resourceIdentity,
      resourceRevisionIdentity,
      ...extras,
    },
  }
}

function createAdapter(
  mode: 'observe' | 'protected' | 'disabled' = 'protected',
  debug = false,
  observer?: OpencodeOperationObserver,
  runtimeRequiredOperations: readonly ReceiptOperation[] = [],
  observations?: ReceiptOperationObservation[],
  hostReadback?: OpencodeWorkflowHostReadback,
  sharedRecovery = false,
): OpencodeWorkflowGuard {
  const classifier = createReceiptClassifier()
  return createOpencodeWorkflowGuard({
    config: { mode, debug },
    ...(observer ? OPERATION_SCOPE : SCOPE),
    ...(sharedRecovery
      ? {
          registrationIdentity: 'adapter-test-registration',
          sessionSalt: new Uint8Array(32).fill(7),
        }
      : {}),
    ...(observer
      ? {
          observer,
          classifier: observations
            ? {
                ...classifier,
                classifyOperation: async (input: unknown) => {
                  observations.push(input as ReceiptOperationObservation)
                  const classify = classifier.classifyOperation
                  if (!classify) {
                    throw new Error(
                      'expected classifier to implement classifyOperation',
                    )
                  }
                  return classify(input)
                },
              }
            : classifier,
          runtimeRequiredOperations,
          hostReadback,
        }
      : {}),
  })
}

function operationSnapshot(
  repositoryIdentity = OPERATION_SCOPE.repositoryIdentity,
  worktreeIdentity = OPERATION_SCOPE.worktreeIdentity,
  commitClosure?: boolean,
): OperationObserverSnapshot {
  return {
    targetDigest: OPERATION_SCOPE.workspaceIdentity,
    repositoryRevisionDigest: repositoryIdentity,
    worktreeRevisionDigest: worktreeIdentity,
    ...(commitClosure === undefined ? {} : { commitClosure }),
  }
}

async function observeOperationTool(
  adapter: OpencodeWorkflowGuard,
  tool: 'write' | 'edit' | 'apply_patch' | 'bash',
  args: Record<string, unknown>,
  output: Record<string, unknown>,
  callID = `${tool}-operation`,
  sessionID = SESSION_A,
): Promise<void> {
  await adapter.hooks['tool.execute.before'](
    { tool, sessionID, callID },
    { args },
  )
  await adapter.hooks['tool.execute.after'](
    { tool, sessionID, callID, args },
    output,
  )
}

async function observeOperationToolWithArgs(
  adapter: OpencodeWorkflowGuard,
  beforeArgs: Record<string, unknown>,
  afterArgs: Record<string, unknown>,
  output: Record<string, unknown>,
  callID = 'apply_patch-operation',
  sessionID = SESSION_A,
): Promise<void> {
  await adapter.hooks['tool.execute.before'](
    { tool: 'apply_patch', sessionID, callID },
    { args: beforeArgs },
  )
  await adapter.hooks['tool.execute.after'](
    { tool: 'apply_patch', sessionID, callID, args: afterArgs },
    output,
  )
}

function prepareApplyPatchTargetDirectory(): () => void {
  const targetDirectory = path.resolve(process.cwd(), 'sub')
  const existed = fs.existsSync(targetDirectory)
  fs.mkdirSync(targetDirectory, { recursive: true })
  return () => {
    if (!existed) fs.rmSync(targetDirectory, { recursive: true, force: true })
  }
}

async function observeSkill(
  adapter: OpencodeWorkflowGuard,
  tool: 'systematic_skill' | 'skill',
  name: string,
  callID = `${tool}-${name}`,
  sessionID = SESSION_A,
  output: unknown = {
    title: 'Loaded skill',
    output: 'skill result',
    metadata: {},
  },
): Promise<void> {
  await adapter.hooks['tool.execute.before'](
    { tool, sessionID, callID },
    { args: { name } },
  )
  await adapter.hooks['tool.execute.after'](
    { tool, sessionID, callID, args: { name } },
    output,
  )
}

async function observeQuestionEvent(
  adapter: OpencodeWorkflowGuard,
  type: 'question.asked' | 'question.replied' | 'question.rejected',
  properties: Record<string, unknown>,
): Promise<void> {
  await adapter.hooks.event({ event: { type, properties } })
}

function mintReceipt(
  adapter: OpencodeWorkflowGuard,
  operation: 'implementation' | 'verification',
  sessionID = SESSION_A,
  scope = SCOPE,
): void {
  const currentStatus = status(adapter, sessionID)
  if (!currentStatus.epoch || !currentStatus.unit) {
    throw new Error('workflow unit missing')
  }
  const callID = `${operation}-${currentStatus.epoch.epochId}-${currentStatus.unit.unitId}`
  const context = {
    epochId: currentStatus.epoch.epochId,
    unitId: currentStatus.unit.unitId,
    workspaceIdentity: scope.workspaceIdentity,
    repositoryIdentity: scope.repositoryIdentity,
    operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
    worktreeIdentity:
      operation === 'implementation'
        ? 'worktree-before'
        : scope.worktreeIdentity,
  }
  const receiptLedger = ledger(adapter, sessionID)
  const prepared = receiptLedger.prepareObservation({
    callId: callID,
    operation,
    context,
  })
  if (prepared.status !== 'prepared') throw new Error('receipt not prepared')
  const finalized = receiptLedger.finalizeObservation({
    callId: callID,
    context,
    after: {
      workspaceIdentity: scope.workspaceIdentity,
      repositoryIdentity: scope.repositoryIdentity,
      worktreeIdentity: scope.worktreeIdentity,
      operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
    },
    classification: {
      outcome: 'accepted',
      category: operation,
      attribution: 'runtime-verified',
      result: 'success',
      sideEffect: operation === 'verification' ? 'not-required' : 'required',
      reasonCode: 'recognized-command',
    },
    terminal: { status: 'success', output: 'non-empty', noOp: false },
  })
  if (finalized.status !== 'finalized') throw new Error('receipt not finalized')
  const observed = adapter.observeReceipt(sessionID, finalized.receipt)
  if (observed.status !== 'accepted') throw new Error('receipt not observed')
}

function wrapReceiptMarkers(markers: readonly unknown[]): readonly unknown[] {
  return [
    {
      info: {},
      parts: [
        {
          state: {
            metadata: {
              [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: markers,
            },
          },
        },
      ],
    },
  ]
}

function buildPinnedRecoveryMarkers(
  registrationIdentity: string,
  sessionSalt: Uint8Array,
  workspaceIdentity: string,
  operationTargetIdentity: string,
  repositoryIdentity: string,
  worktreeIdentity: string,
): readonly unknown[] {
  const recoveryLedger = createReceiptLedger({
    capabilityFlags: ['workflow-guard'],
    registrationIdentity,
    sessionSalt,
  })
  const epochId = 'a'.repeat(32)
  const unitId = 'b'.repeat(32)
  const digestCall = (value: string) =>
    recoveryLedger.digestIdentity('call', value)
  const epochStart = projectReceiptProgressionMarker(recoveryLedger, {
    target: 'epoch',
    state: 'started',
    epochId,
    family: 'work',
    transitionDigest: digestCall('epoch-start'),
    timestamp: 1,
  })
  const unitStart = projectReceiptProgressionMarker(recoveryLedger, {
    target: 'unit',
    state: 'started',
    epochId,
    unitId,
    family: 'work',
    requiredOperations: ['verification'],
    resourceScopes: [],
    pinnedOperationTargetIdentity: operationTargetIdentity,
    transitionDigest: digestCall('unit-start'),
    timestamp: 2,
  })
  if (!epochStart || !unitStart) throw new Error('progression marker failed')

  const context = {
    epochId,
    unitId,
    workspaceIdentity,
    operationTargetIdentity,
    repositoryIdentity,
    worktreeIdentity,
  }
  const prepared = recoveryLedger.prepareObservation({
    callId: 'recovered-verification',
    operation: 'verification',
    context,
  })
  if (prepared.status !== 'prepared') throw new Error('receipt not prepared')
  const finalized = recoveryLedger.finalizeObservation({
    callId: 'recovered-verification',
    context,
    after: context,
    classification: {
      outcome: 'accepted',
      category: 'verification',
      attribution: 'runtime-verified',
      result: 'success',
      sideEffect: 'not-required',
      reasonCode: 'recognized-command',
    },
    terminal: { status: 'success', output: 'non-empty', noOp: false },
  })
  if (finalized.status !== 'finalized') {
    throw new Error(
      `pinned recovery receipt not finalized: ${JSON.stringify(finalized)}`,
    )
  }
  const mint = projectReceiptMintMarker(finalized.receipt, sessionSalt)
  if (!mint) throw new Error('receipt marker failed')
  return [epochStart, unitStart, mint]
}

async function createPinnedRecoveryAdapter(
  mode: 'observe' | 'protected' = 'observe',
): Promise<{
  readonly fixture: TargetDerivationFixture
  readonly adapter: OpencodeWorkflowGuard
  readonly targetRoot: string
  readonly targetIdentity: string
  setTargetValidationAvailable(
    value: boolean,
    reasonCode?: OperationObserverReasonCode,
  ): void
  // Targeted one-shot timeouts, counted from the moment they are armed: the
  // Nth upcoming call of that kind returns `command-timeout`.
  timeoutParentSnapshotOnCall(n: number): void
  timeoutPinnedSnapshotOnCall(n: number): void
  timeoutPinnedValidationOnCall(n: number): void
  throwParentSnapshotOnCall(n: number): void
}> {
  const fixture = createTargetDerivationFixture()
  const targetRoot = fs.realpathSync(fixture.linkedRoot)
  const baseObserver = createOpencodeOperationObserver({
    targetDirectory: fixture.parentRoot,
  })
  const initial = await baseObserver.snapshot()
  if (initial.status !== 'available') {
    fixture.cleanup()
    throw new Error('parent unavailable')
  }
  const targetObserver = createOpencodeOperationObserver({
    targetDirectory: targetRoot,
  })
  const targetInitial = await targetObserver.snapshot()
  if (targetInitial.status !== 'available') {
    fixture.cleanup()
    throw new Error('target unavailable')
  }
  let targetValidationAvailable = true
  let targetValidationReason: OperationObserverReasonCode = 'target-unavailable'
  const calls = { parent: 0, pinned: 0, validation: 0 }
  const timeoutOn: Record<keyof typeof calls, number | undefined> = {
    parent: undefined,
    pinned: undefined,
    validation: undefined,
  }
  let parentThrowOn: number | undefined
  const commandTimeout = {
    status: 'unavailable' as const,
    reasonCode: 'command-timeout' as const,
  }
  const observer: OpencodeOperationObserver = {
    targetDigest: baseObserver.targetDigest,
    validateRegisteredWorktree: (candidateDirectory) => {
      if (candidateDirectory === targetRoot) {
        calls.validation += 1
        if (calls.validation === timeoutOn.validation) {
          return { status: 'error', reasonCode: 'command-timeout' }
        }
        if (!targetValidationAvailable) {
          return { status: 'error', reasonCode: targetValidationReason }
        }
      }
      return baseObserver.validateRegisteredWorktree(candidateDirectory)
    },
    snapshot: async () => {
      calls.parent += 1
      if (calls.parent === parentThrowOn) throw new Error('parent exploded')
      if (calls.parent === timeoutOn.parent) return commandTimeout
      return baseObserver.snapshot()
    },
  }
  const createTargetObserver = (
    targetDirectory: string,
  ): OpencodeOperationObserver => {
    const real = createOpencodeOperationObserver({ targetDirectory })
    if (targetDirectory !== targetRoot) return real
    return {
      ...real,
      snapshot: async () => {
        calls.pinned += 1
        if (calls.pinned === timeoutOn.pinned) return commandTimeout
        return real.snapshot()
      },
    }
  }
  const registrationIdentity = 'pinned-completion-registration'
  const sessionSalt = new Uint8Array(32).fill(137)
  let parentMarkers: readonly unknown[] = []
  const adapter = createOpencodeWorkflowGuard({
    config: { mode, debug: false },
    workspaceIdentity: initial.snapshot.targetDigest,
    repositoryIdentity: targetInitial.snapshot.repositoryRevisionDigest,
    worktreeIdentity: targetInitial.snapshot.worktreeRevisionDigest,
    targetDirectory: fixture.parentRoot,
    sessionLocation: fixture.parentRoot,
    registrationIdentity,
    sessionSalt,
    observer,
    createTargetObserver,
    classifier: createReceiptClassifier(),
    hostReadback: {
      readSessionParts: async (sessionID) =>
        sessionID === SESSION_A ? wrapReceiptMarkers(parentMarkers) : [],
      listChildren: async () => [],
    },
  })

  await observeSkill(
    adapter,
    'systematic_skill',
    'ce:work',
    'pinned-recovery-setup-skill',
    SESSION_B,
  )
  const input = {
    tool: 'bash' as const,
    sessionID: SESSION_B,
    callID: 'pinned-recovery-setup-write',
    args: { command: 'git status --short', workdir: targetRoot },
  }
  await adapter.hooks['tool.execute.before'](input, { args: input.args })
  await adapter.hooks['tool.execute.after'](input, {
    title: 'tests complete',
    output: 'pass',
    metadata: { exit: 0 },
  })

  const targetResult = await targetObserver.snapshot()
  if (targetResult.status !== 'available') {
    fixture.cleanup()
    throw new Error('target unavailable')
  }
  parentMarkers = buildPinnedRecoveryMarkers(
    registrationIdentity,
    sessionSalt,
    initial.snapshot.targetDigest,
    targetObserver.targetDigest,
    targetResult.snapshot.repositoryRevisionDigest,
    targetResult.snapshot.worktreeRevisionDigest,
  )
  await getTool(adapter, 'systematic_workflow_status').execute(
    {},
    toolContext(SESSION_A),
  )

  return {
    fixture,
    adapter,
    targetRoot,
    targetIdentity: targetObserver.targetDigest,
    setTargetValidationAvailable(value, reasonCode = 'target-unavailable') {
      targetValidationAvailable = value
      targetValidationReason = reasonCode
    },
    timeoutParentSnapshotOnCall(n) {
      timeoutOn.parent = calls.parent + n
    },
    timeoutPinnedSnapshotOnCall(n) {
      timeoutOn.pinned = calls.pinned + n
    },
    timeoutPinnedValidationOnCall(n) {
      timeoutOn.validation = calls.validation + n
    },
    throwParentSnapshotOnCall(n) {
      parentThrowOn = calls.parent + n
    },
  }
}

async function createFreshPinnedAdapter(
  requiredOperations: readonly ReceiptOperation[] = [
    'implementation',
    'verification',
  ],
): Promise<{
  readonly fixture: TargetDerivationFixture
  readonly adapter: OpencodeWorkflowGuard
  readonly parentObserver: OpencodeOperationObserver
  readonly targetRoot: string
  readonly targetIdentity: string
}> {
  const fixture = createTargetDerivationFixture()
  const targetRoot = fs.realpathSync(fixture.linkedRoot)
  const parentObserver = createOpencodeOperationObserver({
    targetDirectory: fixture.parentRoot,
  })
  const initial = await parentObserver.snapshot()
  const targetObserver = createOpencodeOperationObserver({
    targetDirectory: targetRoot,
  })
  if (initial.status !== 'available') {
    fixture.cleanup()
    throw new Error('parent unavailable')
  }
  const adapter = createOpencodeWorkflowGuard({
    config: { mode: 'observe', debug: false },
    workspaceIdentity: initial.snapshot.targetDigest,
    repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
    worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
    targetDirectory: fixture.parentRoot,
    sessionLocation: fixture.parentRoot,
    observer: parentObserver,
    classifier: createReceiptClassifier(),
    runtimeRequiredOperations: requiredOperations,
  })
  await observeSkill(adapter, 'systematic_skill', 'ce:work')
  return {
    fixture,
    adapter,
    parentObserver,
    targetRoot,
    targetIdentity: targetObserver.targetDigest,
  }
}

async function observeFreshWrite(
  adapter: OpencodeWorkflowGuard,
  targetPath: string,
  content: string,
  callID: string,
): Promise<void> {
  const input = {
    tool: 'write' as const,
    sessionID: SESSION_A,
    callID,
    args: { filePath: targetPath, content },
  }
  await adapter.hooks['tool.execute.before'](input, { args: input.args })
  fs.writeFileSync(targetPath, content)
  await adapter.hooks['tool.execute.after'](input, {
    title: 'write complete',
    output: 'changed',
    metadata: {},
  })
}

async function observeFreshVerification(
  adapter: OpencodeWorkflowGuard,
  targetRoot: string,
  callID: string,
): Promise<void> {
  await observeOperationTool(
    adapter,
    'bash',
    {
      command: 'bun test tests/unit/example.test.ts',
      workdir: targetRoot,
    },
    { title: 'verification complete', output: 'pass', metadata: { exit: 0 } },
    callID,
  )
}

async function completeUnit(
  adapter: OpencodeWorkflowGuard,
  callID: string,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const input = {
    tool: 'systematic_workflow_complete' as const,
    sessionID: SESSION_A,
    callID,
  }
  await adapter.hooks['tool.execute.before'](input, {
    args: { target: 'unit' },
  })
  const output = { title: 'complete', output: 'done', metadata: {} }
  await adapter.hooks['tool.execute.after'](
    { ...input, args: { target: 'unit' } },
    output,
  )
  return output
}

describe('OpenCode workflow guard adapter', () => {
  test('target derivation: registered worktree from bash workdir', () => {
    const result = deriveOpencodeOperationTarget(
      'bash',
      { workdir: '../linked-worktree' },
      {
        parentTargetRoot: '/parent',
        sessionLocation: '/parent',
        realPath: (value) => value,
        validateRegisteredWorktree: (candidate) =>
          candidate === '/linked-worktree'
            ? {
                status: 'ok',
                targetRoot: candidate,
                gitDir: '/parent/.git/worktrees/linked',
                commonDir: '/parent/.git',
              }
            : { status: 'error', reasonCode: 'target-unavailable' },
      },
    )

    expect(result).toEqual({
      status: 'available',
      targetRoot: '/linked-worktree',
    })
  })

  test('target derivation: worktree from write file path', () => {
    const result = deriveOpencodeOperationTarget(
      'write',
      { path: '/linked-worktree/src/file.ts' },
      {
        parentTargetRoot: '/parent',
        sessionLocation: '/parent',
        realPath: (value) => value,
        validateRegisteredWorktree: (candidate) =>
          candidate === '/linked-worktree/src'
            ? {
                status: 'ok',
                targetRoot: '/linked-worktree',
                gitDir: '/parent/.git/worktrees/linked',
                commonDir: '/parent/.git',
              }
            : { status: 'error', reasonCode: 'target-unavailable' },
      },
    )

    expect(result).toEqual({
      status: 'available',
      targetRoot: '/linked-worktree',
    })
  })

  test('target derivation: one apply_patch target for every file path', () => {
    const result = deriveOpencodeOperationTarget(
      'apply_patch',
      {
        workdir: '/linked-worktree',
        patchText: [
          '*** Begin Patch',
          '*** Add File: src/one.ts',
          '+one',
          '*** Update File: nested/two.ts',
          '@@',
          '-two',
          '+updated',
          '*** End Patch',
        ].join('\n'),
      },
      {
        parentTargetRoot: '/parent',
        sessionLocation: '/parent',
        realPath: (value) => value,
        validateRegisteredWorktree: (candidate) =>
          candidate === '/linked-worktree' ||
          candidate === '/linked-worktree/src' ||
          candidate === '/linked-worktree/nested'
            ? {
                status: 'ok',
                targetRoot: '/linked-worktree',
                gitDir: '/parent/.git/worktrees/linked',
                commonDir: '/parent/.git',
              }
            : { status: 'error', reasonCode: 'target-unavailable' },
      },
    )

    expect(result).toEqual({
      status: 'available',
      targetRoot: '/linked-worktree',
    })
  })

  test('target derivation: canonical registered worktree for real bash workdir', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'bash', {
          command: 'git status --short',
          workdir: fixture.linkedRoot,
        }),
      ).toEqual({
        status: 'available',
        targetRoot: fs.realpathSync(fixture.linkedRoot),
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: relative bash workdir stays on parent target', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'bash', {
          command: 'git status --short',
          workdir: 'nested',
        }),
      ).toEqual({
        status: 'available',
        targetRoot: fs.realpathSync(fixture.parentRoot),
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: absent bash workdir uses parent target', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'bash', { command: 'git status --short' }),
      ).toEqual({
        status: 'available',
        targetRoot: fs.realpathSync(fixture.parentRoot),
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: write and edit support filePath and path', () => {
    const fixture = createTargetDerivationFixture()
    try {
      const expected = {
        status: 'available' as const,
        targetRoot: fs.realpathSync(fixture.linkedRoot),
      }
      expect(
        deriveWithFixture(fixture, 'write', {
          filePath: path.join(fixture.linkedRoot, 'tracked.txt'),
        }),
      ).toEqual(expected)
      expect(
        deriveWithFixture(fixture, 'edit', {
          path: path.join(fixture.linkedRoot, 'tracked.txt'),
        }),
      ).toEqual(expected)
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: new write file uses canonical existing parent', () => {
    const fixture = createTargetDerivationFixture()
    try {
      const targetDirectory = path.join(fixture.linkedRoot, 'new-files')
      fs.mkdirSync(targetDirectory)
      expect(
        deriveWithFixture(fixture, 'write', {
          path: path.join(targetDirectory, 'new.ts'),
        }),
      ).toEqual({
        status: 'available',
        targetRoot: fs.realpathSync(fixture.linkedRoot),
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: multiple apply_patch files share one worktree', () => {
    const fixture = createTargetDerivationFixture()
    try {
      fs.mkdirSync(path.join(fixture.linkedRoot, 'src'), { recursive: true })
      fs.mkdirSync(path.join(fixture.linkedRoot, 'nested'), {
        recursive: true,
      })
      fs.writeFileSync(path.join(fixture.linkedRoot, 'src', 'one.ts'), 'one\n')
      fs.writeFileSync(
        path.join(fixture.linkedRoot, 'nested', 'two.ts'),
        'two\n',
      )

      expect(
        deriveWithFixture(fixture, 'apply_patch', {
          workdir: fixture.linkedRoot,
          patchText: [
            '*** Begin Patch',
            '*** Update File: src/one.ts',
            '*** Update File: nested/two.ts',
            '*** End Patch',
          ].join('\n'),
        }),
      ).toEqual({
        status: 'available',
        targetRoot: fs.realpathSync(fixture.linkedRoot),
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: apply_patch spanning worktrees fails closed', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'apply_patch', {
          patchText: [
            '*** Begin Patch',
            `*** Update File: ${path.join(fixture.linkedRoot, 'tracked.txt')}`,
            `*** Update File: ${path.join(fixture.secondLinkedRoot, 'tracked.txt')}`,
            '*** End Patch',
          ].join('\n'),
        }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: apply_patch absolute worktree path without workdir resolves to worktree', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'apply_patch', {
          patchText: [
            '*** Begin Patch',
            `*** Update File: ${path.join(fixture.linkedRoot, 'tracked.txt')}`,
            '*** End Patch',
          ].join('\n'),
        }),
      ).toEqual({
        status: 'available',
        targetRoot: fs.realpathSync(fixture.linkedRoot),
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: unrelated explicit bash workdir fails closed', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'bash', {
          command: 'git status --short',
          workdir: fixture.unrelatedRoot,
        }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: absolute nested repository is not parent target', () => {
    const fixture = createTargetDerivationFixture()
    const nestedRepository = path.join(fixture.parentRoot, 'nested-repo')
    try {
      fs.mkdirSync(nestedRepository)
      const initialized = runTargetFixtureGit(nestedRepository, [
        'init',
        '--quiet',
      ])
      expect(initialized.status).toBe(0)
      expect(
        deriveWithFixture(fixture, 'bash', {
          command: 'git status --short',
          workdir: nestedRepository,
        }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: absolute nested repository file fails closed', () => {
    const fixture = createTargetDerivationFixture()
    const nestedRepository = path.join(fixture.parentRoot, 'nested-repo')
    const nestedFile = path.join(nestedRepository, 'nested.ts')
    try {
      fs.mkdirSync(nestedRepository)
      const initialized = runTargetFixtureGit(nestedRepository, [
        'init',
        '--quiet',
      ])
      expect(initialized.status).toBe(0)
      fs.writeFileSync(nestedFile, 'nested\n')
      expect(deriveWithFixture(fixture, 'write', { path: nestedFile })).toEqual(
        {
          status: 'unavailable',
          reasonCode: 'target-unavailable',
        },
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: explicit apply workdir validates relative files', () => {
    const fixture = createTargetDerivationFixture()
    const nestedRepository = path.join(fixture.parentRoot, 'nested-repo')
    const nestedFile = path.join(nestedRepository, 'nested.ts')
    try {
      fs.mkdirSync(nestedRepository)
      const initialized = runTargetFixtureGit(nestedRepository, [
        'init',
        '--quiet',
      ])
      expect(initialized.status).toBe(0)
      fs.writeFileSync(nestedFile, 'nested\n')
      expect(
        deriveWithFixture(fixture, 'apply_patch', {
          workdir: fixture.parentRoot,
          patchText: [
            '*** Begin Patch',
            '*** Update File: nested-repo/nested.ts',
            '*** End Patch',
          ].join('\n'),
        }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: invalid explicit apply workdir fails closed', () => {
    const fixture = createTargetDerivationFixture()
    const nestedRepository = path.join(fixture.parentRoot, 'nested-repo')
    try {
      fs.mkdirSync(nestedRepository)
      const initialized = runTargetFixtureGit(nestedRepository, [
        'init',
        '--quiet',
      ])
      expect(initialized.status).toBe(0)
      expect(
        deriveWithFixture(fixture, 'apply_patch', {
          workdir: nestedRepository,
          patchText: '',
        }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: escaping file symlink is rejected', () => {
    const fixture = createTargetDerivationFixture()
    const outsideFile = path.join(
      path.dirname(fixture.parentRoot),
      'outside.ts',
    )
    const escapedFile = path.join(fixture.linkedRoot, 'escaped.ts')
    try {
      fs.writeFileSync(outsideFile, 'outside\n')
      fs.symlinkSync(outsideFile, escapedFile)

      expect(
        deriveWithFixture(fixture, 'write', { path: escapedFile }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('target derivation: linked worktree gitfile is rejected', () => {
    const fixture = createTargetDerivationFixture()
    try {
      expect(
        deriveWithFixture(fixture, 'write', {
          path: path.join(fixture.linkedRoot, '.git'),
        }),
      ).toEqual({
        status: 'unavailable',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('does not expose the trusted recovery seam as a host/model tool', () => {
    const adapter = createAdapter('observe')

    expect(Object.keys(adapter.tools)).not.toContain(
      'observeTrustedRecoveredOperation',
    )
  })

  test('selects trusted required operations from the activated skill', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'git-commit')
    expect(status(adapter).unit?.requiredOperations).toEqual([
      'implementation',
      'verification',
      'commit',
    ])
  })

  test('projects the upgraded declaration with its actual operations and resource scopes', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    const output: RecordedToolOutput = {
      title: 'pending',
      output: 'start complete',
      metadata: {},
    }
    const args = {
      expected_operations: ['commit'],
      resource_scopes: {
        'review-readback': 'review-resource',
        push: 'remote-resource',
      },
    }
    await adapter.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'expanded-start',
      },
      { args },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'expanded-start',
        args,
      },
      output,
    )

    const markers = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    expect(markers).toBeDefined()
    const unitMarker = Array.isArray(markers)
      ? markers.find(
          (marker): marker is Record<string, unknown> =>
            typeof marker === 'object' &&
            marker !== null &&
            (marker as Record<string, unknown>).target === 'unit',
        )
      : markers
    expect(unitMarker).toMatchObject({
      target: 'unit',
      state: 'started',
      requiredOperations: [
        'implementation',
        'verification',
        'commit',
        'push',
        'review-readback',
      ],
      resourceScopes: [
        {
          operation: 'push',
          resourceIdentity: ledger(adapter).digestIdentity(
            'resource',
            'remote-resource',
          ),
        },
        {
          operation: 'review-readback',
          resourceIdentity: ledger(adapter).digestIdentity(
            'resource',
            'review-resource',
          ),
        },
      ],
    })
    expect(status(adapter)).toMatchObject({
      state: 'waiting',
      missingOperations: [
        'implementation',
        'verification',
        'commit',
        'review-readback',
        'push',
      ],
    })
  })

  test('does not emit a second progression marker for a no-growth start', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    const output: RecordedToolOutput = {
      title: 'pending',
      output: 'start complete',
      metadata: {},
    }
    const args = { expected_operations: [] }
    await adapter.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'no-growth-start',
      },
      { args },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'no-growth-start',
        args,
      },
      output,
    )

    expect(output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]).toBe(
      undefined,
    )
    expect(output.output).toContain('unit-active')
  })

  test('replays an expanded parent declaration without becoming unavailable', async () => {
    // `repositoryRevisionDigest`/`worktreeRevisionDigest` are required by
    // `OperationObserverSnapshot`; the fixture previously omitted them,
    // which typed at runtime as `undefined` rather than a real digest. They
    // are filled in here with matching placeholder hex strings so the
    // snapshot shape is honest instead of relying on optional fields.
    const source = createAdapter(
      'observe',
      false,
      sequenceObserver([
        {
          targetDigest: 'a'.repeat(64),
          repositoryRevisionDigest: 'a'.repeat(64),
          worktreeRevisionDigest: 'a'.repeat(64),
        },
      ]),
      [],
      undefined,
      undefined,
      true,
    )
    const skillOutput: RecordedToolOutput = {
      title: 'skill',
      output: 'loaded',
      metadata: {},
    }
    await observeSkill(
      source,
      'systematic_skill',
      'ce:work',
      'replay-skill',
      SESSION_A,
      skillOutput,
    )
    const startOutput: RecordedToolOutput = {
      title: 'start',
      output: 'started',
      metadata: {},
    }
    const startArgs = { expected_operations: ['commit'] }
    await source.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'replay-start',
      },
      { args: startArgs },
    )
    await source.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'replay-start',
        args: startArgs,
      },
      startOutput,
    )

    const markers = [
      skillOutput.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
      startOutput.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
    ].flatMap((value) => (Array.isArray(value) ? value : [value]))
    const parts = [
      {
        info: {},
        parts: [
          {
            state: {
              metadata: {
                [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: markers,
              },
            },
          },
        ],
      },
    ]
    // Same fixture-typing fix as above: real (placeholder) revision digests
    // instead of the previously-omitted, effectively-undefined fields.
    const restored = createAdapter(
      'observe',
      false,
      sequenceObserver([
        {
          targetDigest: 'a'.repeat(64),
          repositoryRevisionDigest: 'a'.repeat(64),
          worktreeRevisionDigest: 'a'.repeat(64),
        },
      ]),
      [],
      undefined,
      {
        readSessionParts: async () => parts,
        listChildren: async () => [],
      },
      true,
    )
    await getTool(restored, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )

    expect(status(restored)).toMatchObject({
      state: 'waiting',
      missingOperations: ['implementation', 'verification', 'commit'],
    })
    expect(status(restored).reasonCode).not.toBe('guard-unavailable')
  })

  describe('guarded skill allowlist', () => {
    const SKILL_TOOLS = ['skill', 'systematic_skill'] as const

    interface AllowlistedSkill {
      readonly name: string
      readonly family: 'work' | 'shipping'
      readonly requiredOperations: readonly ReceiptOperation[]
    }

    // Literal expectations, deliberately not derived from the production
    // TRUSTED_SKILL_POLICIES table so that a drifted policy row fails here.
    const ALLOWLISTED_SKILLS: readonly AllowlistedSkill[] = [
      {
        name: 'ce:work',
        family: 'work',
        requiredOperations: ['implementation', 'verification'],
      },
      {
        name: 'systematic:ce:work',
        family: 'work',
        requiredOperations: ['implementation', 'verification'],
      },
      {
        name: 'git-commit',
        family: 'shipping',
        requiredOperations: ['implementation', 'verification', 'commit'],
      },
      {
        name: 'systematic:git-commit',
        family: 'shipping',
        requiredOperations: ['implementation', 'verification', 'commit'],
      },
      {
        name: 'git-commit-push-pr',
        family: 'shipping',
        requiredOperations: [
          'implementation',
          'verification',
          'commit',
          'push',
          'pr-creation',
          'check-readback',
          'review-readback',
        ],
      },
      {
        name: 'systematic:git-commit-push-pr',
        family: 'shipping',
        requiredOperations: [
          'implementation',
          'verification',
          'commit',
          'push',
          'pr-creation',
          'check-readback',
          'review-readback',
        ],
      },
    ]

    function receiptMarkers(output: RecordedToolOutput): unknown {
      return output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    }

    async function loadSkill(
      adapter: OpencodeWorkflowGuard,
      tool: 'systematic_skill' | 'skill',
      name: string,
      callID = `${tool}-${name}`,
      output: RecordedToolOutput = {
        title: 'Loaded skill',
        output: 'skill result',
        metadata: {},
      },
    ): Promise<RecordedToolOutput> {
      await observeSkill(adapter, tool, name, callID, SESSION_A, output)
      return output
    }

    async function statusDocument(
      adapter: OpencodeWorkflowGuard,
    ): Promise<Record<string, unknown>> {
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      return JSON.parse(expectToolOutput(result).output)
    }

    test.each(
      ['ce:brainstorm', 'ce:review'].flatMap((name) =>
        SKILL_TOOLS.map((tool) => ({ name, tool })),
      ),
    )(
      '$tool loading non-allowlisted $name in an inactive session is a no-op',
      async ({ name, tool }) => {
        const adapter = createAdapter('observe')
        const output = await loadSkill(adapter, tool, name)

        expect(status(adapter)).toMatchObject({
          state: 'inactive',
          reasonCode: 'no-active-epoch',
          epoch: null,
          unit: null,
        })
        expect(receiptMarkers(output)).toBeUndefined()
        const document = await statusDocument(adapter)
        expect(document.seedDeferrals).toBeUndefined()
        expect(document.firstUnavailableCause).toBeUndefined()
      },
    )

    test.each(
      ALLOWLISTED_SKILLS.flatMap((skill) =>
        SKILL_TOOLS.map((tool) => ({ ...skill, tool })),
      ),
    )(
      '$tool loading allowlisted $name activates the $family family with its literal operations',
      async ({ name, tool, family, requiredOperations }) => {
        const adapter = createAdapter('observe')
        const output = await loadSkill(adapter, tool, name)

        expect(status(adapter).epoch?.family).toBe(family)
        expect(status(adapter).unit?.requiredOperations).toEqual(
          requiredOperations,
        )
        expect(receiptMarkers(output)).toBeDefined()
      },
    )

    test('loading ce:review mid-work with a completed unit starts no new unit', async () => {
      const adapter = createAdapter('observe')
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      mintReceipt(adapter, 'implementation')
      mintReceipt(adapter, 'verification')
      await completeUnit(adapter, 'allowlist-complete-unit')
      const before = status(adapter)
      expect(before.unit?.status).toBe('completed')

      for (const tool of SKILL_TOOLS) {
        const output = await loadSkill(adapter, tool, 'ce:review')
        expect(receiptMarkers(output)).toBeUndefined()
      }

      expect(status(adapter)).toEqual(before)
    })

    test('loading ce:review during an active shipping epoch is not a family conflict', async () => {
      const adapter = createAdapter('observe')
      await observeSkill(adapter, 'skill', 'git-commit-push-pr')
      const before = status(adapter)
      const beforeDocument = await statusDocument(adapter)
      expect(before.epoch?.family).toBe('shipping')

      for (const tool of SKILL_TOOLS) {
        const output = await loadSkill(adapter, tool, 'ce:review')
        expect(receiptMarkers(output)).toBeUndefined()
      }

      expect(status(adapter)).toEqual(before)
      expect(status(adapter).reasonCode).not.toBe('family-conflict')
      expect(await statusDocument(adapter)).toEqual(beforeDocument)
    })

    test.each([
      {
        label: 'protected',
        state: 'protected',
        build: async () => {
          const adapter = createAdapter('protected')
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          mintReceipt(adapter, 'implementation')
          mintReceipt(adapter, 'verification')
          return adapter
        },
      },
      {
        label: 'waiting',
        state: 'waiting',
        build: async () => {
          const adapter = createAdapter('observe')
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          return adapter
        },
      },
      {
        label: 'rejected',
        state: 'rejected',
        build: async () => {
          const adapter = createAdapter('observe')
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          adapter.observeReceipt(SESSION_A, { not: 'a receipt' })
          return adapter
        },
      },
      {
        label: 'unavailable',
        state: 'unavailable',
        build: async () => {
          const adapter = createAdapter('observe')
          await adapter.hooks['tool.execute.before'](
            {
              tool: 'systematic_skill',
              sessionID: SESSION_A,
              callID: 'unavailable-swap',
            },
            { args: { name: 'ce:work' } },
          )
          await adapter.hooks['tool.execute.after'](
            {
              tool: 'systematic_skill',
              sessionID: SESSION_A,
              callID: 'unavailable-swap',
              args: { name: 'git-commit' },
            },
            { title: 'x', output: 'y', metadata: {} },
          )
          return adapter
        },
      },
    ] as const)(
      'loading ce:review leaves the $label state and unavailable cause unchanged',
      async ({ state, build }) => {
        const adapter = await build()
        const before = status(adapter)
        const beforeDocument = await statusDocument(adapter)
        expect(before.state).toBe(state)

        for (const tool of SKILL_TOOLS) {
          const output = await loadSkill(adapter, tool, 'ce:review')
          expect(receiptMarkers(output)).toBeUndefined()
        }

        expect(status(adapter)).toEqual(before)
        const afterDocument = await statusDocument(adapter)
        expect(afterDocument.firstUnavailableCause).toEqual(
          beforeDocument.firstUnavailableCause,
        )
        expect(afterDocument).toEqual(beforeDocument)
      },
    )

    test.each(
      ['constructor', 'toString', '__proto__'].flatMap((name) =>
        SKILL_TOOLS.map((tool) => ({ name, tool })),
      ),
    )(
      '$tool loading inherited-property name $name activates nothing',
      async ({ name, tool }) => {
        const adapter = createAdapter('observe')
        const output = await loadSkill(adapter, tool, name)

        expect(status(adapter)).toMatchObject({
          state: 'inactive',
          reasonCode: 'no-active-epoch',
          epoch: null,
          unit: null,
        })
        expect(receiptMarkers(output)).toBeUndefined()
      },
    )

    test('an allowlisted ce:work load whose after output exceeds 32 KB still activates', async () => {
      const adapter = createAdapter('observe')
      const output = await loadSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'oversized-ce-work',
        { title: 'Loaded skill', output: 'x'.repeat(32_769), metadata: {} },
      )

      expect(status(adapter).epoch?.family).toBe('work')
      expect(status(adapter).unit?.requiredOperations).toEqual([
        'implementation',
        'verification',
      ])
      expect(receiptMarkers(output)).toBeDefined()
    })

    test('a session that only loads ce:review is rejected by workflow start with no-active-epoch', async () => {
      const adapter = createAdapter('observe')
      await loadSkill(adapter, 'systematic_skill', 'ce:review')

      const startOutput = {
        title: 'pending',
        output: 'pending',
        metadata: {},
      }
      const startInput = {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'start-after-review-only',
      }
      await adapter.hooks['tool.execute.before'](startInput, { args: {} })
      await adapter.hooks['tool.execute.after'](
        { ...startInput, args: {} },
        startOutput,
      )

      expect(startOutput.output).toContain('no-active-epoch')
      expect(startOutput.metadata).toMatchObject({
        state: 'inactive',
        workflowGuard: {
          status: 'rejected',
          reasonCode: 'no-active-epoch',
        },
      })
      expect(status(adapter)).toMatchObject({
        state: 'inactive',
        reasonCode: 'no-active-epoch',
        epoch: null,
      })
    })

    test('a callID whose before-hook names ce:work and after-hook names git-commit still records call-lifecycle-mismatch', async () => {
      const adapter = createAdapter('observe')
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'allowlist-swap',
        },
        { args: { name: 'ce:work' } },
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'allowlist-swap',
          args: { name: 'git-commit' },
        },
        { title: 'x', output: 'y', metadata: {} },
      )

      expect((await statusDocument(adapter)).firstUnavailableCause).toEqual({
        site: 'tool-after',
        kind: 'call-lifecycle-mismatch',
        timedOut: false,
      })
      expect(status(adapter).state).toBe('unavailable')
    })
  })

  test('activates from successful systematic and native skill after events only', async () => {
    const systematic = createAdapter()
    await observeSkill(systematic, 'systematic_skill', 'ce:work')
    expect(status(systematic).epoch?.family).toBe('work')

    const native = createAdapter()
    await observeSkill(native, 'skill', 'systematic:git-commit-push-pr')
    expect(status(native).epoch?.family).toBe('shipping')
  })

  test('does not activate from failed, unrelated, malformed, prose, guard, or todo events', async () => {
    const adapter = createAdapter()
    const events: Array<{
      tool: string
      args: unknown
      output?: unknown
    }> = [
      { tool: 'systematic_skill', args: { name: 'ce:work' } },
      { tool: 'systematic_skill', args: { name: 'merge' } },
      { tool: 'systematic_skill', args: { name: 'ce:work prose' } },
      { tool: 'systematic_workflow_start', args: {} },
      { tool: 'todowrite', args: { todos: [] } },
    ]

    for (const [index, event] of events.entries()) {
      await adapter.hooks['tool.execute.before'](
        {
          tool: event.tool,
          sessionID: 'session-1',
          callID: `call-${index}`,
        },
        { args: event.args },
      )
      if (event.tool === 'systematic_skill') {
        await adapter.hooks['tool.execute.after'](
          {
            tool: event.tool,
            sessionID: 'session-1',
            callID: `call-${index}`,
            args: event.args,
          },
          event.output ?? {
            title: '',
            output: '',
            metadata: { status: 'failure' },
          },
        )
      }
    }

    expect(status(adapter).epoch).toBeNull()
  })

  test('failed skill after payloads and duplicate after delivery are bounded and idempotent', async () => {
    const adapter = createAdapter()
    await adapter.hooks['tool.execute.before'](
      { tool: 'systematic_skill', sessionID: 'session-1', callID: 'failed' },
      { args: { name: 'ce:work' } },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_skill',
        sessionID: 'session-1',
        callID: 'failed',
        args: {},
      },
      { title: 'error', output: '', metadata: { status: 'failure' } },
    )
    expect(status(adapter).epoch).toBeNull()

    await observeSkill(adapter, 'systematic_skill', 'ce:work', 'successful')
    const epochId = status(adapter).epoch?.epochId
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_skill',
        sessionID: 'session-1',
        callID: 'successful',
        args: { name: 'ce:work' },
      },
      { title: 'Loaded skill', output: 'skill result', metadata: {} },
    )
    expect(status(adapter).epoch?.epochId).toBe(epochId)
  })

  test('registers exactly the four workflow tools with structural schemas', () => {
    const adapter = createAdapter()
    expect(Object.keys(adapter.tools)).toEqual([
      'systematic_workflow_start',
      'systematic_workflow_status',
      'systematic_workflow_complete',
      'systematic_workflow_control',
    ])
    for (const tool of Object.values(adapter.tools)) {
      expect(tool.description).toBeString()
      expect(tool.args).toBeDefined()
      expect(tool.execute).toBeFunction()
    }
  })

  test('exposes raw host argument shapes and structured bounded tool results', async () => {
    const adapter = createAdapter()
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    const expectedShapes = {
      systematic_workflow_start: ['expected_operations', 'resource_scopes'],
      systematic_workflow_status: [],
      systematic_workflow_complete: ['target'],
      systematic_workflow_control: ['mode'],
    }
    for (const [id, keys] of Object.entries(expectedShapes)) {
      const args = getTool(adapter, id).args as Record<string, unknown>
      expect(Object.keys(args).sort()).toEqual([...keys].sort())
      expect(() => z.object(args).strict()).not.toThrow()
      for (const value of Object.values(args)) {
        expect(value).toHaveProperty('_def')
      }
    }

    const result = await getTool(adapter, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    expect(result).toMatchObject({
      title: expect.any(String),
      output: expect.any(String),
      metadata: {
        protocolVersion: expect.any(Number),
        sourceDigest: expect.any(String),
        statusDigest: expect.any(String),
        state: expect.any(String),
        enforcement: 'protected',
      },
    })
  })

  test('start and status tools are non-authoritative while control requires attestation', async () => {
    const adapter = createAdapter()
    const start = await getTool(adapter, 'systematic_workflow_start').execute(
      { expected_operations: ['commit'] },
      toolContext(),
    )
    const statusBefore = status(adapter)
    const statusOutput = await getTool(
      adapter,
      'systematic_workflow_status',
    ).execute({}, toolContext())
    const control = await getTool(
      adapter,
      'systematic_workflow_control',
    ).execute({ mode: 'disabled' }, toolContext())

    expect(expectToolOutput(start).output).toContain('pending')
    expect(expectToolOutput(statusOutput).output).toContain(statusBefore.state)
    expect(expectToolOutput(control).output).toContain('question-attestation')
    expect(status(adapter).epoch).toBeNull()
  })

  test('protected completion vetoes blocked execution while observe records without vetoing', async () => {
    const protectedAdapter = createAdapter('protected')
    await observeSkill(protectedAdapter, 'systematic_skill', 'ce:work')
    await expect(
      protectedAdapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_complete',
          sessionID: 'session-1',
          callID: 'protected-complete',
        },
        { args: { target: 'unit' } },
      ),
    ).rejects.toThrow()

    const observeAdapter = createAdapter('observe')
    await observeSkill(observeAdapter, 'systematic_skill', 'ce:work')
    await expect(
      observeAdapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_complete',
          sessionID: 'session-1',
          callID: 'observe-complete',
        },
        { args: { target: 'unit' } },
      ),
    ).resolves.toBeUndefined()
    await observeAdapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: 'session-1',
        callID: 'observe-complete',
        args: { target: 'unit' },
      },
      { title: 'complete', output: 'selected result', metadata: {} },
    )
    expect(status(observeAdapter).state).toBe('waiting')
  })

  test('uses a tagged plain Error for protected vetoes', async () => {
    const protectedAdapter = createAdapter('protected')
    await observeSkill(protectedAdapter, 'systematic_skill', 'ce:work')

    let caught: unknown
    try {
      await protectedAdapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_complete',
          sessionID: SESSION_A,
          callID: 'tagged-block',
        },
        { args: { target: 'unit' } },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(isWorkflowGuardBlockedError(caught)).toBe(true)
    const tagged = caught as {
      code: string
      reasonCode: string
      message: string
      name: string
    }
    expect(tagged.code).toBe('workflow-guard-blocked')
    expect(tagged.reasonCode).toBe('guard-unavailable')
    expect(tagged.message).toBe('workflow guard blocked')
    expect(tagged.name).toBe('WorkflowGuardBlockedError')
    expect(isWorkflowGuardBlockedError(new Error('ordinary failure'))).toBe(
      false,
    )
    expect(
      isWorkflowGuardBlockedError(
        createWorkflowGuardBlockedError('missing-evidence'),
      ),
    ).toBe(true)
  })

  test('native question flow binds and accepts only a correlated affirmative reply', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    expect(adapter.status(SESSION_A).repair).toBe('fresh-readback')

    const completeOutput = {
      title: 'complete',
      output: 'complete',
      metadata: {},
    }
    await adapter.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'complete-question',
      },
      { args: { target: 'unit' } },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'complete-question',
        args: { target: 'unit' },
      },
      completeOutput,
    )
    expect(completeOutput.output).toContain('question-attestation')
    expect(JSON.parse(completeOutput.output).questions).toEqual([
      {
        header: 'Confirm',
        question: 'Confirm the requested guarded transition.',
        options: [
          { label: 'yes', description: 'Confirm the guarded transition.' },
          { label: 'no', description: 'Decline the guarded transition.' },
        ],
      },
    ])

    const questionOutput = { args: {} as Record<string, unknown> }
    await adapter.hooks['tool.execute.before'](
      { tool: 'question', sessionID: SESSION_A, callID: 'question-call' },
      questionOutput,
    )
    expect(questionOutput.args).toMatchObject({
      questions: [
        {
          question: 'Confirm the requested guarded transition.',
          options: [{ label: 'yes' }, { label: 'no' }],
        },
      ],
    })
    await observeQuestionEvent(adapter, 'question.asked', {
      id: 'request-1',
      sessionID: SESSION_A,
      questions: [],
      tool: { messageID: 'message-1', callID: 'question-call' },
    })
    await observeQuestionEvent(adapter, 'question.replied', {
      sessionID: SESSION_A,
      requestID: 'request-1',
      answers: [['yes']],
    })

    const status = await getTool(adapter, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    expect(expectToolOutput(status).metadata).toMatchObject({
      questionAttestation: { status: 'attested', requestId: 'request-1' },
    })
  })

  test('ambiguous question replies and uncorrelated replies never attest', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    const output = { args: {} as Record<string, unknown> }
    await adapter.hooks['tool.execute.before'](
      { tool: 'question', sessionID: SESSION_A, callID: 'question-call' },
      output,
    )
    await observeQuestionEvent(adapter, 'question.asked', {
      id: 'request-1',
      sessionID: SESSION_A,
      questions: [],
      tool: { callID: 'question-call' },
    })
    await observeQuestionEvent(adapter, 'question.replied', {
      sessionID: SESSION_B,
      requestID: 'request-1',
      answers: [['yes']],
    })
    await observeQuestionEvent(adapter, 'question.replied', {
      sessionID: SESSION_A,
      requestID: 'request-1',
      answers: [['maybe']],
    })
    const status = adapter.status(SESSION_A)
    expect(status.reasonCode).not.toBe('unit-ready')
    expect(JSON.stringify(status)).not.toContain('maybe')
  })

  test('session disablement requires the native question reply', async () => {
    const adapter = createAdapter('observe')
    const first = await getTool(adapter, 'systematic_workflow_control').execute(
      { mode: 'disabled' },
      toolContext(),
    )
    expect(expectToolOutput(first).output).toContain('question-attestation')
    expect(adapter.status(SESSION_A).state).not.toBe('disabled')

    const questionOutput = { args: {} as Record<string, unknown> }
    await adapter.hooks['tool.execute.before'](
      { tool: 'question', sessionID: SESSION_A, callID: 'disable-question' },
      questionOutput,
    )
    await observeQuestionEvent(adapter, 'question.asked', {
      id: 'disable-request',
      sessionID: SESSION_A,
      questions: [],
      tool: { callID: 'disable-question' },
    })
    await observeQuestionEvent(adapter, 'question.replied', {
      sessionID: SESSION_A,
      requestID: 'disable-request',
      answers: [['confirm']],
    })
    const second = await getTool(
      adapter,
      'systematic_workflow_control',
    ).execute({ mode: 'disabled' }, toolContext())
    expect(expectToolOutput(second).output).toContain('disabled')
    expect(adapter.status(SESSION_A).state).toBe('disabled')
  })

  test('independent registrations finalize the same selected transition idempotently', async () => {
    const first = createAdapter('protected')
    const second = createAdapter('protected')
    await observeSkill(first, 'systematic_skill', 'ce:work')
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')

    const beforeInput = {
      tool: 'systematic_workflow_complete',
      sessionID: 'session-1',
      callID: 'selected-complete',
    }
    await first.hooks['tool.execute.before'](beforeInput, {
      args: { target: 'unit' },
    })
    await second.hooks['tool.execute.before'](beforeInput, {
      args: { target: 'unit' },
    })

    const hostOutput = { title: 'selected', output: 'result', metadata: {} }
    let selectedExecutions = 0
    const selectedExecute = async () => {
      selectedExecutions += 1
      return getTool(first, 'systematic_workflow_complete').execute(
        { target: 'unit' },
        toolContext(SESSION_A),
      )
    }
    const selectedResult = await selectedExecute()
    Object.assign(hostOutput, selectedResult)
    const afterInput = { ...beforeInput, args: { target: 'unit' } }
    await first.hooks['tool.execute.after'](afterInput, hostOutput)
    await second.hooks['tool.execute.after'](afterInput, hostOutput)
    await first.hooks['tool.execute.after'](afterInput, hostOutput)
    await second.hooks['tool.execute.after'](afterInput, hostOutput)

    expect(status(first).unit?.status).toBe('completed')
    expect(status(second).unit?.status).toBe('completed')
    expect(selectedExecutions).toBe(1)
    expect(hostOutput.title).toBe('Workflow transition completed')
    expect(hostOutput.metadata).toEqual({
      protocolVersion: expect.any(Number),
      sourceDigest: expect.any(String),
      statusDigest: expect.any(String),
      state: 'protected',
      reasonCode: expect.any(String),
      enforcement: 'protected',
      workflowGuard: { status: 'completed', target: 'unit' },
    })
    expect(
      ledger(first)
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(true)
  })

  test('a later protected registration vetoes before selected execution without consumption', async () => {
    const ready = createAdapter('protected')
    const blocked = createAdapter('protected')
    await observeSkill(ready, 'systematic_skill', 'ce:work')
    await observeSkill(blocked, 'systematic_skill', 'ce:work')
    mintReceipt(ready, 'implementation')
    mintReceipt(ready, 'verification')
    const sharedCallID = 'shared-complete'
    await ready.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: 'session-1',
        callID: sharedCallID,
      },
      { args: { target: 'unit' } },
    )
    let selectedExecutions = 0
    const selectedExecute = async () => {
      selectedExecutions += 1
      return getTool(ready, 'systematic_workflow_complete').execute(
        { target: 'unit' },
        toolContext(SESSION_A),
      )
    }
    await expect(
      (async () => {
        await blocked.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_complete',
            sessionID: 'session-1',
            callID: sharedCallID,
          },
          { args: { target: 'unit' } },
        )
        await selectedExecute()
      })(),
    ).rejects.toThrow()
    expect(selectedExecutions).toBe(0)
    expect(status(ready).unit?.status).toBe('active')
    expect(
      ledger(ready)
        .listReceipts()
        .some((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(false)
    await ready.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      { system: ['readback'] },
    )
    await ready.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'fresh-complete',
      },
      { args: { target: 'unit' } },
    )
  })

  test('disabled mode is visible and does not activate or mutate from tool calls', async () => {
    const adapter = createAdapter('disabled')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await getTool(adapter, 'systematic_workflow_start').execute(
      {},
      toolContext(),
    )
    expect(status(adapter)).toMatchObject({ state: 'disabled', epoch: null })
  })

  test('missing-after completion is abandoned on readback and duplicate after cannot advance twice', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await adapter.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: 'session-1',
        callID: 'missing-after',
      },
      { args: { target: 'unit' } },
    )
    const before = status(adapter)
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      { system: ['base'] },
    )
    expect(status(adapter).unit?.status).toBe(before.unit?.status)
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: 'session-1',
        callID: 'missing-after',
        args: { target: 'unit' },
      },
      { title: 'late', output: 'late', metadata: {} },
    )
    expect(status(adapter).unit?.status).toBe('active')
  })

  test('after failures never throw and make the source unavailable', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: 'session-1',
        callID: 'unprepared',
        args: { target: 'unit' },
      },
      undefined,
    )
    expect(status(adapter).state).toBe('unavailable')
  })

  test('isolates activation, evidence, and transition state by explicit session', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(
      adapter,
      'systematic_skill',
      'ce:work',
      'work-a',
      SESSION_A,
    )
    expect(status(adapter, SESSION_A).epoch).not.toBeNull()
    expect(status(adapter, SESSION_B).epoch).toBeNull()

    mintReceipt(adapter, 'implementation', SESSION_A)
    const receipt = ledger(adapter, SESSION_A).listReceipts()[0]
    expect(receipt).toBeDefined()
    expect(adapter.observeReceipt(SESSION_B, receipt)).toMatchObject({
      status: 'rejected',
    })
    expect(status(adapter, SESSION_B).epoch).toBeNull()

    const prepared = adapter.prepareTransition(SESSION_A, {
      callId: 'shared-transition',
      target: 'unit',
    })
    expect(prepared.status).not.toBe('allowed')
    expect(
      adapter.prepareTransition(SESSION_B, {
        callId: 'shared-transition',
        target: 'unit',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'no-active-epoch' })
  })

  test('requires valid session identities and does not alias missing tool contexts', async () => {
    const adapter = createAdapter()
    await adapter.hooks['tool.execute.before'](
      { tool: 'systematic_skill', sessionID: '', callID: 'missing-session' },
      { args: { name: 'ce:work' } },
    )
    await getTool(adapter, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    expect(status(adapter, SESSION_A).epoch).toBeNull()
    expect(status(adapter, '').state).toBe('unavailable')
    expect(adapter.ledger('')).toBeUndefined()
  })

  test('same-session conflicting skill or start intent seals the session unavailable', async () => {
    const adapter = createAdapter()
    await adapter.hooks['tool.execute.before'](
      { tool: 'systematic_skill', sessionID: SESSION_A, callID: 'conflict' },
      { args: { name: 'ce:work' } },
    )
    await adapter.hooks['tool.execute.before'](
      { tool: 'systematic_skill', sessionID: SESSION_A, callID: 'conflict' },
      { args: { name: 'git-commit' } },
    )
    expect(status(adapter).state).toBe('unavailable')

    const second = createAdapter()
    await second.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'start-conflict',
      },
      { args: { expected_operations: ['commit'] } },
    )
    await second.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'start-conflict',
      },
      { args: { expected_operations: ['push'] } },
    )
    expect(status(second).state).toBe('unavailable')
  })

  test('final skill, start, and complete args must match their before fingerprints', async () => {
    const skill = createAdapter('observe')
    await skill.hooks['tool.execute.before'](
      {
        tool: 'systematic_skill',
        sessionID: SESSION_A,
        callID: 'skill-mismatch',
      },
      { args: { name: 'ce:work' } },
    )
    await skill.hooks['tool.execute.after'](
      {
        tool: 'systematic_skill',
        sessionID: SESSION_A,
        callID: 'skill-mismatch',
        args: { name: 'git-commit' },
      },
      { title: 'loaded', output: 'ok', metadata: {} },
    )
    expect(status(skill).state).toBe('unavailable')
    expect(status(skill).epoch).toBeNull()

    const start = createAdapter('observe')
    await start.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'start-mismatch',
      },
      { args: { expected_operations: ['commit'] } },
    )
    await start.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'start-mismatch',
        args: { expected_operations: ['push'] },
      },
      { title: 'started', output: 'ok', metadata: {} },
    )
    expect(status(start).state).toBe('unavailable')
    expect(status(start).epoch).toBeNull()

    const complete = createAdapter('observe')
    await observeSkill(complete, 'systematic_skill', 'ce:work')
    mintReceipt(complete, 'implementation')
    mintReceipt(complete, 'verification')
    await complete.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'complete-mismatch',
      },
      { args: { target: 'unit' } },
    )
    await complete.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'complete-mismatch',
        args: { target: 'epoch' },
      },
      { title: 'complete', output: 'ok', metadata: {} },
    )
    expect(status(complete).state).toBe('unavailable')
    expect(status(complete).unit?.status).toBe('active')
  })

  test('tool.execute.before reads args from its second (output) argument, not the first', async () => {
    // The real `ToolContext.execute()` hook signature is
    // `(args, context)`, and the plugin's `tool.execute.before` hook
    // forwards them as `(input, output)` where `output.args` carries the
    // tool arguments; `input` only carries call identity (tool/session/call
    // ID). Args placed on `input` instead are never read.
    const misplaced = createAdapter('observe')
    await observeSkill(misplaced, 'systematic_skill', 'ce:work')
    await misplaced.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'arg-contract-misplaced',
        args: { expected_operations: ['commit'] },
      },
      {},
    )
    await misplaced.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'arg-contract-misplaced',
        args: { expected_operations: ['commit'] },
      },
      { title: 'started', output: 'ok', metadata: {} },
    )
    // No pending start was ever registered, so the paired after call finds
    // nothing to complete and fails closed, leaving the skill-activated
    // unit's default required operations un-expanded by `['commit']`.
    expect(status(misplaced).state).toBe('unavailable')
    expect(status(misplaced).unit?.requiredOperations).toEqual([
      'implementation',
      'verification',
    ])

    const correct = createAdapter('observe')
    await observeSkill(correct, 'systematic_skill', 'ce:work')
    await correct.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'arg-contract-correct',
      },
      { args: { expected_operations: ['commit'] } },
    )
    await correct.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'arg-contract-correct',
        args: { expected_operations: ['commit'] },
      },
      { title: 'started', output: 'ok', metadata: {} },
    )
    expect(status(correct).state).not.toBe('unavailable')
    expect(status(correct).unit?.requiredOperations).toEqual([
      'implementation',
      'verification',
      'commit',
    ])
  })

  test('protected same-call target conflicts veto execution and mark unavailable', async () => {
    const adapter = createAdapter('protected')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    mintReceipt(adapter, 'implementation')
    mintReceipt(adapter, 'verification')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'conflicting-complete',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    await expect(
      adapter.hooks['tool.execute.before'](input, {
        args: { target: 'epoch' },
      }),
    ).rejects.toMatchObject({
      code: 'workflow-guard-blocked',
      reasonCode: 'guard-unavailable',
    })
    expect(status(adapter).state).toBe('unavailable')
  })

  test('publishes start rejection and started results in the selected host output', async () => {
    const inactive = createAdapter('observe')
    const rejectedOutput = {
      title: 'pending',
      output: 'pending',
      metadata: {},
    }
    const inactiveInput = {
      tool: 'systematic_workflow_start',
      sessionID: SESSION_A,
      callID: 'start-before-activation',
    }
    await inactive.hooks['tool.execute.before'](inactiveInput, {
      args: {},
    })
    await inactive.hooks['tool.execute.after'](
      { ...inactiveInput, args: {} },
      rejectedOutput,
    )
    expect(rejectedOutput.output).toContain('no-active-epoch')
    expect(rejectedOutput.metadata).toMatchObject({
      protocolVersion: expect.any(Number),
      state: 'inactive',
      workflowGuard: {
        status: 'rejected',
        reasonCode: 'no-active-epoch',
      },
    })

    const subsequent = createAdapter('observe')
    await observeSkill(subsequent, 'systematic_skill', 'ce:work')
    mintReceipt(subsequent, 'implementation')
    mintReceipt(subsequent, 'verification')
    const completeInput = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'complete-before-next-unit',
    }
    const completedOutput = {
      title: 'pending',
      output: 'pending',
      metadata: {},
    }
    await subsequent.hooks['tool.execute.before'](completeInput, {
      args: { target: 'unit' },
    })
    await subsequent.hooks['tool.execute.after'](
      { ...completeInput, args: { target: 'unit' } },
      completedOutput,
    )
    expect(status(subsequent).unit?.status).toBe('completed')

    const startedOutput = { title: 'pending', output: 'pending', metadata: {} }
    const startInput = {
      tool: 'systematic_workflow_start',
      sessionID: SESSION_A,
      callID: 'start-next-unit',
    }
    await subsequent.hooks['tool.execute.before'](startInput, { args: {} })
    await subsequent.hooks['tool.execute.after'](
      { ...startInput, args: {} },
      startedOutput,
    )
    expect(startedOutput.output).toContain('started')
    expect(startedOutput.metadata).toMatchObject({
      protocolVersion: expect.any(Number),
      workflowGuard: { status: 'started' },
    })
    expect(status(subsequent).unit?.status).toBe('active')
  })

  describe('completion requested with no epoch', () => {
    interface HostOutput {
      title: string
      output: string
      metadata: Record<string, unknown>
    }

    function freshOutput(): HostOutput {
      return { title: 'pending', output: 'pending', metadata: {} }
    }

    async function completeBeforeAndAfter(
      adapter: OpencodeWorkflowGuard,
      callID: string,
      target: 'unit' | 'epoch' = 'unit',
    ): Promise<HostOutput> {
      const input = {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID,
      }
      const output = freshOutput()
      await adapter.hooks['tool.execute.before'](input, { args: { target } })
      await adapter.hooks['tool.execute.after'](
        { ...input, args: { target } },
        output,
      )
      return output
    }

    for (const mode of ['observe', 'protected'] as const) {
      test(`${mode} mode writes a guard-owned rejected / no-active-epoch result and stays inactive`, async () => {
        const adapter = createAdapter(mode)
        const output = await completeBeforeAndAfter(
          adapter,
          `no-epoch-complete-${mode}`,
        )
        expect(output.metadata).toMatchObject({
          workflowGuard: {
            status: 'rejected',
            reasonCode: 'no-active-epoch',
            target: 'unit',
          },
        })
        expect(output.title).not.toContain('unavailable')
        expect(output.output).not.toContain('unavailable')
        expect(output.title).toBe('Workflow transition rejected')
        expect(status(adapter)).toMatchObject({
          state: 'inactive',
          reasonCode: 'no-active-epoch',
          epoch: null,
        })
      })
    }

    test('protected mode still throws for other blocked reasons', async () => {
      const adapter = createAdapter('protected')
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      mintReceipt(adapter, 'implementation')
      mintReceipt(adapter, 'verification')
      await completeBeforeAndAfter(adapter, 'unit-complete', 'unit')
      await completeBeforeAndAfter(adapter, 'epoch-complete', 'epoch')
      expect(status(adapter).reasonCode).toBe('epoch-completed')

      await expect(
        adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_complete',
            sessionID: SESSION_A,
            callID: 'epoch-complete-again',
          },
          { args: { target: 'epoch' } },
        ),
      ).rejects.toMatchObject({
        code: 'workflow-guard-blocked',
        reasonCode: 'epoch-completed',
      })
    })

    test('a same-batch skill activation is not recorded as no-active-epoch', async () => {
      const adapter = createAdapter('protected')
      const skillInput = {
        tool: 'systematic_skill',
        sessionID: SESSION_A,
        callID: 'batch-skill',
      }
      const completeInput = {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'batch-complete',
      }
      const skillOutput = freshOutput()
      const completeOutput = freshOutput()
      await adapter.hooks['tool.execute.before'](skillInput, {
        args: { name: 'ce:work' },
      })
      await adapter.hooks['tool.execute.before'](completeInput, {
        args: { target: 'unit' },
      })
      await adapter.hooks['tool.execute.after'](
        { ...skillInput, args: { name: 'ce:work' } },
        skillOutput,
      )
      expect(status(adapter).epoch).not.toBeNull()
      await adapter.hooks['tool.execute.after'](
        { ...completeInput, args: { target: 'unit' } },
        completeOutput,
      )
      const guardMetadata = completeOutput.metadata.workflowGuard as
        | { status: string; reasonCode: string }
        | undefined
      expect(guardMetadata?.reasonCode).not.toBe('no-active-epoch')
      expect(status(adapter).unit?.status).not.toBe('completed')
    })

    async function completeAfter(
      adapter: OpencodeWorkflowGuard,
      callID: string,
    ): Promise<HostOutput> {
      const output = freshOutput()
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_workflow_complete',
          sessionID: SESSION_A,
          callID,
          args: { target: 'unit' },
        },
        output,
      )
      return output
    }

    for (const mode of ['observe', 'protected'] as const) {
      test(`a duplicate after-hook replays the identical no-epoch rejection without a second before-hook and leaves the session inactive (${mode})`, async () => {
        const adapter = createAdapter(mode)
        const callID = `replay-no-epoch-${mode}`
        await adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_complete',
            sessionID: SESSION_A,
            callID,
          },
          { args: { target: 'unit' } },
        )
        const first = await completeAfter(adapter, callID)
        const second = await completeAfter(adapter, callID)
        expect(first.metadata).toMatchObject({
          workflowGuard: {
            status: 'rejected',
            reasonCode: 'no-active-epoch',
            target: 'unit',
          },
        })
        expect(second.metadata.workflowGuard).toEqual(
          first.metadata.workflowGuard,
        )
        expect(second.title).toBe(first.title)
        expect(second.output).toBe(first.output)
        expect(second.title).not.toContain('unavailable')
        expect(status(adapter)).toMatchObject({
          state: 'inactive',
          reasonCode: 'no-active-epoch',
        })
      })
    }

    test('a duplicate after-hook replays the write-time recheck outcome, not a false no-active-epoch', async () => {
      const adapter = createAdapter('protected')
      const skillInput = {
        tool: 'systematic_skill',
        sessionID: SESSION_A,
        callID: 'replay-batch-skill',
      }
      const completeInput = {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'replay-batch-complete',
      }
      await adapter.hooks['tool.execute.before'](skillInput, {
        args: { name: 'ce:work' },
      })
      await adapter.hooks['tool.execute.before'](completeInput, {
        args: { target: 'unit' },
      })
      await adapter.hooks['tool.execute.after'](
        { ...skillInput, args: { name: 'ce:work' } },
        freshOutput(),
      )
      expect(status(adapter).epoch).not.toBeNull()

      const first = await completeAfter(adapter, completeInput.callID)
      const second = await completeAfter(adapter, completeInput.callID)
      const firstGuard = first.metadata.workflowGuard as {
        status: string
        reasonCode: string
      }
      expect(firstGuard.reasonCode).not.toBe('no-active-epoch')
      expect(second.metadata.workflowGuard).toEqual(
        first.metadata.workflowGuard,
      )
      expect(second.title).toBe(first.title)
      expect(second.output).toBe(first.output)
      expect(status(adapter).epoch).not.toBeNull()
      expect(status(adapter).unit?.status).not.toBe('completed')
      expect(status(adapter).reasonCode).not.toBe('guard-unavailable')
    })

    test('an after-hook for a callID that never had a before-hook still takes the unreplayable path', async () => {
      const adapter = createAdapter('observe')
      const output = await completeAfter(adapter, 'never-prepared')
      expect(output.metadata).toMatchObject({
        workflowGuard: {
          status: 'unavailable',
          reasonCode: 'guard-unavailable',
        },
      })
      expect(status(adapter).state).toBe('unavailable')
    })

    test('never finalizes a transition or mints a receipt', async () => {
      for (const mode of ['observe', 'protected'] as const) {
        const adapter = createAdapter(mode)
        await completeBeforeAndAfter(adapter, `no-finalize-${mode}`)
        await completeBeforeAndAfter(adapter, `no-finalize-${mode}`)
        expect(adapter.ledger(SESSION_A)?.listReceipts() ?? []).toEqual([])
        expect(status(adapter).epoch).toBeNull()
        expect(status(adapter).state).toBe('inactive')
      }
    })
  })

  describe('status path isolation', () => {
    interface HostOutput {
      title: string
      output: string
      metadata: Record<string, unknown>
    }

    function freshOutput(): HostOutput {
      return { title: 'pending', output: 'pending', metadata: {} }
    }

    async function statusTool(adapter: OpencodeWorkflowGuard): Promise<void> {
      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )
    }

    async function transformPass(
      adapter: OpencodeWorkflowGuard,
    ): Promise<void> {
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        { system: ['base'] },
      )
    }

    function startBefore(adapter: OpencodeWorkflowGuard, callID: string) {
      return adapter.hooks['tool.execute.before'](
        { tool: 'systematic_workflow_start', sessionID: SESSION_A, callID },
        { args: {} },
      )
    }

    async function startAfter(
      adapter: OpencodeWorkflowGuard,
      callID: string,
    ): Promise<HostOutput> {
      const output = freshOutput()
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID,
          args: {},
        },
        output,
      )
      return output
    }

    async function completeFirstUnit(
      adapter: OpencodeWorkflowGuard,
    ): Promise<void> {
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      mintReceipt(adapter, 'implementation')
      mintReceipt(adapter, 'verification')
      const input = {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'complete-first-unit',
      }
      await adapter.hooks['tool.execute.before'](input, {
        args: { target: 'unit' },
      })
      await adapter.hooks['tool.execute.after'](
        { ...input, args: { target: 'unit' } },
        freshOutput(),
      )
      expect(status(adapter).unit?.status).toBe('completed')
    }

    test('a: a status call between a sibling start before- and after-hook does not discard the start', async () => {
      const adapter = createAdapter('observe')
      await completeFirstUnit(adapter)
      const ledgerBefore = ledger(adapter)

      await Promise.all([
        startBefore(adapter, 'batch-start'),
        adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_status',
            sessionID: SESSION_A,
            callID: 'batch-status',
          },
          { args: {} },
        ),
      ])
      await statusTool(adapter)
      const output = await startAfter(adapter, 'batch-start')

      expect(output.metadata).toMatchObject({
        workflowGuard: { status: 'started' },
      })
      expect(status(adapter).state).not.toBe('unavailable')
      expect(status(adapter).unit?.status).toBe('active')
      expect(ledger(adapter)).toBe(ledgerBefore)
    })

    test('b: a status call between a sibling guarded skill before- and after-hook does not lose the activation', async () => {
      const adapter = createAdapter('observe')
      const skillInput = {
        tool: 'systematic_skill',
        sessionID: SESSION_A,
        callID: 'batch-skill',
      }
      await adapter.hooks['tool.execute.before'](skillInput, {
        args: { name: 'ce:work' },
      })
      await statusTool(adapter)
      await adapter.hooks['tool.execute.after'](
        { ...skillInput, args: { name: 'ce:work' } },
        { title: 'Loaded skill', output: 'skill result', metadata: {} },
      )
      expect(status(adapter).epoch).not.toBeNull()
      expect(status(adapter)).toMatchObject({
        state: 'waiting',
        reasonCode: 'missing-evidence',
      })
    })

    test('c: a status call between a sibling complete before- and after-hook does not lose or poison the completion', async () => {
      const adapter = createAdapter('observe')
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      mintReceipt(adapter, 'implementation')
      mintReceipt(adapter, 'verification')
      const input = {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'batch-complete',
      }
      await adapter.hooks['tool.execute.before'](input, {
        args: { target: 'unit' },
      })
      await statusTool(adapter)
      const output = freshOutput()
      await adapter.hooks['tool.execute.after'](
        { ...input, args: { target: 'unit' } },
        output,
      )
      expect(output.metadata).toMatchObject({
        workflowGuard: { status: 'completed', target: 'unit' },
      })
      expect(status(adapter).state).not.toBe('unavailable')
      expect(status(adapter).unit?.status).toBe('completed')
    })

    test('d: a before-hook that never gets an after-hook keeps its pending entry across status calls; the next transform clears it', async () => {
      const adapter = createAdapter('observe')
      await completeFirstUnit(adapter)

      await startBefore(adapter, 'orphan-start')
      await statusTool(adapter)
      await statusTool(adapter)
      // Status left the entry alone, so a late after-hook still completes it.
      expect(
        (await startAfter(adapter, 'orphan-start')).metadata,
      ).toMatchObject({ workflowGuard: { status: 'started' } })

      const second = createAdapter('observe')
      await completeFirstUnit(second)
      await startBefore(second, 'orphan-start')
      await transformPass(second)
      await startAfter(second, 'orphan-start')
      expect(status(second).state).toBe('unavailable')
    })

    describe('observer readback without an epoch', () => {
      function countingObserver(behavior: 'unavailable' | 'throws'): {
        observer: OpencodeOperationObserver
        calls: () => number
      } {
        const base = sequenceObserver([operationSnapshot()])
        let calls = 0
        return {
          observer: {
            ...base,
            snapshot: async () => {
              calls += 1
              if (behavior === 'throws') throw new Error('observer exploded')
              return { status: 'unavailable', reasonCode: 'target-unavailable' }
            },
          },
          calls: () => calls,
        }
      }

      for (const behavior of ['unavailable', 'throws'] as const) {
        test(`e: status in an inactive session with a ${behavior} observer stays inactive and never reads the observer`, async () => {
          const { observer, calls } = countingObserver(behavior)
          const adapter = createAdapter('observe', false, observer)
          await statusTool(adapter)
          await statusTool(adapter)
          expect(status(adapter)).toMatchObject({
            state: 'inactive',
            reasonCode: 'no-active-epoch',
          })
          expect(calls()).toBe(0)
        })
      }

      test('e: status in an inactive session with no observer stays inactive', async () => {
        const adapter = createAdapter('observe')
        await statusTool(adapter)
        expect(status(adapter).state).toBe('inactive')
      })

      for (const behavior of ['unavailable', 'throws'] as const) {
        test(`f: status during an active epoch with a ${behavior} observer still goes unavailable with the observer-readback-failed cause`, async () => {
          const base = sequenceObserver([operationSnapshot()])
          let failing = false
          const observer: OpencodeOperationObserver = {
            ...base,
            snapshot: async () => {
              if (!failing) return base.snapshot()
              if (behavior === 'throws') throw new Error('observer exploded')
              return { status: 'unavailable', reasonCode: 'target-unavailable' }
            },
          }
          const adapter = createAdapter('observe', false, observer)
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          expect(status(adapter).state).not.toBe('unavailable')
          failing = true
          const result = await getTool(
            adapter,
            'systematic_workflow_status',
          ).execute({}, toolContext(SESSION_A))
          const parsed = JSON.parse(expectToolOutput(result).output)
          expect(parsed.state).toBe('unavailable')
          // A thrown observer has no reason code; an unavailable result
          // carries the observer's own reason code through to the cause.
          expect(parsed.firstUnavailableCause).toEqual(
            behavior === 'throws'
              ? {
                  site: 'refresh-readback',
                  kind: 'observer-readback-failed',
                  timedOut: false,
                }
              : {
                  site: 'refresh-readback',
                  kind: 'observer-readback-failed',
                  reasonCode: 'target-unavailable',
                  timedOut: false,
                },
          )
        })
      }
    })

    describe('status-refresh timeouts skip the probe and are reported', () => {
      const D = 'd'.repeat(64)
      const E = 'e'.repeat(64)
      const FRESH = 'f'.repeat(64)
      const DRIFT = '9'.repeat(64)
      const TIMEOUT = {
        status: 'unavailable' as const,
        reasonCode: 'command-timeout' as const,
      }
      const MISSING = { status: 'missing-resource' as const }
      const PR_CREATE = { command: 'gh pr create --title t --body b' }
      const prAvailable = remoteAvailable(D, E, {
        pullRequest: { identity: D, state: 'open' },
      })
      const prDrifted = remoteAvailable(DRIFT, E, {
        pullRequest: { identity: DRIFT, state: 'open' },
      })

      interface SkipFixture {
        readonly adapter: OpencodeWorkflowGuard
        setLocalTimeout(value: boolean): void
        failRemote(
          operation: RemoteOperation,
          result: OperationObserverRemoteResult | undefined,
        ): void
        resetRemoteCalls(): void
        remoteCalls(): number
        localCalls(): number
        // The Nth upcoming local snapshot call (counted from now) times out.
        timeoutLocalSnapshotOnCall(n: number): void
        // The Nth upcoming local snapshot call reports a drifted revision.
        driftLocalSnapshotOnCall(n: number): void
        // Every upcoming local snapshot fails without a timeout.
        failLocalSnapshot(how: LocalFailure | undefined): void
        // The next remote 'after' read of `operation` is held until released.
        holdRemote(operation: RemoteOperation): {
          readonly reached: Promise<void>
          release(result: OperationObserverRemoteResult): void
        }
      }

      async function runRemoteOperations(
        adapter: OpencodeWorkflowGuard,
        withPullRequest: boolean,
        pushOutput: RecordedToolOutput = {
          title: 'push',
          output: 'pushed',
          metadata: { exit: 0 },
        },
      ): Promise<void> {
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          pushOutput,
          'skip-push',
        )
        expect(status(adapter).satisfiedOperations).toContain('push')
        if (!withPullRequest) return
        await observeOperationTool(
          adapter,
          'bash',
          PR_CREATE,
          { title: 'pr', output: 'created', metadata: { exit: 0 } },
          'skip-pr',
        )
        expect(status(adapter).satisfiedOperations).toContain('pr-creation')
      }

      type LocalFailure = 'throw' | 'target-unavailable' | 'target-mismatch'

      function failedSnapshot(
        how: LocalFailure,
      ): Awaited<ReturnType<OpencodeOperationObserver['snapshot']>> {
        if (how === 'throw') throw new Error('snapshot exploded')
        if (how === 'target-mismatch') {
          return {
            status: 'available',
            snapshot: { ...operationSnapshot(), targetDigest: 'f'.repeat(64) },
          }
        }
        return { status: 'unavailable', reasonCode: how }
      }

      // Targeted failure wrappers over a healthy observer: nothing fails until
      // a test flips a flag after setup, so setup reads are always healthy.
      async function skipFixture(
        mode: 'observe' | 'protected',
        withPullRequest = false,
        sink?: { push?: RecordedToolOutput },
      ): Promise<SkipFixture> {
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
            'pr-creation:before': [MISSING],
            'pr-creation:after': [prAvailable],
          },
        )
        const reader = base.remoteSnapshot
        if (!reader) throw new Error('sequenceObserver has a remote reader')
        let localTimeout = false
        let snapshotCalls = 0
        let timeoutOnCall: number | undefined
        let driftOnCall: number | undefined
        let localFailure: LocalFailure | undefined
        let remoteCalls = 0
        const overrides = new Map<
          RemoteOperation,
          OperationObserverRemoteResult
        >()
        const holds = new Map<
          RemoteOperation,
          () => Promise<OperationObserverRemoteResult>
        >()
        const forcedSnapshot = (
          call: number,
        ):
          | Awaited<ReturnType<OpencodeOperationObserver['snapshot']>>
          | undefined => {
          if (localTimeout || call === timeoutOnCall) return TIMEOUT
          if (call !== driftOnCall) return undefined
          return {
            status: 'available',
            snapshot: operationSnapshot('e'.repeat(64), 'd'.repeat(64)),
          }
        }
        const observer: OpencodeOperationObserver = {
          ...base,
          snapshot: async () => {
            snapshotCalls += 1
            return (
              forcedSnapshot(snapshotCalls) ??
              (localFailure ? failedSnapshot(localFailure) : base.snapshot())
            )
          },
          remoteSnapshot: async (operation, phase) => {
            remoteCalls += 1
            const hold = holds.get(operation)
            if (hold && phase === 'after') {
              holds.delete(operation)
              return hold()
            }
            const override = overrides.get(operation)
            if (override && phase === 'after') return override
            return reader.call(base, operation, phase)
          },
        }
        const adapter = createAdapter(
          mode,
          false,
          observer,
          withPullRequest ? ['push', 'pr-creation'] : ['push'],
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await runRemoteOperations(adapter, withPullRequest, sink?.push)
        expect(status(adapter).state).not.toBe('unavailable')
        return {
          adapter,
          setLocalTimeout(value) {
            localTimeout = value
          },
          failRemote(operation, result) {
            if (result) overrides.set(operation, result)
            else overrides.delete(operation)
          },
          resetRemoteCalls() {
            remoteCalls = 0
          },
          remoteCalls: () => remoteCalls,
          localCalls: () => snapshotCalls,
          timeoutLocalSnapshotOnCall(n) {
            timeoutOnCall = snapshotCalls + n
          },
          driftLocalSnapshotOnCall(n) {
            driftOnCall = snapshotCalls + n
          },
          failLocalSnapshot(how) {
            localFailure = how
          },
          holdRemote(operation) {
            let release: (result: OperationObserverRemoteResult) => void =
              () => {}
            const reached = new Promise<void>((resolveReached) => {
              holds.set(
                operation,
                () =>
                  new Promise<OperationObserverRemoteResult>((resolve) => {
                    release = resolve
                    resolveReached()
                  }),
              )
            })
            return { reached, release: (result) => release(result) }
          },
        }
      }

      async function refreshed(
        adapter: OpencodeWorkflowGuard,
      ): Promise<Record<string, unknown>> {
        const result = await getTool(
          adapter,
          'systematic_workflow_status',
        ).execute({}, toolContext(SESSION_A))
        return JSON.parse(expectToolOutput(result).output)
      }

      test.each(['observe', 'protected'] as const)(
        'a: a push readback timeout after a satisfied push is skipped; the receipt stays valid and the next healthy status is clean (%s)',
        async (mode) => {
          const fx = await skipFixture(mode)
          const before = status(fx.adapter)
          fx.failRemote('push', TIMEOUT)

          const parsed = await refreshed(fx.adapter)
          expect(parsed.state).not.toBe('unavailable')
          expect(parsed.state).toBe(before.state)
          expect(parsed.firstUnavailableCause).toBeUndefined()
          expect(parsed.unconfirmedReadbacks).toEqual([
            { probe: 'push', reasonCode: 'command-timeout' },
          ])
          expect(status(fx.adapter).satisfiedOperations).toContain('push')
          expect(status(fx.adapter).reasonCode).toBe(before.reasonCode)
          expect(status(fx.adapter).reasonCode).not.toBe('stale-receipt')

          fx.failRemote('push', undefined)
          const healthy = await refreshed(fx.adapter)
          expect('unconfirmedReadbacks' in healthy).toBe(false)
          expect(healthy.state).toBe(before.state)
          expect(status(fx.adapter).satisfiedOperations).toContain('push')
          expect(status(fx.adapter).reasonCode).not.toBe('stale-receipt')
        },
      )

      test('b: a local snapshot timeout is skipped: no remote probe runs, nothing changes, and the list is [local, then each satisfied remote operation]', async () => {
        const fx = await skipFixture('observe', true)
        const before = status(fx.adapter)
        fx.resetRemoteCalls()
        fx.setLocalTimeout(true)

        const parsed = await refreshed(fx.adapter)
        expect(parsed.state).not.toBe('unavailable')
        expect(parsed.firstUnavailableCause).toBeUndefined()
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'local', reasonCode: 'command-timeout' },
          { probe: 'push', reasonCode: 'command-timeout' },
          { probe: 'pr-creation', reasonCode: 'command-timeout' },
        ])
        expect(fx.remoteCalls()).toBe(0)
        const after = status(fx.adapter)
        expect(after.state).toBe(before.state)
        expect(after.reasonCode).toBe(before.reasonCode)
        expect(after.satisfiedOperations).toEqual(before.satisfiedOperations)
        expect(after.missingOperations).toEqual(before.missingOperations)
      })

      test('b: a local snapshot timeout with no satisfied remote operation lists exactly [local]', async () => {
        const base = sequenceObserver([operationSnapshot()])
        let remoteCalls = 0
        let timeout = false
        const adapter = createAdapter('observe', false, {
          ...base,
          snapshot: async () => (timeout ? TIMEOUT : base.snapshot()),
          remoteSnapshot: async (operation, phase) => {
            remoteCalls += 1
            return (
              base.remoteSnapshot?.(operation, phase) ?? {
                status: 'missing-resource',
              }
            )
          },
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect(status(adapter).satisfiedOperations).toEqual([])
        timeout = true

        const parsed = await refreshed(adapter)
        expect(parsed.state).not.toBe('unavailable')
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'local', reasonCode: 'command-timeout' },
        ])
        expect(remoteCalls).toBe(0)
      })

      test('c: a pinned snapshot timeout is skipped and the list is [pinned]', async () => {
        const setup = await createPinnedRecoveryAdapter()
        try {
          const { adapter } = setup
          const before = status(adapter)
          setup.timeoutPinnedSnapshotOnCall(1)

          const parsed = await refreshed(adapter)
          expect(parsed.state).not.toBe('unavailable')
          expect(parsed.firstUnavailableCause).toBeUndefined()
          expect(parsed.unconfirmedReadbacks).toEqual([
            { probe: 'pinned', reasonCode: 'command-timeout' },
          ])
          expect(status(adapter).state).toBe(before.state)

          const healthy = await refreshed(adapter)
          expect('unconfirmedReadbacks' in healthy).toBe(false)
        } finally {
          setup.fixture.cleanup()
        }
      })

      // The pinned recovery fixture has no satisfied remote operation, so the
      // pinned skips list only [pinned]; the remote tail is covered by b above.
      test('c: a pinned lookup timeout is skipped and the list is [pinned]', async () => {
        const setup = await createPinnedRecoveryAdapter()
        try {
          const { adapter } = setup
          const before = status(adapter)
          setup.setTargetValidationAvailable(false, 'command-timeout')

          const parsed = await refreshed(adapter)
          expect(parsed.state).not.toBe('unavailable')
          expect(parsed.firstUnavailableCause).toBeUndefined()
          expect(parsed.unconfirmedReadbacks).toEqual([
            { probe: 'pinned', reasonCode: 'command-timeout' },
          ])
          expect(status(adapter).state).toBe(before.state)

          setup.setTargetValidationAvailable(true)
          const healthy = await refreshed(adapter)
          expect('unconfirmedReadbacks' in healthy).toBe(false)
          expect(healthy.state).not.toBe('unavailable')
        } finally {
          setup.fixture.cleanup()
        }
      })

      test('d: with two satisfied remote operations, the timed-out one stays valid, the drifted one goes stale, and only the timed-out one is listed', async () => {
        const fx = await skipFixture('observe', true)
        fx.failRemote('push', TIMEOUT)
        fx.failRemote('pr-creation', prDrifted)

        const parsed = await refreshed(fx.adapter)
        expect(parsed.state).not.toBe('unavailable')
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'push', reasonCode: 'command-timeout' },
        ])
        expect(status(fx.adapter).satisfiedOperations).toContain('push')
        expect(status(fx.adapter).satisfiedOperations).not.toContain(
          'pr-creation',
        )
        expect(status(fx.adapter).missingOperations).toContain('pr-creation')
        expect(status(fx.adapter).missingOperations).not.toContain('push')

        // A later refresh never clears the staleness: the stale operation is
        // no longer satisfied, so it is not probed again, and the timed-out
        // push is still listed on its own.
        fx.failRemote('pr-creation', TIMEOUT)
        const again = await refreshed(fx.adapter)
        expect(again.unconfirmedReadbacks).toEqual([
          { probe: 'push', reasonCode: 'command-timeout' },
        ])
        expect(status(fx.adapter).satisfiedOperations).not.toContain(
          'pr-creation',
        )
        expect(status(fx.adapter).missingOperations).toContain('pr-creation')
      })

      test('e: a timeout followed by a non-timeout failure is fatal with the typed cause, and the skipped probe is still listed', async () => {
        const fx = await skipFixture('observe', true)
        fx.failRemote('push', TIMEOUT)
        fx.failRemote('pr-creation', {
          status: 'unavailable',
          reasonCode: 'remote-command-failed',
        })

        const parsed = await refreshed(fx.adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'refresh-readback',
          kind: 'observer-readback-failed',
          reasonCode: 'remote-command-failed',
          timedOut: false,
        })
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'push', reasonCode: 'command-timeout' },
        ])
      })

      test('e: a non-timeout failure before a timeout stops the loop and lists nothing', async () => {
        const fx = await skipFixture('observe', true)
        fx.failRemote('push', MISSING)
        fx.failRemote('pr-creation', TIMEOUT)

        const parsed = await refreshed(fx.adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'refresh-readback',
          kind: 'observer-readback-failed',
          reasonCode: 'missing-resource',
          timedOut: false,
        })
        expect(parsed.unconfirmedReadbacks).toBeUndefined()
      })

      test('f: when every attempted probe times out, state is unchanged and the list is in fixed order', async () => {
        const fx = await skipFixture('observe', true)
        const before = status(fx.adapter)
        fx.failRemote('push', TIMEOUT)
        fx.failRemote('pr-creation', TIMEOUT)

        const parsed = await refreshed(fx.adapter)
        expect(parsed.state).toBe(before.state)
        expect(parsed.firstUnavailableCause).toBeUndefined()
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'push', reasonCode: 'command-timeout' },
          { probe: 'pr-creation', reasonCode: 'command-timeout' },
        ])
        const after = status(fx.adapter)
        expect(after.satisfiedOperations).toEqual(before.satisfiedOperations)
        expect(after.missingOperations).toEqual(before.missingOperations)
      })

      test('g: the unconfirmed list never enters markers, receipts, tool metadata, or digests', async () => {
        const pushOutput: RecordedToolOutput = {
          title: 'push',
          output: 'pushed',
          metadata: { exit: 0 },
        }
        const fx = await skipFixture('observe', false, { push: pushOutput })
        fx.failRemote('push', TIMEOUT)
        const statusResult = expectToolOutput(
          await getTool(fx.adapter, 'systematic_workflow_status').execute(
            {},
            toolContext(),
          ),
        )
        expect(
          JSON.parse(statusResult.output).unconfirmedReadbacks,
        ).toBeDefined()
        const transformed = { system: ['base'] }
        await fx.adapter.hooks['experimental.chat.system.transform'](
          { sessionID: SESSION_A },
          transformed,
        )
        const everything = JSON.stringify([
          pushOutput,
          statusResult.metadata,
          transformed.system,
          ledger(fx.adapter).listReceipts(),
          status(fx.adapter),
        ])
        expect(everything).not.toContain('unconfirmedReadbacks')
        expect(everything).not.toContain('command-timeout')
      })

      test('h: with no epoch the refresh is skipped and the list is empty', async () => {
        const base = sequenceObserver([operationSnapshot()])
        let reads = 0
        const adapter = createAdapter('observe', false, {
          ...base,
          snapshot: async () => {
            reads += 1
            return TIMEOUT
          },
        })
        const parsed = await refreshed(adapter)
        expect(parsed.state).toBe('inactive')
        expect('unconfirmedReadbacks' in parsed).toBe(false)
        expect(reads).toBe(0)
      })

      describe('completion readback timeouts are retryable', () => {
        const RETRY_TITLE = 'Workflow readback timed out'
        const FATAL_TITLE = 'Workflow transition unavailable'

        type CompletionOutput = {
          title: string
          output: string
          metadata: Record<string, unknown>
        }

        const freshCompletionOutput = (): CompletionOutput => ({
          title: 'complete',
          output: 'done',
          metadata: {},
        })

        async function beforeComplete(
          adapter: OpencodeWorkflowGuard,
          callID: string,
        ): Promise<void> {
          await adapter.hooks['tool.execute.before'](
            {
              tool: 'systematic_workflow_complete',
              sessionID: SESSION_A,
              callID,
            },
            { args: { target: 'unit' } },
          )
        }

        function afterComplete(
          adapter: OpencodeWorkflowGuard,
          callID: string,
          output: CompletionOutput,
        ): Promise<void> {
          return adapter.hooks['tool.execute.after'](
            {
              tool: 'systematic_workflow_complete',
              sessionID: SESSION_A,
              callID,
              args: { target: 'unit' },
            },
            output,
          )
        }

        async function complete(
          adapter: OpencodeWorkflowGuard,
          callID: string,
        ): Promise<CompletionOutput> {
          await beforeComplete(adapter, callID)
          const output = freshCompletionOutput()
          await afterComplete(adapter, callID, output)
          return output
        }

        function expectRetryable(output: CompletionOutput): void {
          expect(output.title).toBe(RETRY_TITLE)
          expect(JSON.parse(output.output)).toEqual({
            status: 'rejected',
            reasonCode: 'readback-timeout',
          })
          expect(output.metadata).toMatchObject({
            workflowGuard: {
              status: 'rejected',
              target: 'unit',
              reasonCode: 'readback-timeout',
            },
          })
        }

        function expectFatal(output: CompletionOutput): void {
          expect(output.title).toBe(FATAL_TITLE)
          expect(JSON.parse(output.output)).toEqual({
            status: 'unavailable',
            reasonCode: 'finalization-failed',
          })
        }

        function consumedReceipts(adapter: OpencodeWorkflowGuard): number {
          return ledger(adapter)
            .listReceipts()
            .filter((receipt) => receipt.canonical.consumption === 'consumed')
            .length
        }

        function expectUntouched(adapter: OpencodeWorkflowGuard): void {
          expect(status(adapter).state).not.toBe('unavailable')
          expect(status(adapter).unit?.status).toBe('active')
          expect(consumedReceipts(adapter)).toBe(0)
        }

        interface StageFixture {
          readonly adapter: OpencodeWorkflowGuard
          // Arms a command-timeout at exactly this stage.
          arm(): void
          // Restores healthy probes (a no-op for the one-shot timeouts).
          disarm(): void
          cleanup(): void
        }

        interface Stage {
          readonly name: string
          build(mode: 'observe' | 'protected'): Promise<StageFixture>
        }

        // Snapshot calls on the completion path, counted per path (prepare is
        // synchronous and reads nothing): parent #1 initial / #2 final, pinned
        // #1 initial / #2 final; pinned lookups #1 initial / #2 revalidation.
        function localStage(
          name: string,
          arm: (fx: SkipFixture) => void,
          disarm: (fx: SkipFixture) => void = () => {},
        ): Stage {
          return {
            name,
            build: async (mode) => {
              const fx = await skipFixture(mode)
              return {
                adapter: fx.adapter,
                arm: () => arm(fx),
                disarm: () => disarm(fx),
                cleanup() {},
              }
            },
          }
        }

        function pinnedStage(
          name: string,
          arm: (
            setup: Awaited<ReturnType<typeof createPinnedRecoveryAdapter>>,
          ) => void,
        ): Stage {
          return {
            name,
            build: async (mode) => {
              const setup = await createPinnedRecoveryAdapter(mode)
              return {
                adapter: setup.adapter,
                arm: () => arm(setup),
                disarm() {},
                cleanup: () => setup.fixture.cleanup(),
              }
            },
          }
        }

        const stages: Stage[] = [
          localStage('initial parent snapshot', (fx) =>
            fx.timeoutLocalSnapshotOnCall(1),
          ),
          pinnedStage('pinned initial lookup', (s) =>
            s.timeoutPinnedValidationOnCall(1),
          ),
          pinnedStage('pinned initial snapshot', (s) =>
            s.timeoutPinnedSnapshotOnCall(1),
          ),
          localStage(
            'remote readback',
            (fx) => fx.failRemote('push', TIMEOUT),
            (fx) => fx.failRemote('push', undefined),
          ),
          localStage('final parent snapshot', (fx) =>
            fx.timeoutLocalSnapshotOnCall(2),
          ),
          pinnedStage('pinned revalidation lookup', (s) =>
            s.timeoutPinnedValidationOnCall(2),
          ),
          pinnedStage('pinned final snapshot', (s) =>
            s.timeoutPinnedSnapshotOnCall(2),
          ),
        ]
        const retryStages = stages.filter((stage) =>
          [
            'remote readback',
            'pinned initial snapshot',
            'pinned revalidation lookup',
          ].includes(stage.name),
        )

        for (const mode of ['observe', 'protected'] as const) {
          test.each(stages)(
            `a: a command-timeout at the $name stage is rejected as retryable and consumes nothing (${mode})`,
            async (stage) => {
              const fx = await stage.build(mode)
              try {
                fx.arm()
                const output = await complete(fx.adapter, 'timeout-complete')
                expectRetryable(output)
                expectUntouched(fx.adapter)
              } finally {
                fx.cleanup()
              }
            },
          )
        }

        test.each(retryStages)(
          'b: after a timeout at the $name stage, a new call ID with healthy probes completes the unit and consumes each receipt once',
          async (stage) => {
            const fx = await stage.build('observe')
            try {
              const receipts = ledger(fx.adapter).listReceipts().length
              fx.arm()
              expectRetryable(await complete(fx.adapter, 'timeout-complete'))
              expectUntouched(fx.adapter)
              fx.disarm()
              const retry = await complete(fx.adapter, 'healthy-complete')
              expect(retry.output).toContain('completed')
              expect(status(fx.adapter).unit?.status).toBe('completed')
              expect(receipts).toBeGreaterThan(0)
              expect(consumedReceipts(fx.adapter)).toBe(receipts)
            } finally {
              fx.cleanup()
            }
          },
        )

        test.each(retryStages)(
          'c: a duplicate after-hook for the timed-out call at the $name stage replays an identical result and changes no session state',
          async (stage) => {
            const fx = await stage.build('observe')
            try {
              fx.arm()
              const first = await complete(fx.adapter, 'timeout-complete')
              expectRetryable(first)
              const before = JSON.stringify(status(fx.adapter))
              const replay = freshCompletionOutput()
              await afterComplete(fx.adapter, 'timeout-complete', replay)
              expect(replay).toEqual(first)
              expect(JSON.stringify(status(fx.adapter))).toBe(before)
              expectUntouched(fx.adapter)
            } finally {
              fx.cleanup()
            }
          },
        )

        test('d: a session made unavailable while the probe is held takes the fatal path when the probe then times out', async () => {
          const fx = await skipFixture('observe')
          const hold = fx.holdRemote('push')
          await beforeComplete(fx.adapter, 'held-complete')
          const output = freshCompletionOutput()
          const done = afterComplete(fx.adapter, 'held-complete', output)
          await hold.reached
          fx.failLocalSnapshot('target-unavailable')
          expect((await refreshed(fx.adapter)).state).toBe('unavailable')
          fx.failLocalSnapshot(undefined)
          hold.release(TIMEOUT)
          await done
          expectFatal(output)
          expect(status(fx.adapter).state).toBe('unavailable')
          expect(consumedReceipts(fx.adapter)).toBe(0)
        })

        describe('e: non-timeout failures stay fatal', () => {
          const localCases: Array<{
            name: string
            arm: (fx: SkipFixture) => void
          }> = [
            {
              name: 'a remote missing-resource',
              arm: (fx) => fx.failRemote('push', MISSING),
            },
            {
              name: 'a remote command-failed reason',
              arm: (fx) =>
                fx.failRemote('push', {
                  status: 'unavailable',
                  reasonCode: 'remote-command-failed',
                }),
            },
            {
              name: 'a throwing parent snapshot',
              arm: (fx) => fx.failLocalSnapshot('throw'),
            },
            {
              name: 'a non-timeout unavailable parent snapshot',
              arm: (fx) => fx.failLocalSnapshot('target-unavailable'),
            },
          ]

          test.each(localCases)('$name', async ({ arm }) => {
            const fx = await skipFixture('observe')
            arm(fx)
            const output = await complete(fx.adapter, 'fatal-complete')
            expectFatal(output)
            expect(status(fx.adapter).state).toBe('unavailable')
            expect(consumedReceipts(fx.adapter)).toBe(0)
          })

          test.each([
            {
              name: 'a pinned lookup that is invalid',
              reason: 'target-unavailable',
            },
            {
              name: 'a pinned lookup that is invalid (command-failed)',
              reason: 'command-failed',
            },
          ] as const)('$name', async ({ reason }) => {
            const setup = await createPinnedRecoveryAdapter()
            try {
              setup.setTargetValidationAvailable(false, reason)
              const output = await complete(setup.adapter, 'fatal-pinned')
              expectFatal(output)
              expect(status(setup.adapter).state).toBe('unavailable')
              expect(consumedReceipts(setup.adapter)).toBe(0)
            } finally {
              setup.fixture.cleanup()
            }
          })

          test('a throwing pinned-flow parent snapshot', async () => {
            const setup = await createPinnedRecoveryAdapter()
            try {
              setup.throwParentSnapshotOnCall(1)
              const output = await complete(setup.adapter, 'fatal-pinned-throw')
              expectFatal(output)
              expect(status(setup.adapter).state).toBe('unavailable')
            } finally {
              setup.fixture.cleanup()
            }
          })
        })

        // CHARACTERIZATION TESTS: these pin what the guard does TODAY when two
        // independent registrations share one after-hook output; they are not
        // requirements. OpenCode hands the same output reference to every
        // plugin hook in sequence, and each registration decides completion
        // independently from its own readbacks. Completion is therefore not
        // atomic across registrations, and the final output depends on hook
        // order. The same divergence already exists for fatal readbacks.
        describe('characterization: two registrations sharing one completion output', () => {
          type Failure = 'timeout' | 'fatal'
          type Order = 'failing-first' | 'healthy-first'

          const cases = (['observe', 'protected'] as const).flatMap((mode) =>
            (['failing-first', 'healthy-first'] as const).flatMap((order) =>
              (['timeout', 'fatal'] as const).map((failure) => ({
                mode,
                order,
                failure,
                name: `${mode} / ${order} / ${failure}`,
              })),
            ),
          )

          const callID = 'shared-complete'

          async function pair(mode: 'observe' | 'protected', failure: Failure) {
            const failing = await skipFixture(mode)
            const healthy = await skipFixture(mode)
            failing.failRemote(
              'push',
              failure === 'timeout' ? TIMEOUT : MISSING,
            )
            return { failing, healthy }
          }

          function expectGuardResult(
            output: CompletionOutput,
            expected: Record<string, unknown>,
          ): void {
            expect(output.metadata.workflowGuard).toMatchObject(expected)
          }

          function failingResult(failure: Failure): Record<string, unknown> {
            return failure === 'timeout'
              ? {
                  status: 'rejected',
                  target: 'unit',
                  reasonCode: 'readback-timeout',
                }
              : {
                  status: 'unavailable',
                  target: 'unit',
                  reasonCode: 'finalization-failed',
                }
          }

          // Duplicate after-hooks consume nothing more. The failing registration
          // replays its own terminal outcome; the healthy one has none and leaves
          // the host output untouched.
          async function expectReplays(
            failing: SkipFixture,
            healthy: SkipFixture,
            failure: Failure,
            receipts: number,
          ): Promise<void> {
            const failingReplay = freshCompletionOutput()
            await afterComplete(failing.adapter, callID, failingReplay)
            if (failure === 'timeout') expectRetryable(failingReplay)
            else expectFatal(failingReplay)
            const healthyReplay = freshCompletionOutput()
            await afterComplete(healthy.adapter, callID, healthyReplay)
            expect(healthyReplay).toEqual(freshCompletionOutput())
            expect(consumedReceipts(healthy.adapter)).toBe(receipts)
            expect(consumedReceipts(failing.adapter)).toBe(0)
          }

          function hookOrder(
            order: Order,
            failing: SkipFixture,
            healthy: SkipFixture,
          ): SkipFixture[] {
            return order === 'failing-first'
              ? [failing, healthy]
              : [healthy, failing]
          }

          function finalResult(
            order: Order,
            failure: Failure,
          ): Record<string, unknown> {
            return order === 'failing-first'
              ? { status: 'completed', target: 'unit' }
              : failingResult(failure)
          }

          test.each(cases)(
            '$name: the healthy registration completes, the failing one consumes nothing, and the final output follows hook order',
            async ({ mode, order, failure }) => {
              const { failing, healthy } = await pair(mode, failure)
              const receipts = ledger(healthy.adapter).listReceipts().length
              expect(receipts).toBeGreaterThan(0)
              await beforeComplete(failing.adapter, callID)
              await beforeComplete(healthy.adapter, callID)
              const shared = freshCompletionOutput()
              for (const fx of hookOrder(order, failing, healthy)) {
                await afterComplete(fx.adapter, callID, shared)
              }

              // Final output: whichever registration wrote last.
              expectGuardResult(shared, finalResult(order, failure))

              // Per-registration state and consumption.
              expect(status(healthy.adapter).unit?.status).toBe('completed')
              expect(consumedReceipts(healthy.adapter)).toBe(receipts)
              expect(status(failing.adapter).unit?.status).toBe('active')
              expect(consumedReceipts(failing.adapter)).toBe(0)
              expect(status(failing.adapter).state === 'unavailable').toBe(
                failure === 'fatal',
              )
              await expectReplays(failing, healthy, failure, receipts)
            },
          )

          test.each(
            (['observe', 'protected'] as const).map((mode) => ({ mode })),
          )(
            'after a timeout, a new call ID with healthy probes completes the failing registration ($mode)',
            async ({ mode }) => {
              const { failing, healthy } = await pair(mode, 'timeout')
              await beforeComplete(failing.adapter, callID)
              await beforeComplete(healthy.adapter, callID)
              const shared = freshCompletionOutput()
              await afterComplete(failing.adapter, callID, shared)
              await afterComplete(healthy.adapter, callID, shared)
              expect(consumedReceipts(failing.adapter)).toBe(0)

              failing.failRemote('push', undefined)
              const retry = await complete(failing.adapter, 'shared-retry')
              expect(retry.output).toContain('completed')
              expect(status(failing.adapter).unit?.status).toBe('completed')
              const total = ledger(failing.adapter).listReceipts().length
              expect(consumedReceipts(failing.adapter)).toBe(total)
              expect(consumedReceipts(healthy.adapter)).toBe(total)
            },
          )
        })

        // CHARACTERIZATION TEST: an earlier completion timeout can mask drift
        // that a previous probe already saw. Completion collects remote
        // readbacks and applies them only when every probe succeeds, so a later
        // timeout discards the drifted evidence; the next attempt re-reads it.
        describe('characterization: late drift, then a later timeout', () => {
          test('the timed-out attempt applies nothing, its replay probes nothing, and a fresh attempt with restored probes detects the drift', async () => {
            const fx = await skipFixture('observe', true)
            const drifted = remoteAvailable(DRIFT, FRESH, {
              pullRequest: { identity: DRIFT, state: 'open' },
            })
            // Probes run in satisfied order: push (drifted) then pr-creation.
            fx.failRemote('push', drifted)
            fx.failRemote('pr-creation', TIMEOUT)
            const snapshot = () => ({
              status: JSON.parse(JSON.stringify(status(fx.adapter))),
              receipts: JSON.parse(
                JSON.stringify(ledger(fx.adapter).listReceipts()),
              ),
            })
            const before = snapshot()
            const remoteBefore = fx.remoteCalls()

            const first = await complete(fx.adapter, 'drift-timeout')
            expectRetryable(first)
            expect(fx.remoteCalls()).toBeGreaterThan(remoteBefore)
            expect(snapshot()).toEqual(before)

            // A duplicate after-hook replays the stored outcome and probes nothing.
            const remoteAfterFirst = fx.remoteCalls()
            const localAfterFirst = fx.localCalls()
            const replay = freshCompletionOutput()
            await afterComplete(fx.adapter, 'drift-timeout', replay)
            expectRetryable(replay)
            expect(fx.remoteCalls()).toBe(remoteAfterFirst)
            expect(fx.localCalls()).toBe(localAfterFirst)
            expect(snapshot()).toEqual(before)

            // Probes restored (pr-creation healthy); the drift on push persists.
            fx.failRemote('pr-creation', undefined)
            const second = await complete(fx.adapter, 'drift-fresh')
            // Today's path: the drifted push evidence is applied at
            // finalization, which rejects the transition with the core's
            // `resource-mismatch`, and the adapter then marks the session
            // unavailable (finalizeComplete's non-completed branch).
            expect(second.metadata.workflowGuard).toMatchObject({
              status: 'rejected',
              target: 'unit',
              reasonCode: 'resource-mismatch',
            })
            expect(second.output).not.toContain('completed')
            expect(status(fx.adapter).state).toBe('unavailable')
            expect(status(fx.adapter).unit?.status).toBe('active')
            expect(consumedReceipts(fx.adapter)).toBe(0)
          })
        })

        describe('fatal completion readbacks are replayable and caused', () => {
          const causeOf = async (adapter: OpencodeWorkflowGuard) =>
            (await refreshed(adapter)).firstUnavailableCause

          const fatalCases: Array<{
            name: string
            arm: (fx: SkipFixture) => void
            reasonCode?: string
          }> = [
            {
              name: 'a remote missing-resource',
              arm: (fx) => fx.failRemote('push', MISSING),
              reasonCode: 'missing-resource',
            },
            {
              name: 'a non-timeout unavailable parent snapshot',
              arm: (fx) => fx.failLocalSnapshot('target-unavailable'),
              reasonCode: 'target-unavailable',
            },
            {
              name: 'a throwing parent snapshot',
              arm: (fx) => fx.failLocalSnapshot('throw'),
            },
            {
              name: 'a parent snapshot target mismatch',
              arm: (fx) => fx.failLocalSnapshot('target-mismatch'),
            },
          ]

          test.each(fatalCases)(
            'a: $name writes finalization-failed, and a duplicate after-hook replays it instead of leaving the raw output',
            async ({ arm }) => {
              const fx = await skipFixture('observe')
              arm(fx)
              const first = await complete(fx.adapter, 'fatal-complete')
              expectFatal(first)
              const raw: CompletionOutput = {
                title: 'host title',
                output: 'raw pending output',
                metadata: {},
              }
              await afterComplete(fx.adapter, 'fatal-complete', raw)
              expectFatal(raw)
              expect(raw.title).toBe(first.title)
              expect(raw.output).toBe(first.output)
              expect(raw.metadata.workflowGuard).toEqual(
                first.metadata.workflowGuard,
              )
            },
          )

          test.each(fatalCases)(
            'b: $name records a complete-readback cause',
            async ({ arm, reasonCode }) => {
              const fx = await skipFixture('observe')
              arm(fx)
              expectFatal(await complete(fx.adapter, 'fatal-complete'))
              expect(await causeOf(fx.adapter)).toEqual({
                site: 'complete-readback',
                kind: 'observer-readback-failed',
                ...(reasonCode === undefined ? {} : { reasonCode }),
                timedOut: false,
              })
            },
          )

          test.each([
            { name: 'a non-timeout failure', result: MISSING },
            { name: 'a timeout', result: TIMEOUT },
          ])(
            'c: $name that lands after a fatal status refresh keeps the earlier cause',
            async ({ result }) => {
              const fx = await skipFixture('observe')
              const hold = fx.holdRemote('push')
              await beforeComplete(fx.adapter, 'held-complete')
              const output = freshCompletionOutput()
              const done = afterComplete(fx.adapter, 'held-complete', output)
              await hold.reached
              fx.failLocalSnapshot('target-unavailable')
              expect((await refreshed(fx.adapter)).state).toBe('unavailable')
              fx.failLocalSnapshot(undefined)
              hold.release(result)
              await done
              expectFatal(output)
              expect(await causeOf(fx.adapter)).toEqual({
                site: 'refresh-readback',
                kind: 'observer-readback-failed',
                reasonCode: 'target-unavailable',
                timedOut: false,
              })
            },
          )

          test('d: a mismatched completion target still goes through finishMismatchedTarget as invalid-transition', async () => {
            const fx = await skipFixture('observe')
            await beforeComplete(fx.adapter, 'mismatch-complete')
            const output = freshCompletionOutput()
            await fx.adapter.hooks['tool.execute.after'](
              {
                tool: 'systematic_workflow_complete',
                sessionID: SESSION_A,
                callID: 'mismatch-complete',
                args: { target: 'epoch' },
              },
              output,
            )
            expect(JSON.parse(output.output)).toEqual({
              status: 'unavailable',
              reasonCode: 'invalid-transition',
            })
            expect(status(fx.adapter).state).toBe('unavailable')
          })

          test('e: a retryable timeout records no cause; a later fatal refresh records its own', async () => {
            const fx = await skipFixture('observe')
            fx.failRemote('push', TIMEOUT)
            expectRetryable(await complete(fx.adapter, 'timeout-complete'))
            expect(await causeOf(fx.adapter)).toBeUndefined()
            fx.failRemote('push', undefined)
            fx.failLocalSnapshot('target-unavailable')
            expect(await causeOf(fx.adapter)).toEqual({
              site: 'refresh-readback',
              kind: 'observer-readback-failed',
              reasonCode: 'target-unavailable',
              timedOut: false,
            })
          })
        })

        describe('interleaving with other activity', () => {
          // Holds the first completion's remote probe, runs `during`, then times
          // the probe out and returns the first completion's output.
          async function timeoutWhileHeld(
            fx: SkipFixture,
            during: () => Promise<void>,
            callID = 'held-complete',
          ): Promise<CompletionOutput> {
            const hold = fx.holdRemote('push')
            await beforeComplete(fx.adapter, callID)
            const output = freshCompletionOutput()
            const done = afterComplete(fx.adapter, callID, output)
            await hold.reached
            await during()
            hold.release(TIMEOUT)
            await done
            return output
          }

          async function caughtBefore(
            adapter: OpencodeWorkflowGuard,
            callID: string,
          ): Promise<unknown> {
            try {
              await beforeComplete(adapter, callID)
            } catch (error) {
              return error
            }
            return undefined
          }

          test.each(['observe', 'protected'] as const)(
            '1: a repairable global evidence issue set while the probe is held does not make the timeout fatal, and later completions are refused by prepare (%s)',
            async (mode) => {
              const fx = await skipFixture(mode)
              const output = await timeoutWhileHeld(fx, async () => {
                expect(
                  fx.adapter.observeReceipt(SESSION_A, { not: 'a receipt' }),
                ).toMatchObject({
                  status: 'rejected',
                  reasonCode: 'invalid-receipt',
                })
                expect(status(fx.adapter).state).toBe('rejected')
                expect(status(fx.adapter).repair).toBe('fresh-readback')
              })
              expectRetryable(output)
              expect(status(fx.adapter).state).toBe('rejected')
              expect(status(fx.adapter).reasonCode).toBe('invalid-receipt')
              expect(consumedReceipts(fx.adapter)).toBe(0)
              expect(
                fx.adapter.prepareTransition(SESSION_A, {
                  callId: 'after-issue',
                  target: 'unit',
                }),
              ).toEqual({ status: 'rejected', reasonCode: 'invalid-receipt' })
              if (mode === 'protected') {
                const caught = await caughtBefore(
                  fx.adapter,
                  'after-issue-hook',
                )
                expect(isWorkflowGuardBlockedError(caught)).toBe(true)
                expect(caught).toMatchObject({ reasonCode: 'invalid-receipt' })
              }
            },
          )

          test('2: a second completion that finishes the unit while the first probe is held leaves the first rejected as retryable, and a retry gets the completed-unit reason without a second consumption', async () => {
            const fx = await skipFixture('observe')
            let second: CompletionOutput | undefined
            const first = await timeoutWhileHeld(fx, async () => {
              second = await complete(fx.adapter, 'second-complete')
            })
            expect(second?.output).toContain('completed')
            expect(status(fx.adapter).unit?.status).toBe('completed')
            const consumed = consumedReceipts(fx.adapter)
            expect(consumed).toBeGreaterThan(0)
            expectRetryable(first)
            expect(status(fx.adapter).unit?.status).toBe('completed')
            expect(status(fx.adapter).state).not.toBe('unavailable')
            expect(
              fx.adapter.prepareTransition(SESSION_A, {
                callId: 'third-complete',
                target: 'unit',
              }),
            ).toMatchObject({
              status: 'rejected',
              reasonCode: 'unit-completed',
            })
            expect(consumedReceipts(fx.adapter)).toBe(consumed)
          })

          test('3: a fatal status refresh after a timeout leaves the duplicate after-hook replaying readback-timeout, and new completions are refused as unavailable', async () => {
            const fx = await skipFixture('observe')
            fx.failRemote('push', TIMEOUT)
            const first = await complete(fx.adapter, 'timeout-complete')
            expectRetryable(first)
            fx.failLocalSnapshot('target-unavailable')
            expect((await refreshed(fx.adapter)).state).toBe('unavailable')

            const replay = freshCompletionOutput()
            await afterComplete(fx.adapter, 'timeout-complete', replay)
            expectRetryable(replay)
            expect(replay.title).toBe(first.title)
            expect(replay.output).toBe(first.output)
            expect(replay.metadata.workflowGuard).toEqual(
              first.metadata.workflowGuard,
            )
            // Everything but the live guard-state fields in metadata() replays
            // identically; those three track the session's current state.
            const liveFields = ['state', 'reasonCode', 'statusDigest']
            const stable = (metadata: Record<string, unknown>) =>
              Object.fromEntries(
                Object.entries(metadata).filter(
                  ([key]) => !liveFields.includes(key),
                ),
              )
            expect(stable(replay.metadata)).toEqual(stable(first.metadata))
            expect(replay.metadata.state).toBe('unavailable')
            expect(
              fx.adapter.prepareTransition(SESSION_A, {
                callId: 'after-unavailable',
                target: 'unit',
              }),
            ).toEqual({
              // The core reports an unavailable guard as a rejected prepare.
              status: 'rejected',
              reasonCode: 'guard-unavailable',
            })
          })

          test('4: a new call ID whose readbacks show drift after a timeout takes the fatal path, and the timed-out attempt applied nothing', async () => {
            const fx = await skipFixture('observe')
            const receiptsBefore = JSON.stringify(
              ledger(fx.adapter).listReceipts(),
            )
            const statusBefore = JSON.stringify(status(fx.adapter))
            fx.failRemote('push', TIMEOUT)
            expectRetryable(await complete(fx.adapter, 'timeout-complete'))
            expect(JSON.stringify(ledger(fx.adapter).listReceipts())).toBe(
              receiptsBefore,
            )
            expect(JSON.stringify(status(fx.adapter))).toBe(statusBefore)

            fx.failRemote('push', undefined)
            fx.driftLocalSnapshotOnCall(2)
            const second = await complete(fx.adapter, 'drift-complete')
            expectFatal(second)
            expect(status(fx.adapter).state).toBe('unavailable')
            expect(consumedReceipts(fx.adapter)).toBe(0)
          })

          test('5: replaying the before-hook with the timed-out call ID throws abandoned-transition in protected mode', async () => {
            const fx = await skipFixture('protected')
            fx.failRemote('push', TIMEOUT)
            expectRetryable(await complete(fx.adapter, 'timeout-complete'))
            const caught = await caughtBefore(fx.adapter, 'timeout-complete')
            expect(isWorkflowGuardBlockedError(caught)).toBe(true)
            expect(caught).toMatchObject({ reasonCode: 'abandoned-transition' })
            expectUntouched(fx.adapter)
          })

          test('5: replaying the before-hook with the timed-out call ID in observe mode records it, and the after-hook replays the stored result', async () => {
            const fx = await skipFixture('observe')
            fx.failRemote('push', TIMEOUT)
            const first = await complete(fx.adapter, 'timeout-complete')
            expectRetryable(first)
            await beforeComplete(fx.adapter, 'timeout-complete')
            const replay = freshCompletionOutput()
            await afterComplete(fx.adapter, 'timeout-complete', replay)
            expectRetryable(replay)
            expect(replay.title).toBe(first.title)
            expect(replay.output).toBe(first.output)
            expectUntouched(fx.adapter)
          })

          test('6: readback-timeout never enters a marker, and a fresh guard recovering from the same history restores the active unit', async () => {
            const timeoutNow = { value: false }
            const base = sequenceObserver([
              operationSnapshot(),
              operationSnapshot(undefined, 'd'.repeat(64)),
            ])
            const observer: OpencodeOperationObserver = {
              ...base,
              snapshot: async () =>
                timeoutNow.value ? TIMEOUT : base.snapshot(),
            }
            const source = createAdapter(
              'observe',
              false,
              observer,
              [],
              [],
              undefined,
              true,
            )
            const skillOutput = freshCompletionOutput()
            const writeOutput = freshCompletionOutput()
            const verifyOutput: CompletionOutput = {
              ...freshCompletionOutput(),
              metadata: { exit: 0 },
            }
            await observeSkill(
              source,
              'systematic_skill',
              'ce:work',
              'recovery-skill',
              SESSION_A,
              skillOutput,
            )
            await observeOperationTool(
              source,
              'write',
              { filePath: 'recovered.ts', content: 'x' },
              writeOutput,
              'recovery-write',
            )
            await observeOperationTool(
              source,
              'bash',
              { command: 'bun test tests/unit/example.test.ts' },
              verifyOutput,
              'recovery-verify',
            )
            expect(status(source).satisfiedOperations).toEqual(
              expect.arrayContaining(['implementation', 'verification']),
            )

            timeoutNow.value = true
            const completed = await complete(source, 'recovery-complete')
            expectRetryable(completed)
            expectUntouched(source)

            // Only the guard's own status key may name the reason; no marker
            // (receipt, progression, or system prompt) may.
            const { workflowGuard: _status, ...markerMetadata } =
              completed.metadata
            const transformed = { system: ['base'] }
            await source.hooks['experimental.chat.system.transform'](
              { sessionID: SESSION_A },
              transformed,
            )
            expect(JSON.stringify(markerMetadata)).not.toContain(
              'readback-timeout',
            )
            expect(JSON.stringify(transformed.system)).not.toContain(
              'readback-timeout',
            )
            expect(JSON.stringify(ledger(source).listReceipts())).not.toContain(
              'readback-timeout',
            )

            const parts = [
              skillOutput,
              writeOutput,
              verifyOutput,
              completed,
            ].map((part) => ({
              info: {},
              parts: [{ state: { metadata: part.metadata } }],
            }))
            const restored = createAdapter(
              'observe',
              false,
              sequenceObserver([operationSnapshot(undefined, 'd'.repeat(64))]),
              [],
              [],
              {
                readSessionParts: async () => parts,
                listChildren: async () => [],
              },
              true,
            )
            await refreshed(restored)
            expect(status(restored).state).not.toBe('unavailable')
            expect(status(restored).epoch).not.toBeNull()
            expect(status(restored).unit?.status).toBe('active')
            expect(status(restored).satisfiedOperations).toEqual(
              expect.arrayContaining(['implementation', 'verification']),
            )
          })
        })
      })
    })

    describe('refresh-readback cause carries the observer reason code', () => {
      const D = 'd'.repeat(64)
      const E = 'e'.repeat(64)
      const FRESH = 'f'.repeat(64)

      async function refreshedStatus(
        adapter: OpencodeWorkflowGuard,
      ): Promise<Record<string, unknown>> {
        const result = await getTool(
          adapter,
          'systematic_workflow_status',
        ).execute({}, toolContext(SESSION_A))
        return JSON.parse(expectToolOutput(result).output)
      }

      test('a: a local snapshot command-timeout during status refresh is skipped, not fatal', async () => {
        const base = sequenceObserver([operationSnapshot()])
        let failing = false
        const observer: OpencodeOperationObserver = {
          ...base,
          snapshot: async () => {
            if (!failing) return base.snapshot()
            return { status: 'unavailable', reasonCode: 'command-timeout' }
          },
        }
        const adapter = createAdapter('observe', false, observer)
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect(status(adapter).state).not.toBe('unavailable')
        failing = true
        const parsed = await refreshedStatus(adapter)
        expect(parsed.state).not.toBe('unavailable')
        expect(parsed.firstUnavailableCause).toBeUndefined()
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'local', reasonCode: 'command-timeout' },
        ])
      })

      async function satisfiedPushAdapter(): Promise<{
        adapter: OpencodeWorkflowGuard
        failRemoteWith(result: OperationObserverRemoteResult): void
      }> {
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
          },
        )
        const reader = base.remoteSnapshot
        if (!reader) throw new Error('sequenceObserver has a remote reader')
        let override: OperationObserverRemoteResult | undefined
        const observer: OpencodeOperationObserver = {
          ...base,
          remoteSnapshot: async (operation, phase) =>
            override ?? reader.call(base, operation, phase),
        }
        const adapter = createAdapter('observe', false, observer, ['push'])
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          { title: 'push', output: 'pushed', metadata: { exit: 0 } },
          'cause-push',
        )
        expect(status(adapter).satisfiedOperations).toContain('push')
        expect(status(adapter).state).not.toBe('unavailable')
        return {
          adapter,
          failRemoteWith(result) {
            override = result
          },
        }
      }

      test('b: a remote readback command-timeout after a satisfied push is skipped, not fatal', async () => {
        const { adapter, failRemoteWith } = await satisfiedPushAdapter()
        failRemoteWith({ status: 'unavailable', reasonCode: 'command-timeout' })
        const parsed = await refreshedStatus(adapter)
        expect(parsed.state).not.toBe('unavailable')
        expect(parsed.firstUnavailableCause).toBeUndefined()
        expect(parsed.unconfirmedReadbacks).toEqual([
          { probe: 'push', reasonCode: 'command-timeout' },
        ])
      })

      test('c: a remote missing-resource after a satisfied push goes unavailable with a non-timeout cause', async () => {
        const { adapter, failRemoteWith } = await satisfiedPushAdapter()
        failRemoteWith({ status: 'missing-resource' })
        const parsed = await refreshedStatus(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'refresh-readback',
          kind: 'observer-readback-failed',
          reasonCode: 'missing-resource',
          timedOut: false,
        })
      })

      test('d: a non-timeout remote unavailable reason is recorded verbatim and is not a timeout', async () => {
        const { adapter, failRemoteWith } = await satisfiedPushAdapter()
        failRemoteWith({
          status: 'unavailable',
          reasonCode: 'remote-command-failed',
        })
        const parsed = await refreshedStatus(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'refresh-readback',
          kind: 'observer-readback-failed',
          reasonCode: 'remote-command-failed',
          timedOut: false,
        })
      })

      test('d: a throwing remote reader has no reason code and is not a timeout', async () => {
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
          },
        )
        const reader = base.remoteSnapshot
        if (!reader) throw new Error('sequenceObserver has a remote reader')
        let throwing = false
        const observer: OpencodeOperationObserver = {
          ...base,
          remoteSnapshot: async (operation, phase) => {
            if (throwing) throw new Error('remote exploded')
            return reader.call(base, operation, phase)
          },
        }
        const adapter = createAdapter('observe', false, observer, ['push'])
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          { title: 'push', output: 'pushed', metadata: { exit: 0 } },
          'throw-push',
        )
        expect(status(adapter).satisfiedOperations).toContain('push')
        throwing = true
        const parsed = await refreshedStatus(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'refresh-readback',
          kind: 'observer-readback-failed',
          timedOut: false,
        })
      })
    })
  })

  test('partial registration finalization fails closed and remains replay-idempotent', async () => {
    const first = createAdapter('observe')
    const second = createAdapter('observe')
    await observeSkill(first, 'systematic_skill', 'ce:work')
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')

    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'partial-finalization',
    }
    await first.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    await second.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })

    const secondStatus = status(second)
    const secondReceipt = ledger(second)
      .listReceipts()
      .find((receipt) => receipt.canonical.operation === 'implementation')
    if (!secondReceipt || !secondStatus.epoch || !secondStatus.unit) {
      throw new Error('partial finalization fixture missing')
    }
    ledger(second).consumeReceipt(secondReceipt.canonical.receiptId, {
      epochId: secondStatus.epoch.epochId,
      unitId: secondStatus.unit.unitId,
      workspaceIdentity: SCOPE.workspaceIdentity,
      repositoryIdentity: SCOPE.repositoryIdentity,
      worktreeIdentity: SCOPE.worktreeIdentity,
      operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
    })

    const sharedOutput = { title: 'pending', output: 'pending', metadata: {} }
    await first.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      sharedOutput,
    )
    await expect(
      second.hooks['tool.execute.after'](
        { ...input, args: { target: 'unit' } },
        sharedOutput,
      ),
    ).resolves.toBeUndefined()
    expect(sharedOutput.output).not.toContain('completed')
    expect(sharedOutput.metadata).toMatchObject({
      state: 'unavailable',
      workflowGuard: {
        status: 'rejected',
        reasonCode: 'consumed-receipt',
        target: 'unit',
      },
    })
    const marker = { system: ['base'] }
    await second.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      marker,
    )
    expect(marker.system.join('\n')).toContain('unavailable')
    const consumption = ledger(second)
      .listReceipts()
      .map((receipt) => receipt.canonical.consumption)
    await second.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      sharedOutput,
    )
    expect(sharedOutput.output).not.toContain('completed')
    expect(
      ledger(second)
        .listReceipts()
        .map((receipt) => receipt.canonical.consumption),
    ).toEqual(consumption)
  })

  const staleReadyOutput = (): RecordedToolOutput => ({
    title: 'Workflow unit ready',
    output: JSON.stringify({ status: 'ready' }),
    metadata: {
      protocolVersion: 2,
      state: 'protected',
      reasonCode: 'unit-ready',
      enforcement: 'protected',
    },
  })

  test('a mismatched completion target writes an abandoned terminal result instead of stale ready metadata', async () => {
    const adapter = createAdapter('protected')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    mintReceipt(adapter, 'implementation')
    mintReceipt(adapter, 'verification')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'mismatched-target-complete',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    const output = staleReadyOutput()
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'epoch' } },
      output,
    )
    expect(output.metadata).not.toMatchObject({ reasonCode: 'unit-ready' })
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'invalid-transition',
      target: 'unit',
    })
  })

  test('a completion call with no pending transition and no replayable outcome writes an unavailable terminal result', async () => {
    const adapter = createAdapter('protected')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'no-pending-complete',
    }
    const output = staleReadyOutput()
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      output,
    )
    expect(output.metadata).not.toMatchObject({ reasonCode: 'unit-ready' })
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'guard-unavailable',
      target: 'unit',
    })
  })

  test('a failed host completion tool preserves the host error text and only corrects the metadata', async () => {
    const adapter = createAdapter('protected')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    mintReceipt(adapter, 'implementation')
    mintReceipt(adapter, 'verification')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'host-failure-complete',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    const hostErrorTitle = 'Bash command failed'
    const hostErrorText = 'permission denied: /var/run/lock'
    const output: RecordedToolOutput = {
      title: hostErrorTitle,
      output: hostErrorText,
      metadata: { status: 'error' },
    }
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      output,
    )
    expect(output.title).toBe(hostErrorTitle)
    expect(output.output).toBe(hostErrorText)
    expect(output.metadata).not.toEqual({ status: 'error' })
    // The host's own failure sentinel must survive alongside the guard's
    // corrected metadata — it is what a second shared-output instance
    // relies on via isSuccessfulAfter() to avoid taking the success path.
    expect(output.metadata.status).toBe('error')
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'failed-operation',
      target: 'unit',
    })
  })

  test('a mismatched completion target replayed on the same callID keeps the original reason code', async () => {
    const adapter = createAdapter('protected')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    mintReceipt(adapter, 'implementation')
    mintReceipt(adapter, 'verification')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'mismatched-target-replay',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    const output = staleReadyOutput()
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'epoch' } },
      output,
    )
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'invalid-transition',
      target: 'unit',
    })
    // Replay against a FRESH result object (not the same shared `output`
    // reused above): a same-object replay would pass even if the second
    // pass writes nothing at all, since the first pass's metadata would
    // simply still be sitting there. A fresh object can only carry
    // 'invalid-transition' if the replay path actually wrote it.
    const replayOutput = staleReadyOutput()
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'epoch' } },
      replayOutput,
    )
    expect(replayOutput.metadata).not.toMatchObject({
      reasonCode: 'unit-ready',
    })
    expect(replayOutput.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'invalid-transition',
      target: 'unit',
    })
  })

  test('a failed host completion replayed on the same callID keeps the original reason code and does not touch title/output', async () => {
    const adapter = createAdapter('protected')
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    mintReceipt(adapter, 'implementation')
    mintReceipt(adapter, 'verification')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'host-failure-replay',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    const hostErrorTitle = 'Bash command failed'
    const hostErrorText = 'permission denied: /var/run/lock'
    const output: RecordedToolOutput = {
      title: hostErrorTitle,
      output: hostErrorText,
      metadata: { status: 'error' },
    }
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      output,
    )
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'failed-operation',
      target: 'unit',
    })
    // A host-tool failure deliberately does NOT mark the session
    // unavailable (unlike an invalid-transition or a finalizeTransition
    // rejection, both of which do): the guard lets the agent retry the
    // same unit after a transient host failure. A replay of the same
    // failed call must not change that disposition either.
    expect(status(adapter).state).not.toBe('unavailable')
    const beforeReplay = {
      ...(output.metadata.workflowGuard as Record<string, unknown>),
    }
    // Replay of the identical call (same callID, same host failure) must
    // not fall through to finishUnreplayableComplete()'s generic
    // 'guard-unavailable', and must not overwrite the host's own
    // title/output with a generic terminal-result title.
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      output,
    )
    expect(output.title).toBe(hostErrorTitle)
    expect(output.output).toBe(hostErrorText)
    expect(output.metadata.status).toBe('error')
    expect(output.metadata.workflowGuard).toEqual(beforeReplay)
    expect(status(adapter).state).not.toBe('unavailable')
  })

  test('a completion call with no pending transition and no target in its own args omits target rather than fabricating one', async () => {
    const adapter = createAdapter('protected')
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'no-pending-no-target-complete',
    }
    const output = staleReadyOutput()
    await adapter.hooks['tool.execute.after']({ ...input, args: {} }, output)
    expect(output.metadata).not.toMatchObject({ reasonCode: 'unit-ready' })
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'guard-unavailable',
    })
    expect(output.metadata.workflowGuard).not.toHaveProperty('target')
  })

  test('a shared output across two guard instances does not erase questionAttestation evidence from the other instance', async () => {
    const first = createAdapter('observe')
    const second = createAdapter('observe')

    // First instance obtains an attested question challenge for completing
    // target 'unit' — same flow as "native question flow binds and accepts
    // only a correlated affirmative reply" above.
    await observeSkill(first, 'systematic_skill', 'ce:work')
    const gateOutput = { title: 'complete', output: 'complete', metadata: {} }
    await first.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'attest-complete',
      },
      { args: { target: 'unit' } },
    )
    await first.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'attest-complete',
        args: { target: 'unit' },
      },
      gateOutput,
    )
    const questionOutput = { args: {} as Record<string, unknown> }
    await first.hooks['tool.execute.before'](
      { tool: 'question', sessionID: SESSION_A, callID: 'attest-question' },
      questionOutput,
    )
    await observeQuestionEvent(first, 'question.asked', {
      id: 'attest-request',
      sessionID: SESSION_A,
      questions: [],
      tool: { messageID: 'attest-message', callID: 'attest-question' },
    })
    await observeQuestionEvent(first, 'question.replied', {
      sessionID: SESSION_A,
      requestID: 'attest-request',
      answers: [['yes']],
    })
    // Resolve first's own missing-evidence gate (independent of the
    // question challenge above) so its next completion attempt actually
    // registers a pending transition instead of being rejected before
    // reaching branch A.
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')

    // First instance now writes a shared output that carries its attested
    // questionAttestation — a mismatched-target completion (branch A) is a
    // convenient vehicle: any of the five metadata-merge sites proves the
    // point.
    await first.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'first-shared-write',
      },
      { args: { target: 'unit' } },
    )
    const sharedOutput: RecordedToolOutput = {
      title: 'stale',
      output: 'stale',
      metadata: {},
    }
    await first.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'first-shared-write',
        args: { target: 'epoch' },
      },
      sharedOutput,
    )
    expect(sharedOutput.metadata.questionAttestation).toMatchObject({
      status: 'attested',
    })

    // A second, independent guard instance (different
    // ledger.metadata.registrationDigest, no attestation of its own) now
    // writes into the SAME shared output for its own, unrelated
    // mismatched-target completion. Its own metadata() call does not emit
    // questionAttestation — the first instance's evidence must survive the
    // strip in withoutStaleConditionalMetadata().
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')
    await second.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'second-shared-write',
      },
      { args: { target: 'unit' } },
    )
    await second.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'second-shared-write',
        args: { target: 'epoch' },
      },
      sharedOutput,
    )
    expect(sharedOutput.metadata.questionAttestation).toMatchObject({
      status: 'attested',
    })
  })

  test('converged-recovery instances share a sourceDigest, so the questionAttestation gate does not protect them from each other (documented trade-off)', async () => {
    // `sharedRecovery: true` pins BOTH `registrationIdentity` and
    // `sessionSalt`, the same pinning `recoverPersistedMarkers()` uses when
    // a second instance recovers its own prior registration from markers
    // seeded by the first. Two instances that converge this way compute the
    // SAME `ledger.metadata.registrationDigest` — and therefore the same
    // `sourceDigest` — as each other, which is exactly the identifier
    // `withoutStaleConditionalMetadata()`'s gate compares. The gate cannot
    // tell these two apart, so it does NOT protect a converged instance's
    // questionAttestation from being stripped by the other. This is
    // accepted rather than fixed: `questionAttestation` in written metadata
    // is display-only (verified: no consumer reads it back as evidence of
    // a fresh attestation — see the sourceDigest-gate commit), so losing it
    // here is a fidelity gap, not a security one.
    const first = createAdapter(
      'observe',
      false,
      undefined,
      [],
      undefined,
      undefined,
      true,
    )
    const second = createAdapter(
      'observe',
      false,
      undefined,
      [],
      undefined,
      undefined,
      true,
    )

    await observeSkill(first, 'systematic_skill', 'ce:work')
    const gateOutput = { title: 'complete', output: 'complete', metadata: {} }
    await first.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'converged-attest-complete',
      },
      { args: { target: 'unit' } },
    )
    await first.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'converged-attest-complete',
        args: { target: 'unit' },
      },
      gateOutput,
    )
    const questionOutput = { args: {} as Record<string, unknown> }
    await first.hooks['tool.execute.before'](
      {
        tool: 'question',
        sessionID: SESSION_A,
        callID: 'converged-attest-question',
      },
      questionOutput,
    )
    await observeQuestionEvent(first, 'question.asked', {
      id: 'converged-attest-request',
      sessionID: SESSION_A,
      questions: [],
      tool: {
        messageID: 'converged-attest-message',
        callID: 'converged-attest-question',
      },
    })
    await observeQuestionEvent(first, 'question.replied', {
      sessionID: SESSION_A,
      requestID: 'converged-attest-request',
      answers: [['yes']],
    })
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')

    await first.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'converged-first-shared-write',
      },
      { args: { target: 'unit' } },
    )
    const sharedOutput: RecordedToolOutput = {
      title: 'stale',
      output: 'stale',
      metadata: {},
    }
    await first.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'converged-first-shared-write',
        args: { target: 'epoch' },
      },
      sharedOutput,
    )
    expect(sharedOutput.metadata.questionAttestation).toMatchObject({
      status: 'attested',
    })

    // Both instances share `registrationIdentity`/`sessionSalt`, so
    // `second`'s own `sourceDigest` equals `first`'s. The gate matches on
    // sourceDigest equality alone and cannot tell that this write belongs
    // to a DIFFERENT instance — it strips the attestation exactly as if
    // `first` were correcting its own stale metadata.
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')
    await second.hooks['tool.execute.before'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'converged-second-shared-write',
      },
      { args: { target: 'unit' } },
    )
    await second.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'converged-second-shared-write',
        args: { target: 'epoch' },
      },
      sharedOutput,
    )
    expect(sharedOutput.metadata.questionAttestation).toBeUndefined()
  })

  test('branch E (a finalizeTransition rejection) replays its own recorded reason code against a fresh result object', async () => {
    // Same partial-registration fixture as "partial registration
    // finalization fails closed and remains replay-idempotent" — that test
    // is left untouched; this one adds the fresh-output replay discipline
    // the branch A regression exposed as missing last round.
    const first = createAdapter('observe')
    const second = createAdapter('observe')
    await observeSkill(first, 'systematic_skill', 'ce:work')
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')

    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'branch-e-replay',
    }
    await first.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    await second.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })

    const secondStatus = status(second)
    const secondReceipt = ledger(second)
      .listReceipts()
      .find((receipt) => receipt.canonical.operation === 'implementation')
    if (!secondReceipt || !secondStatus.epoch || !secondStatus.unit) {
      throw new Error('branch E fixture missing')
    }
    ledger(second).consumeReceipt(secondReceipt.canonical.receiptId, {
      epochId: secondStatus.epoch.epochId,
      unitId: secondStatus.unit.unitId,
      workspaceIdentity: SCOPE.workspaceIdentity,
      repositoryIdentity: SCOPE.repositoryIdentity,
      worktreeIdentity: SCOPE.worktreeIdentity,
      operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
    })

    const firstOutput = { title: 'pending', output: 'pending', metadata: {} }
    await first.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      firstOutput,
    )
    const secondOutput: RecordedToolOutput = {
      title: 'pending',
      output: 'pending',
      metadata: {},
    }
    await second.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      secondOutput,
    )
    expect(secondOutput.metadata.workflowGuard).toMatchObject({
      status: 'rejected',
      reasonCode: 'consumed-receipt',
      target: 'unit',
    })

    // Replay against a FRESH result object, not the reused `secondOutput`:
    // an absent write cannot pass this assertion the way a reused object
    // could.
    const replayOutput: RecordedToolOutput = {
      title: 'pending',
      output: 'pending',
      metadata: {},
    }
    await second.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      replayOutput,
    )
    expect(replayOutput.metadata.workflowGuard).toMatchObject({
      status: 'rejected',
      reasonCode: 'consumed-receipt',
      target: 'unit',
    })
  })

  test('a shared output across two guard instances keeps the host failure sentinel visible to the second instance', async () => {
    const first = createAdapter('protected')
    const second = createAdapter('protected')
    await observeSkill(first, 'systematic_skill', 'ce:work')
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')

    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'shared-host-failure-complete',
    }
    await first.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    await second.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })

    // One host output object shared by both guard instances — mirrors how
    // OpenCode invokes every registered plugin's `tool.execute.after` hook
    // against the same result reference (see the `partial registration
    // finalization…` test above for the established sharing pattern).
    const sharedOutput: RecordedToolOutput = {
      title: 'Bash command failed',
      output: 'permission denied: /var/run/lock',
      metadata: { status: 'error' },
    }
    await first.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      sharedOutput,
    )
    // (a) the host's failure sentinel survives in the shared metadata.
    expect(sharedOutput.metadata.status).toBe('error')

    await second.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      sharedOutput,
    )
    // (b) the second instance still reads the host failure via
    // isSuccessfulAfter() and does not take the success path — it must not
    // report a completed unit, and must not overwrite the terminal title
    // with a completion title.
    expect(status(second).unit?.status).not.toBe('completed')
    expect(sharedOutput.title).not.toBe('Workflow transition completed')
    expect(sharedOutput.metadata.status).toBe('error')
  })

  test('a shared output across two DEBUG-mode guard instances keeps the host failure sentinel visible to the second instance', async () => {
    // Debug mode flattens the guard's own epoch status onto `metadata` too
    // (alongside operations/satisfiedCount/missingCount/family). Before the
    // fix this used a bare `status` key that collided with — and in debug
    // mode silently overwrote — the host's own `status: 'error'` failure
    // sentinel, letting a second guard instance finalize a unit off a
    // failed host result.
    const first = createAdapter('protected', true)
    const second = createAdapter('protected', true)
    await observeSkill(first, 'systematic_skill', 'ce:work')
    await observeSkill(second, 'systematic_skill', 'ce:work')
    mintReceipt(first, 'implementation')
    mintReceipt(first, 'verification')
    mintReceipt(second, 'implementation')
    mintReceipt(second, 'verification')

    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'shared-host-failure-complete-debug',
    }
    await first.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    await second.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })

    const sharedOutput: RecordedToolOutput = {
      title: 'Bash command failed',
      output: 'permission denied: /var/run/lock',
      metadata: { status: 'error' },
    }
    await first.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      sharedOutput,
    )
    // (a) the host's failure sentinel survives in the shared metadata, even
    // though debug mode is on and writes its own epoch status field.
    expect(sharedOutput.metadata.status).toBe('error')
    expect(sharedOutput.metadata.debugEpochStatus).not.toBe('error')

    await second.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      sharedOutput,
    )
    // (b) the second instance does not finalize a unit off a failed host
    // result, and (c) the title/output are not rewritten to success wording.
    expect(status(second).unit?.status).not.toBe('completed')
    expect(sharedOutput.title).not.toBe('Workflow transition completed')
    expect(sharedOutput.output).not.toContain('workflow guard completed')
    expect(sharedOutput.metadata.status).toBe('error')
  })

  test('markers upsert one source entry and aggregate worst precedence', async () => {
    const first = createAdapter('protected')
    const second = createAdapter('protected')
    await observeSkill(first, 'systematic_skill', 'ce:work')
    const output = { system: ['base'] }
    await first.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    )
    await second.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    )
    const firstPass = output.system.join('\n')
    expect((firstPass.match(/<SYSTEMATIC_WORKFLOW_GUARD>/g) ?? []).length).toBe(
      1,
    )
    // The epoch-less second adapter is `inactive`; the active first adapter is
    // `waiting`, which outranks it in the aggregate.
    expect(firstPass).toContain('"state":"inactive"')
    expect(firstPass).toContain('"aggregate":{"state":"waiting"')

    await first.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    )
    const secondPass = output.system.join('\n')
    expect(
      (secondPass.match(/<SYSTEMATIC_WORKFLOW_GUARD>/g) ?? []).length,
    ).toBe(1)
    expect(secondPass).toContain('"state":"inactive"')
    expect(secondPass).toContain('"aggregate":{"state":"waiting"')
  })

  test('round-trips operation-target-mismatch in prior guard marker sources', async () => {
    const adapter = createAdapter('protected')
    const priorSource = {
      source: 'prior-registration',
      state: 'rejected',
      reasonCode: 'operation-target-mismatch',
      enforcement: 'protected',
      statusDigest: 'prior-status',
    }
    const output = {
      system: [
        `<SYSTEMATIC_WORKFLOW_GUARD>${JSON.stringify({
          protocolVersion: 2,
          sources: [priorSource],
          aggregate: priorSource,
        })}</SYSTEMATIC_WORKFLOW_GUARD>`,
      ],
    }

    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      output,
    )

    const body = output.system
      .join('\n')
      .match(
        /<SYSTEMATIC_WORKFLOW_GUARD>(.*?)<\/SYSTEMATIC_WORKFLOW_GUARD>/s,
      )?.[1]
    if (!body) throw new Error('guard marker missing')
    const document = JSON.parse(body) as {
      sources: Array<{ source: string; reasonCode: string }>
    }
    expect(document.sources).toContainEqual(priorSource)
  })

  describe('inactive guard state', () => {
    interface MarkerDoc {
      sources: Array<{ source: string; state: string; reasonCode: string }>
      aggregate: { state: string; reasonCode: string }
    }

    function priorMarker(sources: readonly object[]): string {
      return `<SYSTEMATIC_WORKFLOW_GUARD>${JSON.stringify({
        protocolVersion: 2,
        sources,
        aggregate: sources[0],
      })}</SYSTEMATIC_WORKFLOW_GUARD>`
    }

    function readMarker(system: readonly string[]): MarkerDoc {
      const body = system
        .join('\n')
        .match(
          /<SYSTEMATIC_WORKFLOW_GUARD>(.*?)<\/SYSTEMATIC_WORKFLOW_GUARD>/s,
        )?.[1]
      if (!body) throw new Error('guard marker missing')
      return JSON.parse(body) as MarkerDoc
    }

    const inactiveSource = {
      source: 'prior-inactive',
      state: 'inactive',
      reasonCode: 'no-active-epoch',
      enforcement: 'protected',
      statusDigest: 'prior-inactive-digest',
    }

    test('a fresh session reports inactive / no-active-epoch in protected and observe mode', () => {
      for (const mode of ['protected', 'observe'] as const) {
        const adapter = createAdapter(mode)
        expect(status(adapter)).toMatchObject({
          state: 'inactive',
          reasonCode: 'no-active-epoch',
          epoch: null,
        })
      }
    })

    test('activation from inactive creates an epoch and projects waiting / missing-evidence', async () => {
      const adapter = createAdapter('protected')
      expect(status(adapter).state).toBe('inactive')
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter)).toMatchObject({
        state: 'waiting',
        reasonCode: 'missing-evidence',
      })
      expect(status(adapter).epoch).not.toBeNull()
    })

    test('disabled mode never projects inactive', () => {
      const adapter = createAdapter('disabled')
      expect(status(adapter).state).toBe('disabled')
      expect(status(adapter).state).not.toBe('inactive')
    })

    test('marker aggregate: inactive alone aggregates to inactive', async () => {
      const adapter = createAdapter('protected')
      const output = { system: ['base', priorMarker([inactiveSource])] }
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        output,
      )
      const document = readMarker(output.system)
      expect(document.sources).toContainEqual(inactiveSource)
      expect(document.aggregate).toMatchObject({
        state: 'inactive',
        reasonCode: 'no-active-epoch',
      })
    })

    for (const blocking of [
      { state: 'waiting', reasonCode: 'missing-evidence' },
      { state: 'rejected', reasonCode: 'operation-target-mismatch' },
      { state: 'unavailable', reasonCode: 'guard-unavailable' },
    ] as const) {
      test(`marker aggregate: inactive mixed with ${blocking.state} aggregates to ${blocking.state}`, async () => {
        const adapter = createAdapter('protected')
        const blockingSource = {
          source: `prior-${blocking.state}`,
          ...blocking,
          enforcement: 'protected',
          statusDigest: `prior-${blocking.state}-digest`,
        }
        const output = {
          system: ['base', priorMarker([inactiveSource, blockingSource])],
        }
        await adapter.hooks['experimental.chat.system.transform'](
          { sessionID: SESSION_A },
          output,
        )
        const document = readMarker(output.system)
        expect(document.sources.map((source) => source.state)).toContain(
          'inactive',
        )
        expect(document.aggregate).toMatchObject(blocking)
      })
    }

    test('a marker source with state inactive parses and an unknown state is rejected', async () => {
      const adapter = createAdapter('protected')
      const accepted = { system: ['base', priorMarker([inactiveSource])] }
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        accepted,
      )
      expect(readMarker(accepted.system).sources).toContainEqual(inactiveSource)
      expect(readMarker(accepted.system).aggregate.reasonCode).not.toBe(
        'guard-unavailable',
      )

      const unknownSource = { ...inactiveSource, state: 'dormant' }
      const rejected = { system: ['base', priorMarker([unknownSource])] }
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        rejected,
      )
      const document = readMarker(rejected.system)
      expect(document.sources.map((source) => source.state)).not.toContain(
        'dormant',
      )
      expect(document.aggregate).toMatchObject({
        state: 'unavailable',
        reasonCode: 'guard-unavailable',
      })
    })
  })

  test('recovers a persisted legacy (v1) guard marker under v2 parsing', async () => {
    const adapter = createAdapter('protected')
    const priorSource = {
      source: 'prior-registration-v1',
      state: 'rejected',
      reasonCode: 'operation-target-mismatch',
      enforcement: 'protected',
      statusDigest: 'prior-status-v1',
    }
    const output = {
      system: [
        `<SYSTEMATIC_WORKFLOW_GUARD>${JSON.stringify({
          protocolVersion: 1,
          sources: [priorSource],
          aggregate: priorSource,
        })}</SYSTEMATIC_WORKFLOW_GUARD>`,
      ],
    }

    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      output,
    )

    const body = output.system
      .join('\n')
      .match(
        /<SYSTEMATIC_WORKFLOW_GUARD>(.*?)<\/SYSTEMATIC_WORKFLOW_GUARD>/s,
      )?.[1]
    if (!body) throw new Error('guard marker missing')
    const document = JSON.parse(body) as {
      sources: Array<{ source: string; reasonCode: string }>
    }
    expect(document.sources).toContainEqual(priorSource)
  })

  test('malformed prior guard marker fails closed and internal title transforms stay untouched', async () => {
    const adapter = createAdapter('protected')
    const malformed = {
      system: [
        'title prompt',
        '<SYSTEMATIC_WORKFLOW_GUARD>{not-json}</SYSTEMATIC_WORKFLOW_GUARD>',
      ],
    }
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      malformed,
    )
    expect(malformed.system.join('\n')).toContain('unavailable')

    const internal = { system: ['You are a title generator'] }
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      internal,
    )
    expect(internal.system.join('\n')).not.toContain(
      'SYSTEMATIC_WORKFLOW_GUARD',
    )
  })

  test('preserves source debug fields and uses the worst source digest in the aggregate', async () => {
    const debug = createAdapter('protected', true)
    const worse = createAdapter('protected', false)
    await observeSkill(debug, 'systematic_skill', 'ce:work', 'debug-work')
    const output = { system: ['base'] }
    await debug.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      output,
    )
    await worse.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      output,
    )
    const joined = output.system.join('\n')
    const body = joined.match(
      /<SYSTEMATIC_WORKFLOW_GUARD>(.*?)<\/SYSTEMATIC_WORKFLOW_GUARD>/s,
    )?.[1]
    if (!body) throw new Error('guard marker missing')
    const document = JSON.parse(body) as {
      sources: Array<{ state: string; statusDigest: string; debug?: unknown }>
      aggregate: { state: string; statusDigest: string }
    }
    expect(document.sources.some((source) => source.debug !== undefined)).toBe(
      true,
    )
    const worst = document.sources.find((source) => source.state === 'waiting')
    if (!worst) throw new Error('expected a waiting source')
    expect(document.aggregate.state).toBe('waiting')
    expect(document.aggregate.statusDigest).toBe(worst.statusDigest)
  })

  test('disabled mode appends no guard marker to the system prompt', async () => {
    const adapter = createAdapter('disabled')
    const output = { system: ['base'] }
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      output,
    )
    expect(output.system).toEqual(['base'])
    expect(output.system.join('\n')).not.toContain('SYSTEMATIC_WORKFLOW_GUARD')

    const empty = { system: [] as string[] }
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      empty,
    )
    expect(empty.system).toEqual([])
  })

  test('guard marker text stays identical across transforms and hook events', async () => {
    const adapter = createAdapter('protected')
    const renders: string[] = []
    for (let pass = 0; pass < 4; pass += 1) {
      await adapter.hooks.event({
        event: {
          type: 'message.updated',
          properties: { sessionID: SESSION_A },
        },
      })
      const output = { system: ['base'] }
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        output,
      )
      renders.push(output.system.join('\n'))
    }
    expect(renders[0]).toContain('SYSTEMATIC_WORKFLOW_GUARD')
    expect(new Set(renders).size).toBe(1)
  })

  test('guard marker text stays identical when history has workflow tool parts but no matching receipt markers', async () => {
    // A resumed session: earlier (previous-process) history holds a
    // systematic_workflow_* tool call, but no receipt marker agrees with this
    // process's registration. That is the retryable empty-history path; it must
    // keep one ledger instead of minting a freshly salted one on every event,
    // which would change the marker (a system-prompt prefix) on every request.
    const adapter = createOpencodeWorkflowGuard({
      config: { mode: 'protected', debug: false },
      workspaceIdentity: 'workspace-a',
      hostReadback: {
        readSessionParts: async () => [
          {
            info: {},
            parts: [
              {
                type: 'tool',
                tool: 'systematic_workflow_control',
                state: { status: 'completed', metadata: {} },
              },
            ],
          },
        ],
        listChildren: async () => [],
      },
    })
    const renders: string[] = []
    for (let pass = 0; pass < 5; pass += 1) {
      // Alternate allowFresh=true hooks (events, tool hooks) with the
      // allowFresh=false system transform, as a live request does.
      await adapter.hooks.event({
        event: {
          type: 'message.updated',
          properties: { sessionID: SESSION_A },
        },
      })
      await adapter.hooks['tool.execute.before'](
        { tool: 'read', sessionID: SESSION_A, callID: `read-${pass}` },
        { args: {} },
      )
      const output = { system: ['base'] }
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        output,
      )
      renders.push(output.system.join('\n'))
    }
    expect(renders[0]).toContain('SYSTEMATIC_WORKFLOW_GUARD')
    expect(renders[0]).toContain('guard-unavailable')
    expect(new Set(renders).size).toBe(1)
  })

  test('fails closed on bounded marker overflow while retaining the current source', async () => {
    const adapter = createAdapter()
    const sources = Array.from({ length: 9 }, (_, index) => ({
      source: `source-${index}`,
      state: 'protected',
      reasonCode: 'unit-ready',
      enforcement: 'protected',
      statusDigest: `digest-${index}`,
    }))
    const output = {
      system: [
        `<SYSTEMATIC_WORKFLOW_GUARD>${JSON.stringify({
          protocolVersion: 1,
          sources,
          aggregate: {
            state: 'protected',
            reasonCode: 'unit-ready',
            enforcement: 'protected',
            statusDigest: 'digest-0',
          },
        })}</SYSTEMATIC_WORKFLOW_GUARD>`,
      ],
    }
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      output,
    )
    const joined = output.system.join('\n')
    expect(joined).toContain('guard-unavailable')
    expect(joined).toContain('sources')
  })

  test('unmatched successful start after fails closed for its session', async () => {
    const adapter = createAdapter()
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_workflow_start',
        sessionID: SESSION_A,
        callID: 'unmatched-start',
        args: {},
      },
      { title: 'start', output: 'selected', metadata: {} },
    )
    expect(status(adapter).state).toBe('unavailable')
  })

  for (const tool of ['write', 'edit', 'apply_patch'] as const) {
    test(`changed ${tool} mints one implementation receipt and preserves host metadata`, async () => {
      const observations: ReceiptOperationObservation[] = []
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        ]),
        [],
        observations,
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      const output: RecordedToolOutput = {
        title: `${tool} complete`,
        output: 'local result',
        metadata: { hostMetadata: 'preserved' },
      }
      await observeOperationTool(
        adapter,
        tool,
        { filePath: 'src/example.ts', content: 'new content' },
        output,
        `${tool}-changed`,
      )

      expect(ledger(adapter).listReceipts()).toHaveLength(1)
      expect(ledger(adapter).listReceipts()[0]?.canonical.operation).toBe(
        'implementation',
      )
      expect(observations.length).toBeGreaterThan(0)
      for (const observation of observations) {
        expect(observation.context.workspaceIdentity).toBe(
          OPERATION_SCOPE.workspaceIdentity,
        )
        expect(observation.context.operationTargetIdentity).toBe(
          OPERATION_SCOPE.workspaceIdentity,
        )
        expect(observation.after?.workspaceIdentity).toBe(
          OPERATION_SCOPE.workspaceIdentity,
        )
        expect(observation.after?.operationTargetIdentity).toBe(
          OPERATION_SCOPE.workspaceIdentity,
        )
      }
      expect(output.metadata.hostMetadata).toBe('preserved')
      const marker = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
      expect(Array.isArray(marker)).toBe(false)
      expect(marker).toMatchObject({
        envelope: {
          canonical: {
            workspaceDigest: ledger(adapter).digestIdentity(
              'workspace',
              OPERATION_SCOPE.workspaceIdentity,
            ),
          },
        },
      })
      expect(
        JSON.stringify(
          output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
        ),
      ).not.toContain('src/example.ts')
      expect(
        JSON.stringify(
          output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
        ),
      ).not.toContain('new content')
    })

    test('appends progression markers in order while preserving unrelated metadata', async () => {
      const adapter = createAdapter('observe')
      const output: RecordedToolOutput = {
        title: 'Loaded skill',
        output: 'skill result',
        metadata: { hostMetadata: 'preserved' },
      }

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'progression-markers',
        SESSION_A,
        output,
      )

      expect(output.metadata.hostMetadata).toBe('preserved')
      const marker = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
      expect(Array.isArray(marker)).toBe(true)
      expect(marker).toHaveLength(2)
      expect(marker).toEqual([
        expect.objectContaining({ control: 'progression', target: 'epoch' }),
        expect.objectContaining({ control: 'progression', target: 'unit' }),
      ])
    })
  }

  test('activates from a guarded skill with a 60 KB tool output and merges progression markers', async () => {
    const adapter = createAdapter('observe')
    const output: RecordedToolOutput = {
      title: 'Loaded skill',
      output: 'x'.repeat(60 * 1024),
      metadata: { hostMetadata: 'preserved' },
    }

    await observeSkill(
      adapter,
      'systematic_skill',
      'ce:work',
      'large-output-skill',
      SESSION_A,
      output,
    )

    expect(status(adapter).epoch?.family).toBe('work')
    expect(output.metadata.hostMetadata).toBe('preserved')
    const marker = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    expect(Array.isArray(marker)).toBe(true)
    expect(marker).toHaveLength(2)
    expect(marker).toEqual([
      expect.objectContaining({ control: 'progression', target: 'epoch' }),
      expect.objectContaining({ control: 'progression', target: 'unit' }),
    ])
  })

  test('activates from a guarded skill with a ~51 KB truncated tool output', async () => {
    const adapter = createAdapter('observe')

    await observeSkill(
      adapter,
      'systematic_skill',
      'ce:work',
      'truncated-output-skill',
      SESSION_A,
      {
        title: 'Loaded skill',
        output: 'x'.repeat(51 * 1024),
        metadata: { truncated: true, outputPath: '/tmp/x' },
      },
    )

    expect(status(adapter).epoch?.family).toBe('work')
  })

  test('does not activate a guarded skill when a 60 KB tool output reports metadata.status error', async () => {
    const adapter = createAdapter('observe')

    await observeSkill(
      adapter,
      'systematic_skill',
      'ce:work',
      'large-error-output-skill',
      SESSION_A,
      {
        title: 'error',
        output: 'x'.repeat(60 * 1024),
        metadata: { status: 'error' },
      },
    )

    expect(status(adapter).epoch).toBeNull()
  })

  test('canonicalizes relative-before and absolute-after apply_patch paths into one implementation receipt', async () => {
    const cleanup = prepareApplyPatchTargetDirectory()
    try {
      const absolutePath = path.resolve(process.cwd(), 'sub/x.ts')
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        ]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      await observeOperationToolWithArgs(
        adapter,
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: sub/x.ts',
            '+content',
            '*** End Patch',
          ].join('\n'),
        },
        {
          patchText: [
            '*** Begin Patch',
            `*** Add File: ${absolutePath}`,
            '+content',
            '*** End Patch',
          ].join('\n'),
        },
        { title: 'apply_patch complete', output: 'local result', metadata: {} },
        'apply-patch-canonical-path',
      )

      expect(ledger(adapter).listReceipts()).toHaveLength(1)
      expect(ledger(adapter).listReceipts()[0]?.canonical.operation).toBe(
        'implementation',
      )
      expect(status(adapter).state).not.toBe('unavailable')
    } finally {
      cleanup()
    }
  })

  test('canonicalizes relative-before and absolute-after apply_patch hunks into one implementation receipt', async () => {
    const cleanup = prepareApplyPatchTargetDirectory()
    try {
      const absolutePath = path.resolve(process.cwd(), 'sub/x.ts')
      const absoluteMovePath = path.resolve(process.cwd(), 'sub/y.ts')
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        ]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      await observeOperationToolWithArgs(
        adapter,
        { hunks: [{ path: 'sub/x.ts', move_path: 'sub/y.ts' }] },
        {
          hunks: [{ path: absolutePath, move_path: absoluteMovePath }],
        },
        { title: 'apply_patch complete', output: 'local result', metadata: {} },
        'apply-patch-canonical-hunks',
      )

      expect(ledger(adapter).listReceipts()).toHaveLength(1)
      expect(ledger(adapter).listReceipts()[0]?.canonical.operation).toBe(
        'implementation',
      )
      expect(status(adapter).state).not.toBe('unavailable')
    } finally {
      cleanup()
    }
  })

  test('fails closed without throwing for an apply_patch empty file-target path', async () => {
    const malformedPatch = [
      '*** Begin Patch',
      '*** Add File: ',
      '+content',
      '*** End Patch',
    ].join('\n')
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      ]),
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')

    await expect(
      observeOperationToolWithArgs(
        adapter,
        { patchText: malformedPatch },
        { patchText: malformedPatch },
        { title: 'apply_patch complete', output: 'local result', metadata: {} },
        'apply-patch-empty-file-target',
      ),
    ).resolves.toBeUndefined()

    expect(ledger(adapter).listReceipts()).toHaveLength(0)
    expect(status(adapter).state).toBe('unavailable')
  })

  test('keeps apply_patch fingerprints different when the patch body changes', async () => {
    const cleanup = prepareApplyPatchTargetDirectory()
    try {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        ]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      await observeOperationToolWithArgs(
        adapter,
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: sub/x.ts',
            '+before',
            '*** End Patch',
          ].join('\n'),
        },
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: sub/x.ts',
            '+after',
            '*** End Patch',
          ].join('\n'),
        },
        { title: 'apply_patch complete', output: 'local result', metadata: {} },
        'apply-patch-changed-body',
      )

      expect(ledger(adapter).listReceipts()).toHaveLength(0)
      expect(status(adapter).state).toBe('unavailable')
    } finally {
      cleanup()
    }
  })

  test('keeps apply_patch fingerprints different when the target file changes', async () => {
    const cleanup = prepareApplyPatchTargetDirectory()
    try {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        ]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      await observeOperationToolWithArgs(
        adapter,
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: sub/x.ts',
            '+content',
            '*** End Patch',
          ].join('\n'),
        },
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: sub/y.ts',
            '+content',
            '*** End Patch',
          ].join('\n'),
        },
        { title: 'apply_patch complete', output: 'local result', metadata: {} },
        'apply-patch-changed-file',
      )

      expect(ledger(adapter).listReceipts()).toHaveLength(0)
      expect(status(adapter).state).toBe('unavailable')
    } finally {
      cleanup()
    }
  })

  test('treats an equivalent duplicate apply_patch after event as a replay', async () => {
    const cleanup = prepareApplyPatchTargetDirectory()
    try {
      const absolutePath = path.resolve(process.cwd(), 'sub/x.ts')
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        ]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      await observeOperationToolWithArgs(
        adapter,
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: sub/x.ts',
            '+content',
            '*** End Patch',
          ].join('\n'),
        },
        {
          patchText: [
            '*** Begin Patch',
            `*** Add File: ${absolutePath}`,
            '+content',
            '*** End Patch',
          ].join('\n'),
        },
        { title: 'apply_patch complete', output: 'local result', metadata: {} },
        'apply-patch-replay',
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'apply_patch',
          sessionID: SESSION_A,
          callID: 'apply-patch-replay',
          args: {
            patchText: [
              '*** Begin Patch',
              '*** Add File: sub/x.ts',
              '+content',
              '*** End Patch',
            ].join('\n'),
          },
        },
        { title: 'apply_patch replay', output: 'local result', metadata: {} },
      )

      expect(ledger(adapter).listReceipts()).toHaveLength(1)
      expect(status(adapter).state).not.toBe('unavailable')
    } finally {
      cleanup()
    }
  })

  test('mints an implementation receipt for a write targeted at a registered worktree', async () => {
    const fixture = createTargetDerivationFixture()
    try {
      const parentObserver = createOpencodeOperationObserver({
        targetDirectory: fixture.parentRoot,
      })
      const initial = await parentObserver.snapshot()
      if (initial.status !== 'available') throw new Error('parent unavailable')
      const observations: ReceiptOperationObservation[] = []
      const classifier = createReceiptClassifier()
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        observer: parentObserver,
        classifier: {
          ...classifier,
          classifyOperation: async (input: unknown) => {
            observations.push(input as ReceiptOperationObservation)
            const classify = classifier.classifyOperation
            if (!classify) {
              throw new Error(
                'expected classifier to implement classifyOperation',
              )
            }
            return classify(input)
          },
        },
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      const filePath = path.join(fixture.linkedRoot, 'targeted.txt')
      const input = {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'worktree-targeted-write',
        args: { filePath, content: 'changed' },
      }
      await adapter.hooks['tool.execute.before'](input, { args: input.args })
      fs.writeFileSync(filePath, 'changed')
      await adapter.hooks['tool.execute.after'](input, {
        title: 'write complete',
        output: 'changed',
        metadata: {},
      })

      const receipts = adapter.ledger(SESSION_A)?.listReceipts() ?? []
      expect(observations).toHaveLength(2)
      expect(observations.at(-1)).toMatchObject({
        operation: 'implementation',
        context: {
          operationTargetIdentity: expect.any(String),
        },
        after: {
          operationTargetIdentity: expect.any(String),
        },
      })
      expect(receipts).toHaveLength(1)
      expect(receipts[0]?.canonical.operation).toBe('implementation')
      expect(receipts[0]?.canonical.operationTargetIdentity).toBe(
        createOpencodeOperationObserver({
          targetDirectory: fixture.linkedRoot,
        }).targetDigest,
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('rejects a worktree that is removed and recreated at the same path between hooks', async () => {
    const fixture = createTargetDerivationFixture()
    try {
      const parentObserver = createOpencodeOperationObserver({
        targetDirectory: fixture.parentRoot,
      })
      const initial = await parentObserver.snapshot()
      if (initial.status !== 'available') throw new Error('parent unavailable')
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        observer: parentObserver,
        classifier: createReceiptClassifier(),
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      const input = {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'recreated-worktree-write',
        args: {
          filePath: path.join(fixture.linkedRoot, 'targeted.txt'),
          content: 'changed',
        },
      }
      await adapter.hooks['tool.execute.before'](input, { args: input.args })
      runTargetFixtureGit(fixture.parentRoot, [
        'worktree',
        'remove',
        '--force',
        fixture.linkedRoot,
      ])
      runTargetFixtureGit(fixture.parentRoot, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        'linked-recreated',
        fixture.linkedRoot,
      ])
      await adapter.hooks['tool.execute.after'](input, {
        title: 'write complete',
        output: 'changed',
        metadata: {},
      })

      expect(ledger(adapter).listReceipts()).toHaveLength(0)
      expect(status(adapter).state).toBe('rejected')
    } finally {
      fixture.cleanup()
    }
  })

  test('does not fall back to a parent receipt for an invalid target after a parent change', async () => {
    const fixture = createTargetDerivationFixture()
    try {
      const parentObserver = createOpencodeOperationObserver({
        targetDirectory: fixture.parentRoot,
      })
      const initial = await parentObserver.snapshot()
      if (initial.status !== 'available') throw new Error('parent unavailable')
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        observer: parentObserver,
        classifier: createReceiptClassifier(),
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      const input = {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'invalid-target-with-parent-change',
        args: {
          filePath: path.join(fixture.unrelatedRoot, 'targeted.txt'),
          content: 'should not mint',
        },
      }
      await adapter.hooks['tool.execute.before'](input, { args: input.args })
      fs.appendFileSync(
        path.join(fixture.parentRoot, 'tracked.txt'),
        'parent\n',
      )
      await adapter.hooks['tool.execute.after'](input, {
        title: 'write complete',
        output: 'changed',
        metadata: {},
      })

      expect(ledger(adapter).listReceipts()).toHaveLength(0)
      expect(status(adapter).state).toBe('unavailable')
    } finally {
      fixture.cleanup()
    }
  })

  test('fails closed when a unit switches from one registered worktree target to another', async () => {
    const fixture = createTargetDerivationFixture()
    try {
      const parentObserver = createOpencodeOperationObserver({
        targetDirectory: fixture.parentRoot,
      })
      const initial = await parentObserver.snapshot()
      if (initial.status !== 'available') throw new Error('parent unavailable')
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        observer: parentObserver,
        classifier: createReceiptClassifier(),
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')

      const firstPath = path.join(fixture.linkedRoot, 'first-target.txt')
      const firstInput = {
        tool: 'write' as const,
        sessionID: SESSION_A,
        callID: 'target-switch-first',
        args: { filePath: firstPath, content: 'first' },
      }
      await adapter.hooks['tool.execute.before'](firstInput, {
        args: firstInput.args,
      })
      fs.writeFileSync(firstPath, 'first')
      await adapter.hooks['tool.execute.after'](firstInput, {
        title: 'write complete',
        output: 'changed',
        metadata: {},
      })

      const firstTargetIdentity = createOpencodeOperationObserver({
        targetDirectory: fixture.linkedRoot,
      }).targetDigest
      expect(status(adapter).unit?.pinnedOperationTargetIdentity).toBe(
        firstTargetIdentity,
      )
      expect(ledger(adapter).listReceipts()).toHaveLength(1)

      const secondPath = path.join(
        fixture.secondLinkedRoot,
        'second-target.txt',
      )
      const secondInput = {
        tool: 'write' as const,
        sessionID: SESSION_A,
        callID: 'target-switch-second',
        args: { filePath: secondPath, content: 'second' },
      }
      await adapter.hooks['tool.execute.before'](secondInput, {
        args: secondInput.args,
      })
      fs.writeFileSync(secondPath, 'second')
      await adapter.hooks['tool.execute.after'](secondInput, {
        title: 'write complete',
        output: 'changed',
        metadata: {},
      })

      expect(status(adapter).state).toBe('unavailable')
      expect(status(adapter).unit?.pinnedOperationTargetIdentity).toBe(
        firstTargetIdentity,
      )
      expect(ledger(adapter).listReceipts()).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  test('projects observer commitClosure through the operation observation', async () => {
    const observations: ReceiptOperationObservation[] = []
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(
          OPERATION_SCOPE.repositoryIdentity,
          OPERATION_SCOPE.worktreeIdentity,
          true,
        ),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64), true),
        operationSnapshot('e'.repeat(64), 'f'.repeat(64), true),
      ]),
      ['commit'],
      observations,
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      adapter,
      'bash',
      { command: 'git commit -m "closed"' },
      { title: 'commit', output: 'committed', metadata: { exit: 0 } },
      'commit-closure-projection',
    )
    const observation = observations.find((entry) => entry.tool === 'bash')
    expect(observation?.after?.commitClosure).toBe(true)
  })

  test('no-op local edits do not mint implementation evidence', async () => {
    for (const [index, tool] of (
      ['write', 'edit', 'apply_patch'] as const
    ).entries()) {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot(), operationSnapshot()]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      await observeOperationTool(
        adapter,
        tool,
        { filePath: 'same.ts', content: 'same' },
        { title: `${tool} complete`, output: 'local result', metadata: {} },
        `${tool}-no-op-${index}`,
      )
      expect(ledger(adapter).listReceipts()).toHaveLength(0)
      expect(status(adapter).missingOperations).toContain('implementation')
    }
  })

  test('revision drift is reported as stale/receipt mismatch with fresh readback repair', async () => {
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('e'.repeat(64), 'f'.repeat(64)),
      ]),
      ['implementation'],
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      adapter,
      'write',
      { filePath: 'drift.ts', content: 'changed' },
      { title: 'write', output: 'changed', metadata: {} },
      'drift-operation',
    )
    mintReceipt(adapter, 'verification', SESSION_A, {
      ...OPERATION_SCOPE,
      worktreeIdentity: 'd'.repeat(64),
    })

    await getTool(adapter, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    const current = status(adapter)
    expect(['stale-receipt', 'receipt-mismatch']).toContain(current.reasonCode)
    expect(current.reasonCode).not.toBe('workspace-mismatch')
    expect(current.repair).toBe('fresh-readback')
  })

  test('successful verification bash mints only for supported commands and exit zero', async () => {
    const accepted = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot(undefined, 'd'.repeat(64)),
      ]),
    )
    await observeSkill(accepted, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      accepted,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { title: 'tests', output: '1 pass', metadata: { exit: 0 } },
      'bun-test',
    )
    expect(ledger(accepted).listReceipts()[0]?.canonical.operation).toBe(
      'verification',
    )

    for (const [command, metadata] of [
      ['bun test tests/unit/example.test.ts', { exit: 1 }],
      ['bun test tests/unit/example.test.ts', { exit: '0' }],
      ['echo done', { exit: 0 }],
      ['bun test tests/unit/example.test.ts | tee result', { exit: 0 }],
    ] as const) {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([
          operationSnapshot(),
          operationSnapshot(undefined, 'd'.repeat(64)),
        ]),
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      await observeOperationTool(
        adapter,
        'bash',
        { command },
        { title: 'tests', output: 'result', metadata },
        `bash-${command}-${String(metadata.exit)}`,
      )
      expect(ledger(adapter).listReceipts()).toHaveLength(0)
    }
  })

  test('accepts real OpenCode empty-title and empty-output success shapes', async () => {
    const observations: ReceiptOperationObservation[] = []
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot(undefined, 'd'.repeat(64)),
        operationSnapshot(undefined, 'd'.repeat(64)),
      ]),
      ['implementation', 'verification'],
      observations,
    )
    await observeSkill(
      adapter,
      'systematic_skill',
      'ce:work',
      'real-shaped-skill',
      SESSION_A,
      { title: '', output: '', metadata: { truncated: false } },
    )
    expect(status(adapter).epoch).not.toBeNull()

    await observeOperationTool(
      adapter,
      'write',
      { filePath: 'real-shaped.txt', content: 'changed' },
      { metadata: { diagnostics: {}, exists: false, truncated: false } },
      'real-shaped-write',
    )
    expect(ledger(adapter).listReceipts()).toHaveLength(1)
    await observeOperationTool(
      adapter,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { output: '1 pass', metadata: { exit: 0 } },
      'real-shaped-bash',
    )
    expect(ledger(adapter).listReceipts()).toHaveLength(2)
  })

  // Regression: `finishSkill` (host tool 'systematic_skill'/'skill') now
  // accepts host output beyond MAX_HOST_OUTPUT_LENGTH -- see the guarded
  // skill activation tests above -- but every other completion path
  // (operation results, unit/epoch starts and completes) must keep
  // rejecting oversized host output exactly as before.
  test('rejects operation host results beyond the bounded output limit', async () => {
    const observations: ReceiptOperationObservation[] = []
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot(undefined, 'd'.repeat(64)),
      ]),
      [],
      observations,
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      adapter,
      'write',
      { filePath: 'overlong.txt', content: 'changed' },
      { title: '', output: 'x'.repeat(32_769), metadata: {} },
      'overlong-host-result',
    )
    expect(ledger(adapter).listReceipts()).toHaveLength(0)
    expect(status(adapter).state).toBe('unavailable')
  })

  test('changed git commit mints commit evidence while unchanged HEAD does not', async () => {
    const changed = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('e'.repeat(64), 'd'.repeat(64), true),
      ]),
      ['commit'],
    )
    await observeSkill(changed, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      changed,
      'write',
      { filePath: 'commit.ts', content: 'verified' },
      { title: 'write', output: 'changed', metadata: {} },
      'commit-implementation',
    )
    await observeOperationTool(
      changed,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { title: 'tests', output: 'pass', metadata: { exit: 0 } },
      'commit-verification',
    )
    await observeOperationTool(
      changed,
      'bash',
      { command: 'git commit -m receipt-test' },
      { title: 'commit', output: 'committed', metadata: { exit: 0 } },
      'git-commit-changed',
    )
    expect(
      ledger(changed)
        .listReceipts()
        .some((receipt) => receipt.canonical.operation === 'commit'),
    ).toBe(true)

    const unchanged = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64), true),
      ]),
      ['commit'],
    )
    await observeSkill(unchanged, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      unchanged,
      'write',
      { filePath: 'commit.ts', content: 'verified' },
      { title: 'write', output: 'changed', metadata: {} },
      'no-op-implementation',
    )
    await observeOperationTool(
      unchanged,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { title: 'tests', output: 'pass', metadata: { exit: 0 } },
      'no-op-verification',
    )
    await observeOperationTool(
      unchanged,
      'bash',
      { command: 'git commit -m receipt-test' },
      { title: 'commit', output: 'nothing to commit', metadata: { exit: 0 } },
      'git-commit-no-op',
    )
    expect(
      ledger(unchanged)
        .listReceipts()
        .some((receipt) => receipt.canonical.operation === 'commit'),
    ).toBe(false)
  })

  test('successful push mints remote evidence when the upstream revision changes', async () => {
    const observations: ReceiptOperationObservation[] = []
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([operationSnapshot(), operationSnapshot()], {
        'push:before': [remoteAvailable('d'.repeat(64), 'e'.repeat(64))],
        'push:after': [remoteAvailable('d'.repeat(64), 'f'.repeat(64))],
      }),
      ['push'],
      observations,
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    const output: RecordedToolOutput = {
      title: 'push',
      output: 'pushed',
      metadata: { hostMetadata: 'preserved', exit: 0 },
    }
    await observeOperationTool(
      adapter,
      'bash',
      { command: 'git push origin main' },
      output,
      'remote-push',
    )
    expect(ledger(adapter).listReceipts()[0]?.canonical.operation).toBe('push')
    expect(output.metadata.hostMetadata).toBe('preserved')
    expect(
      output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
    ).toBeDefined()
  })

  test('remote PR, check, and review readbacks mint their accepted classes', async () => {
    const cases = [
      {
        operation: 'pr-creation' as const,
        command: 'gh pr create --title "Receipt guard" --body "Details"',
        before: { status: 'missing-resource' as const },
        after: remoteAvailable('d'.repeat(64), 'f'.repeat(64), {
          pullRequest: { identity: 'd'.repeat(64), state: 'open' },
        }),
      },
      {
        operation: 'check-readback' as const,
        command: 'gh pr checks 42',
        before: remoteAvailable('d'.repeat(64), 'f'.repeat(64), {
          pullRequest: { identity: 'd'.repeat(64), state: 'open' },
          checkState: 'pending',
        }),
        after: remoteAvailable('d'.repeat(64), 'f'.repeat(64), {
          pullRequest: { identity: 'd'.repeat(64), state: 'open' },
          checkState: 'completed-success',
        }),
      },
      {
        operation: 'review-readback' as const,
        command: 'gh pr view 42 --json reviewDecision',
        before: remoteAvailable('d'.repeat(64), 'f'.repeat(64), {
          pullRequest: { identity: 'd'.repeat(64), state: 'open' },
          reviewDecision: 'pending',
        }),
        after: remoteAvailable('d'.repeat(64), 'f'.repeat(64), {
          pullRequest: { identity: 'd'.repeat(64), state: 'open' },
          reviewDecision: 'approved',
        }),
      },
    ]
    for (const testCase of cases) {
      const observations: ReceiptOperationObservation[] = []
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot(), operationSnapshot()], {
          [`${testCase.operation}:before`]: [testCase.before],
          [`${testCase.operation}:after`]: [testCase.after],
        }),
        [testCase.operation],
        observations,
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      const output = {
        title: testCase.operation,
        output: 'remote result',
        metadata: { exit: 0 },
      }
      await observeOperationTool(
        adapter,
        'bash',
        { command: testCase.command },
        output,
        `remote-${testCase.operation}`,
      )
      expect(ledger(adapter).listReceipts()[0]?.canonical.operation).toBe(
        testCase.operation,
      )
    }
  })

  test('remote no-op and unavailable readbacks mint nothing', async () => {
    const unchanged = createAdapter(
      'observe',
      false,
      sequenceObserver([operationSnapshot(), operationSnapshot()], {
        'push:before': [remoteAvailable('d'.repeat(64), 'e'.repeat(64))],
        'push:after': [remoteAvailable('d'.repeat(64), 'e'.repeat(64))],
      }),
      ['push'],
    )
    await observeSkill(unchanged, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      unchanged,
      'bash',
      { command: 'git push origin main' },
      { title: 'push', output: 'pushed', metadata: { exit: 0 } },
      'remote-push-no-op',
    )
    expect(ledger(unchanged).listReceipts()).toHaveLength(0)

    const unavailable = createAdapter(
      'observe',
      false,
      sequenceObserver([operationSnapshot(), operationSnapshot()], {
        'check-readback:before': [
          remoteAvailable('d'.repeat(64), 'f'.repeat(64), {
            pullRequest: { identity: 'd'.repeat(64), state: 'open' },
            checkState: 'pending',
          }),
        ],
        'check-readback:after': [
          { status: 'unavailable', reasonCode: 'remote-missing-field' },
        ],
      }),
      ['check-readback'],
    )
    await observeSkill(unavailable, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      unavailable,
      'bash',
      { command: 'gh pr checks 42' },
      { title: 'checks', output: 'unavailable', metadata: { exit: 0 } },
      'remote-checks-unavailable',
    )
    expect(ledger(unavailable).listReceipts()).toHaveLength(0)
    expect(status(unavailable).state).toBe('unavailable')
  })

  describe('remote seeding deferrals', () => {
    const D = 'd'.repeat(64)
    const E = 'e'.repeat(64)
    const TIMEOUT = {
      status: 'unavailable' as const,
      reasonCode: 'command-timeout' as const,
    }
    const prAvailable = remoteAvailable(D, E, {
      pullRequest: { identity: D, state: 'open' },
    })
    const checkAvailable = remoteAvailable(D, E, {
      pullRequest: { identity: D, state: 'open' },
      checkState: 'pending',
    })

    function deferralAdapter(
      mode: 'observe' | 'protected',
      required: readonly ReceiptOperation[],
      remote: Record<string, readonly OperationObserverRemoteResult[]>,
    ): OpencodeWorkflowGuard {
      return createAdapter(
        mode,
        false,
        sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          remote,
        ),
        required,
      )
    }

    async function statusParsed(
      adapter: OpencodeWorkflowGuard,
    ): Promise<Record<string, unknown>> {
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      return JSON.parse(expectToolOutput(result).output)
    }

    test.each([
      { mode: 'observe', reason: 'command-timeout', result: TIMEOUT },
      {
        mode: 'protected',
        reason: 'command-timeout',
        result: TIMEOUT,
      },
      {
        mode: 'observe',
        reason: 'missing-resource',
        result: { status: 'missing-resource' as const },
      },
      {
        mode: 'protected',
        reason: 'missing-resource',
        result: { status: 'missing-resource' as const },
      },
    ] as const)(
      'b/c/k: a push $reason defers only push; the session stays active ($mode)',
      async ({ mode, reason, result }) => {
        const adapter = deferralAdapter(mode, ['push', 'check-readback'], {
          'push:before': [result],
          'check-readback:before': [checkAvailable],
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        const current = status(adapter)
        expect(current.state).not.toBe('unavailable')
        expect(current.epoch).not.toBeNull()
        expect(current.unit?.status).toBe('active')
        expect(current.missingOperations).toContain('push')
        const parsed = await statusParsed(adapter)
        expect(parsed.firstUnavailableCause).toBeUndefined()
        expect(parsed.seedDeferrals).toEqual([
          { operation: 'push', reasonCode: reason },
        ])
      },
    )

    test.each(['check-readback', 'review-readback'] as const)(
      'd: a %s seeding timeout defers that operation while the others seed',
      async (operation) => {
        const adapter = deferralAdapter('observe', ['push', operation], {
          'push:before': [remoteAvailable(D, E)],
          [`${operation}:before`]: [TIMEOUT],
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect(status(adapter).state).not.toBe('unavailable')
        const parsed = await statusParsed(adapter)
        expect(parsed.seedDeferrals).toEqual([
          { operation, reasonCode: 'command-timeout' },
        ])
      },
    )

    test('e: a local snapshot timeout at seeding is still fatal', async () => {
      const base = sequenceObserver([operationSnapshot()], {
        'push:before': [remoteAvailable(D, E)],
      })
      const adapter = createAdapter(
        'observe',
        false,
        { ...base, snapshot: async () => TIMEOUT },
        ['push'],
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).toBe('unavailable')
      const parsed = await statusParsed(adapter)
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'seed-remote-scopes',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'command-timeout',
        timedOut: true,
      })
      expect(parsed.seedDeferrals).toBeUndefined()
    })

    test('f: a deferred operation that is never performed leaves completion blocked on missing evidence', async () => {
      const adapter = deferralAdapter('observe', ['push'], {
        'push:before': [TIMEOUT],
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
      mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
      expect(status(adapter).missingOperations).toEqual(['push'])
      expect(
        adapter.prepareTransition(SESSION_A, {
          callId: 'deferred-complete',
          target: 'unit',
        }),
      ).toMatchObject({ status: 'waiting', reasonCode: 'missing-evidence' })
      expect(status(adapter).unit?.status).toBe('active')
    })

    test('g: a check timeout after pr-creation seeded records no check deferral', async () => {
      const adapter = deferralAdapter(
        'observe',
        ['pr-creation', 'check-readback'],
        {
          'pr-creation:before': [prAvailable],
          'check-readback:before': [TIMEOUT],
        },
      )
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).not.toBe('unavailable')
      const parsed = await statusParsed(adapter)
      expect(parsed.firstUnavailableCause).toBeUndefined()
      expect(parsed.seedDeferrals).toBeUndefined()
    })

    test('h: a timeout for an operation whose resource the unit declared records no deferral', async () => {
      const adapter = deferralAdapter('observe', ['push'], {
        'push:before': [remoteAvailable(D, E), remoteAvailable(D, E), TIMEOUT],
        'push:after': [remoteAvailable(D, 'f'.repeat(64))],
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      await observeOperationTool(
        adapter,
        'bash',
        { command: 'git push origin main' },
        { title: 'push', output: 'pushed', metadata: { exit: 0 } },
        'declared-push',
      )
      mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
      mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
      await completeUnit(adapter, 'declared-complete-unit1')
      expect(status(adapter).unit?.status).toBe('completed')
      const firstUnitId = status(adapter).unit?.unitId

      const startArgs = { resource_scopes: { push: 'remote-resource' } }
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'declared-start',
        },
        { args: startArgs },
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'declared-start',
          args: startArgs,
        },
        { title: 'x', output: 'y', metadata: {} },
      )
      expect(status(adapter).unit?.unitId).not.toBe(firstUnitId)
      expect(status(adapter).state).not.toBe('unavailable')
      const parsed = await statusParsed(adapter)
      expect(parsed.firstUnavailableCause).toBeUndefined()
      expect(parsed.seedDeferrals).toBeUndefined()
    })

    test('i: a deferral is cleared when the next unit start runs', async () => {
      // A deferred operation cannot reach a completed first unit: its receipt
      // is admitted only after its own before-read binds a baseline, and that
      // clears the deferral. So the next start is a re-declaration on the
      // still-pristine unit; it runs through the same start path that clears
      // the deferral before seeding.
      const adapter = deferralAdapter('observe', ['push'], {
        'push:before': [TIMEOUT, remoteAvailable(D, E)],
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect((await statusParsed(adapter)).seedDeferrals).toEqual([
        { operation: 'push', reasonCode: 'command-timeout' },
      ])
      const unitId = status(adapter).unit?.unitId

      const startArgs = { resource_scopes: { push: 'remote-resource' } }
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'next-unit-start',
        },
        { args: startArgs },
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'next-unit-start',
          args: startArgs,
        },
        { title: 'x', output: 'y', metadata: {} },
      )
      expect(status(adapter).unit?.unitId).toBe(unitId)
      expect(status(adapter).state).not.toBe('unavailable')
      expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
    })

    describe('binding a deferred baseline at the operation before-hook', () => {
      const FRESH = 'f'.repeat(64)

      function counted(
        base: OpencodeOperationObserver,
        counts: Record<string, number>,
      ): OpencodeOperationObserver {
        const reader = base.remoteSnapshot
        if (!reader) throw new Error('sequenceObserver has a remote reader')
        return {
          ...base,
          remoteSnapshot: async (operation, phase) => {
            const key = `${operation}:${phase}`
            counts[key] = (counts[key] ?? 0) + 1
            return reader.call(base, operation, phase)
          },
        }
      }

      function pushAdapter(
        remote: Record<string, readonly OperationObserverRemoteResult[]>,
        counts: Record<string, number> = {},
        required: readonly ReceiptOperation[] = ['push'],
      ): OpencodeWorkflowGuard {
        return createAdapter(
          'observe',
          false,
          counted(
            sequenceObserver(
              [operationSnapshot(), operationSnapshot(), operationSnapshot()],
              remote,
            ),
            counts,
          ),
          required,
        )
      }

      async function pushOperation(
        adapter: OpencodeWorkflowGuard,
        callID = 'bind-push',
      ): Promise<void> {
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          { title: 'push', output: 'pushed', metadata: { exit: 0 } },
          callID,
        )
      }

      function operations(adapter: OpencodeWorkflowGuard): string[] {
        return ledger(adapter)
          .listReceipts()
          .map((receipt) => receipt.canonical.operation)
      }

      test('a: an available before-read binds the deferred push baseline and the push receipt is admitted', async () => {
        const adapter = pushAdapter({
          'push:before': [TIMEOUT, remoteAvailable(D, E)],
          'push:after': [remoteAvailable(D, FRESH)],
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
        await pushOperation(adapter)
        expect(operations(adapter)).toContain('push')
        expect(status(adapter).missingOperations).toEqual([])
        expect(status(adapter).satisfiedOperations).toEqual(
          expect.arrayContaining(['implementation', 'verification', 'push']),
        )
        expect(status(adapter).state).toBe('protected')
        expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
      })

      test('b: a before-read that times out once is retried once and then binds', async () => {
        const counts: Record<string, number> = {}
        const adapter = pushAdapter(
          {
            'push:before': [TIMEOUT, TIMEOUT, remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
          },
          counts,
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await pushOperation(adapter)
        expect(counts['push:before']).toBe(3)
        expect(operations(adapter)).toContain('push')
        expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
      })

      test('c: two before-read timeouts bind nothing; the push runs unadmitted and the session stays up', async () => {
        const counts: Record<string, number> = {}
        const adapter = pushAdapter(
          {
            'push:before': [TIMEOUT, TIMEOUT, TIMEOUT, remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
          },
          counts,
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await pushOperation(adapter)
        expect(counts['push:before']).toBe(3)
        expect(operations(adapter)).not.toContain('push')
        expect(status(adapter).state).not.toBe('unavailable')
        expect(status(adapter).missingOperations).toEqual(['push'])
        expect(status(adapter)).toMatchObject({
          state: 'rejected',
          reasonCode: 'resource-mismatch',
        })
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
      })

      test('d: a push before-read of missing-resource binds nothing and keeps the deferral', async () => {
        const adapter = pushAdapter({
          'push:before': [TIMEOUT, { status: 'missing-resource' }],
          'push:after': [remoteAvailable(D, FRESH)],
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await pushOperation(adapter)
        expect(operations(adapter)).not.toContain('push')
        expect(status(adapter).state).not.toBe('unavailable')
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
      })

      test('e: a deferred pr-creation whose before-read is missing-resource clears the deferral and creation is admitted', async () => {
        const adapter = pushAdapter(
          {
            'pr-creation:before': [TIMEOUT, { status: 'missing-resource' }],
            'pr-creation:after': [prAvailable],
          },
          {},
          ['pr-creation'],
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'pr-creation', reasonCode: 'command-timeout' },
        ])
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'bind-pr' },
          { args: { command: 'gh pr create --title t --body b' } },
        )
        expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'bash',
            sessionID: SESSION_A,
            callID: 'bind-pr',
            args: { command: 'gh pr create --title t --body b' },
          },
          { title: 'pr', output: 'created', metadata: { exit: 0 } },
        )
        expect(operations(adapter)).toContain('pr-creation')
        expect(status(adapter).state).not.toBe('unavailable')
      })

      test('f: a before-read from a different registered worktree observer does not bind', async () => {
        const fixture = createTargetDerivationFixture()
        try {
          expect(
            runTargetFixtureGit(fixture.linkedRoot, [
              'branch',
              '--set-upstream-to=master',
              'linked',
            ]).status === 0 ||
              runTargetFixtureGit(fixture.linkedRoot, [
                'branch',
                '--set-upstream-to=main',
                'linked',
              ]).status === 0,
          ).toBe(true)
          const linkedRemote = await createOpencodeOperationObserver({
            targetDirectory: fixture.linkedRoot,
          }).remoteSnapshot?.('push', 'before')
          // The other worktree's observer would bind if the identity check
          // were missing.
          expect(linkedRemote?.status).toBe('available')

          const adapter = pushAdapter({
            'push:before': [TIMEOUT],
          })
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          await adapter.hooks['tool.execute.before'](
            { tool: 'bash', sessionID: SESSION_A, callID: 'other-worktree' },
            {
              args: {
                command: 'git push origin linked',
                workdir: fixture.linkedRoot,
              },
            },
          )
          expect(status(adapter).state).not.toBe('unavailable')
          expect((await statusParsed(adapter)).seedDeferrals).toEqual([
            { operation: 'push', reasonCode: 'command-timeout' },
          ])
        } finally {
          fixture.cleanup()
        }
      })

      test('g: a push binding names its operation and leaves the pr-creation and check baselines alone', async () => {
        const PR = '1'.repeat(64)
        const adapter = pushAdapter(
          {
            'push:before': [TIMEOUT, remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
            'pr-creation:before': [
              remoteAvailable(PR, E, {
                pullRequest: { identity: PR, state: 'open' },
              }),
            ],
            'pr-creation:after': [
              remoteAvailable(PR, FRESH, {
                pullRequest: { identity: PR, state: 'open' },
              }),
            ],
            'check-readback:before': [
              remoteAvailable(PR, E, {
                pullRequest: { identity: PR, state: 'open' },
                checkState: 'pending',
              }),
            ],
            'check-readback:after': [
              remoteAvailable(PR, FRESH, {
                pullRequest: { identity: PR, state: 'open' },
                checkState: 'completed-success',
              }),
            ],
          },
          {},
          ['push', 'pr-creation', 'check-readback'],
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await pushOperation(adapter)
        expect(operations(adapter)).toContain('push')
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'gh pr create --title t --body b' },
          { title: 'pr', output: 'created', metadata: { exit: 0 } },
          'g-pr',
        )
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'gh pr checks 42' },
          { title: 'checks', output: 'ok', metadata: { exit: 0 } },
          'g-checks',
        )
        // A global (unnamed) binding would have rewritten the pr-creation and
        // check baselines to the push resource and rejected these receipts.
        expect(operations(adapter)).toEqual(
          expect.arrayContaining(['push', 'pr-creation', 'check-readback']),
        )
      })

      test('h: a pr-creation binding leaves the check baseline unset and its deferral in place', async () => {
        const PR = '1'.repeat(64)
        const adapter = pushAdapter(
          {
            'pr-creation:before': [
              TIMEOUT,
              remoteAvailable(PR, E, {
                pullRequest: { identity: PR, state: 'open' },
              }),
            ],
            'pr-creation:after': [
              remoteAvailable(PR, FRESH, {
                pullRequest: { identity: PR, state: 'open' },
              }),
            ],
            'check-readback:before': [TIMEOUT, TIMEOUT, TIMEOUT],
          },
          {},
          ['pr-creation', 'check-readback'],
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'pr-creation', reasonCode: 'command-timeout' },
          { operation: 'check-readback', reasonCode: 'command-timeout' },
        ])
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'h-pr' },
          { args: { command: 'gh pr create --title t --body b' } },
        )
        // pr-creation is bound and cleared; check was not propagated to, so
        // its deferral is still in place.
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'check-readback', reasonCode: 'command-timeout' },
        ])
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'bash',
            sessionID: SESSION_A,
            callID: 'h-pr',
            args: { command: 'gh pr create --title t --body b' },
          },
          { title: 'pr', output: 'created', metadata: { exit: 0 } },
        )
        expect(operations(adapter)).toContain('pr-creation')
      })

      test('m: an available before-read that observeReadback rejects binds nothing and keeps the deferral', async () => {
        const adapter = pushAdapter({
          'push:before': [
            TIMEOUT,
            {
              status: 'available',
              snapshot: {
                resourceIdentity: '',
                resourceRevisionIdentity: E,
              },
            },
          ],
          'push:after': [remoteAvailable(D, FRESH)],
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await pushOperation(adapter)
        expect(operations(adapter)).not.toContain('push')
        expect(status(adapter).state).not.toBe('unavailable')
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
      })

      describe.each([
        [
          'check-readback',
          'gh pr checks 42',
          'checkState',
          'completed-success',
        ],
        [
          'review-readback',
          'gh pr view 42 --json reviewDecision',
          'reviewDecision',
          'approved',
        ],
      ] as const)(
        '%s deferral on a missing-resource before-read',
        (operation, command, field, finalValue) => {
          const PR = '1'.repeat(64)
          const pullRequest = { identity: PR, state: 'open' as const }
          const pendingValue = field === 'checkState' ? 'pending' : 'required'
          const before = remoteAvailable(PR, E, {
            pullRequest,
            [field]: pendingValue,
          })
          const after = remoteAvailable(PR, FRESH, {
            pullRequest,
            [field]: finalValue,
          })

          function adapterFor(
            beforeReads: readonly OperationObserverRemoteResult[],
          ): OpencodeWorkflowGuard {
            return pushAdapter(
              {
                [`${operation}:before`]: [TIMEOUT, ...beforeReads],
                [`${operation}:after`]: [after],
              },
              {},
              [operation],
            )
          }

          function runOperation(
            adapter: OpencodeWorkflowGuard,
            callID: string,
          ): Promise<void> {
            return observeOperationTool(
              adapter,
              'bash',
              { command },
              { title: operation, output: 'ok', metadata: { exit: 0 } },
              callID,
            )
          }

          test('a missing-resource before-read keeps the deferral and admits nothing', async () => {
            const adapter = adapterFor([{ status: 'missing-resource' }])
            await observeSkill(adapter, 'systematic_skill', 'ce:work')
            await runOperation(adapter, 'missing-before')
            expect(operations(adapter)).not.toContain(operation)
            expect(status(adapter).state).not.toBe('unavailable')
            expect((await statusParsed(adapter)).seedDeferrals).toEqual([
              { operation, reasonCode: 'command-timeout' },
            ])
          })

          test('a later available before-read from the same observer binds it and the receipt is admitted', async () => {
            const adapter = adapterFor([{ status: 'missing-resource' }, before])
            await observeSkill(adapter, 'systematic_skill', 'ce:work')
            await runOperation(adapter, 'missing-before')
            expect(operations(adapter)).not.toContain(operation)
            await runOperation(adapter, 'available-before')
            expect(operations(adapter)).toContain(operation)
            expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
            expect(status(adapter).state).not.toBe('unavailable')
          })
        },
      )

      test('l: a push before-hook that runs while the push seed is in flight binds nothing', async () => {
        let releaseSeed: (result: OperationObserverRemoteResult) => void =
          () => {}
        let pushBeforeReads = 0
        const base = sequenceObserver([operationSnapshot()], {
          'push:after': [remoteAvailable(D, FRESH)],
        })
        const adapter = createAdapter(
          'observe',
          false,
          {
            ...base,
            remoteSnapshot: (operation, phase) => {
              if (operation === 'push' && phase === 'before') {
                pushBeforeReads += 1
                if (pushBeforeReads === 1) {
                  return new Promise<OperationObserverRemoteResult>(
                    (resolve) => {
                      releaseSeed = resolve
                    },
                  )
                }
                return Promise.resolve(remoteAvailable(D, E))
              }
              return Promise.resolve({
                status: 'unavailable',
                reasonCode: 'remote-missing-field',
              })
            },
          },
          ['push'],
        )
        const skillDone = observeSkill(adapter, 'systematic_skill', 'ce:work')
        await new Promise((resolve) => setTimeout(resolve, 0))
        // The seed read is suspended; the unit exists but nothing is deferred.
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'in-flight-push' },
          { args: { command: 'git push origin main' } },
        )
        releaseSeed(TIMEOUT)
        await skillDone
        expect(pushBeforeReads).toBe(2)
        // Had the in-flight before-hook bound a baseline, the seed's timeout
        // would have recorded no deferral.
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
      })

      test('n: a before-read suspended across unit completion and the next unit start cannot bind or mint evidence for the new unit', async () => {
        // Push P's before-read samples revision E and is held. Another push
        // advances the remote and completes unit 1. Unit 2 starts with a
        // timed-out (deferred) push seed. Releasing P's old read must neither
        // bind unit 2's deferral with that unit-1 era revision nor let P's
        // up-to-date push count as a mutation for unit 2.
        let releaseStale: (result: OperationObserverRemoteResult) => void =
          () => {}
        let pushBeforeReads = 0
        // The held read (the second push before-read, stale push P) bypasses
        // the sequence, so the base serves: unit-1 seed, unit-1 push Q, then
        // the unit-2 seed (timeout).
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [
              remoteAvailable(D, E),
              remoteAvailable(D, E),
              TIMEOUT,
            ],
            'push:after': [remoteAvailable(D, FRESH)],
          },
        )
        const adapter = createAdapter(
          'observe',
          false,
          {
            ...base,
            remoteSnapshot: (operation, phase) => {
              if (operation === 'push' && phase === 'before') {
                pushBeforeReads += 1
                if (pushBeforeReads === 2) {
                  return new Promise<OperationObserverRemoteResult>(
                    (resolve) => {
                      releaseStale = resolve
                    },
                  )
                }
              }
              return (
                base.remoteSnapshot?.(operation, phase) ??
                Promise.resolve(TIMEOUT)
              )
            },
          },
          ['push'],
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')

        const staleCommand = { command: 'git push origin HEAD' }
        const staleBefore = adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'stale-push' },
          { args: staleCommand },
        )
        for (let tick = 0; tick < 50 && pushBeforeReads < 2; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        expect(pushBeforeReads).toBe(2)

        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          { title: 'push', output: 'pushed', metadata: { exit: 0 } },
          'unit-1-push',
        )
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await completeUnit(adapter, 'stale-complete-unit1')
        expect(status(adapter).unit?.status).toBe('completed')
        const firstUnitId = status(adapter).unit?.unitId

        await adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'stale-start-unit2',
          },
          { args: {} },
        )
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'stale-start-unit2',
            args: {},
          },
          { title: 'x', output: 'y', metadata: {} },
        )
        expect(status(adapter).unit?.unitId).not.toBe(firstUnitId)
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
        const pushReceiptsBefore = operations(adapter).filter(
          (operation) => operation === 'push',
        ).length

        releaseStale(remoteAvailable(D, E))
        await staleBefore
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'bash',
            sessionID: SESSION_A,
            callID: 'stale-push',
            args: staleCommand,
          },
          { title: 'push', output: 'up-to-date', metadata: { exit: 0 } },
        )

        expect(
          operations(adapter).filter((operation) => operation === 'push'),
        ).toHaveLength(pushReceiptsBefore)
        expect(status(adapter).missingOperations).toContain('push')
        expect(status(adapter).state).not.toBe('unavailable')
        // The stale read bound nothing, so unit 2's deferral is untouched.
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
      })

      test('o: a before-read suspended across a same-ID active-unit redeclaration cannot bind the replacement deferral or mint evidence', async () => {
        // The unit keeps both IDs through a successful redeclaration, but the
        // start resets and reseeds the deferrals. P's read of revision E
        // predates that declaration and must not bind the replacement.
        let releaseStale: (result: OperationObserverRemoteResult) => void =
          () => {}
        let pushBeforeReads = 0
        // The held read (the second push before-read, stale push P) bypasses
        // the sequence, so the base serves the initial seed and then the
        // redeclaration seed, both timing out.
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [TIMEOUT, TIMEOUT],
            'push:after': [remoteAvailable(D, FRESH)],
          },
        )
        const adapter = createAdapter(
          'observe',
          false,
          {
            ...base,
            remoteSnapshot: (operation, phase) => {
              if (operation === 'push' && phase === 'before') {
                pushBeforeReads += 1
                if (pushBeforeReads === 2) {
                  return new Promise<OperationObserverRemoteResult>(
                    (resolve) => {
                      releaseStale = resolve
                    },
                  )
                }
              }
              return (
                base.remoteSnapshot?.(operation, phase) ??
                Promise.resolve(TIMEOUT)
              )
            },
          },
          ['push'],
        )
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
        const unitId = status(adapter).unit?.unitId

        const staleCommand = { command: 'git push origin HEAD' }
        const staleBefore = adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'stale-push' },
          { args: staleCommand },
        )
        for (let tick = 0; tick < 50 && pushBeforeReads < 2; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        expect(pushBeforeReads).toBe(2)

        const startArgs = { expected_operations: ['pr-creation'] }
        await adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'redeclare-start',
          },
          { args: startArgs },
        )
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'redeclare-start',
            args: startArgs,
          },
          { title: 'x', output: 'y', metadata: {} },
        )
        expect(pushBeforeReads).toBe(3)
        expect(status(adapter).unit?.unitId).toBe(unitId)
        expect(status(adapter).unit?.requiredOperations).toContain(
          'pr-creation',
        )
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])

        releaseStale(remoteAvailable(D, E))
        await staleBefore
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'bash',
            sessionID: SESSION_A,
            callID: 'stale-push',
            args: staleCommand,
          },
          { title: 'push', output: 'up-to-date', metadata: { exit: 0 } },
        )

        expect(operations(adapter)).not.toContain('push')
        expect(status(adapter).missingOperations).toContain('push')
        expect(status(adapter).state).not.toBe('unavailable')
        expect((await statusParsed(adapter)).seedDeferrals).toEqual([
          { operation: 'push', reasonCode: 'command-timeout' },
        ])
      })
    })

    describe('after-hook ownership across a unit change', () => {
      const FRESH = 'f'.repeat(64)
      const PR_CREATE = { command: 'gh pr create --title t --body b' }
      const MISSING = { status: 'missing-resource' as const }
      type HoldPoint = 'local-after' | 'remote-after'

      interface HeldAfter {
        readonly adapter: OpencodeWorkflowGuard
        arm(point: HoldPoint): void
        hasHeld(): boolean
        release(): void
      }

      function heldAfterAdapter(): HeldAfter {
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
            'pr-creation:before': [MISSING],
            'pr-creation:after': [prAvailable],
            'check-readback:before': [checkAvailable],
            'check-readback:after': [
              remoteAvailable(D, FRESH, {
                pullRequest: { identity: D, state: 'open' },
                checkState: 'completed-success',
              }),
            ],
          },
        )
        let armed: HoldPoint | undefined
        let held = false
        let release: () => void = () => {}
        const gate = (): Promise<void> | undefined => {
          held = true
          armed = undefined
          return new Promise<void>((resolve) => {
            release = resolve
          })
        }
        const adapter = createAdapter(
          'observe',
          false,
          {
            ...base,
            snapshot: async () => {
              if (armed === 'local-after') await gate()
              return base.snapshot()
            },
            remoteSnapshot: async (operation, phase) => {
              if (armed === 'remote-after' && phase === 'after') await gate()
              return (
                base.remoteSnapshot?.(operation, phase) ??
                Promise.resolve(TIMEOUT)
              )
            },
          },
          ['push'],
        )
        return {
          adapter,
          arm: (point) => {
            armed = point
          },
          hasHeld: () => held,
          release: () => release(),
        }
      }

      async function untilHeld(held: HeldAfter): Promise<void> {
        for (let tick = 0; tick < 50 && !held.hasHeld(); tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        expect(held.hasHeld()).toBe(true)
      }

      // Unit 2 also requires pr-creation and check-readback, so a leaked
      // self-seed, propagation, or receipt would be admitted rather than
      // rejected as not required.
      async function startSuccessorUnit(
        adapter: OpencodeWorkflowGuard,
      ): Promise<void> {
        const args = { expected_operations: ['pr-creation', 'check-readback'] }
        await adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'ownership-start-unit2',
          },
          { args },
        )
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'ownership-start-unit2',
            args,
          },
          { title: 'x', output: 'y', metadata: {} },
        )
      }

      // Runs `staleCommand` to completion of its before-hook in unit 1,
      // suspends its after-hook at `point`, completes unit 1 with another
      // push, starts unit 2, then releases the suspended after-hook.
      async function runAcrossUnitChange(
        held: HeldAfter,
        point: HoldPoint,
        staleCommand: Record<string, unknown>,
      ): Promise<void> {
        const { adapter } = held
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        const firstUnitId = status(adapter).unit?.unitId
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'stale-after' },
          { args: staleCommand },
        )
        held.arm(point)
        const staleAfter = adapter.hooks['tool.execute.after'](
          {
            tool: 'bash',
            sessionID: SESSION_A,
            callID: 'stale-after',
            args: staleCommand,
          },
          { title: 'op', output: 'ok', metadata: { exit: 0 } },
        )
        await untilHeld(held)

        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          { title: 'push', output: 'pushed', metadata: { exit: 0 } },
          'ownership-unit-1-push',
        )
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await completeUnit(adapter, 'ownership-complete-unit1')
        expect(status(adapter).unit?.status).toBe('completed')
        await startSuccessorUnit(adapter)
        expect(status(adapter).unit?.unitId).not.toBe(firstUnitId)

        held.release()
        await staleAfter
      }

      function operationsOf(adapter: OpencodeWorkflowGuard): string[] {
        return ledger(adapter)
          .listReceipts()
          .map((receipt) => receipt.canonical.operation)
      }

      test.each([
        ['captureAfterOperation', 'local-after'],
        ['captureRemoteAfter', 'remote-after'],
      ] as const)(
        'a push whose after-hook is suspended in %s cannot mint evidence for the successor unit',
        async (_name, point) => {
          const held = heldAfterAdapter()
          await runAcrossUnitChange(held, point, {
            command: 'git push origin HEAD',
          })
          const { adapter } = held
          // Only unit 1's own push (the completing one) holds a receipt.
          expect(
            operationsOf(adapter).filter((operation) => operation === 'push'),
          ).toHaveLength(1)
          expect(status(adapter).missingOperations).toContain('push')
          expect(status(adapter).state).not.toBe('unavailable')
        },
      )

      test.each([
        ['captureAfterOperation', 'local-after'],
        ['captureRemoteAfter', 'remote-after'],
      ] as const)(
        'a pr-creation whose after-hook is suspended in %s neither self-seeds nor propagates into the successor unit',
        async (_name, point) => {
          const held = heldAfterAdapter()
          await runAcrossUnitChange(held, point, PR_CREATE)
          const { adapter } = held
          expect(operationsOf(adapter)).not.toContain('pr-creation')
          // A self-seed would have set the successor unit's pr-creation
          // baseline and propagated it to check; the same PR would then be
          // admitted. Without a baseline it is a resource-mismatch.
          await observeOperationTool(
            adapter,
            'bash',
            { command: 'gh pr checks 42' },
            { title: 'checks', output: 'ok', metadata: { exit: 0 } },
            'ownership-probe-check',
          )
          expect(operationsOf(adapter)).not.toContain('check-readback')
          expect(status(adapter).state).not.toBe('unavailable')
        },
      )

      test('a push whose held classifier rejects after the unit changed neither disables the successor nor mints evidence', async () => {
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'push:before': [remoteAvailable(D, E)],
            'push:after': [remoteAvailable(D, FRESH)],
          },
        )
        const classifier = createReceiptClassifier()
        const realClassify = classifier.classifyOperation
        if (!realClassify) throw new Error('classifier implements it')
        let armed = false
        let held = false
        let rejectHeld: (reason: Error) => void = () => {}
        const adapter = createOpencodeWorkflowGuard({
          config: { mode: 'observe', debug: false },
          ...OPERATION_SCOPE,
          observer: base,
          runtimeRequiredOperations: ['push'],
          classifier: {
            ...classifier,
            classifyOperation: (input: unknown) => {
              if (!armed) return realClassify(input)
              armed = false
              held = true
              return new Promise((_resolve, reject) => {
                rejectHeld = reject
              })
            },
          },
        })
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        const firstUnitId = status(adapter).unit?.unitId
        const staleCommand = { command: 'git push origin HEAD' }
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'stale-classify' },
          { args: staleCommand },
        )
        armed = true
        const staleAfter = adapter.hooks['tool.execute.after'](
          {
            tool: 'bash',
            sessionID: SESSION_A,
            callID: 'stale-classify',
            args: staleCommand,
          },
          { title: 'op', output: 'ok', metadata: { exit: 0 } },
        )
        for (let tick = 0; tick < 50 && !held; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        expect(held).toBe(true)

        await observeOperationTool(
          adapter,
          'bash',
          { command: 'git push origin main' },
          { title: 'push', output: 'pushed', metadata: { exit: 0 } },
          'classify-unit-1-push',
        )
        mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
        mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
        await completeUnit(adapter, 'classify-complete-unit1')
        expect(status(adapter).unit?.status).toBe('completed')
        await startSuccessorUnit(adapter)
        expect(status(adapter).unit?.unitId).not.toBe(firstUnitId)
        expect(status(adapter).missingOperations).toContain('push')

        rejectHeld(new Error('classifier failed'))
        await staleAfter

        expect(status(adapter).state).not.toBe('unavailable')
        // Only unit 1's own completing push holds a push receipt.
        expect(
          operationsOf(adapter).filter((operation) => operation === 'push'),
        ).toHaveLength(1)
        expect(status(adapter).missingOperations).toContain('push')
      })
    })

    describe.each([
      [
        'check-readback',
        'gh pr checks 42',
        'checkState',
        'pending',
        'completed-success',
      ],
      [
        'review-readback',
        'gh pr view 42 --json reviewDecision',
        'reviewDecision',
        'required',
        'approved',
      ],
    ] as const)(
      'lingering %s deferral after a pr-creation self-seed propagated the baseline',
      (operation, command, field, pendingValue, finalValue) => {
        const FRESH = 'f'.repeat(64)
        const PR_A = D
        const PR_B = '2'.repeat(64)

        function pullRequestRead(
          identity: string,
          revision: string,
          value: string,
        ): OperationObserverRemoteResult {
          return remoteAvailable(identity, revision, {
            pullRequest: { identity, state: 'open' },
            [field]: value,
          })
        }

        // Every seed times out; the pr-creation operation's own before-read
        // is missing-resource, so creation self-seeds PR A from the after-read
        // and propagates it to check and review while their deferrals remain.
        function adapterAfterSelfSeed(
          operationBefore: OperationObserverRemoteResult,
        ): OpencodeWorkflowGuard {
          const base = sequenceObserver(
            [operationSnapshot(), operationSnapshot(), operationSnapshot()],
            {
              'pr-creation:before': [TIMEOUT, { status: 'missing-resource' }],
              'pr-creation:after': [prAvailable],
              [`${operation}:before`]: [TIMEOUT, operationBefore],
              [`${operation}:after`]: [
                pullRequestRead(
                  operationBefore.status === 'available'
                    ? operationBefore.snapshot.resourceIdentity
                    : PR_A,
                  FRESH,
                  finalValue,
                ),
              ],
            },
          )
          return createAdapter('observe', false, base, [
            'pr-creation',
            operation,
          ])
        }

        async function createPullRequestA(
          adapter: OpencodeWorkflowGuard,
        ): Promise<void> {
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          await observeOperationTool(
            adapter,
            'bash',
            { command: 'gh pr create --title t --body b' },
            { title: 'pr', output: 'created', metadata: { exit: 0 } },
            'lingering-pr',
          )
        }

        function operationReceipts(adapter: OpencodeWorkflowGuard): number {
          return ledger(adapter)
            .listReceipts()
            .filter((receipt) => receipt.canonical.operation === operation)
            .length
        }

        test('a different PR cannot overwrite the propagated baseline or mint evidence', async () => {
          const adapter = adapterAfterSelfSeed(
            pullRequestRead(PR_B, E, pendingValue),
          )
          await createPullRequestA(adapter)
          expect(
            ledger(adapter)
              .listReceipts()
              .map((receipt) => receipt.canonical.operation),
          ).toContain('pr-creation')
          expect((await statusParsed(adapter)).seedDeferrals).toEqual([
            { operation, reasonCode: 'command-timeout' },
          ])
          await observeOperationTool(
            adapter,
            'bash',
            { command },
            { title: operation, output: 'ok', metadata: { exit: 0 } },
            'lingering-other-pr',
          )
          expect(operationReceipts(adapter)).toBe(0)
          expect(status(adapter).state).not.toBe('unavailable')
          expect(status(adapter)).toMatchObject({
            state: 'rejected',
            reasonCode: 'resource-mismatch',
          })
          // The deferral was obsolete once the baseline existed.
          expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
        })

        test('the same PR is still admitted and the obsolete deferral is cleared', async () => {
          const adapter = adapterAfterSelfSeed(
            pullRequestRead(PR_A, E, pendingValue),
          )
          await createPullRequestA(adapter)
          await observeOperationTool(
            adapter,
            'bash',
            { command },
            { title: operation, output: 'ok', metadata: { exit: 0 } },
            'lingering-same-pr',
          )
          expect(operationReceipts(adapter)).toBe(1)
          expect(status(adapter).state).not.toBe('unavailable')
          expect((await statusParsed(adapter)).seedDeferrals).toBeUndefined()
        })
      },
    )

    describe('pr-creation after-read self-seed', () => {
      const PR_CREATE = { command: 'gh pr create --title t --body b' }
      const MISSING = { status: 'missing-resource' as const }
      const UNREADABLE = {
        status: 'unavailable' as const,
        reasonCode: 'remote-missing-field' as const,
      }

      // Seeding reads pr-creation:before first (missing-resource, tolerated);
      // the operation's own before-hook read is the second call.
      function prAdapter(
        hookBefore: OperationObserverRemoteResult | 'throw',
      ): OpencodeWorkflowGuard {
        const base = sequenceObserver(
          [operationSnapshot(), operationSnapshot(), operationSnapshot()],
          {
            'pr-creation:before': [MISSING],
            'pr-creation:after': [prAvailable],
            // Seeding tolerates a missing check/review resource, so neither
            // has a baseline until pr-creation propagates one.
            'check-readback:before': [MISSING, checkAvailable],
            'check-readback:after': [
              remoteAvailable(D, 'f'.repeat(64), {
                pullRequest: { identity: D, state: 'open' },
                checkState: 'completed-success',
              }),
            ],
            'review-readback:before': [
              MISSING,
              remoteAvailable(D, E, {
                pullRequest: { identity: D, state: 'open' },
                reviewDecision: 'required',
              }),
            ],
            'review-readback:after': [
              remoteAvailable(D, 'f'.repeat(64), {
                pullRequest: { identity: D, state: 'open' },
                reviewDecision: 'approved',
              }),
            ],
          },
        )
        let beforeReads = 0
        return createAdapter(
          'observe',
          false,
          {
            ...base,
            remoteSnapshot: async (operation, phase) => {
              const isHookRead =
                operation === 'pr-creation' &&
                phase === 'before' &&
                ++beforeReads >= 2
              if (!isHookRead)
                return base.remoteSnapshot?.(operation, phase) ?? UNREADABLE
              if (hookBefore === 'throw') throw new Error('probe failed')
              return hookBefore
            },
          },
          ['pr-creation', 'check-readback', 'review-readback'],
        )
      }

      // The guard exposes no baseline accessor through the adapter, so probe
      // the downstream baselines behaviorally: with no baseline a check or
      // review before-read for any PR is a resource-mismatch and mints
      // nothing; with the PR propagated from creation it is admitted.
      async function admittedDownstream(
        adapter: OpencodeWorkflowGuard,
      ): Promise<string[]> {
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'gh pr checks 42' },
          { title: 'checks', output: 'ok', metadata: { exit: 0 } },
          'probe-check',
        )
        await observeOperationTool(
          adapter,
          'bash',
          { command: 'gh pr view 42 --json reviewDecision' },
          { title: 'review', output: 'ok', metadata: { exit: 0 } },
          'probe-review',
        )
        return ledger(adapter)
          .listReceipts()
          .map((receipt) => receipt.canonical.operation)
          .filter(
            (operation) =>
              operation === 'check-readback' || operation === 'review-readback',
          )
          .sort()
      }

      function prReceipts(adapter: OpencodeWorkflowGuard): number {
        return ledger(adapter)
          .listReceipts()
          .filter((receipt) => receipt.canonical.operation === 'pr-creation')
          .length
      }

      test.each([
        ['a: unavailable/command-timeout', TIMEOUT],
        [
          'b: another unavailable reason',
          { status: 'unavailable', reasonCode: 'remote-missing-field' },
        ],
        ['c: a before-read that throws', 'throw'],
      ] as const)(
        '%s never seeds from the after-read and is not admitted',
        async (_name, hookBefore) => {
          const adapter = prAdapter(hookBefore)
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          await observeOperationTool(
            adapter,
            'bash',
            PR_CREATE,
            { title: 'pr', output: 'created', metadata: { exit: 0 } },
            'pr-self-seed',
          )
          expect(prReceipts(adapter)).toBe(0)
          expect(status(adapter).state).not.toBe('unavailable')
          expect(status(adapter).missingOperations).toContain('pr-creation')
          // No self-seed happened, so nothing was propagated downstream.
          expect(await admittedDownstream(adapter)).toEqual([])
        },
      )

      test('d: a missing-resource before-read still seeds from the after-read and mints', async () => {
        const adapter = prAdapter(MISSING)
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await observeOperationTool(
          adapter,
          'bash',
          PR_CREATE,
          { title: 'pr', output: 'created', metadata: { exit: 0 } },
          'pr-self-seed',
        )
        expect(prReceipts(adapter)).toBe(1)
        expect(status(adapter).state).not.toBe('unavailable')
        // Positive control: the self-seed set the pr-creation baseline and
        // propagated it, so the same PR is admitted downstream.
        expect(await admittedDownstream(adapter)).toEqual([
          'check-readback',
          'review-readback',
        ])
      })

      test('e: a PR present before, with an unchanged head after, is a no-op', async () => {
        const adapter = prAdapter(prAvailable)
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await observeOperationTool(
          adapter,
          'bash',
          PR_CREATE,
          { title: 'pr', output: 'exists', metadata: { exit: 1 } },
          'pr-self-seed',
        )
        expect(prReceipts(adapter)).toBe(0)
        expect(status(adapter).state).not.toBe('unavailable')
        expect(await admittedDownstream(adapter)).toEqual([])
      })
    })

    test('j: the deferral list never enters markers, receipts, tool metadata, or digests', async () => {
      const deferred = deferralAdapter('observe', ['push'], {
        'push:before': [TIMEOUT],
      })
      const skillOutput = { title: 'Loaded skill', output: 'ok', metadata: {} }
      await observeSkill(
        deferred,
        'systematic_skill',
        'ce:work',
        'deferral-skill',
        SESSION_A,
        skillOutput,
      )
      const statusResult = expectToolOutput(
        await getTool(deferred, 'systematic_workflow_status').execute(
          {},
          toolContext(),
        ),
      )
      expect(JSON.parse(statusResult.output).seedDeferrals).toBeDefined()
      const transformed = { system: ['base'] }
      await deferred.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        transformed,
      )
      const everything = JSON.stringify([
        skillOutput,
        statusResult.metadata,
        transformed.system,
        ledger(deferred).listReceipts(),
        status(deferred),
      ])
      expect(everything).not.toContain('seedDeferrals')
      expect(everything).not.toContain('command-timeout')
    })
  })

  describe('guard-unavailable first-cause diagnostic (seedRemoteScopes)', () => {
    // sequenceObserver's default remoteResults is `{}`: any operation/phase
    // key not supplied resolves to `{status:'unavailable', reasonCode:
    // 'remote-missing-field'}` (see helper above), reproducing the real
    // seeding failure from CI run 35405852057 (push scenario, zero mint
    // markers, guard-unavailable).
    function pushSeedingFailureAdapter(): OpencodeWorkflowGuard {
      return createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
        ['push'],
      )
    }

    test('seeding failure records first-cause site, operation, and reasonCode', async () => {
      const adapter = pushSeedingFailureAdapter()
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).toBe('unavailable')

      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      const parsed = JSON.parse(expectToolOutput(result).output)
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'seed-remote-scope',
        kind: 'remote-scope-unavailable',
        operation: 'push',
        reasonCode: 'remote-missing-field',
        timedOut: false,
      })
    })

    test('a later, unrelated markUnavailable() does not overwrite the recorded cause', async () => {
      const adapter = pushSeedingFailureAdapter()
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).toBe('unavailable')

      const before = JSON.parse(
        expectToolOutput(
          await getTool(adapter, 'systematic_workflow_status').execute(
            {},
            toolContext(),
          ),
        ).output,
      )
      expect(before.firstUnavailableCause).toBeDefined()

      // Trigger a second, wholly unrelated markUnavailable(): reusing a
      // callID across two different call kinds (skill vs start) trips the
      // bindCall conflict path (opencode-workflow-guard.ts bindCall()),
      // which never touches the seeding first-cause record.
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'reused-call',
        },
        { args: { name: 'ce:work' } },
      )
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'reused-call',
        },
        { args: {} },
      )

      const after = JSON.parse(
        expectToolOutput(
          await getTool(adapter, 'systematic_workflow_status').execute(
            {},
            toolContext(),
          ),
        ).output,
      )
      expect(after.firstUnavailableCause).toEqual(before.firstUnavailableCause)
    })

    test('cause is absent when the guard never goes unavailable', async () => {
      const adapter = createAdapter('observe')
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).not.toBe('unavailable')

      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      const parsed = JSON.parse(expectToolOutput(result).output)
      expect(parsed.firstUnavailableCause).toBeUndefined()
    })

    test('the diagnostic never enters the marker envelope', async () => {
      const adapter = pushSeedingFailureAdapter()
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).toBe('unavailable')

      const output: { system: string[] } = { system: [] }
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        output,
      )
      const marker = output.system.join('\n')
      expect(marker).toContain('guard-unavailable')
      expect(marker).not.toContain('firstUnavailableCause')
      const markerJson = JSON.parse(
        marker.slice(marker.indexOf('{'), marker.lastIndexOf('}') + 1),
      )
      expect(Object.keys(markerJson).sort()).toEqual(
        ['aggregate', 'protocolVersion', 'sources'].sort(),
      )
    })

    test('the diagnostic is emitted only while state is unavailable, not after unavailable -> disabled', async () => {
      const adapter = pushSeedingFailureAdapter()
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).toBe('unavailable')
      const before = JSON.parse(
        expectToolOutput(
          await getTool(adapter, 'systematic_workflow_status').execute(
            {},
            toolContext(),
          ),
        ).output,
      )
      expect(before.firstUnavailableCause).toBeDefined()

      const control = await getTool(
        adapter,
        'systematic_workflow_control',
      ).execute({ mode: 'disabled' }, toolContext())
      expect(expectToolOutput(control).output).toContain('question-attestation')
      const questionOutput = { args: {} as Record<string, unknown> }
      await adapter.hooks['tool.execute.before'](
        { tool: 'question', sessionID: SESSION_A, callID: 'disable-question' },
        questionOutput,
      )
      await observeQuestionEvent(adapter, 'question.asked', {
        id: 'disable-request',
        sessionID: SESSION_A,
        questions: [],
        tool: { callID: 'disable-question' },
      })
      await observeQuestionEvent(adapter, 'question.replied', {
        sessionID: SESSION_A,
        requestID: 'disable-request',
        answers: [['confirm']],
      })
      const disabled = await getTool(
        adapter,
        'systematic_workflow_control',
      ).execute({ mode: 'disabled' }, toolContext())
      expect(expectToolOutput(disabled).output).toContain('disabled')
      expect(status(adapter).state).toBe('disabled')

      const after = JSON.parse(
        expectToolOutput(
          await getTool(adapter, 'systematic_workflow_status').execute(
            {},
            toolContext(),
          ),
        ).output,
      )
      expect(after.firstUnavailableCause).toBeUndefined()
    })

    test('a competing markUnavailable() while seeding is suspended wins the race; the resumed seeding failure must not become the recorded cause', async () => {
      function deferredResult<T>(): {
        promise: Promise<T>
        resolve: (value: T) => void
      } {
        let resolve!: (value: T) => void
        const promise = new Promise<T>((res) => {
          resolve = res
        })
        return { promise, resolve }
      }

      const pushBefore = deferredResult<OperationObserverRemoteResult>()
      // Latch, not a microtask-turn count: the stub signals it has actually
      // been entered and is suspended on `pushBefore`, so the test never
      // depends on how many awaits precede the remoteSnapshot call.
      const enteredRemoteSnapshot = deferredResult<void>()
      const controllableObserver: OpencodeOperationObserver = {
        targetDigest: OPERATION_SCOPE.workspaceIdentity,
        validateRegisteredWorktree: (candidateDirectory) => ({
          status: 'ok',
          targetRoot: candidateDirectory,
          gitDir: path.join(candidateDirectory, '.git'),
          commonDir: path.join(candidateDirectory, '.git'),
        }),
        async snapshot() {
          return { status: 'available', snapshot: operationSnapshot() }
        },
        async remoteSnapshot(operation, phase) {
          if (operation === 'push' && phase === 'before') {
            enteredRemoteSnapshot.resolve()
            return pushBefore.promise
          }
          return { status: 'unavailable', reasonCode: 'remote-missing-field' }
        },
      }
      const adapter = createAdapter('observe', false, controllableObserver, [
        'push',
      ])

      // Start unit 1's activation. Its seeding suspends inside
      // seedRemoteScope, awaiting the controlled push:before promise.
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'race-skill',
        },
        { args: { name: 'ce:work' } },
      )
      const activation = adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'race-skill',
          args: { name: 'ce:work' },
        },
        { title: 'x', output: 'y', metadata: {} },
      )
      await enteredRemoteSnapshot.promise

      // While unit 1's seeding is still suspended, a wholly unrelated
      // markUnavailable() (bindCall conflict) wins the transition.
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'race-conflict',
        },
        { args: { name: 'ce:work' } },
      )
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'race-conflict',
        },
        { args: {} },
      )
      expect(status(adapter).state).toBe('unavailable')

      // Now resume the suspended seeding into a failure.
      pushBefore.resolve({
        status: 'unavailable',
        reasonCode: 'remote-missing-field',
      })
      await activation

      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      const parsed = JSON.parse(expectToolOutput(result).output)
      // The competing bindCall conflict won the transition and now carries a
      // call-lifecycle-mismatch cause; the resumed seeding failure must not
      // replace it.
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'call-lifecycle-mismatch',
        timedOut: false,
      })
    })

    test('table: every GuardUnavailableCauseKind reports the correct site, operation, and reasonCode', async () => {
      interface UnavailableCase {
        readonly name: string
        readonly observer: OpencodeOperationObserver
        readonly expected: {
          readonly site: 'seed-remote-scopes' | 'seed-remote-scope'
          readonly kind: string
          readonly operation?: 'push'
          readonly reasonCode?: string
          readonly timedOut: boolean
        }
      }
      interface DeferredCase {
        readonly name: string
        readonly observer: OpencodeOperationObserver
        readonly deferred: {
          readonly operation: 'push'
          readonly reasonCode: 'command-timeout' | 'missing-resource'
        }
      }
      type CauseCase = UnavailableCase | DeferredCase

      const validateRegisteredWorktree = (candidateDirectory: string) => ({
        status: 'ok' as const,
        targetRoot: candidateDirectory,
        gitDir: path.join(candidateDirectory, '.git'),
        commonDir: path.join(candidateDirectory, '.git'),
      })

      const cases: readonly CauseCase[] = [
        {
          name: 'observer-not-configured',
          observer: {
            targetDigest: OPERATION_SCOPE.workspaceIdentity,
            validateRegisteredWorktree,
            async snapshot() {
              return { status: 'available', snapshot: operationSnapshot() }
            },
            // remoteSnapshot intentionally omitted.
          },
          expected: {
            site: 'seed-remote-scopes',
            kind: 'observer-not-configured',
            timedOut: false,
          },
        },
        {
          name: 'local-snapshot-error',
          observer: {
            targetDigest: OPERATION_SCOPE.workspaceIdentity,
            validateRegisteredWorktree,
            async snapshot(): Promise<never> {
              throw new Error('snapshot failed')
            },
            async remoteSnapshot() {
              return {
                status: 'unavailable',
                reasonCode: 'remote-missing-field',
              }
            },
          },
          expected: {
            site: 'seed-remote-scopes',
            kind: 'local-snapshot-error',
            timedOut: false,
          },
        },
        {
          name: 'local-snapshot-unavailable, non-timeout reasonCode',
          observer: {
            targetDigest: OPERATION_SCOPE.workspaceIdentity,
            validateRegisteredWorktree,
            async snapshot() {
              return { status: 'unavailable', reasonCode: 'target-unavailable' }
            },
            async remoteSnapshot() {
              return {
                status: 'unavailable',
                reasonCode: 'remote-missing-field',
              }
            },
          },
          expected: {
            site: 'seed-remote-scopes',
            kind: 'local-snapshot-unavailable',
            reasonCode: 'target-unavailable',
            timedOut: false,
          },
        },
        {
          name: 'local-snapshot-unavailable, command-timeout',
          observer: {
            targetDigest: OPERATION_SCOPE.workspaceIdentity,
            validateRegisteredWorktree,
            async snapshot() {
              return { status: 'unavailable', reasonCode: 'command-timeout' }
            },
            async remoteSnapshot() {
              return {
                status: 'unavailable',
                reasonCode: 'remote-missing-field',
              }
            },
          },
          expected: {
            site: 'seed-remote-scopes',
            kind: 'local-snapshot-unavailable',
            reasonCode: 'command-timeout',
            timedOut: true,
          },
        },
        {
          name: 'remote-scope-unreadable',
          observer: {
            targetDigest: OPERATION_SCOPE.workspaceIdentity,
            validateRegisteredWorktree,
            async snapshot() {
              return { status: 'available', snapshot: operationSnapshot() }
            },
            async remoteSnapshot(): Promise<never> {
              throw new Error('remote read failed')
            },
          },
          expected: {
            site: 'seed-remote-scope',
            kind: 'remote-scope-unreadable',
            operation: 'push',
            timedOut: false,
          },
        },
        {
          name: 'push missing-resource defers the operation',
          observer: sequenceObserver([operationSnapshot()], {
            'push:before': [{ status: 'missing-resource' }],
          }),
          deferred: { operation: 'push', reasonCode: 'missing-resource' },
        },
        {
          name: 'remote-scope-unavailable, non-timeout reasonCode',
          observer: sequenceObserver([operationSnapshot()], {
            'push:before': [
              { status: 'unavailable', reasonCode: 'remote-missing-field' },
            ],
          }),
          expected: {
            site: 'seed-remote-scope',
            kind: 'remote-scope-unavailable',
            operation: 'push',
            reasonCode: 'remote-missing-field',
            timedOut: false,
          },
        },
        {
          name: 'remote command-timeout defers the operation',
          observer: sequenceObserver([operationSnapshot()], {
            'push:before': [
              { status: 'unavailable', reasonCode: 'command-timeout' },
            ],
          }),
          deferred: { operation: 'push', reasonCode: 'command-timeout' },
        },
        {
          name: 'remote-readback-rejected',
          observer: sequenceObserver([operationSnapshot()], {
            'push:before': [
              {
                status: 'available',
                snapshot: {
                  resourceIdentity: '',
                  resourceRevisionIdentity: 'e'.repeat(64),
                },
              },
            ],
          }),
          expected: {
            site: 'seed-remote-scope',
            kind: 'remote-readback-rejected',
            operation: 'push',
            reasonCode: 'invalid-receipt',
            timedOut: false,
          },
        },
      ]

      for (const causeCase of cases) {
        const adapter = createAdapter('observe', false, causeCase.observer, [
          'push',
        ])
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        const result = await getTool(
          adapter,
          'systematic_workflow_status',
        ).execute({}, toolContext())
        const parsed = JSON.parse(expectToolOutput(result).output)
        if ('deferred' in causeCase) {
          expect(status(adapter).state, causeCase.name).not.toBe('unavailable')
          expect(parsed.firstUnavailableCause, causeCase.name).toBeUndefined()
          expect(parsed.seedDeferrals, causeCase.name).toEqual([
            causeCase.deferred,
          ])
          continue
        }
        expect(status(adapter).state, causeCase.name).toBe('unavailable')
        expect(parsed.firstUnavailableCause, causeCase.name).toEqual(
          causeCase.expected,
        )
      }
    })

    test('seeding triggered through the explicit systematic_workflow_start path attributes its own failure', async () => {
      const observer = sequenceObserver(
        [
          operationSnapshot(),
          operationSnapshot(),
          operationSnapshot(),
          operationSnapshot(),
        ],
        {
          'push:before': [
            remoteAvailable('d'.repeat(64), 'e'.repeat(64)),
            remoteAvailable('d'.repeat(64), 'e'.repeat(64)),
            { status: 'unavailable', reasonCode: 'remote-missing-field' },
          ],
          'push:after': [remoteAvailable('d'.repeat(64), 'f'.repeat(64))],
        },
      )
      const adapter = createAdapter('observe', false, observer, ['push'])

      // Unit 1: created (and seeded successfully) by skill activation, then
      // fully satisfied and completed — freeing the epoch for a genuinely
      // new unit.
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      await observeOperationTool(
        adapter,
        'bash',
        { command: 'git push origin main' },
        { title: 'push', output: 'pushed', metadata: { exit: 0 } },
        'explicit-start-push',
      )
      mintReceipt(adapter, 'implementation', SESSION_A, OPERATION_SCOPE)
      mintReceipt(adapter, 'verification', SESSION_A, OPERATION_SCOPE)
      expect(status(adapter).missingOperations).toEqual([])
      await completeUnit(adapter, 'explicit-start-complete-unit1')
      expect(status(adapter).unit?.status).toBe('completed')
      const firstUnitId = status(adapter).unit?.unitId

      // Unit 2: started via the explicit systematic_workflow_start path
      // (finishStart), not skill activation. Its own seeding fails.
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'explicit-start-unit2',
        },
        { args: {} },
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'systematic_workflow_start',
          sessionID: SESSION_A,
          callID: 'explicit-start-unit2',
          args: {},
        },
        { title: 'x', output: 'y', metadata: {} },
      )

      expect(status(adapter).unit?.unitId).not.toBe(firstUnitId)
      expect(status(adapter).state).toBe('unavailable')
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      const parsed = JSON.parse(expectToolOutput(result).output)
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'seed-remote-scope',
        kind: 'remote-scope-unavailable',
        operation: 'push',
        reasonCode: 'remote-missing-field',
        timedOut: false,
      })
    })

    test('a cause recorded in one session does not appear in another session status', async () => {
      const adapter = pushSeedingFailureAdapter()
      const otherSessionID = 'session-isolation-other'
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter, SESSION_A).state).toBe('unavailable')

      const otherResult = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext(otherSessionID))
      const otherParsed = JSON.parse(expectToolOutput(otherResult).output)
      // An untouched session reports state 'inactive'/reasonCode
      // 'no-active-epoch' (nothing has happened yet) — distinct from the
      // mode-level 'guard-unavailable' session A hit. Assert on the
      // mode-level reasonCode and the cause itself, not on `state`.
      expect(otherParsed.reasonCode).not.toBe('guard-unavailable')
      expect(otherParsed.firstUnavailableCause).toBeUndefined()
    })
  })

  describe('guard-unavailable first-cause diagnostic (operation before-hook)', () => {
    const BEFORE_CAUSE_SESSION = SESSION_A

    function observerWithSnapshot(
      snapshot: OpencodeOperationObserver['snapshot'],
    ): OpencodeOperationObserver {
      return { ...sequenceObserver([operationSnapshot()]), snapshot }
    }

    async function beforeOperation(
      adapter: OpencodeWorkflowGuard,
      callID: string,
      args: unknown = { command: 'bun test' },
      tool: 'bash' | 'write' = 'bash',
    ): Promise<void> {
      await adapter.hooks['tool.execute.before'](
        { tool, sessionID: BEFORE_CAUSE_SESSION, callID },
        { args },
      )
    }

    async function causeOf(
      adapter: OpencodeWorkflowGuard,
    ): Promise<Record<string, unknown>> {
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext(BEFORE_CAUSE_SESSION))
      return JSON.parse(expectToolOutput(result).output)
    }

    test('a before snapshot that is unavailable records its observer reasonCode', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        observerWithSnapshot(async () => ({
          status: 'unavailable',
          reasonCode: 'file-output-limit',
        })),
      )
      await beforeOperation(adapter, 'before-file-output-limit')
      const parsed = await causeOf(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'file-output-limit',
        timedOut: false,
      })
    })

    test('a before snapshot command-timeout records timedOut', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        observerWithSnapshot(async () => ({
          status: 'unavailable',
          reasonCode: 'command-timeout',
        })),
      )
      await beforeOperation(adapter, 'before-timeout')
      expect((await causeOf(adapter)).firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'command-timeout',
        timedOut: true,
      })
    })

    test('a before snapshot that throws records local-snapshot-error without a reasonCode', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        observerWithSnapshot(async () => {
          throw new Error('snapshot exploded with /secret/path')
        }),
      )
      await beforeOperation(adapter, 'before-throws')
      const parsed = await causeOf(adapter)
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'local-snapshot-error',
        timedOut: false,
      })
      expect(JSON.stringify(parsed)).not.toContain('/secret/path')
    })

    test('a before snapshot for a different target digest records operation-target-mismatch', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        observerWithSnapshot(async () => ({
          status: 'available',
          snapshot: {
            ...operationSnapshot(),
            targetDigest: 'f'.repeat(64),
          },
        })),
      )
      await beforeOperation(adapter, 'before-digest-mismatch')
      expect((await causeOf(adapter)).firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'operation-target-mismatch',
        timedOut: false,
      })
    })

    describe('registered-worktree validation failures record operation-input-invalid', () => {
      const base = sequenceObserver([operationSnapshot()])
      const cases: ReadonlyArray<{
        readonly name: string
        readonly validate: OpencodeOperationObserver['validateRegisteredWorktree']
        readonly reasonCode?: OperationObserverReasonCode
      }> = [
        {
          name: 'unregistered worktree with a validation reason',
          validate: () => ({ status: 'error', reasonCode: 'command-failed' }),
          reasonCode: 'command-failed',
        },
        {
          name: 'validation timeout',
          validate: () => ({ status: 'error', reasonCode: 'command-timeout' }),
          reasonCode: 'command-timeout',
        },
        {
          name: 'ok validation for a different target root',
          validate: (candidateDirectory) => ({
            status: 'ok',
            targetRoot: path.join(candidateDirectory, 'elsewhere'),
            gitDir: '/git',
            commonDir: '/git',
          }),
        },
        {
          name: 'validation that throws',
          validate: () => {
            throw new Error('validation exploded')
          },
        },
      ]

      for (const validationCase of cases) {
        test(validationCase.name, async () => {
          const adapter = createAdapter('observe', false, {
            ...base,
            validateRegisteredWorktree: validationCase.validate,
          })
          await beforeOperation(adapter, 'before-validation')
          const parsed = await causeOf(adapter)
          expect(parsed.state).toBe('unavailable')
          expect(parsed.firstUnavailableCause).toEqual({
            site: 'tool-before',
            kind: 'operation-input-invalid',
            ...(validationCase.reasonCode === undefined
              ? {}
              : { reasonCode: validationCase.reasonCode }),
            timedOut: validationCase.reasonCode === 'command-timeout',
          })
        })
      }
    })

    test('arguments that cannot be fingerprinted record operation-input-invalid', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
      )
      await beforeOperation(adapter, 'before-no-fingerprint', {
        command: 'bun test',
        unserializable: undefined,
      })
      expect((await causeOf(adapter)).firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'operation-input-invalid',
        timedOut: false,
      })
    })

    test('a target that cannot be derived records operation-input-invalid', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
      )
      await beforeOperation(
        adapter,
        'before-git-admin-target',
        { filePath: '.git/config', content: 'x' },
        'write',
      )
      const parsed = await causeOf(adapter)
      expect(parsed.firstUnavailableCause).toMatchObject({
        site: 'tool-before',
        kind: 'operation-input-invalid',
        timedOut: false,
      })
    })

    test('a real non-git workspace records operation-input-invalid with command-failed on the first operation', async () => {
      const worktree = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-non-git-')),
      )
      try {
        const adapter = createOpencodeWorkflowGuard({
          config: { mode: 'observe', debug: false },
          ...OPERATION_SCOPE,
          targetDirectory: worktree,
          observer: createOpencodeOperationObserver({
            targetDirectory: worktree,
          }),
          classifier: createReceiptClassifier(),
          runtimeRequiredOperations: [],
        })
        await beforeOperation(adapter, 'before-non-git')
        const parsed = await causeOf(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'tool-before',
          kind: 'operation-input-invalid',
          reasonCode: 'command-failed',
          timedOut: false,
        })
      } finally {
        fs.rmSync(worktree, { recursive: true, force: true })
      }
    })

    test('a registered worktree whose snapshot fails with command-failed records local-snapshot-unavailable', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        observerWithSnapshot(async () => ({
          status: 'unavailable',
          reasonCode: 'command-failed',
        })),
      )
      await beforeOperation(adapter, 'before-snapshot-command-failed')
      expect((await causeOf(adapter)).firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'command-failed',
        timedOut: false,
      })
    })

    test('a callID reused across call kinds records call-lifecycle-mismatch on an operation call', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
      )
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: BEFORE_CAUSE_SESSION,
          callID: 'reused-operation-call',
        },
        { args: { name: 'ce:work' } },
      )
      expect(status(adapter).state).not.toBe('unavailable')
      await beforeOperation(adapter, 'reused-operation-call')
      const parsed = await causeOf(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'call-lifecycle-mismatch',
        timedOut: false,
      })
    })

    test('a callID reused across skill and start calls records call-lifecycle-mismatch', async () => {
      const adapter = createAdapter('observe')
      for (const tool of ['systematic_skill', 'systematic_workflow_start']) {
        await adapter.hooks['tool.execute.before'](
          {
            tool,
            sessionID: BEFORE_CAUSE_SESSION,
            callID: 'reused-skill-start-call',
          },
          { args: tool === 'systematic_skill' ? { name: 'ce:work' } : {} },
        )
      }
      expect((await causeOf(adapter)).firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'call-lifecycle-mismatch',
        timedOut: false,
      })
    })

    test('a callID reused across skill and complete calls records call-lifecycle-mismatch', async () => {
      const adapter = createAdapter('observe')
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: BEFORE_CAUSE_SESSION,
          callID: 'reused-skill-complete-call',
        },
        { args: { name: 'ce:work' } },
      )
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'systematic_workflow_complete',
          sessionID: BEFORE_CAUSE_SESSION,
          callID: 'reused-skill-complete-call',
        },
        { args: { target: 'unit' } },
      )
      const parsed = await causeOf(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'tool-before',
        kind: 'call-lifecycle-mismatch',
        timedOut: false,
      })
    })

    test('the first before-hook cause wins over a later failing operation', async () => {
      let mode: 'unavailable' | 'throws' = 'unavailable'
      const adapter = createAdapter(
        'observe',
        false,
        observerWithSnapshot(async () => {
          if (mode === 'throws') throw new Error('later failure')
          return { status: 'unavailable', reasonCode: 'file-output-limit' }
        }),
      )
      await beforeOperation(adapter, 'first-wins-1')
      const first = (await causeOf(adapter)).firstUnavailableCause
      expect(first).toEqual({
        site: 'tool-before',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'file-output-limit',
        timedOut: false,
      })
      mode = 'throws'
      await beforeOperation(adapter, 'first-wins-2', { command: 'bun lint' })
      expect((await causeOf(adapter)).firstUnavailableCause).toEqual(first)
    })
  })

  describe('guard-unavailable first-cause diagnostic (operation after-hook)', () => {
    const D = 'd'.repeat(64)
    const E = 'e'.repeat(64)
    const COMMAND = { command: 'bun test' }
    const OUTPUT = { title: 'run', output: 'ok', metadata: { exit: 0 } }

    interface ArmedOverrides {
      readonly snapshot?: OpencodeOperationObserver['snapshot']
      readonly validate?: OpencodeOperationObserver['validateRegisteredWorktree']
    }

    // Behaves normally through the before-hook; `arm()` switches the supplied
    // overrides on for the after-hook.
    function armable(
      overrides: ArmedOverrides,
      remoteResults: Readonly<
        Record<string, readonly OperationObserverRemoteResult[]>
      > = {},
    ): { observer: OpencodeOperationObserver; arm: () => void } {
      let armed = false
      const base = sequenceObserver([operationSnapshot()], remoteResults)
      const observer: OpencodeOperationObserver = {
        ...base,
        snapshot: () =>
          armed && overrides.snapshot ? overrides.snapshot() : base.snapshot(),
        validateRegisteredWorktree: (candidateDirectory) =>
          armed && overrides.validate
            ? overrides.validate(candidateDirectory)
            : base.validateRegisteredWorktree(candidateDirectory),
      }
      return {
        observer,
        arm: () => {
          armed = true
        },
      }
    }

    async function afterHook(
      adapter: OpencodeWorkflowGuard,
      callID: string,
      args: Record<string, unknown> = COMMAND,
      output: unknown = OUTPUT,
    ): Promise<void> {
      await adapter.hooks['tool.execute.after'](
        { tool: 'bash', sessionID: SESSION_A, callID, args },
        output,
      )
    }

    async function beforeThenAfter(
      adapter: OpencodeWorkflowGuard,
      callID: string,
      arm?: () => void,
      output: unknown = OUTPUT,
    ): Promise<void> {
      await adapter.hooks['tool.execute.before'](
        { tool: 'bash', sessionID: SESSION_A, callID },
        { args: COMMAND },
      )
      arm?.()
      await afterHook(adapter, callID, COMMAND, output)
    }

    async function causeOf(adapter: OpencodeWorkflowGuard): Promise<unknown> {
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      const parsed = JSON.parse(expectToolOutput(result).output)
      return parsed.state === 'unavailable'
        ? parsed.firstUnavailableCause
        : 'not-unavailable'
    }

    async function activatedAdapter(
      observer: OpencodeOperationObserver,
      runtimeRequired: readonly ReceiptOperation[] = [],
      classifierOverride?: Record<string, unknown>,
    ): Promise<OpencodeWorkflowGuard> {
      const adapter = classifierOverride
        ? createOpencodeWorkflowGuard({
            config: { mode: 'observe', debug: false },
            ...OPERATION_SCOPE,
            observer,
            ...(classifierOverride.classifier === undefined
              ? {}
              : {
                  classifier: classifierOverride.classifier as ReturnType<
                    typeof createReceiptClassifier
                  >,
                }),
            runtimeRequiredOperations: runtimeRequired,
          })
        : createAdapter('observe', false, observer, runtimeRequired)
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      expect(status(adapter).state).not.toBe('unavailable')
      return adapter
    }

    function afterCause(
      kind: string,
      reasonCode?: string,
      timedOut = false,
    ): Record<string, unknown> {
      return {
        site: 'tool-after',
        kind,
        ...(reasonCode === undefined ? {} : { reasonCode }),
        timedOut,
      }
    }

    test('a completion the guard refuses to finalize records transition-finalize-rejected with the guard reason', async () => {
      const adapter = createAdapter('observe')
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      mintReceipt(adapter, 'implementation')
      mintReceipt(adapter, 'verification')
      const input = {
        tool: 'systematic_workflow_complete',
        sessionID: SESSION_A,
        callID: 'finalize-rejected',
      }
      await adapter.hooks['tool.execute.before'](input, {
        args: { target: 'unit' },
      })
      // Consume a receipt out-of-band after the transition was prepared, so
      // the guard refuses to finalize it.
      const current = status(adapter)
      const receipt = ledger(adapter)
        .listReceipts()
        .find((candidate) => candidate.canonical.operation === 'implementation')
      if (!receipt || !current.epoch || !current.unit) {
        throw new Error('finalize rejection fixture missing')
      }
      ledger(adapter).consumeReceipt(receipt.canonical.receiptId, {
        epochId: current.epoch.epochId,
        unitId: current.unit.unitId,
        workspaceIdentity: SCOPE.workspaceIdentity,
        repositoryIdentity: SCOPE.repositoryIdentity,
        worktreeIdentity: SCOPE.worktreeIdentity,
        operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
      })
      await adapter.hooks['tool.execute.after'](
        { ...input, args: { target: 'unit' } },
        { title: 'complete', output: 'done', metadata: {} },
      )
      expect(await causeOf(adapter)).toEqual({
        site: 'tool-after',
        kind: 'transition-finalize-rejected',
        reasonCode: 'consumed-receipt',
        timedOut: false,
      })
    })

    test('an after hook with no pending operation records call-lifecycle-mismatch', async () => {
      const adapter = await activatedAdapter(
        sequenceObserver([operationSnapshot()]),
      )
      await afterHook(adapter, 'after-no-pending')
      expect(await causeOf(adapter)).toEqual(
        afterCause('call-lifecycle-mismatch'),
      )
    })

    test('an after hook whose args differ from the pending operation records call-lifecycle-mismatch', async () => {
      const adapter = await activatedAdapter(
        sequenceObserver([operationSnapshot()]),
      )
      await adapter.hooks['tool.execute.before'](
        { tool: 'bash', sessionID: SESSION_A, callID: 'after-mismatch' },
        { args: COMMAND },
      )
      await afterHook(adapter, 'after-mismatch', { command: 'bun lint' })
      expect(await causeOf(adapter)).toEqual(
        afterCause('call-lifecycle-mismatch'),
      )
    })

    test.each([
      ['missing metadata', { title: 'run', output: 'ok' }],
      ['oversized title', { title: 'x'.repeat(100_000), metadata: {} }],
      ['non-record output', 'not a record'],
    ] as const)(
      'an unparseable host output (%s) records operation-input-invalid',
      async (_name, output) => {
        const adapter = await activatedAdapter(
          sequenceObserver([operationSnapshot()]),
        )
        await beforeThenAfter(adapter, 'after-bad-output', undefined, output)
        expect(await causeOf(adapter)).toEqual(
          afterCause('operation-input-invalid'),
        )
      },
    )

    describe('after-hook registered-worktree validation', () => {
      const cases: ReadonlyArray<{
        readonly name: string
        readonly validate: OpencodeOperationObserver['validateRegisteredWorktree']
        readonly reasonCode?: OperationObserverReasonCode
      }> = [
        {
          name: 'an error with a reason',
          validate: () => ({ status: 'error', reasonCode: 'command-failed' }),
          reasonCode: 'command-failed',
        },
        {
          name: 'a timeout',
          validate: () => ({ status: 'error', reasonCode: 'command-timeout' }),
          reasonCode: 'command-timeout',
        },
        {
          name: 'a different target root',
          validate: (candidateDirectory) => ({
            status: 'ok',
            targetRoot: path.join(candidateDirectory, 'elsewhere'),
            gitDir: '/git',
            commonDir: '/git',
          }),
        },
        {
          name: 'a different registered identity',
          validate: (candidateDirectory) => ({
            status: 'ok',
            targetRoot: candidateDirectory,
            gitDir: '/other-git',
            commonDir: '/other-git',
          }),
        },
        {
          name: 'a throw',
          validate: () => {
            throw new Error('validation exploded')
          },
        },
      ]
      for (const validationCase of cases) {
        test(`${validationCase.name} records operation-input-invalid`, async () => {
          const { observer, arm } = armable({
            validate: validationCase.validate,
          })
          const adapter = await activatedAdapter(observer)
          await beforeThenAfter(adapter, 'after-validation', arm)
          expect(await causeOf(adapter)).toEqual(
            afterCause(
              'operation-input-invalid',
              validationCase.reasonCode,
              validationCase.reasonCode === 'command-timeout',
            ),
          )
        })
      }
    })

    test('an after snapshot that is unavailable records its observer reasonCode', async () => {
      const { observer, arm } = armable({
        snapshot: async () => ({
          status: 'unavailable',
          reasonCode: 'file-output-limit',
        }),
      })
      const adapter = await activatedAdapter(observer)
      await beforeThenAfter(adapter, 'after-file-output-limit', arm)
      expect(await causeOf(adapter)).toEqual({
        site: 'tool-after',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'file-output-limit',
        timedOut: false,
      })
    })

    test('an after snapshot command-timeout records timedOut', async () => {
      const { observer, arm } = armable({
        snapshot: async () => ({
          status: 'unavailable',
          reasonCode: 'command-timeout',
        }),
      })
      const adapter = await activatedAdapter(observer)
      await beforeThenAfter(adapter, 'after-timeout', arm)
      expect(await causeOf(adapter)).toEqual(
        afterCause('local-snapshot-unavailable', 'command-timeout', true),
      )
    })

    test('an after snapshot that throws records local-snapshot-error', async () => {
      const { observer, arm } = armable({
        snapshot: async () => {
          throw new Error('after snapshot exploded')
        },
      })
      const adapter = await activatedAdapter(observer)
      await beforeThenAfter(adapter, 'after-throws', arm)
      expect(await causeOf(adapter)).toEqual(afterCause('local-snapshot-error'))
    })

    test('an after snapshot for a different target digest records operation-target-mismatch', async () => {
      const { observer, arm } = armable({
        snapshot: async () => ({
          status: 'available',
          snapshot: { ...operationSnapshot(), targetDigest: 'f'.repeat(64) },
        }),
      })
      const adapter = await activatedAdapter(observer)
      await beforeThenAfter(adapter, 'after-digest-mismatch', arm)
      expect(await causeOf(adapter)).toEqual(
        afterCause('operation-target-mismatch'),
      )
    })

    describe('classifier not ready', () => {
      const realClassifier = createReceiptClassifier()

      test('a missing classifier records operation-classifier-unavailable', async () => {
        const adapter = await activatedAdapter(
          sequenceObserver([operationSnapshot()]),
          [],
          {},
        )
        await beforeThenAfter(adapter, 'after-no-classifier')
        expect(await causeOf(adapter)).toEqual(
          afterCause('operation-classifier-unavailable'),
        )
      })

      test('a classifier that throws records operation-classifier-unavailable', async () => {
        const adapter = await activatedAdapter(
          sequenceObserver([operationSnapshot()]),
          [],
          {
            classifier: {
              ...realClassifier,
              classifyOperation: async () => {
                throw new Error('classifier exploded')
              },
            },
          },
        )
        await beforeThenAfter(adapter, 'after-classifier-throws')
        expect(await causeOf(adapter)).toEqual(
          afterCause('operation-classifier-unavailable'),
        )
      })

      test('a classifier that returns an unexpected category records operation-classifier-unavailable', async () => {
        const adapter = await activatedAdapter(
          sequenceObserver([operationSnapshot()]),
          [],
          {
            classifier: {
              ...realClassifier,
              classifyOperation: async () => ({
                outcome: 'accepted',
                category: 'bogus-category',
              }),
            },
          },
        )
        await beforeThenAfter(adapter, 'after-classifier-bogus')
        expect(await causeOf(adapter)).toEqual(
          afterCause('operation-classifier-unavailable'),
        )
      })
    })

    describe('operation-observation-rejected', () => {
      const PUSH = { command: 'git push origin main' }

      async function pushAfter(
        adapter: OpencodeWorkflowGuard,
        callID: string,
      ): Promise<void> {
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID },
          { args: PUSH },
        )
        await afterHook(adapter, callID, PUSH)
      }

      const pushCases: ReadonlyArray<{
        readonly name: string
        readonly after: OperationObserverRemoteResult | 'throw'
        readonly reasonCode?: string
      }> = [
        {
          name: 'a remote after-read that is unavailable',
          after: { status: 'unavailable', reasonCode: 'remote-missing-field' },
          reasonCode: 'remote-missing-field',
        },
        {
          name: 'a remote after-read that times out',
          after: { status: 'unavailable', reasonCode: 'command-timeout' },
          reasonCode: 'command-timeout',
        },
        {
          name: 'a remote after-read with a missing resource',
          after: { status: 'missing-resource' },
          reasonCode: 'missing-resource',
        },
        { name: 'a remote after-read that throws', after: 'throw' },
      ]

      for (const pushCase of pushCases) {
        test(`${pushCase.name} records operation-observation-rejected`, async () => {
          const base = sequenceObserver([operationSnapshot()], {
            'push:before': [remoteAvailable(D, E), remoteAvailable(D, E)],
          })
          const observer: OpencodeOperationObserver = {
            ...base,
            remoteSnapshot: async (operation, phase) => {
              if (operation === 'push' && phase === 'after') {
                if (pushCase.after === 'throw') throw new Error('probe failed')
                return pushCase.after
              }
              return (
                base.remoteSnapshot?.(operation, phase) ?? {
                  status: 'unavailable',
                  reasonCode: 'remote-missing-field',
                }
              )
            },
          }
          const adapter = await activatedAdapter(observer, ['push'])
          await pushAfter(adapter, 'after-remote')
          expect(await causeOf(adapter)).toEqual(
            afterCause(
              'operation-observation-rejected',
              pushCase.reasonCode,
              pushCase.reasonCode === 'command-timeout',
            ),
          )
        })
      }

      test('a pr-creation self-seed readback the guard rejects records operation-observation-rejected with the guard reason', async () => {
        const MISSING = { status: 'missing-resource' as const }
        const base = sequenceObserver([operationSnapshot()], {
          'pr-creation:before': [MISSING],
          // An empty resource identity cannot be seeded as a baseline.
          'pr-creation:after': [
            remoteAvailable('', E, {
              pullRequest: { identity: D, state: 'open' },
            }),
          ],
        })
        const adapter = await activatedAdapter(base, ['pr-creation'])
        const create = { command: 'gh pr create --title t --body b' }
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID: 'after-pr-seed' },
          { args: create },
        )
        await afterHook(adapter, 'after-pr-seed', create)
        expect(await causeOf(adapter)).toEqual(
          afterCause('operation-observation-rejected', 'invalid-receipt'),
        )
      })

      test('a guard observeOperation that throws records operation-observation-rejected', async () => {
        const realClassifier = createReceiptClassifier()
        const classify = realClassifier.classifyOperation
        if (!classify)
          throw new Error('classifier implements classifyOperation')
        let calls = 0
        const adapter = await activatedAdapter(
          sequenceObserver([operationSnapshot()]),
          [],
          {
            classifier: {
              ...realClassifier,
              classifyOperation: async (input: unknown) => {
                calls += 1
                const classification = await classify(input)
                if (calls === 1) return classification
                return {
                  ...classification,
                  get outcome(): never {
                    throw new Error('guard admission exploded')
                  },
                }
              },
            },
          },
        )
        await beforeThenAfter(adapter, 'after-observe-throws')
        expect(await causeOf(adapter)).toEqual(
          afterCause('operation-observation-rejected'),
        )
      })

      test('a guard observeOperation that returns unavailable carries the guard reasonCode', async () => {
        // The first accepted local operation pins the unit's operation target;
        // a second operation under a different target digest makes the guard
        // itself answer unavailable/operation-target-mismatch.
        let targetDigest = OPERATION_SCOPE.workspaceIdentity
        const base = sequenceObserver([operationSnapshot()])
        const observer: OpencodeOperationObserver = {
          ...base,
          get targetDigest() {
            return targetDigest
          },
          snapshot: async () => ({
            status: 'available',
            snapshot: { ...operationSnapshot(), targetDigest },
          }),
        }
        const adapter = await activatedAdapter(observer)
        await beforeThenAfter(adapter, 'after-pin-target')
        expect(await causeOf(adapter)).toBe('not-unavailable')
        targetDigest = 'f'.repeat(64)
        await beforeThenAfter(adapter, 'after-guard-unavailable')
        expect(await causeOf(adapter)).toEqual(
          afterCause(
            'operation-observation-rejected',
            'operation-target-mismatch',
          ),
        )
      })
    })

    test('a before-hook cause keeps winning over a later after-hook failure', async () => {
      const { observer } = armable({})
      const failingBefore: OpencodeOperationObserver = {
        ...observer,
        snapshot: async () => ({
          status: 'unavailable',
          reasonCode: 'file-output-limit',
        }),
      }
      const adapter = createAdapter('observe', false, failingBefore)
      await beforeThenAfter(adapter, 'first-wins-after')
      expect(await causeOf(adapter)).toEqual({
        site: 'tool-before',
        kind: 'local-snapshot-unavailable',
        reasonCode: 'file-output-limit',
        timedOut: false,
      })
    })
  })

  describe('guard-unavailable first-cause diagnostic (hook-threw)', () => {
    const BOOM = 'boom /path/secret-AKIA0000.env token=abc'
    const FORBIDDEN = ['secret', 'AKIA', 'boom', '/path', 'token']
    const ALLOWED_CAUSE_KEYS = [
      'site',
      'kind',
      'reasonCode',
      'operation',
      'timedOut',
    ]

    function boom(): never {
      throw new Error(BOOM)
    }

    async function statusOutput(adapter: OpencodeWorkflowGuard): Promise<{
      raw: string
      parsed: Record<string, unknown>
    }> {
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext())
      const raw = expectToolOutput(result).output
      return { raw, parsed: JSON.parse(raw) }
    }

    function hookThrew(site: string): Record<string, unknown> {
      return { site, kind: 'hook-threw', timedOut: false }
    }

    // An exception raised while the runtime before-hook prepares the call (a
    // host payload accessor that throws) is caught by the runtime before().
    async function throwInBefore(
      adapter: OpencodeWorkflowGuard,
      callID = 'throw-before',
    ): Promise<void> {
      await adapter.hooks['tool.execute.before'](
        { tool: 'bash', sessionID: SESSION_A, callID },
        {
          get args(): unknown {
            return boom()
          },
        },
      )
    }

    // A successful before-hook, then a host output whose accessor throws while
    // the after-hook parses it: caught by the runtime after().
    async function throwInAfter(
      adapter: OpencodeWorkflowGuard,
      callID = 'throw-after',
      args: Record<string, unknown> = { command: 'bun test' },
    ): Promise<void> {
      await adapter.hooks['tool.execute.before'](
        { tool: 'bash', sessionID: SESSION_A, callID },
        { args },
      )
      await adapter.hooks['tool.execute.after'](
        { tool: 'bash', sessionID: SESSION_A, callID, args },
        {
          get title(): unknown {
            return boom()
          },
          output: 'ok',
          metadata: {},
        },
      )
    }

    test('an exception escaping the before hook records hook-threw at tool-before', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
      )
      await throwInBefore(adapter)
      const { parsed } = await statusOutput(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual(hookThrew('tool-before'))
    })

    test('an exception escaping the after hook records hook-threw at tool-after', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
      )
      await throwInAfter(adapter)
      const { parsed } = await statusOutput(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual(hookThrew('tool-after'))
    })

    test('an exception escaping the event hook records hook-threw at event', async () => {
      const adapter = createAdapter('observe')
      // Initialize the session first so the throw reaches the recording path
      // (the pre-initialization case is covered by the next test).
      await adapter.hooks.event({
        event: {
          type: 'message.updated',
          properties: { sessionID: SESSION_A },
        },
      })
      await adapter.hooks.event({
        event: {
          get type(): unknown {
            return boom()
          },
          properties: { sessionID: SESSION_A },
        },
      })
      const { parsed } = await statusOutput(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual(hookThrew('event'))
    })

    test('a first-ever event that throws before the session guard exists does not leak out of the hook', async () => {
      const adapter = createAdapter('observe')
      await expect(
        adapter.hooks.event({
          event: {
            get type(): unknown {
              return boom()
            },
            properties: { sessionID: SESSION_A },
          },
        }),
      ).resolves.toBeUndefined()
      // The failure is held pending and committed when the session's guard is
      // published, so the hook's failure is not forgotten.
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      const { parsed } = await statusOutput(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual(hookThrew('event'))
    })

    describe('initialization that throws after the host read', () => {
      const INIT_CAUSE = {
        site: 'initialize-session',
        kind: 'initialization-threw',
        timedOut: false,
      }

      // A history part whose every property read throws makes marker
      // classification throw inside initializeSession.
      function throwingHistoryAdapter(
        mode: 'protected' | 'observe',
      ): OpencodeWorkflowGuard {
        return createOpencodeWorkflowGuard({
          config: { mode, debug: false },
          workspaceIdentity: 'workspace',
          registrationIdentity: 'init-threw-registration',
          sessionSalt: new Uint8Array(32).fill(5),
          hostReadback: {
            readSessionParts: async () => [
              new Proxy({}, { get: () => boom() }),
            ],
            listChildren: async () => [],
          },
        })
      }

      // A ledger that cannot be minted: no guard can be published at all.
      function unpublishableAdapter(
        mode: 'protected' | 'observe',
      ): OpencodeWorkflowGuard {
        return createOpencodeWorkflowGuard({
          config: { mode, debug: false },
          workspaceIdentity: 'workspace',
          registrationIdentity: 'init-unpublishable-registration',
          sessionSalt: {
            get length(): number {
              return boom()
            },
          } as unknown as Uint8Array,
          hostReadback: {
            readSessionParts: async () => [],
            listChildren: async () => [],
          },
        })
      }

      async function beforeBash(
        adapter: OpencodeWorkflowGuard,
        callID: string,
      ): Promise<void> {
        await adapter.hooks['tool.execute.before'](
          { tool: 'bash', sessionID: SESSION_A, callID },
          { args: { command: 'bun test' } },
        )
      }

      async function caught(run: () => Promise<unknown>): Promise<unknown> {
        try {
          await run()
        } catch (error) {
          return error
        }
        return undefined
      }

      test('protected: marker classification that throws publishes unavailable with initialization-threw and later completions are rejected', async () => {
        const adapter = throwingHistoryAdapter('protected')
        await beforeBash(adapter, 'init-throws-1')
        const { parsed } = await statusOutput(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual(INIT_CAUSE)
        const error = await caught(() =>
          adapter.hooks['tool.execute.before'](
            {
              tool: 'systematic_workflow_complete',
              sessionID: SESSION_A,
              callID: 'init-throws-complete',
            },
            { args: { target: 'unit' } },
          ),
        )
        expect(isWorkflowGuardBlockedError(error)).toBe(true)
      })

      test('observe: marker classification that throws does not throw out of the hook and status shows the cause', async () => {
        const adapter = throwingHistoryAdapter('observe')
        await expect(beforeBash(adapter, 'init-throws-obs')).resolves.toBe(
          undefined,
        )
        const { parsed } = await statusOutput(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual(INIT_CAUSE)
      })

      test('protected: a before hook that throws while no guard can be published rejects the call', async () => {
        const adapter = unpublishableAdapter('protected')
        const error = await caught(() => beforeBash(adapter, 'no-guard-1'))
        expect(isWorkflowGuardBlockedError(error)).toBe(true)
        // Still no guard on the next hook: still rejected, never run unobserved.
        const again = await caught(() => beforeBash(adapter, 'no-guard-2'))
        expect(isWorkflowGuardBlockedError(again)).toBe(true)
        expect(status(adapter).state).toBe('unavailable')
      })

      test('observe: a before hook that throws while no guard can be published does not throw', async () => {
        const adapter = unpublishableAdapter('observe')
        await expect(beforeBash(adapter, 'no-guard-obs')).resolves.toBe(
          undefined,
        )
        expect(status(adapter).state).toBe('unavailable')
      })

      test.each(['protected', 'observe'] as const)(
        'a pending event failure survives provisional-history confirmation (%s)',
        async (mode) => {
          let reads = 0
          const adapter = createOpencodeWorkflowGuard({
            config: { mode, debug: false },
            workspaceIdentity: 'workspace',
            registrationIdentity: 'pending-survives-registration',
            sessionSalt: new Uint8Array(32).fill(8),
            hostReadback: {
              readSessionParts: async () => {
                reads += 1
                return []
              },
              listChildren: async () => [],
            },
          })
          // 1. The first event throws before the guard exists: queued.
          await adapter.hooks.event({
            event: {
              get type(): unknown {
                return boom()
              },
              properties: { sessionID: SESSION_A },
            },
          })
          // 2. The transform publishes a provisional guard and commits it.
          await adapter.hooks['experimental.chat.system.transform'](
            { sessionID: SESSION_A },
            { system: ['base'] },
          )
          expect(status(adapter).state).toBe('unavailable')
          // 3. A normal event must not republish an inactive guard over it.
          await adapter.hooks.event({
            event: {
              type: 'message.updated',
              properties: { sessionID: SESSION_A },
            },
          })
          const { parsed } = await statusOutput(adapter)
          expect(parsed.state).toBe('unavailable')
          expect(parsed.firstUnavailableCause).toEqual(hookThrew('event'))
          expect(reads).toBe(1)
        },
      )

      test('a deferred empty-history initialization stays retryable and records no cause', async () => {
        let reads = 0
        const adapter = createOpencodeWorkflowGuard({
          config: { mode: 'observe', debug: false },
          workspaceIdentity: 'workspace',
          registrationIdentity: 'init-deferred-registration',
          sessionSalt: new Uint8Array(32).fill(6),
          hostReadback: {
            readSessionParts: async () => {
              reads += 1
              return []
            },
            listChildren: async () => [],
          },
        })
        // The transform may not confirm a fresh session: provisional inactive.
        await adapter.hooks['experimental.chat.system.transform'](
          { sessionID: SESSION_A },
          { system: ['base'] },
        )
        expect(status(adapter).state).not.toBe('unavailable')
        // The next allow-fresh recovery re-reads the history and confirms it.
        await adapter.hooks.event({
          event: {
            type: 'message.updated',
            properties: { sessionID: SESSION_A },
          },
        })
        expect(reads).toBe(2)
        const { parsed } = await statusOutput(adapter)
        expect(parsed.state).not.toBe('unavailable')
        expect(parsed.firstUnavailableCause).toBeUndefined()
      })
    })

    test('an exception escaping the transform hook records hook-threw at transform', async () => {
      const adapter = createAdapter('observe')
      const system = Object.assign(['base prompt'], {
        filter: () => boom(),
      })
      await adapter.hooks['experimental.chat.system.transform'](
        { sessionID: SESSION_A },
        { system },
      )
      const { parsed } = await statusOutput(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual(hookThrew('transform'))
    })

    test('an earlier typed cause wins over a later hook-threw', async () => {
      const adapter = createAdapter(
        'observe',
        false,
        sequenceObserver([operationSnapshot()]),
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'bash',
          sessionID: SESSION_A,
          callID: 'typed-first',
          args: { command: 'bun test' },
        },
        { title: 'run', output: 'ok', metadata: {} },
      )
      await throwInBefore(adapter, 'typed-first-then-throw')
      const { parsed } = await statusOutput(adapter)
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'tool-after',
        kind: 'call-lifecycle-mismatch',
        timedOut: false,
      })
    })

    test('the cause never carries the error message, a path, or a file name', async () => {
      const worktree = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-hook-threw-')),
      )
      try {
        fs.writeFileSync(path.join(worktree, 'secret-AKIA0000.env'), 'k=v\n')
        const adapter = createOpencodeWorkflowGuard({
          config: { mode: 'observe', debug: false },
          ...OPERATION_SCOPE,
          targetDirectory: worktree,
          observer: sequenceObserver([operationSnapshot()]),
          classifier: createReceiptClassifier(),
          runtimeRequiredOperations: [],
        })
        const args = { filePath: 'secret-AKIA0000.env', content: 'k=v\n' }
        await adapter.hooks['tool.execute.before'](
          { tool: 'write', sessionID: SESSION_A, callID: 'secret-write' },
          { args },
        )
        await adapter.hooks['tool.execute.after'](
          { tool: 'write', sessionID: SESSION_A, callID: 'secret-write', args },
          {
            get title(): unknown {
              return boom()
            },
            output: 'ok',
            metadata: {},
          },
        )
        const { raw, parsed } = await statusOutput(adapter)
        expect(parsed.firstUnavailableCause).toEqual(hookThrew('tool-after'))
        const cause = parsed.firstUnavailableCause as Record<string, unknown>
        for (const key of Object.keys(cause)) {
          expect(ALLOWED_CAUSE_KEYS).toContain(key)
        }
        for (const forbidden of FORBIDDEN) {
          expect(raw).not.toContain(forbidden)
        }
      } finally {
        fs.rmSync(worktree, { recursive: true, force: true })
      }
    })

    describe('hook paths that already had a typed result now carry a cause', () => {
      test('a start after-hook with no pending start records call-lifecycle-mismatch', async () => {
        const adapter = createAdapter('observe')
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'start-no-pending',
            args: {},
          },
          { title: 'x', output: 'y', metadata: {} },
        )
        expect(
          (await statusOutput(adapter)).parsed.firstUnavailableCause,
        ).toEqual({
          site: 'tool-after',
          kind: 'call-lifecycle-mismatch',
          timedOut: false,
        })
      })

      test('a unit start the guard rejects records unit-start-rejected with the guard reason', async () => {
        // The guard validates the required operations when it is created, so
        // an invalid runtime policy is reached by corrupting the shared list
        // after initialization and before the skill rebuilds the policy.
        const required: ReceiptOperation[] = []
        const adapter = createAdapter(
          'observe',
          false,
          sequenceObserver([operationSnapshot()]),
          required,
        )
        await adapter.hooks.event({
          event: {
            type: 'message.updated',
            properties: { sessionID: SESSION_A },
          },
        })
        required.push('bogus-operation' as ReceiptOperation)
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        await adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'start-invalid-policy',
          },
          { args: {} },
        )
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_workflow_start',
            sessionID: SESSION_A,
            callID: 'start-invalid-policy',
            args: {},
          },
          { title: 'x', output: 'y', metadata: {} },
        )
        const { parsed } = await statusOutput(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site: 'tool-after',
          kind: 'unit-start-rejected',
          reasonCode: 'invalid-configuration',
          timedOut: false,
        })
      })

      test('a skill after-hook for a different skill than the before-hook records call-lifecycle-mismatch', async () => {
        const adapter = createAdapter('observe')
        await adapter.hooks['tool.execute.before'](
          {
            tool: 'systematic_skill',
            sessionID: SESSION_A,
            callID: 'skill-swap',
          },
          { args: { name: 'ce:work' } },
        )
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_skill',
            sessionID: SESSION_A,
            callID: 'skill-swap',
            args: { name: 'git-commit' },
          },
          { title: 'x', output: 'y', metadata: {} },
        )
        expect(
          (await statusOutput(adapter)).parsed.firstUnavailableCause,
        ).toEqual({
          site: 'tool-after',
          kind: 'call-lifecycle-mismatch',
          timedOut: false,
        })
      })

      test('a complete after-hook with no pending completion records call-lifecycle-mismatch', async () => {
        const adapter = createAdapter('observe')
        await adapter.hooks['tool.execute.after'](
          {
            tool: 'systematic_workflow_complete',
            sessionID: SESSION_A,
            callID: 'complete-no-pending',
            args: { target: 'unit' },
          },
          { title: 'x', output: 'y', metadata: {} },
        )
        expect(
          (await statusOutput(adapter)).parsed.firstUnavailableCause,
        ).toEqual({
          site: 'tool-after',
          kind: 'call-lifecycle-mismatch',
          timedOut: false,
        })
      })
    })

    // The type system now requires a cause on every `markUnavailable` call, so
    // the old source-text completeness guard is gone. `makeWorkflowTool`'s
    // `runtime.metadata()` catch has no reachable seam (it only throws if the
    // marker projection itself throws), so only the `context.metadata` catch
    // is exercised.
    test('a tool whose host metadata callback throws records hook-threw at tool-execute', async () => {
      const adapter = createAdapter('observe')
      const throwingContext = {
        ...toolContext(),
        metadata: () => boom(),
      }
      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        throwingContext,
      )
      const { parsed } = await statusOutput(adapter)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual(hookThrew('tool-execute'))
    })
  })

  test('before-only operation is abandoned at the next request boundary (transform), not by a status call', async () => {
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('d'.repeat(64), 'd'.repeat(64)),
      ]),
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await adapter.hooks['tool.execute.before'](
      { tool: 'write', sessionID: SESSION_A, callID: 'before-only' },
      { args: { filePath: 'pending.ts', content: 'pending' } },
    )
    // A status call is a sibling tool call and must not discard the entry.
    await getTool(adapter, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    await adapter.hooks['experimental.chat.system.transform'](
      { sessionID: SESSION_A },
      { system: ['base'] },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'before-only',
        args: { filePath: 'pending.ts', content: 'pending' },
      },
      { title: 'late', output: 'late', metadata: {} },
    )
    expect(ledger(adapter).listReceipts()).toHaveLength(0)
  })

  test('mutated, missing, and duplicate after events fail closed without double minting', async () => {
    const mutated = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      ]),
    )
    await observeSkill(mutated, 'systematic_skill', 'ce:work')
    await mutated.hooks['tool.execute.before'](
      { tool: 'write', sessionID: SESSION_A, callID: 'mutated' },
      { args: { filePath: 'a.ts', content: 'a' } },
    )
    await mutated.hooks['tool.execute.after'](
      {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'mutated',
        args: { filePath: 'b.ts', content: 'a' },
      },
      { title: 'write', output: 'changed', metadata: {} },
    )
    expect(ledger(mutated).listReceipts()).toHaveLength(0)
    expect(status(mutated).state).toBe('unavailable')

    const missing = createAdapter(
      'observe',
      false,
      sequenceObserver([operationSnapshot()]),
    )
    await observeSkill(missing, 'systematic_skill', 'ce:work')
    await missing.hooks['tool.execute.after'](
      {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'missing-baseline',
        args: { filePath: 'a.ts', content: 'a' },
      },
      { title: 'write', output: 'changed', metadata: {} },
    )
    expect(ledger(missing).listReceipts()).toHaveLength(0)
    expect(status(missing).state).toBe('unavailable')

    const foreign = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        {
          ...operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
          targetDigest: 'e'.repeat(64),
        },
      ]),
    )
    await observeSkill(foreign, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      foreign,
      'write',
      { filePath: 'a.ts', content: 'a' },
      { title: 'write', output: 'changed', metadata: {} },
      'foreign-target',
    )
    expect(ledger(foreign).listReceipts()).toHaveLength(0)
    expect(status(foreign).state).toBe('unavailable')

    const duplicate = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      ]),
    )
    await observeSkill(duplicate, 'systematic_skill', 'ce:work')
    const output = { title: 'write', output: 'changed', metadata: {} }
    await observeOperationTool(
      duplicate,
      'write',
      { filePath: 'a.ts', content: 'a' },
      output,
      'duplicate',
    )
    await duplicate.hooks['tool.execute.after'](
      {
        tool: 'write',
        sessionID: SESSION_A,
        callID: 'duplicate',
        args: { filePath: 'a.ts', content: 'a' },
      },
      output,
    )
    expect(ledger(duplicate).listReceipts()).toHaveLength(1)
  })

  test('fresh completion readback completes once and interleaving changes reject without consumption', async () => {
    const observer = sequenceObserver([
      operationSnapshot(),
      operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
    ])
    const adapter = createAdapter('observe', false, observer)
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      adapter,
      'write',
      { filePath: 'a.ts', content: 'a' },
      { title: 'write', output: 'changed', metadata: {} },
      'completion-implementation',
    )
    await observeOperationTool(
      adapter,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { title: 'tests', output: 'pass', metadata: { exit: 0 } },
      'completion-verification',
    )
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'completion',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    const output = { title: 'complete', output: 'done', metadata: {} }
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      output,
    )
    expect(status(adapter).unit?.status).toBe('completed')
    expect(
      ledger(adapter)
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(true)

    const interleaved = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'f'.repeat(64)),
      ]),
    )
    await observeSkill(interleaved, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      interleaved,
      'write',
      { filePath: 'a.ts', content: 'a' },
      { title: 'write', output: 'changed', metadata: {} },
      'interleaved-implementation',
    )
    await observeOperationTool(
      interleaved,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { title: 'tests', output: 'pass', metadata: { exit: 0 } },
      'interleaved-verification',
    )
    const interleavedInput = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'interleaved-completion',
    }
    await interleaved.hooks['tool.execute.before'](interleavedInput, {
      args: { target: 'unit' },
    })
    const interleavedOutput = {
      title: 'complete',
      output: 'done',
      metadata: {},
    }
    await interleaved.hooks['tool.execute.after'](
      { ...interleavedInput, args: { target: 'unit' } },
      interleavedOutput,
    )
    expect(status(interleaved).unit?.status).toBe('active')
    expect(
      ledger(interleaved)
        .listReceipts()
        .some((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(false)
  })

  test('an interleaved-digest completion readback writes an unavailable terminal result instead of stale ready metadata', async () => {
    const adapter = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'f'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'g'.repeat(64)),
      ]),
    )
    await observeSkill(adapter, 'systematic_skill', 'ce:work')
    await observeOperationTool(
      adapter,
      'write',
      { filePath: 'a.ts', content: 'a' },
      { title: 'write', output: 'changed', metadata: {} },
      'readback-unavailable-implementation',
    )
    await observeOperationTool(
      adapter,
      'bash',
      { command: 'bun test tests/unit/example.test.ts' },
      { title: 'tests', output: 'pass', metadata: { exit: 0 } },
      'readback-unavailable-verification',
    )
    const input = {
      tool: 'systematic_workflow_complete',
      sessionID: SESSION_A,
      callID: 'readback-unavailable-completion',
    }
    await adapter.hooks['tool.execute.before'](input, {
      args: { target: 'unit' },
    })
    const output = staleReadyOutput()
    await adapter.hooks['tool.execute.after'](
      { ...input, args: { target: 'unit' } },
      output,
    )
    expect(status(adapter).unit?.status).toBe('active')
    expect(output.metadata).not.toMatchObject({ reasonCode: 'unit-ready' })
    expect(output.metadata.workflowGuard).toMatchObject({
      status: 'unavailable',
      reasonCode: 'finalization-failed',
      target: 'unit',
    })
  })

  test('requalifies a pinned worktree target during completion readback', async () => {
    const setup = await createPinnedRecoveryAdapter()
    try {
      const { adapter } = setup
      expect(status(adapter).unit?.pinnedOperationTargetIdentity).toBe(
        setup.targetIdentity,
      )

      const completeInput = {
        tool: 'systematic_workflow_complete' as const,
        sessionID: SESSION_A,
        callID: 'pinned-completion',
      }
      await adapter.hooks['tool.execute.before'](completeInput, {
        args: { target: 'unit' },
      })
      const output = { title: 'complete', output: 'done', metadata: {} }
      await adapter.hooks['tool.execute.after'](
        { ...completeInput, args: { target: 'unit' } },
        output,
      )

      expect(status(adapter).unit?.status).toBe('completed')
      expect(output.output).toContain('workflow guard completed unit')
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('anchors fresh pinned completion readback to the worktree target', async () => {
    const setup = await createFreshPinnedAdapter()
    try {
      const { adapter, fixture } = setup

      const targetPath = path.join(fixture.linkedRoot, 'fresh-target.txt')
      await observeFreshWrite(
        adapter,
        targetPath,
        'fresh target',
        'fresh-pinned-completion-write',
      )
      await observeFreshVerification(
        adapter,
        fixture.linkedRoot,
        'fresh-pinned-completion-verification',
      )
      expect(ledger(adapter).listReceipts()).toHaveLength(2)

      const output = await completeUnit(adapter, 'fresh-pinned-completion')

      expect(status(adapter).unit?.status).toBe('completed')
      expect(output.output).toContain('workflow guard completed unit')
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('rejects completion when pinned worktree content changes after evidence', async () => {
    const setup = await createFreshPinnedAdapter()
    try {
      const targetPath = path.join(setup.targetRoot, 'content-drift.txt')
      await observeFreshWrite(
        setup.adapter,
        targetPath,
        'evidence content',
        'content-drift-write',
      )
      await observeFreshVerification(
        setup.adapter,
        setup.targetRoot,
        'content-drift-verification',
      )
      fs.appendFileSync(targetPath, '\npost-evidence drift')

      const contentOutput = await completeUnit(
        setup.adapter,
        'content-drift-completion',
      )

      expect(contentOutput.output).toContain('stale-receipt')
      expect(status(setup.adapter).state).toBe('unavailable')
      expect(status(setup.adapter).unit?.status).toBe('active')
      expect(
        ledger(setup.adapter)
          .listReceipts()
          .some((receipt) => receipt.canonical.consumption === 'consumed'),
      ).toBe(false)
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('stales only commit when pinned HEAD advances without content changes', async () => {
    const setup = await createFreshPinnedAdapter([
      'implementation',
      'verification',
      'commit',
    ])
    try {
      const targetPath = path.join(setup.targetRoot, 'tracked.txt')
      await observeFreshWrite(
        setup.adapter,
        targetPath,
        'committed content',
        'head-drift-write',
      )
      await observeFreshVerification(
        setup.adapter,
        setup.targetRoot,
        'head-drift-verification',
      )
      const commitInput = {
        tool: 'bash' as const,
        sessionID: SESSION_A,
        callID: 'head-drift-commit',
        args: {
          command: 'git commit -m "head drift baseline"',
          workdir: setup.targetRoot,
        },
      }
      await setup.adapter.hooks['tool.execute.before'](commitInput, {
        args: commitInput.args,
      })
      const stageResult = Bun.spawnSync(['git', 'add', 'tracked.txt'], {
        cwd: setup.targetRoot,
      })
      if (stageResult.exitCode !== 0) throw new Error('stage failed')
      const commitResult = Bun.spawnSync(
        ['git', 'commit', '-m', 'head drift baseline'],
        { cwd: setup.targetRoot },
      )
      if (commitResult.exitCode !== 0) throw new Error('commit failed')
      await setup.adapter.hooks['tool.execute.after'](commitInput, {
        title: 'commit complete',
        output: 'committed',
        metadata: { exit: 0 },
      })
      const emptyCommit = Bun.spawnSync(
        ['git', 'commit', '--allow-empty', '-m', 'outside completion'],
        { cwd: setup.targetRoot },
      )
      if (emptyCommit.exitCode !== 0) throw new Error('empty commit failed')

      const output = await completeUnit(setup.adapter, 'head-drift-completion')

      expect(output.output).toContain('stale-receipt')
      expect(status(setup.adapter).state).toBe('unavailable')
      expect(status(setup.adapter).satisfiedOperations).toEqual([
        'implementation',
        'verification',
      ])
      expect(status(setup.adapter).unit?.status).toBe('active')
      expect(
        ledger(setup.adapter)
          .listReceipts()
          .some((receipt) => receipt.canonical.consumption === 'consumed'),
      ).toBe(false)
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('fails closed when the pinned target changes during completion acquisition', async () => {
    const fixture = createTargetDerivationFixture()
    try {
      const realParentObserver = createOpencodeOperationObserver({
        targetDirectory: fixture.parentRoot,
      })
      const initial = await realParentObserver.snapshot()
      if (initial.status !== 'available') throw new Error('parent unavailable')
      const targetPath = path.join(fixture.linkedRoot, 'acquisition-drift.txt')
      let mutateDuringCompletion = false
      let parentSnapshots = 0
      const parentObserver: OpencodeOperationObserver = {
        ...realParentObserver,
        async snapshot() {
          const result = await realParentObserver.snapshot()
          parentSnapshots += 1
          if (mutateDuringCompletion && parentSnapshots === 2) {
            fs.writeFileSync(targetPath, 'changed during completion')
          }
          return result
        },
      }
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        sessionLocation: fixture.parentRoot,
        observer: parentObserver,
        classifier: createReceiptClassifier(),
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      await observeFreshWrite(
        adapter,
        targetPath,
        'stable evidence',
        'acquisition-drift-write',
      )
      await observeFreshVerification(
        adapter,
        fixture.linkedRoot,
        'acquisition-drift-verification',
      )
      parentSnapshots = 0
      mutateDuringCompletion = true

      await completeUnit(adapter, 'acquisition-drift-completion')

      expect(status(adapter).state).toBe('unavailable')
      expect(status(adapter).reasonCode).toBe('guard-unavailable')
      expect(
        ledger(adapter)
          .listReceipts()
          .some((receipt) => receipt.canonical.consumption === 'consumed'),
      ).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test('fails closed when the pinned registration identity changes before completion', async () => {
    const fixture = createTargetDerivationFixture()
    try {
      const realParentObserver = createOpencodeOperationObserver({
        targetDirectory: fixture.parentRoot,
      })
      const initial = await realParentObserver.snapshot()
      if (initial.status !== 'available') throw new Error('parent unavailable')
      const targetRoot = fs.realpathSync(fixture.linkedRoot)
      let substituteRegistration = false
      const parentObserver: OpencodeOperationObserver = {
        ...realParentObserver,
        validateRegisteredWorktree(candidateDirectory) {
          const validation =
            realParentObserver.validateRegisteredWorktree(candidateDirectory)
          if (
            substituteRegistration &&
            candidateDirectory === targetRoot &&
            validation.status === 'ok'
          ) {
            return { ...validation, gitDir: `${validation.gitDir}-substituted` }
          }
          return validation
        },
      }
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        sessionLocation: fixture.parentRoot,
        observer: parentObserver,
        classifier: createReceiptClassifier(),
      })
      await observeSkill(adapter, 'systematic_skill', 'ce:work')
      const targetPath = path.join(targetRoot, 'registration-drift.txt')
      await observeFreshWrite(
        adapter,
        targetPath,
        'registered evidence',
        'registration-drift-write',
      )
      await observeFreshVerification(
        adapter,
        targetRoot,
        'registration-drift-verification',
      )
      substituteRegistration = true

      await completeUnit(adapter, 'registration-drift-completion')

      expect(status(adapter).state).toBe('unavailable')
      expect(status(adapter).reasonCode).toBe('guard-unavailable')
      expect(
        ledger(adapter)
          .listReceipts()
          .some((receipt) => receipt.canonical.consumption === 'consumed'),
      ).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test('fails closed when a pinned worktree target no longer validates on completion', async () => {
    const setup = await createPinnedRecoveryAdapter()
    try {
      const { adapter } = setup
      setup.setTargetValidationAvailable(false)

      const completeInput = {
        tool: 'systematic_workflow_complete' as const,
        sessionID: SESSION_A,
        callID: 'invalid-pinned-completion',
      }
      await adapter.hooks['tool.execute.before'](completeInput, {
        args: { target: 'unit' },
      })
      const output = { title: 'complete', output: 'done', metadata: {} }
      await adapter.hooks['tool.execute.after'](
        { ...completeInput, args: { target: 'unit' } },
        output,
      )

      expect(status(adapter).state).toBe('unavailable')
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('a pinned worktree target whose validation times out rejects completion as retryable', async () => {
    const setup = await createPinnedRecoveryAdapter()
    try {
      const { adapter } = setup
      setup.setTargetValidationAvailable(false, 'command-timeout')

      const completeInput = {
        tool: 'systematic_workflow_complete' as const,
        sessionID: SESSION_A,
        callID: 'timeout-pinned-completion',
      }
      await adapter.hooks['tool.execute.before'](completeInput, {
        args: { target: 'unit' },
      })
      const output = { title: 'complete', output: 'done', metadata: {} }
      await adapter.hooks['tool.execute.after'](
        { ...completeInput, args: { target: 'unit' } },
        output,
      )

      expect(output.title).toBe('Workflow readback timed out')
      expect(JSON.parse(output.output)).toEqual({
        status: 'rejected',
        reasonCode: 'readback-timeout',
      })
      expect(status(adapter).state).not.toBe('unavailable')
      expect(status(adapter).unit?.status).toBe('active')
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('a pinned worktree validation target-unavailable during status refresh goes unavailable and records it', async () => {
    const setup = await createPinnedRecoveryAdapter()
    try {
      const { adapter } = setup
      setup.setTargetValidationAvailable(false, 'target-unavailable')
      const result = await getTool(
        adapter,
        'systematic_workflow_status',
      ).execute({}, toolContext(SESSION_A))
      const parsed = JSON.parse(expectToolOutput(result).output)
      expect(parsed.state).toBe('unavailable')
      expect(parsed.firstUnavailableCause).toEqual({
        site: 'refresh-readback',
        kind: 'observer-readback-failed',
        reasonCode: 'target-unavailable',
        timedOut: false,
      })
      expect(parsed.unconfirmedReadbacks).toBeUndefined()
    } finally {
      setup.fixture.cleanup()
    }
  })

  test('operation evidence remains isolated across sessions and registrations', async () => {
    const first = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      ]),
    )
    const second = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      ]),
    )
    await observeSkill(
      first,
      'systematic_skill',
      'ce:work',
      'first-skill',
      SESSION_A,
    )
    await observeSkill(
      second,
      'systematic_skill',
      'ce:work',
      'second-skill',
      SESSION_B,
    )
    await observeOperationTool(
      first,
      'write',
      { filePath: 'a.ts', content: 'a' },
      { title: 'write', output: 'changed', metadata: {} },
      'isolated-first',
      SESSION_A,
    )
    expect(ledger(first, SESSION_A).listReceipts()).toHaveLength(1)
    expect(ledger(second, SESSION_B).listReceipts()).toHaveLength(0)
    expect(status(second, SESSION_B).epoch).not.toBeNull()
    expect(first.ledger(SESSION_B)).toBeUndefined()
  })

  test('recovers persisted receipt markers once and restores the workflow state', async () => {
    const source = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(),
        operationSnapshot(undefined, 'd'.repeat(64)),
      ]),
      [],
      [],
      undefined,
      true,
    )
    const skillOutput: RecordedToolOutput = {
      title: 'skill',
      output: 'loaded',
      metadata: {},
    }
    await observeSkill(
      source,
      'systematic_skill',
      'ce:work',
      'skill-recovery',
      SESSION_A,
      skillOutput,
    )
    const output: RecordedToolOutput = {
      title: 'write',
      output: 'changed',
      metadata: {},
    }
    await observeOperationTool(
      source,
      'write',
      { filePath: 'recovered.ts', content: 'x' },
      output,
      'recovery-source',
    )
    const marker = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    expect(marker).toBeDefined()

    const parts = [
      { info: {}, parts: [{ state: { metadata: skillOutput.metadata } }] },
      {
        info: {},
        parts: [
          {
            state: {
              metadata: { [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: marker },
            },
          },
        ],
      },
    ]
    const restored = createAdapter(
      'observe',
      false,
      sequenceObserver([
        operationSnapshot(undefined, 'd'.repeat(64)),
        operationSnapshot(undefined, 'd'.repeat(64)),
      ]),
      [],
      [],
      {
        readSessionParts: async () => parts,
        listChildren: async () => [],
      },
      true,
    )
    await getTool(restored, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    expect(status(restored).epoch).not.toBeNull()
    expect(status(restored).unit).not.toBeNull()
    expect(status(restored).satisfiedOperations).toContain('implementation')
    await getTool(restored, 'systematic_workflow_status').execute(
      {},
      toolContext(),
    )
    expect(status(restored).epoch).not.toBeNull()
  })

  describe('dual-registration restart recovery (fix/workflow-guard-dual-registration-recovery)', () => {
    // Helper: build a minimal marker array for a registration with a known sessionSalt
    function buildMarkersForRegistration(
      registrationIdentity: string,
      sessionSalt: Uint8Array,
    ): unknown[] {
      const ledgerA = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity,
        sessionSalt,
      })
      const EPOCH_ID_A = 'a'.repeat(32)
      const UNIT_ID_A = 'b'.repeat(32)
      const transitionDigest = (tag: string) =>
        ledgerA.digestIdentity('call', tag)

      const epochStart = projectReceiptProgressionMarker(ledgerA, {
        target: 'epoch',
        state: 'started',
        epochId: EPOCH_ID_A,
        family: 'work',
        transitionDigest: transitionDigest('epoch-start'),
        timestamp: 1,
      })
      const unitStart = projectReceiptProgressionMarker(ledgerA, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID_A,
        unitId: UNIT_ID_A,
        family: 'work',
        requiredOperations: ['implementation'],
        resourceScopes: [],
        transitionDigest: transitionDigest('unit-start'),
        timestamp: 2,
      })

      // Create a receipt
      ledgerA.prepareObservation({
        callId: 'impl-call',
        operation: 'implementation',
        context: {
          epochId: EPOCH_ID_A,
          unitId: UNIT_ID_A,
          workspaceIdentity: 'workspace-a',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'worktree-before',
        },
      })
      const finalized = ledgerA.finalizeObservation({
        callId: 'impl-call',
        context: {
          epochId: EPOCH_ID_A,
          unitId: UNIT_ID_A,
          workspaceIdentity: 'workspace-a',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'worktree-before',
        },
        after: {
          workspaceIdentity: 'workspace-a',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'worktree-after',
        },
        classification: {
          outcome: 'accepted',
          category: 'implementation',
          attribution: 'runtime-verified',
          result: 'success',
          sideEffect: 'required',
          reasonCode: 'recognized-command',
        },
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      })
      if (finalized.status !== 'finalized') throw new Error('finalize failed')
      const mint = projectReceiptMintMarker(finalized.receipt, sessionSalt)
      if (!mint || !epochStart || !unitStart)
        throw new Error('marker projection failed')
      return [epochStart, unitStart, mint]
    }

    test('RED: recovery with mixed-registration markers previously returned unavailable (bug reproduction)', async () => {
      // Registration A: our "known" registration (matching what the guard uses)
      const ownIdentity = 'own-registration-identity'
      const ownSalt = new Uint8Array(32).fill(42)

      // Registration B: a foreign/second registration in the same session
      const foreignIdentity = 'foreign-registration-identity'
      const foreignSalt = new Uint8Array(32).fill(99)

      // Build markers from both registrations — this is what the shared metadata array contains
      const ownMarkers = buildMarkersForRegistration(ownIdentity, ownSalt)
      const foreignMarkers = buildMarkersForRegistration(
        foreignIdentity,
        foreignSalt,
      )

      // Combined marker array (shared metadata.systematic_workflow_receipt from both registrations)
      const combinedMarkers = [...ownMarkers, ...foreignMarkers]

      // Build a parts array that simulates what OpenCode persists
      const parts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: combinedMarkers,
                },
              },
            },
          ],
        },
      ]

      const restored = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace-a',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => parts,
          listChildren: async () => [],
        },
      })

      await getTool(restored, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      // BEFORE FIX: guard would be 'unavailable' due to conflicting-seed
      // AFTER FIX: guard should have recovered its own markers (epoch/unit not null)
      const s = restored.status(SESSION_A)
      expect(s.state).not.toBe('unavailable')
      expect(s.epoch).not.toBeNull()
    })

    test('foreign-only marker array → fresh start, not unavailable', async () => {
      const ownIdentity = 'my-registration'
      const ownSalt = new Uint8Array(32).fill(11)

      const foreignIdentity = 'foreign-only-registration'
      const foreignSalt = new Uint8Array(32).fill(88)

      const foreignMarkers = buildMarkersForRegistration(
        foreignIdentity,
        foreignSalt,
      )

      const parts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: foreignMarkers,
                },
              },
            },
          ],
        },
      ]

      const restored = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace-a',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => parts,
          listChildren: async () => [],
        },
      })

      // Trigger initialize (simulated by observing a skill to force status evaluation)
      const skillOutput = { title: 'loaded', output: 'ok', metadata: {} }
      await restored.hooks['tool.execute.before'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'skill-foreign-only',
        },
        { args: { name: 'ce:work' } },
      )
      await restored.hooks['tool.execute.after'](
        {
          tool: 'systematic_skill',
          sessionID: SESSION_A,
          callID: 'skill-foreign-only',
          args: { name: 'ce:work' },
        },
        skillOutput,
      )

      // Should have recovered fresh (not unavailable), so skill can activate epoch
      const s = restored.status(SESSION_A)
      // After fresh start + skill, epoch should be active
      expect(s.state).not.toBe('unavailable')
    })

    test('single-registration array is unchanged by filter (regression guard)', async () => {
      // The existing 'recovers persisted receipt markers once and restores the workflow state'
      // test covers this, but we add an explicit filter regression test here.
      const ownIdentity = 'single-reg-identity'
      const ownSalt = new Uint8Array(32).fill(33)
      const ownMarkers = buildMarkersForRegistration(ownIdentity, ownSalt)

      const parts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: ownMarkers,
                },
              },
            },
          ],
        },
      ]

      const restored = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace-a',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => parts,
          listChildren: async () => [],
        },
      })

      await getTool(restored, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      const s = restored.status(SESSION_A)
      // Single-registration: should recover successfully (not unavailable)
      expect(s.state).not.toBe('unavailable')
      expect(s.epoch).not.toBeNull()
    })

    test('genuinely corrupt marker for own registration still fails closed', async () => {
      const ownIdentity = 'corrupt-test-registration'
      const ownSalt = new Uint8Array(32).fill(77)
      const ownMarkers = buildMarkersForRegistration(ownIdentity, ownSalt)

      // Corrupt first marker (integrity mismatch)
      const corruptedMarker = {
        ...(ownMarkers[0] as Record<string, unknown>),
        integrity: 'a'.repeat(64),
      }

      const parts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: [
                    corruptedMarker,
                    ...ownMarkers.slice(1),
                  ],
                },
              },
            },
          ],
        },
      ]

      const restored = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace-a',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => parts,
          listChildren: async () => [],
        },
      })

      await getTool(restored, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      const s = restored.status(SESSION_A)
      // Genuine corruption → still fails closed → unavailable
      expect(s.state).toBe('unavailable')
    })

    test('empty array after filter → fresh start, not guard-unavailable', async () => {
      // This is effectively the foreign-only case: after filtering there are no own markers.
      // The guard should treat this as a fresh start (allowFresh path in initializeSession),
      // NOT as guard-unavailable. A fresh guard without an active epoch has state
      // 'inactive' with reasonCode 'no-active-epoch' — distinct from 'guard-unavailable'.
      const ownIdentity = 'empty-after-filter-reg'
      const ownSalt = new Uint8Array(32).fill(55)
      const foreignIdentity = 'unrelated-foreign-reg'
      const foreignSalt = new Uint8Array(32).fill(66)

      const foreignMarkers = buildMarkersForRegistration(
        foreignIdentity,
        foreignSalt,
      )

      const parts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: foreignMarkers,
                },
              },
            },
          ],
        },
      ]

      const restored = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace-a',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => parts,
          listChildren: async () => [],
        },
      })

      await getTool(restored, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      // A fresh guard (no epoch activated yet) has state 'inactive' / 'no-active-epoch'.
      // The key invariant: it must NOT be 'guard-unavailable' (which publishUnavailable sets).
      const s = restored.status(SESSION_A)
      expect(s.reasonCode).not.toBe('guard-unavailable')
      expect(s.state).toBe('inactive')
      expect(s.reasonCode).toBe('no-active-epoch')
    })

    // ── Ambiguity fail-closed tests (Oracle-identified defect) ──────────────────
    //
    // These are RED before the fix: ambiguous markers currently collapse to the
    // foreign-empty path (publishFresh → no-active-epoch) instead of failing closed
    // (publishUnavailable → guard-unavailable).
    //
    // Distinguisher: publishUnavailable produces 'guard-unavailable';
    //                publishFresh produces 'no-active-epoch'. Both have epoch=null.

    // Helper: wrap markers in the parts structure used by readSessionParts
    function wrapMarkers(markers: unknown[]): readonly unknown[] {
      return [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: markers,
                },
              },
            },
          ],
        },
      ]
    }

    // Helper: build an own guard-capable ledger for the ambiguity tests
    function buildOwnLedger(
      registrationIdentity: string,
      sessionSalt: Uint8Array,
    ) {
      return createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity,
        sessionSalt,
      })
    }

    test('RED main: all own seed-bearing markers corrupted → fail-closed guard-unavailable, not fresh', async () => {
      // Scenario: all own mint/progression markers have corrupted integrity.
      // resolveOwnRegistrationDigest can't find a valid own seed (validation fails
      // for every candidate). The corrupted marker is ambiguous (could be ours) →
      // must publishUnavailable(), NOT publishFresh().
      const ownIdentity = 'ambig-all-corrupted'
      const ownSalt = new Uint8Array(32).fill(11)
      const ledger = buildOwnLedger(ownIdentity, ownSalt)
      const EPOCH_ID = 'a'.repeat(32)

      const validMarker = projectReceiptProgressionMarker(ledger, {
        target: 'epoch',
        state: 'started',
        epochId: EPOCH_ID,
        family: 'work',
        transitionDigest: ledger.digestIdentity('call', 'ep'),
        timestamp: 1,
      })
      if (!validMarker) throw new Error('marker projection failed')
      // Corrupt the integrity so validateReceiptMarker → integrity-mismatch → rejected
      const corruptedMarker = { ...validMarker, integrity: 'f'.repeat(64) }

      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => wrapMarkers([corruptedMarker]),
          listChildren: async () => [],
        },
      })

      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      const s = adapter.status(SESSION_A)
      // BEFORE FIX: 'no-active-epoch' (wrong — publishFresh was called).
      // AFTER FIX:  'guard-unavailable' (correct — publishUnavailable was called).
      expect(s.reasonCode).toBe('guard-unavailable')
      expect(s.epoch).toBeNull() // fresh guard, no epoch started
    })

    test('RED main: consume-only markers (no salt/seed) → fail-closed guard-unavailable, not fresh', async () => {
      // Scenario: parts contain only a valid consume marker carrying the own
      // registrationDigest but no sessionSalt. candidateSeedFromMarker returns
      // undefined for consume markers (no sessionSalt field on consume). We cannot
      // verify ownership without a salt → ambiguous → must fail closed.
      const ownIdentity = 'ambig-consume-only'
      const ownSalt = new Uint8Array(32).fill(22)
      const ownLedger = buildOwnLedger(ownIdentity, ownSalt)
      const EPOCH_ID = 'a'.repeat(32)
      const UNIT_ID = 'b'.repeat(32)

      // Build an own receipt via prepare+finalize, then project ONLY the consume marker
      ownLedger.prepareObservation({
        callId: 'impl',
        operation: 'implementation',
        context: {
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          workspaceIdentity: 'ws',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'before',
        },
      })
      const finalized = ownLedger.finalizeObservation({
        callId: 'impl',
        context: {
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          workspaceIdentity: 'ws',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'before',
        },
        after: {
          workspaceIdentity: 'ws',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'after',
        },
        classification: {
          outcome: 'accepted',
          category: 'implementation',
          attribution: 'runtime-verified',
          result: 'success',
          sideEffect: 'required',
          reasonCode: 'recognized-command',
        },
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      })
      if (finalized.status !== 'finalized') throw new Error('finalize failed')

      const consumeMarker = projectReceiptConsumptionMarker(
        finalized.receipt,
        ownLedger.digestIdentity('call', 'transition'),
        Date.now(),
      )
      if (!consumeMarker) throw new Error('consume marker projection failed')

      // Parts contain ONLY the consume marker: no mint/progression seed markers
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => wrapMarkers([consumeMarker]),
          listChildren: async () => [],
        },
      })

      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      const s = adapter.status(SESSION_A)
      // BEFORE FIX: 'no-active-epoch' (wrong — consume is seedless, treated as empty).
      // AFTER FIX:  'guard-unavailable' (correct — consume is ambiguous → fail closed).
      expect(s.reasonCode).toBe('guard-unavailable')
      expect(s.epoch).toBeNull()
    })

    test('RED main: valid foreign markers + malformed marker → fail-closed, not fresh', async () => {
      // Scenario: valid provably-foreign seed-bearing markers PLUS one malformed
      // marker (own markers removed, unknown corruption). The malformed marker is
      // ambiguous (could be a corrupted own marker) → must fail closed.
      const ownIdentity = 'ambig-foreign-plus-malformed'
      const ownSalt = new Uint8Array(32).fill(33)
      const foreignIdentity = 'provably-foreign-reg'
      const foreignSalt = new Uint8Array(32).fill(44)

      // Valid provably-foreign markers (buildMarkersForRegistration uses the SAME helper
      // defined in the dual-registration restart recovery describe block above)
      const foreignMarkers = buildMarkersForRegistration(
        foreignIdentity,
        foreignSalt,
      )
      // Malformed: not a valid marker shape → validateReceiptMarker → unknown-kind
      const malformedMarker = { kind: 'corrupt-unknown', data: 'x' }

      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () =>
            wrapMarkers([...foreignMarkers, malformedMarker]),
          listChildren: async () => [],
        },
      })

      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      const s = adapter.status(SESSION_A)
      // BEFORE FIX: 'no-active-epoch' (wrong — malformed marker silently ignored).
      // AFTER FIX:  'guard-unavailable' (correct — malformed is ambiguous → fail closed).
      expect(s.reasonCode).toBe('guard-unavailable')
      expect(s.epoch).toBeNull()
    })

    test('regression guard main: all provably-foreign valid markers → fresh start, NOT fail-closed', async () => {
      // This must pass BOTH before and after the fix. Genuinely foreign-only markers
      // (valid, salt-bearing, none agree with own identity) → foreign-empty → publishFresh.
      // Verifies the true-foreign case is never regressed to fail-closed.
      const ownIdentity = 'provably-foreign-only'
      const ownSalt = new Uint8Array(32).fill(55)
      const foreignIdentity = 'all-foreign-reg'
      const foreignSalt = new Uint8Array(32).fill(66)

      const foreignMarkers = buildMarkersForRegistration(
        foreignIdentity,
        foreignSalt,
      )

      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'protected', debug: false },
        workspaceIdentity: 'workspace',
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        hostReadback: {
          readSessionParts: async () => wrapMarkers(foreignMarkers),
          listChildren: async () => [],
        },
      })

      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        toolContext(SESSION_A),
      )

      const s = adapter.status(SESSION_A)
      // Foreign-only → publishFresh → no-active-epoch (NOT guard-unavailable).
      expect(s.state).toBe('inactive')
      expect(s.reasonCode).toBe('no-active-epoch')
      expect(s.epoch).toBeNull()
    })

    describe('initialization and observer-readback unavailable causes', () => {
      const OWN_IDENTITY = 'cause-own-registration'
      const OWN_SALT = new Uint8Array(32).fill(71)
      const GUARD_HISTORY_PARTS: readonly unknown[] = [
        {
          info: {},
          parts: [
            {
              type: 'tool',
              tool: 'systematic_workflow_control',
              state: { status: 'completed', metadata: {} },
            },
          ],
        },
      ]

      function adapterWithHistory(
        readSessionParts: () => Promise<readonly unknown[]>,
        workspaceIdentity = 'workspace',
      ): OpencodeWorkflowGuard {
        return createOpencodeWorkflowGuard({
          config: { mode: 'protected', debug: false },
          workspaceIdentity,
          registrationIdentity: OWN_IDENTITY,
          sessionSalt: OWN_SALT,
          hostReadback: { readSessionParts, listChildren: async () => [] },
        })
      }

      async function statusJson(
        adapter: OpencodeWorkflowGuard,
      ): Promise<Record<string, unknown>> {
        const result = await getTool(
          adapter,
          'systematic_workflow_status',
        ).execute({}, toolContext(SESSION_A))
        return JSON.parse(expectToolOutput(result).output)
      }

      async function expectCause(
        adapter: OpencodeWorkflowGuard,
        site: string,
        kind: string,
        reasonCode?: string,
      ): Promise<void> {
        const parsed = await statusJson(adapter)
        expect(parsed.state).toBe('unavailable')
        expect(parsed.firstUnavailableCause).toEqual({
          site,
          kind,
          ...(reasonCode === undefined ? {} : { reasonCode }),
          timedOut: false,
        })
      }

      test('history read failure records history-read-failed', async () => {
        const adapter = adapterWithHistory(async () => {
          throw new Error('read failed')
        })
        await expectCause(adapter, 'initialize-session', 'history-read-failed')
      })

      test('markerless guard history records markerless-guard-history and keeps it across unavailable retries', async () => {
        const adapter = adapterWithHistory(async () => GUARD_HISTORY_PARTS)
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )
        await adapter.hooks.event({
          event: {
            type: 'message.updated',
            properties: { sessionID: SESSION_A },
          },
        })
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )
      })

      test('ambiguous markers record markers-ambiguous', async () => {
        const adapter = adapterWithHistory(async () =>
          wrapMarkers([{ kind: 'corrupt-unknown', data: 'x' }]),
        )
        await expectCause(adapter, 'initialize-session', 'markers-ambiguous')
      })

      test('a corrupted own marker records markers-malformed-or-incompatible', async () => {
        const ownMarkers = buildMarkersForRegistration(OWN_IDENTITY, OWN_SALT)
        const corrupted = {
          ...(ownMarkers[0] as Record<string, unknown>),
          integrity: 'a'.repeat(64),
        }
        const adapter = adapterWithHistory(async () =>
          wrapMarkers([corrupted, ...ownMarkers.slice(1)]),
        )
        await expectCause(
          adapter,
          'initialize-session',
          'markers-malformed-or-incompatible',
        )
      })

      test('own markers that fail to reconstruct record recovery-rejected', async () => {
        const ownMarkers = buildMarkersForRegistration(OWN_IDENTITY, OWN_SALT)
        // Unit start and receipt without the epoch start: valid markers that
        // cannot be folded into a coherent guard state.
        const adapter = adapterWithHistory(async () =>
          wrapMarkers(ownMarkers.slice(1)),
        )
        await expectCause(adapter, 'initialize-session', 'recovery-rejected')
      })

      test('an observer readback failure during an active epoch records observer-readback-failed', async () => {
        const base = sequenceObserver([operationSnapshot()])
        let failing = false
        const observer: OpencodeOperationObserver = {
          ...base,
          snapshot: async () =>
            failing
              ? { status: 'unavailable', reasonCode: 'target-unavailable' }
              : base.snapshot(),
        }
        const adapter = createAdapter('observe', false, observer)
        await observeSkill(adapter, 'systematic_skill', 'ce:work')
        expect(status(adapter).state).not.toBe('unavailable')
        failing = true
        await expectCause(
          adapter,
          'refresh-readback',
          'observer-readback-failed',
          'target-unavailable',
        )
      })

      test('markerless-guard-history is final: history that later looks empty neither retries nor clears the cause, and a cause-less transition keeps the first cause', async () => {
        // Previously this history was retryable, so a later fresh publication
        // cleared the cause. It is now final, so the first cause must persist.
        let historyPresent = true
        const adapter = adapterWithHistory(async () =>
          historyPresent ? GUARD_HISTORY_PARTS : [],
        )
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )

        historyPresent = false
        await adapter.hooks.event({
          event: {
            type: 'message.updated',
            properties: { sessionID: SESSION_A },
          },
        })
        await adapter.hooks['tool.execute.before'](
          { tool: 'read', sessionID: SESSION_A, callID: 'no-fresh-retry' },
          { args: {} },
        )
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )

        // A cause-less markUnavailable(): reusing a callID across call kinds.
        for (const tool of ['systematic_skill', 'systematic_workflow_start']) {
          await adapter.hooks['tool.execute.before'](
            { tool, sessionID: SESSION_A, callID: 'reused-call' },
            { args: tool === 'systematic_skill' ? { name: 'ce:work' } : {} },
          )
        }
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )
      })

      test('markerless-guard-history is final: markers that later become restorable are not re-read', async () => {
        // Previously retryable, so a later successful restoration cleared the
        // cause. It is now final.
        const ownMarkers = buildMarkersForRegistration(OWN_IDENTITY, OWN_SALT)
        let mode: 'history' | 'markers' = 'history'
        const adapter = adapterWithHistory(
          async () =>
            mode === 'history' ? GUARD_HISTORY_PARTS : wrapMarkers(ownMarkers),
          'workspace-a',
        )
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )
        mode = 'markers'
        await adapter.hooks.event({
          event: {
            type: 'message.updated',
            properties: { sessionID: SESSION_A },
          },
        })
        await adapter.hooks['tool.execute.before'](
          { tool: 'read', sessionID: SESSION_A, callID: 'no-restore-retry' },
          { args: {} },
        )
        await expectCause(
          adapter,
          'initialize-session',
          'markerless-guard-history',
        )
      })

      test('causes never enter markers, tool metadata, receipts, or digests', async () => {
        const markerSource = async (
          readSessionParts: () => Promise<readonly unknown[]>,
        ) => {
          const adapter = adapterWithHistory(readSessionParts)
          const skillOutput = {
            title: 'Loaded skill',
            output: 'ok',
            metadata: {},
          }
          await observeSkill(
            adapter,
            'systematic_skill',
            'ce:work',
            'cause-skill',
            SESSION_A,
            skillOutput,
          )
          const output = { system: ['base'] }
          await adapter.hooks['experimental.chat.system.transform'](
            { sessionID: SESSION_A },
            output,
          )
          const parsed = await statusJson(adapter)
          expect(parsed.firstUnavailableCause).toBeDefined()
          const serialized = [
            JSON.stringify(skillOutput),
            output.system.join('\n'),
            JSON.stringify(adapter.status(SESSION_A)),
            JSON.stringify(adapter.ledger(SESSION_A)?.listReceipts() ?? []),
          ].join('\n')
          for (const forbidden of [
            'firstUnavailableCause',
            'initialize-session',
            'history-read-failed',
            'markerless-guard-history',
            'observer-readback-failed',
          ]) {
            expect(serialized).not.toContain(forbidden)
          }
          return output.system.join('\n')
        }

        const withReadFailure = await markerSource(async () => {
          throw new Error('read failed')
        })
        const withMarkerlessHistory = await markerSource(
          async () => GUARD_HISTORY_PARTS,
        )
        // Same pinned registration + same state/reason: digests and markers are
        // identical regardless of which cause was recorded.
        expect(withReadFailure).toBe(withMarkerlessHistory)
      })

      describe('exempt guard-owned history', () => {
        function toolPart(
          tool: string,
          state: Record<string, unknown> | undefined,
          extra: Record<string, unknown> = {},
        ): readonly unknown[] {
          return [
            {
              info: {},
              parts: [
                {
                  type: 'tool',
                  tool,
                  callID: 'prior-call',
                  ...(state ? { state } : {}),
                  ...extra,
                },
              ],
            },
          ]
        }

        const NO_EPOCH_REJECTION = {
          workflowGuard: { status: 'rejected', reasonCode: 'no-active-epoch' },
        }

        async function expectInactive(
          parts: readonly unknown[],
        ): Promise<void> {
          const adapter = adapterWithHistory(async () => parts)
          const parsed = await statusJson(adapter)
          expect(parsed.state).toBe('inactive')
          expect(parsed.firstUnavailableCause).toBeUndefined()
        }

        async function expectMarkerless(
          parts: readonly unknown[],
        ): Promise<void> {
          await expectCause(
            adapterWithHistory(async () => parts),
            'initialize-session',
            'markerless-guard-history',
          )
        }

        test('a: an in-flight status part does not poison a fresh session; a guarded skill then activates', async () => {
          const adapter = adapterWithHistory(async () =>
            toolPart('systematic_workflow_status', { status: 'running' }),
          )
          expect((await statusJson(adapter)).state).toBe('inactive')
          expect((await statusJson(adapter)).state).toBe('inactive')
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          expect(status(adapter)).toMatchObject({
            state: 'waiting',
            reasonCode: 'missing-evidence',
          })
        })

        test('b: restart with only completed markerless status parts is inactive', async () => {
          await expectInactive(
            toolPart('systematic_workflow_status', {
              status: 'completed',
              metadata: {},
            }),
          )
        })

        test('c: restart with a completed start rejected / no-active-epoch is inactive', async () => {
          await expectInactive(
            toolPart('systematic_workflow_start', {
              status: 'completed',
              metadata: NO_EPOCH_REJECTION,
            }),
          )
        })

        for (const mode of ['protected', 'observe'] as const) {
          test(`d: restart after a real ${mode}-mode no-epoch completion is inactive`, async () => {
            const first = createAdapter(mode)
            const output = {
              title: 'pending',
              output: 'pending',
              metadata: {},
            }
            const input = {
              tool: 'systematic_workflow_complete',
              sessionID: SESSION_A,
              callID: `restart-no-epoch-${mode}`,
            }
            await first.hooks['tool.execute.before'](input, {
              args: { target: 'unit' },
            })
            await first.hooks['tool.execute.after'](
              { ...input, args: { target: 'unit' } },
              output,
            )
            expect(output.metadata).toMatchObject({
              workflowGuard: {
                status: 'rejected',
                reasonCode: 'no-active-epoch',
              },
            })
            await expectInactive(
              toolPart('systematic_workflow_complete', {
                status: 'completed',
                metadata: output.metadata,
              }),
            )
          })
        }

        test('e: restart histories that stay closed publish markerless-guard-history', async () => {
          const closed: ReadonlyArray<{
            name: string
            parts: readonly unknown[]
          }> = [
            {
              name: 'completed markerless control',
              parts: toolPart('systematic_workflow_control', {
                status: 'completed',
                metadata: {},
              }),
            },
            {
              name: 'completed start that started a unit',
              parts: toolPart('systematic_workflow_start', {
                status: 'completed',
                metadata: { workflowGuard: { status: 'started' } },
              }),
            },
            {
              name: 'completed start rejected with epoch-completed',
              parts: toolPart('systematic_workflow_start', {
                status: 'completed',
                metadata: {
                  workflowGuard: {
                    status: 'rejected',
                    reasonCode: 'epoch-completed',
                  },
                },
              }),
            },
            {
              name: 'completed complete without rejected / no-active-epoch metadata',
              parts: toolPart('systematic_workflow_complete', {
                status: 'completed',
                metadata: {},
              }),
            },
            {
              name: 'guard part missing state.status',
              parts: toolPart('systematic_workflow_start', undefined, {
                metadata: NO_EPOCH_REJECTION,
              }),
            },
            {
              name: 'guard part with state but no status',
              parts: toolPart('systematic_workflow_complete', {
                metadata: NO_EPOCH_REJECTION,
              }),
            },
            {
              name: 'running start from a prior process',
              parts: toolPart('systematic_workflow_start', {
                status: 'running',
              }),
            },
            {
              name: 'errored complete',
              parts: toolPart('systematic_workflow_complete', {
                status: 'error',
                metadata: NO_EPOCH_REJECTION,
              }),
            },
            {
              name: 'pending control',
              parts: toolPart('systematic_workflow_control', {
                status: 'pending',
              }),
            },
          ]
          for (const entry of closed) {
            const adapter = adapterWithHistory(async () => entry.parts)
            const parsed = await statusJson(adapter)
            expect(parsed.state, entry.name).toBe('unavailable')
            expect(parsed.firstUnavailableCause, entry.name).toEqual({
              site: 'initialize-session',
              kind: 'markerless-guard-history',
              timedOut: false,
            })
          }
        })

        test('f: malformed or ambiguous markers stay closed even when every guard part is exempt', async () => {
          const exempt = toolPart('systematic_workflow_status', {
            status: 'completed',
            metadata: {},
          })
          await expectCause(
            adapterWithHistory(async () => [
              ...wrapMarkers([{ kind: 'corrupt-unknown', data: 'x' }]),
              ...exempt,
            ]),
            'initialize-session',
            'markers-ambiguous',
          )

          const ownMarkers = buildMarkersForRegistration(OWN_IDENTITY, OWN_SALT)
          const corrupted = {
            ...(ownMarkers[0] as Record<string, unknown>),
            integrity: 'a'.repeat(64),
          }
          await expectCause(
            adapterWithHistory(async () => [
              ...wrapMarkers([corrupted, ...ownMarkers.slice(1)]),
              ...toolPart('systematic_workflow_start', {
                status: 'completed',
                metadata: NO_EPOCH_REJECTION,
              }),
            ]),
            'initialize-session',
            'markers-malformed-or-incompatible',
          )
        })

        test('g: markerless-guard-history unavailable is not retried by later hooks', async () => {
          let reads = 0
          const adapter = adapterWithHistory(async () => {
            reads += 1
            return GUARD_HISTORY_PARTS
          })
          await expectCause(
            adapter,
            'initialize-session',
            'markerless-guard-history',
          )
          expect(reads).toBe(1)
          await adapter.hooks.event({
            event: {
              type: 'message.updated',
              properties: { sessionID: SESSION_A },
            },
          })
          await adapter.hooks['tool.execute.before'](
            { tool: 'read', sessionID: SESSION_A, callID: 'no-retry' },
            { args: {} },
          )
          await adapter.hooks['experimental.chat.system.transform'](
            { sessionID: SESSION_A },
            { system: ['base'] },
          )
          await statusJson(adapter)
          expect(reads).toBe(1)
          expect(adapter.status(SESSION_A).state).toBe('unavailable')
        })

        test('h: valid foreign-only markers keep current behavior', async () => {
          const foreignMarkers = buildMarkersForRegistration(
            'cause-foreign-registration',
            new Uint8Array(32).fill(72),
          )
          await expectInactive(wrapMarkers(foreignMarkers))
          await expectMarkerless([
            ...wrapMarkers(foreignMarkers),
            ...GUARD_HISTORY_PARTS,
          ])
        })
      })

      describe('transform-first provisional inactive and re-initialization waiters', () => {
        type GuardMode = 'protected' | 'observe'

        function adapterFor(
          mode: GuardMode,
          readSessionParts: () => Promise<readonly unknown[]>,
          workspaceIdentity = 'workspace',
        ): OpencodeWorkflowGuard {
          return createOpencodeWorkflowGuard({
            config: { mode, debug: false },
            workspaceIdentity,
            registrationIdentity: OWN_IDENTITY,
            sessionSalt: OWN_SALT,
            hostReadback: { readSessionParts, listChildren: async () => [] },
          })
        }

        async function transformText(
          adapter: OpencodeWorkflowGuard,
        ): Promise<string> {
          const output = { system: ['base'] }
          await adapter.hooks['experimental.chat.system.transform'](
            { sessionID: SESSION_A },
            output,
          )
          return output.system.join('\n')
        }

        async function eventHook(
          adapter: OpencodeWorkflowGuard,
        ): Promise<void> {
          await adapter.hooks.event({
            event: {
              type: 'message.updated',
              properties: { sessionID: SESSION_A },
            },
          })
        }

        async function beforeHook(
          adapter: OpencodeWorkflowGuard,
          callID = 'ordering-read',
        ): Promise<void> {
          await adapter.hooks['tool.execute.before'](
            { tool: 'read', sessionID: SESSION_A, callID },
            { args: {} },
          )
        }

        for (const mode of ['protected', 'observe'] as const) {
          test(`a/f: every first-hook ordering on a fresh empty-history session ends inactive / no-active-epoch with identical marker text (${mode})`, async () => {
            const orderings: ReadonlyArray<{
              name: string
              run: (adapter: OpencodeWorkflowGuard) => Promise<void>
            }> = [
              { name: 'event-first', run: eventHook },
              {
                name: 'transform-first',
                run: async (adapter) => {
                  await transformText(adapter)
                  await beforeHook(adapter)
                },
              },
              { name: 'before-hook-first', run: (a) => beforeHook(a) },
              {
                name: 'direct-tool',
                run: async (adapter) => {
                  await statusJson(adapter)
                },
              },
            ]
            const finals: string[] = []
            for (const ordering of orderings) {
              const adapter = adapterFor(mode, async () => [])
              await ordering.run(adapter)
              expect(status(adapter), ordering.name).toMatchObject({
                state: 'inactive',
                reasonCode: 'no-active-epoch',
              })
              finals.push(await transformText(adapter))
            }
            expect(new Set(finals).size).toBe(1)
          })

          test(`a/f: the transform marker is identical across the provisional and confirmed passes (${mode})`, async () => {
            const adapter = adapterFor(mode, async () => [])
            const provisional = await transformText(adapter)
            expect(status(adapter)).toMatchObject({
              state: 'inactive',
              reasonCode: 'no-active-epoch',
            })
            await beforeHook(adapter)
            const confirmed = await transformText(adapter)
            expect(provisional).toContain('"state":"inactive"')
            expect(confirmed).toBe(provisional)
          })
        }

        test('b: a late own marker found by the confirming re-read is restored, not overwritten fresh', async () => {
          const ownMarkers = buildMarkersForRegistration(OWN_IDENTITY, OWN_SALT)
          let reads = 0
          const adapter = adapterFor(
            'protected',
            async () => {
              reads += 1
              return reads === 1 ? [] : wrapMarkers(ownMarkers)
            },
            'workspace-a',
          )
          await transformText(adapter)
          expect(status(adapter).epoch).toBeNull()
          await beforeHook(adapter)
          expect(reads).toBe(2)
          expect(status(adapter).epoch).not.toBeNull()
          expect(status(adapter).state).not.toBe('unavailable')
        })

        test('c: a confirming re-read that finds non-exempt guard history becomes final markerless-guard-history', async () => {
          let reads = 0
          const adapter = adapterFor('protected', async () => {
            reads += 1
            return reads === 1 ? [] : GUARD_HISTORY_PARTS
          })
          await transformText(adapter)
          await beforeHook(adapter)
          await expectCause(
            adapter,
            'initialize-session',
            'markerless-guard-history',
          )
          await eventHook(adapter)
          await beforeHook(adapter, 'ordering-read-2')
          expect(reads).toBe(2)
        })

        test('d: concurrent hooks never run against, or observe, a guard whose re-initialization is in flight', async () => {
          let reads = 0
          let releaseRead: (parts: readonly unknown[]) => void = () => {}
          const adapter = adapterFor('protected', () => {
            reads += 1
            if (reads === 1) return Promise.resolve([])
            return new Promise<readonly unknown[]>((resolve) => {
              releaseRead = resolve
            })
          })
          await transformText(adapter)
          expect(reads).toBe(1)

          // Invoked in the same tick, before any microtask runs: every hook
          // sees the settled provisional initialization promise.
          const settled = { event: false, before: false }
          const eventDone = eventHook(adapter).then(() => {
            settled.event = true
          })
          const beforeDone = beforeHook(adapter, 'race-read').then(() => {
            settled.before = true
          })
          const statusDone = statusJson(adapter)

          // Give every continuation a chance to run while the read is held.
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(reads).toBe(2)
          expect(settled).toEqual({ event: false, before: false })

          releaseRead([])
          await Promise.all([eventDone, beforeDone])
          const observed = await statusDone
          expect(observed.state).toBe('inactive')
          expect(status(adapter)).toMatchObject({
            state: 'inactive',
            reasonCode: 'no-active-epoch',
          })
          expect(reads).toBe(2)
        })

        test('e: a guarded skill and a bash hook racing the confirming re-read activate exactly one epoch', async () => {
          let reads = 0
          let releaseRead: (parts: readonly unknown[]) => void = () => {}
          const adapter = adapterFor('protected', () => {
            reads += 1
            if (reads === 1) return Promise.resolve([])
            return new Promise<readonly unknown[]>((resolve) => {
              releaseRead = resolve
            })
          })
          await transformText(adapter)

          const skillDone = observeSkill(adapter, 'systematic_skill', 'ce:work')
          const bashDone = adapter.hooks['tool.execute.before'](
            { tool: 'bash', sessionID: SESSION_A, callID: 'race-bash' },
            { args: { command: 'git status --short' } },
          )
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(status(adapter).epoch).toBeNull()

          releaseRead([])
          await Promise.all([skillDone, bashDone])
          expect(reads).toBe(2)
          const after = status(adapter)
          expect(after.epoch).not.toBeNull()
          expect(after).toMatchObject({
            state: 'waiting',
            reasonCode: 'missing-evidence',
          })
          const epochId = after.epoch?.epochId
          await eventHook(adapter)
          expect(status(adapter).epoch?.epochId).toBe(epochId)
        })
      })

      describe('current-turn exemption on first initialization', () => {
        type MutationTool =
          | 'systematic_workflow_start'
          | 'systematic_workflow_complete'
          | 'systematic_workflow_control'

        // The injected runtime clock: messages created at or after this
        // instant belong to this process's lifetime.
        const RUNTIME_START = 1_000
        const CALL = 'call_0'

        function adapterFor(
          mode: 'protected' | 'observe',
          readSessionParts: () => Promise<readonly unknown[]>,
        ): OpencodeWorkflowGuard {
          return createOpencodeWorkflowGuard({
            config: { mode, debug: false },
            workspaceIdentity: 'workspace',
            registrationIdentity: OWN_IDENTITY,
            sessionSalt: OWN_SALT,
            now: () => RUNTIME_START,
            hostReadback: {
              readSessionParts,
              listChildren: async () => [],
            },
          })
        }

        function hostPart(
          tool: string,
          callID: string,
          state: Record<string, unknown>,
        ): Record<string, unknown> {
          return { type: 'tool', tool, callID, state }
        }

        let messageSequence = 0
        function message(
          role: string,
          time: Record<string, unknown> | undefined,
          ...parts: Record<string, unknown>[]
        ): Record<string, unknown> {
          messageSequence += 1
          return {
            info: {
              id: `msg_${messageSequence}`,
              sessionID: SESSION_A,
              role,
              ...(time ? { time } : {}),
            },
            parts,
          }
        }

        function turn(
          ...parts: Record<string, unknown>[]
        ): Record<string, unknown> {
          return message('assistant', { created: 2_000 }, ...parts)
        }

        // First read (transform) is empty; every later read is `confirming`.
        function transformThen(
          confirming: readonly unknown[],
        ): () => Promise<readonly unknown[]> {
          let reads = 0
          return async () => {
            reads += 1
            return reads === 1 ? [] : confirming
          }
        }

        async function transformPass(
          adapter: OpencodeWorkflowGuard,
        ): Promise<void> {
          await adapter.hooks['experimental.chat.system.transform'](
            { sessionID: SESSION_A },
            { system: ['base'] },
          )
        }

        function beforeHook(
          adapter: OpencodeWorkflowGuard,
          tool: string,
          callID = CALL,
        ): Promise<void> {
          return adapter.hooks['tool.execute.before'](
            { tool, sessionID: SESSION_A, callID },
            {
              args:
                tool === 'systematic_workflow_complete'
                  ? { target: 'unit' }
                  : {},
            },
          )
        }

        async function expectClosed(
          adapter: OpencodeWorkflowGuard,
        ): Promise<void> {
          await expectCause(
            adapter,
            'initialize-session',
            'markerless-guard-history',
          )
        }

        const mutationTools: ReadonlyArray<{
          tool: MutationTool
          modes: ReadonlyArray<'protected' | 'observe'>
        }> = [
          { tool: 'systematic_workflow_start', modes: ['protected'] },
          {
            tool: 'systematic_workflow_complete',
            modes: ['protected', 'observe'],
          },
          { tool: 'systematic_workflow_control', modes: ['protected'] },
        ]

        async function expectNoEpochRejection(
          adapter: OpencodeWorkflowGuard,
          tool: MutationTool,
        ): Promise<void> {
          const output = { title: 'pending', output: 'pending', metadata: {} }
          await adapter.hooks['tool.execute.after'](
            {
              tool,
              sessionID: SESSION_A,
              callID: CALL,
              args:
                tool === 'systematic_workflow_complete'
                  ? { target: 'unit' }
                  : {},
            },
            output,
          )
          expect(output.metadata).toMatchObject({
            workflowGuard: {
              status: 'rejected',
              reasonCode: 'no-active-epoch',
            },
          })
        }

        async function runCurrentTurnCase(
          tool: MutationTool,
          mode: 'protected' | 'observe',
          transformFirst: boolean,
        ): Promise<void> {
          const history = [
            message('user', { created: 1_900 }),
            turn(hostPart(tool, CALL, { status: 'running' })),
          ]
          const adapter = adapterFor(
            mode,
            transformFirst ? transformThen(history) : async () => history,
          )
          if (transformFirst) await transformPass(adapter)
          await beforeHook(adapter, tool)
          expect(status(adapter).state).toBe('inactive')
          if (tool !== 'systematic_workflow_control') {
            await expectNoEpochRejection(adapter, tool)
          }
          expect(status(adapter)).toMatchObject({
            state: 'inactive',
            reasonCode: 'no-active-epoch',
          })
          expect((await statusJson(adapter)).state).toBe('inactive')
        }

        const currentTurnCases = mutationTools.flatMap(({ tool, modes }) =>
          modes.flatMap((mode) =>
            [true, false].map((transformFirst) => ({
              tool,
              mode,
              transformFirst,
            })),
          ),
        )
        test.each(currentTurnCases)(
          'a: the current-turn running $tool part does not poison initialization ($mode, transformFirst=$transformFirst)',
          (c) => runCurrentTurnCase(c.tool, c.mode, c.transformFirst),
        )

        test.each(['pending', 'running'])(
          'a: a %s current-turn part is accepted',
          async (exempt) => {
            const adapter = adapterFor('protected', async () => [
              turn(
                hostPart('systematic_workflow_start', CALL, { status: exempt }),
              ),
            ])
            await beforeHook(adapter, 'systematic_workflow_start')
            expect((await statusJson(adapter)).state).toBe('inactive')
          },
        )

        test('b (P1-a): an old running start whose callID is reused by a new call is not exempt and no epoch is minted over it', async () => {
          const adapter = adapterFor('protected', async () => [
            message(
              'assistant',
              { created: 1_500 },
              hostPart('systematic_workflow_start', 'call_0', {
                status: 'running',
              }),
            ),
            message('user', { created: 1_800 }),
          ])
          await beforeHook(adapter, 'systematic_workflow_start', 'call_0')
          await expectClosed(adapter)
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          expect(status(adapter).epoch).toBeNull()
          expect(status(adapter).state).toBe('unavailable')
        })

        test('c: an unfinished assistant turn created before the runtime started is not the current turn', async () => {
          const adapter = adapterFor('protected', async () => [
            message(
              'assistant',
              { created: 500 },
              hostPart('systematic_workflow_start', CALL, {
                status: 'running',
              }),
            ),
          ])
          await beforeHook(adapter, 'systematic_workflow_start')
          await expectClosed(adapter)
        })

        async function raceStatusAndStart(statusFirst: boolean): Promise<void> {
          let reads = 0
          const history = [
            turn(
              hostPart('systematic_workflow_status', 'call_status', {
                status: 'running',
              }),
              hostPart('systematic_workflow_start', 'call_start', {
                status: 'running',
              }),
            ),
          ]
          const adapter = adapterFor('protected', async () => {
            reads += 1
            return reads === 1 ? [] : history
          })
          await transformPass(adapter)
          const statusCall = () =>
            beforeHook(adapter, 'systematic_workflow_status', 'call_status')
          const startCall = () =>
            beforeHook(adapter, 'systematic_workflow_start', 'call_start')
          await Promise.all(
            statusFirst
              ? [statusCall(), startCall()]
              : [startCall(), statusCall()],
          )
          expect(reads).toBe(2)
          expect(status(adapter)).toMatchObject({
            state: 'inactive',
            reasonCode: 'no-active-epoch',
          })
        }

        test.each([true, false])(
          'd (P1-b): status and start before-hooks racing the confirming read both end inactive (statusFirst=%s)',
          raceStatusAndStart,
        )

        test('e: a completed newest assistant message is not the current turn', async () => {
          const adapter = adapterFor('protected', async () => [
            message(
              'assistant',
              { created: 2_000, completed: 2_500 },
              hostPart('systematic_workflow_start', CALL, {
                status: 'running',
              }),
            ),
          ])
          await beforeHook(adapter, 'systematic_workflow_start')
          await expectClosed(adapter)
        })

        test('e: a newest user message is not the current turn', async () => {
          const adapter = adapterFor('protected', async () => [
            message(
              'user',
              { created: 2_000 },
              hostPart('systematic_workflow_start', CALL, {
                status: 'running',
              }),
            ),
          ])
          await beforeHook(adapter, 'systematic_workflow_start')
          await expectClosed(adapter)
        })

        const malformedInfo: ReadonlyArray<{
          name: string
          history: readonly unknown[]
        }> = [
          {
            name: 'missing info.time',
            history: [
              message(
                'assistant',
                undefined,
                hostPart('systematic_workflow_start', CALL, {
                  status: 'running',
                }),
              ),
            ],
          },
          {
            name: 'non-numeric info.time.created',
            history: [
              message(
                'assistant',
                { created: 'now' },
                hostPart('systematic_workflow_start', CALL, {
                  status: 'running',
                }),
              ),
            ],
          },
          {
            name: 'missing info',
            history: [
              {
                parts: [
                  hostPart('systematic_workflow_start', CALL, {
                    status: 'running',
                  }),
                ],
              },
            ],
          },
          {
            name: 'two messages sharing the newest created time',
            history: [
              message('user', { created: 2_000 }),
              turn(
                hostPart('systematic_workflow_start', CALL, {
                  status: 'running',
                }),
              ),
            ],
          },
        ]
        test.each([...malformedInfo])(
          'e: $name is not the current turn',
          async (entry) => {
            const adapter = adapterFor('protected', async () => entry.history)
            await beforeHook(adapter, 'systematic_workflow_start')
            await expectClosed(adapter)
          },
        )

        test.each(['completed', 'error'])(
          'e: a %s current-turn part is never exempt through this rule',
          async (closedState) => {
            const adapter = adapterFor('protected', async () => [
              turn(
                hostPart('systematic_workflow_start', CALL, {
                  status: closedState,
                  metadata: {},
                }),
              ),
            ])
            await beforeHook(adapter, 'systematic_workflow_start')
            await expectClosed(adapter)
          },
        )

        test('e: a non-current-turn running part next to a current-turn one keeps history closed', async () => {
          const adapter = adapterFor('protected', async () => [
            message(
              'assistant',
              { created: 1_500, completed: 1_600 },
              hostPart('systematic_workflow_start', 'call_prior', {
                status: 'running',
              }),
            ),
            turn(
              hostPart('systematic_workflow_start', CALL, {
                status: 'running',
              }),
            ),
          ])
          await beforeHook(adapter, 'systematic_workflow_start')
          await expectClosed(adapter)
        })

        test('f: an ambiguous marker plus a current-turn running part is still markers-ambiguous', async () => {
          const adapter = adapterFor('protected', async () => [
            ...wrapMarkers([{ kind: 'corrupt-unknown', data: 'x' }]),
            turn(
              hostPart('systematic_workflow_start', CALL, {
                status: 'running',
              }),
            ),
          ])
          await beforeHook(adapter, 'systematic_workflow_start')
          await expectCause(adapter, 'initialize-session', 'markers-ambiguous')
        })
      })

      describe('strict own-history read versus lenient child-rollup read', () => {
        function adapterWithReaders(readers: {
          lenient: (sessionID: string) => Promise<readonly unknown[]>
          strict?: (sessionID: string) => Promise<readonly unknown[]>
        }): OpencodeWorkflowGuard {
          return createOpencodeWorkflowGuard({
            config: { mode: 'observe', debug: false },
            workspaceIdentity: 'workspace',
            registrationIdentity: OWN_IDENTITY,
            sessionSalt: OWN_SALT,
            hostReadback: {
              readSessionParts: readers.lenient,
              ...(readers.strict
                ? { readSessionPartsStrict: readers.strict }
                : {}),
              listChildren: async (sessionID) =>
                sessionID === SESSION_A
                  ? [{ sessionId: 'child-session', parentID: SESSION_A }]
                  : [],
            },
          })
        }

        async function fireTask(adapter: OpencodeWorkflowGuard): Promise<void> {
          await adapter.hooks['tool.execute.before'](
            { tool: 'task', sessionID: SESSION_A, callID: 'strict-task' },
            { args: {} },
          )
          await adapter.hooks['tool.execute.after'](
            {
              tool: 'task',
              sessionID: SESSION_A,
              callID: 'strict-task',
              args: {},
            },
            {
              title: 'task result',
              output: 'done',
              metadata: { sessionId: 'child-session' },
            },
          )
        }

        test('a thrown strict read is unavailable / history-read-failed even when the lenient read would return []', async () => {
          const adapter = adapterWithReaders({
            lenient: async () => [],
            strict: async () => {
              throw new Error('strict read failed')
            },
          })
          await expectCause(
            adapter,
            'initialize-session',
            'history-read-failed',
          )
          expect(adapter.status(SESSION_A).state).toBe('unavailable')
        })

        test('a successful empty strict read is inactive, not unavailable', async () => {
          const adapter = adapterWithReaders({
            lenient: async () => [],
            strict: async () => [],
          })
          const parsed = await statusJson(adapter)
          expect(parsed.state).toBe('inactive')
          expect(parsed.firstUnavailableCause).toBeUndefined()
        })

        test('initialization uses the strict read and never the lenient one', async () => {
          const lenientCalls: string[] = []
          const adapter = adapterWithReaders({
            lenient: async (sessionID) => {
              lenientCalls.push(sessionID)
              return []
            },
            strict: async () => [],
          })
          await statusJson(adapter)
          expect(lenientCalls).toEqual([])
        })

        test('a child rollup read returning no parts rolls up nothing and leaves the parent unchanged', async () => {
          const adapter = adapterWithReaders({
            lenient: async () => [],
            strict: async () => [],
          })
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          const before = status(adapter)
          await fireTask(adapter)
          const after = status(adapter)
          expect(after.state).toBe(before.state)
          expect(after.state).not.toBe('unavailable')
          expect(after.epoch?.epochId).toBe(before.epoch?.epochId)
          expect(adapter.ledger(SESSION_A)?.listReceipts() ?? []).toEqual([])
        })

        test('a thrown child rollup read still marks the parent unavailable', async () => {
          const adapter = adapterWithReaders({
            lenient: async (sessionID) => {
              if (sessionID === 'child-session') {
                throw new Error('child read failed')
              }
              return []
            },
            strict: async () => [],
          })
          await observeSkill(adapter, 'systematic_skill', 'ce:work')
          expect(status(adapter).state).not.toBe('unavailable')
          await fireTask(adapter)
          expect(status(adapter).state).toBe('unavailable')
        })
      })
    })
  })

  describe('dual-registration rollupForegroundTask recovery (fix/workflow-guard-dual-registration-recovery)', () => {
    // Re-usable: build a mint marker array for a guard-capable ledger.
    // These are the markers that appear in a child session's parts when that
    // child session ran under a given registration.
    function buildChildMarkers(
      registrationIdentity: string,
      sessionSalt: Uint8Array,
      workspaceIdentity: string,
      repositoryIdentity: string,
      worktreeBeforeIdentity: string,
      worktreeAfterIdentity: string,
    ): unknown[] {
      const childLedger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity,
        sessionSalt,
      })
      const EPOCH_ID = 'c'.repeat(32)
      const UNIT_ID = 'd'.repeat(32)
      const td = (tag: string) => childLedger.digestIdentity('call', tag)

      const epochStart = projectReceiptProgressionMarker(childLedger, {
        target: 'epoch',
        state: 'started',
        epochId: EPOCH_ID,
        family: 'work',
        transitionDigest: td('epoch-start'),
        timestamp: 10,
      })
      const unitStart = projectReceiptProgressionMarker(childLedger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation'],
        resourceScopes: [],
        transitionDigest: td('unit-start'),
        timestamp: 11,
      })

      childLedger.prepareObservation({
        callId: 'child-impl',
        operation: 'implementation',
        context: {
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          workspaceIdentity,
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          repositoryIdentity,
          worktreeIdentity: worktreeBeforeIdentity,
        },
      })
      const finalized = childLedger.finalizeObservation({
        callId: 'child-impl',
        context: {
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          workspaceIdentity,
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          repositoryIdentity,
          worktreeIdentity: worktreeBeforeIdentity,
        },
        after: {
          workspaceIdentity,
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          repositoryIdentity,
          worktreeIdentity: worktreeAfterIdentity,
        },
        classification: {
          outcome: 'accepted',
          category: 'implementation',
          attribution: 'runtime-verified',
          result: 'success',
          sideEffect: 'required',
          reasonCode: 'recognized-command',
        },
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      })
      if (finalized.status !== 'finalized')
        throw new Error('child finalize failed')
      const mint = projectReceiptMintMarker(finalized.receipt, sessionSalt)
      if (!mint || !epochStart || !unitStart)
        throw new Error('child marker projection failed')
      return [epochStart, unitStart, mint]
    }

    function buildChildMarkersWithReceipts(
      registrationIdentity: string,
      sessionSalt: Uint8Array,
      workspaceIdentity: string,
      receipts: readonly {
        operation: 'implementation' | 'verification' | 'commit'
        workspaceIdentity?: string
        repositoryBeforeIdentity: string
        repositoryAfterIdentity: string
        worktreeBeforeIdentity: string
        worktreeAfterIdentity: string
      }[],
      operationTargetIdentity = OPERATION_SCOPE.operationTargetIdentity,
    ): unknown[] {
      const childLedger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity,
        sessionSalt,
      })
      const epochId = '8'.repeat(32)
      const unitId = '9'.repeat(32)
      const digestCall = (tag: string) =>
        childLedger.digestIdentity('call', tag)
      const epochStart = projectReceiptProgressionMarker(childLedger, {
        target: 'epoch',
        state: 'started',
        epochId,
        family: 'work',
        transitionDigest: digestCall('epoch-start'),
        timestamp: 10,
      })
      const unitStart = projectReceiptProgressionMarker(childLedger, {
        target: 'unit',
        state: 'started',
        epochId,
        unitId,
        family: 'work',
        requiredOperations: receipts.map(({ operation }) => operation),
        resourceScopes: [],
        transitionDigest: digestCall('unit-start'),
        timestamp: 11,
      })
      if (!epochStart || !unitStart)
        throw new Error('progression marker failed')

      const mints = receipts.map((receipt, index) => {
        const callId = `child-${receipt.operation}-${index}`
        const receiptWorkspaceIdentity =
          receipt.workspaceIdentity ?? workspaceIdentity
        const context = {
          epochId,
          unitId,
          workspaceIdentity: receiptWorkspaceIdentity,
          operationTargetIdentity,
          repositoryIdentity: receipt.repositoryBeforeIdentity,
          worktreeIdentity: receipt.worktreeBeforeIdentity,
        }
        expect(
          childLedger.prepareObservation({
            callId,
            operation: receipt.operation,
            context,
          }).status,
        ).toBe('prepared')
        const finalized = childLedger.finalizeObservation({
          callId,
          context,
          after: {
            workspaceIdentity: receiptWorkspaceIdentity,
            operationTargetIdentity,
            repositoryIdentity: receipt.repositoryAfterIdentity,
            worktreeIdentity: receipt.worktreeAfterIdentity,
            ...(receipt.operation === 'commit' ? { commitClosure: true } : {}),
          },
          classification: {
            outcome: 'accepted',
            category: receipt.operation,
            attribution: 'runtime-verified',
            result: 'success',
            sideEffect: 'required',
            reasonCode: 'recognized-command',
          },
          terminal: { status: 'success', output: 'non-empty', noOp: false },
        })
        if (finalized.status !== 'finalized')
          throw new Error('child receipt did not finalize')
        const mint = projectReceiptMintMarker(finalized.receipt, sessionSalt)
        if (!mint) throw new Error('child mint marker failed')
        return mint
      })

      return [epochStart, unitStart, ...mints]
    }

    // Helper: fire the task after hook with a given child session's parts
    async function fireTaskAfter(
      adapter: OpencodeWorkflowGuard,
      childSessionID: string,
      sessionID = SESSION_A,
    ): Promise<{
      title: string
      output: string
      metadata: Record<string, unknown>
    }> {
      const output: {
        title: string
        output: string
        metadata: Record<string, unknown>
      } = {
        title: 'task result',
        output: 'done',
        metadata: { sessionId: childSessionID },
      }
      await adapter.hooks['tool.execute.before'](
        {
          tool: 'task',
          sessionID,
          callID: 'task-call-1',
        },
        { args: {} },
      )
      await adapter.hooks['tool.execute.after'](
        {
          tool: 'task',
          sessionID,
          callID: 'task-call-1',
          args: {},
        },
        output,
      )
      return output
    }

    test('RED: mixed-registration child markers must not mark parent unavailable (rollup bug reproduction)', async () => {
      // Setup: own registration
      const ownIdentity = 'rollup-own-registration'
      const ownSalt = new Uint8Array(32).fill(13)
      const foreignIdentity = 'rollup-foreign-registration'
      const foreignSalt = new Uint8Array(32).fill(14)
      const childSessionID = 'child-session-mixed'
      const parentSessionID = SESSION_A

      const ownChildMarkers = buildChildMarkers(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-before',
        OPERATION_SCOPE.worktreeIdentity,
      )
      const foreignChildMarkers = buildChildMarkers(
        foreignIdentity,
        foreignSalt,
        OPERATION_SCOPE.workspaceIdentity,
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-before',
        OPERATION_SCOPE.worktreeIdentity,
      )
      // Combined: both registrations' markers in the same child session parts
      const combinedMarkers = [...ownChildMarkers, ...foreignChildMarkers]
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: combinedMarkers,
                },
              },
            },
          ],
        },
      ]

      // Track whether observer.snapshot() was called during rollup.
      // BEFORE FIX: conflicting-seed → markUnavailable() BEFORE snapshot call → snapshotCalled stays false.
      // AFTER FIX: own markers filtered → seed extracted → snapshot IS called.
      let snapshotCalled = false
      const ownAdapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        ...OPERATION_SCOPE,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        observer: {
          targetDigest: OPERATION_SCOPE.workspaceIdentity,
          // Required by `OpencodeOperationObserver`; this fixture previously
          // omitted it, which only compiled because Bun strips types at
          // runtime. It IS exercised here: rollupForegroundTask calls it
          // (opencode-workflow-guard.ts:2145). The `snapshotCalled` assertion
          // is unaffected because `options.observer?.snapshot()` (line 2100)
          // runs first; previously the missing member threw a swallowed
          // TypeError that aborted the rollup, so the rollup now runs to
          // completion (end state rejected/rejected-operation rather than
          // unavailable/guard-unavailable).
          validateRegisteredWorktree(candidateDirectory) {
            return {
              status: 'ok',
              targetRoot: candidateDirectory,
              gitDir: path.join(candidateDirectory, '.git'),
              commonDir: path.join(candidateDirectory, '.git'),
            }
          },
          async snapshot() {
            snapshotCalled = true
            return {
              status: 'available' as const,
              snapshot: operationSnapshot(),
            }
          },
          async remoteSnapshot() {
            return {
              status: 'unavailable' as const,
              reasonCode: 'remote-missing-field' as const,
            }
          },
        },
        hostReadback: {
          readSessionParts: async (sid) => {
            if (sid === parentSessionID) return []
            return childParts
          },
          listChildren: async (sid) =>
            sid === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })

      // Activate epoch via skill
      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'rollup-skill',
        parentSessionID,
      )

      // Confirm epoch is active before rollup
      expect(ownAdapter.status(parentSessionID).epoch).not.toBeNull()

      // Fire task after hook → triggers rollupForegroundTask
      // BEFORE FIX: extractReceiptReadbackSeed sees two differing seeds → conflicting-seed → markUnavailable
      //   before snapshot is ever called → snapshotCalled stays false.
      // AFTER FIX: foreign markers filtered out → own markers only → seed ready → snapshot called,
      //   then worktree validation runs and the rollup completes (see the observer fixture above).
      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      // Key assertion: snapshot must have been called, proving rollup got past the conflicting-seed gate.
      // Before the fix, markUnavailable() fires at the seed check, BEFORE the observer snapshot call.
      expect(snapshotCalled).toBe(true)
    })

    test('foreign-only child markers → benign no-op, session not marked unavailable', async () => {
      const ownIdentity = 'rollup-own-foreign-only'
      const ownSalt = new Uint8Array(32).fill(21)
      const foreignIdentity = 'rollup-foreign-only'
      const foreignSalt = new Uint8Array(32).fill(22)
      const childSessionID = 'child-session-foreign-only'
      const parentSessionID = SESSION_A

      const foreignChildMarkers = buildChildMarkers(
        foreignIdentity,
        foreignSalt,
        OPERATION_SCOPE.workspaceIdentity,
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-before',
        OPERATION_SCOPE.worktreeIdentity,
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]:
                    foreignChildMarkers,
                },
              },
            },
          ],
        },
      ]

      const ownAdapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        ...OPERATION_SCOPE,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        observer: sequenceObserver([operationSnapshot(), operationSnapshot()]),
        hostReadback: {
          readSessionParts: async (sid) => {
            if (sid === parentSessionID) return []
            return childParts
          },
          listChildren: async (sid) =>
            sid === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'foreign-only-skill',
        parentSessionID,
      )
      const beforeState = ownAdapter.status(parentSessionID).reasonCode

      // All child markers are foreign → benign no-op after filtering
      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      const s = ownAdapter.status(parentSessionID)
      expect(s.reasonCode).not.toBe('guard-unavailable')
      // State should be unchanged (epoch still active, not marked unavailable)
      expect(s.reasonCode).toBe(beforeState)
    })

    test('genuine corruption in own child markers still fails closed (markUnavailable)', async () => {
      const ownIdentity = 'rollup-corrupt-test'
      const ownSalt = new Uint8Array(32).fill(33)
      const childSessionID = 'child-session-corrupt'
      const parentSessionID = SESSION_A

      const ownChildMarkers = buildChildMarkers(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-before',
        OPERATION_SCOPE.worktreeIdentity,
      )
      // Corrupt the first marker's integrity
      const corruptedMarker = {
        ...(ownChildMarkers[0] as Record<string, unknown>),
        integrity: 'b'.repeat(64),
      }
      const corruptedMarkers = [corruptedMarker, ...ownChildMarkers.slice(1)]

      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: corruptedMarkers,
                },
              },
            },
          ],
        },
      ]

      const ownAdapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        ...OPERATION_SCOPE,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        observer: sequenceObserver([operationSnapshot(), operationSnapshot()]),
        hostReadback: {
          readSessionParts: async (sid) => {
            if (sid === parentSessionID) return []
            return childParts
          },
          listChildren: async (sid) =>
            sid === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'corrupt-skill',
        parentSessionID,
      )
      expect(ownAdapter.status(parentSessionID).state).not.toBe('unavailable')

      // Corrupt own marker → filter retains it → extractReceiptReadbackSeed fails on integrity → markUnavailable
      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      // Must still fail closed
      expect(ownAdapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
    })

    test('own-only child markers → regression guard (seed extraction and observer reach identical to before fix)', async () => {
      // Verify that when only own markers are present, the rollup path reaches
      // observer.snapshot() — which is the same behavior as before the fix
      // (filter is a no-op, seed is found cleanly, flow continues normally).
      const ownIdentity = 'rollup-own-only'
      const ownSalt = new Uint8Array(32).fill(44)
      const childSessionID = 'child-session-own-only'
      const parentSessionID = SESSION_A

      const ownChildMarkers = buildChildMarkers(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-before',
        OPERATION_SCOPE.worktreeIdentity,
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: ownChildMarkers,
                },
              },
            },
          ],
        },
      ]

      let snapshotCalled = false
      const ownAdapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        ...OPERATION_SCOPE,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        observer: {
          targetDigest: OPERATION_SCOPE.workspaceIdentity,
          validateRegisteredWorktree(candidateDirectory: string) {
            return {
              status: 'ok' as const,
              targetRoot: candidateDirectory,
              gitDir: `${candidateDirectory}/.git`,
              commonDir: `${candidateDirectory}/.git`,
            }
          },
          async snapshot() {
            snapshotCalled = true
            return {
              status: 'available' as const,
              snapshot: operationSnapshot(),
            }
          },
          async remoteSnapshot() {
            return {
              status: 'unavailable' as const,
              reasonCode: 'remote-missing-field' as const,
            }
          },
        },
        hostReadback: {
          readSessionParts: async (sid) => {
            if (sid === parentSessionID) return []
            return childParts
          },
          listChildren: async (sid) =>
            sid === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'own-only-skill',
        parentSessionID,
      )
      expect(ownAdapter.status(parentSessionID).epoch).not.toBeNull()

      // Own-only: filter is a no-op → same behavior as before fix → reaches observer snapshot
      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      // Regression guard: seed extraction succeeds, rollup reaches the observer snapshot call.
      // This proves the single-registration path is unaffected by the filter change.
      expect(snapshotCalled).toBe(true)
    })

    // ── Rollup ambiguity fail-closed tests (Oracle-identified defect) ─────────
    //
    // Signal: snapshotCalled === false means markUnavailable() fired BEFORE the
    // observer snapshot call (mode-level unavailable). If snapshot was called but
    // reasonCode is still guard-unavailable, it came from a unit-level issue (no
    // classifier), not from our new ambiguity guard.
    //
    // Assertion pattern for ambiguous rollup:
    //   snapshotCalled === false  (rollup bailed before observer)
    //   AND reasonCode === 'guard-unavailable' (mode-level, from markUnavailable)
    //
    // Assertion pattern for benign foreign-only rollup:
    //   snapshotCalled === false  (early return before observer)
    //   AND reasonCode !== 'guard-unavailable' (epoch still active as before)

    function buildCorruptedChildParts(
      registrationIdentity: string,
      sessionSalt: Uint8Array,
    ): readonly unknown[] {
      const ledger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity,
        sessionSalt,
      })
      const EPOCH_ID = 'e'.repeat(32)
      const validMarker = projectReceiptProgressionMarker(ledger, {
        target: 'epoch',
        state: 'started',
        epochId: EPOCH_ID,
        family: 'work',
        transitionDigest: ledger.digestIdentity('call', 'ep'),
        timestamp: 1,
      })
      if (!validMarker) throw new Error('marker projection failed')
      const corruptedMarker = { ...validMarker, integrity: 'e'.repeat(64) }
      return [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: [corruptedMarker],
                },
              },
            },
          ],
        },
      ]
    }

    function buildConsumeOnlyChildParts(
      registrationIdentity: string,
      sessionSalt: Uint8Array,
    ): readonly unknown[] {
      const ownLedger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity,
        sessionSalt,
      })
      const EPOCH_ID = 'f'.repeat(32)
      const UNIT_ID = '0'.repeat(32)
      ownLedger.prepareObservation({
        callId: 'ci',
        operation: 'implementation',
        context: {
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          workspaceIdentity: 'ws',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'b',
        },
      })
      const finalized = ownLedger.finalizeObservation({
        callId: 'ci',
        context: {
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          workspaceIdentity: 'ws',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'b',
        },
        after: {
          workspaceIdentity: 'ws',
          operationTargetIdentity: OPERATION_SCOPE.operationTargetIdentity,
          worktreeIdentity: 'a',
        },
        classification: {
          outcome: 'accepted',
          category: 'implementation',
          attribution: 'runtime-verified',
          result: 'success',
          sideEffect: 'required',
          reasonCode: 'recognized-command',
        },
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      })
      if (finalized.status !== 'finalized')
        throw new Error('child finalize failed')
      const consumeMarker = projectReceiptConsumptionMarker(
        finalized.receipt,
        ownLedger.digestIdentity('call', 'tr'),
        1,
      )
      if (!consumeMarker) throw new Error('consume marker projection failed')
      return [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: [consumeMarker],
                },
              },
            },
          ],
        },
      ]
    }

    function makeRollupAdapter(
      ownIdentity: string,
      ownSalt: Uint8Array,
      snapshotRef: { called: boolean },
      childSessionID: string,
      childPartsFactory: () => readonly unknown[],
      parentSessionID: string,
      runtimeRequiredOperations: readonly ReceiptOperation[] = [],
      repositoryIdentity = OPERATION_SCOPE.repositoryIdentity,
      snapshotRepositoryIdentity = OPERATION_SCOPE.repositoryIdentity,
      snapshotWorktreeIdentity = OPERATION_SCOPE.worktreeIdentity,
    ): OpencodeWorkflowGuard {
      return createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        ...OPERATION_SCOPE,
        repositoryIdentity,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        runtimeRequiredOperations,
        observer: {
          targetDigest: OPERATION_SCOPE.workspaceIdentity,
          validateRegisteredWorktree(candidateDirectory: string) {
            return {
              status: 'ok' as const,
              targetRoot: candidateDirectory,
              gitDir: `${candidateDirectory}/.git`,
              commonDir: `${candidateDirectory}/.git`,
            }
          },
          async snapshot() {
            snapshotRef.called = true
            return {
              status: 'available' as const,
              snapshot: operationSnapshot(
                snapshotRepositoryIdentity,
                snapshotWorktreeIdentity,
              ),
            }
          },
          async remoteSnapshot() {
            return {
              status: 'unavailable' as const,
              reasonCode: 'remote-missing-field' as const,
            }
          },
        },
        hostReadback: {
          readSessionParts: async (sid) => {
            if (sid === parentSessionID) return []
            return childPartsFactory()
          },
          listChildren: async (sid) =>
            sid === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })
    }

    test('RED rollup: all own child seed markers corrupted → markUnavailable before snapshot', async () => {
      // BEFORE FIX: corrupted marker → ownMarkersFromParts returns [] → benign return.
      //   snapshotCalled stays false AND reasonCode stays 'missing-evidence' (active epoch).
      // AFTER FIX:  corrupted marker → ambiguous → markUnavailable() before snapshot.
      //   snapshotCalled stays false AND reasonCode becomes 'guard-unavailable'.
      const ownIdentity = 'rollup-corrupt-seed'
      const ownSalt = new Uint8Array(32).fill(77)
      const childSessionID = 'child-corrupt-seed'
      const parentSessionID = SESSION_A

      const snapshotRef = { called: false }
      const ownAdapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => buildCorruptedChildParts(ownIdentity, ownSalt),
        parentSessionID,
      )

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'corrupt-seed-skill',
        parentSessionID,
      )
      expect(ownAdapter.status(parentSessionID).epoch).not.toBeNull()

      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      // BEFORE FIX: snapshotRef.called === false (early return) but reasonCode ≠ 'guard-unavailable'
      // AFTER FIX:  snapshotRef.called === false (markUnavailable fires) + reasonCode = 'guard-unavailable'
      expect(snapshotRef.called).toBe(false)
      expect(ownAdapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
    })

    test('RED rollup: consume-only child markers (no salt) → markUnavailable before snapshot', async () => {
      // BEFORE FIX: consume-only → ownMarkersFromParts returns [] → benign return.
      // AFTER FIX:  consume-only → ambiguous → markUnavailable().
      const ownIdentity = 'rollup-consume-only'
      const ownSalt = new Uint8Array(32).fill(88)
      const childSessionID = 'child-consume-only'
      const parentSessionID = SESSION_A

      const snapshotRef = { called: false }
      const ownAdapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => buildConsumeOnlyChildParts(ownIdentity, ownSalt),
        parentSessionID,
      )

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'consume-only-skill',
        parentSessionID,
      )
      expect(ownAdapter.status(parentSessionID).epoch).not.toBeNull()

      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      expect(snapshotRef.called).toBe(false)
      expect(ownAdapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
    })

    test('rollup: valid foreign marker + malformed marker → ambiguous → markUnavailable before snapshot', async () => {
      // Child session parts contain one valid provably-foreign seed-bearing marker
      // (different registrationDigest that does NOT agree with our identity) PLUS one
      // malformed/invalid marker. classifyMarkersFromParts → ambiguous (malformed is
      // not provably foreign) → rollupForegroundTask → markUnavailable() before snapshot.
      const ownIdentity = 'rollup-foreign-plus-malformed'
      const ownSalt = new Uint8Array(32).fill(111)
      const foreignIdentity = 'rollup-provably-foreign-reg'
      const foreignSalt = new Uint8Array(32).fill(112)
      const childSessionID = 'child-foreign-plus-malformed'
      const parentSessionID = SESSION_A

      // Build one valid foreign seed marker (provably foreign: valid + seed-bearing + ≠ own identity)
      const foreignLedger = createReceiptLedger({
        capabilityFlags: ['workflow-guard'],
        registrationIdentity: foreignIdentity,
        sessionSalt: foreignSalt,
      })
      const foreignEpochMarker = projectReceiptProgressionMarker(
        foreignLedger,
        {
          target: 'epoch',
          state: 'started',
          epochId: '1'.repeat(32),
          family: 'work',
          transitionDigest: foreignLedger.digestIdentity('call', 'ep'),
          timestamp: 1,
        },
      )
      if (!foreignEpochMarker)
        throw new Error('foreign marker projection failed')

      // Malformed marker: unparseable shape → validateReceiptMarker → unknown-kind → ambiguous
      const malformedMarker = { kind: 'corrupt-unknown', payload: 'x' }

      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: [
                    foreignEpochMarker,
                    malformedMarker,
                  ],
                },
              },
            },
          ],
        },
      ]

      const snapshotRef = { called: false }
      const ownAdapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
      )

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'foreign-malformed-skill',
        parentSessionID,
      )
      expect(ownAdapter.status(parentSessionID).epoch).not.toBeNull()

      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      // Ambiguous (malformed marker present) → markUnavailable() fires before snapshot.
      expect(snapshotRef.called).toBe(false)
      expect(ownAdapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
    })

    test('regression guard rollup: genuinely foreign-only child → benign no-op, NOT markUnavailable', async () => {
      // All valid, salt-bearing, provably-foreign child markers → foreign-empty → early return.
      // Must NOT regress to markUnavailable. Passes both before and after the fix.
      const ownIdentity = 'rollup-foreign-regression'
      const ownSalt = new Uint8Array(32).fill(99)
      const foreignIdentity = 'rollup-foreign-valid-only'
      const foreignSalt = new Uint8Array(32).fill(100)
      const childSessionID = 'child-foreign-valid-only'
      const parentSessionID = SESSION_A

      const foreignChildMarkers = buildChildMarkers(
        foreignIdentity,
        foreignSalt,
        OPERATION_SCOPE.workspaceIdentity,
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-b',
        OPERATION_SCOPE.worktreeIdentity,
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]:
                    foreignChildMarkers,
                },
              },
            },
          ],
        },
      ]

      const snapshotRef = { called: false }
      const ownAdapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
      )

      await observeSkill(
        ownAdapter,
        'systematic_skill',
        'ce:work',
        'foreign-regression-skill',
        parentSessionID,
      )
      const beforeReasonCode = ownAdapter.status(parentSessionID).reasonCode
      expect(ownAdapter.status(parentSessionID).epoch).not.toBeNull()

      await fireTaskAfter(ownAdapter, childSessionID, parentSessionID)

      // Benign no-op: snapshot not called, guard not marked unavailable
      expect(snapshotRef.called).toBe(false)
      expect(ownAdapter.status(parentSessionID).reasonCode).not.toBe(
        'guard-unavailable',
      )
      expect(ownAdapter.status(parentSessionID).reasonCode).toBe(
        beforeReasonCode,
      )
    })

    test('foreign workspace child receipt still makes the parent unavailable', async () => {
      const ownIdentity = 'rollup-foreign-workspace'
      const ownSalt = new Uint8Array(32).fill(121)
      const childSessionID = 'child-foreign-workspace'
      const parentSessionID = SESSION_A
      const childMarkers = buildChildMarkers(
        ownIdentity,
        ownSalt,
        'workspace-other',
        OPERATION_SCOPE.repositoryIdentity,
        'worktree-before',
        OPERATION_SCOPE.worktreeIdentity,
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: childMarkers,
                },
              },
            },
          ],
        },
      ]
      const snapshotRef = { called: false }
      const adapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
      )

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'foreign-workspace-skill',
      )
      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      expect(snapshotRef.called).toBe(true)
      expect(adapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
    })

    test('RED rollup preflights every local child receipt before minting any parent evidence', async () => {
      const ownIdentity = 'rollup-preflight-before-mint'
      const ownSalt = new Uint8Array(32).fill(126)
      const childSessionID = 'child-preflight-before-mint'
      const parentSessionID = SESSION_A
      const finalRepository = 'f'.repeat(64)
      const finalWorktree = '1'.repeat(64)
      const childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'implementation',
            repositoryBeforeIdentity: OPERATION_SCOPE.repositoryIdentity,
            repositoryAfterIdentity: finalRepository,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: finalWorktree,
          },
          {
            operation: 'verification',
            workspaceIdentity: 'workspace-other',
            repositoryBeforeIdentity: finalRepository,
            repositoryAfterIdentity: finalRepository,
            worktreeBeforeIdentity: finalWorktree,
            worktreeAfterIdentity: finalWorktree,
          },
        ],
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: childMarkers,
                },
              },
            },
          ],
        },
      ]
      const snapshotRef = { called: false }
      const adapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
        ['implementation', 'verification'],
        OPERATION_SCOPE.repositoryIdentity,
        finalRepository,
        finalWorktree,
      )

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'preflight-before-mint-skill',
        parentSessionID,
      )
      const beforeReceiptCount = ledger(adapter, parentSessionID).listReceipts()
        .length

      const output = await fireTaskAfter(
        adapter,
        childSessionID,
        parentSessionID,
      )
      expect(snapshotRef.called).toBe(true)
      expect(adapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(
        beforeReceiptCount,
      )
      expect(
        output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
      ).toBeUndefined()
    })

    test('RED rollup mints implementation and verification from fresh parent context exactly once', async () => {
      const ownIdentity = 'rollup-fresh-context-per-candidate'
      const ownSalt = new Uint8Array(32).fill(127)
      const childSessionID = 'child-fresh-context-per-candidate'
      const parentSessionID = SESSION_A
      const finalRepository = 'f'.repeat(64)
      const finalWorktree = '1'.repeat(64)
      const childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'implementation',
            repositoryBeforeIdentity: OPERATION_SCOPE.repositoryIdentity,
            repositoryAfterIdentity: finalRepository,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: finalWorktree,
          },
          {
            operation: 'verification',
            repositoryBeforeIdentity: OPERATION_SCOPE.repositoryIdentity,
            repositoryAfterIdentity: finalRepository,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: finalWorktree,
          },
        ],
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: childMarkers,
                },
              },
            },
          ],
        },
      ]
      const snapshotRef = { called: false }
      const adapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
        ['implementation', 'verification'],
        OPERATION_SCOPE.repositoryIdentity,
        finalRepository,
        finalWorktree,
      )

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'fresh-context-per-candidate-skill',
        parentSessionID,
      )

      const firstOutput = await fireTaskAfter(
        adapter,
        childSessionID,
        parentSessionID,
      )
      const firstReceipts = ledger(adapter, parentSessionID).listReceipts()
      const firstMarkers = [
        firstOutput.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
      ].flatMap((value) =>
        Array.isArray(value) ? value : value ? [value] : [],
      )
      const firstMarkerReceiptIDs = firstMarkers.map(
        (marker) =>
          (
            marker as {
              envelope: { canonical: { receiptId: string } }
            }
          ).envelope.canonical.receiptId,
      )

      expect(snapshotRef.called).toBe(true)
      expect(firstReceipts).toHaveLength(2)
      expect(
        firstReceipts.map((receipt) => receipt.canonical.operation),
      ).toEqual(['implementation', 'verification'])
      expect(status(adapter, parentSessionID).satisfiedOperations).toEqual(
        expect.arrayContaining(['implementation', 'verification']),
      )
      expect(status(adapter, parentSessionID).reasonCode).not.toBe(
        'fresh-readback',
      )
      expect(firstMarkers).toHaveLength(2)
      expect(new Set(firstMarkerReceiptIDs).size).toBe(2)

      const secondOutput = await fireTaskAfter(
        adapter,
        childSessionID,
        parentSessionID,
      )
      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(2)
      expect(
        secondOutput.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY],
      ).toBeUndefined()
    })

    test('rolls up a child implementation from a registered worktree target', async () => {
      const fixture = createTargetDerivationFixture()
      try {
        const parentObserver = createOpencodeOperationObserver({
          targetDirectory: fixture.parentRoot,
        })
        const initial = await parentObserver.snapshot()
        if (initial.status !== 'available')
          throw new Error('parent observer unavailable')

        const ownIdentity = 'rollup-registered-worktree-target'
        const ownSalt = new Uint8Array(32).fill(128)
        const childSessionID = 'child-registered-worktree-target'
        const parentSessionID = SESSION_A
        let childParts: ReadonlyArray<unknown> = []
        const adapter = createOpencodeWorkflowGuard({
          config: { mode: 'observe', debug: false },
          workspaceIdentity: initial.snapshot.targetDigest,
          repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
          worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
          targetDirectory: fixture.parentRoot,
          registrationIdentity: ownIdentity,
          sessionSalt: ownSalt,
          runtimeRequiredOperations: ['implementation'],
          observer: parentObserver,
          classifier: createReceiptClassifier(),
          hostReadback: {
            readSessionParts: async (sessionID) =>
              sessionID === parentSessionID ? [] : childParts,
            listChildren: async (sessionID) =>
              sessionID === parentSessionID
                ? [{ sessionId: childSessionID, parentID: parentSessionID }]
                : [],
          },
        })

        await observeSkill(
          adapter,
          'systematic_skill',
          'ce:work',
          'registered-worktree-parent-skill',
          parentSessionID,
        )

        const childSkillOutput: RecordedToolOutput = {
          title: 'Loaded skill',
          output: 'child skill result',
          metadata: {},
        }
        await observeSkill(
          adapter,
          'systematic_skill',
          'ce:work',
          'registered-worktree-child-skill',
          childSessionID,
          childSkillOutput,
        )

        const filePath = path.join(fixture.linkedRoot, 'rollup-targeted.txt')
        const childWriteInput = {
          tool: 'write',
          sessionID: childSessionID,
          callID: 'registered-worktree-child-write',
          args: { filePath, content: 'changed' },
        }
        const childWriteOutput: RecordedToolOutput = {
          title: 'write complete',
          output: 'changed',
          metadata: {},
        }
        await adapter.hooks['tool.execute.before'](childWriteInput, {
          args: childWriteInput.args,
        })
        fs.writeFileSync(filePath, 'changed')
        await adapter.hooks['tool.execute.after'](
          childWriteInput,
          childWriteOutput,
        )

        const childSkillMarkers =
          childSkillOutput.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
        const childWriteMarker =
          childWriteOutput.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
        childParts = [
          {
            info: {},
            parts: [
              {
                state: {
                  metadata: {
                    [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: [
                      ...(Array.isArray(childSkillMarkers)
                        ? childSkillMarkers
                        : childSkillMarkers
                          ? [childSkillMarkers]
                          : []),
                      ...(childWriteMarker ? [childWriteMarker] : []),
                    ],
                  },
                },
              },
            ],
          },
        ]

        await fireTaskAfter(adapter, childSessionID, parentSessionID)

        const receipts = ledger(adapter, parentSessionID).listReceipts()
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.canonical.operation).toBe('implementation')
        expect(status(adapter, parentSessionID).satisfiedOperations).toContain(
          'implementation',
        )
      } finally {
        fixture.cleanup()
      }
    })

    test('rejects a child receipt with an authenticated unregistered target identity', async () => {
      const ownIdentity = 'rollup-wrong-operation-target'
      const ownSalt = new Uint8Array(32).fill(129)
      const childSessionID = 'child-wrong-operation-target'
      const parentSessionID = SESSION_A
      const wrongTargetIdentity = 'f'.repeat(64)
      const childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'implementation',
            repositoryBeforeIdentity: OPERATION_SCOPE.repositoryIdentity,
            repositoryAfterIdentity: OPERATION_SCOPE.repositoryIdentity,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: '1'.repeat(64),
          },
        ],
        wrongTargetIdentity,
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: childMarkers,
                },
              },
            },
          ],
        },
      ]
      const snapshotRef = { called: false }
      const adapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
        ['implementation'],
      )

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'wrong-operation-target-skill',
        parentSessionID,
      )
      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      expect(adapter.status(parentSessionID).reasonCode).toBe(
        'guard-unavailable',
      )
      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(0)
    })

    test('skips stale child receipts, mints a later current receipt, and rolls up once', async () => {
      const ownIdentity = 'rollup-stale-then-current'
      const ownSalt = new Uint8Array(32).fill(122)
      const childSessionID = 'child-stale-then-current'
      const parentSessionID = SESSION_A
      const childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'implementation',
            repositoryBeforeIdentity: 'd'.repeat(64),
            repositoryAfterIdentity: 'e'.repeat(64),
            worktreeBeforeIdentity: 'f'.repeat(64),
            worktreeAfterIdentity: '1'.repeat(64),
          },
          {
            operation: 'commit',
            repositoryBeforeIdentity: 'd'.repeat(64),
            repositoryAfterIdentity: OPERATION_SCOPE.repositoryIdentity,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: OPERATION_SCOPE.worktreeIdentity,
          },
        ],
      )
      const childParts = [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: childMarkers,
                },
              },
            },
          ],
        },
      ]
      const snapshotRef = { called: false }
      const adapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        () => childParts,
        parentSessionID,
        ['commit'],
        'd'.repeat(64),
      )

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'stale-then-current-skill',
      )
      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      const firstReceipts = ledger(adapter, parentSessionID).listReceipts()
      expect(
        firstReceipts.filter((receipt) => receipt.canonical.operation),
      ).toHaveLength(1)
      expect(firstReceipts[0]?.canonical.operation).toBe('commit')
      expect(status(adapter, parentSessionID).satisfiedOperations).toContain(
        'commit',
      )

      await fireTaskAfter(adapter, childSessionID, parentSessionID)
      const secondReceipts = ledger(adapter, parentSessionID).listReceipts()
      expect(secondReceipts).toHaveLength(firstReceipts.length)
      expect(snapshotRef.called).toBe(true)
    })

    test('does not mark the parent unavailable when every child receipt is stale, and retries fresh evidence', async () => {
      const ownIdentity = 'rollup-stale-only-retry'
      const ownSalt = new Uint8Array(32).fill(123)
      const childSessionID = 'child-stale-only-retry'
      const parentSessionID = SESSION_A
      let childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'commit',
            repositoryBeforeIdentity: 'd'.repeat(64),
            repositoryAfterIdentity: 'e'.repeat(64),
            worktreeBeforeIdentity: 'f'.repeat(64),
            worktreeAfterIdentity: '1'.repeat(64),
          },
        ],
      )
      const childParts = () => [
        {
          info: {},
          parts: [
            {
              state: {
                metadata: {
                  [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]: childMarkers,
                },
              },
            },
          ],
        },
      ]
      const snapshotRef = { called: false }
      const adapter = makeRollupAdapter(
        ownIdentity,
        ownSalt,
        snapshotRef,
        childSessionID,
        childParts,
        parentSessionID,
        ['commit'],
        'd'.repeat(64),
      )

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'stale-only-retry-skill',
      )
      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      expect(snapshotRef.called).toBe(true)
      expect(status(adapter, parentSessionID).reasonCode).not.toBe(
        'guard-unavailable',
      )
      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(0)
      expect(
        status(adapter, parentSessionID).satisfiedOperations,
      ).not.toContain('commit')

      childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'commit',
            repositoryBeforeIdentity: 'd'.repeat(64),
            repositoryAfterIdentity: OPERATION_SCOPE.repositoryIdentity,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: OPERATION_SCOPE.worktreeIdentity,
          },
        ],
      )
      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(1)
      expect(status(adapter, parentSessionID).satisfiedOperations).toContain(
        'commit',
      )
    })

    test('uses the guard current context after a parent implementation before rolling up a child commit', async () => {
      const ownIdentity = 'rollup-parent-local-before-child-commit'
      const ownSalt = new Uint8Array(32).fill(124)
      const childSessionID = 'child-parent-local-before-commit'
      const parentSessionID = SESSION_A
      const parentRepository = 'd'.repeat(64)
      const parentWorktree = 'e'.repeat(64)
      const finalRepository = 'f'.repeat(64)
      const finalWorktree = '1'.repeat(64)
      const childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'commit',
            repositoryBeforeIdentity: parentRepository,
            repositoryAfterIdentity: finalRepository,
            worktreeBeforeIdentity: parentWorktree,
            worktreeAfterIdentity: finalWorktree,
          },
        ],
      )
      const snapshot = sequenceObserver([
        operationSnapshot(),
        operationSnapshot(parentRepository, parentWorktree),
        operationSnapshot(finalRepository, finalWorktree),
      ])
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        ...OPERATION_SCOPE,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        runtimeRequiredOperations: ['commit'],
        classifier: createReceiptClassifier(),
        observer: snapshot,
        hostReadback: {
          readSessionParts: async (sessionID) =>
            sessionID === parentSessionID
              ? []
              : [
                  {
                    info: {},
                    parts: [
                      {
                        state: {
                          metadata: {
                            [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]:
                              childMarkers,
                          },
                        },
                      },
                    ],
                  },
                ],
          listChildren: async (sessionID) =>
            sessionID === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'parent-local-before-child-commit-skill',
        parentSessionID,
      )
      await observeOperationTool(
        adapter,
        'write',
        { filePath: 'parent-local.txt', content: 'parent change' },
        { title: 'write', output: 'changed', metadata: {} },
        'parent-local-implementation',
        parentSessionID,
      )
      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(1)
      expect(status(adapter, parentSessionID).satisfiedOperations).toContain(
        'implementation',
      )

      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      const receipts = ledger(adapter, parentSessionID).listReceipts()
      expect(receipts).toHaveLength(2)
      expect(receipts.map((receipt) => receipt.canonical.operation)).toEqual([
        'implementation',
        'commit',
      ])
      expect(status(adapter, parentSessionID).satisfiedOperations).toContain(
        'commit',
      )
      expect(status(adapter, parentSessionID).reasonCode).not.toBe(
        'guard-unavailable',
      )
    })

    test('rolls up a child commit when boot repository and worktree identities are omitted', async () => {
      const ownIdentity = 'rollup-optional-boot-identities'
      const ownSalt = new Uint8Array(32).fill(125)
      const childSessionID = 'child-optional-boot-identities'
      const parentSessionID = SESSION_A
      const childMarkers = buildChildMarkersWithReceipts(
        ownIdentity,
        ownSalt,
        OPERATION_SCOPE.workspaceIdentity,
        [
          {
            operation: 'commit',
            repositoryBeforeIdentity: 'd'.repeat(64),
            repositoryAfterIdentity: OPERATION_SCOPE.repositoryIdentity,
            worktreeBeforeIdentity: OPERATION_SCOPE.worktreeIdentity,
            worktreeAfterIdentity: OPERATION_SCOPE.worktreeIdentity,
          },
        ],
      )
      const adapter = createOpencodeWorkflowGuard({
        config: { mode: 'observe', debug: false },
        workspaceIdentity: OPERATION_SCOPE.workspaceIdentity,
        registrationIdentity: ownIdentity,
        sessionSalt: ownSalt,
        runtimeRequiredOperations: ['commit'],
        observer: sequenceObserver([
          operationSnapshot('d'.repeat(64), OPERATION_SCOPE.worktreeIdentity),
          operationSnapshot(),
        ]),
        hostReadback: {
          readSessionParts: async (sessionID) =>
            sessionID === parentSessionID
              ? []
              : [
                  {
                    info: {},
                    parts: [
                      {
                        state: {
                          metadata: {
                            [SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]:
                              childMarkers,
                          },
                        },
                      },
                    ],
                  },
                ],
          listChildren: async (sessionID) =>
            sessionID === parentSessionID
              ? [{ sessionId: childSessionID, parentID: parentSessionID }]
              : [],
        },
      })

      await observeSkill(
        adapter,
        'systematic_skill',
        'ce:work',
        'optional-boot-identities-skill',
        parentSessionID,
      )
      await getTool(adapter, 'systematic_workflow_status').execute(
        {},
        toolContext(parentSessionID),
      )
      await fireTaskAfter(adapter, childSessionID, parentSessionID)

      expect(ledger(adapter, parentSessionID).listReceipts()).toHaveLength(1)
      expect(status(adapter, parentSessionID).satisfiedOperations).toContain(
        'commit',
      )
    })
  })
})
