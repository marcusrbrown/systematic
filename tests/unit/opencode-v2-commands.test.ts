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
import { setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import {
  buildCommand,
  createCommandRuntime,
} from '../../src/lib/opencode-v2-commands.js'

const PACKAGE_ROOT = path.resolve(import.meta.dir, '../..')

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

/**
 * A stand-in host with just the members the command installer uses. Every
 * session call is logged, so a test can assert what a command did and did not
 * ask of the session.
 */
function createHost(
  options: {
    native?: string[]
    promptFails?: boolean
    listFails?: boolean
    directory?: string
  } = {},
) {
  const calls: Call[] = []
  const transforms: ((editor: {
    add(c: CommandDefinitionStub): void
  }) => void)[] = []
  const log = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
  }
  const spy = (fn: string) => async (input: Record<string, unknown>) => {
    log(fn, input)
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
    agent: { async transform() {} },
    skill: { async transform() {} },
    tool: { async transform() {} },
    permission: { async assert() {} },
    session: {
      async hook() {},
      async prompt(input: Record<string, unknown>) {
        log('prompt', input)
        if (options.promptFails) throw new Error('prompt exploded')
      },
      // Routing is gone: none of these may be called.
      switchAgent: spy('switchAgent'),
      switchModel: spy('switchModel'),
      create: spy('create'),
      wait: spy('wait'),
      get: spy('get'),
    },
  } as unknown as Plugin.Context
  return { ctx, calls, transforms }
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

function makeRuntime(host: Host) {
  return createCommandRuntime(host.ctx, (message) => {
    console.error(`systematic: ${message}`)
  })
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

describe('a command that declares routing', () => {
  const REFUSAL = (name: string, field: string) =>
    `Systematic command "${name}" declares ${field}, which OpenCode v2 plugin commands cannot route. Define it as an OpenCode command in Markdown or JSON to choose its agent or model.`

  test.each([
    ['agent', { agent: 'plan' }],
    ['model', { model: 'other/special' }],
    ['subtask', { subtask: true }],
  ] as const)(
    '%s is refused with the documented message and nothing is prompted',
    async (field, planned) => {
      const host = createHost()
      const { definition } = command(host, planned)

      await expect(definition.execute(invocation('go'))).rejects.toThrow(
        REFUSAL('systematic:probe', field),
      )

      expect(callsOf(host, 'prompt')).toHaveLength(0)
      expect(callsOf(host, 'switchAgent')).toHaveLength(0)
      expect(callsOf(host, 'switchModel')).toHaveLength(0)
      expect(callsOf(host, 'create')).toHaveLength(0)
    },
  )

  test('subtask false is a declaration too', async () => {
    const host = createHost()
    const { definition } = command(host, { subtask: false })

    await expect(definition.execute(invocation('go'))).rejects.toThrow(
      REFUSAL('systematic:probe', 'subtask'),
    )
    expect(callsOf(host, 'prompt')).toHaveLength(0)
  })

  test('the refusal is logged once per run with the systematic prefix', async () => {
    const host = createHost()
    const { definition } = command(host, { agent: 'plan' })

    await definition.execute(invocation('a')).catch(() => {})
    await definition.execute(invocation('b')).catch(() => {})

    const notes = errorMessages().filter((message) =>
      message.includes('declares agent'),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
  })

  test('the first declared field is named when several are declared', async () => {
    const host = createHost()
    const { definition } = command(host, {
      agent: 'plan',
      model: 'other/special',
    })

    await expect(definition.execute(invocation('go'))).rejects.toThrow(
      REFUSAL('systematic:probe', 'agent'),
    )
  })

  test('a plain command still prompts once on the invoking session', async () => {
    const host = createHost()
    const { definition } = command(host)

    await definition.execute(invocation('go'))

    expect(callsOf(host, 'prompt')).toHaveLength(1)
    expect(errorMessages()).toEqual([])
  })
})

describe('a command that throws', () => {
  test('is reported with the systematic prefix and rethrown for the invoker', async () => {
    const host = createHost({ promptFails: true })
    const { definition } = command(host)

    await expect(definition.execute(invocation('x'))).rejects.toThrow(
      'prompt exploded',
    )

    expect(errorMessages()).toEqual([
      'systematic: command "systematic:probe" failed: prompt exploded',
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
