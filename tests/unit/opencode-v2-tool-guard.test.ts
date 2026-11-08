import { describe, expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin'

import { createSafeGuard, type V2Snapshot } from '../../src/lib/opencode-v2.js'
import {
  decideToolCall,
  installToolGuard,
  READ_ONLY_AGENT_NAMES,
  READ_ONLY_TOOL_ALLOWLIST,
} from '../../src/lib/opencode-v2-tool-guard.js'

interface RecordedHook {
  name: string
  callback: (event: Record<string, unknown>) => unknown
}

function createFakeContext(options: { hookRejects?: boolean } = {}): {
  ctx: Plugin.Context
  hooks: RecordedHook[]
} {
  const hooks: RecordedHook[] = []
  const ctx = {
    tool: {
      async hook(name: string, callback: RecordedHook['callback']) {
        if (options.hookRejects) throw new Error('hook registry unavailable')
        hooks.push({ name, callback })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  return { ctx, hooks }
}

async function install(ctx: Plugin.Context, report = (_message: string) => {}) {
  await installToolGuard({
    ctx,
    snapshot: {} as V2Snapshot,
    guard: createSafeGuard(),
    report,
  })
}

const RESEARCHER = 'connections-researcher'

describe('the allowlist', () => {
  test('is exactly read, search, skill and the two Systematic tools', () => {
    expect([...READ_ONLY_TOOL_ALLOWLIST].sort()).toEqual([
      'glob',
      'grep',
      'read',
      'skill',
      'systematic_search',
      'systematic_skill',
    ])
  })

  test('names the connections researcher', () => {
    expect(READ_ONLY_AGENT_NAMES).toContain(RESEARCHER)
  })
})

describe('decideToolCall', () => {
  test.each([...READ_ONLY_TOOL_ALLOWLIST])(
    'lets the researcher call %s',
    (tool) => {
      expect(decideToolCall(RESEARCHER, tool)).toEqual({ allowed: true })
    },
  )

  test.each([
    'shell',
    'edit',
    'write',
    'webfetch',
    'websearch',
    'subagent',
    'question',
    'execute',
    'opencode_worktree_create',
    'opencode_session_move',
    'opencode_models',
    'some_mcp_server_tool',
  ])('refuses the researcher %s, naming the tool and the reason', (tool) => {
    const verdict = decideToolCall(RESEARCHER, tool)

    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.message).toContain(tool)
      expect(verdict.message).toContain('read-only')
    }
  })

  test('matches tool names exactly, not by prefix or case', () => {
    for (const tool of [
      'read_file',
      'Read',
      'readx',
      'systematic_search2',
      '',
    ]) {
      expect(decideToolCall(RESEARCHER, tool).allowed).toBe(false)
    }
  })

  test('leaves every other agent alone', () => {
    for (const agent of [
      'build',
      'plan',
      'general',
      'unguarded-researcher',
      '',
    ]) {
      expect(decideToolCall(agent, 'shell')).toEqual({ allowed: true })
      expect(decideToolCall(agent, 'execute')).toEqual({ allowed: true })
    }
  })

  test('matches the agent name exactly', () => {
    for (const agent of ['Connections-Researcher', 'connections-researcher2']) {
      expect(decideToolCall(agent, 'shell')).toEqual({ allowed: true })
    }
  })

  test('refuses a researcher call whose tool name is not a string', () => {
    expect(decideToolCall(RESEARCHER, undefined).allowed).toBe(false)
    expect(decideToolCall(RESEARCHER, 42).allowed).toBe(false)
  })
})

describe('installToolGuard', () => {
  test('registers one execute.before hook', async () => {
    const { ctx, hooks } = createFakeContext()

    await install(ctx)

    expect(hooks.map((hook) => hook.name)).toEqual(['execute.before'])
  })

  test('the hook throws for a refused call, so the host fails that call alone', async () => {
    const { ctx, hooks } = createFakeContext()
    await install(ctx)
    const hook = hooks[0]?.callback

    expect(() =>
      hook?.({ agent: RESEARCHER, tool: 'opencode_worktree_create' }),
    ).toThrow(/opencode_worktree_create/)
    expect(() => hook?.({ agent: RESEARCHER, tool: 'execute' })).toThrow(
      /execute/,
    )
  })

  test('the hook returns quietly for an allowed call and for another agent', async () => {
    const { ctx, hooks } = createFakeContext()
    await install(ctx)
    const hook = hooks[0]?.callback

    expect(() => hook?.({ agent: RESEARCHER, tool: 'read' })).not.toThrow()
    expect(() => hook?.({ agent: 'build', tool: 'shell' })).not.toThrow()
  })

  test('the hook does not touch the event, so another plugin sees the call as it was', async () => {
    const { ctx, hooks } = createFakeContext()
    await install(ctx)
    const event = { agent: RESEARCHER, tool: 'read', input: { path: 'x' } }

    hooks[0]?.callback(event)

    expect(event).toEqual({
      agent: RESEARCHER,
      tool: 'read',
      input: { path: 'x' },
    })
  })

  test('a hook registration that fails rejects, so setup can keep the guarded agents out', async () => {
    const { ctx } = createFakeContext({ hookRejects: true })

    await expect(install(ctx)).rejects.toThrow('hook registry unavailable')
  })
})
