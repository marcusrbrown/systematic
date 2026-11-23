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
  DURABLE_MAX_ENTRIES,
  DURABLE_MAX_ENTRY_BYTES,
  exceedsHostOutputLimit,
  restoreSkillResults,
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

  test('leaves a text result unchanged when it already holds the full text', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        textToolResultMessage('c1', 'systematic_skill', 'FULL-OUTPUT'),
      ],
    }

    restoreSkillResults(store, event)

    expect((event.messages[0] as ToolResultMessage).content[0]?.result).toEqual(
      { type: 'text', value: 'FULL-OUTPUT' },
    )
  })

  test('leaves a content result unchanged when its only text part is the full text', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [toolResultMessage('c1', 'systematic_skill', ['FULL-OUTPUT'])],
    }

    restoreSkillResults(store, event)

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
    store.put('s', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [textToolResultMessage('c1', 'systematic_skill', 'CUT')],
    }

    restoreSkillResults(store, event)

    expect((event.messages[0] as ToolResultMessage).content[0]?.result).toEqual(
      { type: 'text', value: 'FULL-OUTPUT' },
    )
  })

  test('restores a truncated content result as content and drops the host marker', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'FULL-OUTPUT')
    const event = {
      sessionID: 's',
      messages: [
        toolResultMessage('c1', 'systematic_skill', ['CUT', '[showing 1-5]']),
      ],
    }

    restoreSkillResults(store, event)

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

    restoreSkillResults(store, event)

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
    store.put('s', 'c1', 'FULL-OUTPUT')
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

    restoreSkillResults(store, { sessionID: 's', messages: [failed] })

    expect(failed.content[0]?.result).toEqual({
      type: 'error',
      value: { error: 'boom', content: [] },
    })
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

      await hook.callback(event)

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

// --- Durable restore ---------------------------------------------------------

/**
 * The host's plugin storage as a map. Every call is recorded, and a test can
 * make any operation fail. Values are cloned through JSON, as the host's
 * database does, so a test cannot lean on object identity.
 */
function createFakeStorage(): V2Storage & {
  data: Map<string, unknown>
  calls: { op: string; key: string }[]
  fail: {
    get?: Error
    set?: Error
    remove?: Error
    /** Fails a `set` for the keys this accepts. */
    setWhere?: (key: string) => boolean
  }
} {
  const data = new Map<string, unknown>()
  const calls: { op: string; key: string }[] = []
  const fail: {
    get?: Error
    set?: Error
    remove?: Error
    setWhere?: (key: string) => boolean
  } = {}
  return {
    data,
    calls,
    fail,
    async get(key) {
      calls.push({ op: 'get', key })
      if (fail.get !== undefined) throw fail.get
      return data.has(key) ? structuredClone(data.get(key)) : undefined
    },
    async set(key, value) {
      calls.push({ op: 'set', key })
      if (fail.set !== undefined) throw fail.set
      if (fail.setWhere?.(key) === true) throw new Error('set refused')
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    async remove(key) {
      calls.push({ op: 'remove', key })
      if (fail.remove !== undefined) throw fail.remove
      data.delete(key)
    },
  }
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
  return hook.callback
}

function resultOf(event: ReturnType<typeof cutRequest>): unknown {
  return (event.messages[0] as ReturnType<typeof toolResultMessage>).content[0]
    ?.result
}

describe('exceedsHostOutputLimit', () => {
  test('is over at 51201 bytes and not at 51200, counted in bytes', () => {
    expect(exceedsHostOutputLimit('a'.repeat(51_200))).toBe(false)
    expect(exceedsHostOutputLimit('a'.repeat(51_201))).toBe(true)
    // 3 bytes each: 17067 characters is 51201 bytes.
    expect(exceedsHostOutputLimit('€'.repeat(17_066))).toBe(false)
    expect(exceedsHostOutputLimit('€'.repeat(17_067))).toBe(true)
  })

  test('is over at 2001 lines and not at 2000, not counting a final line break', () => {
    expect(exceedsHostOutputLimit('\n'.repeat(1999))).toBe(false)
    expect(exceedsHostOutputLimit(`${'x\n'.repeat(2000)}`)).toBe(false)
    expect(exceedsHostOutputLimit(`${'x\n'.repeat(2000)}x`)).toBe(true)
    expect(exceedsHostOutputLimit('')).toBe(false)
  })
})

describe('durable skill output: persist on execute', () => {
  test('writes a skill over the host limit, as the exact rendered output keyed by session and call', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const loaded = await tool.execute(
      { name: OVER_LIMIT_SKILL },
      toolContext({ sessionID: 's-1', id: 'call-1' }),
    )

    expect(Buffer.byteLength(loaded.content ?? '')).toBeGreaterThan(51_200)
    const entries = [...storage.data.entries()].filter(([key]) =>
      key.startsWith('systematic:skill-output:s'),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.[1]).toEqual({
      v: 1,
      sessionID: 's-1',
      callID: 'call-1',
      output: loaded.content,
    })
    expect(errorMessages()).toEqual([])
  })

  test('writes nothing for a skill under the host limit', async () => {
    const storage = createFakeStorage()
    const host = await setup(undefined, { storage })
    const tool = await registeredTool(host)

    const loaded = await tool.execute(
      { name: UNDER_LIMIT_SKILL },
      toolContext(),
    )

    expect(Buffer.byteLength(loaded.content ?? '')).toBeLessThanOrEqual(51_200)
    expect(storage.calls).toEqual([])
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

describe('durable skill output: caps and eviction', () => {
  test('an output over the byte cap is not written, with one diagnostic', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      maxEntryBytes: 10,
      report: (message) => reports.push(message),
    })

    await durable.put('s', 'c1', '1234567890')
    await durable.put('s', 'c2', '12345678901')
    await durable.put('s', 'c3', '€€€€')

    expect(await durable.get('s', 'c1')).toBe('1234567890')
    expect(await durable.get('s', 'c2')).toBeUndefined()
    expect(await durable.get('s', 'c3')).toBeUndefined()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('over 10 bytes')
  })

  test('the defaults are 1 MiB per entry and 32 entries', () => {
    expect(DURABLE_MAX_ENTRY_BYTES).toBe(1024 * 1024)
    expect(DURABLE_MAX_ENTRIES).toBe(32)
  })

  test('keeps the newest entries and removes the oldest from storage', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { maxEntries: 3 })

    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      await durable.put('s', id, `OUT-${id}`)
    }

    expect(await durable.get('s', 'c1')).toBeUndefined()
    expect(await durable.get('s', 'c2')).toBeUndefined()
    expect(await durable.get('s', 'c3')).toBe('OUT-c3')
    expect(await durable.get('s', 'c4')).toBe('OUT-c4')
    expect(await durable.get('s', 'c5')).toBe('OUT-c5')
    // The two evicted records are gone from the database, not only unlisted.
    const records = [...storage.data.keys()].filter(
      (key) => key !== 'systematic:skill-output-index',
    )
    expect(records).toHaveLength(3)
  })

  test('writing an entry again refreshes it, so it is the last to go', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { maxEntries: 2 })

    await durable.put('s', 'c1', 'ONE')
    await durable.put('s', 'c2', 'TWO')
    await durable.put('s', 'c1', 'ONE-AGAIN')
    await durable.put('s', 'c3', 'THREE')

    expect(await durable.get('s', 'c2')).toBeUndefined()
    expect(await durable.get('s', 'c1')).toBe('ONE-AGAIN')
    expect(await durable.get('s', 'c3')).toBe('THREE')
  })

  test('writing an entry again does not list it twice, so it is not evicted early', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { maxEntries: 3 })

    await durable.put('s', 'c1', 'ONE')
    await durable.put('s', 'c2', 'TWO')
    await durable.put('s', 'c1', 'ONE-AGAIN')
    await durable.put('s', 'c3', 'THREE')

    expect(await durable.get('s', 'c1')).toBe('ONE-AGAIN')
    expect(await durable.get('s', 'c2')).toBe('TWO')
    expect(await durable.get('s', 'c3')).toBe('THREE')
  })

  test('concurrent writes all land and the cap holds', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage, { maxEntries: 4 })

    await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
        durable.put('s', id, `OUT-${id}`),
      ),
    )

    const kept = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => durable.get('s', id)),
    )
    expect(kept).toEqual([
      undefined,
      undefined,
      'OUT-c',
      'OUT-d',
      'OUT-e',
      'OUT-f',
    ])
  })

  test('ids with the key separator in them do not share an entry', async () => {
    const storage = createFakeStorage()
    const durable = createDurableSkillOutputs(storage)

    await durable.put('a:b', 'c', 'FIRST')
    await durable.put('a', 'b:c', 'SECOND')

    expect(await durable.get('a:b', 'c')).toBe('FIRST')
    expect(await durable.get('a', 'b:c')).toBe('SECOND')
  })

  test('when the index cannot be written no entry is written either, so none is left unlisted', async () => {
    const storage = createFakeStorage()
    storage.fail.setWhere = (key) => key === 'systematic:skill-output-index'
    const durable = createDurableSkillOutputs(storage, {
      report: () => {},
    })

    await durable.put('s', 'c1', 'ONE')

    expect([...storage.data.keys()]).toEqual([])
  })

  test('a failed removal keeps the new entry out and does not throw', async () => {
    const storage = createFakeStorage()
    const reports: string[] = []
    const durable = createDurableSkillOutputs(storage, {
      maxEntries: 1,
      report: (message) => reports.push(message),
    })
    await durable.put('s', 'c1', 'ONE')
    storage.fail.remove = new Error('locked')

    await expect(durable.put('s', 'c2', 'TWO')).resolves.toBeUndefined()

    expect(await durable.get('s', 'c1')).toBe('ONE')
    expect(await durable.get('s', 'c2')).toBeUndefined()
    expect(reports).toEqual([
      'skill output could not be kept across a restart: locked',
    ])
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
    await durable.put('s', 'c1', 'FULL-ONE')
    await durable.put('s', 'c2', 'FULL-TWO')
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
    await createDurableSkillOutputs(storage).put('s-a', 'call-1', 'FULL-A')
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
    const key = (call: string) => `systematic:skill-output:s:${call}`
    storage.data.set(key('wrong-session'), {
      v: 1,
      sessionID: 'other',
      callID: 'wrong-session',
      output: 'FORGED',
    })
    storage.data.set(key('wrong-call'), {
      v: 1,
      sessionID: 's',
      callID: 'other',
      output: 'FORGED',
    })
    storage.data.set(key('wrong-version'), {
      v: 2,
      sessionID: 's',
      callID: 'wrong-version',
      output: 'FORGED',
    })
    storage.data.set(key('not-text'), {
      v: 1,
      sessionID: 's',
      callID: 'not-text',
      output: 5,
    })
    storage.data.set(key('bare-string'), 'FORGED')

    for (const call of [
      'wrong-session',
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
    'systematic:skill-output:s:c1': {
      v: 1,
      sessionID: 's',
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

    expect(restoreSkillResults(store, event)).toBeUndefined()
    expect((resultOf(event) as { value: unknown[] }).value).toHaveLength(2)
  })
})
