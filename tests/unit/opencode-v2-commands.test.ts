import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin'

import type { PlannedCommand } from '../../src/lib/asset-plan.js'
import { createConfigHandler } from '../../src/lib/config-handler.js'
import { createSafeGuard, setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import {
  buildCommand,
  createCommandRuntime,
  parseModelRef,
} from '../../src/lib/opencode-v2-commands.js'

const PACKAGE_ROOT = path.resolve(import.meta.dir, '../..')

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

interface SessionState {
  agent?: string
  model?: ModelRef
  outcome?: 'succeeded' | 'failed' | 'interrupted'
}

interface HostAgent {
  id: string
  mode: 'primary' | 'subagent' | 'all'
  model?: ModelRef
}

interface CommandDefinitionStub {
  name: string
  description?: string
  execute: (input: InvocationStub) => Promise<void>
}

interface InvocationStub {
  sessionID: string
  prompt: {
    text: string
    files?: { uri: string; name?: string }[]
    agents?: { name: string }[]
    skills?: { id: string }[]
  }
  delivery: string
}

type Call = { fn: string; args: Record<string, unknown> }

const BUILD_MODEL: ModelRef = {
  providerID: 'prov',
  id: 'base-model',
  variant: 'default',
}

/**
 * A stand-in host with just the session, agent and command members the
 * command installer uses. Every session call is logged in order, and sessions
 * keep an agent and a model the way the host's `switchAgent`/`switchModel` do.
 */
function createHost(
  options: {
    agents?: HostAgent[]
    native?: string[]
    childReply?: string
    childOutcome?: SessionState['outcome']
    promptFails?: boolean
    waitHook?: (sessionID: string) => void
    waitGate?: Promise<void>
    waitFails?: boolean
    /** The session is mid-turn when the command arrives, so a wait blocks on the gate. */
    busyAtStart?: boolean
    /** What the host resolves for a session with no model. `null` is no default at all. */
    defaultModel?: ModelRef | null
    defaultModelFails?: boolean
    getFails?: boolean
    listFails?: boolean
    directory?: string
  } = {},
) {
  const calls: Call[] = []
  const sessions = new Map<string, SessionState>([
    ['parent', { agent: 'build', model: BUILD_MODEL }],
  ])
  // A wait on an idle session returns at once; only a session with a turn in
  // flight blocks on the gate, the way the host's wait does.
  const busy = new Set<string>(options.busyAtStart ? ['parent'] : [])
  const agents: HostAgent[] = options.agents ?? [
    { id: 'build', mode: 'primary' },
    { id: 'plan', mode: 'primary' },
    { id: 'helper', mode: 'subagent' },
    { id: 'modelled', mode: 'primary', model: { providerID: 'p', id: 'm' } },
  ]
  const transforms: ((editor: {
    add(c: CommandDefinitionStub): void
  }) => void)[] = []
  let childCount = 0
  const log = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
  }
  const ctx = {
    location: { directory: options.directory ?? '/unused' },
    command: {
      async list() {
        if (options.listFails) throw new Error('list exploded')
        return { data: (options.native ?? []).map((name) => ({ name })) }
      },
      async transform(callback: (typeof transforms)[number]) {
        transforms.push(callback)
      },
    },
    agent: {
      async list() {
        return { data: agents }
      },
      async transform() {},
    },
    skill: { async transform() {} },
    tool: { async transform() {} },
    permission: { async assert() {} },
    model: {
      async default() {
        log('modelDefault', {})
        if (options.defaultModelFails) throw new Error('default exploded')
        const found =
          options.defaultModel === undefined
            ? { providerID: 'prov', id: 'default-model' }
            : options.defaultModel
        return {
          data:
            found === null
              ? undefined
              : {
                  providerID: found.providerID,
                  id: found.id,
                  modelID: found.id,
                },
        }
      },
    },
    session: {
      async hook() {},
      async get(input: { sessionID: string }) {
        log('get', input)
        if (options.getFails) throw new Error('session lookup failed')
        const state = sessions.get(input.sessionID)
        if (state === undefined) throw new Error('no such session')
        return { id: input.sessionID, ...state }
      },
      async switchAgent(input: { sessionID: string; agent: string }) {
        log('switchAgent', input)
        const state = sessions.get(input.sessionID)
        if (state) state.agent = input.agent
      },
      async switchModel(input: { sessionID: string; model: ModelRef }) {
        log('switchModel', input)
        const state = sessions.get(input.sessionID)
        if (state) state.model = { variant: 'default', ...input.model }
      },
      async prompt(input: Record<string, unknown>) {
        log('prompt', input)
        if (options.promptFails) throw new Error('prompt exploded')
        busy.add(String(input.sessionID))
      },
      async wait(input: { sessionID: string }) {
        log('wait', input)
        if (options.waitFails) throw new Error('wait exploded')
        if (!busy.has(input.sessionID)) return
        await options.waitGate
        busy.delete(input.sessionID)
        options.waitHook?.(input.sessionID)
      },
      async create(input: {
        parentID?: string
        agent?: string
        model?: ModelRef
        title?: string
      }) {
        log('create', input)
        childCount += 1
        const id = `child-${childCount}`
        sessions.set(id, {
          agent: input.agent ?? 'build',
          model: input.model ?? BUILD_MODEL,
          outcome: options.childOutcome ?? 'succeeded',
        })
        return { id }
      },
      async context(input: { sessionID: string }) {
        log('context', input)
        return [
          { type: 'user', content: [{ type: 'text', text: 'task' }] },
          {
            type: 'assistant',
            content: [
              { type: 'reasoning', text: 'hidden thoughts' },
              { type: 'text', text: options.childReply ?? 'CHILD-REPLY' },
            ],
          },
        ]
      },
      async synthetic(input: Record<string, unknown>) {
        log('synthetic', input)
      },
    },
  } as unknown as Plugin.Context
  return { ctx, calls, sessions, transforms }
}

type Host = ReturnType<typeof createHost>

let errorSpy: Mock<typeof console.error>
let warnSpy: Mock<typeof console.warn>

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

function errorMessages(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]))
}

/** A promise a test settles by hand, to hold a session wait open. */
function gate() {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function makeRuntime(host: Host) {
  return createCommandRuntime(host.ctx, createSafeGuard(), (message) => {
    console.error(`systematic: ${message}`)
  })
}

async function settle(runtime: ReturnType<typeof makeRuntime>) {
  await Promise.all([...runtime.background])
}

function command(
  host: Host,
  planned: Partial<PlannedCommand> = {},
  name = 'systematic:probe',
) {
  const runtime = makeRuntime(host)
  const definition = buildCommand(runtime, name, {
    template: 'Do the thing: $ARGUMENTS',
    description: '(Systematic) probe',
    ...planned,
  }) as unknown as CommandDefinitionStub
  return { runtime, definition }
}

function invocation(
  text: string,
  extra: Partial<InvocationStub['prompt']> = {},
  sessionID = 'parent',
): InvocationStub {
  return { sessionID, prompt: { text, ...extra }, delivery: 'queue' }
}

function callsOf(host: Host, fn: string): Call[] {
  return host.calls.filter((call) => call.fn === fn)
}

function order(host: Host): string[] {
  return host.calls
    .filter(
      (call) =>
        call.fn !== 'get' &&
        call.fn !== 'context' &&
        call.fn !== 'modelDefault',
    )
    .map((call) => {
      const detail =
        call.fn === 'switchAgent'
          ? `:${String(call.args.agent)}`
          : call.fn === 'switchModel'
            ? `:${String((call.args.model as ModelRef).id)}`
            : call.fn === 'create'
              ? `:${String(call.args.agent)}`
              : ''
      return `${call.fn}${detail}`
    })
}

describe('parseModelRef', () => {
  test('splits provider and model', () => {
    expect(parseModelRef('anthropic/claude-sonnet-5-5')).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-5-5',
    })
  })

  test('reads a variant after #', () => {
    expect(parseModelRef('openai/gpt-6#high')).toEqual({
      providerID: 'openai',
      id: 'gpt-6',
      variant: 'high',
    })
  })

  test('keeps further slashes in the model id', () => {
    expect(parseModelRef('openrouter/anthropic/claude')).toEqual({
      providerID: 'openrouter',
      id: 'anthropic/claude',
    })
  })

  test.each(['', 'no-provider', '/model', 'provider/', 'p/m#'])(
    'rejects %p',
    (value) => {
      expect(parseModelRef(value)).toBeUndefined()
    },
  )
})

describe('prompt expansion', () => {
  test('substitutes $ARGUMENTS and submits one prompt with the delivery', async () => {
    const host = createHost()
    const { definition } = command(host)

    await definition.execute(invocation('ISSUE-42 now'))

    const [prompt] = callsOf(host, 'prompt')
    expect(prompt?.args).toMatchObject({
      sessionID: 'parent',
      text: 'Do the thing: ISSUE-42 now',
      delivery: 'queue',
    })
    expect(callsOf(host, 'prompt')).toHaveLength(1)
  })

  test('expands positional arguments, the last one taking the rest', async () => {
    const host = createHost()
    const { definition } = command(host, { template: 'Compare $1 with $2.' })

    await definition.execute(invocation('api stable branch'))

    expect(callsOf(host, 'prompt')[0]?.args.text).toBe(
      'Compare api with stable branch.',
    )
  })

  test('quoted words form one positional argument', async () => {
    const host = createHost()
    const { definition } = command(host, { template: 'Check $1. Focus: $2.' })

    await definition.execute(invocation('src/a.ts "error handling"'))

    expect(callsOf(host, 'prompt')[0]?.args.text).toBe(
      'Check src/a.ts. Focus: error handling.',
    )
  })

  test('with no placeholder, non-blank arguments follow after a blank line', async () => {
    const host = createHost()
    const { definition } = command(host, { template: 'Explain this code.' })

    await definition.execute(invocation('src/cache.ts'))
    await definition.execute(invocation('   '))

    const texts = callsOf(host, 'prompt').map((call) => call.args.text)
    expect(texts).toEqual([
      'Explain this code.\n\nsrc/cache.ts',
      'Explain this code.',
    ])
  })

  test('a !-backtick block is left as literal text and nothing runs', async () => {
    const host = createHost()
    const { definition } = command(host, {
      template:
        'Before !`echo SHOULD-NOT-RUN && touch /tmp/never` after $ARGUMENTS',
    })

    await definition.execute(invocation('x'))

    expect(callsOf(host, 'prompt')[0]?.args.text).toBe(
      'Before !`echo SHOULD-NOT-RUN && touch /tmp/never` after x',
    )
  })

  test('files, agents and skills from the invocation reach the prompt unchanged', async () => {
    const host = createHost()
    const { definition } = command(host)
    const files = [{ uri: 'file:///tmp/a.md', name: 'a.md' }]
    const agents = [{ name: 'helper' }]
    const skills = [{ id: 'git-worktree' }]

    await definition.execute(invocation('x', { files, agents, skills }))

    const args = callsOf(host, 'prompt')[0]?.args
    expect(args?.files).toBe(files)
    expect(args?.agents).toBe(agents)
    expect(args?.skills).toBe(skills)
  })

  test('the description is passed through', () => {
    const host = createHost()
    const { definition } = command(host, { description: '(Systematic) hello' })

    expect(definition.name).toBe('systematic:probe')
    expect(definition.description).toBe('(Systematic) hello')
  })
})

describe('agent and model routing in the current session', () => {
  test('switches to the configured agent, prompts, and puts the session back after the turn', async () => {
    const turn = gate()
    const host = createHost({ waitGate: turn.promise })
    const { runtime, definition } = command(host, { agent: 'plan' })

    await definition.execute(invocation('go'))
    // While the turn runs, the session is on the command's agent.
    expect(order(host).slice(0, 3)).toEqual([
      'wait',
      'switchAgent:plan',
      'prompt',
    ])
    expect(host.sessions.get('parent')?.agent).toBe('plan')

    turn.release()
    await settle(runtime)
    expect(order(host)).toEqual([
      'wait',
      'switchAgent:plan',
      'prompt',
      'wait',
      'switchAgent:build',
    ])
    expect(host.sessions.get('parent')?.agent).toBe('build')
  })

  test('no switch and no restore when the session already runs the agent', async () => {
    const host = createHost()
    host.sessions.set('parent', { agent: 'plan', model: BUILD_MODEL })
    const { runtime, definition } = command(host, { agent: 'plan' })

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(order(host)).toEqual(['prompt'])
  })

  test('a command with no agent and no model touches neither', async () => {
    const host = createHost()
    const { runtime, definition } = command(host)

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(order(host)).toEqual(['prompt'])
  })

  test('switches to the configured model before the prompt and restores the previous one', async () => {
    const turn = gate()
    const host = createHost({ waitGate: turn.promise })
    const { runtime, definition } = command(host, {
      model: 'other/special#high',
    })

    await definition.execute(invocation('go'))
    expect(callsOf(host, 'switchModel')[0]?.args.model).toEqual({
      providerID: 'other',
      id: 'special',
      variant: 'high',
    })
    expect(order(host).slice(0, 3)).toEqual([
      'wait',
      'switchModel:special',
      'prompt',
    ])
    expect(host.sessions.get('parent')?.model).toMatchObject({ id: 'special' })

    turn.release()
    await settle(runtime)
    expect(host.sessions.get('parent')?.model).toMatchObject({
      providerID: 'prov',
      id: 'base-model',
    })
  })

  test('a model string that is not provider/model is skipped with one diagnostic across runs', async () => {
    const host = createHost()
    const { runtime, definition } = command(host, { model: 'nonsense' })

    await definition.execute(invocation('a'))
    await definition.execute(invocation('b'))
    await settle(runtime)

    expect(callsOf(host, 'switchModel')).toHaveLength(0)
    expect(callsOf(host, 'prompt')).toHaveLength(2)
    const notes = errorMessages().filter((m) => m.includes('"nonsense"'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
  })

  test('a configured agent that is not registered runs on the current agent with exactly one diagnostic', async () => {
    const host = createHost()
    const { runtime, definition } = command(host, { agent: 'ghost' })

    await definition.execute(invocation('a'))
    await definition.execute(invocation('b'))
    await settle(runtime)

    expect(callsOf(host, 'switchAgent')).toHaveLength(0)
    expect(callsOf(host, 'prompt')).toHaveLength(2)
    expect(host.sessions.get('parent')?.agent).toBe('build')
    const notes = errorMessages().filter((m) => m.includes('"ghost"'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
    expect(notes[0]).toContain('systematic:probe')
  })

  test('does not undo an agent switch made while the turn ran', async () => {
    const host = createHost({
      waitHook: (sessionID) => {
        const state = host.sessions.get(sessionID)
        if (state) state.agent = 'modelled'
      },
    })
    const { runtime, definition } = command(host, { agent: 'plan' })

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(host.sessions.get('parent')?.agent).toBe('modelled')
    expect(callsOf(host, 'switchAgent')).toHaveLength(1)
  })

  test('a prompt that fails restores the session at once, reports, and rethrows', async () => {
    const host = createHost({ promptFails: true })
    const { runtime, definition } = command(host, { agent: 'plan' })

    await expect(definition.execute(invocation('go'))).rejects.toThrow(
      'prompt exploded',
    )
    await settle(runtime)

    expect(host.sessions.get('parent')?.agent).toBe('build')
    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" failed: prompt exploded',
    ])
  })

  test('a restore that also fails is reported once and the prompt error is still the one thrown', async () => {
    const host = createHost({ promptFails: true })
    const switchAgent = host.ctx.session.switchAgent.bind(host.ctx.session)
    host.ctx.session.switchAgent = async (input) => {
      // The switch to the command's agent works; the put-back does not.
      if (input.agent === 'build') throw new Error('switch back exploded')
      return switchAgent(input)
    }
    const { runtime, definition } = command(host, { agent: 'plan' })

    await expect(definition.execute(invocation('go'))).rejects.toThrow(
      'prompt exploded',
    )
    await settle(runtime)

    const restoreNotes = errorMessages().filter((message) =>
      message.includes('could not restore the session'),
    )
    expect(restoreNotes).toEqual([
      'systematic: command "systematic:probe" could not restore the session: switch back exploded',
    ])
    // The prompt failure is still reported on its own, after the restore note.
    expect(errorMessages()).toEqual([
      restoreNotes[0] as string,
      'systematic: command "systematic:probe" failed: prompt exploded',
    ])
  })

  test('a second run waits for the first run to put the session back before it reads the state', async () => {
    const host = createHost()
    const { runtime, definition } = command(host, { agent: 'plan' })

    await definition.execute(invocation('one'))
    await definition.execute(invocation('two'))
    await settle(runtime)

    // Two full cycles: neither run mistakes the switched agent for the original.
    expect(
      order(host).filter((step) => step === 'switchAgent:build'),
    ).toHaveLength(2)
    expect(host.sessions.get('parent')?.agent).toBe('build')
  })
})

describe('a turn already running when the command arrives', () => {
  test('the switch and the prompt wait for that turn to end', async () => {
    const turn = gate()
    const host = createHost({ busyAtStart: true, waitGate: turn.promise })
    const { runtime, definition } = command(host, { agent: 'plan' })

    const running = definition.execute(invocation('go'))
    await Bun.sleep(20)
    // The host reads a session's agent for every model request, so nothing
    // may change while the earlier turn is still going.
    expect(order(host)).toEqual(['wait'])
    expect(host.sessions.get('parent')?.agent).toBe('build')

    turn.release()
    await running
    await settle(runtime)
    expect(order(host)).toEqual([
      'wait',
      'switchAgent:plan',
      'prompt',
      'wait',
      'switchAgent:build',
    ])
  })

  test('a model switch waits too', async () => {
    const turn = gate()
    const host = createHost({ busyAtStart: true, waitGate: turn.promise })
    const { runtime, definition } = command(host, { model: 'other/special' })

    const running = definition.execute(invocation('go'))
    await Bun.sleep(20)
    expect(callsOf(host, 'switchModel')).toHaveLength(0)

    turn.release()
    await running
    await settle(runtime)
    expect(order(host).slice(0, 3)).toEqual([
      'wait',
      'switchModel:special',
      'prompt',
    ])
  })

  test('the session is read after the wait, so a switch made during the earlier turn is the one restored to', async () => {
    const turn = gate()
    let waits = 0
    const host = createHost({
      busyAtStart: true,
      waitGate: turn.promise,
      waitHook: (sessionID) => {
        // Only the earlier turn changes the agent, as it ends.
        waits += 1
        const state = host.sessions.get(sessionID)
        if (state && waits === 1) state.agent = 'modelled'
      },
    })
    const { runtime, definition } = command(host, { agent: 'plan' })

    const running = definition.execute(invocation('go'))
    turn.release()
    await running
    await settle(runtime)

    expect(host.sessions.get('parent')?.agent).toBe('modelled')
  })

  test('a command that switches nothing does not wait', async () => {
    const host = createHost({ busyAtStart: true })
    const { runtime, definition } = command(host)

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(order(host)).toEqual(['prompt'])
  })
})

describe('a session with no agent or model of its own', () => {
  const DEFAULT_MODEL: ModelRef = { providerID: 'prov', id: 'default-model' }

  test('a model switch is undone to the host default model', async () => {
    const host = createHost()
    host.sessions.set('parent', {})
    const { runtime, definition } = command(host, { model: 'other/special' })

    await definition.execute(invocation('go'))
    expect(host.sessions.get('parent')?.model).toMatchObject({ id: 'special' })
    await settle(runtime)

    expect(callsOf(host, 'switchModel').map((c) => c.args.model)).toEqual([
      { providerID: 'other', id: 'special' },
      DEFAULT_MODEL,
    ])
    expect(host.sessions.get('parent')?.model).toMatchObject(DEFAULT_MODEL)
    expect(errorMessages()).toEqual([])
  })

  test('a session that names a model never asks for the default', async () => {
    const host = createHost()
    const { runtime, definition } = command(host, { model: 'other/special' })

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(callsOf(host, 'modelDefault')).toHaveLength(0)
  })

  test('with no default model either, the model is not switched and one diagnostic says why', async () => {
    const host = createHost({ defaultModel: null })
    host.sessions.set('parent', { agent: 'build' })
    const { runtime, definition } = command(host, { model: 'other/special' })

    await definition.execute(invocation('a'))
    await definition.execute(invocation('b'))
    await settle(runtime)

    expect(callsOf(host, 'switchModel')).toHaveLength(0)
    expect(callsOf(host, 'prompt')).toHaveLength(2)
    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" could not switch model: the session has no model to restore',
    ])
  })

  test('a default model lookup that fails is reported and the model is not switched', async () => {
    const host = createHost({ defaultModelFails: true })
    host.sessions.set('parent', { agent: 'build' })
    const { runtime, definition } = command(host, { model: 'other/special' })

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(callsOf(host, 'switchModel')).toHaveLength(0)
    expect(callsOf(host, 'prompt')).toHaveLength(1)
    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" could not read the default model: default exploded',
      'systematic: command "systematic:probe" could not switch model: the session has no model to restore',
    ])
  })

  test('the agent is not switched, the turn runs on the current agent and one diagnostic says why', async () => {
    const host = createHost()
    host.sessions.set('parent', { model: BUILD_MODEL })
    const { runtime, definition } = command(host, { agent: 'plan' })

    await definition.execute(invocation('a'))
    await definition.execute(invocation('b'))
    await settle(runtime)

    expect(callsOf(host, 'switchAgent')).toHaveLength(0)
    expect(callsOf(host, 'prompt')).toHaveLength(2)
    expect(host.sessions.get('parent')?.agent).toBeUndefined()
    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" could not switch agent: the session has no agent to restore',
    ])
  })

  test('with neither, the agent is skipped and the model still switches and returns', async () => {
    const host = createHost()
    host.sessions.set('parent', {})
    const { runtime, definition } = command(host, {
      agent: 'plan',
      model: 'other/special',
    })

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(callsOf(host, 'switchAgent')).toHaveLength(0)
    expect(host.sessions.get('parent')?.agent).toBeUndefined()
    expect(host.sessions.get('parent')?.model).toMatchObject(DEFAULT_MODEL)
    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" could not switch agent: the session has no agent to restore',
    ])
  })

  test('a command with no agent and no model does not look anything up', async () => {
    const host = createHost()
    host.sessions.set('parent', {})
    const { runtime, definition } = command(host)

    await definition.execute(invocation('go'))
    await settle(runtime)

    expect(callsOf(host, 'modelDefault')).toHaveLength(0)
    expect(order(host)).toEqual(['prompt'])
  })
})

describe('subagent mode', () => {
  test('runs in a child session and posts the result back to the parent', async () => {
    const host = createHost({ childReply: 'THE-CHILD-ANSWER' })
    const { runtime, definition } = command(host, {
      agent: 'helper',
      template: 'Audit $ARGUMENTS',
    })

    await definition.execute(invocation('pkg-x'))
    await settle(runtime)

    const create = callsOf(host, 'create')[0]?.args
    expect(create).toMatchObject({
      parentID: 'parent',
      agent: 'helper',
    })
    const childPrompt = callsOf(host, 'prompt')[0]?.args
    expect(childPrompt).toMatchObject({
      sessionID: 'child-1',
      text: 'Audit pkg-x',
    })
    const synthetic = callsOf(host, 'synthetic')[0]?.args
    expect(synthetic?.sessionID).toBe('parent')
    expect(String(synthetic?.text)).toContain('THE-CHILD-ANSWER')
    expect(String(synthetic?.text)).toContain('systematic:probe')
    expect(String(synthetic?.text)).not.toContain('hidden thoughts')
    // The parent keeps its agent and model.
    expect(callsOf(host, 'switchAgent')).toHaveLength(0)
    expect(callsOf(host, 'switchModel')).toHaveLength(0)
    expect(order(host)).toEqual([
      'create:helper',
      'prompt',
      'wait',
      'synthetic',
    ])
  })

  test('execute returns before the child finishes', async () => {
    const turn = gate()
    const host = createHost({ waitGate: turn.promise })
    const { runtime, definition } = command(host, { subtask: true })

    await definition.execute(invocation('x'))
    expect(callsOf(host, 'synthetic')).toHaveLength(0)

    turn.release()
    await settle(runtime)
    expect(callsOf(host, 'synthetic')).toHaveLength(1)
  })

  test('subtask true uses a child even for a primary agent, and subtask false stays inline for a subagent', async () => {
    const forced = createHost()
    const forcedCommand = command(forced, { agent: 'plan', subtask: true })
    await forcedCommand.definition.execute(invocation('x'))
    await settle(forcedCommand.runtime)
    expect(callsOf(forced, 'create')).toHaveLength(1)

    const inline = createHost()
    const inlineCommand = command(inline, { agent: 'helper', subtask: false })
    await inlineCommand.definition.execute(invocation('x'))
    await settle(inlineCommand.runtime)
    expect(callsOf(inline, 'create')).toHaveLength(0)
    expect(callsOf(inline, 'switchAgent')[0]?.args.agent).toBe('helper')
  })

  test('with subtask unset, a subagent-mode agent runs as a child and a primary agent does not', async () => {
    const child = createHost()
    const childCommand = command(child, { agent: 'helper' })
    await childCommand.definition.execute(invocation('x'))
    await settle(childCommand.runtime)
    expect(callsOf(child, 'create')).toHaveLength(1)

    const plain = createHost()
    const plainCommand = command(plain, { agent: 'plan' })
    await plainCommand.definition.execute(invocation('x'))
    await settle(plainCommand.runtime)
    expect(callsOf(plain, 'create')).toHaveLength(0)
  })

  test('the child uses the command model, else the agent model, else the parent model', async () => {
    const withModel = createHost()
    const a = command(withModel, { agent: 'helper', model: 'x/y' })
    await a.definition.execute(invocation('q'))
    await settle(a.runtime)
    expect(callsOf(withModel, 'create')[0]?.args.model).toEqual({
      providerID: 'x',
      id: 'y',
    })

    const agentModel = createHost({
      agents: [
        { id: 'build', mode: 'primary' },
        { id: 'helper', mode: 'subagent', model: { providerID: 'p', id: 'm' } },
      ],
    })
    const b = command(agentModel, { agent: 'helper' })
    await b.definition.execute(invocation('q'))
    await settle(b.runtime)
    // The agent's own model applies only when the session names none.
    expect(callsOf(agentModel, 'create')[0]?.args.model).toBeUndefined()

    const parentModel = createHost()
    const c = command(parentModel, { agent: 'helper' })
    await c.definition.execute(invocation('q'))
    await settle(c.runtime)
    expect(callsOf(parentModel, 'create')[0]?.args.model).toMatchObject({
      providerID: 'prov',
      id: 'base-model',
    })
  })

  test('files and the other attachments go to the child prompt', async () => {
    const host = createHost()
    const { runtime, definition } = command(host, { subtask: true })
    const files = [{ uri: 'file:///tmp/a.md' }]

    await definition.execute(invocation('x', { files }))
    await settle(runtime)

    expect(callsOf(host, 'prompt')[0]?.args.files).toBe(files)
  })

  test('a child that failed still reports back to the parent', async () => {
    const host = createHost({ childOutcome: 'failed', childReply: '' })
    const { runtime, definition } = command(host, { subtask: true })

    await definition.execute(invocation('x'))
    await settle(runtime)

    const synthetic = callsOf(host, 'synthetic')[0]?.args
    expect(String(synthetic?.text)).toContain('failed')
  })

  test('a child run that throws is reported and does not escape', async () => {
    const host = createHost({ waitFails: true })
    const { runtime, definition } = command(host, { subtask: true })

    await definition.execute(invocation('x'))
    await expect(settle(runtime)).resolves.toBeUndefined()

    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" subagent failed: wait exploded',
    ])
  })

  test('an agent that is not registered runs the child on the parent agent with one diagnostic', async () => {
    const host = createHost()
    const { runtime, definition } = command(host, {
      agent: 'ghost',
      subtask: true,
    })

    await definition.execute(invocation('x'))
    await settle(runtime)

    expect(callsOf(host, 'create')[0]?.args.agent).toBe('build')
    expect(errorMessages().filter((m) => m.includes('"ghost"'))).toHaveLength(1)
  })
})

describe('a command that throws', () => {
  test('is reported with the systematic prefix and rethrown for the invoker', async () => {
    const host = createHost({ getFails: true })
    const { definition } = command(host, { agent: 'plan' })

    await expect(definition.execute(invocation('x'))).rejects.toThrow(
      'session lookup failed',
    )

    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" failed: session lookup failed',
    ])
  })
})

describe('registration', () => {
  let tempRoot: string
  let projectDir: string
  let homeDir: string
  const ORIGINAL_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'oc-v2-commands-'),
    )
    projectDir = path.join(tempRoot, 'project')
    homeDir = path.join(tempRoot, 'home')
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.config/opencode'), { recursive: true })
    delete process.env.OPENCODE_CONFIG_DIR
  })

  afterEach(() => {
    if (ORIGINAL_CONFIG_DIR === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = ORIGINAL_CONFIG_DIR
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setup(host: Host) {
    await setupOpenCodeV2(host.ctx, { packageRoot: PACKAGE_ROOT, homeDir })
  }

  function replay(host: Host) {
    const added = new Map<string, CommandDefinitionStub>()
    for (const transform of host.transforms) {
      transform({ add: (definition) => added.set(definition.name, definition) })
    }
    return added
  }

  test('registers one command per planned command with the v1 names and descriptions', async () => {
    const host = createHost({ directory: projectDir })
    await setup(host)
    const added = replay(host)

    // The v1 config hook over the same tree and an empty config.
    const v1Config: { command?: Record<string, { description?: string }> } = {}
    await createConfigHandler({
      directory: projectDir,
      bundledSkillsDir: path.join(PACKAGE_ROOT, 'skills'),
      bundledAgentsDir: path.join(PACKAGE_ROOT, 'agents'),
      bundledCommandsDir: path.join(PACKAGE_ROOT, 'commands'),
      homeDir,
    })(v1Config as never)
    const v1Commands = v1Config.command ?? {}

    expect(added.size).toBeGreaterThan(10)
    expect([...added.keys()].sort()).toEqual(Object.keys(v1Commands).sort())
    for (const [name, definition] of added) {
      expect(definition.description).toBe(v1Commands[name]?.description)
    }
    // The shape the user sees: the systematic: prefix and the description prefix.
    expect(added.has('systematic:git-worktree')).toBe(true)
    expect(added.get('systematic:git-worktree')?.description).toStartWith(
      '(Systematic) ',
    )
    expect(errorMessages()).toEqual([])
  })

  test('a name a native command already owns is skipped with one diagnostic across replays', async () => {
    const host = createHost({
      native: ['init', 'systematic:git-worktree'],
      directory: projectDir,
    })
    await setup(host)

    for (let attempt = 0; attempt < 3; attempt++) {
      const added = replay(host)
      expect(added.has('systematic:git-worktree')).toBe(false)
      expect(added.has('systematic:git-commit')).toBe(true)
    }

    const notes = errorMessages().filter((m) =>
      m.includes('"systematic:git-worktree"'),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
  })

  test('replaying the transform gives the same commands', async () => {
    const host = createHost({ directory: projectDir })
    await setup(host)

    const first = replay(host)
    const second = replay(host)

    expect([...second.keys()]).toEqual([...first.keys()])
  })

  test('a discovered skill whose bare name matches a native command is skipped', async () => {
    const skillDir = path.join(projectDir, '.claude/skills/review')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: A discovered review skill\n---\n# Review\n',
    )
    const other = path.join(projectDir, '.claude/skills/my-own')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(
      path.join(other, 'SKILL.md'),
      '---\nname: my-own\ndescription: Another discovered skill\n---\n# Own\n',
    )
    const host = createHost({
      native: ['init', 'review'],
      directory: projectDir,
    })
    await setup(host)

    const added = replay(host)

    expect(added.has('review')).toBe(false)
    expect(added.has('my-own')).toBe(true)
    expect(errorMessages().filter((m) => m.includes('"review"'))).toHaveLength(
      1,
    )
  })

  test('without the native-command lookup every command still registers, and the failure is reported', async () => {
    const host = createHost({ listFails: true, directory: projectDir })
    await setup(host)

    const added = replay(host)

    expect(added.size).toBeGreaterThan(10)
    expect(errorMessages()).toEqual([
      'systematic: command list failed: list exploded',
    ])
  })

  test('a throwing add is caught and the other commands still register', async () => {
    const host = createHost({ directory: projectDir })
    await setup(host)

    let attempts = 0
    for (const transform of host.transforms) {
      expect(() =>
        transform({
          add() {
            attempts += 1
            if (attempts === 2) throw new Error('add exploded')
          },
        }),
      ).not.toThrow()
    }

    expect(attempts).toBeGreaterThan(10)
    expect(errorMessages()).toHaveLength(1)
    expect(errorMessages()[0]).toContain('add exploded')
  })
})
