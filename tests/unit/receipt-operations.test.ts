import { describe, expect, test } from 'bun:test'

import {
  createReceiptClassifier,
  type ReceiptOperation,
} from '../../src/lib/receipt-classifier.js'
import {
  createReceiptLedger,
  type ReceiptClassification,
} from '../../src/lib/receipt-ledger.js'
import {
  createWorkflowGuard,
  type EvidenceObservationResult,
  type WorkflowGuard,
  type WorkflowGuardOptions,
} from '../../src/lib/workflow-guard.js'

const successTerminal = {
  status: 'success' as const,
  output: 'non-empty' as const,
  noOp: false,
}

const REVISION_A =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REVISION_B =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const REVISION_C =
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const RESOURCE_BEFORE =
  '1111111111111111111111111111111111111111111111111111111111111111'
const RESOURCE_AFTER =
  '2222222222222222222222222222222222222222222222222222222222222222'
const RESOURCE_REMOTE =
  '3333333333333333333333333333333333333333333333333333333333333333'
const RESOURCE_PR =
  '4444444444444444444444444444444444444444444444444444444444444444'
const RESOURCE_WRONG =
  '5555555555555555555555555555555555555555555555555555555555555555'
const WORKSPACE_CURRENT =
  '6666666666666666666666666666666666666666666666666666666666666666'
const WORKSPACE_AFTER =
  '7777777777777777777777777777777777777777777777777777777777777777'
const WORKSPACE_NEXT =
  '8888888888888888888888888888888888888888888888888888888888888888'
const REPOSITORY_CURRENT =
  '9999999999999999999999999999999999999999999999999999999999999999'
const REPOSITORY_BEFORE =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REPOSITORY_AFTER =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const WORKTREE_CURRENT =
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const WORKSPACE_OTHER =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const WORKSPACE_ZERO =
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const REPOSITORY_ZERO =
  '1212121212121212121212121212121212121212121212121212121212121212'
const REPOSITORY_ONE =
  '1313131313131313131313131313131313131313131313131313131313131313'
const REPOSITORY_NEW =
  '1515151515151515151515151515151515151515151515151515151515151515'
const WORKTREE_ZERO =
  '1414141414141414141414141414141414141414141414141414141414141414'
const WORKTREE_AFTER =
  '1616161616161616161616161616161616161616161616161616161616161616'
const WORKTREE_INITIAL = WORKTREE_ZERO

const baseContext = {
  epochId: 'epoch-1',
  unitId: 'unit-1',
  workspaceIdentity: WORKSPACE_CURRENT,
  repositoryIdentity: REPOSITORY_CURRENT,
  worktreeIdentity: WORKTREE_CURRENT,
  resourceIdentity: RESOURCE_BEFORE,
}

interface OperationClassifier {
  classifyOperation(input: unknown): Promise<ReceiptClassification>
}

interface ReadbackResult {
  status: 'accepted' | 'rejected'
  changed?: boolean
  reasonCode?: string
}

interface OperationWorkflowGuard extends WorkflowGuard {
  observeOperation(input: unknown): Promise<EvidenceObservationResult>
  observeReadback(input: unknown): ReadbackResult
}

function operationInput(
  operation: ReceiptOperation,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const commands: Partial<Record<ReceiptOperation, string>> = {
    implementation: undefined,
    verification: 'bun test tests/unit/receipt-operations.test.ts',
    commit: 'git commit -m "receipt guard"',
    push: 'git push origin HEAD',
    'pr-creation': 'gh pr create --title "Receipt guard" --body "Details"',
    'check-readback': 'gh pr checks 42',
    'review-readback': 'gh pr view 42 --json reviewDecision',
  }
  const tools: Record<ReceiptOperation, string> = {
    implementation: 'edit',
    verification: 'bash',
    commit: 'git',
    push: 'git',
    'pr-creation': 'gh',
    'check-readback': 'gh',
    'review-readback': 'gh',
  }
  const after = {
    workspaceIdentity: WORKSPACE_CURRENT,
    repositoryIdentity: REPOSITORY_CURRENT,
    worktreeIdentity:
      operation === 'implementation' ? WORKTREE_AFTER : WORKTREE_CURRENT,
    ...(operation === 'push'
      ? {
          resourceIdentity: RESOURCE_AFTER,
          resourceRevisionIdentity: REVISION_B,
        }
      : {}),
    ...(operation === 'pr-creation'
      ? {
          resourceIdentity: RESOURCE_PR,
          pullRequest: { identity: RESOURCE_PR, state: 'open' },
          resourceRevisionIdentity: REVISION_B,
        }
      : {}),
    ...(operation === 'check-readback'
      ? {
          resourceIdentity: RESOURCE_PR,
          pullRequest: { identity: RESOURCE_PR, state: 'open' },
          resourceRevisionIdentity: REVISION_B,
          checkState: 'completed-success',
        }
      : {}),
    ...(operation === 'review-readback'
      ? {
          resourceIdentity: RESOURCE_PR,
          pullRequest: { identity: RESOURCE_PR, state: 'open' },
          resourceRevisionIdentity: REVISION_C,
          reviewDecision: 'approved',
        }
      : {}),
  }
  const context = {
    ...baseContext,
    ...(operation === 'push'
      ? {
          resourceIdentity: RESOURCE_AFTER,
          resourceRevisionIdentity: REVISION_A,
        }
      : {}),
    ...(operation === 'pr-creation' ? { resourceIdentity: RESOURCE_PR } : {}),
    ...(operation === 'verification'
      ? { workspaceIdentity: WORKSPACE_CURRENT }
      : {}),
    ...(operation === 'commit'
      ? { repositoryIdentity: REPOSITORY_BEFORE }
      : {}),
    ...(operation === 'check-readback' || operation === 'review-readback'
      ? {
          resourceIdentity: RESOURCE_PR,
          resourceRevisionIdentity: REVISION_B,
        }
      : {}),
  }
  return {
    callId: `call-${operation}`,
    operation,
    tool: tools[operation],
    ...(commands[operation] ? { command: commands[operation] } : {}),
    context,
    after,
    terminal: successTerminal,
    ...overrides,
  }
}

function createScenario(
  classifier: unknown,
  requiredOperations: readonly ReceiptOperation[] = [],
): {
  guard: OperationWorkflowGuard
  ledger: ReturnType<typeof createReceiptLedger>
} {
  const ledger = createReceiptLedger({
    registrationIdentity: 'operations-test',
  })
  const resourceScopes = Object.fromEntries(
    Object.entries({
      push: RESOURCE_AFTER,
      'pr-creation': RESOURCE_PR,
      'check-readback': RESOURCE_PR,
      'review-readback': RESOURCE_PR,
    }).filter(([operation]) =>
      requiredOperations.includes(operation as ReceiptOperation),
    ),
  )
  const guard = createWorkflowGuard({
    ledger,
    classifier,
    workspaceIdentity: WORKSPACE_CURRENT,
    repositoryIdentity: REPOSITORY_CURRENT,
    worktreeIdentity: WORKTREE_CURRENT,
    runtimeRequiredOperations: requiredOperations,
    runtimeResourceScopes: resourceScopes,
  } as WorkflowGuardOptions)
  const operationGuard = guard as OperationWorkflowGuard
  expect(
    operationGuard.activate({
      event: 'guarded-skill',
      skill: 'ce-work',
      outcome: 'success',
    }),
  ).toMatchObject({ status: 'activated' })
  expect(
    operationGuard.startUnit({ expectedOperations: requiredOperations }),
  ).toMatchObject({
    status: 'started',
  })
  return { guard: operationGuard, ledger }
}

function bindOperation(
  guard: OperationWorkflowGuard,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const status = guard.status()
  if (!status.epoch || !status.unit) throw new Error('workflow scope missing')
  return {
    ...input,
    context: {
      ...(input.context as Record<string, unknown>),
      epochId: status.epoch.epochId,
      unitId: status.unit.unitId,
    },
  }
}

function operationWithRevision(
  operation: ReceiptOperation,
  resourceIdentity: string,
  beforeRevision: string | undefined,
  afterRevision: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const input = operationInput(operation, overrides)
  return {
    ...input,
    context: {
      ...(input.context as Record<string, unknown>),
      resourceIdentity,
      ...(beforeRevision ? { resourceRevisionIdentity: beforeRevision } : {}),
    },
    after: {
      ...(input.after as Record<string, unknown>),
      resourceIdentity,
      ...(afterRevision ? { resourceRevisionIdentity: afterRevision } : {}),
    },
  }
}

function coherentFinalReadbacks(
  pushResourceIdentity = RESOURCE_REMOTE,
  workspaceIdentity = WORKSPACE_ZERO,
  repositoryIdentity = REPOSITORY_ONE,
  worktreeIdentity = WORKTREE_CURRENT,
): Array<Record<string, unknown>> {
  return [
    {
      workspaceIdentity,
      repositoryIdentity,
      worktreeIdentity,
    },
    {
      operation: 'push',
      workspaceIdentity,
      repositoryIdentity,
      worktreeIdentity,
      resourceIdentity: pushResourceIdentity,
      resourceRevisionIdentity: REVISION_B,
    },
    {
      operation: 'pr-creation',
      workspaceIdentity,
      repositoryIdentity,
      worktreeIdentity,
      resourceIdentity: RESOURCE_PR,
      resourceRevisionIdentity: REVISION_B,
      pullRequest: { identity: RESOURCE_PR, state: 'open' },
    },
    {
      operation: 'check-readback',
      workspaceIdentity,
      repositoryIdentity,
      worktreeIdentity,
      resourceIdentity: RESOURCE_PR,
      resourceRevisionIdentity: REVISION_B,
      pullRequest: { identity: RESOURCE_PR, state: 'open' },
      checkState: 'completed-success',
    },
    {
      operation: 'review-readback',
      workspaceIdentity,
      repositoryIdentity,
      worktreeIdentity,
      resourceIdentity: RESOURCE_PR,
      resourceRevisionIdentity: REVISION_C,
      pullRequest: { identity: RESOURCE_PR, state: 'open' },
      reviewDecision: 'approved',
    },
  ]
}

async function buildFullOperationScenario(): Promise<{
  classifier: ReturnType<typeof createReceiptClassifier>
  guard: OperationWorkflowGuard
  ledger: ReturnType<typeof createReceiptLedger>
}> {
  const classifier = createReceiptClassifier()
  const operations: ReceiptOperation[] = [
    'commit',
    'push',
    'pr-creation',
    'check-readback',
    'review-readback',
  ]
  const { guard, ledger } = createScenario(classifier, operations)
  const inputs = [
    operationInput('implementation', {
      callId: 'bundle-implementation',
      after: {
        ...operationInput('implementation').after,
        worktreeIdentity: WORKTREE_AFTER,
      },
    }),
    operationInput('verification', {
      callId: 'bundle-verification',
      context: {
        ...baseContext,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
      after: {
        ...operationInput('verification').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
    }),
    operationInput('commit', {
      callId: 'bundle-commit',
      context: {
        ...baseContext,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
      after: {
        ...operationInput('commit').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_AFTER,
        worktreeIdentity: WORKTREE_AFTER,
      },
    }),
    operationWithRevision('push', RESOURCE_AFTER, REVISION_A, REVISION_B, {
      callId: 'bundle-push',
      context: {
        ...baseContext,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_AFTER,
        worktreeIdentity: WORKTREE_AFTER,
      },
      after: {
        ...operationInput('push').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_AFTER,
        worktreeIdentity: WORKTREE_AFTER,
      },
    }),
    operationWithRevision('pr-creation', RESOURCE_PR, undefined, REVISION_B, {
      callId: 'bundle-pr',
      context: {
        ...baseContext,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_AFTER,
        worktreeIdentity: WORKTREE_AFTER,
      },
      after: {
        ...operationInput('pr-creation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_AFTER,
        worktreeIdentity: WORKTREE_AFTER,
      },
    }),
    operationWithRevision(
      'check-readback',
      RESOURCE_PR,
      REVISION_B,
      REVISION_B,
      {
        callId: 'bundle-check',
        context: {
          ...baseContext,
          workspaceIdentity: WORKSPACE_CURRENT,
          repositoryIdentity: REPOSITORY_AFTER,
          worktreeIdentity: WORKTREE_AFTER,
        },
        after: {
          ...operationInput('check-readback').after,
          workspaceIdentity: WORKSPACE_CURRENT,
          repositoryIdentity: REPOSITORY_AFTER,
          worktreeIdentity: WORKTREE_AFTER,
        },
      },
    ),
    operationWithRevision(
      'review-readback',
      RESOURCE_PR,
      REVISION_B,
      REVISION_C,
      {
        callId: 'bundle-review',
        context: {
          ...baseContext,
          workspaceIdentity: WORKSPACE_CURRENT,
          repositoryIdentity: REPOSITORY_AFTER,
          worktreeIdentity: WORKTREE_AFTER,
        },
        after: {
          ...operationInput('review-readback').after,
          workspaceIdentity: WORKSPACE_CURRENT,
          repositoryIdentity: REPOSITORY_AFTER,
          worktreeIdentity: WORKTREE_AFTER,
        },
      },
    ),
  ]
  for (const input of inputs) {
    const result = await guard.observeOperation(bindOperation(guard, input))
    expect(result).toMatchObject({ status: 'accepted' })
  }
  return { classifier, guard, ledger }
}

describe('receipt operation adapters', () => {
  test('recognizes all seven operation classes without returning command or resource data', async () => {
    const classifier =
      createReceiptClassifier() as unknown as OperationClassifier
    const operations: ReceiptOperation[] = [
      'implementation',
      'verification',
      'commit',
      'push',
      'pr-creation',
      'check-readback',
      'review-readback',
    ]

    for (const operation of operations) {
      const result = await classifier.classifyOperation(
        operationInput(operation),
      )
      expect(result).toMatchObject({
        outcome: 'accepted',
        category: operation,
        attribution: 'runtime-verified',
        result: 'success',
      })
      expect(JSON.stringify(result)).not.toContain('receipt guard')
      expect(JSON.stringify(result)).not.toContain('pr-42')
    }
  })

  test('requires class-specific side effects and readback state', async () => {
    const classifier =
      createReceiptClassifier() as unknown as OperationClassifier
    const noOps: Array<Record<string, unknown>> = [
      operationInput('implementation', {
        after: { ...operationInput('implementation').context },
      }),
      operationInput('commit', {
        after: { ...operationInput('commit').context },
      }),
      operationInput('push', {
        after: { ...operationInput('push').context },
      }),
      operationInput('pr-creation', {
        after: {
          ...operationInput('pr-creation').context,
          pullRequest: { identity: RESOURCE_BEFORE, state: 'open' },
        },
      }),
      operationInput('verification', {
        after: {
          ...operationInput('verification').context,
          workspaceIdentity: WORKSPACE_OTHER,
        },
      }),
      operationInput('check-readback', {
        after: {
          ...operationInput('check-readback').context,
          pullRequest: { identity: RESOURCE_PR, state: 'closed' },
          checkState: 'pending',
        },
      }),
      operationInput('review-readback', {
        after: {
          ...operationInput('review-readback').context,
          pullRequest: { identity: RESOURCE_PR, state: 'closed' },
          reviewDecision: 'commented',
        },
      }),
    ]

    for (const input of noOps) {
      const result = await classifier.classifyOperation(input)
      expect(result.outcome).toBe('rejected')
      expect(result.reasonCode).not.toBe('recognized-command')
    }
  })

  test('separates stable workspace targets from mutable implementation revisions', async () => {
    const classifier =
      createReceiptClassifier() as unknown as OperationClassifier
    const changedWorktree = await classifier.classifyOperation(
      operationInput('implementation', {
        after: {
          ...operationInput('implementation').after,
          workspaceIdentity: WORKSPACE_CURRENT,
          worktreeIdentity: WORKTREE_AFTER,
        },
        terminal: successTerminal,
      }),
    )
    expect(changedWorktree).toMatchObject({
      outcome: 'accepted',
      category: 'implementation',
    })

    for (const after of [
      {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_CURRENT,
      },
      {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: undefined,
      },
    ]) {
      expect(
        await classifier.classifyOperation(
          operationInput('implementation', { after }),
        ),
      ).toMatchObject({
        outcome: 'rejected',
        reasonCode: 'unchanged-worktree',
      })
    }

    expect(
      await classifier.classifyOperation(
        operationInput('implementation', {
          after: {
            ...operationInput('implementation').after,
            workspaceIdentity: WORKSPACE_OTHER,
            worktreeIdentity: WORKTREE_AFTER,
          },
        }),
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'workspace-mismatch',
    })

    expect(
      await classifier.classifyOperation(operationInput('verification')),
    ).toMatchObject({ outcome: 'accepted', category: 'verification' })
    expect(
      await classifier.classifyOperation(
        operationInput('verification', {
          after: {
            ...operationInput('verification').after,
            workspaceIdentity: WORKSPACE_OTHER,
            worktreeIdentity: WORKTREE_AFTER,
          },
        }),
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reasonCode: 'workspace-mismatch',
    })
  })

  test('rejects failures, cancellation, command/class mismatch, and privacy-bearing fields', async () => {
    const classifier =
      createReceiptClassifier() as unknown as OperationClassifier
    for (const status of ['failure', 'cancelled', 'running'] as const) {
      const result = await classifier.classifyOperation(
        operationInput('verification', {
          terminal: { status, output: 'non-empty', noOp: false },
        }),
      )
      expect(result.outcome).toBe('rejected')
    }
    expect(
      await classifier.classifyOperation(
        operationInput('verification', {
          terminal: { status: 'success', output: 'unknown', noOp: false },
        }),
      ),
    ).toMatchObject({ outcome: 'rejected' })

    const mismatch = await classifier.classifyOperation(
      operationInput('commit', {
        tool: 'gh',
        command: 'git commit -m "wrong tool"',
      }),
    )
    expect(mismatch).toMatchObject({ outcome: 'rejected', category: 'commit' })

    const privateInput = await classifier.classifyOperation(
      operationInput('verification', {
        stdout: 'secret output',
        env: { TOKEN: 'secret' },
        path: '/private/repo',
      }),
    )
    expect(privateInput).toMatchObject({ outcome: 'rejected' })
    expect(JSON.stringify(privateInput)).not.toContain('secret')
    expect(JSON.stringify(privateInput)).not.toContain('/private/repo')
  })

  test('rejects unrelated resources and non-operation tool identities without receipts', async () => {
    const classifier = createReceiptClassifier()
    const unrelated = operationInput('push', {
      after: {
        ...operationInput('push').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_CURRENT,
        resourceIdentity: RESOURCE_WRONG,
      },
    })
    expect(await classifier.classifyOperation(unrelated)).toMatchObject({
      outcome: 'rejected',
      category: 'push',
    })

    const { guard, ledger } = createScenario(classifier, ['push'])
    expect(
      await guard.observeOperation(bindOperation(guard, unrelated)),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'resource-mismatch',
    })
    expect(
      await guard.observeOperation(
        bindOperation(guard, {
          ...operationInput('push', {
            callId: 'custom-tool',
            after: {
              ...operationInput('push').after,
              workspaceIdentity: WORKSPACE_CURRENT,
              repositoryIdentity: REPOSITORY_CURRENT,
            },
          }),
          tool: 'systematic_workflow_start',
        }),
      ),
    ).toMatchObject({ status: 'rejected' })
    expect(ledger.listReceipts()).toHaveLength(0)
    await classifier.close()
  })

  test('binds operation before identities to guard state and seals mismatched calls', async () => {
    const classifier = createReceiptClassifier()
    const { guard, ledger } = createScenario(classifier)
    const mismatched = operationInput('implementation', {
      context: {
        ...operationInput('implementation').context,
        workspaceIdentity: WORKSPACE_OTHER,
        repositoryIdentity: REPOSITORY_BEFORE,
        worktreeIdentity: WORKTREE_ZERO,
      },
      after: {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_NEXT,
        repositoryIdentity: REPOSITORY_CURRENT,
        worktreeIdentity: WORKTREE_CURRENT,
      },
    })
    expect(
      await guard.observeOperation(bindOperation(guard, mismatched)),
    ).toMatchObject({ status: 'rejected', reasonCode: 'workspace-mismatch' })
    expect(
      await guard.observeOperation(
        bindOperation(guard, {
          ...mismatched,
          context: {
            ...(mismatched.context as Record<string, unknown>),
            workspaceIdentity: WORKSPACE_CURRENT,
            repositoryIdentity: REPOSITORY_CURRENT,
            worktreeIdentity: WORKTREE_CURRENT,
          },
        }),
      ),
    ).toMatchObject({ status: 'rejected' })
    expect(ledger.listReceipts()).toHaveLength(0)
    await classifier.close()
  })

  test('reports repository/worktree precondition drift as current-revision mismatch', async () => {
    const classifier = createReceiptClassifier()
    const { guard, ledger } = createScenario(classifier, ['implementation'])
    const drifted = operationInput('implementation', {
      context: {
        ...operationInput('implementation').context,
        repositoryIdentity: REPOSITORY_BEFORE,
        worktreeIdentity: WORKTREE_CURRENT,
      },
    })
    expect(
      await guard.observeOperation(bindOperation(guard, drifted)),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'receipt-mismatch',
    })
    expect(ledger.listReceipts()).toHaveLength(0)
    await classifier.close()
  })

  test('separates stable resource scope from digest-shaped mutable revision', async () => {
    const classifier = createReceiptClassifier()
    const valid = operationWithRevision(
      'push',
      RESOURCE_AFTER,
      REVISION_A,
      REVISION_B,
    )
    expect(await classifier.classifyOperation(valid)).toMatchObject({
      outcome: 'accepted',
      category: 'push',
    })

    for (const identity of [
      '/repo/.git',
      'https://example.test/repo',
      'main',
    ]) {
      const result = await classifier.classifyOperation(
        operationWithRevision('push', identity, identity, REVISION_B),
      )
      expect(result).toMatchObject({ outcome: 'rejected' })
      expect(JSON.stringify(result)).not.toContain(identity)
    }

    const { guard, ledger } = createScenario(classifier, ['push'])
    expect(
      await guard.observeOperation(
        bindOperation(
          guard,
          operationWithRevision('push', RESOURCE_WRONG, REVISION_A, REVISION_B),
        ),
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'resource-mismatch' })
    expect(ledger.listReceipts()).toHaveLength(0)
    await classifier.close()
  })

  test('requires digest-shaped identities for every U4 operation state field', async () => {
    const classifier = createReceiptClassifier()
    const cases = [
      ['workspaceIdentity', '/repo/workspace'],
      ['repositoryIdentity', 'https://example.test/repo'],
      ['worktreeIdentity', 'worktree prose'],
      ['resourceIdentity', 'origin/main'],
      ['resourceRevisionIdentity', 'revision prose'],
    ] as const
    for (const [field, raw] of cases) {
      const operation = field.startsWith('resource') ? 'push' : 'verification'
      const input = operationInput(operation, {
        context: {
          ...(operationInput(operation).context as Record<string, unknown>),
          [field]: raw,
        },
        after: {
          ...(operationInput(operation).after as Record<string, unknown>),
          [field]: raw,
        },
      })
      const result = await classifier.classifyOperation(input)
      expect(result).toMatchObject({ outcome: 'rejected' })
      expect(JSON.stringify(result)).not.toContain(raw)
    }
    expect(
      await classifier.classifyOperation(operationInput('verification')),
    ).toMatchObject({ outcome: 'accepted' })
    await classifier.close()
  })

  test('binds each mutable resource before revision to the trusted current baseline', async () => {
    const operations: Array<{
      operation: ReceiptOperation
      scope: string
      firstBefore?: string
      firstAfter: string
    }> = [
      {
        operation: 'push',
        scope: RESOURCE_AFTER,
        firstBefore: REVISION_A,
        firstAfter: REVISION_B,
      },
      {
        operation: 'pr-creation',
        scope: RESOURCE_PR,
        firstAfter: REVISION_B,
      },
      {
        operation: 'check-readback',
        scope: RESOURCE_PR,
        firstBefore: REVISION_B,
        firstAfter: REVISION_B,
      },
      {
        operation: 'review-readback',
        scope: RESOURCE_PR,
        firstBefore: REVISION_B,
        firstAfter: REVISION_C,
      },
    ]
    for (const [index, item] of operations.entries()) {
      const classifier = createReceiptClassifier()
      const { guard } = createScenario(classifier, [item.operation])
      const first = operationWithRevision(
        item.operation,
        item.scope,
        item.firstBefore,
        item.firstAfter,
        { callId: `revision-first-${index}` },
      )
      expect(
        await guard.observeOperation(bindOperation(guard, first)),
      ).toMatchObject({ status: 'accepted' })
      const invalid = operationWithRevision(
        item.operation,
        item.scope,
        REVISION_A,
        REVISION_C,
        { callId: `revision-invalid-${index}` },
      )
      expect(
        await guard.observeOperation(bindOperation(guard, invalid)),
      ).toMatchObject({ status: 'rejected' })
      const valid = operationWithRevision(
        item.operation,
        item.scope,
        item.firstAfter,
        REVISION_C,
        { callId: `revision-valid-${index}` },
      )
      expect(
        await guard.observeOperation(bindOperation(guard, valid)),
      ).toMatchObject({ status: 'accepted' })
      await classifier.close()
    }
  })

  test('mints one receipt per observed operation and rejects replay/conflicting intent', async () => {
    const classifier = createReceiptClassifier()
    const { guard, ledger } = createScenario(classifier)
    const input = operationInput('implementation')

    expect(
      await guard.observeOperation(bindOperation(guard, input)),
    ).toMatchObject({
      status: 'accepted',
      operation: 'implementation',
    })
    expect(
      await guard.observeOperation(bindOperation(guard, input)),
    ).toMatchObject({
      status: 'rejected',
    })
    expect(
      await guard.observeOperation(
        bindOperation(guard, {
          ...operationInput('commit', { callId: input.callId }),
          context: input.context,
        }),
      ),
    ).toMatchObject({ status: 'rejected' })
    expect(ledger.listReceipts()).toHaveLength(1)
    await classifier.close()
  })

  test('terminal failed, malformed, and missing-after calls cannot retry into success', async () => {
    const classifier = createReceiptClassifier()
    const failed = createScenario(classifier)
    const failedInput = operationInput('implementation', {
      after: {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
      },
      terminal: { status: 'failure', output: 'non-empty', noOp: false },
    })
    expect(
      await failed.guard.observeOperation(
        bindOperation(failed.guard, failedInput),
      ),
    ).toMatchObject({ status: 'rejected' })
    expect(
      await failed.guard.observeOperation(
        bindOperation(failed.guard, {
          ...failedInput,
          terminal: successTerminal,
        }),
      ),
    ).toMatchObject({ status: 'rejected' })
    expect(failed.ledger.listReceipts()).toHaveLength(0)

    const malformed = createScenario(classifier)
    const malformedInput = {
      ...operationInput('implementation'),
      after: undefined,
      unexpected: 'raw output',
    }
    expect(
      await malformed.guard.observeOperation(
        bindOperation(malformed.guard, malformedInput),
      ),
    ).toMatchObject({
      status: 'rejected',
    })
    expect(
      await malformed.guard.observeOperation(
        bindOperation(malformed.guard, {
          ...operationInput('implementation'),
          callId: malformedInput.callId,
          after: {
            ...operationInput('implementation').after,
            workspaceIdentity: WORKSPACE_CURRENT,
          },
        }),
      ),
    ).toMatchObject({ status: 'rejected' })

    const missingAfter = createScenario(classifier)
    const missingInput = { ...operationInput('verification'), after: undefined }
    expect(
      await missingAfter.guard.observeOperation(
        bindOperation(missingAfter.guard, missingInput),
      ),
    ).toMatchObject({
      status: 'rejected',
    })
    expect(
      await missingAfter.guard.observeOperation(
        bindOperation(missingAfter.guard, {
          ...missingInput,
          after: operationInput('verification').after,
        }),
      ),
    ).toMatchObject({ status: 'rejected' })
    await classifier.close()
  })

  test('successful no-op evidence is bounded and cannot be retried with the same host call', async () => {
    const classifier = createReceiptClassifier()
    const { guard, ledger } = createScenario(classifier)
    const noOp = operationInput('implementation', {
      context: {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_CURRENT,
        worktreeIdentity: WORKTREE_CURRENT,
      },
      after: {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_CURRENT,
        worktreeIdentity: WORKTREE_CURRENT,
      },
    })
    expect(
      await guard.observeOperation(bindOperation(guard, noOp)),
    ).toMatchObject({ status: 'rejected' })
    expect(
      await guard.observeOperation(
        bindOperation(guard, {
          ...noOp,
          after: { ...noOp.after, workspaceIdentity: WORKSPACE_NEXT },
        }),
      ),
    ).toMatchObject({ status: 'rejected' })
    expect(ledger.listReceipts()).toHaveLength(0)
    await classifier.close()
  })

  test('keeps the coherent operation chain satisfied as guard state progresses', async () => {
    const classifier = createReceiptClassifier()
    const ledger = createReceiptLedger({
      registrationIdentity: 'coherent-chain',
    })
    const guard = createWorkflowGuard({
      ledger,
      classifier,
      workspaceIdentity: WORKSPACE_ZERO,
      repositoryIdentity: REPOSITORY_ZERO,
      worktreeIdentity: WORKTREE_ZERO,
      runtimeRequiredOperations: [
        'commit',
        'push',
        'pr-creation',
        'check-readback',
        'review-readback',
      ],
      runtimeResourceScopes: {
        push: RESOURCE_REMOTE,
        'pr-creation': RESOURCE_PR,
        'check-readback': RESOURCE_PR,
        'review-readback': RESOURCE_PR,
      },
    } as WorkflowGuardOptions) as OperationWorkflowGuard
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

    const chain = [
      operationInput('implementation', {
        callId: 'chain-implementation',
        context: {
          ...baseContext,
          epochId: 'epoch-placeholder',
          unitId: 'unit-placeholder',
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ZERO,
          worktreeIdentity: WORKTREE_INITIAL,
        },
        after: {
          ...operationInput('implementation').after,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ZERO,
          worktreeIdentity: WORKTREE_CURRENT,
        },
      }),
      operationInput('verification', {
        callId: 'chain-verification',
        context: {
          ...baseContext,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ZERO,
          worktreeIdentity: WORKTREE_CURRENT,
        },
        after: {
          ...operationInput('verification').after,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ZERO,
          worktreeIdentity: WORKTREE_CURRENT,
        },
      }),
      operationInput('commit', {
        callId: 'chain-commit',
        context: {
          ...baseContext,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ZERO,
          worktreeIdentity: WORKTREE_CURRENT,
        },
        after: {
          ...operationInput('commit').after,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ONE,
          worktreeIdentity: WORKTREE_CURRENT,
        },
      }),
      operationWithRevision('push', RESOURCE_REMOTE, REVISION_A, REVISION_B, {
        callId: 'chain-push',
        context: {
          ...baseContext,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ONE,
          worktreeIdentity: WORKTREE_CURRENT,
        },
        after: {
          ...operationInput('push').after,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ONE,
          worktreeIdentity: WORKTREE_CURRENT,
        },
      }),
      operationWithRevision('pr-creation', RESOURCE_PR, undefined, REVISION_B, {
        callId: 'chain-pr',
        context: {
          ...baseContext,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ONE,
          worktreeIdentity: WORKTREE_CURRENT,
        },
        after: {
          ...operationInput('pr-creation').after,
          workspaceIdentity: WORKSPACE_ZERO,
          repositoryIdentity: REPOSITORY_ONE,
          worktreeIdentity: WORKTREE_CURRENT,
        },
      }),
      operationWithRevision(
        'check-readback',
        RESOURCE_PR,
        REVISION_B,
        REVISION_B,
        {
          callId: 'chain-check',
          context: {
            ...baseContext,
            workspaceIdentity: WORKSPACE_ZERO,
            repositoryIdentity: REPOSITORY_ONE,
            worktreeIdentity: WORKTREE_CURRENT,
            resourceIdentity: RESOURCE_PR,
          },
          after: {
            ...operationInput('check-readback').after,
            workspaceIdentity: WORKSPACE_ZERO,
            repositoryIdentity: REPOSITORY_ONE,
            worktreeIdentity: WORKTREE_CURRENT,
          },
        },
      ),
      operationWithRevision(
        'review-readback',
        RESOURCE_PR,
        REVISION_B,
        REVISION_C,
        {
          callId: 'chain-review',
          context: {
            ...baseContext,
            workspaceIdentity: WORKSPACE_ZERO,
            repositoryIdentity: REPOSITORY_ONE,
            worktreeIdentity: WORKTREE_CURRENT,
            resourceIdentity: RESOURCE_PR,
          },
          after: {
            ...operationInput('review-readback').after,
            workspaceIdentity: WORKSPACE_ZERO,
            repositoryIdentity: REPOSITORY_ONE,
            worktreeIdentity: WORKTREE_CURRENT,
          },
        },
      ),
    ]
    for (const input of chain) {
      const result = await guard.observeOperation(bindOperation(guard, input))
      expect(result).toMatchObject({ status: 'accepted' })
      if (input.operation === 'commit') {
        expect(guard.status().satisfiedOperations).toEqual([
          'implementation',
          'verification',
          'commit',
        ])
      }
    }
    expect(guard.status()).toMatchObject({
      state: 'protected',
      satisfiedOperations: [
        'implementation',
        'verification',
        'commit',
        'push',
        'pr-creation',
        'check-readback',
        'review-readback',
      ],
    })
    const prepared = guard.prepareTransition({
      callId: 'chain-transition',
      target: 'unit',
    })
    expect(prepared).toMatchObject({ status: 'allowed' })
    if (prepared.status !== 'allowed')
      throw new Error('transition did not prepare')
    expect(
      guard.finalizeTransition({
        callId: 'chain-transition',
        transitionId: prepared.transitionId,
        readbacks: coherentFinalReadbacks(),
      }),
    ).toMatchObject({ status: 'completed' })
    await classifier.close()
  })

  test('requires a complete fresh final readback bundle for U4 evidence', async () => {
    const { guard, ledger, classifier } = await buildFullOperationScenario()
    const prepared = guard.prepareTransition({
      callId: 'bundle-missing-transition',
      target: 'unit',
    })
    expect(prepared).toMatchObject({ status: 'allowed' })
    if (prepared.status !== 'allowed')
      throw new Error('transition did not prepare')
    expect(
      guard.finalizeTransition({
        callId: 'bundle-missing-transition',
        transitionId: prepared.transitionId,
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'missing-evidence' })
    expect(
      ledger
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'available'),
    ).toBe(true)
    await classifier.close()
  })

  test('finalizes U4 evidence only with honest global and resource readbacks', async () => {
    const { guard, ledger, classifier } = await buildFullOperationScenario()
    const prepared = guard.prepareTransition({
      callId: 'bundle-valid-transition',
      target: 'unit',
    })
    expect(prepared).toMatchObject({ status: 'allowed' })
    if (prepared.status !== 'allowed')
      throw new Error('transition did not prepare')
    expect(
      guard.finalizeTransition({
        callId: 'bundle-valid-transition',
        transitionId: prepared.transitionId,
        readbacks: coherentFinalReadbacks(
          RESOURCE_AFTER,
          WORKSPACE_CURRENT,
          REPOSITORY_AFTER,
          WORKTREE_AFTER,
        ),
      }),
    ).toMatchObject({ status: 'completed' })
    expect(
      ledger
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'consumed'),
    ).toBe(true)
    await classifier.close()
  })

  test('rejects malformed, duplicate, combined, and oversized final bundles atomically', async () => {
    const variants: Array<
      (bundle: Array<Record<string, unknown>>) => Record<string, unknown>
    > = [
      (bundle) => ({ readbacks: bundle.slice(0, 1) }),
      (bundle) => ({
        readbacks: [...bundle, bundle[1]],
      }),
      (bundle) => ({ readback: bundle[0], readbacks: bundle }),
      (bundle) => ({ readbacks: Array.from({ length: 9 }, () => bundle[0]) }),
    ]
    for (const [index, variant] of variants.entries()) {
      const { guard, ledger, classifier } = await buildFullOperationScenario()
      const prepared = guard.prepareTransition({
        callId: `bundle-invalid-transition-${index}`,
        target: 'unit',
      })
      expect(prepared).toMatchObject({ status: 'allowed' })
      if (prepared.status !== 'allowed')
        throw new Error('transition did not prepare')
      expect(
        guard.finalizeTransition({
          callId: `bundle-invalid-transition-${index}`,
          transitionId: prepared.transitionId,
          ...variant(
            coherentFinalReadbacks(
              RESOURCE_AFTER,
              WORKSPACE_AFTER,
              REPOSITORY_AFTER,
              WORKTREE_CURRENT,
            ),
          ),
        }),
      ).toMatchObject({ status: 'rejected' })
      expect(
        ledger
          .listReceipts()
          .every((receipt) => receipt.canonical.consumption === 'available'),
      ).toBe(true)
      await classifier.close()
    }
  })

  test('rejects every final readback drift without consuming any receipt', async () => {
    const driftBundles: Array<
      (bundle: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    > = [
      (bundle) =>
        bundle.map((readback) => ({
          ...readback,
          workspaceIdentity: WORKSPACE_NEXT,
        })),
      (bundle) =>
        bundle.map((readback) => ({
          ...readback,
          repositoryIdentity: REPOSITORY_NEW,
        })),
      (bundle) =>
        bundle.map((readback) =>
          readback.operation === 'push'
            ? { ...readback, resourceRevisionIdentity: REVISION_C }
            : readback,
        ),
      (bundle) =>
        bundle.map((readback) =>
          readback.operation === 'pr-creation'
            ? {
                ...readback,
                pullRequest: { identity: RESOURCE_PR, state: 'closed' },
              }
            : readback,
        ),
      (bundle) =>
        bundle.map((readback) =>
          readback.operation === 'check-readback'
            ? { ...readback, checkState: 'pending' }
            : readback,
        ),
      (bundle) =>
        bundle.map((readback) =>
          readback.operation === 'review-readback'
            ? { ...readback, reviewDecision: 'commented' }
            : readback,
        ),
    ]
    for (const [index, createDrift] of driftBundles.entries()) {
      const { guard, ledger, classifier } = await buildFullOperationScenario()
      const prepared = guard.prepareTransition({
        callId: `bundle-drift-transition-${index}`,
        target: 'unit',
      })
      expect(prepared).toMatchObject({ status: 'allowed' })
      if (prepared.status !== 'allowed')
        throw new Error('transition did not prepare')
      expect(
        guard.finalizeTransition({
          callId: `bundle-drift-transition-${index}`,
          transitionId: prepared.transitionId,
          readbacks: createDrift(
            coherentFinalReadbacks(
              RESOURCE_AFTER,
              WORKSPACE_AFTER,
              REPOSITORY_AFTER,
              WORKTREE_CURRENT,
            ),
          ),
        }),
      ).toMatchObject({ status: 'rejected' })
      expect(
        ledger
          .listReceipts()
          .every((receipt) => receipt.canonical.consumption === 'available'),
      ).toBe(true)
      await classifier.close()
    }
  })

  test('marks verification and dependent evidence stale after a later revision change, but not after a no-op readback', async () => {
    const classifier = createReceiptClassifier()
    const { guard } = createScenario(classifier)
    const implementation = operationInput('implementation', {
      after: {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
      },
    })
    const verification = operationInput('verification', {
      context: {
        ...operationInput('verification').context,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
      after: {
        ...operationInput('verification').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
    })
    expect(
      await guard.observeOperation(bindOperation(guard, implementation)),
    ).toMatchObject({ status: 'accepted' })
    expect(
      await guard.observeOperation(bindOperation(guard, verification)),
    ).toMatchObject({ status: 'accepted' })
    expect(guard.status()).toMatchObject({ state: 'protected' })

    expect(
      guard.observeReadback({
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      }),
    ).toMatchObject({ status: 'accepted', changed: false })
    expect(guard.status()).toMatchObject({ state: 'protected' })

    expect(
      guard.observeReadback({
        workspaceIdentity: WORKSPACE_CURRENT,
        repositoryIdentity: REPOSITORY_CURRENT,
        worktreeIdentity: WORKTREE_ZERO,
      }),
    ).toMatchObject({ status: 'accepted', changed: true })
    expect(guard.status()).toMatchObject({
      state: 'rejected',
      reasonCode: 'stale-receipt',
      satisfiedOperations: ['implementation'],
      missingOperations: ['verification'],
    })

    const freshVerification = operationInput('verification', {
      callId: 'fresh-verification',
      context: {
        ...operationInput('verification').context,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_ZERO,
      },
      after: {
        ...operationInput('verification').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_ZERO,
      },
    })
    expect(
      await guard.observeOperation(bindOperation(guard, freshVerification)),
    ).toMatchObject({ status: 'accepted' })
    expect(guard.status().satisfiedOperations).toEqual([
      'implementation',
      'verification',
    ])
    await classifier.close()
  })

  test('final compare-and-consume readback rejects interleaving changes without consuming receipts', async () => {
    const classifier = createReceiptClassifier()
    const { guard, ledger } = createScenario(classifier)
    const implementation = operationInput('implementation', {
      after: {
        ...operationInput('implementation').after,
        workspaceIdentity: WORKSPACE_CURRENT,
      },
    })
    const verification = operationInput('verification', {
      context: {
        ...operationInput('verification').context,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
      after: {
        ...operationInput('verification').after,
        workspaceIdentity: WORKSPACE_CURRENT,
        worktreeIdentity: WORKTREE_AFTER,
      },
    })
    expect(
      await guard.observeOperation(bindOperation(guard, implementation)),
    ).toMatchObject({ status: 'accepted' })
    expect(
      await guard.observeOperation(bindOperation(guard, verification)),
    ).toMatchObject({ status: 'accepted' })
    const prepared = guard.prepareTransition({
      callId: 'toctou',
      target: 'unit',
    })
    expect(prepared.status).toBe('allowed')
    if (prepared.status !== 'allowed')
      throw new Error('transition did not prepare')

    const result = guard.finalizeTransition({
      callId: 'toctou',
      transitionId: prepared.transitionId,
      readbacks: [
        {
          workspaceIdentity: WORKSPACE_CURRENT,
          repositoryIdentity: REPOSITORY_CURRENT,
          worktreeIdentity: WORKTREE_ZERO,
        },
      ],
    })
    expect(result).toMatchObject({
      status: 'rejected',
      reasonCode: 'stale-receipt',
    })
    expect(
      ledger
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'available'),
    ).toBe(true)
    await classifier.close()
  })

  test('PR state changes stale shipping evidence during final readback', async () => {
    const classifier = createReceiptClassifier()
    const { guard, ledger } = createScenario(classifier, ['pr-creation'])
    for (const input of [
      operationInput('implementation', {
        after: {
          ...operationInput('implementation').after,
          workspaceIdentity: WORKSPACE_CURRENT,
        },
      }),
      operationInput('verification', {
        context: {
          ...operationInput('verification').context,
          workspaceIdentity: WORKSPACE_CURRENT,
          worktreeIdentity: WORKTREE_AFTER,
        },
        after: {
          ...operationInput('verification').after,
          workspaceIdentity: WORKSPACE_CURRENT,
          worktreeIdentity: WORKTREE_AFTER,
        },
      }),
      operationInput('pr-creation', {
        callId: 'pr-state-change',
        context: {
          ...operationInput('pr-creation').context,
          workspaceIdentity: WORKSPACE_CURRENT,
          worktreeIdentity: WORKTREE_AFTER,
        },
        after: {
          ...operationInput('pr-creation').after,
          workspaceIdentity: WORKSPACE_CURRENT,
          repositoryIdentity: REPOSITORY_CURRENT,
          worktreeIdentity: WORKTREE_AFTER,
        },
      }),
    ]) {
      expect(
        await guard.observeOperation(bindOperation(guard, input)),
      ).toMatchObject({
        status: 'accepted',
      })
    }

    const prepared = guard.prepareTransition({
      callId: 'pr-state-transition',
      target: 'unit',
    })
    expect(prepared).toMatchObject({ status: 'allowed' })
    if (prepared.status !== 'allowed')
      throw new Error('transition did not prepare')
    expect(
      guard.finalizeTransition({
        callId: 'pr-state-transition',
        transitionId: prepared.transitionId,
        readbacks: [
          {
            workspaceIdentity: WORKSPACE_AFTER,
            repositoryIdentity: REPOSITORY_CURRENT,
            worktreeIdentity: WORKTREE_CURRENT,
          },
          {
            operation: 'pr-creation',
            workspaceIdentity: WORKSPACE_AFTER,
            repositoryIdentity: REPOSITORY_CURRENT,
            worktreeIdentity: WORKTREE_CURRENT,
            resourceIdentity: RESOURCE_PR,
            resourceRevisionIdentity: REVISION_B,
            pullRequest: { identity: RESOURCE_PR, state: 'closed' },
          },
        ],
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'stale-receipt' })
    expect(
      ledger
        .listReceipts()
        .every((receipt) => receipt.canonical.consumption === 'available'),
    ).toBe(true)
    await classifier.close()
  })
})
