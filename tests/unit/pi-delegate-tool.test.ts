import { describe, expect, test } from 'bun:test'
import type {
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { AgentCatalogEntry } from '../../src/lib/agent-resolver.js'
import type {
  OverlayConfig,
  SourcedOverlayConfig,
  SourcedOverlayConfigMap,
} from '../../src/lib/config.js'
import {
  createPiDelegateTool,
  DELEGATE_EXECUTION_MODE,
  DELEGATE_TOOL_NAME,
  type DelegateSessionLike,
  type DelegateToolDetails,
  MAX_DELEGATE_TURNS,
} from '../../src/lib/pi-delegate-tool.js'

const catalog: AgentCatalogEntry[] = [
  {
    name: 'git-analyzer',
    description: 'Analyzes git history',
    body: 'You are a git historian.',
    toolsSource: undefined,
    key: 'git-analyzer',
    category: 'research',
    id: 'research/git-analyzer',
  },
  {
    name: 'security-reviewer',
    description: 'Reviews for security issues',
    body: 'You are a security reviewer.',
    toolsSource: 'Read, Grep, Glob, Bash',
    key: 'security-reviewer',
    category: 'review',
    id: 'review/security-reviewer',
  },
]

interface FakeSessionEvent {
  type: string
}

interface FakeSession extends DelegateSessionLike {
  listeners: Array<(event: FakeSessionEvent) => void>
  disposed: boolean
  aborted: boolean
  abortCalls: number
  lastAssistantText: string
  turnsToEmit: number
  promptCalls: number
  /** When set, prompt() rejects with this error after emitting its turns. */
  failAfterTurns: Error | undefined
  /**
   * When true, prompt() rejects with a generic error the instant abort() is
   * called on this session — simulating a real session whose prompt()
   * rejects because it was aborted mid-stream (turn-limit or external).
   */
  rejectPromptWhenAborted: boolean
  /** When set, abort() itself rejects with this error instead of resolving. */
  abortShouldFail: Error | undefined
}

function emitTurnStarts(session: FakeSession): void {
  for (let i = 0; i < session.turnsToEmit; i++) {
    if (session.aborted) break
    for (const l of session.listeners) l({ type: 'turn_start' })
  }
}

function createFakeSession(turnsToEmit: number): FakeSession {
  let promptRejecter: ((error: unknown) => void) | undefined

  const session: FakeSession = {
    listeners: [],
    disposed: false,
    aborted: false,
    abortCalls: 0,
    lastAssistantText: 'final answer text',
    turnsToEmit,
    promptCalls: 0,
    failAfterTurns: undefined,
    rejectPromptWhenAborted: false,
    abortShouldFail: undefined,

    subscribe(listener: (event: FakeSessionEvent) => void): () => void {
      session.listeners.push(listener)
      return () => {
        session.listeners = session.listeners.filter((l) => l !== listener)
      }
    },

    async prompt(_text: string): Promise<void> {
      session.promptCalls += 1
      return new Promise((resolve, reject) => {
        promptRejecter = reject
        emitTurnStarts(session)
        if (session.aborted && session.rejectPromptWhenAborted) return
        if (session.failAfterTurns) {
          reject(session.failAfterTurns)
          return
        }
        resolve()
      })
    },

    async abort(): Promise<void> {
      session.abortCalls += 1
      session.aborted = true
      if (session.rejectPromptWhenAborted) {
        promptRejecter?.(new Error('prompt aborted'))
      }
      if (session.abortShouldFail) {
        throw session.abortShouldFail
      }
    },

    dispose(): void {
      session.disposed = true
    },

    getLastAssistantText(): string | undefined {
      return session.aborted ? undefined : session.lastAssistantText
    },
  }

  return session
}

function fakeCtx(
  model: unknown = { provider: 'p', id: 'm' },
  hasModel = true,
  modelRegistry: { find: (provider: string, id: string) => unknown } = {
    find: () => undefined,
  },
): ExtensionContext {
  return {
    cwd: '/fake/cwd',
    model: hasModel ? model : undefined,
    modelRegistry,
  } as unknown as ExtensionContext
}

/** Fake `ctx.modelRegistry` that resolves exactly the given `provider/id` strings to distinct sentinel model objects, for asserting the delegate passed the resolved (not the inherited) model. */
function fakeModelRegistry(known: Record<string, unknown>): {
  find: (provider: string, id: string) => unknown
} {
  return {
    find: (provider: string, id: string) => known[`${provider}/${id}`],
  }
}

function overlay(value: OverlayConfig): SourcedOverlayConfig {
  return { value, sourcePath: '/fake/systematic.json', keyPath: 'fake' }
}

function overlays(
  agents: Record<string, OverlayConfig> = {},
  categories: Record<string, OverlayConfig> = {},
): SourcedOverlayConfigMap {
  return {
    agents: Object.fromEntries(
      Object.entries(agents).map(([k, v]) => [k, overlay(v)]),
    ),
    categories: Object.fromEntries(
      Object.entries(categories).map(([k, v]) => [k, overlay(v)]),
    ),
  }
}

const EMPTY_OVERLAYS: SourcedOverlayConfigMap = { agents: {}, categories: {} }

describe('createPiDelegateTool: registration shape', () => {
  test('registers exactly {agent, task} parameters', () => {
    let created: FakeSession | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        created = createFakeSession(1)
        return created
      },
    })

    expect(tool.name).toBe(DELEGATE_TOOL_NAME)
    expect(tool.name).toBe('systematic_delegate')
    const schema = tool.parameters as unknown as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties).sort()).toEqual(['agent', 'task'])
    expect(schema.required.sort()).toEqual(['agent', 'task'])
    void created
  })

  test('description includes bounded deterministic persona list', () => {
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => createFakeSession(1),
    })
    expect(tool.description).toContain('git-analyzer: Analyzes git history')
    expect(tool.description).toContain(
      'security-reviewer: Reviews for security issues',
    )
  })

  test('execution mode is fixed sequential', () => {
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => createFakeSession(1),
    })
    expect(tool.executionMode).toBe('sequential')
    expect(DELEGATE_EXECUTION_MODE).toBe('sequential')
  })

  test('exposes a concise promptSnippet for Pi', () => {
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => createFakeSession(1),
    })

    expect(tool.promptSnippet).toBe(
      'Use the narrowest persona that fits the task, and delegate one concrete job.',
    )
  })

  test('description stays bounded and includes concise prompt snippets', () => {
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => createFakeSession(1),
    })

    expect(tool.description.length).toBeLessThan(6000)
    for (const entry of catalog) {
      expect(tool.description).toContain(entry.name)
      expect(tool.description).toContain('promptSnippet:')
    }
    expect(tool.description).toContain(
      'Use the narrowest persona that fits the task',
    )
  })
})

async function execute(
  tool: ToolDefinition<never, DelegateToolDetails>,
  params: { agent: string; task: string },
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  return tool.execute('call-1', params as never, signal, undefined, ctx)
}

describe('createPiDelegateTool: happy path', () => {
  test('returns final assistant text and turn count on normal completion', async () => {
    let capturedCwd: string | undefined
    let capturedModel: unknown
    let capturedTools: string[] | undefined
    let capturedPrompt: string | undefined

    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async (opts) => {
        capturedCwd = opts.cwd
        capturedModel = opts.model
        capturedTools = opts.allowedToolNames
        capturedPrompt = opts.systemPromptOverride
        // CreateDelegateSession must not expose task/signal — the real
        // constructor never consumes either.
        expect(opts).not.toHaveProperty('task')
        expect(opts).not.toHaveProperty('signal')
        return createFakeSession(3)
      },
    })

    const model = { provider: 'anthropic', id: 'claude' }
    const result = await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'security-reviewer', task: 'find bugs' },
      undefined,
      fakeCtx(model),
    )

    expect(result.content).toEqual([
      { type: 'text', text: 'final answer text' },
    ])
    expect(result.details).toEqual({
      persona: 'security-reviewer',
      turnCount: 3,
      outcome: 'completed',
    })
    expect(capturedCwd).toBe('/fake/cwd')
    expect(capturedModel).toBe(model)
    expect(capturedTools).toEqual(['read', 'grep', 'find', 'bash'])
    expect(capturedPrompt).toBe('You are a security reviewer.')
  })

  test('undeclared persona tools defaults to the read-only allowlist', async () => {
    let capturedTools: string[] | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async (opts) => {
        capturedTools = opts.allowedToolNames
        return createFakeSession(1)
      },
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'trace history' },
      undefined,
      fakeCtx(),
    )

    expect(capturedTools).toEqual(['read', 'grep', 'find', 'ls'])
  })
})
describe('createPiDelegateTool: error paths', () => {
  test("unknown persona rejects through Pi's error channel with available persona names", async () => {
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => createFakeSession(1),
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'nonexistent', task: 'x' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/Unknown persona "nonexistent".*git-analyzer/s)
  })

  test('undefined parent model rejects before creating a child session', async () => {
    let created = false
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        created = true
        return createFakeSession(1)
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'x' },
        undefined,
        fakeCtx(undefined, false),
      ),
    ).rejects.toThrow(/cannot start because no model is available to inherit/i)
    expect(created).toBe(false)
  })

  test('20-turn bound throws before turn 21 and preserves the turn count', async () => {
    let sessionRef: FakeSession | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        sessionRef = createFakeSession(MAX_DELEGATE_TURNS + 5)
        return sessionRef
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'loop forever' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/git-analyzer.*20-turn limit|20 turns.*git-analyzer/s)
    expect(sessionRef?.aborted).toBe(true)
    expect(sessionRef?.disposed).toBe(true)
    // abort() must be called at most once even though the turn-cap listener
    // keeps observing turn_start events on an already-aborting session.
    expect(sessionRef?.abortCalls).toBe(1)
  })

  test('a signal already aborted before execution rejects without constructing a child session', async () => {
    let created = false
    const controller = new AbortController()
    controller.abort()
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        created = true
        return createFakeSession(1)
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'x' },
        controller.signal,
        fakeCtx(),
      ),
    ).rejects.toThrow(/git-analyzer.*aborted/s)
    expect(created).toBe(false)
  })

  test('preserves turnCount when prompt() fails after some turns already ran', async () => {
    let sessionRef: FakeSession | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        sessionRef = createFakeSession(5)
        sessionRef.failAfterTurns = new Error('provider exploded')
        return sessionRef
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'x' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(
      /Delegation to "git-analyzer" failed after 5 turns: provider exploded/,
    )
    expect(sessionRef?.disposed).toBe(true)
  })

  test('signal aborting while createDelegateSession() is still pending preempts promptly and cleans up a late session', async () => {
    let sessionRef: FakeSession | undefined
    const controller = new AbortController()
    let resolveCreation: (() => void) | undefined
    const creationGate = new Promise<void>((resolve) => {
      resolveCreation = resolve
    })

    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        await creationGate
        sessionRef = createFakeSession(3)
        return sessionRef
      },
    })

    const resultPromise = execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      controller.signal,
      fakeCtx(),
    )

    controller.abort()
    await expect(resultPromise).rejects.toThrow(
      /aborted before the child session finished starting/,
    )
    expect(sessionRef).toBeUndefined()

    resolveCreation?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sessionRef).toBeDefined()
    expect(sessionRef?.promptCalls).toBe(0)
    expect(sessionRef?.abortCalls).toBe(1)
    expect(sessionRef?.disposed).toBe(true)
  })

  test('turn-limit-triggered prompt() rejection still reports turn_limit, not a generic failure', async () => {
    let sessionRef: FakeSession | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        sessionRef = createFakeSession(MAX_DELEGATE_TURNS + 3)
        sessionRef.rejectPromptWhenAborted = true
        return sessionRef
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'loop forever' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(
      /Delegation to "git-analyzer" stopped after the 20-turn limit \(20 turns\)\./,
    )
    expect(sessionRef?.abortCalls).toBe(1)
    expect(sessionRef?.disposed).toBe(true)
  })

  test('a rejecting abort() after the turn limit reports failed with the actual turn count, not a false clean abort', async () => {
    let sessionRef: FakeSession | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        sessionRef = createFakeSession(MAX_DELEGATE_TURNS + 3)
        sessionRef.abortShouldFail = new Error('abort() itself failed')
        return sessionRef
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'loop forever' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/git-analyzer.*20 turns.*abort/i)
    expect(sessionRef?.disposed).toBe(true)
  })

  test('a rejecting abort() after an external abort request reports failed, not a false clean abort', async () => {
    let sessionRef: FakeSession | undefined
    const controller = new AbortController()
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        sessionRef = createFakeSession(0)
        sessionRef.abortShouldFail = new Error('abort() itself failed')
        sessionRef.prompt = async () => {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve())
          })
        }
        return sessionRef
      },
    })

    const resultPromise = execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      controller.signal,
      fakeCtx(),
    )
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(resultPromise).rejects.toThrow(/git-analyzer.*abort/i)
    expect(sessionRef?.disposed).toBe(true)
  })

  test('parent/tool abort signal propagates to child session.abort()', async () => {
    let sessionRef: FakeSession | undefined
    const controller = new AbortController()
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        sessionRef = createFakeSession(0)
        // Simulate a long-running prompt that only resolves once aborted.
        sessionRef.prompt = async () => {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve())
          })
        }
        return sessionRef
      },
    })

    const resultPromise = execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      controller.signal,
      fakeCtx(),
    )
    // Let the async session-creation microtasks settle before aborting, so
    // sessionRef is assigned and the tool's abort listener is registered.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(resultPromise).rejects.toThrow(/git-analyzer.*aborted/i)

    expect(sessionRef?.aborted).toBe(true)
    expect(sessionRef?.disposed).toBe(true)
  })

  test('dispose() is always called on success and every failure path', async () => {
    const successSession = createFakeSession(1)
    const toolSuccess = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => successSession,
    })
    await execute(
      toolSuccess as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      undefined,
      fakeCtx(),
    )
    expect(successSession.disposed).toBe(true)

    const toolThrows = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => {
        throw new Error('creation failed')
      },
    })
    await expect(
      execute(
        toolThrows as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'x' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/creation failed/)
  })

  test('unsubscribes the event listener after completion', async () => {
    const session = createFakeSession(2)
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => session,
    })
    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      undefined,
      fakeCtx(),
    )
    expect(session.listeners.length).toBe(0)
  })

  test('declared unknown tool name rejects without creating a child session', async () => {
    let created = false
    const badCatalog: AgentCatalogEntry[] = [
      {
        name: 'bad-persona',
        description: 'Has an unmappable tool',
        body: 'Body',
        toolsSource: 'Read, Frobnicate',
        key: 'bad-persona',
        category: 'misc',
        id: 'misc/bad-persona',
      },
    ]
    const tool = createPiDelegateTool({
      catalog: badCatalog,
      createDelegateSession: async () => {
        created = true
        return createFakeSession(1)
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'bad-persona', task: 'x' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(
      /bad-persona.*Frobnicate|Unknown declared tool "Frobnicate"/s,
    )
    expect(created).toBe(false)
  })

  test('Task declaration never maps into the child (denylist)', async () => {
    let created = false
    const badCatalog: AgentCatalogEntry[] = [
      {
        name: 'self-delegating',
        description: 'Declares Task',
        body: 'Body',
        toolsSource: 'Read, Task',
        key: 'self-delegating',
        category: 'misc',
        id: 'misc/self-delegating',
      },
    ]
    const tool = createPiDelegateTool({
      catalog: badCatalog,
      createDelegateSession: async () => {
        created = true
        return createFakeSession(1)
      },
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'self-delegating', task: 'x' },
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/self-delegating.*Task|Unknown declared tool "Task"/s)
    expect(created).toBe(false)
  })
})

describe('createPiDelegateTool: Pi routing (Unit 5)', () => {
  test('agents.fixer.pi.model set → child session created with that model', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const configModel = { provider: 'anthropic', id: 'pi-only-model' }
    let capturedModel: unknown
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async (opts) => {
        capturedModel = opts.model
        return createFakeSession(1)
      },
      overlays: overlays({
        fixer: { pi: { model: 'anthropic/pi-only-model' } },
      }),
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx(
        { provider: 'p', id: 'parent-model' },
        true,
        fakeModelRegistry({ 'anthropic/pi-only-model': configModel }),
      ),
    )

    expect(capturedModel).toBe(configModel)
  })

  test('flat agents.fixer.model set and no block → same routing as a pi block (AE4)', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const configModel = { provider: 'openai', id: 'flat-model' }
    let capturedModel: unknown
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async (opts) => {
        capturedModel = opts.model
        return createFakeSession(1)
      },
      overlays: overlays({ fixer: { model: 'openai/flat-model' } }),
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx(
        { provider: 'p', id: 'parent-model' },
        true,
        fakeModelRegistry({ 'openai/flat-model': configModel }),
      ),
    )

    expect(capturedModel).toBe(configModel)
  })

  test('nothing resolves → child inherits ctx.model', async () => {
    const parentModel = { provider: 'p', id: 'parent-model' }
    let capturedModel: unknown
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async (opts) => {
        capturedModel = opts.model
        return createFakeSession(1)
      },
      overlays: EMPTY_OVERLAYS,
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      undefined,
      fakeCtx(parentModel),
    )

    expect(capturedModel).toBe(parentModel)
  })

  test('model: null resolves → inherits ctx.model even though a category pinned a model', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const parentModel = { provider: 'p', id: 'parent-model' }
    let capturedModel: unknown
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async (opts) => {
        capturedModel = opts.model
        return createFakeSession(1)
      },
      overlays: overlays(
        { fixer: { model: null } },
        { fix: { model: 'anthropic/category-model' } },
      ),
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx(parentModel),
    )

    expect(capturedModel).toBe(parentModel)
  })

  test('nothing resolves and ctx.model undefined → the existing fail-closed error', async () => {
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async () => createFakeSession(1),
      overlays: EMPTY_OVERLAYS,
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'git-analyzer', task: 'x' },
        undefined,
        fakeCtx(undefined, false),
      ),
    ).rejects.toThrow(/cannot start because no model is available to inherit/i)
  })

  test('first dispatch with a config-sourced model gets one routing notice; second dispatch of the same agent gets none; a different agent gets its own (AE9)', async () => {
    const twoCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
      {
        name: 'oracle',
        description: 'Knows things',
        body: 'You are an oracle.',
        toolsSource: undefined,
        key: 'oracle',
        category: 'review',
        id: 'review/oracle',
      },
    ]
    const fixerModel = { provider: 'anthropic', id: 'fixer-model' }
    const oracleModel = { provider: 'anthropic', id: 'oracle-model' }
    const modelRegistry = fakeModelRegistry({
      'anthropic/fixer-model': fixerModel,
      'anthropic/oracle-model': oracleModel,
    })
    const tool = createPiDelegateTool({
      catalog: twoCatalog,
      createDelegateSession: async () => createFakeSession(1),
      overlays: overlays({
        fixer: { model: 'anthropic/fixer-model' },
        oracle: { model: 'anthropic/oracle-model' },
      }),
      activeProfile: 'personal',
    })

    const first = await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent' }, true, modelRegistry),
    )
    const firstText = (first.content[0] as { text: string }).text
    expect(firstText).toContain('fixer')
    expect(firstText).toContain('anthropic/fixer-model')
    expect(firstText).toContain('personal')

    const second = await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it again' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent' }, true, modelRegistry),
    )
    const secondText = (second.content[0] as { text: string }).text
    expect(secondText).not.toContain('[systematic]')

    const third = await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'oracle', task: 'ask it' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent' }, true, modelRegistry),
    )
    const thirdText = (third.content[0] as { text: string }).text
    expect(thirdText).toContain('oracle')
    expect(thirdText).toContain('anthropic/oracle-model')
  })

  test('a session-creation failure does not consume the one-time routing notice; the next successful dispatch of the same agent still gets it (code review fix)', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const fixerModel = { provider: 'anthropic', id: 'fixer-model' }
    const modelRegistry = fakeModelRegistry({
      'anthropic/fixer-model': fixerModel,
    })
    let attempts = 0
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('session creation boom')
        }
        return createFakeSession(1)
      },
      overlays: overlays({ fixer: { model: 'anthropic/fixer-model' } }),
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'fixer', task: 'fix it' },
        undefined,
        fakeCtx({ provider: 'p', id: 'parent' }, true, modelRegistry),
      ),
    ).rejects.toThrow()

    const second = await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it again' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent' }, true, modelRegistry),
    )
    const secondText = (second.content[0] as { text: string }).text
    expect(secondText).toContain('[systematic]')
    expect(secondText).toContain('fixer')
    expect(secondText).toContain('anthropic/fixer-model')
    expect(attempts).toBe(2)
  })

  test('an unregistered configured model fails closed instead of silently falling back', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async () => createFakeSession(1),
      overlays: overlays({ fixer: { model: 'anthropic/unregistered-model' } }),
    })

    await expect(
      execute(
        tool as unknown as ToolDefinition<never, DelegateToolDetails>,
        { agent: 'fixer', task: 'fix it' },
        undefined,
        fakeCtx({ provider: 'p', id: 'parent' }),
      ),
    ).rejects.toThrow(/not registered/i)
  })

  test('agents.fixer.pi.thinking: "high" → session options carry thinkingLevel: "high"', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    let capturedThinkingLevel: unknown
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async (opts) => {
        capturedThinkingLevel = opts.thinkingLevel
        return createFakeSession(1)
      },
      overlays: overlays({ fixer: { pi: { thinking: 'high' } } }),
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent-model' }),
    )

    expect(capturedThinkingLevel).toBe('high')
  })

  test('agents.fixer.pi.thinking set with NO model anywhere \u2192 thinkingLevel applied on the inherited ctx.model (thinking is model-independent)', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const inheritedModel = { provider: 'p', id: 'parent-model' }
    let capturedThinkingLevel: unknown
    let capturedModel: unknown
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async (opts) => {
        capturedThinkingLevel = opts.thinkingLevel
        capturedModel = opts.model
        return createFakeSession(1)
      },
      overlays: overlays({ fixer: { pi: { thinking: 'high' } } }),
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx(inheritedModel),
    )

    expect(capturedThinkingLevel).toBe('high')
    expect(capturedModel).toBe(inheritedModel)
  })

  test('no thinking anywhere \u2192 thinkingLevel key is absent (child inherits Pi default)', async () => {
    let capturedOpts: Record<string, unknown> | undefined
    const tool = createPiDelegateTool({
      catalog,
      createDelegateSession: async (opts) => {
        capturedOpts = opts as unknown as Record<string, unknown>
        return createFakeSession(1)
      },
      overlays: EMPTY_OVERLAYS,
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'git-analyzer', task: 'x' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent-model' }),
    )

    expect(capturedOpts?.thinkingLevel).toBeUndefined()
  })

  test('legacy pi_subagents.<key>.thinking still resolves to thinkingLevel when no pi block is set (AE8)', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    let capturedThinkingLevel: unknown
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async (opts) => {
        capturedThinkingLevel = opts.thinkingLevel
        return createFakeSession(1)
      },
      overlays: EMPTY_OVERLAYS,
      piSubagentsOverlays: { agents: { fixer: { thinking: 'medium' } } },
    })

    await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx({ provider: 'p', id: 'parent-model' }),
    )

    expect(capturedThinkingLevel).toBe('medium')
  })

  test('the R4a notice includes the applied thinking level when one is set', async () => {
    const fixerCatalog: AgentCatalogEntry[] = [
      {
        name: 'fixer',
        description: 'Fixes things',
        body: 'You are a fixer.',
        toolsSource: undefined,
        key: 'fixer',
        category: 'fix',
        id: 'fix/fixer',
      },
    ]
    const configModel = { provider: 'anthropic', id: 'fixer-model' }
    const tool = createPiDelegateTool({
      catalog: fixerCatalog,
      createDelegateSession: async () => createFakeSession(1),
      overlays: overlays({
        fixer: { model: 'anthropic/fixer-model', pi: { thinking: 'high' } },
      }),
    })

    const result = await execute(
      tool as unknown as ToolDefinition<never, DelegateToolDetails>,
      { agent: 'fixer', task: 'fix it' },
      undefined,
      fakeCtx(
        { provider: 'p', id: 'parent' },
        true,
        fakeModelRegistry({ 'anthropic/fixer-model': configModel }),
      ),
    )

    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('thinking "high"')
  })
})
