import { describe, expect, test } from 'bun:test'

import type {
  OpencodeOperationObserver,
  OperationObserverSnapshot,
} from '../../src/lib/opencode-operation-observer.js'
import {
  createOpencodeWorkflowGuard,
  SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY,
} from '../../src/lib/opencode-workflow-guard.js'
import {
  CANONICAL_QUESTION_WORDING,
  classifyQuestionAnswer,
  createQuestionAttestation,
} from '../../src/lib/question-attestation.js'
import {
  createReceiptClassifier,
  type ReceiptOperationObservation,
} from '../../src/lib/receipt-classifier.js'
import {
  createReceiptLedger,
  type ReceiptContext,
} from '../../src/lib/receipt-ledger.js'
import {
  projectReceiptConsumptionMarker,
  projectReceiptMintMarker,
} from '../../src/lib/receipt-readback.js'
import { createWorkflowGuard } from '../../src/lib/workflow-guard.js'

const SESSION_ID = 'privacy-session'
const RESOURCE = '/Users/example/private/project'
const SECRET_PATH = `${process.cwd()}/tests/unit/.privacy-fixture.env`
const SECRET_COMMAND = 'git push origin private-branch --token=secret-value'
const SECRET_PR_BODY = 'private pull request body with customer@example.test'
const SECRET_ENV = 'SUPER_SECRET_ENV_VALUE'
const SECRET_PROSE = 'private user prose must never be persisted'
const SESSION_SALT = new Uint8Array(32).fill(7)
const OPERATION_TARGET_IDENTITY = 'd'.repeat(64)

const DIGEST = /^[0-9a-f]{64}$/
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,256}$/
const STRUCTURED_STATUS = /^[A-Za-z0-9_.:|,-]{1,512}$/
const CANONICAL_ENUMS = new Set([
  'accepted',
  'affirmed',
  'available',
  'bound',
  'compatible',
  'completed',
  'consumed',
  'control',
  'disabled',
  'enabled',
  'implementation',
  'mint',
  'non-empty',
  'observe',
  'pending',
  'protected',
  'rejected',
  'runtime-verified',
  'success',
  'transition',
  'unit-ready',
  'verification',
])

function expectNoSensitiveStrings(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const sensitive of [
    RESOURCE,
    SECRET_PATH,
    SECRET_COMMAND,
    SECRET_PR_BODY,
    SECRET_ENV,
    SECRET_PROSE,
  ]) {
    expect(serialized).not.toContain(sensitive)
  }
}

function expectBoundedProjection(value: unknown): void {
  if (typeof value === 'string') {
    expect(
      value === CANONICAL_QUESTION_WORDING ||
        DIGEST.test(value) ||
        IDENTIFIER.test(value) ||
        STRUCTURED_STATUS.test(value) ||
        CANONICAL_ENUMS.has(value),
    ).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) expectBoundedProjection(item)
    return
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) expectBoundedProjection(nested)
  }
}

function sequenceObserver(
  snapshots: readonly OperationObserverSnapshot[],
): OpencodeOperationObserver {
  let index = 0
  return {
    targetDigest: snapshots[0]?.targetDigest ?? 'a'.repeat(64),
    validateRegisteredWorktree(_candidateDirectory: string) {
      const targetRoot = process.cwd()
      return {
        status: 'ok' as const,
        targetRoot,
        gitDir: `${targetRoot}/.git`,
        commonDir: `${targetRoot}/.git`,
      }
    },
    async snapshot() {
      const snapshot = snapshots[Math.min(index++, snapshots.length - 1)]
      if (!snapshot)
        return { status: 'unavailable', reasonCode: 'target-unavailable' }
      return { status: 'available', snapshot }
    },
    async remoteSnapshot() {
      return { status: 'unavailable', reasonCode: 'remote-missing-field' }
    },
  }
}

function operationSnapshot(
  repositoryRevisionDigest: string,
  worktreeRevisionDigest: string,
): OperationObserverSnapshot {
  return {
    targetDigest: 'a'.repeat(64),
    repositoryRevisionDigest,
    worktreeRevisionDigest,
  }
}

function mintReceipt(): {
  ledger: ReturnType<typeof createReceiptLedger>
  receipt: ReturnType<
    ReturnType<typeof createReceiptLedger>['listReceipts']
  >[number]
} {
  const ledger = createReceiptLedger({
    registrationIdentity: 'privacy-registration',
    sessionSalt: SESSION_SALT,
  })
  const context: ReceiptContext = {
    epochId: 'epoch-privacy',
    unitId: 'unit-privacy',
    workspaceIdentity: RESOURCE,
    repositoryIdentity: `${RESOURCE}/.git`,
    worktreeIdentity: `${RESOURCE}/.worktree`,
    operationTargetIdentity: OPERATION_TARGET_IDENTITY,
    resourceIdentity: SECRET_PATH,
  }
  expect(
    ledger.prepareObservation({
      callId: SECRET_COMMAND,
      operation: 'implementation',
      context,
    }),
  ).toMatchObject({ status: 'prepared' })
  const finalized = ledger.finalizeObservation({
    callId: SECRET_COMMAND,
    context,
    after: {
      workspaceIdentity: RESOURCE,
      repositoryIdentity: `${RESOURCE}/.git-after`,
      worktreeIdentity: `${RESOURCE}/.worktree-after`,
      operationTargetIdentity: OPERATION_TARGET_IDENTITY,
      resourceIdentity: SECRET_PATH,
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
  expect(finalized).toMatchObject({ status: 'finalized' })
  if (finalized.status !== 'finalized') throw new Error('receipt-not-finalized')
  return { ledger, receipt: finalized.receipt }
}

describe('receipt privacy projections', () => {
  test('ledger envelopes and readback markers contain only bounded values', () => {
    const { ledger, receipt } = mintReceipt()
    const mintMarker = projectReceiptMintMarker(receipt, SESSION_SALT)
    const consumeMarker = projectReceiptConsumptionMarker(
      receipt,
      ledger.digestIdentity('transition', SECRET_PR_BODY),
      123,
    )

    expect(mintMarker).toBeDefined()
    expect(consumeMarker).toBeDefined()
    const values = [
      ledger.metadata,
      receipt,
      ledger.listReceipts(),
      mintMarker,
      consumeMarker,
    ]
    for (const value of values) {
      expectNoSensitiveStrings(value)
      expectBoundedProjection(value)
    }
  })

  test('workflow and attestation status never expose sensitive identities or answers', () => {
    const ledger = createReceiptLedger({
      registrationIdentity: SECRET_PR_BODY,
      sessionSalt: SESSION_SALT,
    })
    const guard = createWorkflowGuard({
      ledger,
      workspaceIdentity: RESOURCE,
      repositoryIdentity: SECRET_PATH,
      worktreeIdentity: SECRET_COMMAND,
      mode: 'protected',
    })
    expect(
      guard.activate({
        event: 'guarded-skill',
        skill: 'ce-work',
        outcome: 'success',
      }),
    ).toMatchObject({ status: 'activated' })
    expect(
      guard.startUnit({ expectedOperations: [], resourceScopes: {} }),
    ).toMatchObject({ status: 'started' })

    const attestation = createQuestionAttestation({ clock: () => 456 })
    const challenge = attestation.challenge({
      sessionId: SESSION_ID,
      resource: SECRET_PATH,
      transition: 'unit-complete',
      purpose: 'transition',
    })
    expect(challenge.status).toBe('pending')
    if (challenge.status !== 'pending') throw new Error('challenge-not-created')
    expect(
      attestation.bindAsked({
        challengeId: challenge.challenge.challengeId,
        callId: SECRET_COMMAND,
        requestId: 'request-privacy',
      }),
    ).toMatchObject({ status: 'bound' })
    expect(
      attestation.observeReply({
        sessionId: SESSION_ID,
        requestId: 'request-privacy',
        answer: SECRET_PROSE,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'non-affirmative' })

    const values = [
      guard.status(),
      guard.status().epoch,
      guard.status().unit,
      challenge.challenge,
      attestation.status({ challengeId: challenge.challenge.challengeId }),
      attestation.sessionStatus({ sessionId: SESSION_ID }),
    ]
    for (const value of values) {
      expectNoSensitiveStrings(value)
      expectBoundedProjection(value)
    }
  })

  test('adapter receipt markers and workflow-tool metadata are bounded', async () => {
    const observations: ReceiptOperationObservation[] = []
    const classifier = createReceiptClassifier()
    const adapter = createOpencodeWorkflowGuard({
      config: { mode: 'observe', debug: false },
      workspaceIdentity: 'a'.repeat(64),
      repositoryIdentity: 'b'.repeat(64),
      worktreeIdentity: 'c'.repeat(64),
      observer: sequenceObserver([
        operationSnapshot('b'.repeat(64), 'c'.repeat(64)),
        operationSnapshot('b'.repeat(64), 'd'.repeat(64)),
      ]),
      classifier: {
        ...classifier,
        classifyOperation: async (input: unknown) => {
          observations.push(input as ReceiptOperationObservation)
          return classifier.classifyOperation?.(input)
        },
      },
      runtimeRequiredOperations: [],
      hostReadback: undefined,
    })
    await adapter.hooks['tool.execute.before'](
      {
        tool: 'systematic_skill',
        sessionID: SESSION_ID,
        callID: 'privacy-skill-call',
      },
      { args: { name: 'ce:work' } },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'systematic_skill',
        sessionID: SESSION_ID,
        callID: 'privacy-skill-call',
        args: { name: 'ce:work' },
      },
      {
        title: 'Loaded skill',
        output: 'skill result',
        metadata: { status: 'success' },
      },
    )
    const output = {
      title: 'operation complete',
      output: 'bounded host result',
      metadata: {},
    }
    await adapter.hooks['tool.execute.before'](
      {
        tool: 'write',
        sessionID: SESSION_ID,
        callID: 'privacy-operation-call',
      },
      {
        args: {
          filePath: SECRET_PATH,
          content: SECRET_COMMAND,
          env: SECRET_ENV,
        },
      },
    )
    await adapter.hooks['tool.execute.after'](
      {
        tool: 'write',
        sessionID: SESSION_ID,
        callID: 'privacy-operation-call',
        args: {
          filePath: SECRET_PATH,
          content: SECRET_COMMAND,
          env: SECRET_ENV,
        },
      },
      output,
    )

    const marker = output.metadata[SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY]
    const toolResult = await adapter.tools.systematic_workflow_status.execute(
      {},
      { sessionID: SESSION_ID, metadata: () => {} },
    )
    const toolMetadata = toolResult.metadata
    const values = [marker, adapter.status(SESSION_ID), toolMetadata]
    for (const value of values) {
      expect(value).toBeDefined()
      expectNoSensitiveStrings(value)
      expectBoundedProjection(value)
    }
  })

  test('answer classifier accepts only the canonical bounded affirmative shape', () => {
    expect(classifyQuestionAnswer('yes')).toBe('affirmative')
    expect(classifyQuestionAnswer('confirm')).toBe('affirmative')
    for (const answer of [
      'YES',
      'yes please',
      'confirm this transition',
      SECRET_PROSE,
      { answer: 'yes' },
      ['yes'],
      1,
    ]) {
      expect(classifyQuestionAnswer(answer)).toBe('non-affirmative')
    }
    expectNoSensitiveStrings({ wording: CANONICAL_QUESTION_WORDING })
  })
})
