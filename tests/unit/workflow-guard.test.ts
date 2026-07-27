import { describe, expect, test } from 'bun:test'

import {
  createReceiptLedger,
  type ReceiptContext,
  type ReceiptEnvelope,
  type ReceiptOperation,
} from '../../src/lib/receipt-ledger.js'
import {
  createWorkflowGuard,
  type WorkflowGuard,
  type WorkflowGuardOptions,
} from '../../src/lib/workflow-guard.js'

const SCOPE = {
  workspaceIdentity: 'workspace-current',
  repositoryIdentity: 'repository-current',
  worktreeIdentity: 'worktree-current',
  resourceIdentity: 'resource-current',
}

const GUARD_SCOPE = {
  workspaceIdentity: SCOPE.workspaceIdentity,
  repositoryIdentity: SCOPE.repositoryIdentity,
  worktreeIdentity: SCOPE.worktreeIdentity,
}

let callSequence = 0

function createGuard(
  options: Partial<WorkflowGuardOptions> & Record<string, unknown> = {},
): {
  guard: WorkflowGuard
  ledger: ReturnType<typeof createReceiptLedger>
} {
  const ledger = createReceiptLedger({
    registrationIdentity: `registration-${++callSequence}`,
  })
  const guard = createWorkflowGuard({
    ledger,
    ...GUARD_SCOPE,
    ...options,
  } as WorkflowGuardOptions)
  return { guard, ledger }
}

function activateWork(guard: WorkflowGuard): void {
  expect(
    guard.activate({
      event: 'guarded-skill',
      skill: 'ce-work',
      outcome: 'success',
    }),
  ).toMatchObject({ status: 'activated' })
}

function startUnit(
  guard: WorkflowGuard,
  expectedOperations: readonly ReceiptOperation[] = [],
  resourceScopes: Record<string, string> = {},
) {
  const result = guard.startUnit({ expectedOperations, resourceScopes })
  expect(result.status).toBe('started')
  if (result.status !== 'started') throw new Error('unit did not start')
  return result.unit
}

function currentEpochAndUnit(guard: WorkflowGuard): {
  epochId: string
  unitId: string
} {
  const snapshot = guard.status()
  if (!snapshot.epoch || !snapshot.unit) throw new Error('guard is not active')
  return { epochId: snapshot.epoch.epochId, unitId: snapshot.unit.unitId }
}

function receiptContext(
  guard: WorkflowGuard,
  operation?: ReceiptOperation,
): ReceiptContext {
  const { epochId, unitId } = currentEpochAndUnit(guard)
  return {
    epochId,
    unitId,
    workspaceIdentity: SCOPE.workspaceIdentity,
    repositoryIdentity: 'repository-before',
    worktreeIdentity: 'worktree-before',
    ...(operation === 'push' || operation === 'pr-creation'
      ? { resourceIdentity: 'resource-before' }
      : {}),
  }
}

function mintReceiptWithContext(
  ledger: ReturnType<typeof createReceiptLedger>,
  operation: ReceiptOperation,
  context: ReceiptContext,
  after = GUARD_SCOPE,
): ReceiptEnvelope {
  const callId = `host-call-${++callSequence}`
  expect(ledger.prepareObservation({ callId, operation, context }).status).toBe(
    'prepared',
  )
  const result = ledger.finalizeObservation({
    callId,
    context,
    after,
    classification: {
      outcome: 'accepted',
      category: operation,
      attribution: 'runtime-verified',
      result: 'success',
      sideEffect:
        operation === 'implementation' ||
        operation === 'commit' ||
        operation === 'push' ||
        operation === 'pr-creation'
          ? 'required'
          : 'not-required',
      reasonCode: 'recognized-command',
    },
    terminal: { status: 'success', output: 'non-empty', noOp: false },
  })
  if (result.status !== 'finalized') throw new Error('receipt did not finalize')
  return result.receipt
}

function mintReceipt(
  guard: WorkflowGuard,
  ledger: ReturnType<typeof createReceiptLedger>,
  operation: ReceiptOperation,
  after = SCOPE,
): ReceiptEnvelope {
  const defaultAfter =
    operation === 'push' || operation === 'pr-creation' ? SCOPE : GUARD_SCOPE
  return mintReceiptWithContext(
    ledger,
    operation,
    receiptContext(guard, operation),
    after === SCOPE ? defaultAfter : after,
  )
}

function completeUnit(
  guard: WorkflowGuard,
  ledger: ReturnType<typeof createReceiptLedger>,
  expectedOperations: readonly ReceiptOperation[] = [],
  callId = `unit-transition-${++callSequence}`,
) {
  for (const operation of [
    'implementation',
    'verification',
    ...expectedOperations,
  ]) {
    guard.observeReceipt(mintReceipt(guard, ledger, operation))
  }
  const prepared = guard.prepareTransition({ callId, target: 'unit' })
  expect(prepared.status).toBe('allowed')
  if (prepared.status !== 'allowed')
    throw new Error('unit transition not allowed')
  return guard.finalizeTransition({
    callId,
    transitionId: prepared.transitionId,
  })
}

function guardWithReceipts(
  guard: WorkflowGuard,
  ledger: ReturnType<typeof createReceiptLedger>,
): void {
  guard.observeReceipt(mintReceipt(guard, ledger, 'implementation'))
  guard.observeReceipt(mintReceipt(guard, ledger, 'verification'))
}

describe('workflow guard', () => {
  test('activates on successful guarded skills, reuses work, and attaches nested shipping', () => {
    const { guard } = createGuard()

    expect(guard.status().epoch).toBeNull()
    activateWork(guard)
    const first = guard.status()
    expect(first.epoch).toMatchObject({ status: 'active' })

    expect(
      guard.activate({
        event: 'guarded-skill',
        skill: 'ce-work',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'reused' })
    expect(guard.status().epoch?.epochId).toBe(first.epoch?.epochId)

    expect(
      guard.activate({
        event: 'guarded-skill',
        skill: 'git-commit-push-pr',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'attached' })
    expect(guard.status().epoch?.epochId).toBe(first.epoch?.epochId)
  })

  test('ignores failed, unrelated, prose-only, and control-surface activation events', () => {
    const { guard } = createGuard()
    const events: unknown[] = [
      {
        event: 'guarded-skill',
        skill: 'ce-work',
        outcome: 'failure',
      },
      {
        event: 'guarded-skill',
        skill: 'merge',
        outcome: 'success',
      },
      { event: 'prose', text: 'please start ce-work', outcome: 'success' },
      { event: 'control', role: 'start-unit', outcome: 'success' },
    ]

    for (const event of events) {
      expect(guard.activate(event)).toMatchObject({ status: 'ignored' })
    }
    expect(
      guard.prepareTransition({ callId: 'inactive-call', target: 'unit' }),
    ).toMatchObject({
      status: 'unavailable',
      reasonCode: 'no-active-epoch',
    })
    expect(guard.status().epoch).toBeNull()
  })

  test('starts immutable units with mandatory minima that optional input cannot lower', () => {
    const { guard } = createGuard()
    activateWork(guard)

    const unit = startUnit(guard, ['commit', 'push'])
    expect(unit.requiredOperations).toEqual([
      'implementation',
      'verification',
      'commit',
      'push',
    ])
    expect(Object.isFrozen(unit)).toBe(true)
    expect(Object.isFrozen(unit.requiredOperations)).toBe(true)

    const scopedGuard = createGuard().guard
    activateWork(scopedGuard)
    const scopedUnit = scopedGuard.startUnit({
      resourceScopes: { push: 'remote-resource' },
    })
    expect(scopedUnit.status).toBe('started')
    if (scopedUnit.status !== 'started')
      throw new Error('scoped unit did not start')
    expect(scopedUnit.unit.requiredOperations).toContain('push')
    expect(scopedUnit.unit.requiredResourceOperations).toEqual(['push'])

    const forged = guard.startUnit({
      expectedOperations: [],
      unitId: 'model-unit',
      status: 'completed',
      consumed: ['implementation'],
    })
    expect(forged).toMatchObject({
      status: 'rejected',
      reasonCode: 'forbidden-field',
    })
  })

  test('requires matching fresh implementation and verification receipts at finalization', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)

    const implementation = mintReceipt(guard, ledger, 'implementation')
    const verification = mintReceipt(guard, ledger, 'verification')
    guard.observeReceipt(implementation)
    guard.observeReceipt(verification)
    expect(guard.status()).toMatchObject({
      state: 'protected',
      reasonCode: 'unit-ready',
    })

    const callId = 'fresh-evidence-call'
    const prepared = guard.prepareTransition({ callId, target: 'unit' })
    expect(prepared).toMatchObject({ status: 'allowed' })
    expect(
      ledger.getEnvelope(implementation.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('available')
    expect(
      ledger.getEnvelope(verification.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('available')

    if (prepared.status !== 'allowed') throw new Error('transition not allowed')
    expect(
      guard.finalizeTransition({ callId, transitionId: prepared.transitionId }),
    ).toMatchObject({ status: 'completed', target: 'unit' })
    expect(
      ledger.getEnvelope(implementation.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('consumed')
    expect(
      ledger.getEnvelope(verification.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('consumed')
    expect(guard.status().unit?.status).toBe('completed')
  })

  test('finalization replay is idempotent and does not advance twice', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    const callId = 'replay-call'
    const result = completeUnit(guard, ledger, [], callId)
    expect(result).toMatchObject({ status: 'completed', target: 'unit' })
    if (result.status !== 'completed') throw new Error('unit did not complete')

    expect(
      guard.finalizeTransition({ callId, transitionId: result.transitionId }),
    ).toMatchObject({ status: 'duplicate', target: 'unit' })
    expect(guard.status().unit?.status).toBe('completed')
  })

  test('keeps unit completion distinct from final epoch completion', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    expect(completeUnit(guard, ledger)).toMatchObject({ target: 'unit' })
    expect(guard.status().epoch?.status).toBe('active')

    const callId = 'epoch-transition-call'
    const prepared = guard.prepareTransition({ callId, target: 'epoch' })
    expect(prepared.status).toBe('allowed')
    if (prepared.status !== 'allowed')
      throw new Error('epoch transition not allowed')
    expect(
      guard.finalizeTransition({ callId, transitionId: prepared.transitionId }),
    ).toMatchObject({ status: 'completed', target: 'epoch' })
    expect(guard.status().epoch?.status).toBe('completed')

    expect(
      guard.prepareTransition({
        callId: 'completed-epoch-call',
        target: 'epoch',
      }),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'epoch-completed',
    })
    expect(
      guard.activate({
        event: 'guarded-skill',
        skill: 'ce-work',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'activated', epoch: { status: 'active' } })

    const fresh = createGuard()
    activateWork(fresh.guard)
    expect(fresh.guard.status().epoch?.epochId).not.toBe(
      guard.status().epoch?.epochId,
    )
  })

  test('status is deduplicated until evidence, progression, or control changes', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    const first = guard.status()
    const repeated = guard.status()
    expect(repeated).toEqual(first)
    expect(repeated.statusKey).toBe(first.statusKey)

    guard.observeAttempt({
      operation: 'implementation',
      outcome: 'running',
    })
    const attempted = guard.status()
    expect(attempted.statusKey).not.toBe(first.statusKey)
    expect(attempted.state).toBe('rejected')

    guard.observeReceipt(mintReceipt(guard, ledger, 'implementation'))
    expect(guard.status().statusKey).not.toBe(attempted.statusKey)
  })

  test('supports exactly one repair path and becomes unavailable without one', () => {
    const configurations: Array<{
      supportedRepairs: WorkflowGuardOptions['supportedRepairs']
      expected: string
    }> = [
      { supportedRepairs: ['fresh-readback'], expected: 'fresh-readback' },
      { supportedRepairs: ['rerun-operation'], expected: 'rerun-operation' },
      {
        supportedRepairs: ['question-attestation'],
        expected: 'unavailable',
      },
    ]

    for (const configuration of configurations) {
      const { guard } = createGuard({
        supportedRepairs: configuration.supportedRepairs,
      })
      activateWork(guard)
      startUnit(guard)
      const status = guard.status()
      expect(status.state).toBe(
        configuration.expected === 'unavailable' ? 'unavailable' : 'waiting',
      )
      if (configuration.expected === 'unavailable') {
        expect(status.reasonCode).toBe('no-supported-repair')
      } else {
        expect(status.repair).toBe(configuration.expected)
      }
    }

    const unavailable = createGuard({ supportedRepairs: [] }).guard
    activateWork(unavailable)
    startUnit(unavailable)
    expect(unavailable.status()).toMatchObject({
      state: 'unavailable',
      reasonCode: 'no-supported-repair',
    })
  })

  test('does not let optional operations substitute for mandatory or other optional operations', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard, [
      'commit',
      'push',
      'pr-creation',
      'check-readback',
      'review-readback',
    ])

    for (const operation of [
      'implementation',
      'verification',
      'commit',
    ] as const) {
      guard.observeReceipt(mintReceipt(guard, ledger, operation))
    }
    expect(guard.status()).toMatchObject({
      state: 'waiting',
      missingOperations: [
        'push',
        'pr-creation',
        'check-readback',
        'review-readback',
      ],
    })
    expect(
      guard.prepareTransition({ callId: 'optional-call', target: 'unit' }),
    ).toMatchObject({
      status: 'waiting',
      reasonCode: 'missing-evidence',
    })
  })

  test('rejects missing, stale, unrelated, failed, cancelled, running, consumed, and mismatched evidence', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)

    expect(guard.observeReceipt({})).toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-receipt',
    })

    let staleNow = Date.now()
    const staleGuard = createGuard({
      maxReceiptAgeMs: 1,
      clock: () => staleNow,
    })
    activateWork(staleGuard.guard)
    startUnit(staleGuard.guard)
    const stale = mintReceipt(
      staleGuard.guard,
      staleGuard.ledger,
      'implementation',
    )
    staleNow = Date.now() + 2
    expect(staleGuard.guard.observeReceipt(stale)).toMatchObject({
      status: 'rejected',
      reasonCode: 'stale-receipt',
    })

    const unrelated = mintReceipt(guard, ledger, 'verification')
    expect(guard.observeReceipt(unrelated)).toMatchObject({
      status: 'accepted',
      operation: 'verification',
    })
    const unrelatedOperation = mintReceipt(guard, ledger, 'commit')
    expect(guard.observeReceipt(unrelatedOperation)).toMatchObject({
      status: 'rejected',
      reasonCode: 'operation-not-required',
    })
    expect(guard.status().missingOperations).toEqual(['implementation'])

    expect(
      guard.observeAttempt({ operation: 'implementation', outcome: 'failed' }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'failed-operation' })
    expect(
      guard.observeAttempt({
        operation: 'implementation',
        outcome: 'cancelled',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'cancelled-operation' })
    expect(
      guard.observeAttempt({ operation: 'implementation', outcome: 'running' }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'running-operation' })
    expect(
      guard.observeAttempt({ operation: 'implementation', outcome: 'no-op' }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'no-op-operation' })
    expect(
      guard.observeAttempt({
        operation: 'implementation',
        outcome: 'unattributed',
      }),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'unattributed-operation',
    })

    const implementation = mintReceipt(guard, ledger, 'implementation')
    const { epochId, unitId } = currentEpochAndUnit(guard)
    expect(
      ledger.consumeReceipt(implementation.canonical.receiptId, {
        epochId,
        unitId,
        ...GUARD_SCOPE,
      }),
    ).toMatchObject({ status: 'consumed' })
    expect(guard.observeReceipt(implementation)).toMatchObject({
      status: 'rejected',
      reasonCode: 'consumed-receipt',
    })

    const other = createGuard()
    activateWork(other.guard)
    startUnit(other.guard)
    const foreign = mintReceipt(other.guard, other.ledger, 'implementation')
    expect(guard.observeReceipt(foreign)).toMatchObject({
      status: 'rejected',
      reasonCode: 'foreign-registration',
    })

    const wrongWorkspaceContext = receiptContext(guard)
    expect(
      ledger.prepareObservation({
        callId: 'wrong-workspace-call',
        operation: 'implementation',
        context: wrongWorkspaceContext,
      }),
    ).toMatchObject({ status: 'prepared' })
    const wrongWorkspace = ledger.finalizeObservation({
      callId: 'wrong-workspace-call',
      context: wrongWorkspaceContext,
      after: {
        ...SCOPE,
        workspaceIdentity: 'workspace-other',
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
    expect(wrongWorkspace).toMatchObject({
      status: 'rejected',
      reasonCode: 'workspace-mismatch',
    })

    const currentContext = receiptContext(guard)
    const wrongEpochContext = { ...currentContext, epochId: 'foreign-epoch' }
    const wrongEpoch = mintReceiptWithContext(
      ledger,
      'implementation',
      wrongEpochContext,
    )
    expect(guard.observeReceipt(wrongEpoch)).toMatchObject({
      status: 'rejected',
      reasonCode: 'receipt-mismatch',
    })

    const wrongUnitContext = { ...currentContext, unitId: 'foreign-unit' }
    const wrongUnit = mintReceiptWithContext(
      ledger,
      'implementation',
      wrongUnitContext,
    )
    expect(guard.observeReceipt(wrongUnit)).toMatchObject({
      status: 'rejected',
      reasonCode: 'receipt-mismatch',
    })
  })

  test('preparation does not consume and finalization fails closed when evidence changes', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    const implementation = mintReceipt(guard, ledger, 'implementation')
    const verification = mintReceipt(guard, ledger, 'verification')
    guard.observeReceipt(implementation)
    guard.observeReceipt(verification)
    const callId = 'fresh-state-call'
    const prepared = guard.prepareTransition({ callId, target: 'unit' })
    expect(prepared.status).toBe('allowed')
    if (prepared.status !== 'allowed') throw new Error('transition not allowed')

    const { epochId, unitId } = currentEpochAndUnit(guard)
    ledger.consumeReceipt(implementation.canonical.receiptId, {
      epochId,
      unitId,
      ...GUARD_SCOPE,
    })
    expect(
      guard.finalizeTransition({ callId, transitionId: prepared.transitionId }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'consumed-receipt' })
    expect(guard.status().unit?.status).toBe('active')
  })

  test('disabled and unavailable guards refuse guarded completion without activating', () => {
    for (const mode of ['disabled', 'unavailable'] as const) {
      const { guard } = createGuard({ mode })
      expect(
        guard.activate({
          event: 'guarded-skill',
          skill: 'ce-work',
          outcome: 'success',
        }),
      ).toMatchObject({ status: mode === 'disabled' ? 'ignored' : 'rejected' })
      expect(guard.status().state).toBe(mode)
      expect(guard.startUnit({})).toMatchObject({
        status: 'rejected',
        reasonCode: mode === 'disabled' ? 'disabled' : 'guard-unavailable',
      })
      expect(
        guard.prepareTransition({ callId: `${mode}-call`, target: 'unit' }),
      ).toMatchObject({
        status: 'rejected',
        reasonCode: mode === 'disabled' ? 'disabled' : 'guard-unavailable',
      })
    }
  })

  test('independent guards bound to independent ledgers can accept equivalent transitions', () => {
    const first = createGuard()
    const second = createGuard()
    activateWork(first.guard)
    activateWork(second.guard)
    startUnit(first.guard)
    startUnit(second.guard)

    expect(completeUnit(first.guard, first.ledger)).toMatchObject({
      status: 'completed',
    })
    expect(completeUnit(second.guard, second.ledger)).toMatchObject({
      status: 'completed',
    })
    expect(first.guard.status().state).toBe('protected')
    expect(second.guard.status().state).toBe('protected')
    expect(first.guard.status().unit?.requiredOperations).toEqual(
      second.guard.status().unit?.requiredOperations,
    )
  })

  test('one registration can reject a partial finalization without changing another', () => {
    const first = createGuard()
    const second = createGuard()
    activateWork(first.guard)
    activateWork(second.guard)
    startUnit(first.guard)
    startUnit(second.guard)

    for (const operation of ['implementation', 'verification'] as const) {
      first.guard.observeReceipt(
        mintReceipt(first.guard, first.ledger, operation),
      )
      second.guard.observeReceipt(
        mintReceipt(second.guard, second.ledger, operation),
      )
    }
    const firstCallId = 'first-registration-call'
    const secondCallId = 'second-registration-call'
    const firstPrepared = first.guard.prepareTransition({
      callId: firstCallId,
      target: 'unit',
    })
    const secondPrepared = second.guard.prepareTransition({
      callId: secondCallId,
      target: 'unit',
    })
    expect(firstPrepared.status).toBe('allowed')
    expect(secondPrepared.status).toBe('allowed')
    if (
      firstPrepared.status !== 'allowed' ||
      secondPrepared.status !== 'allowed'
    ) {
      throw new Error('transitions not prepared')
    }

    const firstScope = currentEpochAndUnit(first.guard)
    const firstImplementation = first.guard
      .status()
      .satisfiedOperations.includes('implementation')
    expect(firstImplementation).toBe(true)
    const firstReceipt = first.ledger.listReceipts()[0]
    if (!firstReceipt) throw new Error('missing first receipt')
    first.ledger.consumeReceipt(firstReceipt.canonical.receiptId, {
      ...firstScope,
      ...GUARD_SCOPE,
    })

    expect(
      first.guard.finalizeTransition({
        callId: firstCallId,
        transitionId: firstPrepared.transitionId,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'consumed-receipt' })
    expect(
      first.guard.finalizeTransition({
        callId: firstCallId,
        transitionId: firstPrepared.transitionId,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'consumed-receipt' })
    expect(
      first.guard.prepareTransition({ callId: firstCallId, target: 'unit' }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'transition-terminal' })
    expect(
      second.guard.finalizeTransition({
        callId: secondCallId,
        transitionId: secondPrepared.transitionId,
      }),
    ).toMatchObject({ status: 'completed', target: 'unit' })
    expect(first.guard.status().unit?.status).toBe('active')
    expect(second.guard.status().unit?.status).toBe('completed')
  })

  test('binds concurrent transitions to call IDs and advances at most once', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    guard.observeReceipt(mintReceipt(guard, ledger, 'implementation'))
    guard.observeReceipt(mintReceipt(guard, ledger, 'verification'))

    const first = guard.prepareTransition({
      callId: 'host-call-a',
      target: 'unit',
    })
    const second = guard.prepareTransition({
      callId: 'host-call-b',
      target: 'unit',
    })
    expect(first.status).toBe('allowed')
    expect(second.status).toBe('allowed')
    if (first.status !== 'allowed' || second.status !== 'allowed') {
      throw new Error('concurrent transitions did not prepare')
    }
    expect(
      guard.prepareTransition({ callId: 'host-call-a', target: 'unit' }),
    ).toMatchObject({ status: 'allowed', transitionId: first.transitionId })
    expect(
      guard.prepareTransition({ callId: 'host-call-a', target: 'epoch' }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'call-context-conflict' })

    expect(
      guard.finalizeTransition({
        callId: 'host-call-a',
        transitionId: first.transitionId,
      }),
    ).toMatchObject({ status: 'completed', target: 'unit' })
    expect(
      guard.finalizeTransition({
        callId: 'host-call-b',
        transitionId: second.transitionId,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'unit-completed' })
    expect(
      guard.finalizeTransition({
        callId: 'host-call-a',
        transitionId: first.transitionId,
      }),
    ).toMatchObject({ status: 'duplicate', target: 'unit' })
  })

  test('supports abandon/no-after and seals rejected finalization replay', () => {
    const abandoned = createGuard()
    activateWork(abandoned.guard)
    startUnit(abandoned.guard)
    const prepared = abandoned.guard.prepareTransition({
      callId: 'abandoned-host-call',
      target: 'unit',
    })
    expect(prepared.status).toBe('waiting')

    const ready = createGuard()
    activateWork(ready.guard)
    startUnit(ready.guard)
    guardWithReceipts(ready.guard, ready.ledger)
    const readyTransition = ready.guard.prepareTransition({
      callId: 'rejected-host-call',
      target: 'unit',
    })
    expect(readyTransition.status).toBe('allowed')
    if (readyTransition.status !== 'allowed')
      throw new Error('transition not allowed')

    expect(
      ready.guard.abandonTransition({
        callId: 'rejected-host-call',
        transitionId: readyTransition.transitionId,
      }),
    ).toMatchObject({ status: 'abandoned' })
    expect(
      ready.guard.finalizeTransition({
        callId: 'rejected-host-call',
        transitionId: readyTransition.transitionId,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'abandoned-transition' })
    expect(
      ready.guard.prepareTransition({
        callId: 'rejected-host-call',
        target: 'unit',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'abandoned-transition' })
  })

  test('mode control abandons prepared calls while preserving epoch and evidence', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    const implementation = mintReceipt(guard, ledger, 'implementation')
    const verification = mintReceipt(guard, ledger, 'verification')
    guard.observeReceipt(implementation)
    guard.observeReceipt(verification)
    const epochId = guard.status().epoch?.epochId
    const prepared = guard.prepareTransition({
      callId: 'mode-call',
      target: 'unit',
    })
    expect(prepared.status).toBe('allowed')
    if (prepared.status !== 'allowed') throw new Error('transition not allowed')

    expect(guard.setMode({ mode: 'disabled' })).toMatchObject({
      status: 'changed',
      mode: 'disabled',
    })
    expect(guard.status()).toMatchObject({ state: 'disabled' })
    expect(guard.status().epoch?.epochId).toBe(epochId)
    expect(
      guard.finalizeTransition({
        callId: 'mode-call',
        transitionId: prepared.transitionId,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'abandoned-transition' })

    expect(guard.setMode({ mode: 'protected' })).toMatchObject({
      status: 'changed',
      mode: 'protected',
    })
    expect(guard.status()).toMatchObject({
      state: 'protected',
      satisfiedOperations: ['implementation', 'verification'],
    })
  })

  test('tracks closed work/shipping families and starts a fresh epoch after completion', () => {
    const { guard, ledger } = createGuard()
    const work = guard.activate({
      event: 'guarded-skill',
      skill: 'ce-work',
      outcome: 'success',
    })
    expect(work).toMatchObject({
      status: 'activated',
      epoch: { family: 'work' },
    })
    expect(
      guard.activate({
        event: 'guarded-skill',
        skill: 'git-commit-push-pr',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'attached', epoch: { family: 'work' } })
    startUnit(guard)
    expect(completeUnit(guard, ledger)).toMatchObject({ status: 'completed' })
    const epochTransition = guard.prepareTransition({
      callId: 'complete-epoch-call',
      target: 'epoch',
    })
    expect(epochTransition.status).toBe('allowed')
    if (epochTransition.status !== 'allowed') throw new Error('epoch not ready')
    expect(
      guard.finalizeTransition({
        callId: 'complete-epoch-call',
        transitionId: epochTransition.transitionId,
      }),
    ).toMatchObject({ status: 'completed', target: 'epoch' })
    const completedEpoch = guard.status().epoch?.epochId
    const fresh = guard.activate({
      event: 'guarded-skill',
      skill: 'git-commit-push-pr',
      outcome: 'success',
    })
    expect(fresh).toMatchObject({
      status: 'activated',
      epoch: { family: 'shipping' },
    })
    expect(guard.status().epoch?.epochId).not.toBe(completedEpoch)
    expect(guard.status().unit).toBeNull()

    const shipping = createGuard()
    expect(
      shipping.guard.activate({
        event: 'guarded-skill',
        skill: 'git-commit-push-pr',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'activated', epoch: { family: 'shipping' } })
    expect(
      shipping.guard.activate({
        event: 'guarded-skill',
        skill: 'ce-work',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'family-conflict' })
  })

  test('derives repair paths from runtime eligibility, never caller repair fields', () => {
    const mandatory = createGuard({
      supportedRepairs: ['question-attestation'],
    })
    activateWork(mandatory.guard)
    startUnit(mandatory.guard)
    expect(
      mandatory.guard.observeAttempt({
        operation: 'implementation',
        outcome: 'failed',
        repair: 'question-attestation',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'invalid-receipt' })
    expect(mandatory.guard.status()).toMatchObject({
      state: 'unavailable',
      reasonCode: 'no-supported-repair',
    })

    const shipping = createGuard({
      supportedRepairs: ['question-attestation'],
      questionEligibleOperations: ['push'],
    })
    activateWork(shipping.guard)
    startUnit(shipping.guard, ['push'], { push: 'remote-resource' })
    const implementation = mintReceipt(
      shipping.guard,
      shipping.ledger,
      'implementation',
    )
    const verification = mintReceipt(
      shipping.guard,
      shipping.ledger,
      'verification',
    )
    shipping.guard.observeReceipt(implementation)
    shipping.guard.observeReceipt(verification)
    expect(shipping.guard.status()).toMatchObject({
      state: 'waiting',
      repair: 'question-attestation',
      missingOperations: ['push'],
    })
  })

  test('global incompatible evidence blocks prepare until a valid observation repairs it', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)
    guardWithReceipts(guard, ledger)
    expect(guard.observeReceipt({})).toMatchObject({ status: 'rejected' })
    expect(guard.status()).toMatchObject({ state: 'rejected' })
    expect(
      guard.prepareTransition({
        callId: 'global-dispute-call',
        target: 'unit',
      }),
    ).toMatchObject({ status: 'rejected' })
    guard.observeReceipt(mintReceipt(guard, ledger, 'implementation'))
    expect(guard.status().state).toBe('protected')
    expect(
      guard.prepareTransition({
        callId: 'global-repaired-call',
        target: 'unit',
      }),
    ).toMatchObject({ status: 'allowed' })
  })

  test('uses deterministic optional age policy and keeps default receipts long-lived', () => {
    expect(() => createGuard({ maxReceiptAgeMs: 0 })).toThrow()
    expect(() => createGuard({ maxReceiptAgeMs: -1 })).toThrow()

    const defaultGuard = createGuard()
    activateWork(defaultGuard.guard)
    startUnit(defaultGuard.guard)
    expect(
      defaultGuard.guard.observeReceipt(
        mintReceipt(defaultGuard.guard, defaultGuard.ledger, 'implementation'),
      ),
    ).toMatchObject({ status: 'accepted' })

    let now = Date.now()
    const policy = createGuard({
      clock: () => now,
      maxReceiptAgeMs: 100,
    })
    activateWork(policy.guard)
    startUnit(policy.guard)
    const receipt = mintReceipt(policy.guard, policy.ledger, 'implementation')
    now = Date.now() + 101
    expect(policy.guard.observeReceipt(receipt)).toMatchObject({
      status: 'rejected',
      reasonCode: 'stale-receipt',
    })
  })

  test('keeps resource scopes operation-specific and requires every trusted shipping operation', () => {
    const operations = [
      'commit',
      'push',
      'pr-creation',
      'check-readback',
      'review-readback',
    ] as const
    const runtimeScopes = Object.fromEntries(
      operations.map((operation) => [operation, 'remote-resource']),
    )
    const { guard, ledger } = createGuard({
      runtimeRequiredOperations: operations,
      runtimeResourceScopes: Object.fromEntries(
        Object.keys(runtimeScopes).map((operation) => [
          operation,
          'resource-current',
        ]),
      ),
    })
    activateWork(guard)
    const unit = startUnit(guard)
    expect(unit.requiredOperations).toEqual([
      'implementation',
      'verification',
      ...operations,
    ])

    guard.observeReceipt(mintReceipt(guard, ledger, 'implementation'))
    guard.observeReceipt(mintReceipt(guard, ledger, 'verification'))
    for (const operation of operations) {
      const context = {
        ...receiptContext(guard, operation),
        resourceIdentity: 'resource-before',
      }
      guard.observeReceipt(
        mintReceiptWithContext(ledger, operation, context, {
          ...SCOPE,
          resourceIdentity: 'resource-current',
        }),
      )
    }
    const prepared = guard.prepareTransition({
      callId: 'shipping-call',
      target: 'unit',
    })
    expect(prepared.status).toBe('allowed')
    if (prepared.status !== 'allowed')
      throw new Error('shipping transition not allowed')
    expect(
      guard.finalizeTransition({
        callId: 'shipping-call',
        transitionId: prepared.transitionId,
      }),
    ).toMatchObject({ status: 'completed' })
    expect(guard.status().satisfiedOperations).toEqual([
      'implementation',
      'verification',
      ...operations,
    ])
    expect(
      ledger
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(true)
  })

  test('seals a blocked prepare by call ID until a fresh host call retries', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    startUnit(guard)

    expect(
      guard.prepareTransition({ callId: 'blocked-call', target: 'unit' }),
    ).toMatchObject({ status: 'waiting', reasonCode: 'missing-evidence' })

    guard.observeReceipt(mintReceipt(guard, ledger, 'implementation'))
    guard.observeReceipt(mintReceipt(guard, ledger, 'verification'))
    expect(
      guard.prepareTransition({ callId: 'blocked-call', target: 'unit' }),
    ).toMatchObject({ status: 'waiting', reasonCode: 'missing-evidence' })
    expect(
      guard.prepareTransition({ callId: 'blocked-call', target: 'epoch' }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'call-context-conflict' })

    const fresh = guard.prepareTransition({
      callId: 'fresh-call',
      target: 'unit',
    })
    expect(fresh.status).toBe('allowed')
    if (fresh.status !== 'allowed')
      throw new Error('fresh transition not allowed')
    expect(
      guard.finalizeTransition({
        callId: 'fresh-call',
        transitionId: fresh.transitionId,
      }),
    ).toMatchObject({ status: 'completed', target: 'unit' })
  })

  test('applies trusted runtime minima and resource scopes per unit', () => {
    const { guard, ledger } = createGuard()
    activateWork(guard)
    const work = guard.startUnit(
      { expectedOperations: [] },
      { requiredOperations: [], resourceScopes: {} },
    )
    expect(work).toMatchObject({
      status: 'started',
      unit: { requiredOperations: ['implementation', 'verification'] },
    })
    guardWithReceipts(guard, ledger)
    expect(completeUnit(guard, ledger)).toMatchObject({ status: 'completed' })

    const shipping = guard.startUnit(
      { expectedOperations: [] },
      {
        requiredOperations: ['commit', 'push'],
        resourceScopes: { push: 'remote-resource' },
      },
    )
    expect(shipping).toMatchObject({
      status: 'started',
      unit: {
        requiredOperations: [
          'implementation',
          'verification',
          'commit',
          'push',
        ],
        requiredResourceOperations: ['push'],
      },
    })
    const conflict = createGuard()
    activateWork(conflict.guard)
    expect(
      conflict.guard.startUnit(
        { resourceScopes: { push: 'model-resource' } },
        {
          requiredOperations: ['push'],
          resourceScopes: { push: 'remote-resource' },
        },
      ),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'runtime-scope-conflict',
    })
  })

  test('status counts only currently qualified available evidence', () => {
    const consumed = createGuard()
    activateWork(consumed.guard)
    startUnit(consumed.guard)
    const implementation = mintReceipt(
      consumed.guard,
      consumed.ledger,
      'implementation',
    )
    consumed.guard.observeReceipt(implementation)
    consumed.guard.observeReceipt(
      mintReceipt(consumed.guard, consumed.ledger, 'verification'),
    )
    const consumedScope = currentEpochAndUnit(consumed.guard)
    consumed.ledger.consumeReceipt(implementation.canonical.receiptId, {
      ...consumedScope,
      ...GUARD_SCOPE,
    })
    expect(consumed.guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'consumed-receipt',
      satisfiedOperations: ['verification'],
      missingOperations: ['implementation'],
    })

    let now = Date.now()
    const stale = createGuard({
      maxReceiptAgeMs: 1,
      clock: () => now,
    })
    activateWork(stale.guard)
    startUnit(stale.guard)
    stale.guard.observeReceipt(
      mintReceipt(stale.guard, stale.ledger, 'implementation'),
    )
    now = Date.now() + 2
    expect(stale.guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'stale-receipt',
      satisfiedOperations: [],
      missingOperations: ['implementation', 'verification'],
    })
  })

  test('fails closed when the trusted clock throws or returns non-finite data', () => {
    const clocks: Array<() => number> = [
      () => {
        throw new Error('private clock failure')
      },
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
    ]

    for (const clock of clocks) {
      const { guard, ledger } = createGuard({ maxReceiptAgeMs: 1, clock })
      activateWork(guard)
      startUnit(guard)
      expect(
        guard.observeReceipt(mintReceipt(guard, ledger, 'implementation')),
      ).toMatchObject({
        status: 'unavailable',
        reasonCode: 'guard-unavailable',
      })
      expect(guard.status()).toMatchObject({
        state: 'unavailable',
        reasonCode: 'guard-unavailable',
      })
    }
  })
})
