import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import {
  createReceiptClassifier,
  type ReceiptClassifier,
  type ReceiptOperation,
} from '../../src/lib/receipt-classifier.js'
import {
  createReceiptLedger,
  type FinalizeObservationResult,
  type ReceiptClassification,
} from '../../src/lib/receipt-ledger.js'

/** `classifyOperation` is optional on the interface (some classifiers only support `classify`), but `createReceiptClassifier` always implements it. */
function callClassifyOperation(
  classifier: ReceiptClassifier,
  input: unknown,
): Promise<ReceiptClassification> {
  const { classifyOperation } = classifier
  if (!classifyOperation) {
    throw new Error('Expected classifier.classifyOperation to be defined')
  }
  return classifyOperation.call(classifier, input)
}

function assertFinalized(
  result: FinalizeObservationResult,
): asserts result is Extract<
  FinalizeObservationResult,
  { status: 'finalized' }
> {
  if (result.status !== 'finalized') {
    throw new Error(`Expected a finalized result, got status: ${result.status}`)
  }
}

const successfulTerminal = {
  status: 'success' as const,
  output: 'non-empty' as const,
  noOp: false,
}

const positiveCommands: Array<[ReceiptOperation, string]> = [
  ['implementation', 'git apply change.patch'],
  ['verification', 'bun test tests/unit/example.test.ts'],
  ['commit', 'git commit -m "implement receipt guard"'],
  ['push', 'git push origin HEAD'],
  ['pr-creation', 'gh pr create --title "Receipt guard" --body "Details"'],
  ['check-readback', 'gh pr checks 42'],
  ['review-readback', 'gh pr view 42 --json reviews'],
]

describe('receipt classifier', () => {
  test('accepts each operation class only with a representative successful terminal result', async () => {
    const classifier = createReceiptClassifier()

    for (const [category, command] of positiveCommands) {
      const result = await classifier.classify({
        command,
        terminal: successfulTerminal,
      })
      expect(result).toMatchObject({
        outcome: 'accepted',
        category,
        attribution: 'runtime-verified',
        result: 'success',
        reasonCode: 'recognized-command',
      })
      expect(result).not.toHaveProperty('command')
      expect(JSON.stringify(result)).not.toContain(command)
    }

    await classifier.close()
  })

  test('accepts non-destructive git push forms and rejects destructive push intents', async () => {
    const classifier = createReceiptClassifier()
    const accepted = [
      'git push',
      'git push origin',
      'git push origin main',
      'git push origin HEAD',
      'git push -u origin main',
      'git push --set-upstream origin main',
      'git push origin HEAD:main',
    ]
    for (const command of accepted) {
      await expect(
        classifier.classify({ command, terminal: successfulTerminal }),
      ).resolves.toMatchObject({
        outcome: 'accepted',
        category: 'push',
      })
    }
    for (const command of [
      'git push origin +HEAD:main',
      'git push origin +refs/heads/main:main',
      'git push origin :branch',
      'git push --delete origin branch',
      'git push -d origin branch',
      'git push --force origin main',
      'git push --force=if-stale origin main',
      'git push -f origin main',
      'git push --force-with-lease origin main',
      'git push --force-with-lease=origin/main origin main',
      'git push --mirror origin',
      'git push --prune origin main',
      'git push -- origin main',
      'git push origin main; rm -rf /',
    ]) {
      const result = await classifier.classify({
        command,
        terminal: successfulTerminal,
      })
      expect(result).toMatchObject({ outcome: 'rejected' })
      expect(result.category).not.toBe('push')
    }
    await classifier.close()
  })

  test('accepts an allowed environment and cwd prefix in an ordered && chain', async () => {
    const classifier = createReceiptClassifier()
    const result = await classifier.classify({
      command: 'CI=1 cd src && bun test tests/unit/example.test.ts',
      terminal: successfulTerminal,
    })

    expect(result).toMatchObject({
      outcome: 'accepted',
      category: 'verification',
      attribution: 'runtime-verified',
      result: 'success',
    })
    await classifier.close()
  })

  test('allows only benign CI environment prefixes and relative descendant cwd prefixes', async () => {
    const classifier = createReceiptClassifier()
    for (const command of [
      'CI=1 bun test tests/unit/example.test.ts',
      'CI=true cd ./src && bun test tests/unit/example.test.ts',
      'cd src/lib && bun test tests/unit/example.test.ts',
    ]) {
      const result = await classifier.classify({
        command,
        terminal: successfulTerminal,
      })
      expect(result.outcome).toBe('accepted')
    }

    for (const command of [
      'PATH=/tmp bun test tests/unit/example.test.ts',
      'BASH_ENV=something bun test tests/unit/example.test.ts',
      'GIT_SSH_COMMAND=ssh bun test tests/unit/example.test.ts',
      'NODE_OPTIONS=--require evil bun test tests/unit/example.test.ts',
      'cd /tmp && bun test tests/unit/example.test.ts',
      'cd ../outside && bun test tests/unit/example.test.ts',
      'cd src/../../outside && bun test tests/unit/example.test.ts',
      'cd ~ && bun test tests/unit/example.test.ts',
      'cd "" && bun test tests/unit/example.test.ts',
    ]) {
      const result = await classifier.classify({
        command,
        terminal: successfulTerminal,
      })
      expect(result.outcome).toBe('rejected')
    }
    await classifier.close()
  })

  test('classifies terminal failures without treating parsing as execution proof', async () => {
    const classifier = createReceiptClassifier()

    for (const [category, command] of positiveCommands) {
      const result = await classifier.classify({
        command,
        terminal: { status: 'failure', output: 'non-empty', noOp: false },
      })
      expect(result).toMatchObject({
        outcome: 'rejected',
        category,
        result: 'failure',
        reasonCode: 'terminal-failure',
      })
    }

    await classifier.close()
  })

  test('rejects operation-specific near misses for every operation class', async () => {
    const classifier = createReceiptClassifier()
    const nearMisses = [
      'git apply --check change.patch',
      'bun run test',
      'bun test --filter receipt',
      'git diff --check unrelated.patch',
      'git commit --amend -m "amended"',
      'git commit -m ""',
      'git push --delete origin main',
      'gh pr create --dry-run --title "Title" --body "Body"',
      'gh pr create --title "" --body ""',
      'gh pr checks not-a-number',
      'gh pr view 42 --json files',
    ]

    for (const command of nearMisses) {
      const result = await classifier.classify({
        command,
        terminal: successfulTerminal,
      })
      expect(result).toMatchObject({ outcome: 'rejected' })
      expect(result.reasonCode).not.toBe('recognized-command')
    }
    await classifier.close()
  })

  test('rejects successful empty and no-op terminal results', async () => {
    const classifier = createReceiptClassifier()
    const empty = await classifier.classify({
      command: 'git status --short',
      terminal: { status: 'success', output: 'empty', noOp: false },
    })
    expect(empty).toMatchObject({
      outcome: 'rejected',
      result: 'success',
      reasonCode: 'empty-result',
    })

    const noOp = await classifier.classify({
      command: 'git status --short',
      terminal: { status: 'success', output: 'non-empty', noOp: true },
    })
    expect(noOp).toMatchObject({
      outcome: 'rejected',
      result: 'success',
      reasonCode: 'successful-no-op',
    })
    await classifier.close()
  })

  test('requires commit closure in operation observations', async () => {
    const classifier = createReceiptClassifier()
    const identity = 'a'.repeat(64)
    const base = {
      callId: 'commit-closure',
      operation: 'commit' as const,
      tool: 'bash' as const,
      command: 'git commit -m "closed"',
      context: {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: identity,
        repositoryIdentity: 'b'.repeat(64),
        worktreeIdentity: 'c'.repeat(64),
      },
      terminal: successfulTerminal,
    }
    const open = await callClassifyOperation(classifier, {
      ...base,
      after: {
        workspaceIdentity: identity,
        repositoryIdentity: 'd'.repeat(64),
        worktreeIdentity: 'e'.repeat(64),
        commitClosure: false,
      },
    })
    expect(open).toMatchObject({
      outcome: 'rejected',
      category: 'commit',
      reasonCode: 'no-op-resource',
    })

    const closed = await callClassifyOperation(classifier, {
      ...base,
      after: {
        workspaceIdentity: identity,
        repositoryIdentity: 'd'.repeat(64),
        worktreeIdentity: 'e'.repeat(64),
        commitClosure: true,
      },
    })
    expect(closed).toMatchObject({
      outcome: 'accepted',
      category: 'commit',
    })
    await classifier.close()
  })

  test('accepts implementation observations with the optional closure field', async () => {
    const classifier = createReceiptClassifier()
    const identity = 'a'.repeat(64)
    const result = await callClassifyOperation(classifier, {
      callId: 'implementation-closure-field',
      operation: 'implementation',
      tool: 'write',
      context: {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: identity,
        repositoryIdentity: 'b'.repeat(64),
        worktreeIdentity: 'c'.repeat(64),
      },
      after: {
        workspaceIdentity: identity,
        repositoryIdentity: 'b'.repeat(64),
        worktreeIdentity: 'd'.repeat(64),
        commitClosure: true,
      },
      terminal: successfulTerminal,
    })
    expect(result).toMatchObject({
      outcome: 'accepted',
      category: 'implementation',
    })
    await classifier.close()
  })

  test('does not let a non-shell write claim a commit operation', async () => {
    const classifier = createReceiptClassifier()
    const identity = 'a'.repeat(64)
    const result = await callClassifyOperation(classifier, {
      callId: 'non-shell-commit-claim',
      operation: 'commit',
      tool: 'write',
      context: {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: identity,
        repositoryIdentity: 'b'.repeat(64),
        worktreeIdentity: 'c'.repeat(64),
      },
      after: {
        workspaceIdentity: identity,
        repositoryIdentity: 'd'.repeat(64),
        worktreeIdentity: 'e'.repeat(64),
        commitClosure: true,
      },
      terminal: successfulTerminal,
    })

    expect(result.outcome).toBe('rejected')
    expect(result.category).not.toBe('commit')
    await classifier.close()
  })

  test('rejects prohibited shell shapes without a string fallback', async () => {
    const classifier = createReceiptClassifier()
    const prohibited = [
      'git status || true',
      'git status --short | cat',
      'git status; git diff',
      '$(git status --short)',
      '(git status --short)',
      'bash -c "git status --short"',
      'eval "git status --short"',
      'git status --short > result.txt',
      '$COMMAND status',
    ]

    for (const command of prohibited) {
      const result = await classifier.classify({
        command,
        terminal: successfulTerminal,
      })
      expect(result.outcome).toBe('rejected')
      expect(result.reasonCode).not.toBe('recognized-command')
      expect(result).not.toHaveProperty('command')
    }

    await classifier.close()
  })

  test('returns a bounded parser failure for invalid Bash syntax', async () => {
    const classifier = createReceiptClassifier()
    const result = await classifier.classify({
      command: 'git status "',
      terminal: successfulTerminal,
    })

    expect(result).toMatchObject({
      outcome: 'rejected',
      category: null,
      result: 'unknown',
      reasonCode: 'parser-failure',
    })
    await classifier.close()
  })

  test('reports missing parser assets as bounded unavailable results', async () => {
    const classifier = createReceiptClassifier({
      treeSitterWasmPath: '/definitely/missing/tree-sitter.wasm',
    })
    const result = await classifier.classify({
      command: 'git status --short',
      terminal: successfulTerminal,
    })

    expect(result).toMatchObject({
      outcome: 'unavailable',
      reasonCode: 'parser-asset-unavailable',
      category: null,
      result: 'unknown',
    })
    await classifier.close()
  })

  test('reports incompatible grammar assets as bounded unavailable results', async () => {
    const incompatibleGrammar = fileURLToPath(
      import.meta.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    )
    const classifier = createReceiptClassifier({
      bashWasmPath: incompatibleGrammar,
    })
    const result = await classifier.classify({
      command: 'git status --short',
      terminal: successfulTerminal,
    })

    expect(result).toMatchObject({
      outcome: 'unavailable',
      reasonCode: 'grammar-incompatible',
      category: null,
      result: 'unknown',
    })
    await classifier.close()
  })

  test('integrates one classifier result with independent ledgers and fails closed on finalization failure', async () => {
    const classifier = createReceiptClassifier()
    const classified = await classifier.classify({
      command: 'git push origin HEAD',
      terminal: successfulTerminal,
    })
    expect(classified.outcome).toBe('accepted')

    const first = createReceiptLedger({
      registrationIdentity: 'registration-a',
    })
    const second = createReceiptLedger({
      registrationIdentity: 'registration-b',
    })
    const prepareInput = {
      callId: 'push-call',
      operation: 'push' as const,
      context: {
        epochId: 'epoch-1',
        unitId: 'unit-1',
        workspaceIdentity: 'workspace-before',
        repositoryIdentity: 'repository-before',
        worktreeIdentity: 'worktree-before',
        resourceIdentity: 'remote-before',
      },
    }
    first.prepareObservation(prepareInput)
    second.prepareObservation(prepareInput)

    const finalizeInput = {
      callId: 'push-call',
      context: prepareInput.context,
      after: {
        workspaceIdentity: 'workspace-before',
        repositoryIdentity: 'repository-after',
        worktreeIdentity: 'worktree-after',
        resourceIdentity: 'remote-after',
      },
      classification: classified,
      terminal: successfulTerminal,
    }
    const firstReceipt = first.finalizeObservation(finalizeInput)
    const secondReceipt = second.finalizeObservation(finalizeInput)
    expect(firstReceipt.status).toBe('finalized')
    expect(secondReceipt.status).toBe('finalized')
    assertFinalized(firstReceipt)
    assertFinalized(secondReceipt)
    expect(firstReceipt.receipt.canonical.registrationDigest).not.toBe(
      secondReceipt.receipt.canonical.registrationDigest,
    )

    const rejectedLedger = createReceiptLedger({
      registrationIdentity: 'registration-c',
    })
    rejectedLedger.prepareObservation(prepareInput)
    const rejected = rejectedLedger.finalizeObservation({
      ...finalizeInput,
      classification: {
        ...classified,
        outcome: 'unavailable',
        reasonCode: 'parser-asset-unavailable',
      },
    })
    expect(rejected).toMatchObject({
      status: 'rejected',
      reasonCode: 'classification-unavailable',
    })

    await classifier.close()
  })

  test('rejects use after deterministic classifier cleanup', async () => {
    const classifier = createReceiptClassifier()
    await classifier.close()
    const result = await classifier.classify({
      command: 'git status --short',
      terminal: successfulTerminal,
    })
    expect(result).toMatchObject({
      outcome: 'unavailable',
      reasonCode: 'classifier-closed',
    })
  })
})
