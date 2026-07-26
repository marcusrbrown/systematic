import { describe, expect, test } from 'bun:test'

import {
  createReceiptLedger,
  type ReceiptEnvelope,
  type ReceiptOperation,
} from '../../src/lib/receipt-ledger.js'
import {
  foldReceiptReadback,
  projectReceiptConsumptionMarker,
  projectReceiptMintMarker,
  projectReceiptProgressionMarker,
  type ReceiptReadbackState,
} from '../../src/lib/receipt-readback.js'
import {
  createWorkflowGuard,
  type WorkflowGuard,
} from '../../src/lib/workflow-guard.js'

const SESSION_SALT = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const EPOCH_ID = 'a'.repeat(32)
const UNIT_ID = 'b'.repeat(32)
const WORKSPACE_ID = 'workspace-current'
const REPOSITORY_ID = 'repository-current'
const WORKTREE_ID = 'worktree-current'

function createRecoveredFixture(
  progressionMode: 'active' | 'consumed' | 'completed' = 'active',
  includeRepositoryBoundary = true,
  operation: ReceiptOperation = 'implementation',
): {
  ledger: ReturnType<typeof createReceiptLedger>
  state: ReceiptReadbackState
  receipt: ReceiptEnvelope
} {
  const sourceLedger = createReceiptLedger({
    registrationIdentity: 'registration-a',
    sessionSalt: SESSION_SALT,
  })
  const context = {
    epochId: EPOCH_ID,
    unitId: UNIT_ID,
    workspaceIdentity: 'workspace-before',
    ...(includeRepositoryBoundary
      ? {
          repositoryIdentity:
            operation === 'implementation'
              ? REPOSITORY_ID
              : 'repository-before',
          worktreeIdentity:
            operation === 'implementation' ? WORKTREE_ID : 'worktree-before',
        }
      : {}),
  }
  expect(
    sourceLedger.prepareObservation({
      callId: 'call-implementation',
      operation,
      context,
    }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = sourceLedger.finalizeObservation({
    callId: 'call-implementation',
    context,
    after: {
      workspaceIdentity: WORKSPACE_ID,
      ...(includeRepositoryBoundary
        ? {
            repositoryIdentity: REPOSITORY_ID,
            worktreeIdentity: WORKTREE_ID,
          }
        : {}),
    },
    classification: {
      outcome: 'accepted',
      category: operation,
      attribution: 'runtime-verified',
      result: 'success',
      sideEffect: 'required',
      reasonCode: 'recognized-command',
    },
    terminal: { status: 'success', output: 'non-empty', noOp: false },
  })
  expect(finalized.status).toBe('finalized')
  if (finalized.status !== 'finalized') throw new Error('receipt-not-minted')
  const mint = projectReceiptMintMarker(finalized.receipt, SESSION_SALT)
  expect(mint).toBeDefined()
  if (!mint) throw new Error('mint-marker-not-projected')
  const markers = createProgressionMarkers(
    sourceLedger,
    finalized.receipt,
    progressionMode,
    operation,
  )
  const readback = [mint, ...markers]
  const recoveredLedger = createReceiptLedger({
    registrationIdentity: 'registration-a',
    sessionSalt: SESSION_SALT,
  })
  expect(recoveredLedger.recoverReadback(readback)).toMatchObject({
    status: 'recovered',
  })
  const folded = foldReceiptReadback(readback, {
    registrationDigest: recoveredLedger.metadata.registrationDigest,
    capabilityFlags: recoveredLedger.metadata.capabilityFlags,
    expectedSource: 'runtime-verified',
    sessionSalt: SESSION_SALT,
  })
  expect(folded.status).toBe('reconstructed')
  if (folded.status !== 'reconstructed') throw new Error('readback-not-folded')
  return {
    ledger: recoveredLedger,
    state: folded.state,
    receipt: finalized.receipt,
  }
}

function createProgressionMarkers(
  ledger: ReturnType<typeof createReceiptLedger>,
  receipt: ReceiptEnvelope,
  mode: 'active' | 'consumed' | 'completed',
  operation: ReceiptOperation,
) {
  const epochStart = projectReceiptProgressionMarker(ledger, {
    target: 'epoch',
    state: 'started',
    epochId: EPOCH_ID,
    family: 'work',
    transitionDigest: ledger.digestIdentity('call', 'epoch-start'),
    timestamp: 1,
  })
  const unitStart = projectReceiptProgressionMarker(ledger, {
    target: 'unit',
    state: 'started',
    epochId: EPOCH_ID,
    unitId: UNIT_ID,
    family: 'work',
    requiredOperations: [operation],
    resourceScopes: [],
    transitionDigest: ledger.digestIdentity('call', 'unit-start'),
    timestamp: 2,
  })
  const consume =
    mode === 'active'
      ? undefined
      : projectReceiptConsumptionMarker(
          receipt,
          ledger.digestIdentity('call', 'consume'),
          3,
        )
  const unitComplete =
    mode === 'completed'
      ? projectReceiptProgressionMarker(ledger, {
          target: 'unit',
          state: 'completed',
          epochId: EPOCH_ID,
          unitId: UNIT_ID,
          family: 'work',
          requiredOperations: [operation],
          resourceScopes: [],
          transitionDigest: ledger.digestIdentity('call', 'unit-complete'),
          timestamp: 4,
        })
      : undefined
  const epochComplete =
    mode === 'completed'
      ? projectReceiptProgressionMarker(ledger, {
          target: 'epoch',
          state: 'completed',
          epochId: EPOCH_ID,
          family: 'work',
          transitionDigest: ledger.digestIdentity('call', 'epoch-complete'),
          timestamp: 5,
        })
      : undefined
  if (
    !epochStart ||
    !unitStart ||
    (mode !== 'active' && !consume) ||
    (mode === 'completed' && (!unitComplete || !epochComplete))
  ) {
    throw new Error('readback-marker-not-projected')
  }
  return [
    epochStart,
    unitStart,
    ...(consume ? [consume] : []),
    ...(unitComplete ? [unitComplete] : []),
    ...(epochComplete ? [epochComplete] : []),
  ]
}

function createGuard(
  ledger: ReturnType<typeof createReceiptLedger>,
): WorkflowGuard {
  return createWorkflowGuard({
    ledger,
    workspaceIdentity: WORKSPACE_ID,
    repositoryIdentity: REPOSITORY_ID,
    worktreeIdentity: WORKTREE_ID,
    mode: 'protected',
  })
}

function createResourceRecoveredFixture(): {
  ledger: ReturnType<typeof createReceiptLedger>
  state: ReceiptReadbackState
} {
  const sourceLedger = createReceiptLedger({
    registrationIdentity: 'registration-a',
    sessionSalt: SESSION_SALT,
  })
  const context = {
    epochId: EPOCH_ID,
    unitId: UNIT_ID,
    workspaceIdentity: WORKSPACE_ID,
    repositoryIdentity: REPOSITORY_ID,
    worktreeIdentity: WORKTREE_ID,
    resourceIdentity: 'remote-before',
  }
  expect(
    sourceLedger.prepareObservation({
      callId: 'call-push',
      operation: 'push',
      context,
    }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = sourceLedger.finalizeObservation({
    callId: 'call-push',
    context,
    after: {
      workspaceIdentity: WORKSPACE_ID,
      repositoryIdentity: REPOSITORY_ID,
      worktreeIdentity: WORKTREE_ID,
      resourceIdentity: 'remote-current',
    },
    classification: {
      outcome: 'accepted',
      category: 'push',
      attribution: 'runtime-verified',
      result: 'success',
      sideEffect: 'required',
      reasonCode: 'recognized-command',
    },
    terminal: { status: 'success', output: 'non-empty', noOp: false },
  })
  expect(finalized.status).toBe('finalized')
  if (finalized.status !== 'finalized')
    throw new Error('resource-receipt-not-minted')
  const mint = projectReceiptMintMarker(finalized.receipt, SESSION_SALT)
  const epochStart = projectReceiptProgressionMarker(sourceLedger, {
    target: 'epoch',
    state: 'started',
    epochId: EPOCH_ID,
    family: 'shipping',
    transitionDigest: sourceLedger.digestIdentity('call', 'epoch-start'),
    timestamp: 1,
  })
  const unitStart = projectReceiptProgressionMarker(sourceLedger, {
    target: 'unit',
    state: 'started',
    epochId: EPOCH_ID,
    unitId: UNIT_ID,
    family: 'shipping',
    requiredOperations: ['push'],
    resourceScopes: [
      {
        operation: 'push',
        resourceIdentity: sourceLedger.digestIdentity(
          'resource',
          'remote-current',
        ),
      },
    ],
    transitionDigest: sourceLedger.digestIdentity('call', 'unit-start'),
    timestamp: 2,
  })
  expect(mint && epochStart && unitStart).toBeTruthy()
  if (!mint || !epochStart || !unitStart)
    throw new Error('resource-marker-not-projected')
  const recoveredLedger = createReceiptLedger({
    registrationIdentity: 'registration-a',
    sessionSalt: SESSION_SALT,
  })
  const markers = [epochStart, unitStart, mint]
  expect(recoveredLedger.recoverReadback(markers)).toMatchObject({
    status: 'recovered',
  })
  const folded = foldReceiptReadback(markers, {
    registrationDigest: recoveredLedger.metadata.registrationDigest,
    capabilityFlags: recoveredLedger.metadata.capabilityFlags,
    expectedSource: 'runtime-verified',
    sessionSalt: SESSION_SALT,
  })
  expect(folded.status).toBe('reconstructed')
  if (folded.status !== 'reconstructed')
    throw new Error('resource-state-not-folded')
  return { ledger: recoveredLedger, state: folded.state }
}

describe('workflow guard recovery', () => {
  test('restores exact active epoch/unit state from folded readback', () => {
    const fixture = createRecoveredFixture()
    const guard = createGuard(fixture.ledger)

    const result = guard.restore({
      provenance: 'restart',
      state: fixture.state,
    })

    expect(result).toMatchObject({ status: 'restored' })
    expect(guard.status()).toMatchObject({
      epoch: { epochId: EPOCH_ID, family: 'work', status: 'active' },
      unit: {
        unitId: UNIT_ID,
        status: 'active',
        requiredOperations: ['implementation'],
      },
    })
  })

  test('makes exact restart restore duplicate and rejects conflicting restore atomically', () => {
    const fixture = createRecoveredFixture()
    const guard = createGuard(fixture.ledger)
    const input = { provenance: 'restart', state: fixture.state } as const

    expect(guard.restore(input)).toMatchObject({ status: 'restored' })
    const before = guard.status()
    expect(guard.restore(input)).toMatchObject({ status: 'duplicate' })
    expect(guard.status()).toEqual(before)

    const conflicting = {
      ...fixture.state,
      receipts: [...fixture.state.receipts, ...fixture.state.receipts],
    }
    expect(
      guard.restore({ provenance: 'restart', state: conflicting }),
    ).toEqual({ status: 'rejected', reasonCode: 'recovery-conflict' })
    expect(guard.status()).toEqual(before)
  })

  test('rejects duplicated receipt IDs before the first restore commit', () => {
    const fixture = createRecoveredFixture()
    const guard = createGuard(fixture.ledger)
    const before = guard.status()

    expect(
      guard.restore({
        provenance: 'restart',
        state: {
          ...fixture.state,
          receipts: [...fixture.state.receipts, ...fixture.state.receipts],
        },
      }),
    ).toEqual({ status: 'rejected', reasonCode: 'invalid-recovery' })
    expect(guard.status()).toEqual(before)
  })

  test('rejects fork-copy without attaching copied state or evidence', () => {
    const fixture = createRecoveredFixture()
    const guard = createGuard(fixture.ledger)
    const before = guard.status()

    expect(
      guard.restore({ provenance: 'fork-copy', state: fixture.state }),
    ).toEqual({ status: 'rejected', reasonCode: 'fork-copy-not-lineage' })
    expect(guard.status()).toEqual(before)
  })

  test('does not reconstruct or overwrite in-flight transition state', () => {
    const fixture = createRecoveredFixture()
    const guard = createGuard(fixture.ledger)
    expect(
      guard.prepareTransition({ callId: 'pending', target: 'unit' }),
    ).toMatchObject({ status: 'unavailable' })
    const before = guard.status()

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toEqual({ status: 'rejected', reasonCode: 'recovery-conflict' })
    expect(guard.status()).toEqual(before)
  })

  test('rejects recovery identity, family, policy, and unit-scope drift atomically', () => {
    const fixture = createRecoveredFixture()
    const cases = [
      {
        ...fixture.state,
        progression: {
          ...fixture.state.progression,
          epoch: {
            ...fixture.state.progression.epoch,
            epochDigest: 'f'.repeat(64),
          },
        },
      },
      {
        ...fixture.state,
        progression: {
          ...fixture.state.progression,
          unit: {
            ...fixture.state.progression.unit,
            resourceScopes: [
              {
                operation: 'push' as const,
                resourceIdentity: 'd'.repeat(64),
              },
            ],
          },
        },
      },
      {
        ...fixture.state,
        progression: {
          ...fixture.state.progression,
          epoch: {
            ...fixture.state.progression.epoch,
            family: 'shipping' as const,
          },
        },
      },
      {
        ...fixture.state,
        progression: {
          ...fixture.state.progression,
          unit: null,
        },
      },
      {
        ...fixture.state,
        progression: {
          ...fixture.state.progression,
          unit: {
            ...fixture.state.progression.unit,
            epochId: 'c'.repeat(32),
          },
        },
      },
      {
        ...fixture.state,
        progression: {
          ...fixture.state.progression,
          unit: {
            ...fixture.state.progression.unit,
            requiredOperations: ['verification'],
          },
        },
      },
    ]

    for (const state of cases) {
      const guard = createGuard(fixture.ledger)
      const before = guard.status()
      const result = guard.restore({ provenance: 'restart', state })
      expect(result).toMatchObject({ status: 'rejected' })
      expect(guard.status()).toEqual(before)
    }
  })

  test('rejects latest-unit receipts crossing the current workspace boundary', () => {
    const fixture = createRecoveredFixture()
    const guard = createWorkflowGuard({
      ledger: fixture.ledger,
      workspaceIdentity: 'workspace-other',
      repositoryIdentity: REPOSITORY_ID,
      worktreeIdentity: WORKTREE_ID,
      mode: 'protected',
    })
    const before = guard.status()

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toEqual({ status: 'rejected', reasonCode: 'workspace-mismatch' })
    expect(guard.status()).toEqual(before)
  })

  test('does not classify repository/worktree revision drift as foreign replay', () => {
    const omitted = createRecoveredFixture('active', false)
    const omittedGuard = createGuard(omitted.ledger)
    expect(
      omittedGuard.restore({ provenance: 'restart', state: omitted.state }),
    ).toMatchObject({ status: 'restored' })

    const present = createRecoveredFixture()
    const absentGuard = createWorkflowGuard({
      ledger: present.ledger,
      workspaceIdentity: WORKSPACE_ID,
      mode: 'protected',
    })
    expect(
      absentGuard.restore({ provenance: 'restart', state: present.state }),
    ).toMatchObject({ status: 'restored' })

    const wrongGuard = createWorkflowGuard({
      ledger: present.ledger,
      workspaceIdentity: WORKSPACE_ID,
      repositoryIdentity: 'repository-other',
      worktreeIdentity: 'worktree-other',
      mode: 'protected',
    })
    expect(
      wrongGuard.restore({ provenance: 'restart', state: present.state }),
    ).toMatchObject({ status: 'restored' })
  })

  test('preserves implementation evidence across repository/worktree revision drift', () => {
    const fixture = createRecoveredFixture()
    const guard = createWorkflowGuard({
      ledger: fixture.ledger,
      workspaceIdentity: WORKSPACE_ID,
      repositoryIdentity: 'repository-new',
      worktreeIdentity: 'worktree-new',
      mode: 'protected',
    })

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toMatchObject({ status: 'restored' })
    expect(guard.status()).toMatchObject({
      state: 'protected',
      satisfiedOperations: ['implementation'],
      missingOperations: [],
    })
  })

  test('requalifies revision-dependent recovered evidence through fresh readback', () => {
    const fixture = createRecoveredFixture('active', true, 'commit')
    const guard = createWorkflowGuard({
      ledger: fixture.ledger,
      workspaceIdentity: WORKSPACE_ID,
      repositoryIdentity: 'repository-new',
      worktreeIdentity: 'worktree-new',
      mode: 'protected',
    })

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toMatchObject({ status: 'restored' })
    expect(guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'receipt-mismatch',
      repair: 'fresh-readback',
      missingOperations: ['commit'],
    })
    expect(
      guard.observeReadback({
        workspaceIdentity: WORKSPACE_ID,
        repositoryIdentity: REPOSITORY_ID,
        worktreeIdentity: WORKTREE_ID,
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(guard.status()).toMatchObject({
      state: 'protected',
      satisfiedOperations: ['commit'],
      missingOperations: [],
    })
    expect(
      guard.observeReadback({
        workspaceIdentity: WORKSPACE_ID,
        repositoryIdentity: 'repository-drift',
        worktreeIdentity: 'worktree-drift',
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'stale-receipt',
      repair: 'fresh-readback',
      missingOperations: ['commit'],
    })
  })

  test('surfaces a consumed active receipt as repairable missing evidence', () => {
    const fixture = createRecoveredFixture('consumed')
    const guard = createGuard(fixture.ledger)

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toMatchObject({ status: 'restored' })
    expect(guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'consumed-receipt',
      repair: 'fresh-readback',
      missingOperations: ['implementation'],
    })
  })

  test('restores completed state without making consumed receipts reusable', () => {
    const fixture = createRecoveredFixture('completed')
    const guard = createGuard(fixture.ledger)

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toMatchObject({ status: 'restored' })
    expect(guard.status()).toMatchObject({
      state: 'protected',
      reasonCode: 'epoch-completed',
      epoch: { status: 'completed' },
      unit: { status: 'completed' },
    })
    expect(fixture.ledger.listReceipts()[0]?.canonical.consumption).toBe(
      'consumed',
    )
    expect(guard.observeReceipt(fixture.receipt)).toEqual({
      status: 'rejected',
      reasonCode: 'unit-completed',
    })
    expect(
      guard.activate({
        event: 'guarded-skill',
        skill: 'ce-work',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'activated' })
  })

  test('keeps recovered resource evidence waiting until a fresh readback qualifies it', () => {
    const fixture = createResourceRecoveredFixture()
    const guard = createGuard(fixture.ledger)

    expect(
      guard.restore({ provenance: 'restart', state: fixture.state }),
    ).toMatchObject({ status: 'restored' })
    expect(guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'resource-mismatch',
      repair: 'fresh-readback',
      missingOperations: ['push'],
      unit: { requiredResourceOperations: ['push'] },
    })
    expect(
      guard.observeReadback({
        operation: 'push',
        workspaceIdentity: WORKSPACE_ID,
        repositoryIdentity: REPOSITORY_ID,
        worktreeIdentity: WORKTREE_ID,
        resourceIdentity: 'remote-current',
      }),
    ).toMatchObject({ status: 'accepted' })
    expect(guard.status()).toMatchObject({
      state: 'protected',
      reasonCode: 'unit-ready',
      satisfiedOperations: ['push'],
      missingOperations: [],
    })
  })
})
