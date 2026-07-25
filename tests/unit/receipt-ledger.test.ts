import { describe, expect, test } from 'bun:test'

import {
  createReceiptLedger,
  type ReceiptClassification,
  type ReceiptContext,
  type ReceiptOperation,
} from '../../src/lib/receipt-ledger.js'

const RAW_REPOSITORY = '/private/repos/receipt-demo/.git'
const RAW_WORKTREE = '/private/repos/receipt-demo'
const RAW_WORKSPACE_BEFORE = 'workspace-before'
const RAW_WORKSPACE_AFTER = 'workspace-after'
const RAW_COMMAND = 'git apply private.patch'
const RAW_OUTPUT = 'private terminal output'
const SUPPLIED_SALT = Uint8Array.from({ length: 32 }, (_, index) => index)

type LedgerOptions = Parameters<typeof createReceiptLedger>[0]

function createLedgerWithSalt(
  salt: Uint8Array,
  registrationIdentity = 'registration-a',
) {
  return createReceiptLedger({
    registrationIdentity,
    sessionSalt: salt,
  } as LedgerOptions)
}

function getSessionSalt(
  ledger: ReturnType<typeof createReceiptLedger>,
): Uint8Array | undefined {
  const candidate = ledger as unknown as {
    getSessionSalt?: () => Uint8Array
  }
  return typeof candidate.getSessionSalt === 'function'
    ? candidate.getSessionSalt()
    : undefined
}

function context(
  epochId = 'epoch-1',
  unitId = 'unit-1',
  workspaceIdentity = RAW_WORKSPACE_BEFORE,
): ReceiptContext {
  return {
    epochId,
    unitId,
    workspaceIdentity,
    repositoryIdentity: RAW_REPOSITORY,
    worktreeIdentity: RAW_WORKTREE,
    resourceIdentity: 'resource-1',
  }
}

function classification(
  operation: ReceiptOperation = 'implementation',
): ReceiptClassification {
  return {
    outcome: 'accepted',
    category: operation,
    attribution: 'runtime-verified',
    result: 'success',
    sideEffect: 'required',
    reasonCode: 'recognized-command',
  }
}

function prepareLedgerObservation(
  ledger: ReturnType<typeof createReceiptLedger>,
  callId = 'call-1',
  observationContext = context(),
  operation: ReceiptOperation = 'implementation',
) {
  return ledger.prepareObservation({
    callId,
    operation,
    context: observationContext,
  })
}

function finalizeLedgerObservation(
  ledger: ReturnType<typeof createReceiptLedger>,
  callId = 'call-1',
  observationContext = context(),
  afterWorkspaceIdentity = RAW_WORKSPACE_AFTER,
  operation: ReceiptOperation = 'implementation',
) {
  return ledger.finalizeObservation({
    callId,
    context: observationContext,
    after: {
      workspaceIdentity: afterWorkspaceIdentity,
      repositoryIdentity: 'repository-after',
      worktreeIdentity: 'worktree-after',
      resourceIdentity: 'resource-after',
    },
    classification: classification(operation),
    terminal: {
      status: 'success',
      output: 'non-empty',
      noOp: false,
    },
  })
}

describe('receipt ledger', () => {
  test('mints bounded runtime-owned metadata after a changed workspace observation', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })

    expect(prepareLedgerObservation(ledger)).toMatchObject({
      status: 'prepared',
    })

    const result = finalizeLedgerObservation(ledger)

    expect(result.status).toBe('finalized')
    expect(result.receipt).toMatchObject({
      compatibility: 'compatible',
      canonical: {
        operation: 'implementation',
        result: 'success',
        consumption: 'available',
        source: 'runtime-verified',
      },
    })
    expect(result.receipt?.canonical.receiptId).toBeString()
    expect(JSON.stringify(result.receipt)).not.toContain(RAW_REPOSITORY)
    expect(JSON.stringify(result.receipt)).not.toContain(RAW_WORKTREE)
    expect(JSON.stringify(result.receipt)).not.toContain(RAW_COMMAND)
    expect(JSON.stringify(result.receipt)).not.toContain(RAW_OUTPUT)
  })

  test('deduplicates a call and consumes its receipt exactly once', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })

    expect(prepareLedgerObservation(ledger).status).toBe('prepared')
    expect(prepareLedgerObservation(ledger).status).toBe('duplicate')

    const finalized = finalizeLedgerObservation(ledger)
    expect(finalized.status).toBe('finalized')

    const replay = finalizeLedgerObservation(ledger)
    expect(replay.status).toBe('rejected')
    expect(replay.reasonCode).toBe('duplicate-finalization')

    const receiptId = finalized.receipt?.canonical.receiptId
    expect(receiptId).toBeString()
    expect(
      ledger.consumeReceipt(receiptId ?? '', {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: RAW_WORKSPACE_AFTER,
        repositoryIdentity: 'repository-after',
        worktreeIdentity: 'worktree-after',
        resourceIdentity: 'resource-after',
      }).status,
    ).toBe('consumed')
    expect(
      ledger.consumeReceipt(receiptId ?? '', {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: RAW_WORKSPACE_AFTER,
        repositoryIdentity: 'repository-after',
        worktreeIdentity: 'worktree-after',
        resourceIdentity: 'resource-after',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'already-consumed' })
  })

  test('rejects a second prepare for the same call with a different operation', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })

    expect(
      prepareLedgerObservation(
        ledger,
        'same-call',
        context(),
        'implementation',
      ),
    ).toMatchObject({
      status: 'prepared',
    })
    expect(
      prepareLedgerObservation(ledger, 'same-call', context(), 'verification'),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'call-context-conflict',
    })
  })

  test('rejects a second prepare for the same call with a different context', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })

    expect(
      prepareLedgerObservation(ledger, 'same-call', context('epoch-1')),
    ).toMatchObject({
      status: 'prepared',
    })
    expect(
      prepareLedgerObservation(ledger, 'same-call', context('epoch-2')),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'call-context-conflict',
    })
  })

  test('rejects same-call changes to repository, worktree, or resource identity', () => {
    const fields: Array<keyof ReceiptContext> = [
      'repositoryIdentity',
      'worktreeIdentity',
      'resourceIdentity',
    ]

    for (const field of fields) {
      const ledger = createReceiptLedger({
        registrationIdentity: `registration-${field}`,
      })
      const firstContext = context()
      const secondContext = {
        ...firstContext,
        [field]: `foreign-${field}`,
      }
      expect(
        prepareLedgerObservation(ledger, 'same-call', firstContext).status,
      ).toBe('prepared')
      expect(
        prepareLedgerObservation(ledger, 'same-call', secondContext),
      ).toMatchObject({
        status: 'rejected',
        reasonCode: 'call-context-conflict',
      })
    }
  })

  test('does not mint implementation evidence for an unchanged workspace', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    prepareLedgerObservation(ledger)

    const result = finalizeLedgerObservation(
      ledger,
      'call-1',
      context(),
      RAW_WORKSPACE_BEFORE,
    )

    expect(result).toMatchObject({
      status: 'rejected',
      reasonCode: 'unchanged-workspace',
    })
  })

  test('does not mint evidence for empty or successful no-op results', () => {
    const emptyLedger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    prepareLedgerObservation(emptyLedger)
    const empty = emptyLedger.finalizeObservation({
      callId: 'call-1',
      context: context(),
      after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
      classification: classification(),
      terminal: { status: 'success', output: 'empty', noOp: false },
    })
    expect(empty).toMatchObject({
      status: 'rejected',
      reasonCode: 'empty-result',
    })

    const noOpLedger = createReceiptLedger({
      registrationIdentity: 'registration-b',
    })
    prepareLedgerObservation(noOpLedger)
    const noOp = noOpLedger.finalizeObservation({
      callId: 'call-1',
      context: context(),
      after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
      classification: classification(),
      terminal: { status: 'success', output: 'non-empty', noOp: true },
    })
    expect(noOp).toMatchObject({
      status: 'rejected',
      reasonCode: 'successful-no-op',
    })
  })

  test('seals a failed terminal finalization against later replay', () => {
    const failures = [
      { status: 'failure' as const, reasonCode: 'terminal-failure' },
      { status: 'cancelled' as const, reasonCode: 'terminal-failure' },
      { status: 'running' as const, reasonCode: 'terminal-failure' },
      { status: 'unknown' as const, reasonCode: 'terminal-failure' },
    ]

    for (const failure of failures) {
      const ledger = createReceiptLedger({
        registrationIdentity: `registration-${failure.status}`,
      })
      prepareLedgerObservation(ledger)

      const failed = ledger.finalizeObservation({
        callId: 'call-1',
        context: context(),
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: classification(),
        terminal: { status: failure.status, output: 'non-empty', noOp: false },
      })
      expect(failed).toMatchObject({
        status: 'rejected',
        reasonCode: failure.reasonCode,
      })
      expect(prepareLedgerObservation(ledger)).toMatchObject({
        status: 'rejected',
        reasonCode: 'abandoned-observation',
      })
      expect(finalizeLedgerObservation(ledger)).toMatchObject({
        status: 'rejected',
        reasonCode: 'abandoned-observation',
      })
    }
  })

  test('seals unavailable, empty, no-op, unchanged, resource-no-op, and mismatched finalizations', () => {
    const unavailableLedger = createReceiptLedger({
      registrationIdentity: 'registration-unavailable',
    })
    prepareLedgerObservation(unavailableLedger)
    expect(
      unavailableLedger.finalizeObservation({
        callId: 'call-1',
        context: context(),
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: {
          ...classification(),
          outcome: 'unavailable',
          reasonCode: 'parser-asset-unavailable',
        },
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      }),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'classification-unavailable',
    })
    expect(prepareLedgerObservation(unavailableLedger)).toMatchObject({
      status: 'rejected',
      reasonCode: 'abandoned-observation',
    })

    const rejectedLedger = createReceiptLedger({
      registrationIdentity: 'registration-rejected',
    })
    prepareLedgerObservation(rejectedLedger)
    expect(
      rejectedLedger.finalizeObservation({
        callId: 'call-1',
        context: context(),
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: {
          ...classification(),
          outcome: 'rejected',
          reasonCode: 'classification-rejected',
        },
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      }),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'classification-rejected',
    })
    expect(prepareLedgerObservation(rejectedLedger)).toMatchObject({
      status: 'rejected',
      reasonCode: 'abandoned-observation',
    })

    const emptyLedger = createReceiptLedger({
      registrationIdentity: 'registration-empty-replay',
    })
    prepareLedgerObservation(emptyLedger)
    expect(
      emptyLedger.finalizeObservation({
        callId: 'call-1',
        context: context(),
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: classification(),
        terminal: { status: 'success', output: 'empty', noOp: false },
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'empty-result' })
    expect(finalizeLedgerObservation(emptyLedger)).toMatchObject({
      status: 'rejected',
      reasonCode: 'abandoned-observation',
    })

    const noOpLedger = createReceiptLedger({
      registrationIdentity: 'registration-no-op-replay',
    })
    prepareLedgerObservation(noOpLedger)
    expect(
      noOpLedger.finalizeObservation({
        callId: 'call-1',
        context: context(),
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: classification(),
        terminal: { status: 'success', output: 'non-empty', noOp: true },
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'successful-no-op' })
    expect(finalizeLedgerObservation(noOpLedger)).toMatchObject({
      status: 'rejected',
      reasonCode: 'abandoned-observation',
    })

    const unchangedLedger = createReceiptLedger({
      registrationIdentity: 'registration-unchanged',
    })
    prepareLedgerObservation(unchangedLedger)
    expect(
      finalizeLedgerObservation(
        unchangedLedger,
        'call-1',
        context(),
        RAW_WORKSPACE_BEFORE,
      ),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'unchanged-workspace',
    })
    expect(finalizeLedgerObservation(unchangedLedger)).toMatchObject({
      status: 'rejected',
      reasonCode: 'abandoned-observation',
    })

    const resourceLedger = createReceiptLedger({
      registrationIdentity: 'registration-resource',
    })
    const resourceContext = {
      ...context(),
      resourceIdentity: 'remote-before',
      repositoryIdentity: 'repository-before',
    }
    resourceLedger.prepareObservation({
      callId: 'resource-call',
      operation: 'push',
      context: resourceContext,
    })
    expect(
      resourceLedger.finalizeObservation({
        callId: 'resource-call',
        context: resourceContext,
        after: {
          workspaceIdentity: RAW_WORKSPACE_AFTER,
          repositoryIdentity: 'repository-after',
          resourceIdentity: 'remote-before',
        },
        classification: classification('push'),
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'no-op-resource' })
    expect(
      resourceLedger.prepareObservation({
        callId: 'resource-call',
        operation: 'push',
        context: resourceContext,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'abandoned-observation' })

    const mismatchLedger = createReceiptLedger({
      registrationIdentity: 'registration-mismatch',
    })
    prepareLedgerObservation(mismatchLedger)
    expect(
      finalizeLedgerObservation(mismatchLedger, 'call-1', context('epoch-2')),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'epoch-mismatch',
    })
    expect(finalizeLedgerObservation(mismatchLedger)).toMatchObject({
      status: 'rejected',
      reasonCode: 'abandoned-observation',
    })
  })

  test('rejects epoch, unit, and workspace mismatches before minting', () => {
    const cases: Array<{
      name: string
      prepared: ReceiptContext
      finalized: ReceiptContext
      reasonCode: string
    }> = [
      {
        name: 'epoch',
        prepared: context('epoch-1'),
        finalized: context('epoch-2'),
        reasonCode: 'epoch-mismatch',
      },
      {
        name: 'unit',
        prepared: context('epoch-1', 'unit-1'),
        finalized: context('epoch-1', 'unit-2'),
        reasonCode: 'unit-mismatch',
      },
      {
        name: 'workspace',
        prepared: context('epoch-1', 'unit-1', RAW_WORKSPACE_BEFORE),
        finalized: context('epoch-1', 'unit-1', 'workspace-foreign'),
        reasonCode: 'workspace-mismatch',
      },
    ]

    for (const mismatch of cases) {
      const ledger = createReceiptLedger({
        registrationIdentity: `registration-${mismatch.name}`,
      })
      prepareLedgerObservation(ledger, 'call-1', mismatch.prepared)
      const result = finalizeLedgerObservation(
        ledger,
        'call-1',
        mismatch.finalized,
      )
      expect(result).toMatchObject({
        status: 'rejected',
        reasonCode: mismatch.reasonCode,
      })
    }
  })

  test('rejects consuming a receipt with a foreign epoch, unit, or workspace', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    prepareLedgerObservation(ledger)
    const finalized = finalizeLedgerObservation(ledger)
    const receiptId = finalized.receipt?.canonical.receiptId ?? ''

    expect(
      ledger.consumeReceipt(receiptId, {
        epochId: 'foreign-epoch',
        unitId: 'unit-1',
        workspaceIdentity: RAW_WORKSPACE_AFTER,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'epoch-mismatch' })
    expect(
      ledger.consumeReceipt(receiptId, {
        epochId: 'epoch-1',
        unitId: 'foreign-unit',
        workspaceIdentity: RAW_WORKSPACE_AFTER,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'unit-mismatch' })
    expect(
      ledger.consumeReceipt(receiptId, {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: 'foreign-workspace',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'workspace-mismatch' })
  })

  test('rejects model-shaped finalized fields through the observation API', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    const forged = {
      callId: 'call-forged',
      operation: 'implementation',
      context: context(),
      receiptId: 'model-receipt',
      consumption: 'consumed',
      outcome: 'compatible',
      finalized: true,
    }

    expect(ledger.prepareObservation(forged)).toMatchObject({
      status: 'rejected',
      reasonCode: 'forbidden-field',
    })
    expect(
      ledger.finalizeObservation({
        ...forged,
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: classification(),
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'forbidden-field' })
  })

  test('fails closed for unknown, incomplete, and cross-registration envelopes', () => {
    const first = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    prepareLedgerObservation(first)
    const finalized = finalizeLedgerObservation(first)
    const envelope = finalized.receipt
    expect(envelope).toBeDefined()
    expect(first.validateEnvelope(envelope)).toMatchObject({
      compatibility: 'compatible',
    })

    expect(first.validateEnvelope({})).toMatchObject({
      compatibility: 'unavailable',
      reasonCode: 'incomplete-envelope',
    })
    expect(
      first.validateEnvelope({
        ...(envelope ?? {}),
        schemaVersion: 999,
      }),
    ).toMatchObject({
      compatibility: 'unavailable',
      reasonCode: 'unknown-envelope',
    })
    expect(
      first.validateEnvelope({
        ...(envelope ?? {}),
        capabilityFlags: undefined,
      }),
    ).toMatchObject({
      compatibility: 'unavailable',
      reasonCode: 'incomplete-envelope',
    })

    const second = createReceiptLedger({
      registrationIdentity: 'registration-b',
    })
    expect(second.validateEnvelope(envelope)).toMatchObject({
      compatibility: 'rejected',
      reasonCode: 'cross-registration-disputed',
    })
  })

  test('requires exact canonical capability compatibility in envelopes', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-capabilities',
      capabilityFlags: ['zeta', 'alpha', 'zeta'],
    })
    prepareLedgerObservation(ledger)
    const finalized = finalizeLedgerObservation(ledger)
    const envelope = finalized.receipt

    expect(ledger.metadata.capabilityFlags).toEqual(['alpha', 'zeta'])
    expect(Object.isFrozen(ledger.metadata)).toBe(true)
    expect(Object.isFrozen(ledger.metadata.capabilityFlags)).toBe(true)
    try {
      ;(ledger.metadata.capabilityFlags as string[]).push('forged')
    } catch {
      // Frozen metadata is intentionally immutable at the public boundary.
    }
    expect(ledger.metadata.capabilityFlags).toEqual(['alpha', 'zeta'])
    expect(ledger.validateEnvelope(envelope)).toMatchObject({
      compatibility: 'compatible',
    })

    const mismatches = [
      ['alpha'],
      ['alpha', 'extra', 'zeta'],
      ['alpha', 'zeta', 'zeta'],
      ['zeta', 'alpha'],
      ['alpha', 'zeta', 'x'.repeat(1000)],
      Array.from({ length: 17 }, (_, index) => `cap-${index}`),
    ]
    for (const capabilityFlags of mismatches) {
      expect(
        ledger.validateEnvelope({
          ...(envelope ?? {}),
          capabilityFlags,
        }),
      ).toMatchObject({
        compatibility: 'unavailable',
        reasonCode: 'capability-mismatch',
      })
    }
  })

  test('rejects unrepresentable configured capabilities at ledger construction', () => {
    const oversizedFlag = 'x'.repeat(129)
    const invalidConfigurations: Array<{
      capabilityFlags: readonly string[]
      rawValue: string
    }> = [
      {
        capabilityFlags: Array.from(
          { length: 17 },
          (_, index) => `cap-${index}`,
        ),
        rawValue: 'cap-16',
      },
      { capabilityFlags: ['valid', ''], rawValue: '' },
      { capabilityFlags: ['valid', oversizedFlag], rawValue: oversizedFlag },
      {
        capabilityFlags: ['valid', 42] as unknown as readonly string[],
        rawValue: '42',
      },
    ]

    for (const configuration of invalidConfigurations) {
      let thrown: unknown
      try {
        createReceiptLedger({
          capabilityFlags: configuration.capabilityFlags,
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect(String(thrown)).toContain('invalid-capability-flags')
      if (configuration.rawValue.length > 0) {
        expect(String(thrown)).not.toContain(configuration.rawValue)
      }
    }
  })

  test('correlates identities within one session but not across ledgers', () => {
    const first = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    const second = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })

    const firstDigest = first.digestIdentity('repository', RAW_REPOSITORY)
    expect(first.digestIdentity('repository', RAW_REPOSITORY)).toBe(firstDigest)
    expect(first.digestIdentity('worktree', RAW_WORKTREE)).not.toBe(firstDigest)
    expect(second.digestIdentity('repository', RAW_REPOSITORY)).not.toBe(
      firstDigest,
    )
    expect(first.metadata.registrationDigest).not.toBe(
      second.metadata.registrationDigest,
    )
  })

  test('restores supplied session salts without exposing or sharing mutable bytes', () => {
    const supplied = new Uint8Array(SUPPLIED_SALT)
    const first = createLedgerWithSalt(supplied)
    const second = createLedgerWithSalt(new Uint8Array(SUPPLIED_SALT))
    const firstDigest = first.digestIdentity('repository', RAW_REPOSITORY)

    expect(second.digestIdentity('repository', RAW_REPOSITORY)).toBe(
      firstDigest,
    )
    supplied[0] = supplied[0] ^ 0xff
    expect(first.digestIdentity('repository', RAW_REPOSITORY)).toBe(firstDigest)

    const returned = getSessionSalt(first)
    expect(returned).toBeInstanceOf(Uint8Array)
    if (!returned) return
    returned[1] = returned[1] ^ 0xff
    expect(first.digestIdentity('repository', RAW_REPOSITORY)).toBe(firstDigest)

    prepareLedgerObservation(first)
    const finalized = finalizeLedgerObservation(first)
    const saltHex = Buffer.from(SUPPLIED_SALT).toString('hex')
    expect(JSON.stringify(finalized.receipt)).not.toContain(saltHex)
    expect(JSON.stringify(first.listReceipts())).not.toContain(saltHex)
  })

  test('rejects invalid supplied session salt lengths at construction', () => {
    expect(() =>
      createReceiptLedger({
        sessionSalt: new Uint8Array(31),
      } as LedgerOptions),
    ).toThrow()
  })

  test('keeps prepared observations non-authoritative and abandons them without poisoning replay', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    const prepared = prepareLedgerObservation(ledger)
    expect(prepared.status).toBe('prepared')
    expect(ledger.listReceipts()).toHaveLength(0)
    expect(
      ledger.consumeReceipt(prepared.preparationId ?? '', {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: RAW_WORKSPACE_BEFORE,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'unknown-receipt' })

    expect(
      ledger.abandonObservation({ callId: 'call-1', context: context() }),
    ).toMatchObject({ status: 'abandoned' })
    expect(
      ledger.finalizeObservation({
        callId: 'call-1',
        context: context(),
        after: { workspaceIdentity: RAW_WORKSPACE_AFTER },
        classification: classification(),
        terminal: { status: 'success', output: 'non-empty', noOp: false },
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'abandoned-observation' })

    expect(prepareLedgerObservation(ledger, 'call-2').status).toBe('prepared')
    expect(finalizeLedgerObservation(ledger, 'call-2').status).toBe('finalized')
  })

  test('keeps separate epochs independent even when operation names repeat', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    prepareLedgerObservation(ledger, 'call-epoch-1', context('epoch-1'))
    prepareLedgerObservation(ledger, 'call-epoch-2', context('epoch-2'))

    const first = finalizeLedgerObservation(
      ledger,
      'call-epoch-1',
      context('epoch-1'),
    )
    const second = finalizeLedgerObservation(
      ledger,
      'call-epoch-2',
      context('epoch-2'),
    )

    expect(first.status).toBe('finalized')
    expect(second.status).toBe('finalized')
    expect(first.receipt?.canonical.epochDigest).not.toBe(
      second.receipt?.canonical.epochDigest,
    )
    expect(
      ledger.consumeReceipt(first.receipt?.canonical.receiptId ?? '', {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: RAW_WORKSPACE_AFTER,
        repositoryIdentity: 'repository-after',
        worktreeIdentity: 'worktree-after',
        resourceIdentity: 'resource-after',
      }).status,
    ).toBe('consumed')
    expect(
      ledger.consumeReceipt(second.receipt?.canonical.receiptId ?? '', {
        epochId: 'epoch-2',
        unitId: 'unit-1',
        workspaceIdentity: RAW_WORKSPACE_AFTER,
        repositoryIdentity: 'repository-after',
        worktreeIdentity: 'worktree-after',
        resourceIdentity: 'resource-after',
      }).status,
    ).toBe('consumed')
  })

  test('retains abandoned call keys beyond the old FIFO bound', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: 'registration-long-lived',
    })
    for (let index = 0; index < 1_025; index += 1) {
      const callId = `abandoned-call-${index}`
      const observationContext = context(
        `epoch-${index}`,
        'unit-1',
        `workspace-${index}`,
      )
      expect(
        prepareLedgerObservation(ledger, callId, observationContext).status,
      ).toBe('prepared')
      expect(
        ledger.abandonObservation({ callId, context: observationContext })
          .status,
      ).toBe('abandoned')
    }

    expect(
      prepareLedgerObservation(
        ledger,
        'abandoned-call-0',
        context('epoch-0', 'unit-1', 'workspace-0'),
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'abandoned-observation' })
  })
})
