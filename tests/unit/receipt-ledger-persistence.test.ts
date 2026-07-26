import { describe, expect, test } from 'bun:test'

import {
  createReceiptLedger,
  type ReceiptClassification,
  type ReceiptContext,
  type ReceiptEnvelope,
} from '../../src/lib/receipt-ledger.js'
import {
  extractReceiptReadbackSeed,
  foldReceiptReadback,
  projectReceiptConsumptionMarker,
  projectReceiptMintMarker,
  projectReceiptProgressionMarker,
  type ReceiptMarker,
  receiptReadbackExpectationFromMetadata,
} from '../../src/lib/receipt-readback.js'

const SESSION_SALT = Uint8Array.from({ length: 32 }, (_, index) => index)
const RAW_COMMAND = 'git apply private.patch'
const RAW_OUTPUT = 'private terminal output'
const RAW_PATH = '/private/repos/receipt-demo'

interface MintedReceipt {
  ledger: ReturnType<typeof createReceiptLedger>
  receipt: ReceiptEnvelope
  marker: ReceiptMarker
  afterContext: ReceiptContext
}

interface ProgressionInput {
  readonly target: 'epoch' | 'unit'
  readonly state: 'started' | 'completed'
  readonly epochDigest: string
  readonly unitDigest?: string
  readonly transitionDigest: string
  readonly timestamp?: number
}

function opaqueIdentity(label: string): string {
  if (label === 'epoch-1' || label === 'unit-1') return '1'.repeat(32)
  if (label === 'epoch-a') return 'a'.repeat(32)
  if (label === 'epoch-b') return 'b'.repeat(32)
  if (label === 'unit-2') return '2'.repeat(32)
  return 'c'.repeat(32)
}

function createMintedReceipt(
  registrationIdentity = 'registration-a',
  epochId = 'epoch-1',
  unitId = 'unit-1',
  callId = 'call-1',
): MintedReceipt {
  const ledger = createReceiptLedger({
    registrationIdentity,
    sessionSalt: SESSION_SALT,
  })
  const beforeContext: ReceiptContext = {
    epochId: opaqueIdentity(epochId),
    unitId: opaqueIdentity(unitId),
    workspaceIdentity: 'workspace-before',
  }
  const afterContext: ReceiptContext = {
    epochId: opaqueIdentity(epochId),
    unitId: opaqueIdentity(unitId),
    workspaceIdentity: 'workspace-after',
  }
  const classification: ReceiptClassification = {
    outcome: 'accepted',
    category: 'implementation',
    attribution: 'runtime-verified',
    result: 'success',
    sideEffect: 'required',
    reasonCode: 'recognized-command',
  }

  expect(
    ledger.prepareObservation({
      callId,
      operation: 'implementation',
      context: beforeContext,
    }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = ledger.finalizeObservation({
    callId,
    context: beforeContext,
    after: { workspaceIdentity: afterContext.workspaceIdentity },
    classification,
    terminal: { status: 'success', output: 'non-empty', noOp: false },
  })
  expect(finalized.status).toBe('finalized')
  if (finalized.status !== 'finalized') throw new Error('receipt-not-minted')

  const marker = projectReceiptMintMarker(finalized.receipt, SESSION_SALT)
  expect(marker).toBeDefined()
  if (!marker) throw new Error('mint-marker-not-projected')
  return {
    ledger,
    receipt: finalized.receipt,
    marker,
    afterContext,
  }
}

function expectation(ledger: ReturnType<typeof createReceiptLedger>) {
  return receiptReadbackExpectationFromMetadata(ledger.metadata, SESSION_SALT)
}

function transitionDigest(
  ledger: ReturnType<typeof createReceiptLedger>,
  identity: string,
): string {
  return ledger.digestIdentity('call', identity)
}

function progressionMarker(
  ledger: ReturnType<typeof createReceiptLedger>,
  input: ProgressionInput,
) {
  const epochCandidates = ['epoch-1', 'epoch-a', 'epoch-b']
  const epochId = epochCandidates.find(
    (candidate) =>
      ledger.digestIdentity('epoch', opaqueIdentity(candidate)) ===
      input.epochDigest,
  )
  if (!epochId) return undefined
  if (input.target === 'epoch') {
    return projectReceiptProgressionMarker(ledger, {
      target: 'epoch',
      state: input.state,
      epochId: opaqueIdentity(epochId),
      family: 'work',
      transitionDigest: input.transitionDigest,
      timestamp: input.timestamp,
    })
  }
  const unitCandidates = ['unit-1', 'unit-2']
  const unitId = unitCandidates.find(
    (candidate) =>
      ledger.digestIdentity('unit', opaqueIdentity(candidate)) ===
      input.unitDigest,
  )
  if (!unitId) return undefined
  return projectReceiptProgressionMarker(ledger, {
    target: 'unit',
    state: input.state,
    epochId: opaqueIdentity(epochId),
    unitId: opaqueIdentity(unitId),
    family: 'work',
    requiredOperations: ['implementation'],
    resourceScopes: [],
    transitionDigest: input.transitionDigest,
    timestamp: input.timestamp,
  })
}

function projectRestartProgression(
  source: Parameters<typeof projectReceiptProgressionMarker>[0],
  input: Parameters<typeof projectReceiptProgressionMarker>[1],
) {
  return projectReceiptProgressionMarker(source, input)
}

describe('receipt persistence readback', () => {
  test('reconstructs an exact receipt into a fresh same-registration ledger', () => {
    const original = createMintedReceipt()
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })

    const folded = foldReceiptReadback([original.marker], expectation(fresh))
    expect(folded).toMatchObject({ status: 'reconstructed' })
    expect(fresh.recoverReadback([original.marker])).toMatchObject({
      status: 'recovered',
    })
    expect(fresh.getEnvelope(original.receipt.canonical.receiptId)).toEqual(
      original.receipt,
    )
    expect(
      folded.status === 'reconstructed' ? folded.state.receipts : [],
    ).toEqual([original.receipt])
  })

  test('recovers an available receipt and consumes it exactly once', () => {
    const original = createMintedReceipt()
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    fresh.recoverReadback([original.marker])

    expect(
      fresh.consumeReceipt(
        original.receipt.canonical.receiptId,
        original.afterContext,
      ),
    ).toMatchObject({ status: 'consumed' })
    expect(
      fresh.consumeReceipt(
        original.receipt.canonical.receiptId,
        original.afterContext,
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'already-consumed' })
  })

  test('recovers consumed state and keeps it consumed', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'transition-consume'),
      10,
    )
    expect(consume).toBeDefined()
    if (!consume) throw new Error('consume-marker-not-projected')

    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const recovered = fresh.recoverReadback([original.marker, consume])
    expect(recovered).toMatchObject({ status: 'recovered' })
    expect(
      fresh.getEnvelope(original.receipt.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('consumed')
    expect(
      fresh.consumeReceipt(
        original.receipt.canonical.receiptId,
        original.afterContext,
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'already-consumed' })
  })

  test('folds ordered consume, unit, and epoch progression markers', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'transition-consume'),
      10,
    )
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 11,
    })
    const unitComplete = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-complete'),
      timestamp: 12,
    })
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 13,
    })
    const epochComplete = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-complete'),
      timestamp: 14,
    })
    expect(
      consume && unitStart && unitComplete && epochStart && epochComplete,
    ).toBeTruthy()
    if (
      !consume ||
      !unitStart ||
      !unitComplete ||
      !epochStart ||
      !epochComplete
    )
      throw new Error('control-marker-not-projected')

    const folded = foldReceiptReadback(
      [
        original.marker,
        consume,
        epochStart,
        unitStart,
        unitComplete,
        epochComplete,
      ],
      expectation(original.ledger),
    )
    expect(folded).toMatchObject({
      status: 'reconstructed',
      state: {
        progression: {
          unit: { state: 'completed' },
          epoch: { state: 'completed' },
        },
      },
    })
    if (folded.status !== 'reconstructed') throw new Error('fold-failed')
    expect(folded.state.receipts[0]?.canonical.consumption).toBe('consumed')
  })

  test('treats repeated readback and marker delivery as idempotent', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'transition-consume'),
      10,
    )
    expect(consume).toBeDefined()
    if (!consume) throw new Error('consume-marker-not-projected')

    const folded = foldReceiptReadback(
      [original.marker, original.marker, consume, consume],
      expectation(original.ledger),
    )
    expect(folded).toMatchObject({ status: 'reconstructed' })
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(fresh.recoverReadback([original.marker, consume])).toMatchObject({
      status: 'recovered',
    })
    expect(fresh.recoverReadback([original.marker, consume])).toMatchObject({
      status: 'duplicate',
    })
  })

  test('bootstraps a ready seed and exact progression state before the first mint', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const epochMarker = projectRestartProgression(ledger, {
      target: 'epoch',
      state: 'started',
      epochId: 'a'.repeat(32),
      family: 'work',
      transitionDigest: transitionDigest(ledger, 'epoch-start'),
      timestamp: 1,
    })
    const unitMarker = projectRestartProgression(ledger, {
      target: 'unit',
      state: 'started',
      epochId: 'a'.repeat(32),
      unitId: 'b'.repeat(32),
      family: 'work',
      requiredOperations: ['implementation'],
      resourceScopes: [],
      transitionDigest: transitionDigest(ledger, 'unit-start'),
      timestamp: 2,
    })
    expect(epochMarker && unitMarker).toBeTruthy()
    if (!epochMarker || !unitMarker)
      throw new Error('progression-marker-not-projected')

    expect(extractReceiptReadbackSeed([epochMarker, unitMarker])).toMatchObject(
      {
        status: 'ready',
        registrationDigest: ledger.metadata.registrationDigest,
        capabilityFlags: ledger.metadata.capabilityFlags,
      },
    )
    expect(
      foldReceiptReadback([epochMarker, unitMarker], expectation(ledger)),
    ).toMatchObject({
      status: 'reconstructed',
      state: {
        receipts: [],
        progression: {
          epoch: { epochId: 'a'.repeat(32), family: 'work' },
          unit: {
            epochId: 'a'.repeat(32),
            unitId: 'b'.repeat(32),
            requiredOperations: ['implementation'],
            resourceScopes: [],
          },
        },
      },
    })
  })

  test('rejects a valid-integrity marker whose identity digest relation is wrong', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const invalidDigestSource = {
      metadata: ledger.metadata,
      getSessionSalt: () => ledger.getSessionSalt(),
      digestIdentity: () => 'f'.repeat(64),
    }
    const marker = projectRestartProgression(invalidDigestSource, {
      target: 'epoch',
      state: 'started',
      epochId: 'a'.repeat(32),
      family: 'work',
      transitionDigest: transitionDigest(ledger, 'epoch-start'),
      timestamp: 1,
    })
    expect(marker).toBeDefined()
    if (!marker) throw new Error('progression-marker-not-projected')
    expect(foldReceiptReadback([marker], expectation(ledger))).toMatchObject({
      status: 'rejected',
      category: 'identity-digest-mismatch',
    })
  })

  test('rejects missing or non-hex internal IDs and resource scopes without echoing them', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const missingId = projectRestartProgression(ledger, {
      target: 'epoch',
      state: 'started',
      epochId: '',
      family: 'work',
      transitionDigest: transitionDigest(ledger, 'epoch-start'),
      timestamp: 1,
    })
    const nonHexResource = projectRestartProgression(ledger, {
      target: 'unit',
      state: 'started',
      epochId: 'a'.repeat(32),
      unitId: 'b'.repeat(32),
      family: 'work',
      requiredOperations: ['implementation'],
      resourceScopes: [
        { operation: 'implementation', resourceIdentity: 'not-opaque' },
      ],
      transitionDigest: transitionDigest(ledger, 'unit-start'),
      timestamp: 2,
    })
    expect(missingId).toBeUndefined()
    expect(nonHexResource).toBeUndefined()
    expect(String(missingId)).not.toContain('epochId')
    expect(String(nonHexResource)).not.toContain('not-opaque')
  })

  test('rejects declaration drift and seed disagreement atomically', () => {
    const first = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const second = createReceiptLedger({
      registrationIdentity: 'registration-b',
      sessionSalt: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    })
    const started = projectRestartProgression(first, {
      target: 'epoch',
      state: 'started',
      epochId: 'a'.repeat(32),
      family: 'work',
      transitionDigest: transitionDigest(first, 'epoch-start'),
      timestamp: 1,
    })
    const drifted = projectRestartProgression(first, {
      target: 'epoch',
      state: 'completed',
      epochId: 'a'.repeat(32),
      family: 'shipping',
      transitionDigest: transitionDigest(first, 'epoch-complete'),
      timestamp: 2,
    })
    const foreign = projectRestartProgression(second, {
      target: 'epoch',
      state: 'started',
      epochId: 'a'.repeat(32),
      family: 'work',
      transitionDigest: transitionDigest(second, 'epoch-start'),
      timestamp: 1,
    })
    expect(started && drifted && foreign).toBeTruthy()
    if (!started || !drifted || !foreign)
      throw new Error('progression-marker-not-projected')

    expect(
      foldReceiptReadback([started, drifted], expectation(first)),
    ).toMatchObject({ status: 'rejected', category: 'conflicting-marker' })
    expect(extractReceiptReadbackSeed([started, foreign])).toMatchObject({
      status: 'repair-required',
      category: 'conflicting-seed',
    })
  })

  test('requires a seed for consumption-only readback', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume'),
      1,
    )
    expect(consume).toBeDefined()
    if (!consume) throw new Error('consume-marker-not-projected')
    expect(extractReceiptReadbackSeed([consume])).toMatchObject({
      status: 'repair-required',
      category: 'missing-seed',
    })
  })

  test('treats an unchanged started progression full readback as duplicate', () => {
    const original = createMintedReceipt()
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 10,
    })
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 11,
    })
    expect(epochStart && unitStart).toBeTruthy()
    if (!epochStart || !unitStart)
      throw new Error('progression-marker-not-projected')

    const fullReadback = [epochStart, unitStart, original.marker]
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(fresh.recoverReadback(fullReadback)).toMatchObject({
      status: 'recovered',
    })
    const before = fresh.getProgressionState()
    expect(fresh.recoverReadback(fullReadback)).toMatchObject({
      status: 'duplicate',
    })
    expect(fresh.getProgressionState()).toEqual(before)
  })

  test('treats an unchanged completed progression full readback as duplicate', () => {
    const original = createMintedReceipt()
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 10,
    })
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 11,
    })
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume'),
      12,
    )
    const unitComplete = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-complete'),
      timestamp: 13,
    })
    const epochComplete = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-complete'),
      timestamp: 14,
    })
    expect(
      epochStart && unitStart && consume && unitComplete && epochComplete,
    ).toBeTruthy()
    if (
      !epochStart ||
      !unitStart ||
      !consume ||
      !unitComplete ||
      !epochComplete
    )
      throw new Error('progression-marker-not-projected')

    const fullReadback = [
      epochStart,
      unitStart,
      original.marker,
      consume,
      unitComplete,
      epochComplete,
    ]
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(fresh.recoverReadback(fullReadback)).toMatchObject({
      status: 'recovered',
    })
    const before = fresh.getProgressionState()
    expect(fresh.recoverReadback(fullReadback)).toMatchObject({
      status: 'duplicate',
    })
    expect(fresh.getProgressionState()).toEqual(before)
  })

  test('rejects same progression identity and state with a different transition', () => {
    const original = createMintedReceipt()
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 10,
    })
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 11,
    })
    const conflictingUnitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start-2'),
      timestamp: 12,
    })
    expect(epochStart && unitStart && conflictingUnitStart).toBeTruthy()
    if (!epochStart || !unitStart || !conflictingUnitStart)
      throw new Error('progression-marker-not-projected')

    expect(
      foldReceiptReadback(
        [epochStart, unitStart, conflictingUnitStart],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'conflicting-marker' })
  })

  test('rejects missing, malformed, and control-before-mint evidence', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'transition-consume'),
      10,
    )
    expect(consume).toBeDefined()
    if (!consume) throw new Error('consume-marker-not-projected')

    expect(foldReceiptReadback([], expectation(original.ledger))).toMatchObject(
      {
        status: 'reconstructed',
        state: { receipts: [] },
      },
    )
    expect(
      foldReceiptReadback([null], expectation(original.ledger)),
    ).toMatchObject({ status: 'rejected', category: 'malformed' })
    expect(
      foldReceiptReadback([consume], expectation(original.ledger)),
    ).toMatchObject({
      status: 'rejected',
      category: 'control-before-mint',
    })
  })

  test('rejects unknown schema, protocol, capability, and conflicting markers', () => {
    const original = createMintedReceipt()
    expect(
      foldReceiptReadback(
        [{ ...original.marker, schemaVersion: 999 }],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'unknown-schema' })
    expect(
      foldReceiptReadback(
        [{ ...original.marker, protocolVersion: 999 }],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'unknown-protocol' })
    expect(
      foldReceiptReadback([original.marker], {
        ...expectation(original.ledger),
        capabilityFlags: ['foreign-capability'],
      }),
    ).toMatchObject({ status: 'rejected', category: 'capability-mismatch' })

    const conflictingReceipt: ReceiptEnvelope = {
      ...original.receipt,
      canonical: {
        ...original.receipt.canonical,
        timestamp: original.receipt.canonical.timestamp + 1,
      },
    }
    const conflictingMarker = projectReceiptMintMarker(
      conflictingReceipt,
      SESSION_SALT,
    )
    expect(conflictingMarker).toBeDefined()
    if (!conflictingMarker) throw new Error('conflicting-marker-not-projected')
    expect(
      foldReceiptReadback(
        [original.marker, conflictingMarker],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'conflicting-marker' })
  })

  test('rejects out-of-order and conflicting control markers', () => {
    const original = createMintedReceipt()
    const start = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 10,
    })
    const complete = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-complete'),
      timestamp: 11,
    })
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume-a'),
      12,
    )
    const otherConsume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume-b'),
      13,
    )
    expect(start && complete && consume && otherConsume).toBeTruthy()
    if (!start || !complete || !consume || !otherConsume)
      throw new Error('control-marker-not-projected')

    expect(
      foldReceiptReadback(
        [original.marker, complete, start],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'progression-mismatch' })
    expect(
      foldReceiptReadback(
        [original.marker, consume, otherConsume],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'conflicting-marker' })
  })

  test('rejects tampered envelope and receipt identity without echoing input', () => {
    const original = createMintedReceipt()
    const tampered = {
      ...original.marker,
      envelope: {
        ...original.receipt,
        canonical: {
          ...original.receipt.canonical,
          receiptId: 'f'.repeat(32),
        },
      },
    }
    const result = foldReceiptReadback([tampered], expectation(original.ledger))
    expect(result).toMatchObject({
      status: 'rejected',
      category: 'integrity-mismatch',
    })
    expect(JSON.stringify(result)).not.toContain('f'.repeat(32))
  })

  test('rejects forbidden and raw-shaped marker fields without persistence leakage', () => {
    const original = createMintedReceipt()
    const rawShaped = {
      ...original.marker,
      rawCommand: RAW_COMMAND,
      terminalOutput: RAW_OUTPUT,
      repositoryPath: RAW_PATH,
    }
    const result = foldReceiptReadback(
      [rawShaped],
      expectation(original.ledger),
    )
    expect(result).toMatchObject({
      status: 'rejected',
      category: 'forbidden-field',
    })
    expect(JSON.stringify(result)).not.toContain(RAW_COMMAND)
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT)
    expect(JSON.stringify(result)).not.toContain(RAW_PATH)
    expect(JSON.stringify(original.marker)).not.toContain(RAW_COMMAND)
    expect(JSON.stringify(original.marker)).not.toContain(RAW_OUTPUT)
    expect(JSON.stringify(original.marker)).not.toContain(RAW_PATH)
  })

  test('does not mutate input markers while folding', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'transition-consume'),
      10,
    )
    expect(consume).toBeDefined()
    if (!consume) throw new Error('consume-marker-not-projected')
    const markers = [original.marker, consume]
    const before = structuredClone(markers)

    foldReceiptReadback(markers, expectation(original.ledger))

    expect(markers).toEqual(before)
  })

  test('keeps registrations independent and rejects foreign imports', () => {
    const first = createMintedReceipt('registration-a')
    const second = createMintedReceipt('registration-b')
    const firstLedger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const secondLedger = createReceiptLedger({
      registrationIdentity: 'registration-b',
      sessionSalt: SESSION_SALT,
    })

    expect(firstLedger.recoverReadback([first.marker])).toMatchObject({
      status: 'recovered',
    })
    expect(secondLedger.recoverReadback([second.marker])).toMatchObject({
      status: 'recovered',
    })
    expect(firstLedger.recoverReadback([second.marker])).toMatchObject({
      status: 'rejected',
      category: 'cross-registration',
    })
    expect(secondLedger.recoverReadback([first.marker])).toMatchObject({
      status: 'rejected',
      category: 'cross-registration',
    })
    expect(
      firstLedger.getEnvelope(second.receipt.canonical.receiptId),
    ).toBeUndefined()
    expect(
      secondLedger.getEnvelope(first.receipt.canonical.receiptId),
    ).toBeUndefined()
  })

  test('retains progression state through ledger recovery without exposing salt', () => {
    const original = createMintedReceipt()
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 9,
    })
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 10,
    })
    const progression = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-complete'),
      timestamp: 11,
    })
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume'),
      12,
    )
    expect(epochStart && unitStart && progression && consume).toBeTruthy()
    if (!epochStart || !unitStart || !progression || !consume)
      throw new Error('progression-marker-not-projected')

    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(
      fresh.recoverReadback([
        epochStart,
        unitStart,
        original.marker,
        consume,
        progression,
      ]),
    ).toMatchObject({
      status: 'recovered',
      progression: { unit: { state: 'completed' } },
    })
    expect(fresh.getProgressionState()).toMatchObject({
      unit: { state: 'completed' },
    })
    expect(JSON.stringify(fresh.getProgressionState())).not.toContain(
      Buffer.from(SESSION_SALT).toString('hex'),
    )
  })

  test('does not regress consumed or completed state on partial replay', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume'),
      10,
    )
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 9,
    })
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 10,
    })
    const complete = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest: original.receipt.canonical.epochDigest,
      unitDigest: original.receipt.canonical.unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-complete'),
      timestamp: 11,
    })
    expect(epochStart && unitStart && consume && complete).toBeTruthy()
    if (!epochStart || !unitStart || !consume || !complete)
      throw new Error('control-marker-not-projected')

    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(
      fresh.recoverReadback([
        epochStart,
        unitStart,
        original.marker,
        consume,
        complete,
      ]),
    ).toMatchObject({
      status: 'recovered',
    })
    expect(fresh.recoverReadback([original.marker])).toMatchObject({
      status: 'rejected',
      category: 'progression-mismatch',
    })
  })

  test('folds epoch and unit starts before any receipt exists', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    const epochDigest = ledger.digestIdentity(
      'epoch',
      opaqueIdentity('epoch-a'),
    )
    const unitDigest = ledger.digestIdentity('unit', opaqueIdentity('unit-1'))
    const epochStarted = progressionMarker(ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest,
      transitionDigest: transitionDigest(ledger, 'epoch-a-start'),
      timestamp: 1,
    })
    const unitStarted = progressionMarker(ledger, {
      target: 'unit',
      state: 'started',
      epochDigest,
      unitDigest,
      transitionDigest: transitionDigest(ledger, 'unit-1-start'),
      timestamp: 2,
    })
    expect(epochStarted && unitStarted).toBeTruthy()
    if (!epochStarted || !unitStarted)
      throw new Error('progression-marker-not-projected')
    expect('receiptId' in epochStarted).toBe(false)
    expect('receiptId' in unitStarted).toBe(false)

    const folded = foldReceiptReadback(
      [epochStarted, unitStarted],
      expectation(ledger),
    )
    expect(folded).toMatchObject({
      status: 'reconstructed',
      state: {
        receipts: [],
        progression: {
          epoch: { state: 'started', epochDigest },
          unit: { state: 'started', epochDigest, unitDigest },
        },
      },
    })
  })

  test('folds sequential completed epochs and units with latest-state projection', () => {
    const first = createMintedReceipt(
      'registration-a',
      'epoch-a',
      'unit-1',
      'call-a',
    )
    const second = createMintedReceipt(
      'registration-a',
      'epoch-b',
      'unit-2',
      'call-b',
    )
    const epochADigest = first.ledger.digestIdentity(
      'epoch',
      opaqueIdentity('epoch-a'),
    )
    const epochBDigest = first.ledger.digestIdentity(
      'epoch',
      opaqueIdentity('epoch-b'),
    )
    const unit1Digest = first.ledger.digestIdentity(
      'unit',
      opaqueIdentity('unit-1'),
    )
    const unit2Digest = first.ledger.digestIdentity(
      'unit',
      opaqueIdentity('unit-2'),
    )
    const epochAStart = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: epochADigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-a-start'),
      timestamp: 1,
    })
    const unit1Start = progressionMarker(first.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: epochADigest,
      unitDigest: unit1Digest,
      transitionDigest: transitionDigest(first.ledger, 'unit-1-start'),
      timestamp: 2,
    })
    const consumeFirst = projectReceiptConsumptionMarker(
      first.receipt,
      transitionDigest(first.ledger, 'consume-a'),
      3,
    )
    const unit1Complete = progressionMarker(first.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest: epochADigest,
      unitDigest: unit1Digest,
      transitionDigest: transitionDigest(first.ledger, 'unit-1-complete'),
      timestamp: 4,
    })
    const epochAComplete = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'completed',
      epochDigest: epochADigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-a-complete'),
      timestamp: 5,
    })
    const epochBStart = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: epochBDigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-b-start'),
      timestamp: 6,
    })
    const unit2Start = progressionMarker(first.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: epochBDigest,
      unitDigest: unit2Digest,
      transitionDigest: transitionDigest(first.ledger, 'unit-2-start'),
      timestamp: 7,
    })
    expect(
      epochAStart &&
        unit1Start &&
        consumeFirst &&
        unit1Complete &&
        epochAComplete &&
        epochBStart &&
        unit2Start,
    ).toBeTruthy()
    if (
      !epochAStart ||
      !unit1Start ||
      !consumeFirst ||
      !unit1Complete ||
      !epochAComplete ||
      !epochBStart ||
      !unit2Start
    )
      throw new Error('progression-marker-not-projected')

    const recoveredLedger = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(
      recoveredLedger.recoverReadback([
        epochAStart,
        unit1Start,
        first.marker,
        consumeFirst,
        unit1Complete,
        epochAComplete,
      ]),
    ).toMatchObject({ status: 'recovered' })
    expect(
      recoveredLedger.recoverReadback([
        epochAStart,
        unit1Start,
        first.marker,
        consumeFirst,
        unit1Complete,
        epochAComplete,
        epochBStart,
        unit2Start,
      ]),
    ).toMatchObject({
      status: 'recovered',
      progression: {
        epoch: { epochDigest: epochBDigest, state: 'started' },
        unit: { unitDigest: unit2Digest, state: 'started' },
      },
    })

    const folded = foldReceiptReadback(
      [
        epochAStart,
        unit1Start,
        first.marker,
        consumeFirst,
        unit1Complete,
        epochAComplete,
        epochBStart,
        unit2Start,
      ],
      expectation(first.ledger),
    )
    expect(folded).toMatchObject({
      status: 'reconstructed',
      state: {
        progression: {
          epoch: { state: 'started', epochDigest: epochBDigest },
          unit: {
            state: 'started',
            epochDigest: epochBDigest,
            unitDigest: unit2Digest,
          },
        },
      },
    })
    expect(JSON.stringify(folded)).not.toContain(
      second.receipt.canonical.receiptId,
    )
  })

  test('rejects progression reopen, premature epoch changes, unknown completion, and cross-epoch units', () => {
    const first = createMintedReceipt(
      'registration-a',
      'epoch-a',
      'unit-1',
      'call-a',
    )
    const epochADigest = first.ledger.digestIdentity(
      'epoch',
      opaqueIdentity('epoch-a'),
    )
    const epochBDigest = first.ledger.digestIdentity(
      'epoch',
      opaqueIdentity('epoch-b'),
    )
    const unit1Digest = first.ledger.digestIdentity(
      'unit',
      opaqueIdentity('unit-1'),
    )
    const unit2Digest = first.ledger.digestIdentity(
      'unit',
      opaqueIdentity('unit-2'),
    )
    const epochAStart = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: epochADigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-a-start'),
      timestamp: 1,
    })
    const epochBStart = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: epochBDigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-b-start'),
      timestamp: 2,
    })
    const epochAComplete = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'completed',
      epochDigest: epochADigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-a-complete'),
      timestamp: 3,
    })
    const epochAReopen = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest: epochADigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-a-reopen'),
      timestamp: 4,
    })
    const unknownComplete = progressionMarker(first.ledger, {
      target: 'epoch',
      state: 'completed',
      epochDigest: epochBDigest,
      transitionDigest: transitionDigest(first.ledger, 'epoch-b-complete'),
      timestamp: 5,
    })
    const crossEpochUnit = progressionMarker(first.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest: epochBDigest,
      unitDigest: unit2Digest,
      transitionDigest: transitionDigest(first.ledger, 'unit-2-cross-epoch'),
      timestamp: 6,
    })
    expect(
      epochAStart &&
        epochBStart &&
        epochAComplete &&
        epochAReopen &&
        unknownComplete &&
        crossEpochUnit,
    ).toBeTruthy()
    if (
      !epochAStart ||
      !epochBStart ||
      !epochAComplete ||
      !epochAReopen ||
      !unknownComplete ||
      !crossEpochUnit
    )
      throw new Error('progression-marker-not-projected')

    expect(
      foldReceiptReadback(
        [epochAStart, epochBStart],
        expectation(first.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'out-of-order' })
    expect(
      foldReceiptReadback(
        [epochAStart, epochAReopen],
        expectation(first.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'conflicting-marker' })
    expect(
      foldReceiptReadback([unknownComplete], expectation(first.ledger)),
    ).toMatchObject({ status: 'rejected', category: 'out-of-order' })
    expect(
      foldReceiptReadback(
        [epochAStart, crossEpochUnit],
        expectation(first.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'progression-mismatch' })
    expect(unit1Digest).toBeString()
  })

  test('advances an existing recovered receipt from available to consumed atomically', () => {
    const original = createMintedReceipt()
    const consume = projectReceiptConsumptionMarker(
      original.receipt,
      transitionDigest(original.ledger, 'consume'),
      10,
    )
    expect(consume).toBeDefined()
    if (!consume) throw new Error('consume-marker-not-projected')
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })

    expect(fresh.recoverReadback([original.marker])).toMatchObject({
      status: 'recovered',
    })
    expect(
      fresh.getEnvelope(original.receipt.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('available')
    expect(fresh.recoverReadback([original.marker, consume])).toMatchObject({
      status: 'recovered',
    })
    expect(
      fresh.getEnvelope(original.receipt.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('consumed')
    expect(fresh.recoverReadback([original.marker, consume])).toMatchObject({
      status: 'duplicate',
    })
    expect(fresh.recoverReadback([original.marker])).toMatchObject({
      status: 'duplicate',
    })
    expect(
      fresh.getEnvelope(original.receipt.canonical.receiptId)?.canonical
        .consumption,
    ).toBe('consumed')
  })

  test('rejects conflicting non-consumption changes atomically', () => {
    const original = createMintedReceipt()
    const conflictingReceipt: ReceiptEnvelope = {
      ...original.receipt,
      canonical: {
        ...original.receipt.canonical,
        timestamp: original.receipt.canonical.timestamp + 1,
      },
    }
    const conflictingMarker = projectReceiptMintMarker(
      conflictingReceipt,
      SESSION_SALT,
    )
    expect(conflictingMarker).toBeDefined()
    if (!conflictingMarker) throw new Error('conflicting-marker-not-projected')
    const fresh = createReceiptLedger({
      registrationIdentity: 'registration-a',
      sessionSalt: SESSION_SALT,
    })
    expect(fresh.recoverReadback([original.marker])).toMatchObject({
      status: 'recovered',
    })
    expect(fresh.recoverReadback([conflictingMarker])).toMatchObject({
      status: 'rejected',
      category: 'conflicting-marker',
    })
    expect(fresh.getEnvelope(original.receipt.canonical.receiptId)).toEqual(
      original.receipt,
    )
  })

  test('rejects completion with available receipts and completion without a started chain', () => {
    const original = createMintedReceipt()
    const epochDigest = original.receipt.canonical.epochDigest
    const unitDigest = original.receipt.canonical.unitDigest
    const epochStart = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'started',
      epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-start'),
      timestamp: 1,
    })
    const unitStart = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'started',
      epochDigest,
      unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-start'),
      timestamp: 2,
    })
    const unitComplete = progressionMarker(original.ledger, {
      target: 'unit',
      state: 'completed',
      epochDigest,
      unitDigest,
      transitionDigest: transitionDigest(original.ledger, 'unit-complete'),
      timestamp: 3,
    })
    const epochComplete = progressionMarker(original.ledger, {
      target: 'epoch',
      state: 'completed',
      epochDigest,
      transitionDigest: transitionDigest(original.ledger, 'epoch-complete'),
      timestamp: 4,
    })
    expect(
      epochStart && unitStart && unitComplete && epochComplete,
    ).toBeTruthy()
    if (!epochStart || !unitStart || !unitComplete || !epochComplete)
      throw new Error('progression-marker-not-projected')

    expect(
      foldReceiptReadback(
        [epochStart, unitStart, original.marker, unitComplete],
        expectation(original.ledger),
      ),
    ).toMatchObject({ status: 'rejected', category: 'inconsistent-evidence' })
    expect(
      foldReceiptReadback([unitComplete], expectation(original.ledger)),
    ).toMatchObject({ status: 'rejected', category: 'progression-mismatch' })
    expect(
      foldReceiptReadback([epochComplete], expectation(original.ledger)),
    ).toMatchObject({ status: 'rejected', category: 'out-of-order' })
  })
})
