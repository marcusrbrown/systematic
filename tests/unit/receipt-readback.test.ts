import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  createReceiptLedger,
  type ReceiptEnvelope,
} from '../../src/lib/receipt-ledger.js'
import {
  digestReceiptIdentity,
  extractReceiptReadbackSeed,
  filterMarkersByRegistration,
  foldReceiptReadback,
  projectReceiptConsumptionMarker,
  projectReceiptMintMarker,
  projectReceiptProgressionMarker,
  type ReceiptMarker,
  type ReceiptProgressionMarker,
  type ReceiptReadbackFailureCategory,
  receiptReadbackExpectationFromMetadata,
  validateReceiptMarker,
} from '../../src/lib/receipt-readback.js'

const SESSION_SALT = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const OTHER_SALT = Uint8Array.from({ length: 32 }, (_, index) => index + 33)
const EPOCH_ID = 'a'.repeat(32)
const UNIT_ID = 'b'.repeat(32)
const RAW_COMMAND = 'git apply private.patch'
const RAW_OUTPUT = 'private terminal output'
const RAW_PATH = '/private/repos/receipt-demo'
const OPERATION_TARGET_IDENTITY = 'c'.repeat(64)

type MintMarker = Extract<ReceiptMarker, { kind: 'mint' }>
type ConsumeMarker = Extract<
  ReceiptMarker,
  { kind: 'control'; control: 'consume' }
>
type EpochMarker = Extract<
  ReceiptMarker,
  { kind: 'control'; control: 'progression'; target: 'epoch' }
>
type UnitMarker = Extract<
  ReceiptMarker,
  { kind: 'control'; control: 'progression'; target: 'unit' }
>

interface ReceiptFixture {
  readonly ledger: ReturnType<typeof createReceiptLedger>
  readonly receipt: ReceiptEnvelope
  readonly sessionSalt: Uint8Array
  readonly mint: MintMarker
  readonly consume: ConsumeMarker
  readonly epochStart: EpochMarker
  readonly epochComplete: EpochMarker
  readonly unitStart: UnitMarker
  readonly unitComplete: UnitMarker
}

interface ReceiptFixtureOptions {
  readonly registrationIdentity?: string
  readonly capabilityFlags?: readonly string[]
  readonly sessionSalt?: Uint8Array
}

function required<T>(value: T | undefined, name: string): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error(name)
  return value
}

// `projectReceiptProgressionMarker` returns the `ReceiptProgressionMarker`
// union regardless of the input's `target` discriminant (it is not
// overloaded per-target). These helpers narrow the union to the specific
// variant the caller already knows it asked for.
function requiredEpochMarker(
  value: ReceiptProgressionMarker | undefined,
  name: string,
): EpochMarker {
  const marker = required(value, name)
  if (marker.target !== 'epoch') throw new Error(`${name}-not-epoch`)
  return marker
}

function requiredUnitMarker(
  value: ReceiptProgressionMarker | undefined,
  name: string,
): UnitMarker {
  const marker = required(value, name)
  if (marker.target !== 'unit') throw new Error(`${name}-not-unit`)
  return marker
}

function createFixture(options: ReceiptFixtureOptions = {}): ReceiptFixture {
  const sessionSalt = options.sessionSalt ?? SESSION_SALT
  const ledger = createReceiptLedger({
    registrationIdentity: options.registrationIdentity ?? 'registration-a',
    capabilityFlags: options.capabilityFlags,
    sessionSalt,
  })
  const context = {
    epochId: EPOCH_ID,
    unitId: UNIT_ID,
    workspaceIdentity: RAW_PATH,
    worktreeIdentity: 'worktree-before',
    operationTargetIdentity: OPERATION_TARGET_IDENTITY,
  }

  expect(
    ledger.prepareObservation({
      callId: RAW_COMMAND,
      operation: 'implementation',
      context,
    }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = ledger.finalizeObservation({
    callId: RAW_COMMAND,
    context,
    after: {
      workspaceIdentity: RAW_PATH,
      worktreeIdentity: 'worktree-after',
      operationTargetIdentity: OPERATION_TARGET_IDENTITY,
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
  expect(finalized.status).toBe('finalized')
  if (finalized.status !== 'finalized') throw new Error('receipt-not-minted')

  const mint = required(
    projectReceiptMintMarker(finalized.receipt, sessionSalt),
    'mint-marker-not-projected',
  )
  const transition = (identity: string) =>
    ledger.digestIdentity('call', identity)
  const epochStart = requiredEpochMarker(
    projectReceiptProgressionMarker(ledger, {
      target: 'epoch',
      state: 'started',
      epochId: EPOCH_ID,
      family: 'work',
      transitionDigest: transition('epoch-start'),
      timestamp: 1,
    }),
    'epoch-start-not-projected',
  )
  const unitStart = requiredUnitMarker(
    projectReceiptProgressionMarker(ledger, {
      target: 'unit',
      state: 'started',
      epochId: EPOCH_ID,
      unitId: UNIT_ID,
      family: 'work',
      requiredOperations: ['implementation'],
      resourceScopes: [],
      transitionDigest: transition('unit-start'),
      timestamp: 2,
    }),
    'unit-start-not-projected',
  )
  const consume = required(
    projectReceiptConsumptionMarker(
      finalized.receipt,
      transition('consume'),
      3,
    ),
    'consume-marker-not-projected',
  )
  const unitComplete = requiredUnitMarker(
    projectReceiptProgressionMarker(ledger, {
      target: 'unit',
      state: 'completed',
      epochId: EPOCH_ID,
      unitId: UNIT_ID,
      family: 'work',
      requiredOperations: ['implementation'],
      resourceScopes: [],
      transitionDigest: transition('unit-complete'),
      timestamp: 4,
    }),
    'unit-complete-not-projected',
  )
  const epochComplete = requiredEpochMarker(
    projectReceiptProgressionMarker(ledger, {
      target: 'epoch',
      state: 'completed',
      epochId: EPOCH_ID,
      family: 'work',
      transitionDigest: transition('epoch-complete'),
      timestamp: 5,
    }),
    'epoch-complete-not-projected',
  )

  return {
    ledger,
    receipt: finalized.receipt,
    sessionSalt,
    mint,
    consume,
    epochStart,
    epochComplete,
    unitStart,
    unitComplete,
  }
}

function expectationOf(fixture: ReceiptFixture) {
  return receiptReadbackExpectationFromMetadata(
    fixture.ledger.metadata,
    fixture.sessionSalt,
  )
}

function completeReadback(fixture: ReceiptFixture): readonly ReceiptMarker[] {
  return [
    fixture.epochStart,
    fixture.unitStart,
    fixture.mint,
    fixture.consume,
    fixture.unitComplete,
    fixture.epochComplete,
  ]
}

function expectCompletedReadback(
  result: ReturnType<typeof foldReceiptReadback>,
): void {
  expect(result).toMatchObject({
    status: 'reconstructed',
    state: {
      receipts: [{ canonical: { consumption: 'consumed' } }],
      progression: {
        epoch: { state: 'completed' },
        unit: { state: 'completed' },
      },
    },
  })
}

function conflictingMint(fixture: ReceiptFixture): MintMarker {
  const receipt: ReceiptEnvelope = {
    ...fixture.receipt,
    canonical: {
      ...fixture.receipt.canonical,
      timestamp: fixture.receipt.canonical.timestamp + 1,
    },
  }
  return required(
    projectReceiptMintMarker(receipt, fixture.sessionSalt),
    'conflicting-mint-not-projected',
  )
}

function legacyMintMarker(fixture: ReceiptFixture): MintMarker {
  const canonical = fixture.receipt.canonical
  const envelope: ReceiptEnvelope = {
    schemaVersion: 1,
    protocolVersion: 1,
    registrationDigest: fixture.receipt.registrationDigest,
    capabilityFlags: [...fixture.receipt.capabilityFlags],
    compatibility: 'compatible',
    canonical: {
      receiptId: canonical.receiptId,
      registrationDigest: canonical.registrationDigest,
      callDigest: canonical.callDigest,
      epochDigest: canonical.epochDigest,
      unitDigest: canonical.unitDigest,
      workspaceDigest: canonical.workspaceDigest,
      repositoryDigest: canonical.repositoryDigest,
      worktreeDigest: canonical.worktreeDigest,
      resourceDigest: canonical.resourceDigest,
      operation: canonical.operation,
      result: canonical.result,
      source: canonical.source,
      consumption: canonical.consumption,
      timestamp: canonical.timestamp,
    },
  }
  const serialized = JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    protocolVersion: envelope.protocolVersion,
    registrationDigest: envelope.registrationDigest,
    capabilityFlags: [...envelope.capabilityFlags],
    compatibility: envelope.compatibility,
    canonical: {
      receiptId: envelope.canonical.receiptId,
      registrationDigest: envelope.canonical.registrationDigest,
      callDigest: envelope.canonical.callDigest,
      epochDigest: envelope.canonical.epochDigest,
      unitDigest: envelope.canonical.unitDigest,
      workspaceDigest: envelope.canonical.workspaceDigest,
      repositoryDigest: envelope.canonical.repositoryDigest ?? null,
      worktreeDigest: envelope.canonical.worktreeDigest ?? null,
      resourceDigest: envelope.canonical.resourceDigest ?? null,
      operation: envelope.canonical.operation,
      result: envelope.canonical.result,
      source: envelope.canonical.source,
      consumption: envelope.canonical.consumption,
      timestamp: envelope.canonical.timestamp,
    },
  })
  const sessionSalt = Buffer.from(fixture.sessionSalt).toString('hex')
  return {
    kind: 'mint',
    schemaVersion: 1,
    protocolVersion: 1,
    envelope,
    sessionSalt,
    integrity: createHash('sha256')
      .update(
        `systematic/receipt-readback/mint/v1/${sessionSalt}/${serialized}`,
      )
      .digest('hex'),
  }
}

describe('receipt readback', () => {
  test('round-trips the v2 operation target identity through a mint marker', () => {
    const fixture = createFixture()

    expect(fixture.receipt.schemaVersion).toBe(2)
    expect(fixture.mint.schemaVersion).toBe(2)
    expect(fixture.mint.envelope.canonical.operationTargetIdentity).toBe(
      OPERATION_TARGET_IDENTITY,
    )
    expect(
      foldReceiptReadback([fixture.mint], expectationOf(fixture)),
    ).toMatchObject({
      status: 'reconstructed',
      state: {
        receipts: [
          {
            canonical: {
              operationTargetIdentity: OPERATION_TARGET_IDENTITY,
            },
          },
        ],
      },
    })
  })

  test('admits a valid v1 marker only as legacy parent-target evidence', () => {
    const fixture = createFixture()
    const legacy = legacyMintMarker(fixture)

    const result = foldReceiptReadback([legacy], expectationOf(fixture))

    expect(result).toMatchObject({
      status: 'reconstructed',
      state: {
        receipts: [{ canonical: { operationTargetIdentity: undefined } }],
      },
    })

    const recoveredLedger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: fixture.sessionSalt,
    })
    expect(recoveredLedger.recoverReadback([legacy])).toMatchObject({
      status: 'recovered',
      receipts: [{ canonical: { operationTargetIdentity: undefined } }],
    })
  })

  test('rejects v1 evidence when recovery expects a foreign target', () => {
    const fixture = createFixture()
    const legacy = legacyMintMarker(fixture)
    const foreignTarget = 'd'.repeat(64)

    const result = foldReceiptReadback([legacy], {
      ...expectationOf(fixture),
      operationTargetIdentity: foreignTarget,
    })

    expect(result).toEqual({
      status: 'rejected',
      category: 'identity-digest-mismatch',
    })

    const recoveredLedger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: fixture.sessionSalt,
    })
    expect(recoveredLedger.recoverReadback([legacy], foreignTarget)).toEqual({
      status: 'rejected',
      category: 'identity-digest-mismatch',
    })
  })

  test('rejects a v2 marker that omits the target identity', () => {
    const fixture = createFixture()
    const canonical = { ...fixture.mint.envelope.canonical }
    delete canonical.operationTargetIdentity

    expect(
      validateReceiptMarker({
        ...fixture.mint,
        envelope: { ...fixture.mint.envelope, canonical },
      }),
    ).toEqual({ status: 'rejected', category: 'malformed' })
  })

  test('binds target identity changes to the mint integrity digest', () => {
    const fixture = createFixture()
    const tampered = {
      ...fixture.mint,
      envelope: {
        ...fixture.mint.envelope,
        canonical: {
          ...fixture.mint.envelope.canonical,
          operationTargetIdentity: 'd'.repeat(64),
        },
      },
    }

    expect(validateReceiptMarker(tampered)).toEqual({
      status: 'rejected',
      category: 'integrity-mismatch',
    })
    const reprojected = required(
      projectReceiptMintMarker(tampered.envelope, fixture.sessionSalt),
      'tampered-marker-not-reprojected',
    )
    expect(reprojected.integrity).not.toBe(fixture.mint.integrity)
  })

  test('canonical field insertion order does not change v2 serialization integrity', () => {
    const fixture = createFixture()
    const canonical = fixture.receipt.canonical
    const reordered = {
      timestamp: canonical.timestamp,
      consumption: canonical.consumption,
      source: canonical.source,
      result: canonical.result,
      operation: canonical.operation,
      resourceDigest: canonical.resourceDigest,
      operationTargetIdentity: canonical.operationTargetIdentity,
      worktreeDigest: canonical.worktreeDigest,
      repositoryDigest: canonical.repositoryDigest,
      workspaceDigest: canonical.workspaceDigest,
      unitDigest: canonical.unitDigest,
      epochDigest: canonical.epochDigest,
      callDigest: canonical.callDigest,
      registrationDigest: canonical.registrationDigest,
      receiptId: canonical.receiptId,
    }
    const reorderedMarker = required(
      projectReceiptMintMarker(
        { ...fixture.receipt, canonical: reordered },
        fixture.sessionSalt,
      ),
      'reordered-marker-not-projected',
    )

    expect(reorderedMarker.integrity).toBe(fixture.mint.integrity)
  })

  test('hashes raw identities into opaque digests and builds a defensive expectation', () => {
    const fixture = createFixture()
    const digest = digestReceiptIdentity('workspace', RAW_PATH, SESSION_SALT)
    const expectation = expectationOf(fixture)

    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain(RAW_PATH)
    expect(expectation).toMatchObject({
      registrationDigest: fixture.ledger.metadata.registrationDigest,
      capabilityFlags: fixture.ledger.metadata.capabilityFlags,
      source: 'runtime-verified',
    })
    expect([...expectation.sessionSalt]).toEqual([...SESSION_SALT])
    expect(expectation.sessionSalt).not.toBe(SESSION_SALT)
  })

  test('validates projected mint, consumption, and progression markers directly', () => {
    const fixture = createFixture()

    for (const marker of [
      fixture.mint,
      fixture.consume,
      fixture.epochStart,
      fixture.unitStart,
    ]) {
      expect(validateReceiptMarker(marker)).toMatchObject({ status: 'valid' })
    }

    expect(validateReceiptMarker(null)).toEqual({
      status: 'rejected',
      category: 'malformed',
    })
    expect(
      validateReceiptMarker({
        kind: 'mint',
        schemaVersion: 999,
        protocolVersion: 1,
      }),
    ).toEqual({ status: 'rejected', category: 'unknown-schema' })
    expect(
      validateReceiptMarker({
        kind: 'mint',
        schemaVersion: 1,
        protocolVersion: 999,
      }),
    ).toEqual({ status: 'rejected', category: 'unknown-protocol' })
    expect(validateReceiptMarker({ kind: 'future-marker' })).toEqual({
      status: 'rejected',
      category: 'unknown-kind',
    })
    expect(
      validateReceiptMarker({ ...fixture.mint, rawCommand: RAW_COMMAND }),
    ).toEqual({ status: 'rejected', category: 'forbidden-field' })
  })

  test('persists a pinned operation target through unit progression readback', () => {
    const fixture = createFixture()
    const pinned = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation'],
        resourceScopes: [],
        pinnedOperationTargetIdentity: OPERATION_TARGET_IDENTITY,
        transitionDigest: fixture.ledger.digestIdentity('call', 'unit-pin'),
        timestamp: 6,
      }),
      'pinned-unit-marker-not-projected',
    )

    expect(pinned).toMatchObject({
      pinnedOperationTargetIdentity: OPERATION_TARGET_IDENTITY,
    })
    expect(validateReceiptMarker(pinned)).toMatchObject({ status: 'valid' })

    const result = foldReceiptReadback(
      [fixture.epochStart, fixture.unitStart, pinned],
      expectationOf(fixture),
    )
    expect(result).toMatchObject({
      status: 'reconstructed',
      state: {
        progression: {
          unit: { pinnedOperationTargetIdentity: OPERATION_TARGET_IDENTITY },
        },
      },
    })
  })

  test('round-trips a v2 remote receipt without a local operation target identity', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-remote-target',
      sessionSalt: SESSION_SALT,
    })
    const context = {
      epochId: EPOCH_ID,
      unitId: UNIT_ID,
      workspaceIdentity: RAW_PATH,
      repositoryIdentity: 'repository-before',
      resourceIdentity: 'remote-before',
    }
    expect(
      ledger.prepareObservation({
        callId: 'remote-push',
        operation: 'push',
        context,
      }),
    ).toMatchObject({ status: 'prepared' })

    const finalized = ledger.finalizeObservation({
      callId: 'remote-push',
      context,
      after: {
        workspaceIdentity: RAW_PATH,
        repositoryIdentity: 'repository-after',
        resourceIdentity: 'remote-after',
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
    if (finalized.status !== 'finalized') throw new Error('remote-not-minted')
    expect(finalized.receipt.schemaVersion).toBe(2)
    expect(finalized.receipt.canonical.operationTargetIdentity).toBeUndefined()

    const mint = required(
      projectReceiptMintMarker(finalized.receipt, SESSION_SALT),
      'remote-mint-marker-not-projected',
    )
    const result = foldReceiptReadback(
      [mint],
      receiptReadbackExpectationFromMetadata(ledger.metadata, SESSION_SALT),
    )
    expect(result).toMatchObject({
      status: 'reconstructed',
      state: {
        receipts: [
          {
            canonical: {
              operation: 'push',
            },
          },
        ],
      },
    })
    if (result.status === 'reconstructed') {
      expect(result.state.receipts[0]?.canonical).not.toHaveProperty(
        'operationTargetIdentity',
      )
    }
  })

  test('rejects a v2 local receipt marker when its operation target identity is missing', () => {
    const fixture = createFixture()
    const {
      operationTargetIdentity: _operationTargetIdentity,
      ...canonicalWithoutTarget
    } = fixture.receipt.canonical
    const missingTargetReceipt: ReceiptEnvelope = {
      ...fixture.receipt,
      canonical: canonicalWithoutTarget,
    }

    expect(
      projectReceiptMintMarker(missingTargetReceipt, SESSION_SALT),
    ).toBeUndefined()
  })

  test('folds mint, consumption, and progression markers into ordered state', () => {
    const fixture = createFixture()
    const result = foldReceiptReadback(
      completeReadback(fixture),
      expectationOf(fixture),
    )

    expect(result).toMatchObject({
      status: 'reconstructed',
      state: {
        registrationDigest: fixture.ledger.metadata.registrationDigest,
        receipts: [
          {
            canonical: {
              receiptId: fixture.receipt.canonical.receiptId,
              operation: 'implementation',
              consumption: 'consumed',
            },
          },
        ],
        progression: {
          epoch: { state: 'completed', epochId: EPOCH_ID },
          unit: {
            state: 'completed',
            epochId: EPOCH_ID,
            unitId: UNIT_ID,
            requiredOperations: ['implementation'],
            resourceScopes: [],
          },
        },
      },
    })

    const recoveredLedger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: fixture.sessionSalt,
    })
    expect(recoveredLedger.recoverReadback([fixture.mint])).toMatchObject({
      status: 'recovered',
      receipts: [
        { canonical: { operationTargetIdentity: OPERATION_TARGET_IDENTITY } },
      ],
    })
  })

  test('advances available evidence to consumed and completed state as markers arrive', () => {
    const fixture = createFixture()
    const active = foldReceiptReadback(
      [fixture.epochStart, fixture.unitStart, fixture.mint],
      expectationOf(fixture),
    )
    expect(active).toMatchObject({
      status: 'reconstructed',
      state: {
        receipts: [{ canonical: { consumption: 'available' } }],
        progression: {
          epoch: { state: 'started' },
          unit: { state: 'started' },
        },
      },
    })

    const completed = foldReceiptReadback(
      completeReadback(fixture),
      expectationOf(fixture),
    )
    expectCompletedReadback(completed)
  })

  test('treats exact duplicate readback markers as idempotent', () => {
    const fixture = createFixture()
    const result = foldReceiptReadback(
      [
        fixture.epochStart,
        fixture.epochStart,
        fixture.unitStart,
        fixture.unitStart,
        fixture.mint,
        fixture.mint,
        fixture.consume,
        fixture.consume,
        fixture.unitComplete,
        fixture.unitComplete,
        fixture.epochComplete,
        fixture.epochComplete,
      ],
      expectationOf(fixture),
    )

    expectCompletedReadback(result)
    if (result.status === 'reconstructed') {
      expect(result.state.receipts).toHaveLength(1)
    }
  })

  test('folds a same-unit monotonic started declaration extension', () => {
    const fixture = createFixture()
    const expanded = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation', 'verification'],
        resourceScopes: [],
        transitionDigest: fixture.ledger.digestIdentity(
          'call',
          'unit-start-expanded',
        ),
        timestamp: 6,
      }),
      'expanded-unit-start-not-projected',
    )

    const result = foldReceiptReadback(
      [fixture.epochStart, fixture.unitStart, expanded, fixture.mint],
      expectationOf(fixture),
    )

    expect(result).toMatchObject({
      status: 'reconstructed',
      state: {
        progression: {
          unit: {
            state: 'started',
            requiredOperations: ['implementation', 'verification'],
          },
        },
      },
    })
  })

  test('treats identical same-unit declarations as idempotent across marker metadata', () => {
    const fixture = createFixture()
    const duplicateDeclaration = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation'],
        resourceScopes: [],
        transitionDigest: fixture.ledger.digestIdentity('call', 'unit-start'),
        timestamp: 6,
      }),
      'duplicate-unit-start-not-projected',
    )

    expect(
      foldReceiptReadback(
        [fixture.epochStart, fixture.unitStart, duplicateDeclaration],
        expectationOf(fixture),
      ),
    ).toMatchObject({ status: 'reconstructed' })
  })

  test('rejects same-unit declaration growth after evidence has been minted', () => {
    const fixture = createFixture()
    const expanded = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation', 'verification'],
        resourceScopes: [],
        transitionDigest: fixture.ledger.digestIdentity(
          'call',
          'unit-start-after-evidence',
        ),
        timestamp: 6,
      }),
      'expanded-unit-start-not-projected',
    )

    expect(
      foldReceiptReadback(
        [fixture.epochStart, fixture.unitStart, fixture.mint, expanded],
        expectationOf(fixture),
      ),
    ).toEqual({ status: 'rejected', category: 'out-of-order' })
  })

  test('rejects same-unit declaration shrink and changed existing resource scope', () => {
    const fixture = createFixture()
    const expanded = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation', 'verification'],
        resourceScopes: [
          {
            operation: 'push',
            resourceIdentity: 'c'.repeat(64),
          },
        ],
        transitionDigest: fixture.ledger.digestIdentity(
          'call',
          'unit-start-expanded',
        ),
        timestamp: 6,
      }),
      'expanded-unit-start-not-projected',
    )
    const shrink = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation'],
        resourceScopes: [],
        transitionDigest: fixture.ledger.digestIdentity(
          'call',
          'unit-start-shrink',
        ),
        timestamp: 7,
      }),
      'shrink-unit-start-not-projected',
    )
    const changedScope = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation', 'verification'],
        resourceScopes: [
          {
            operation: 'push',
            resourceIdentity: 'd'.repeat(64),
          },
        ],
        transitionDigest: fixture.ledger.digestIdentity(
          'call',
          'unit-start-changed-scope',
        ),
        timestamp: 8,
      }),
      'changed-scope-unit-start-not-projected',
    )

    expect(
      foldReceiptReadback(
        [fixture.epochStart, fixture.unitStart, expanded, shrink],
        expectationOf(fixture),
      ),
    ).toEqual({ status: 'rejected', category: 'conflicting-marker' })
    expect(
      foldReceiptReadback(
        [fixture.epochStart, fixture.unitStart, expanded, changedScope],
        expectationOf(fixture),
      ),
    ).toEqual({ status: 'rejected', category: 'conflicting-marker' })
  })

  test('retains added resource scopes in the recovered progression', () => {
    const fixture = createFixture()
    const scoped = required(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'unit',
        state: 'started',
        epochId: EPOCH_ID,
        unitId: UNIT_ID,
        family: 'work',
        requiredOperations: ['implementation', 'push'],
        resourceScopes: [
          {
            operation: 'push',
            resourceIdentity: 'c'.repeat(64),
          },
        ],
        transitionDigest: fixture.ledger.digestIdentity(
          'call',
          'unit-start-scoped',
        ),
        timestamp: 6,
      }),
      'scoped-unit-start-not-projected',
    )

    const result = foldReceiptReadback(
      [fixture.epochStart, fixture.unitStart, scoped],
      expectationOf(fixture),
    )
    expect(result).toMatchObject({
      status: 'reconstructed',
      state: {
        progression: {
          unit: {
            requiredOperations: ['implementation', 'push'],
            resourceScopes: [
              { operation: 'push', resourceIdentity: 'c'.repeat(64) },
            ],
          },
        },
      },
    })
  })

  test('extracts an agreeing seed and rejects salt, registration, or capability disagreement', () => {
    const fixture = createFixture()
    const ready = extractReceiptReadbackSeed([
      fixture.epochStart,
      fixture.unitStart,
      fixture.mint,
    ])
    expect(ready).toMatchObject({
      status: 'ready',
      registrationDigest: fixture.ledger.metadata.registrationDigest,
      capabilityFlags: fixture.ledger.metadata.capabilityFlags,
    })
    if (ready.status === 'ready') {
      expect([...ready.sessionSalt]).toEqual([...SESSION_SALT])
    }

    expect(extractReceiptReadbackSeed([])).toEqual({ status: 'empty' })
    expect(extractReceiptReadbackSeed([fixture.consume])).toEqual({
      status: 'repair-required',
      category: 'missing-seed',
    })

    const disagreementFixtures = [
      createFixture({ sessionSalt: OTHER_SALT }),
      createFixture({ registrationIdentity: 'registration-b' }),
      createFixture({ capabilityFlags: ['foreign-capability'] }),
    ]
    for (const disagreement of disagreementFixtures) {
      expect(
        extractReceiptReadbackSeed([
          fixture.epochStart,
          disagreement.epochStart,
        ]),
      ).toEqual({ status: 'repair-required', category: 'conflicting-seed' })
    }
  })

  test('fails closed with bounded categories for malformed and inconsistent markers', () => {
    const fixture = createFixture()
    const foreignRegistration = createFixture({
      registrationIdentity: 'registration-b',
    })
    const foreignSalt = createFixture({ sessionSalt: OTHER_SALT })
    const foreignCapabilities = createFixture({
      capabilityFlags: ['foreign-capability'],
    })
    const cases: Array<{
      readonly name: string
      readonly inputs: readonly unknown[]
      readonly category: ReceiptReadbackFailureCategory
    }> = [
      { name: 'malformed', inputs: [null], category: 'malformed' },
      {
        name: 'unknown-schema',
        inputs: [{ ...fixture.mint, schemaVersion: 999 }],
        category: 'unknown-schema',
      },
      {
        name: 'forbidden-field',
        inputs: [{ ...fixture.mint, rawCommand: RAW_COMMAND }],
        category: 'forbidden-field',
      },
      {
        name: 'oversized',
        inputs: Array.from({ length: 129 }, () => fixture.mint),
        category: 'malformed',
      },
      {
        name: 'out-of-order',
        inputs: [fixture.epochComplete],
        category: 'out-of-order',
      },
      {
        name: 'duplicate-conflict',
        inputs: [fixture.mint, conflictingMint(fixture)],
        category: 'conflicting-marker',
      },
      {
        name: 'salt-inconsistent',
        inputs: [foreignSalt.mint],
        category: 'salt-mismatch',
      },
      {
        name: 'registration-mismatch',
        inputs: [foreignRegistration.mint],
        category: 'cross-registration',
      },
      {
        name: 'capability-disagreement',
        inputs: [foreignCapabilities.mint],
        category: 'capability-mismatch',
      },
      {
        name: 'control-before-mint',
        inputs: [fixture.consume],
        category: 'control-before-mint',
      },
      {
        name: 'missing-mint',
        inputs: [fixture.epochStart, fixture.epochComplete],
        category: 'missing-mint',
      },
      {
        name: 'inconsistent-evidence',
        inputs: [fixture.epochStart, fixture.mint, fixture.epochComplete],
        category: 'inconsistent-evidence',
      },
    ]

    for (const testCase of cases) {
      const result = foldReceiptReadback(
        testCase.inputs,
        expectationOf(fixture),
      )
      expect(result, testCase.name).toEqual({
        status: 'rejected',
        category: testCase.category,
      })
      expect(JSON.stringify(result)).not.toContain(RAW_COMMAND)
      expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT)
    }
  })

  test('rejects invalid projection inputs without returning raw values', () => {
    const fixture = createFixture()
    const consumedReceipt: ReceiptEnvelope = {
      ...fixture.receipt,
      canonical: { ...fixture.receipt.canonical, consumption: 'consumed' },
    }

    expect(
      projectReceiptMintMarker(consumedReceipt, SESSION_SALT),
    ).toBeUndefined()
    expect(
      projectReceiptConsumptionMarker(fixture.receipt, 'not-a-digest', 0),
    ).toBeUndefined()
    expect(
      projectReceiptProgressionMarker(fixture.ledger, {
        target: 'epoch',
        state: 'started',
        epochId: 'not-an-opaque-id',
        family: 'work',
        transitionDigest: fixture.ledger.digestIdentity('call', 'epoch'),
      }),
    ).toBeUndefined()
    expect(JSON.stringify(fixture.mint)).not.toContain(RAW_COMMAND)
    expect(JSON.stringify(fixture.mint)).not.toContain(RAW_OUTPUT)
  })

  test('does not mutate markers and retains only opaque values in reconstructed state', () => {
    const fixture = createFixture()
    const markers = [
      fixture.epochStart,
      fixture.unitStart,
      fixture.mint,
      fixture.consume,
      fixture.unitComplete,
      fixture.epochComplete,
    ]
    const before = structuredClone(markers)
    const result = foldReceiptReadback(markers, expectationOf(fixture))

    expect(markers).toEqual(before)
    expect(JSON.stringify(markers)).not.toContain(RAW_COMMAND)
    expect(JSON.stringify(markers)).not.toContain(RAW_OUTPUT)
    expect(JSON.stringify(markers)).not.toContain(RAW_PATH)
    expect(JSON.stringify(result)).not.toContain(RAW_COMMAND)
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT)
    expect(JSON.stringify(result)).not.toContain(RAW_PATH)
    if (result.status === 'reconstructed') {
      expect(result.state.registrationDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(result.state.receipts[0]?.canonical.callDigest).toMatch(
        /^[0-9a-f]{64}$/,
      )
      expect(result.state.receipts[0]?.canonical.operation).toBe(
        'implementation',
      )
      expect(result.state.progression.epoch?.epochId).toMatch(/^[0-9a-f]{32}$/)
      expect(result.state.progression.unit?.unitId).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  describe('filterMarkersByRegistration', () => {
    test('keeps only markers belonging to the given registrationDigest', () => {
      const own = createFixture()
      const foreign = createFixture({
        registrationIdentity: 'foreign-registration',
        sessionSalt: Uint8Array.from({ length: 32 }, (_, i) => i + 100),
      })
      const ownDigest = own.ledger.metadata.registrationDigest
      const foreignDigest = foreign.ledger.metadata.registrationDigest

      // Sanity: digests must differ
      expect(ownDigest).not.toBe(foreignDigest)

      const mixed: unknown[] = [
        own.mint,
        own.epochStart,
        own.unitStart,
        own.consume,
        own.unitComplete,
        own.epochComplete,
        foreign.mint,
        foreign.epochStart,
        foreign.unitStart,
        foreign.consume,
      ]

      const filtered = filterMarkersByRegistration(mixed, ownDigest)
      // All own markers retained
      expect(filtered).toHaveLength(6)
      // All foreign markers stripped
      for (const item of filtered) {
        const result = validateReceiptMarker(item)
        expect(result.status).toBe('valid')
        if (result.status === 'valid') {
          const marker = result.marker
          if (marker.kind === 'mint') {
            expect(marker.envelope.registrationDigest).toBe(ownDigest)
          } else {
            expect(marker.registrationDigest).toBe(ownDigest)
          }
        }
      }
    })

    test('passes through malformed/unreadable markers fail-closed (does not silently drop)', () => {
      const own = createFixture()
      const ownDigest = own.ledger.metadata.registrationDigest

      // A malformed entry: must be retained (fail-closed — caller will reject it)
      const malformed: unknown = { kind: 'mint', schemaVersion: 999 }
      const result = filterMarkersByRegistration(
        [own.mint, malformed, own.epochStart],
        ownDigest,
      )
      // malformed marker must be retained so extractReceiptReadbackSeed can fail-close on it
      expect(result).toHaveLength(3)
      expect(result[1]).toBe(malformed)
    })

    test('returns empty array when all markers are from a foreign registration', () => {
      const own = createFixture()
      const foreign = createFixture({
        registrationIdentity: 'entirely-foreign',
        sessionSalt: Uint8Array.from({ length: 32 }, (_, i) => i + 77),
      })
      const ownDigest = own.ledger.metadata.registrationDigest

      const result = filterMarkersByRegistration(
        [foreign.mint, foreign.epochStart, foreign.unitStart],
        ownDigest,
      )
      expect(result).toHaveLength(0)
    })

    test('is a no-op when all markers already belong to own registration', () => {
      const own = createFixture()
      const ownDigest = own.ledger.metadata.registrationDigest
      const ownMarkers: unknown[] = [
        own.epochStart,
        own.unitStart,
        own.mint,
        own.consume,
        own.unitComplete,
        own.epochComplete,
      ]

      const result = filterMarkersByRegistration(ownMarkers, ownDigest)
      expect(result).toHaveLength(ownMarkers.length)
      expect(result).toEqual(ownMarkers)
    })

    test('retain consume markers (no seed, but carry registrationDigest) for own registration', () => {
      const own = createFixture()
      const foreign = createFixture({
        registrationIdentity: 'another-registration',
        sessionSalt: Uint8Array.from({ length: 32 }, (_, i) => i + 55),
      })
      const ownDigest = own.ledger.metadata.registrationDigest

      // consume markers are "seedless" (no sessionSalt) but have registrationDigest
      const filtered = filterMarkersByRegistration(
        [own.consume, foreign.consume],
        ownDigest,
      )
      expect(filtered).toHaveLength(1)
      const only = validateReceiptMarker(filtered[0])
      expect(only.status).toBe('valid')
      if (only.status === 'valid' && only.marker.kind === 'control') {
        expect(only.marker.registrationDigest).toBe(ownDigest)
      }
    })

    test('progression markers (epoch + unit) are filtered by registrationDigest correctly', () => {
      const own = createFixture()
      const foreign = createFixture({
        registrationIdentity: 'progression-foreign',
        sessionSalt: Uint8Array.from({ length: 32 }, (_, i) => i + 200),
      })
      const ownDigest = own.ledger.metadata.registrationDigest

      const mixed: unknown[] = [
        own.epochStart,
        foreign.epochStart,
        own.unitStart,
        foreign.unitStart,
        own.epochComplete,
        foreign.epochComplete,
      ]
      const filtered = filterMarkersByRegistration(mixed, ownDigest)
      expect(filtered).toHaveLength(3)
    })
  })
})
