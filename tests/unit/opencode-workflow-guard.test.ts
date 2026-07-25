import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  createOpencodeWorkflowGuard,
  type OpencodeWorkflowGuard,
} from '../../src/lib/opencode-workflow-guard.js'
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

function createAdapter(
  mode: 'observe' | 'protected' | 'disabled' = 'protected',
  debug = false,
): OpencodeWorkflowGuard {
  return createOpencodeWorkflowGuard({
    config: { mode, debug },
    ...SCOPE,
  })
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

function mintReceipt(
  adapter: OpencodeWorkflowGuard,
  operation: 'implementation' | 'verification',
  sessionID = SESSION_A,
): void {
  const currentStatus = status(adapter, sessionID)
  if (!currentStatus.epoch || !currentStatus.unit) {
    throw new Error('workflow unit missing')
  }
  const callID = `${operation}-${currentStatus.epoch.epochId}-${currentStatus.unit.unitId}`
  const context = {
    epochId: currentStatus.epoch.epochId,
    unitId: currentStatus.unit.unitId,
    workspaceIdentity: 'workspace-before',
    repositoryIdentity: SCOPE.repositoryIdentity,
    worktreeIdentity: SCOPE.worktreeIdentity,
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
      workspaceIdentity: SCOPE.workspaceIdentity,
      repositoryIdentity: SCOPE.repositoryIdentity,
      worktreeIdentity: SCOPE.worktreeIdentity,
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
          event.output ?? { title: 'Loaded skill', output: '', metadata: {} },
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

  test('start and status tools are non-authoritative while control is unavailable', async () => {
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
    expect(control.output).toContain('unavailable')
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
})
