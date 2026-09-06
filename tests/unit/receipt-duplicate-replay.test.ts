import { describe, expect, test } from 'bun:test'
import { createQuestionAttestation } from '../../src/lib/question-attestation.js'
import {
  createReceiptLedger,
  type ReceiptContext,
  type ReceiptEnvelope,
} from '../../src/lib/receipt-ledger.js'
import {
  foldReceiptReadback,
  projectReceiptConsumptionMarker,
  projectReceiptMintMarker,
  receiptReadbackExpectationFromMetadata,
} from '../../src/lib/receipt-readback.js'
import {
  createWorkflowGuard,
  type WorkflowGuard,
} from '../../src/lib/workflow-guard.js'

const SESSION_SALT = new Uint8Array(32).fill(9)
const SCOPE = {
  workspaceIdentity: 'workspace-current',
  repositoryIdentity: 'repository-current',
  worktreeIdentity: 'worktree-current',
}
const OPERATION_TARGET_IDENTITY = 'd'.repeat(64)

function createMintedReceipt(
  registrationIdentity = 'registration-a',
  callId = 'call-a',
): {
  ledger: ReturnType<typeof createReceiptLedger>
  context: ReceiptContext
  receipt: ReceiptEnvelope
} {
  const ledger = createReceiptLedger({
    registrationIdentity,
    sessionSalt: SESSION_SALT,
  })
  const context: ReceiptContext = {
    epochId: 'epoch-a',
    unitId: 'unit-a',
    workspaceIdentity: SCOPE.workspaceIdentity,
    repositoryIdentity: 'repository-before',
    worktreeIdentity: 'worktree-before',
    operationTargetIdentity: OPERATION_TARGET_IDENTITY,
  }
  expect(
    ledger.prepareObservation({ callId, operation: 'implementation', context }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = ledger.finalizeObservation({
    callId,
    context,
    after: { ...SCOPE, operationTargetIdentity: OPERATION_TARGET_IDENTITY },
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
  expect(finalized).toMatchObject({ status: 'finalized' })
  if (finalized.status !== 'finalized') throw new Error('receipt-not-finalized')
  return { ledger, context, receipt: finalized.receipt }
}

function createWorkflowTestGuard(): {
  guard: WorkflowGuard
  ledger: ReturnType<typeof createReceiptLedger>
} {
  const ledger = createReceiptLedger({
    registrationIdentity: 'workflow-registration',
    sessionSalt: SESSION_SALT,
  })
  const guard = createWorkflowGuard({
    ledger,
    ...SCOPE,
    mode: 'protected',
  })
  expect(
    guard.activate({
      event: 'guarded-skill',
      skill: 'ce-work',
      outcome: 'success',
    }),
  ).toMatchObject({ status: 'activated' })
  expect(guard.startUnit({ expectedOperations: [] })).toMatchObject({
    status: 'started',
  })
  return { guard, ledger }
}

function mintWorkflowEvidence(
  guard: WorkflowGuard,
  ledger: ReturnType<typeof createReceiptLedger>,
  operation: 'implementation' | 'verification',
): ReceiptEnvelope {
  const status = guard.status()
  if (!status.epoch || !status.unit) throw new Error('workflow-unit-missing')
  const context: ReceiptContext = {
    epochId: status.epoch.epochId,
    unitId: status.unit.unitId,
    workspaceIdentity: SCOPE.workspaceIdentity,
    repositoryIdentity: 'repository-before',
    worktreeIdentity:
      operation === 'implementation'
        ? 'worktree-before'
        : SCOPE.worktreeIdentity,
    operationTargetIdentity: OPERATION_TARGET_IDENTITY,
  }
  const callId = `${operation}-evidence`
  expect(
    ledger.prepareObservation({ callId, operation, context }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = ledger.finalizeObservation({
    callId,
    context,
    after: { ...SCOPE, operationTargetIdentity: OPERATION_TARGET_IDENTITY },
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
  if (finalized.status !== 'finalized')
    throw new Error('evidence-not-finalized')
  expect(guard.observeReceipt(finalized.receipt)).toMatchObject({
    status: 'accepted',
  })
  return finalized.receipt
}

describe('receipt duplicate and replay matrix', () => {
  test('mints once per call, consumes once, and folds duplicate delivery idempotently', () => {
    const original = createMintedReceipt()
    const duplicatePrepare = original.ledger.prepareObservation({
      callId: 'call-a',
      operation: 'implementation',
      context: original.context,
    })
    expect(duplicatePrepare).toMatchObject({
      status: 'duplicate',
      reasonCode: 'duplicate-finalization',
    })

    const marker = projectReceiptMintMarker(original.receipt, SESSION_SALT)
    const consumeMarker = projectReceiptConsumptionMarker(
      original.receipt,
      original.ledger.digestIdentity('call', 'unit-complete'),
      10,
    )
    expect(marker && consumeMarker).toBeTruthy()
    if (!marker || !consumeMarker) throw new Error('markers-not-projected')

    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(fresh.recoverReceipt(marker)).toMatchObject({ status: 'recovered' })
    expect(fresh.recoverReceipt(marker)).toMatchObject({ status: 'duplicate' })
    expect(fresh.recoverReadback([marker, consumeMarker])).toMatchObject({
      status: 'recovered',
    })
    expect(fresh.recoverReadback([marker, consumeMarker])).toMatchObject({
      status: 'duplicate',
    })

    const consumed = original.ledger.consumeReceipt(
      original.receipt.canonical.receiptId,
      { ...original.context, ...SCOPE },
    )
    expect(consumed).toMatchObject({ status: 'consumed' })
    expect(
      original.ledger.consumeReceipt(original.receipt.canonical.receiptId, {
        ...original.context,
        ...SCOPE,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'already-consumed' })
  })

  test('distinguishes conflicting-marker, unknown-receipt, and cross-registration replay controls', () => {
    const original = createMintedReceipt()
    const marker = projectReceiptMintMarker(original.receipt, SESSION_SALT)
    expect(marker).toBeDefined()
    if (!marker) throw new Error('marker-not-projected')

    const conflictingEnvelope: ReceiptEnvelope = {
      ...original.receipt,
      canonical: {
        ...original.receipt.canonical,
        timestamp: original.receipt.canonical.timestamp + 1,
      },
    }
    const conflictingMarker = projectReceiptMintMarker(
      conflictingEnvelope,
      SESSION_SALT,
    )
    expect(conflictingMarker).toBeDefined()
    if (!conflictingMarker) throw new Error('conflicting-marker-not-projected')
    expect(
      foldReceiptReadback(
        [marker, conflictingMarker],
        receiptReadbackExpectationFromMetadata(
          original.ledger.metadata,
          SESSION_SALT,
        ),
      ),
    ).toMatchObject({ status: 'rejected', category: 'conflicting-marker' })

    expect(
      original.ledger.consumeReceipt('f'.repeat(32), original.context),
    ).toMatchObject({ status: 'rejected', reasonCode: 'unknown-receipt' })

    const foreign = createReceiptLedger({
      registrationIdentity: 'registration-b',
      sessionSalt: SESSION_SALT,
    })
    expect(foreign.recoverReceipt(marker)).toMatchObject({
      status: 'rejected',
      category: 'cross-registration',
    })
  })

  test('workflow transition finalization replay does not consume or advance twice', () => {
    const { guard, ledger } = createWorkflowTestGuard()
    mintWorkflowEvidence(guard, ledger, 'implementation')
    mintWorkflowEvidence(guard, ledger, 'verification')

    const prepared = guard.prepareTransition({
      callId: 'transition-call',
      target: 'unit',
    })
    expect(prepared).toMatchObject({ status: 'allowed' })
    if (prepared.status !== 'allowed') throw new Error('transition-not-allowed')
    const completed = guard.finalizeTransition({
      callId: 'transition-call',
      transitionId: prepared.transitionId,
    })
    expect(completed).toMatchObject({ status: 'completed', target: 'unit' })
    if (completed.status !== 'completed')
      throw new Error('transition-not-completed')
    expect(
      guard.finalizeTransition({
        callId: 'transition-call',
        transitionId: completed.transitionId,
      }),
    ).toMatchObject({ status: 'duplicate', target: 'unit' })
    expect(guard.status().unit?.status).toBe('completed')
    expect(
      ledger
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(true)
  })

  test('replayed question request IDs are rejected after one correlated reply', () => {
    const machine = createQuestionAttestation({ clock: () => 99 })
    const first = machine.challenge({
      sessionId: 'session-a',
      resource: 'resource-a',
      transition: 'unit-complete',
      purpose: 'transition',
    })
    expect(first.status).toBe('pending')
    if (first.status !== 'pending') throw new Error('challenge-not-created')
    expect(
      machine.bindAsked({
        challengeId: first.challenge.challengeId,
        callId: 'question-call-a',
        requestId: 'request-1',
      }),
    ).toMatchObject({ status: 'bound' })
    expect(
      machine.observeReply({
        sessionId: 'session-a',
        requestId: 'request-1',
        answer: 'yes',
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(
      machine.observeReply({
        sessionId: 'session-a',
        requestId: 'request-1',
        answer: 'yes',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'replay' })

    const second = machine.challenge({
      sessionId: 'session-a',
      resource: 'resource-b',
      transition: 'unit-complete',
      purpose: 'transition',
    })
    expect(second.status).toBe('pending')
    if (second.status !== 'pending')
      throw new Error('second-challenge-not-created')
    expect(
      machine.bindAsked({
        challengeId: second.challenge.challengeId,
        callId: 'question-call-b',
        requestId: 'request-1',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'replay' })
  })
})
