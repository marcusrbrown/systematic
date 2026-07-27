import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type {
  OpencodeOperationObserver,
  OpencodeWorkflowHostReadback,
  OperationObserverRemoteResult,
  OperationObserverSnapshot,
} from '../../src/lib/opencode-operation-observer.js'
import {
  createOpencodeWorkflowGuard,
  createWorkflowGuardBlockedError,
  isWorkflowGuardBlockedError,
  type OpencodeWorkflowGuard,
  SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY,
} from '../../src/lib/opencode-workflow-guard.js'
import {
  createReceiptClassifier,
  type ReceiptOperationObservation,
} from '../../src/lib/receipt-classifier.js'
import type { ReceiptLedger } from '../../src/lib/receipt-ledger.js'
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

describe('OpenCode workflow guard adapter', () => {
  test('selects trusted required operations from the activated skill', async () => {
    const adapter = createAdapter('observe')
    await observeSkill(adapter, 'systematic_skill', 'git-commit')
    expect(status(adapter).unit?.requiredOperations).toEqual([
      'implementation',
      'verification',
      'commit',
    ])
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
        expect(observation.after?.workspaceIdentity).toBe(
          OPERATION_SCOPE.workspaceIdentity,
        )
      }
      expect(output.metadata.hostMetadata).toBe('preserved')
      const marker = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
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
  }

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
})
