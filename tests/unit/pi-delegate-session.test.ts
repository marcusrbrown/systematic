import { describe, expect, test } from 'bun:test'
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent'
import {
  buildDelegateAgentSessionOptions,
  buildDelegateResourceLoaderOptions,
  createDelegateSessionWith,
  type PiDelegateSessionRuntime,
} from '../../src/lib/pi-delegate-session.js'
import { DELEGATE_TOOL_NAME } from '../../src/lib/pi-delegate-tool.js'

describe('buildDelegateResourceLoaderOptions', () => {
  test('requests depth-1 structural isolation, parent cwd, and an authoritative override system prompt', () => {
    const options = buildDelegateResourceLoaderOptions({
      cwd: '/parent/cwd',
      agentDir: '/agent/dir',
      systemPromptOverride: 'Persona body text.',
    })

    expect(options.cwd).toBe('/parent/cwd')
    expect(options.agentDir).toBe('/agent/dir')
    expect(options.noExtensions).toBe(true)
    expect(options.noSkills).toBe(true)
    expect(options.noPromptTemplates).toBe(true)
    expect(options.noThemes).toBe(true)
    expect(options.noContextFiles).toBe(true)
    expect(options.systemPromptOverride?.(undefined)).toBe('Persona body text.')
    expect(options.systemPromptOverride?.('anything else')).toBe(
      'Persona body text.',
    )
    expect(options.appendSystemPromptOverride?.(['leaked context'])).toEqual([])
  })
})

describe('buildDelegateAgentSessionOptions', () => {
  test('requests parent model/cwd, exact mapped tools, empty customTools, and the given loader/session manager', () => {
    const model = { provider: 'anthropic', id: 'claude' }
    const resourceLoader = { marker: 'resource-loader' } as never
    const sessionManager = { marker: 'session-manager' } as never

    const options = buildDelegateAgentSessionOptions({
      cwd: '/parent/cwd',
      agentDir: '/agent/dir',
      model: model as CreateAgentSessionOptions['model'],
      allowedToolNames: ['read', 'grep'],
      resourceLoader,
      sessionManager,
    })

    expect(options.cwd).toBe('/parent/cwd')
    expect(options.agentDir).toBe('/agent/dir')
    expect(options.model).toBe(model)
    expect(options.tools).toEqual(['read', 'grep'])
    expect(options.customTools).toEqual([])
    expect(options.resourceLoader).toBe(resourceLoader)
    expect(options.sessionManager).toBe(sessionManager)
  })
})

function createFakeRuntime(): {
  runtime: PiDelegateSessionRuntime
  calls: {
    getAgentDirCalls: number
    createResourceLoaderArgs: unknown[]
    reloadCalls: number
    createInMemorySessionManagerArgs: unknown[]
    createAgentSessionArgs: unknown[]
    callOrder: string[]
  }
} {
  const calls = {
    getAgentDirCalls: 0,
    createResourceLoaderArgs: [] as unknown[],
    reloadCalls: 0,
    createInMemorySessionManagerArgs: [] as unknown[],
    createAgentSessionArgs: [] as unknown[],
    callOrder: [] as string[],
  }

  const runtime: PiDelegateSessionRuntime = {
    getAgentDir: () => {
      calls.getAgentDirCalls += 1
      return '/fake/agent-dir'
    },
    createResourceLoader: (options) => {
      calls.createResourceLoaderArgs.push(options)
      return {
        getExtensions: () =>
          ({ extensions: [], errors: [], runtime: {} }) as never,
        getSkills: () => ({ skills: [], diagnostics: [] }) as never,
        getPrompts: () => ({ prompts: [], diagnostics: [] }) as never,
        getThemes: () => ({ themes: [], diagnostics: [] }) as never,
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => undefined,
        getAppendSystemPrompt: () => [],
        extendResources: () => {},
        reload: async () => {
          calls.reloadCalls += 1
          calls.callOrder.push('reload')
        },
      } as never
    },
    createInMemorySessionManager: (cwd) => {
      calls.createInMemorySessionManagerArgs.push(cwd)
      return { marker: 'in-memory-session-manager', cwd } as never
    },
    createAgentSession: async (options) => {
      calls.createAgentSessionArgs.push(options)
      calls.callOrder.push('createAgentSession')
      return {
        session: { marker: 'fake-session' },
        extensionsResult: { extensions: [], errors: [] },
      } as unknown as CreateAgentSessionResult
    },
  }

  return { runtime, calls }
}

describe('createDelegateSessionWith: live adapter contract, no provider required', () => {
  test('requests parent cwd/model, structural depth-1 loader flags, authoritative prompt, in-memory session manager, exact tools, and calls reload() before createAgentSession', async () => {
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    const model = { provider: 'anthropic', id: 'claude' }
    const session = await createSession({
      agentName: 'git-analyzer',
      model: model as CreateAgentSessionOptions['model'],
      cwd: '/parent/cwd',
      systemPromptOverride: 'Persona body.',
      allowedToolNames: ['read', 'grep'],
    })

    expect(session).toEqual({ marker: 'fake-session' } as never)
    expect(calls.getAgentDirCalls).toBe(1)

    expect(calls.createResourceLoaderArgs).toHaveLength(1)
    const loaderOptions = calls.createResourceLoaderArgs[0] as ReturnType<
      typeof buildDelegateResourceLoaderOptions
    >
    expect(loaderOptions.cwd).toBe('/parent/cwd')
    expect(loaderOptions.agentDir).toBe('/fake/agent-dir')
    expect(loaderOptions.noExtensions).toBe(true)
    expect(loaderOptions.noSkills).toBe(true)
    expect(loaderOptions.noPromptTemplates).toBe(true)
    expect(loaderOptions.noThemes).toBe(true)
    expect(loaderOptions.noContextFiles).toBe(true)
    expect(loaderOptions.systemPromptOverride?.(undefined)).toBe(
      'Persona body.',
    )
    expect(loaderOptions.appendSystemPromptOverride?.(['x'])).toEqual([])

    expect(calls.reloadCalls).toBe(1)
    expect(calls.createInMemorySessionManagerArgs).toEqual(['/parent/cwd'])

    expect(calls.createAgentSessionArgs).toHaveLength(1)
    const sessionOptions = calls
      .createAgentSessionArgs[0] as CreateAgentSessionOptions
    expect(sessionOptions.cwd).toBe('/parent/cwd')
    expect(sessionOptions.agentDir).toBe('/fake/agent-dir')
    expect(sessionOptions.model).toBe(model)
    expect(sessionOptions.tools).toEqual(['read', 'grep'])
    expect(sessionOptions.customTools).toEqual([])
    expect(sessionOptions.sessionManager).toEqual({
      marker: 'in-memory-session-manager',
      cwd: '/parent/cwd',
    } as never)

    // reload() must be called before createAgentSession() is invoked.
    expect(calls.callOrder).toEqual(['reload', 'createAgentSession'])
  })

  test('fails closed and never constructs a resource loader when allowedToolNames includes the delegate tool', async () => {
    const { runtime, calls } = createFakeRuntime()
    const createSession = createDelegateSessionWith(runtime)

    await expect(
      createSession({
        agentName: 'malicious',
        model: { provider: 'p', id: 'm' } as CreateAgentSessionOptions['model'],
        cwd: '/cwd',
        systemPromptOverride: 'x',
        allowedToolNames: ['read', DELEGATE_TOOL_NAME],
      }),
    ).rejects.toThrow(/fail-closed re-entry guard/)

    expect(calls.getAgentDirCalls).toBe(0)
    expect(calls.createResourceLoaderArgs).toHaveLength(0)
    expect(calls.createAgentSessionArgs).toHaveLength(0)
  })
})
