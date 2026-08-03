import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type {
  OpencodeOperationObserver,
  OpencodeWorkflowHostReadback,
  OperationObserverRemoteResult,
  OperationObserverSnapshot,
} from '../../src/lib/opencode-operation-observer.js'
import { createOpencodeOperationObserver } from '../../src/lib/opencode-operation-observer.js'
import {
  createOpencodeWorkflowGuard,
  createWorkflowGuardBlockedError,
  deriveOpencodeOperationTarget,
  isWorkflowGuardBlockedError,
  type OpencodeWorkflowGuard,
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

function toolContext(sessionID = SESSION_A): {
  sessionID: string
  metadata: () => void
} {
  return { sessionID, metadata: () => {} }
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
      return values[Math.min(current, values.length - 1)]
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
  runtimeRequiredOperations: readonly string[] = [],
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
                  return classifier.classifyOperation?.(input)
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

async function createPinnedRecoveryAdapter(): Promise<{
  readonly fixture: TargetDerivationFixture
  readonly adapter: OpencodeWorkflowGuard
  readonly targetRoot: string
  readonly targetIdentity: string
  setTargetValidationAvailable(value: boolean): void
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
  const observer: OpencodeOperationObserver = {
    targetDigest: baseObserver.targetDigest,
    validateRegisteredWorktree: (candidateDirectory) => {
      if (!targetValidationAvailable && candidateDirectory === targetRoot) {
        return { status: 'error', reasonCode: 'target-unavailable' }
      }
      return baseObserver.validateRegisteredWorktree(candidateDirectory)
    },
    snapshot: () => baseObserver.snapshot(),
  }
  const registrationIdentity = 'pinned-completion-registration'
  const sessionSalt = new Uint8Array(32).fill(137)
  let parentMarkers: readonly unknown[] = []
  const adapter = createOpencodeWorkflowGuard({
    config: { mode: 'observe' },
    workspaceIdentity: initial.snapshot.targetDigest,
    repositoryIdentity: targetInitial.snapshot.repositoryRevisionDigest,
    worktreeIdentity: targetInitial.snapshot.worktreeRevisionDigest,
    targetDirectory: fixture.parentRoot,
    sessionLocation: fixture.parentRoot,
    registrationIdentity,
    sessionSalt,
    observer,
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
  await adapter.tools.systematic_workflow_status.execute(
    {},
    { sessionID: SESSION_A, metadata: () => {} },
  )

  return {
    fixture,
    adapter,
    targetRoot,
    targetIdentity: targetObserver.targetDigest,
    setTargetValidationAvailable(value) {
      targetValidationAvailable = value
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
    config: { mode: 'observe' },
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
    const output = {
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
    const output = {
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
    const source = createAdapter(
      'observe',
      false,
      sequenceObserver([{ targetDigest: 'a'.repeat(64) }]),
      [],
      undefined,
      undefined,
      true,
    )
    const skillOutput = { title: 'skill', output: 'loaded', metadata: {} }
    await observeSkill(
      source,
      'systematic_skill',
      'ce:work',
      'replay-skill',
      SESSION_A,
      skillOutput,
    )
    const startOutput = {
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
    const restored = createAdapter(
      'observe',
      false,
      sequenceObserver([{ targetDigest: 'a'.repeat(64) }]),
      [],
      undefined,
      {
        readSessionParts: async () => parts,
        listChildren: async () => [],
      },
      true,
    )
    await restored.tools.systematic_workflow_status.execute({}, toolContext())

    expect(status(restored)).toMatchObject({
      state: 'waiting',
      missingOperations: ['implementation', 'verification', 'commit'],
    })
    expect(status(restored).reasonCode).not.toBe('guard-unavailable')
  })

  test('falls back to the mandatory floor for unknown guarded skills', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'ce:brainstorm')
    expect(status(adapter).unit?.requiredOperations).toEqual([
      'implementation',
      'verification',
    ])
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
      const args = adapter.tools[id].args as Record<string, unknown>
      expect(Object.keys(args).sort()).toEqual([...keys].sort())
      expect(() => z.object(args).strict()).not.toThrow()
      for (const value of Object.values(args)) {
        expect(value).toHaveProperty('_def')
      }
    }

    const result = await adapter.tools.systematic_workflow_status.execute(
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
    const start = await adapter.tools.systematic_workflow_start.execute(
      { expected_operations: ['commit'] },
      toolContext(),
    )
    const statusBefore = status(adapter)
    const statusOutput = await adapter.tools.systematic_workflow_status.execute(
      {},
      toolContext(),
    )
    const control = await adapter.tools.systematic_workflow_control.execute(
      { mode: 'disabled' },
      toolContext(),
    )

    expect(start.output).toContain('pending')
    expect(statusOutput.output).toContain(statusBefore.state)
    expect(control.output).toContain('question-attestation')
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

    const status = await adapter.tools.systematic_workflow_status.execute(
      {},
      toolContext(),
    )
    expect(status.metadata).toMatchObject({
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
    const first = await adapter.tools.systematic_workflow_control.execute(
      { mode: 'disabled' },
      toolContext(),
    )
    expect(first.output).toContain('question-attestation')
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
    const second = await adapter.tools.systematic_workflow_control.execute(
      { mode: 'disabled' },
      toolContext(),
    )
    expect(second.output).toContain('disabled')
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
      return first.tools.systematic_workflow_complete.execute(
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
      return ready.tools.systematic_workflow_complete.execute(
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
    await adapter.tools.systematic_workflow_start.execute({}, toolContext())
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
    ).toMatchObject({ status: 'unavailable' })
  })

  test('requires valid session identities and does not alias missing tool contexts', async () => {
    const adapter = createAdapter()
    await adapter.hooks['tool.execute.before'](
      { tool: 'systematic_skill', sessionID: '', callID: 'missing-session' },
      { args: { name: 'ce:work' } },
    )
    await adapter.tools.systematic_workflow_status.execute({}, toolContext())
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
      state: 'unavailable',
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
    expect(firstPass).toContain('unavailable')

    await first.hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    )
    const secondPass = output.system.join('\n')
    expect(
      (secondPass.match(/<SYSTEMATIC_WORKFLOW_GUARD>/g) ?? []).length,
    ).toBe(1)
    expect(secondPass).toContain('unavailable')
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
    const worst = document.sources.find(
      (source) => source.state === 'unavailable',
    )
    expect(document.aggregate.state).toBe('unavailable')
    expect(document.aggregate.statusDigest).toBe(worst?.statusDigest)
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
      const output = {
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
      const output = {
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
        config: { mode: 'observe' },
        workspaceIdentity: initial.snapshot.targetDigest,
        repositoryIdentity: initial.snapshot.repositoryRevisionDigest,
        worktreeIdentity: initial.snapshot.worktreeRevisionDigest,
        targetDirectory: fixture.parentRoot,
        observer: parentObserver,
        classifier: {
          ...classifier,
          classifyOperation: async (input: unknown) => {
            observations.push(input as ReceiptOperationObservation)
            return classifier.classifyOperation?.(input)
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
        config: { mode: 'observe' },
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
        config: { mode: 'observe' },
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
        config: { mode: 'observe' },
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

    await adapter.tools.systematic_workflow_status.execute({}, toolContext())
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

  test('rejects host results beyond the bounded output limit', async () => {
    const adapter = createAdapter()
    await observeSkill(
      adapter,
      'systematic_skill',
      'ce:work',
      'overlong-host-result',
      SESSION_A,
      { title: '', output: 'x'.repeat(32_769), metadata: {} },
    )
    expect(status(adapter).epoch).toBeNull()
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
    const output = {
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

  test('before-only operation is abandoned at the next status boundary', async () => {
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
    await adapter.tools.systematic_workflow_status.execute({}, toolContext())
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
        config: { mode: 'observe' },
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
        config: { mode: 'observe' },
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
    const skillOutput = { title: 'skill', output: 'loaded', metadata: {} }
    await observeSkill(
      source,
      'systematic_skill',
      'ce:work',
      'skill-recovery',
      SESSION_A,
      skillOutput,
    )
    const output = {
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
    await restored.tools.systematic_workflow_status.execute({}, toolContext())
    expect(status(restored).epoch).not.toBeNull()
    expect(status(restored).unit).not.toBeNull()
    expect(status(restored).satisfiedOperations).toContain('implementation')
    await restored.tools.systematic_workflow_status.execute({}, toolContext())
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

      await restored.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
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

      await restored.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
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

      await restored.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
      )

      const s = restored.status(SESSION_A)
      // Genuine corruption → still fails closed → unavailable
      expect(s.state).toBe('unavailable')
    })

    test('empty array after filter → fresh start, not guard-unavailable', async () => {
      // This is effectively the foreign-only case: after filtering there are no own markers.
      // The guard should treat this as a fresh start (allowFresh path in initializeSession),
      // NOT as guard-unavailable. A fresh guard without an active epoch has state
      // 'unavailable' with reasonCode 'no-active-epoch' — distinct from 'guard-unavailable'.
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

      await restored.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
      )

      // A fresh guard (no epoch activated yet) has state 'unavailable' / 'no-active-epoch'.
      // The key invariant: it must NOT be 'guard-unavailable' (which publishUnavailable sets).
      const s = restored.status(SESSION_A)
      expect(s.reasonCode).not.toBe('guard-unavailable')
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

      await adapter.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
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

      await adapter.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
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

      await adapter.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
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

      await adapter.tools.systematic_workflow_status.execute(
        {},
        { sessionID: SESSION_A, metadata: () => {} },
      )

      const s = adapter.status(SESSION_A)
      // Foreign-only → publishFresh → no-active-epoch (NOT guard-unavailable).
      expect(s.reasonCode).toBe('no-active-epoch')
      expect(s.epoch).toBeNull()
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
      await adapter.hooks['tool.execute.before']({
        tool: 'task',
        sessionID,
        callID: 'task-call-1',
        args: {},
      })
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
      // AFTER FIX: foreign markers filtered out → own markers only → seed ready → snapshot called.
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

        const childSkillOutput = {
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
        const childWriteOutput = {
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
      await adapter.tools.systematic_workflow_status.execute(
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
