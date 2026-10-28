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

import { setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import {
  addBundledSkill,
  restoreSkillResults,
  type V2SkillRecord,
} from '../../src/lib/opencode-v2-skills.js'
import { createSkillOutputStore } from '../../src/lib/skill-tool.js'

const PACKAGE_ROOT = path.resolve(import.meta.dir, '../..')

interface AssertCall {
  sessionID: string
  agent?: string
  action: string
  resources: string[]
  source?: { type: string; messageID: string; id: string }
}

interface ToolContextStub {
  sessionID: string
  agent: string
  messageID: string
  id: string
  progress: (update: unknown) => Promise<void>
  signal: AbortSignal
}

interface RegisteredTool {
  name: string
  description: string
  input: Record<string, unknown>
  options?: { codemode?: boolean; pinned?: boolean }
  execute: (
    input: unknown,
    context: ToolContextStub,
  ) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

/**
 * A stand-in host context with just the registries the skills installer
 * touches. Registered callbacks are kept so a test can replay them.
 */
function createSkillsContext(
  directory: string,
  options: { assert?: (call: AssertCall) => Promise<void> } = {},
) {
  const skillTransforms: ((editor: FakeSkillEditor) => void)[] = []
  const toolTransforms: ((editor: FakeToolEditor) => void)[] = []
  const hooks: { name: string; callback: (event: unknown) => unknown }[] = []
  const asserts: AssertCall[] = []
  const ctx = {
    location: { directory },
    session: {
      async hook(name: string, callback: (event: unknown) => unknown) {
        hooks.push({ name, callback })
      },
    },
    agent: { async transform() {} },
    command: {
      async list() {
        return { data: [] }
      },
      async transform() {},
    },
    skill: {
      async transform(callback: (editor: FakeSkillEditor) => void) {
        skillTransforms.push(callback)
      },
    },
    tool: {
      async transform(callback: (editor: FakeToolEditor) => void) {
        toolTransforms.push(callback)
      },
    },
    permission: {
      async assert(call: AssertCall) {
        asserts.push(call)
        await options.assert?.(call)
      },
    },
  } as unknown as Plugin.Context
  return { ctx, skillTransforms, toolTransforms, hooks, asserts }
}

interface FakeSkillEditor {
  skills: Map<string, V2SkillRecord>
  get(id: string): V2SkillRecord | undefined
  add(skill: V2SkillRecord): void
}

function createSkillEditor(
  preexisting: readonly string[] = [],
  failingIds: readonly string[] = [],
): FakeSkillEditor {
  const skills = new Map<string, V2SkillRecord>()
  for (const id of preexisting) {
    skills.set(id, { id, name: id, path: `/other/${id}/SKILL.md`, content: '' })
  }
  return {
    skills,
    get: (id) => skills.get(id),
    add(skill) {
      if (failingIds.includes(skill.id)) {
        throw new Error(`add failed for ${skill.id}`)
      }
      skills.set(skill.id, skill)
    },
  }
}

interface FakeToolEditor {
  tools: Map<string, RegisteredTool>
  get(id: string): RegisteredTool | undefined
  add(tool: RegisteredTool): void
}

function createToolEditor(preexisting: readonly string[] = []): FakeToolEditor {
  const tools = new Map<string, RegisteredTool>()
  for (const name of preexisting) {
    tools.set(name, {
      name,
      description: '',
      input: {},
      execute: async () => ({}),
    })
  }
  return {
    tools,
    get: (id) => tools.get(id),
    add(tool) {
      tools.set(tool.name, tool)
    },
  }
}

let tempRoot: string
let projectDir: string
let homeDir: string
let errorSpy: Mock<typeof console.error>
let warnSpy: Mock<typeof console.warn>
const ORIGINAL_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR

beforeEach(() => {
  tempRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'oc-v2-skills-'),
  )
  projectDir = path.join(tempRoot, 'project')
  homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
  fs.mkdirSync(path.join(homeDir, '.config/opencode'), { recursive: true })
  delete process.env.OPENCODE_CONFIG_DIR
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  warnSpy.mockRestore()
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function writeProjectConfig(content: unknown): void {
  fs.writeFileSync(
    path.join(projectDir, '.opencode/systematic.json'),
    JSON.stringify(content),
  )
}

function errorMessages(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]))
}

async function setup(
  config?: unknown,
  options: { assert?: (call: AssertCall) => Promise<void> } = {},
) {
  if (config !== undefined) writeProjectConfig(config)
  const host = createSkillsContext(projectDir, options)
  await setupOpenCodeV2(host.ctx, { packageRoot: PACKAGE_ROOT, homeDir })
  return host
}

function toolContext(
  overrides: Partial<ToolContextStub> = {},
): ToolContextStub {
  return {
    sessionID: 'session-1',
    agent: 'agent-1',
    messageID: 'message-1',
    id: 'call-1',
    progress: async () => {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function registeredTool(
  host: Awaited<ReturnType<typeof setup>>,
): Promise<RegisteredTool> {
  const editor = createToolEditor()
  host.toolTransforms[0]?.(editor)
  const tool = editor.tools.get('systematic_skill')
  if (tool === undefined) throw new Error('systematic_skill was not registered')
  return tool
}

describe('bundled skill registration', () => {
  test('adds every enabled bundled skill with its name as the id, its file as the path and its body as the content', async () => {
    const host = await setup()
    expect(host.skillTransforms).toHaveLength(1)
    const editor = createSkillEditor()

    host.skillTransforms[0]?.(editor)

    const git = editor.skills.get('git-worktree')
    expect(git).toBeDefined()
    expect(git?.name).toBe('git-worktree')
    expect(git?.description?.length ?? 0).toBeGreaterThan(10)
    // The path lets the host resolve the skill's base directory and references.
    expect(git?.path).toBe(
      path.join(PACKAGE_ROOT, 'skills/git-worktree/SKILL.md'),
    )
    // The body has no frontmatter.
    expect(git?.content.startsWith('---')).toBe(false)
    expect(git?.content).toBe(git?.content.trim() as string)
    expect(git?.content.length ?? 0).toBeGreaterThan(100)
    // Skills whose name carries a colon keep it as the id.
    expect(editor.skills.has('ce:review')).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('a disabled skill is never added', async () => {
    const host = await setup({ disabled_skills: ['git-worktree'] })
    const editor = createSkillEditor()

    host.skillTransforms[0]?.(editor)

    expect(editor.skills.has('git-worktree')).toBe(false)
    expect(editor.skills.has('git-commit')).toBe(true)
  })

  test('a skill that opts out of model invocation is added with autoinvoke off, the others leave it unset', async () => {
    const host = await setup()
    const editor = createSkillEditor()

    host.skillTransforms[0]?.(editor)

    const hidden = [...editor.skills.values()].filter(
      (skill) => skill.autoinvoke === false,
    )
    const plain = [...editor.skills.values()].filter(
      (skill) => skill.autoinvoke === undefined,
    )
    expect(hidden.length + plain.length).toBe(editor.skills.size)
    expect(plain.length).toBeGreaterThan(10)
  })

  test('replaying the transform on a fresh editor gives the same skills', async () => {
    const host = await setup()
    const first = createSkillEditor()
    const second = createSkillEditor()

    host.skillTransforms[0]?.(first)
    host.skillTransforms[0]?.(second)

    expect(first.skills.size).toBeGreaterThan(10)
    expect([...second.skills.entries()]).toEqual([...first.skills.entries()])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('an id an earlier plugin defined is skipped with one diagnostic across replays', async () => {
    const host = await setup()

    for (let attempt = 0; attempt < 3; attempt++) {
      const editor = createSkillEditor(['git-worktree'])
      host.skillTransforms[0]?.(editor)
      expect(editor.skills.get('git-worktree')?.path).toBe(
        '/other/git-worktree/SKILL.md',
      )
      expect(editor.skills.has('git-commit')).toBe(true)
    }

    const clashes = errorMessages().filter((message) =>
      message.includes('"git-worktree"'),
    )
    expect(clashes).toHaveLength(1)
    expect(clashes[0]).toStartWith('systematic: ')
  })

  test('an add that throws is caught and the other skills still register', async () => {
    const host = await setup()
    const editor = createSkillEditor([], ['git-worktree'])

    expect(() => host.skillTransforms[0]?.(editor)).not.toThrow()

    expect(editor.skills.has('git-worktree')).toBe(false)
    expect(editor.skills.has('git-commit')).toBe(true)
    expect(errorMessages()).toHaveLength(1)
    expect(errorMessages()[0]).toContain('git-worktree')
  })

  test('addBundledSkill leaves an existing id untouched', () => {
    const editor = createSkillEditor(['x'])
    const record: V2SkillRecord = {
      id: 'x',
      name: 'x',
      path: '/ours/x/SKILL.md',
      content: 'ours',
    }

    addBundledSkill(editor, record, new Set(), () => {})

    expect(editor.skills.get('x')?.content).toBe('')
  })
})

describe('systematic_skill tool registration', () => {
  test('registers a direct JSON Schema tool with no codemode', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    expect(tool.name).toBe('systematic_skill')
    expect(tool.options).toEqual({ codemode: false })
    expect(tool.input).toMatchObject({
      type: 'object',
      required: ['name'],
      additionalProperties: false,
    })
    expect(tool.description).toContain('systematic:git-worktree')
  })

  test('a disabled skill is absent from the description', async () => {
    const host = await setup({ disabled_skills: ['git-worktree'] })
    const tool = await registeredTool(host)

    expect(tool.description).not.toContain('systematic:git-worktree')
    expect(tool.description).toContain('systematic:git-commit')
  })

  test('a tool another plugin already registered under the name is left alone with one diagnostic', async () => {
    const host = await setup()

    for (let attempt = 0; attempt < 2; attempt++) {
      const editor = createToolEditor(['systematic_skill'])
      host.toolTransforms[0]?.(editor)
      expect(editor.tools.get('systematic_skill')?.description).toBe('')
    }

    const clashes = errorMessages().filter((message) =>
      message.includes('systematic_skill'),
    )
    expect(clashes).toHaveLength(1)
  })
})

describe('systematic_skill execute', () => {
  test('loads an enabled skill by bare name and by prefixed name', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    const bare = await tool.execute({ name: 'git-worktree' }, toolContext())
    const prefixed = await tool.execute(
      { name: 'systematic:git-worktree' },
      toolContext(),
    )

    expect(bare.content).toContain(
      '<skill_content name="systematic:git-worktree">',
    )
    expect(bare.content).toContain('Base directory for this skill:')
    expect(prefixed.content).toBe(bare.content)
    expect(bare.metadata).toMatchObject({ name: 'systematic:git-worktree' })
  })

  test('asks the host permission check with action skill and the bare skill name as the resource, before returning', async () => {
    const order: string[] = []
    const host = await setup(undefined, {
      assert: async () => {
        order.push('assert')
      },
    })
    const tool = await registeredTool(host)

    await tool.execute(
      { name: 'systematic:git-worktree' },
      toolContext({
        progress: async () => {
          order.push('progress')
        },
      }),
    )

    expect(host.asserts).toEqual([
      {
        sessionID: 'session-1',
        agent: 'agent-1',
        action: 'skill',
        resources: ['git-worktree'],
        source: { type: 'tool', messageID: 'message-1', id: 'call-1' },
      },
    ])
    // The check runs before anything is reported or returned.
    expect(order).toEqual(['assert', 'progress'])
  })

  test('a denied skill rejects with the host error and returns nothing', async () => {
    const denied = new Error('Permission denied: skill')
    const host = await setup(undefined, {
      assert: async () => {
        throw denied
      },
    })
    const tool = await registeredTool(host)

    await expect(
      tool.execute({ name: 'git-worktree' }, toolContext()),
    ).rejects.toBe(denied)
  })

  test('a skill in disabled_skills is refused with the not-found message and no permission check', async () => {
    const host = await setup({ disabled_skills: ['git-worktree'] })
    const tool = await registeredTool(host)

    await expect(
      tool.execute({ name: 'systematic:git-worktree' }, toolContext()),
    ).rejects.toThrow(
      'Skill "systematic:git-worktree" not found. Available systematic skills:',
    )
    expect(host.asserts).toHaveLength(0)
  })

  test('an unknown skill lists the available ones and asks nothing', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    await expect(tool.execute({ name: 'nope' }, toolContext())).rejects.toThrow(
      'Skill "nope" not found. Available systematic skills:',
    )
    expect(host.asserts).toHaveLength(0)
  })

  test('arguments are substituted for $ARGUMENTS', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    const withArgs = await tool.execute(
      { name: 'reproduce-bug', arguments: 'ISSUE-1234-MARKER' },
      toolContext(),
    )
    const without = await tool.execute(
      { name: 'reproduce-bug' },
      toolContext({ id: 'call-2' }),
    )

    expect(withArgs.content).toContain('ISSUE-1234-MARKER')
    expect(withArgs.content).not.toContain('$ARGUMENTS')
    expect(without.content).toContain('$ARGUMENTS')
  })

  test('rejects input without a string name, before any lookup', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    for (const input of [undefined, null, {}, { name: 3 }, 'git-worktree']) {
      await expect(tool.execute(input, toolContext())).rejects.toThrow(
        'systematic_skill requires a "name" string',
      )
    }
    await expect(
      tool.execute({ name: 'git-worktree', arguments: 5 }, toolContext()),
    ).rejects.toThrow('"arguments" must be a string')
    expect(host.asserts).toHaveLength(0)
  })

  test('a progress update that fails does not fail the load', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    const result = await tool.execute(
      { name: 'git-worktree' },
      toolContext({
        progress: async () => {
          throw new Error('progress failed')
        },
      }),
    )

    expect(result.content).toContain('<skill_content')
    expect(errorMessages()).toEqual([
      'systematic: skill progress failed: progress failed',
    ])
  })
})

// --- Truncation restoration --------------------------------------------------

function toolResultMessage(id: string, name: string, texts: string[]) {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        id,
        name,
        result: {
          type: 'content',
          value: texts.map((text) => ({ type: 'text', text })),
        },
      },
    ],
  }
}

describe('restoreSkillResults', () => {
  test('replaces the matching tool-result with the full text and leaves the rest', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        toolResultMessage('c1', 'systematic_skill', [
          'TRUNCATED',
          '[showing lines 1-5 of 99; full output saved to /tmp/x]',
        ]),
        toolResultMessage('c9', 'systematic_skill', ['OTHER']),
        toolResultMessage('c1', 'skill', ['NATIVE']),
      ],
    }

    restoreSkillResults(store, event)

    const [, restored, otherCall, otherTool] = event.messages as ReturnType<
      typeof toolResultMessage
    >[]
    expect(restored?.content[0]?.result).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'FULL-OUTPUT' }],
    })
    // A different call id, and the same id under another tool name, stay as they are.
    expect(otherCall?.content[0]?.result.value).toEqual([
      { type: 'text', text: 'OTHER' },
    ])
    expect(otherTool?.content[0]?.result.value).toEqual([
      { type: 'text', text: 'NATIVE' },
    ])
  })

  test('restores on every request, because the store is read and not consumed', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')

    for (let request = 0; request < 3; request++) {
      const event = {
        sessionID: 's',
        messages: [toolResultMessage('c1', 'systematic_skill', ['CUT'])],
      }
      restoreSkillResults(store, event)
      expect(
        (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
          ?.result.value,
      ).toEqual([{ type: 'text', text: 'FULL-OUTPUT' }])
    }
  })

  test('does not depend on the host marker text', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        toolResultMessage('c1', 'systematic_skill', ['no marker here']),
      ],
    }

    restoreSkillResults(store, event)

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: 'FULL-OUTPUT' }])
  })

  test('does not cross sessions', () => {
    const store = createSkillOutputStore()
    store.put('other-session', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [toolResultMessage('c1', 'systematic_skill', ['CUT'])],
    }

    restoreSkillResults(store, event)

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: 'CUT' }])
  })

  test('ignores events and messages of any other shape without throwing', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')

    for (const event of [
      undefined,
      null,
      'text',
      {},
      { sessionID: 's' },
      { sessionID: 's', messages: 'nope' },
      { sessionID: 's', messages: [null, 3, { role: 'tool' }, { content: 5 }] },
      {
        sessionID: 's',
        messages: [{ role: 'tool', content: [null, { type: 'tool-result' }] }],
      },
      { messages: [toolResultMessage('c1', 'systematic_skill', ['CUT'])] },
    ]) {
      expect(() => restoreSkillResults(store, event)).not.toThrow()
    }
  })
})

describe('context hook wiring', () => {
  test('registers one context hook, and a load followed by a request returns the full text', async () => {
    const host = await setup()
    const tool = await registeredTool(host)
    const contextHooks = host.hooks.filter((hook) => hook.name === 'context')
    expect(contextHooks).toHaveLength(1)

    const loaded = await tool.execute(
      { name: 'git-worktree' },
      toolContext({ sessionID: 's-restore', id: 'call-restore' }),
    )
    const event = {
      sessionID: 's-restore',
      messages: [
        toolResultMessage('call-restore', 'systematic_skill', [
          'CUT',
          'marker',
        ]),
      ],
    }
    await contextHooks[0]?.callback(event)

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: loaded.content ?? '' }])
  })

  test('a failed permission check stores nothing to restore', async () => {
    const host = await setup(undefined, {
      assert: async () => {
        throw new Error('denied')
      },
    })
    const tool = await registeredTool(host)
    await tool
      .execute(
        { name: 'git-worktree' },
        toolContext({ sessionID: 's-deny', id: 'call-deny' }),
      )
      .catch(() => {})
    const event = {
      sessionID: 's-deny',
      messages: [toolResultMessage('call-deny', 'systematic_skill', ['CUT'])],
    }

    await host.hooks.find((hook) => hook.name === 'context')?.callback(event)

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: 'CUT' }])
  })

  test('a malformed request never throws out of the hook', async () => {
    const host = await setup()
    const hook = host.hooks.find((candidate) => candidate.name === 'context')

    await expect(
      Promise.resolve(hook?.callback({ sessionID: 3, messages: [{}] })),
    ).resolves.toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('a store that throws is reported and the hook still returns', async () => {
    const host = await setup()
    const hook = host.hooks.find((candidate) => candidate.name === 'context')
    const hostile = {
      sessionID: 's',
      get messages(): unknown {
        throw new Error('hostile getter')
      },
    }

    await expect(
      Promise.resolve(hook?.callback(hostile)),
    ).resolves.toBeUndefined()
    expect(errorMessages()).toEqual([
      'systematic: skill output restore failed: hostile getter',
    ])
  })
})
