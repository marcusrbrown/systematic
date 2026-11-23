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
  createDurableSkillOutputs,
  DURABLE_DEADLINE_MS,
  DURABLE_MAX_AGE_MS,
  DURABLE_MAX_ENTRIES,
  DURABLE_MAX_ENTRY_BYTES,
  DURABLE_MAX_MISSES,
  DURABLE_MISS_TTL_MS,
  restoreSkillResults,
  type SkillCallIds,
  skillOutputHandle,
  type V2SkillRecord,
  type V2Storage,
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
  options: {
    assert?: (call: AssertCall) => Promise<void>
    storage?: V2Storage
  } = {},
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
      async hook() {},
    },
    permission: {
      async assert(call: AssertCall) {
        asserts.push(call)
        await options.assert?.(call)
      },
    },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
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
  options: {
    assert?: (call: AssertCall) => Promise<void>
    storage?: V2Storage
  } = {},
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

/** The host collapses a single text part to `{ type: 'text' }` before the hook runs. */
function textToolResultMessage(id: string, name: string, text: string) {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', id, name, result: { type: 'text', value: text } },
    ],
  }
}

type ToolResultMessage = ReturnType<typeof textToolResultMessage>

/** The assistant message every test call belongs to: the default `messageID` of `toolContext`. */
const OWNER = 'message-1'

/** The in-memory store key of a test call. */
function handleOf(callID: string): string {
  return skillOutputHandle(OWNER, callID)
}

/** The identity of a test call. */
function ids(callID: string, sessionID = 's', messageID = OWNER): SkillCallIds {
  return { sessionID, messageID, callID }
}

type Part = { type?: unknown; name?: unknown; id?: unknown }

/**
 * The request the host sends: before each tool message, the assistant message
 * that made its calls. The tool messages are the same objects, so a test reads
 * its results from the event it built.
 */
function owned<T>(event: T, messageID = OWNER): T {
  if (typeof event !== 'object' || event === null) return event
  const { messages } = event as { messages?: unknown }
  if (!Array.isArray(messages)) return event
  const withOwners = messages.flatMap((message: unknown) => {
    const tool = message as { role?: unknown; content?: unknown } | null
    if (tool?.role !== 'tool' || !Array.isArray(tool.content)) return [message]
    const calls = (tool.content as Part[])
      .filter((part) => part?.type === 'tool-result')
      .map((part) => ({
        type: 'tool-call',
        id: part.id,
        name: part.name,
        input: {},
      }))
    return [{ role: 'assistant', id: messageID, content: calls }, message]
  })
  return { ...event, messages: withOwners }
}

describe('restoreSkillResults', () => {
  test('replaces the matching tool-result with the full text and leaves the rest', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
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

    restoreSkillResults(store, owned(event))

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
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')

    for (let request = 0; request < 3; request++) {
      const event = {
        sessionID: 's',
        messages: [toolResultMessage('c1', 'systematic_skill', ['CUT'])],
      }
      restoreSkillResults(store, owned(event))
      expect(
        (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
          ?.result.value,
      ).toEqual([{ type: 'text', text: 'FULL-OUTPUT' }])
    }
  })

  test('does not depend on the host marker text', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        toolResultMessage('c1', 'systematic_skill', ['no marker here']),
      ],
    }

    restoreSkillResults(store, owned(event))

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: 'FULL-OUTPUT' }])
  })

  test('does not cross sessions', () => {
    const store = createSkillOutputStore()
    store.put('other-session', handleOf('c1'), 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [toolResultMessage('c1', 'systematic_skill', ['CUT'])],
    }

    restoreSkillResults(store, owned(event))

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: 'CUT' }])
  })

  test('leaves a text result unchanged when it already holds the full text', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        textToolResultMessage('c1', 'systematic_skill', 'FULL-OUTPUT'),
      ],
    }

    restoreSkillResults(store, owned(event))

    expect((event.messages[0] as ToolResultMessage).content[0]?.result).toEqual(
      { type: 'text', value: 'FULL-OUTPUT' },
    )
  })

  test('leaves a content result unchanged when its only text part is the full text', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [toolResultMessage('c1', 'systematic_skill', ['FULL-OUTPUT'])],
    }

    restoreSkillResults(store, owned(event))

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result,
    ).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'FULL-OUTPUT' }],
    })
  })

  test('restores a truncated text result as text, not as content', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [textToolResultMessage('c1', 'systematic_skill', 'CUT')],
    }

    restoreSkillResults(store, owned(event))

    expect((event.messages[0] as ToolResultMessage).content[0]?.result).toEqual(
      { type: 'text', value: 'FULL-OUTPUT' },
    )
  })

  test('restores a truncated content result as content and drops the host marker', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        toolResultMessage('c1', 'systematic_skill', ['CUT', '[showing 1-5]']),
      ],
    }

    restoreSkillResults(store, owned(event))

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result,
    ).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'FULL-OUTPUT' }],
    })
  })

  test('leaves a result of either kind unchanged when the store has no entry', () => {
    const store = createSkillOutputStore()
    const event = {
      sessionID: 's',
      messages: [
        textToolResultMessage('c1', 'systematic_skill', 'TEXT'),
        toolResultMessage('c2', 'systematic_skill', ['CONTENT']),
      ],
    }

    restoreSkillResults(store, owned(event))

    const [text, content] = event.messages as [
      ToolResultMessage,
      ReturnType<typeof toolResultMessage>,
    ]
    expect(text.content[0]?.result).toEqual({ type: 'text', value: 'TEXT' })
    expect(content.content[0]?.result).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'CONTENT' }],
    })
  })

  test('does not overwrite an error result, even when the store has the full text', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')
    // The shape the hook receives: the host's normalized `{ type: 'error', value }`,
    // whose value is the stored `{ error, content }` (ToolResultValue.make).
    const failed = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'c1',
          name: 'systematic_skill',
          result: { type: 'error', value: { error: 'boom', content: [] } },
        },
      ],
    }

    restoreSkillResults(store, owned({ sessionID: 's', messages: [failed] }))

    expect(failed.content[0]?.result).toEqual({
      type: 'error',
      value: { error: 'boom', content: [] },
    })
  })

  test('ignores events and messages of any other shape without throwing', () => {
    const store = createSkillOutputStore()
    store.put('s', handleOf('c1'), 'FULL-OUTPUT')

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
      expect(() => restoreSkillResults(store, owned(event))).not.toThrow()
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
    await contextHooks[0]?.callback(owned(event))

    expect(
      (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
        ?.result.value,
    ).toEqual([{ type: 'text', text: loaded.content ?? '' }])
  })

  test('the registered hook keeps the host result shape on every request: an uncut load is untouched and a cut load is restored in full, as the same kind', async () => {
    const host = await setup()
    const tool = await registeredTool(host)
    const hook = host.hooks.find((candidate) => candidate.name === 'context')
    // The hook is the subject: without it nothing below runs, so say so.
    if (hook === undefined)
      throw new Error('the context hook is not registered')

    const sessionID = 's-shape'
    const full = new Map<string, string>()
    const fullOf = (id: string) => full.get(id) ?? ''
    for (const id of ['call-fit', 'call-cut-text', 'call-cut-content']) {
      const loaded = await tool.execute(
        { name: 'git-worktree' },
        toolContext({ sessionID, id }),
      )
      full.set(id, loaded.content ?? '')
      expect(full.get(id)).toContain('<skill_content')
    }

    // The host builds a fresh request from history each time, so each round
    // starts from the host's own result and runs the hook again.
    for (let request = 1; request <= 3; request++) {
      const event = {
        sessionID,
        messages: [
          // Under the host limit: its single text part is the whole skill.
          textToolResultMessage(
            'call-fit',
            'systematic_skill',
            fullOf('call-fit'),
          ),
          // Over the limit and cut to one text part, as `{ type: 'text' }`.
          textToolResultMessage('call-cut-text', 'systematic_skill', 'CUT'),
          // Over the limit and cut to a preview plus the marker, as `content`.
          toolResultMessage('call-cut-content', 'systematic_skill', [
            'CUT',
            '[showing lines 1-5]',
          ]),
        ],
      }

      await hook.callback(owned(event))

      const [fit, cutText, cutContent] = event.messages as [
        ToolResultMessage,
        ToolResultMessage,
        ReturnType<typeof toolResultMessage>,
      ]
      expect(fit.content[0]?.result, `request ${request}: uncut`).toEqual({
        type: 'text',
        value: fullOf('call-fit'),
      })
      expect(
        cutText.content[0]?.result,
        `request ${request}: cut text`,
      ).toEqual({ type: 'text', value: fullOf('call-cut-text') })
      expect(
        cutContent.content[0]?.result,
        `request ${request}: cut content`,
      ).toEqual({
        type: 'content',
        value: [{ type: 'text', text: fullOf('call-cut-content') }],
      })
    }
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

    await host.hooks
      .find((hook) => hook.name === 'context')
      ?.callback(owned(event))

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

// --- Durable restore ---------------------------------------------------------

type StorageOp = 'get' | 'set' | 'remove' | 'scan'

/**
 * The host's plugin storage as a map with the host's scan: ordered by key, a
 * page limit and a `next` cursor. Every call is recorded; a test can make an
 * operation fail or never answer. Values are cloned through JSON, as the host's
 * database does.
 */
function createFakeStorage(data = new Map<string, unknown>()) {
  const calls: { op: StorageOp; key: string }[] = []
  const fail: Partial<Record<StorageOp, Error>> = {}
  const hang: Partial<Record<StorageOp, boolean>> = {}
  const slow = { ms: 0 }
  const enter = async (op: StorageOp, key: string) => {
    calls.push({ op, key })
    if (slow.ms > 0) await Bun.sleep(slow.ms)
    if (hang[op] === true) await new Promise<never>(() => {})
    const error = fail[op]
    if (error !== undefined) throw error
  }
  const storage: V2Storage = {
    async get(key) {
      await enter('get', key)
      return data.has(key) ? structuredClone(data.get(key)) : undefined
    },
    async set(key, value) {
      await enter('set', key)
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    async remove(key) {
      await enter('remove', key)
      data.delete(key)
    },
    async scan(options) {
      await enter('scan', options.prefix)
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000)
      const rows = [...data.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .filter((key) => options.after === undefined || key > options.after)
        .sort()
      const entries = rows
        .slice(0, limit)
        .map((key) => ({ key, value: structuredClone(data.get(key)) }))
      const last = entries.at(-1)
      return rows.length > limit && last !== undefined
        ? { entries, next: last.key }
        : { entries }
    },
  }
  return { ...storage, data, calls, fail, hang, slow } as V2Storage & {
    slow: { ms: number }
    data: Map<string, unknown>
    calls: { op: StorageOp; key: string }[]
    fail: Partial<Record<StorageOp, Error>>
    hang: Partial<Record<StorageOp, boolean>>
  }
}

const KEY_PREFIX = 'systematic:skill-output:'
const DAY_MS = 24 * 60 * 60 * 1000

/** A stored record as the plugin writes it, for seeding storage. */
function record(callID: string, storedAt: number, output = `OUT-${callID}`) {
  return {
    v: 2,
    sessionID: 's',
    messageID: OWNER,
    callID,
    output,
    storedAt,
  }
}

function seed(
  storage: { data: Map<string, unknown> },
  callID: string,
  storedAt: number,
) {
  storage.data.set(
    `${KEY_PREFIX}s:message-1:${callID}`,
    record(callID, storedAt),
  )
}

function storedCalls(storage: { data: Map<string, unknown> }): string[] {
  return [...storage.data.keys()].sort()
}

/** A skill the host cuts (about 97 KB), and one it does not. */
const OVER_LIMIT_SKILL = 'ce:review'
const UNDER_LIMIT_SKILL = 'git-worktree'

function cutRequest(sessionID: string, callID: string) {
  return {
    sessionID,
    messages: [
      toolResultMessage(callID, 'systematic_skill', [
        'CUT',
        '[showing lines 1-5 of 999; full output saved to /tmp/x]',
      ]),
    ],
  }
}

function contextHook(host: Awaited<ReturnType<typeof setup>>) {
  const hook = host.hooks.find((candidate) => candidate.name === 'context')
  if (hook === undefined) throw new Error('the context hook is not registered')
  return (event: unknown) => hook.callback(owned(event))
}

function resultOf(event: ReturnType<typeof cutRequest>): unknown {
  return (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
    ?.result
}

describe('durable skill output: persist on execute', () => {
  test('writes every load, a skill over the host limit and one under it, as the exact rendered output with its ids and time', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const big = await tool.execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ sessionID: 's-1', id: 'call-big' }),
    )
    const small = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's-1', id: 'call-small' }),
    )

    expect(Buffer.byteLength(big.content ?? '')).toBeGreaterThan(51_200)
    expect(Buffer.byteLength(small.content ?? '')).toBeLessThan(51_200)
    expect(storage.data.get(`${KEY_PREFIX}s-1:message-1:call-big`)).toEqual({
      v: 2,
      sessionID: 's-1',
      messageID: 'message-1',
      callID: 'call-big',
      output: big.content,
      storedAt: expect.any(Number),
    })
    expect(
      storage.data.get(`${KEY_PREFIX}s-1:message-1:call-small`),
    ).toMatchObject({
      callID: 'call-small',
      output: small.content,
    })
    expect(errorMessages()).toEqual([])
  })

  test('a storage that fails the write does not fail the skill call, and says so once', async () => {
    const storage = createFakeStorage()
    storage.fail.set = new Error('disk full')
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const first = await tool.execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ id: 'call-a' }),
    )
    const second = await tool.execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ id: 'call-b' }),
    )

    expect(first.content).toContain('<skill_content')
    expect(second.content).toBe(first.content)
    expect(errorMessages()).toEqual([
      'systematic: skill output could not be kept across a restart: disk full',
    ])
  })

  test('a storage that never answers does not hold the skill call or the model request past the deadline', async () => {
    const storage = createFakeStorage()
    storage.hang.set = true
    storage.hang.get = true
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const startedLoad = Date.now()
    const loaded = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's-hang', id: 'call-hang' }),
    )
    const loadMs = Date.now() - startedLoad
    // A restart: a new installer, so no memory entry; the read hangs too.
    const after = await setup(undefined, { storage })
    const event = cutRequest('s-hang', 'call-hang')
    const startedRead = Date.now()
    await contextHook(after)(event)
    const readMs = Date.now() - startedRead

    expect(loaded.content).toContain('<skill_content')
    expect(loadMs).toBeGreaterThanOrEqual(DURABLE_DEADLINE_MS - 100)
    expect(loadMs).toBeLessThan(DURABLE_DEADLINE_MS + 1500)
    expect(readMs).toBeLessThan(DURABLE_DEADLINE_MS + 1500)
    expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
    expect(errorMessages()).toEqual([
      `systematic: skill output write did not finish in time, so no more skill output is kept across a restart: storage did not answer within ${DURABLE_DEADLINE_MS} ms`,
      `systematic: kept skill output could not be read: storage did not answer within ${DURABLE_DEADLINE_MS} ms`,
    ])
  }, 15_000)

  test('a host without plugin storage loads the skill and keeps the in-memory restore', async () => {
    const host = await setup()
    const tool = await registeredTool(host)

    const loaded = await tool.execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ sessionID: 's-mem', id: 'call-mem' }),
    )
    const event = cutRequest('s-mem', 'call-mem')
    await contextHook(host)(event)

    expect(resultOf(event)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: loaded.content }],
    })
  })
})

describe('durable skill output: the cap, and entries listed by prefix', () => {
  test('the defaults are 1 MiB per entry, 32 entries, 7 days, a 2 s deadline and 256 remembered misses', () => {
    expect(DURABLE_MAX_ENTRY_BYTES).toBe(1024 * 1024)
    expect(DURABLE_MAX_ENTRIES).toBe(32)
    expect(DURABLE_MAX_AGE_MS).toBe(7 * DAY_MS)
    expect(DURABLE_DEADLINE_MS).toBe(2000)
    expect(DURABLE_MAX_MISSES).toBe(256)
  })

  test('an output over the byte cap is not written, is a remembered miss, and says so once', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      maxEntryBytes: 10,
      report: (message) => reports.push(message),
    })

    await durable.put(ids('c1'), '1234567890')
    await durable.put(ids('c2'), '12345678901')
    await durable.put(ids('c3'), '€€€€')
    storage.calls.length = 0

    expect(await durable.get(ids('c1'))).toBe('1234567890')
    expect(await durable.get(ids('c2'))).toBeUndefined()
    expect(await durable.get(ids('c3'))).toBeUndefined()
    // Only the entry that was kept needed a read.
    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('over 10 bytes')
  })

  test('keeps the newest entries, removes the rest, and leaves no key but the records', async () => {
    const storage = createFakeStorage()
    let clock = 1000
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 3,
      now: () => clock++,
    })

    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      await durable.put(ids(id), `OUT-${id}`)
    }

    expect(storedCalls(storage)).toEqual([
      `${KEY_PREFIX}s:message-1:c3`,
      `${KEY_PREFIX}s:message-1:c4`,
      `${KEY_PREFIX}s:message-1:c5`,
    ])
    expect(await durable.get(ids('c5'))).toBe('OUT-c5')
  })

  test('writes the entry before it lists or removes anything', async () => {
    const storage = createFakeStorage()
    seed(storage, 'old', 1)
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 1,
      now: () => 100,
    })

    await durable.put(ids('new'), 'OUT-new')

    expect(storage.calls.map((call) => call.op)).toEqual([
      'set',
      'scan',
      'remove',
    ])
  })

  test('ranks the entry just written like any other, so an older one is not kept past the cap', async () => {
    const storage = createFakeStorage()
    seed(storage, 'ahead', 9_999)
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 1,
      now: () => 100,
    })

    await durable.put(ids('behind'), 'OUT-behind')

    expect(storedCalls(storage)).toEqual([`${KEY_PREFIX}s:message-1:ahead`])
  })

  test('writing a key again refreshes its time, so it is the last to go', async () => {
    const storage = createFakeStorage()
    let clock = 1
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 2,
      now: () => clock++,
    })

    await durable.put(ids('c1'), 'ONE')
    await durable.put(ids('c2'), 'TWO')
    await durable.put(ids('c1'), 'ONE-AGAIN')
    await durable.put(ids('c3'), 'THREE')

    expect(await durable.get(ids('c2'))).toBeUndefined()
    expect(await durable.get(ids('c1'))).toBe('ONE-AGAIN')
    expect(await durable.get(ids('c3'))).toBe('THREE')
  })

  test('lists every page of the prefix, so a long backlog is trimmed to the cap', async () => {
    const storage = createFakeStorage()
    for (let index = 0; index < 230; index++)
      seed(storage, `c${String(index).padStart(3, '0')}`, 1000 + index)
    storage.data.set('someone-else:key', 'untouched')
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 5,
      now: () => 5000,
    })

    await durable.put(ids('newest'), 'OUT-newest')

    const kept = storedCalls(storage).filter((key) =>
      key.startsWith(KEY_PREFIX),
    )
    expect(kept).toEqual([
      `${KEY_PREFIX}s:message-1:c226`,
      `${KEY_PREFIX}s:message-1:c227`,
      `${KEY_PREFIX}s:message-1:c228`,
      `${KEY_PREFIX}s:message-1:c229`,
      `${KEY_PREFIX}s:message-1:newest`,
    ])
    expect(storage.data.get('someone-else:key')).toBe('untouched')
  })

  test('ids with the key separator in them do not share an entry', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)

    await durable.put(ids('c', 'a:b'), 'FIRST')
    await durable.put(ids('b:c', 'a'), 'SECOND')

    expect(await durable.get(ids('c', 'a:b'))).toBe('FIRST')
    expect(await durable.get(ids('b:c', 'a'))).toBe('SECOND')
  })

  test('two instances over one storage, writing at the same time, keep the cap and leave no stray entry', async () => {
    const storage = createFakeStorage()
    let clock = 1
    const options = { maxEntries: 5, now: () => clock++ }
    const first = createDurableSkillOutputs(storage, options)
    const second = createDurableSkillOutputs(storage, options)

    for (let round = 0; round < 12; round++) {
      await Promise.all([
        first.put(ids(`a${round}`), `OUT-a${round}`),
        second.put(ids(`b${round}`), `OUT-b${round}`),
      ])
      // Two writers can each miss the other's newest entry for one round.
      expect(storage.data.size).toBeLessThanOrEqual(5 + 1)
    }
    // The next write from either instance settles it.
    await first.put(ids('last'), 'OUT-last')

    expect(storage.data.size).toBe(5)
    for (const [key, value] of storage.data) {
      expect(key.startsWith(KEY_PREFIX)).toBe(true)
      expect(value).toMatchObject({ v: 2, sessionID: 's' })
    }
    expect(await second.get(ids('last'))).toBe('OUT-last')
  })

  test('a removal that two instances both try is harmless', async () => {
    const storage = createFakeStorage()
    seed(storage, 'old', 1)
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 1,
      now: () => 100,
    })
    const realRemove = storage.remove
    // Another instance removes the entry first, between the listing and the removal.
    storage.remove = async (key) => {
      storage.data.delete(key)
      await realRemove(key)
    }

    await durable.put(ids('new'), 'OUT-new')

    expect(storedCalls(storage)).toEqual([`${KEY_PREFIX}s:message-1:new`])
  })
})

describe('durable skill output: expiry', () => {
  test('a write removes entries older than the age limit even when the cap is not reached', async () => {
    const storage = createFakeStorage()
    const now = 100 * DAY_MS
    seed(storage, 'stale', now - 7 * DAY_MS - 1)
    seed(storage, 'edge', now - 7 * DAY_MS)
    seed(storage, 'fresh', now - 1 * DAY_MS)
    const durable = createDurableSkillOutputs(storage, { now: () => now })

    await durable.put(ids('new'), 'OUT-new')

    expect(storedCalls(storage)).toEqual([
      `${KEY_PREFIX}s:message-1:edge`,
      `${KEY_PREFIX}s:message-1:fresh`,
      `${KEY_PREFIX}s:message-1:new`,
    ])
  })

  test('a record with no usable time is removed by the next write', async () => {
    const storage = createFakeStorage()
    storage.data.set(`${KEY_PREFIX}s:message-1:odd`, { v: 2, sessionID: 's' })
    storage.data.set(`${KEY_PREFIX}s:message-1:text`, 'not a record')
    const durable = createDurableSkillOutputs(storage, {
      now: () => 5 * DAY_MS,
    })

    await durable.put(ids('new'), 'OUT-new')

    expect(storedCalls(storage)).toEqual([`${KEY_PREFIX}s:message-1:new`])
  })

  test('a read treats a record older than the age limit as a miss and a record at the limit as a hit', async () => {
    const storage = createFakeStorage()
    const now = 100 * DAY_MS
    seed(storage, 'edge', now - 7 * DAY_MS)
    seed(storage, 'stale', now - 7 * DAY_MS - 1)
    const durable = createDurableSkillOutputs(storage, { now: () => now })

    expect(await durable.get(ids('edge'))).toBe('OUT-edge')
    expect(await durable.get(ids('stale'))).toBeUndefined()
  })

  test('a read does not trust a record whose time is missing', async () => {
    const storage = createFakeStorage()
    storage.data.set(`${KEY_PREFIX}s:message-1:c1`, {
      v: 2,
      sessionID: 's',
      messageID: OWNER,
      callID: 'c1',
      output: 'NO-TIME',
    })
    const durable = createDurableSkillOutputs(storage, { now: () => 1000 })

    expect(await durable.get(ids('c1'))).toBeUndefined()
  })
})

describe('durable skill output: remembered misses', () => {
  test('a key found missing is not read again', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)

    expect(await durable.get(ids('c1'))).toBeUndefined()
    expect(await durable.get(ids('c1'))).toBeUndefined()
    expect(await durable.get(ids('c1'))).toBeUndefined()

    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(1)
  })

  test('an expired record and an invalid one are remembered too', async () => {
    const storage = createFakeStorage()
    const now = 100 * DAY_MS
    seed(storage, 'stale', 1)
    storage.data.set(`${KEY_PREFIX}s:message-1:wrong-call`, {
      ...record('other', now),
    })
    const durable = createDurableSkillOutputs(storage, { now: () => now })

    for (let read = 0; read < 2; read++) {
      expect(await durable.get(ids('stale'))).toBeUndefined()
      expect(await durable.get(ids('wrong-call'))).toBeUndefined()
    }

    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(2)
  })

  test('a write for the key clears the remembered miss', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)
    expect(await durable.get(ids('c1'))).toBeUndefined()

    await durable.put(ids('c1'), 'NOW-HERE')

    expect(await durable.get(ids('c1'))).toBe('NOW-HERE')
  })

  test('a failed write does not clear it', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { report: () => {} })
    expect(await durable.get(ids('c1'))).toBeUndefined()
    storage.fail.set = new Error('disk full')
    await durable.put(ids('c1'), 'LOST')
    storage.fail.set = undefined
    storage.data.set(`${KEY_PREFIX}s:message-1:c1`, record('c1', Date.now()))
    storage.calls.length = 0

    expect(await durable.get(ids('c1'))).toBeUndefined()
    expect(storage.calls).toEqual([])
  })

  test('a read that fails or times out is not remembered', async () => {
    const storage = createFakeStorage()
    seed(storage, 'c1', Date.now())
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 20,
      report: () => {},
    })
    storage.fail.get = new Error('database locked')
    expect(await durable.get(ids('c1'))).toBeUndefined()
    storage.fail.get = undefined
    storage.hang.get = true
    expect(await durable.get(ids('c1'))).toBeUndefined()
    storage.hang.get = false

    expect(await durable.get(ids('c1'))).toBe('OUT-c1')
  })

  test('only the newest misses are kept', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { maxMisses: 2 })
    for (const id of ['a', 'b', 'c']) await durable.get(ids(id))
    storage.calls.length = 0

    await durable.get(ids('b'))
    await durable.get(ids('c'))
    expect(storage.calls).toHaveLength(0)
    await durable.get(ids('a'))

    expect(storage.calls).toHaveLength(1)
  })
})

describe('durable skill output: failures leave what is stored intact and never block', () => {
  test('a write that fails at the cap leaves every older entry in place', async () => {
    const storage = createFakeStorage()
    for (const id of ['c1', 'c2', 'c3']) seed(storage, id, 1000)
    const before = storedCalls(storage)
    storage.fail.set = new Error('disk full')
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 3,
      now: () => 2000,
      report: (message) => reports.push(message),
    })

    await durable.put(ids('c4'), 'OUT-c4')

    expect(storedCalls(storage)).toEqual(before)
    expect(storage.calls.map((call) => call.op)).toEqual(['set'])
    expect(reports).toEqual([
      'skill output could not be kept across a restart: disk full',
    ])
  })

  test('a listing or a removal that fails keeps the new entry, stops further writes, and says so once', async () => {
    for (const op of ['scan', 'remove'] as const) {
      const storage = createFakeStorage()
      seed(storage, 'old', 1)
      storage.fail[op] = new Error('locked')
      const reports: string[] = []
      const durable = createDurableSkillOutputs(storage, {
        maxEntries: 1,
        now: () => 100,
        report: (message) => reports.push(message),
      })

      await durable.put(ids('a'), 'OUT-a')
      await durable.put(ids('b'), 'OUT-b')
      await durable.put(ids('c'), 'OUT-c')

      expect(storage.data.has(`${KEY_PREFIX}s:message-1:a`), op).toBe(true)
      expect(storage.data.has(`${KEY_PREFIX}s:message-1:b`), op).toBe(false)
      expect(storage.data.has(`${KEY_PREFIX}s:message-1:c`), op).toBe(false)
      expect(reports, op).toEqual([
        'old skill outputs could not be removed, so no more skill output is kept across a restart: locked',
      ])
      // Reads still work for what was kept.
      expect(await durable.get(ids('a')), op).toBe('OUT-a')
    }
  })

  test('a write that never answers resolves at the deadline, reports once, and stops further writes', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 30,
      report: (message) => reports.push(message),
    })
    storage.hang.set = true

    const started = Date.now()
    await durable.put(ids('c1'), 'ONE')
    const waited = Date.now() - started
    storage.hang.set = false
    await durable.put(ids('c2'), 'TWO')

    expect(waited).toBeGreaterThanOrEqual(25)
    expect(waited).toBeLessThan(1000)
    expect(storage.calls.filter((call) => call.op === 'set')).toHaveLength(1)
    expect(await durable.get(ids('c2'))).toBeUndefined()
    expect(reports).toEqual([
      'skill output write did not finish in time, so no more skill output is kept across a restart: storage did not answer within 30 ms',
    ])
  })

  test('a listing that never answers still resolves at the deadline with the entry written', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 30,
      report: (message) => reports.push(message),
    })
    storage.hang.scan = true

    await durable.put(ids('c1'), 'ONE')

    expect(storage.data.has(`${KEY_PREFIX}s:message-1:c1`)).toBe(true)
    expect(reports).toEqual([
      'old skill outputs could not be removed, so no more skill output is kept across a restart: storage did not answer within 30 ms',
    ])
  })

  test('calls that each answer in time but together run past the deadline still end the write at the deadline', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 100,
      report: (message) => reports.push(message),
    })
    storage.slow.ms = 70

    const started = Date.now()
    await durable.put(ids('c1'), 'ONE')

    expect(Date.now() - started).toBeLessThan(150)
    expect(reports).toEqual([
      'old skill outputs could not be removed, so no more skill output is kept across a restart: storage did not answer within 100 ms',
    ])
  })

  test('a deadline that is met is cancelled, so no timer is left running', async () => {
    const storage = createFakeStorage()
    seed(storage, 'c1', Date.now())
    const spy = spyOn(globalThis, 'clearTimeout')
    try {
      await createDurableSkillOutputs(storage).get(ids('c1'))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('a read that never answers resolves at the deadline as a miss', async () => {
    const storage = createFakeStorage()
    seed(storage, 'c1', Date.now())
    storage.hang.get = true
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 30,
      report: () => {},
    })

    const started = Date.now()
    const found = await durable.get(ids('c1'))

    expect(found).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('durable skill output: restore on a store miss', () => {
  test('a new process with the same storage restores a cut skill in full, as the same kind', async () => {
    const storage = createFakeStorage()
    const before = await setup(undefined, { storage })
    const loaded = await (await registeredTool(before)).execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ sessionID: 's-restart', id: 'call-restart' }),
    )

    // A restart: a new installer, so an empty in-memory store, the same storage.
    const after = await setup(undefined, { storage })
    const event = cutRequest('s-restart', 'call-restart')
    const returned = contextHook(after)(event)

    expect(returned).toBeInstanceOf(Promise)
    await returned
    expect(resultOf(event)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: loaded.content }],
    })
    expect(errorMessages()).toEqual([])
  })

  test('a small skill the host cut at a lowered output limit is restored after a restart', async () => {
    const storage = createFakeStorage()
    const before = await setup(undefined, { storage })
    const loaded = await (await registeredTool(before)).execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's-low', id: 'call-low' }),
    )
    expect(Buffer.byteLength(loaded.content ?? '')).toBeLessThan(51_200)

    // A restart; the host's configured limit cut this small output to preview plus marker.
    const after = await setup(undefined, { storage })
    const event = cutRequest('s-low', 'call-low')
    await contextHook(after)(event)

    expect(resultOf(event)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: loaded.content }],
    })
  })

  test('a cut result with no stored entry is read once, not on every request', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const hook = contextHook(host)

    for (let request = 0; request < 4; request++) {
      const event = cutRequest('s', 'never-stored')
      await hook(event)
      expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
    }

    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(1)
  })

  test('reads storage once for a call, then serves it from memory on later requests', async () => {
    const storage = createFakeStorage()
    const before = await setup(undefined, { storage })
    const loaded = await (await registeredTool(before)).execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ sessionID: 's-warm', id: 'call-warm' }),
    )
    const after = await setup(undefined, { storage })
    const hook = contextHook(after)
    storage.calls.length = 0

    for (let request = 0; request < 3; request++) {
      const event = cutRequest('s-warm', 'call-warm')
      await hook(event)
      expect(resultOf(event), `request ${request + 1}`).toEqual({
        type: 'content',
        value: [{ type: 'text', text: loaded.content }],
      })
    }

    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(1)
  })

  test('restores each cut skill in a request from its own entry', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)
    await durable.put(ids('c1'), 'FULL-ONE')
    await durable.put(ids('c2'), 'FULL-TWO')
    const host = await setup(undefined, { storage })
    const event = {
      sessionID: 's',
      messages: [
        toolResultMessage('c1', 'systematic_skill', ['CUT', 'marker']),
        toolResultMessage('c2', 'systematic_skill', ['CUT', 'marker']),
      ],
    }

    await contextHook(host)(event)

    const [one, two] = event.messages as ReturnType<typeof toolResultMessage>[]
    expect(one?.content[0]?.result.value).toEqual([
      { type: 'text', text: 'FULL-ONE' },
    ])
    expect(two?.content[0]?.result.value).toEqual([
      { type: 'text', text: 'FULL-TWO' },
    ])
  })

  test('a call under another session or another call id is not restored', async () => {
    const storage = createFakeStorage()
    await createDurableSkillOutputs(storage).put(ids('call-1', 's-a'), 'FULL-A')
    const host = await setup(undefined, { storage })
    const hook = contextHook(host)

    const otherSession = cutRequest('s-b', 'call-1')
    const otherCall = cutRequest('s-a', 'call-2')
    await hook(otherSession)
    await hook(otherCall)

    for (const event of [otherSession, otherCall]) {
      expect(resultOf(event)).toEqual({
        type: 'content',
        value: [
          { type: 'text', text: 'CUT' },
          {
            type: 'text',
            text: '[showing lines 1-5 of 999; full output saved to /tmp/x]',
          },
        ],
      })
    }
  })

  test('a stored record that names other ids, another version or a non-string output is ignored', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const hook = contextHook(host)
    const key = (call: string) => `systematic:skill-output:s:message-1:${call}`
    const base = {
      v: 2,
      sessionID: 's',
      messageID: OWNER,
      output: 'FORGED',
      storedAt: Date.now(),
    }
    storage.data.set(key('wrong-session'), {
      ...base,
      sessionID: 'other',
      callID: 'wrong-session',
    })
    storage.data.set(key('wrong-message'), {
      ...base,
      messageID: 'other',
      callID: 'wrong-message',
    })
    storage.data.set(key('wrong-call'), { ...base, callID: 'other' })
    storage.data.set(key('wrong-version'), {
      ...base,
      v: 1,
      callID: 'wrong-version',
    })
    storage.data.set(key('not-text'), {
      ...base,
      callID: 'not-text',
      output: 5,
    })
    storage.data.set(key('bare-string'), 'FORGED')

    for (const call of [
      'wrong-session',
      'wrong-message',
      'wrong-call',
      'wrong-version',
      'not-text',
      'bare-string',
    ]) {
      const event = cutRequest('s', call)
      await hook(event)
      expect(JSON.stringify(resultOf(event)), call).not.toContain('FORGED')
      expect(JSON.stringify(resultOf(event)), call).toContain('"CUT"')
    }
  })

  test('a storage that cannot be read leaves the part cut, resolves, and says so once', async () => {
    const storage = createFakeStorage()
    storage.fail.get = new Error('database locked')
    const host = await setup(undefined, { storage })
    const hook = contextHook(host)

    for (let request = 0; request < 3; request++) {
      const event = cutRequest('s', 'c1')
      await expect(Promise.resolve(hook(event))).resolves.toBeUndefined()
      expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
    }

    expect(errorMessages()).toEqual([
      'systematic: kept skill output could not be read: database locked',
    ])
  })

  test('a missing entry leaves the part as the host cut it, with no diagnostic', async () => {
    const host = await setup(undefined, { storage: createFakeStorage() })
    const event = cutRequest('s', 'never-stored')

    await contextHook(host)(event)

    expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
    expect(errorMessages()).toEqual([])
  })
})

describe('durable skill output: no work without a cut skill part', () => {
  /** A request with this one result, run through a hook over a spying storage. */
  async function hookOver(message: unknown, store?: Record<string, unknown>) {
    const storage = createFakeStorage()
    for (const [key, value] of Object.entries(store ?? {}))
      storage.data.set(key, value)
    const host = await setup(undefined, { storage })
    const returned = contextHook(host)({
      sessionID: 's',
      messages: [message],
    })
    return { returned, storage }
  }

  const ENTRY = {
    'systematic:skill-output:s:message-1:c1': {
      v: 2,
      sessionID: 's',
      messageID: OWNER,
      callID: 'c1',
      output: 'FULL',
    },
  }

  test('returns nothing, not a promise, and never touches storage', async () => {
    const cases: [string, unknown][] = [
      ['a user message', { role: 'user', content: [{ type: 'text' }] }],
      [
        'a whole skill as text',
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'c1',
              name: 'systematic_skill',
              result: { type: 'text', value: 'FULL' },
            },
          ],
        },
      ],
      [
        'a whole skill as one content part',
        toolResultMessage('c1', 'systematic_skill', ['FULL']),
      ],
      [
        'a cut result of another tool',
        toolResultMessage('c1', 'skill', ['CUT', 'marker']),
      ],
      [
        'a skill error',
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'c1',
              name: 'systematic_skill',
              result: { type: 'error', value: { error: 'boom', content: [] } },
            },
          ],
        },
      ],
      ['a malformed message', { role: 'tool', content: 5 }],
    ]

    for (const [label, message] of cases) {
      const { returned, storage } = await hookOver(message, ENTRY)
      expect(returned, label).toBeUndefined()
      expect(storage.calls, label).toEqual([])
    }
  })

  test('a cut skill the memory store holds is restored at once, with no read', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)
    const loaded = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's-hit', id: 'call-hit' }),
    )
    const event = cutRequest('s-hit', 'call-hit')
    storage.calls.length = 0

    const returned = contextHook(host)(event)

    expect(returned).toBeUndefined()
    expect(resultOf(event)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: loaded.content }],
    })
    expect(storage.calls).toEqual([])
  })

  test('without storage a cut skill the store lacks stays cut and returns nothing', async () => {
    const host = await setup()
    const event = cutRequest('s', 'c1')

    expect(contextHook(host)(event)).toBeUndefined()
    expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
  })

  test('restoreSkillResults without a durable store reads nothing and returns nothing', () => {
    const store = createSkillOutputStore()
    const event = cutRequest('s', 'c1')

    expect(restoreSkillResults(store, owned(event))).toBeUndefined()
    expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
  })
})

// --- Reused call ids, ranking, stopped writes, deadlines, misses, keys ---------

/** The assistant message the host builds for a turn: it holds the calls, and its id is the calling message. */
function assistantMessage(messageID: string | undefined, callIDs: string[]) {
  return {
    role: 'assistant',
    ...(messageID === undefined ? {} : { id: messageID }),
    content: callIDs.map((id) => ({
      type: 'tool-call',
      id,
      name: 'systematic_skill',
      input: {},
    })),
  }
}

function rawContextHook(host: Awaited<ReturnType<typeof setup>>) {
  const hook = host.hooks.find((candidate) => candidate.name === 'context')
  if (hook === undefined) throw new Error('the context hook is not registered')
  return hook.callback
}

function textOf(message: unknown): unknown {
  return (message as ReturnType<typeof toolResultMessage>).content[0]?.result
    .value
}

describe('durable skill output: a call id reused across turns', () => {
  /** Two turns of one session that both got the provider call id `call-1`, each cut by the host. */
  function reusedCallRequest() {
    return {
      sessionID: 's-reuse',
      messages: [
        assistantMessage('msg-1', ['call-1']),
        toolResultMessage('call-1', 'systematic_skill', ['CUT-1', 'marker']),
        assistantMessage('msg-2', ['call-1']),
        toolResultMessage('call-1', 'systematic_skill', ['CUT-2', 'marker']),
      ],
    }
  }

  async function loadTwo(storage: ReturnType<typeof createFakeStorage>) {
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)
    const first = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's-reuse', messageID: 'msg-1', id: 'call-1' }),
    )
    const second = await tool.execute(
      { name: 'git-commit' },
      toolContext({ sessionID: 's-reuse', messageID: 'msg-2', id: 'call-1' }),
    )
    expect(first.content).not.toBe(second.content)
    return { host, first: first.content, second: second.content }
  }

  test('each result gets its own output in one process, from memory', async () => {
    const { host, first, second } = await loadTwo(createFakeStorage())
    const event = reusedCallRequest()

    await rawContextHook(host)(event)

    expect(textOf(event.messages[1])).toEqual([{ type: 'text', text: first }])
    expect(textOf(event.messages[3])).toEqual([{ type: 'text', text: second }])
  })

  test('each result gets its own output after a restart, from storage', async () => {
    const storage = createFakeStorage()
    const { first, second } = await loadTwo(storage)
    const restarted = await setup(undefined, { storage })
    const event = reusedCallRequest()

    await rawContextHook(restarted)(event)

    expect(textOf(event.messages[1])).toEqual([{ type: 'text', text: first }])
    expect(textOf(event.messages[3])).toEqual([{ type: 'text', text: second }])
    expect(storage.data.size).toBe(2)
  })

  test('a result whose calling message is missing, unnamed, ambiguous or another tool is left as the host cut it', async () => {
    const storage = createFakeStorage()
    const { host } = await loadTwo(storage)
    const restarted = await setup(undefined, { storage })
    const cut = () =>
      toolResultMessage('call-1', 'systematic_skill', ['CUT', 'm'])
    const cases: [string, unknown[]][] = [
      ['no assistant message', [cut()]],
      [
        'an assistant message with no id',
        [assistantMessage(undefined, ['call-1']), cut()],
      ],
      [
        'the call id twice in one message',
        [assistantMessage('msg-1', ['call-1', 'call-1']), cut()],
      ],
      [
        'a message id nothing was stored under',
        [assistantMessage('msg-9', ['call-1']), cut()],
      ],
      [
        'the latest call under the id is unnamed',
        [
          assistantMessage('msg-1', ['call-1']),
          assistantMessage(undefined, ['call-1']),
          cut(),
        ],
      ],
      [
        'a call of another tool under the id',
        [
          {
            role: 'assistant',
            id: 'msg-1',
            content: [
              { type: 'tool-call', id: 'call-1', name: 'skill', input: {} },
            ],
          },
          cut(),
        ],
      ],
    ]

    for (const [label, messages] of cases) {
      for (const target of [host, restarted]) {
        const event = { sessionID: 's-reuse', messages }
        const message = messages.at(-1)
        const returned = rawContextHook(target)(event)
        await returned
        expect(textOf(message), label).toEqual([
          { type: 'text', text: 'CUT' },
          { type: 'text', text: 'm' },
        ])
      }
    }
  })

  test('a record stored under one message is not read for another message with the same call id', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)
    await durable.put(ids('call-1', 's', 'msg-1'), 'ONE')

    expect(await durable.get(ids('call-1', 's', 'msg-1'))).toBe('ONE')
    expect(await durable.get(ids('call-1', 's', 'msg-2'))).toBeUndefined()
  })
})

describe('durable skill output: one ranking for every writer', () => {
  test('two cleanups over one snapshot of 33 records leave exactly the 32 newest', async () => {
    const storage = createFakeStorage()
    for (let index = 1; index <= 31; index++)
      seed(storage, `seed${String(index).padStart(2, '0')}`, 10 * index)
    // Both writers list only after both have written, so they trim the same 33 records.
    const realScan = storage.scan.bind(storage)
    const arrivals: {
      options: Parameters<typeof realScan>[0]
      done: (value: Awaited<ReturnType<typeof realScan>>) => void
    }[] = []
    storage.scan = (options) =>
      new Promise((done) => {
        arrivals.push({ options, done })
        if (arrivals.length < 2) return
        for (const arrival of arrivals)
          void realScan(arrival.options).then(arrival.done)
      })
    const oldest = createDurableSkillOutputs(storage, { now: () => 5 })
    const newest = createDurableSkillOutputs(storage, { now: () => 1000 })

    await Promise.all([
      oldest.put(ids('oldest'), 'OUT-oldest'),
      newest.put(ids('newest'), 'OUT-newest'),
    ])

    const kept = storedCalls(storage)
    expect(kept).toHaveLength(32)
    expect(kept).not.toContain(`${KEY_PREFIX}s:message-1:oldest`)
    expect(kept).toContain(`${KEY_PREFIX}s:message-1:newest`)
    expect(kept.filter((key) => key.includes(':seed'))).toHaveLength(31)
  })

  test('equal times rank by key, so every writer keeps the same records', async () => {
    const storage = createFakeStorage()
    for (const id of ['d', 'a', 'c', 'b']) seed(storage, id, 50)
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 2,
      now: () => 50,
    })

    await durable.put(ids('e'), 'OUT-e')

    expect(storedCalls(storage)).toEqual([
      `${KEY_PREFIX}s:message-1:a`,
      `${KEY_PREFIX}s:message-1:b`,
    ])
  })
})

describe('durable skill output: unhealthy cleanup stops durable writes', () => {
  test('sustained listing failure keeps the stored count bounded while every tool call still succeeds', async () => {
    const storage = createFakeStorage()
    storage.fail.scan = new Error('locked')
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    for (let call = 0; call < 20; call++) {
      const loaded = await tool.execute(
        { name: UNDER_LIMIT_SKILL },
        toolContext({ sessionID: 's-grow', id: `call-${call}` }),
      )
      expect(loaded.content).toContain('<skill_content')
    }

    expect(storage.data.size).toBe(1)
    expect(storage.calls.filter((call) => call.op === 'set')).toHaveLength(1)
    expect(errorMessages()).toHaveLength(1)
  })

  test('sustained removal failure at the cap adds one record and then none', async () => {
    const storage = createFakeStorage()
    for (let index = 0; index < 32; index++)
      seed(storage, `c${index}`, 1000 + index)
    storage.fail.remove = new Error('locked')
    const durable = createDurableSkillOutputs(storage, {
      now: () => 5000,
      report: () => {},
    })

    for (let call = 0; call < 10; call++)
      await durable.put(ids(`new${call}`), `OUT-${call}`)

    expect(storage.data.size).toBe(33)
  })

  test('after the stop, reads still work and the in-memory store still restores a live result', async () => {
    const storage = createFakeStorage()
    seed(storage, 'kept', Date.now())
    storage.fail.scan = new Error('locked')
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)
    const live = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's', id: 'call-live' }),
    )
    storage.fail.scan = undefined

    const liveEvent = cutRequest('s', 'call-live')
    await contextHook(host)(liveEvent)
    const keptEvent = cutRequest('s', 'kept')
    await contextHook(host)(keptEvent)

    expect(resultOf(liveEvent)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: live.content }],
    })
    expect(resultOf(keptEvent)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'OUT-kept' }],
    })
  })

  test('a failed write alone does not stop later writes', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { report: () => {} })
    storage.fail.set = new Error('disk full')
    await durable.put(ids('a'), 'OUT-a')
    storage.fail.set = undefined

    await durable.put(ids('b'), 'OUT-b')

    expect(await durable.get(ids('b'))).toBe('OUT-b')
  })
})

describe('durable skill output: one deadline across the write and the cleanup', () => {
  test("the listing pages draw on the write's own budget, so a long listing ends at the deadline", async () => {
    const storage = createFakeStorage()
    for (let index = 0; index < 250; index++)
      seed(storage, `c${String(index).padStart(3, '0')}`, 1000 + index)
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 200,
      maxEntries: 5,
      now: () => 5000,
      report: () => {},
    })
    storage.slow.ms = 60

    await durable.put(ids('new'), 'OUT-new')
    const callsAtReturn = storage.calls.length
    await Bun.sleep(300)

    // Ten pages are listed when each call has the whole deadline; here at most three fit.
    const ops = storage.calls.map((call) => call.op)
    expect(ops.filter((op) => op === 'scan').length).toBeLessThanOrEqual(4)
    expect(ops).not.toContain('remove')
    expect(storage.calls).toHaveLength(callsAtReturn)
  })

  test('a deadline that is already spent starts no storage call', async () => {
    const storage = createFakeStorage()
    seed(storage, 'c1', Date.now())
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 0,
      report: (message) => reports.push(message),
    })

    await durable.put(ids('new'), 'OUT-new')
    expect(await durable.get(ids('c1'))).toBeUndefined()

    expect(storage.calls).toEqual([])
    expect(reports).toEqual([
      'skill output could not be kept across a restart: storage did not answer within 0 ms',
      'kept skill output could not be read: storage did not answer within 0 ms',
    ])
  })

  test('a write whose budget is spent by a slow set reports once and starts no cleanup', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 30,
      report: (message) => reports.push(message),
    })
    storage.slow.ms = 80

    await durable.put(ids('a'), 'OUT-a')
    await Bun.sleep(150)

    expect(storage.calls.map((call) => call.op)).toEqual(['set'])
    expect(reports).toEqual([
      'skill output write did not finish in time, so no more skill output is kept across a restart: storage did not answer within 30 ms',
    ])
  })
})

describe('durable skill output: a remembered miss expires', () => {
  test('a key is read again once the miss is older than its time to live', async () => {
    const storage = createFakeStorage()
    let clock = 1_000_000
    const durable = createDurableSkillOutputs(storage, { now: () => clock })
    expect(await durable.get(ids('c1'))).toBeUndefined()
    // Another instance writes the record afterwards.
    storage.data.set(`${KEY_PREFIX}s:message-1:c1`, record('c1', clock))

    clock += DURABLE_MISS_TTL_MS - 1
    expect(await durable.get(ids('c1'))).toBeUndefined()
    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(1)

    clock += 1
    expect(await durable.get(ids('c1'))).toBe('OUT-c1')
    expect(storage.calls.filter((call) => call.op === 'get')).toHaveLength(2)
  })

  test('the time to live is 60 seconds', () => {
    expect(DURABLE_MISS_TTL_MS).toBe(60_000)
  })
})

describe('durable skill output: an id that cannot be a key', () => {
  const LONE = 'a\ud800b'

  test('put and get resolve without throwing and touch no storage, for each id', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      report: (message) => reports.push(message),
    })

    for (const bad of [ids('c', LONE), ids(LONE), ids('c', 's', LONE)]) {
      await expect(durable.put(bad, 'OUT')).resolves.toBeUndefined()
      await expect(durable.get(bad)).resolves.toBeUndefined()
    }

    expect(storage.calls).toEqual([])
    expect(reports).toEqual([
      'skill output has an id that cannot be stored and is not kept across a restart',
    ])
  })

  test('a skill load under such a call id still succeeds and is restored from memory', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const loaded = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext({ sessionID: 's', id: LONE }),
    )
    const event = cutRequest('s', LONE)
    await contextHook(host)(event)

    expect(loaded.content).toContain('<skill_content')
    expect(resultOf(event)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: loaded.content }],
    })
    expect(storage.calls).toEqual([])
  })

  test('a cut result under such an id after a restart stays cut without a throw', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const event = cutRequest('s', LONE)

    await expect(
      Promise.resolve(contextHook(host)(event)),
    ).resolves.toBeUndefined()

    expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
    expect(storage.calls).toEqual([])
    expect(errorMessages()).toEqual([])
  })
})

describe('durable skill output: one write in flight, and a timed-out write stops writes', () => {
  test('several writes that each commit after their deadline leave the stored count within the cap plus one', async () => {
    const storage = createFakeStorage()
    for (const id of ['c1', 'c2', 'c3']) seed(storage, id, 1000)
    const durable = createDurableSkillOutputs(storage, {
      deadlineMs: 30,
      maxEntries: 3,
      now: () => 2000,
      report: () => {},
    })
    storage.slow.ms = 80

    for (let call = 0; call < 6; call++)
      await durable.put(ids(`late${call}`), `OUT-${call}`)
    // Let every set that outlived its deadline commit.
    await Bun.sleep(300)

    expect(storage.data.size).toBeLessThanOrEqual(3 + 1)
    expect(storage.calls.filter((call) => call.op === 'set')).toHaveLength(1)
  })

  test('a burst of overlapping puts at the cap with the cleanup blocked stays within the cap plus one', async () => {
    for (const block of ['hang', 'fail'] as const) {
      const storage = createFakeStorage()
      for (const id of ['c1', 'c2', 'c3']) seed(storage, id, 1000)
      if (block === 'hang') storage.hang.scan = true
      else storage.fail.scan = new Error('locked')
      const durable = createDurableSkillOutputs(storage, {
        deadlineMs: 30,
        maxEntries: 3,
        now: () => 2000,
        report: () => {},
      })

      await Promise.all(
        Array.from({ length: 10 }, (_, call) =>
          durable.put(ids(`burst${call}`), `OUT-${call}`),
        ),
      )
      await Bun.sleep(100)

      expect(storage.data.size, block).toBeLessThanOrEqual(3 + 1)
      expect(
        storage.calls.filter((call) => call.op === 'set'),
        block,
      ).toHaveLength(1)
    }
  })

  test('a put that arrives while another write is in flight is skipped, and the next one after it settles is written', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)
    storage.slow.ms = 40

    const first = durable.put(ids('a'), 'OUT-a')
    const overlapping = durable.put(ids('b'), 'OUT-b')
    await Promise.all([first, overlapping])
    await durable.put(ids('c'), 'OUT-c')

    expect(storedCalls(storage)).toEqual([
      `${KEY_PREFIX}s:message-1:a`,
      `${KEY_PREFIX}s:message-1:c`,
    ])
  })

  test('a put that arrives during the cleanup of another write is skipped too', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)
    storage.slow.ms = 40

    const first = durable.put(ids('a'), 'OUT-a')
    // The set takes 40 ms and the listing the next 40: this lands in the cleanup.
    await Bun.sleep(60)
    await durable.put(ids('b'), 'OUT-b')
    await first

    expect(storedCalls(storage)).toEqual([`${KEY_PREFIX}s:message-1:a`])
  })

  test('a skipped write still restores the live result from memory', async () => {
    const storage = createFakeStorage()
    storage.slow.ms = 60
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const [first, second] = await Promise.all([
      tool.execute(
        { name: UNDER_LIMIT_SKILL },
        toolContext({ sessionID: 's-skip', id: 'call-a' }),
      ),
      tool.execute(
        { name: 'git-commit' },
        toolContext({ sessionID: 's-skip', id: 'call-b' }),
      ),
    ])
    storage.slow.ms = 0
    const event = {
      sessionID: 's-skip',
      messages: [
        toolResultMessage('call-a', 'systematic_skill', ['CUT', 'marker']),
        toolResultMessage('call-b', 'systematic_skill', ['CUT', 'marker']),
      ],
    }
    storage.calls.length = 0
    await contextHook(host)(event)

    // One of the two was kept in storage and both come back from memory, with no read.
    expect(storedCalls(storage)).toHaveLength(1)
    const [a, b] = event.messages
    expect(textOf(a)).toEqual([{ type: 'text', text: first.content }])
    expect(textOf(b)).toEqual([{ type: 'text', text: second.content }])
    expect(storage.calls.filter((call) => call.op === 'get')).toEqual([])
  })

  test('a write that fails outright, rather than timing out, does not stop later writes', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { report: () => {} })
    storage.fail.set = new Error('disk full')
    await durable.put(ids('a'), 'OUT-a')
    storage.fail.set = undefined

    await durable.put(ids('b'), 'OUT-b')

    expect(await durable.get(ids('b'))).toBe('OUT-b')
  })
})
