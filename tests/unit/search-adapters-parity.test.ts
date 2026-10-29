/**
 * Parity across the search tool adapters. Each adapter's real entry runs over
 * one fixture corpus and the rendered text is compared byte for byte (AE5 for
 * v1, v2 and Pi). A shared-core test would not prove this: the adapters pick
 * their own start directory and map their own errors.
 *
 * The corpus is the committed lifecycle fixture plus documents written here at
 * run time, because a file name carrying an ESC byte cannot live in git. Later
 * units add the CLI, the bin and the hybrid cases to this same file.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
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
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Plugin } from '@opencode/plugin'
import type { PluginInput } from '@opencode-ai/plugin'
import { createOpenCodeV1Hooks } from '../../src/lib/opencode-v1.js'
import { setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import { REAL_PI_DELEGATE_SESSION_RUNTIME } from '../../src/lib/pi-delegate-session.js'
import { MAX_LIMIT, SEARCH_ERRORS } from '../../src/lib/search-core.js'
import piExtension from '../../src/pi.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..')
const LIFECYCLE_FIXTURE = path.join(
  PACKAGE_ROOT,
  'tests/fixtures/search-corpus/lifecycle',
)
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const NO_PROJECT_NOTE_PATTERN = /no project directory/i

const temp = createTempDirTracker()

// The adapters read user config at init. Point the home at an empty one so a
// developer's own `search` block cannot change what a test sees.
const isolatedHome = fs.mkdtempSync(
  path.join(os.tmpdir(), 'search-parity-home-'),
)
const realHomedir = os.homedir
const realConfigDir = process.env.OPENCODE_CONFIG_DIR
let errorSpy: Mock<typeof console.error>

beforeAll(() => {
  os.homedir = () => isolatedHome
  delete process.env.OPENCODE_CONFIG_DIR
})

afterAll(() => {
  os.homedir = realHomedir
  if (realConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = realConfigDir
  fs.rmSync(isolatedHome, { recursive: true, force: true })
})

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  temp.cleanup()
  fs.rmSync(path.join(isolatedHome, '.config'), {
    recursive: true,
    force: true,
  })
})

function writeUserConfig(config: unknown): void {
  const dir = path.join(isolatedHome, '.config/opencode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'systematic.json'), JSON.stringify(config))
}

function writeDoc(root: string, name: string, content: string): void {
  const dir = path.join(root, 'docs/solutions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content)
}

/** The lifecycle fixture plus a few ranked docs and the hostile pair, under a `.git` marker. */
function makeProject(): string {
  const root = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-parity-'))),
  )
  fs.mkdirSync(path.join(root, '.git'))
  fs.cpSync(LIFECYCLE_FIXTURE, root, { recursive: true })
  writeDoc(
    root,
    'parity-a.md',
    '---\ntitle: Zebra crossing flake\nsymptoms:\n  - zebra flake on retry\ntags:\n  - zebra\n---\n\nThe zebra flake appears when retries overlap.\n',
  )
  writeDoc(
    root,
    'parity-b.md',
    '---\ntitle: Retry overlap\nmodule: retries\n---\n\nA second note that mentions the zebra once.\n',
  )
  writeDoc(
    root,
    `evil${ESC}[31m-name${ESC}]52;c;QUJD${BEL}.md`,
    `---\ntitle: Evil ${ESC}[1mzebra title\ntags:\n  - "t${ESC}]52;c;WFla${BEL}ag"\n---\n\nzebra line ${ESC}]52;c;SGVsbG8=${BEL} zebra after osc\n`,
  )
  return root
}

const QUERY = 'zebra flake retry'

interface Surface {
  readonly name: string
  search(root: string, args: Record<string, unknown>): Promise<string>
}

function toolContext(root: string) {
  return {
    sessionID: 's',
    messageID: 'm',
    agent: 'a',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    ask: async () => {
      throw new Error('search must not ask for permission')
    },
    metadata: () => {},
  }
}

async function createV1Surface(): Promise<Surface> {
  const initDir = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-v1-init-'))),
  )
  const input = {
    client: { app: { log: async () => {} } },
    directory: initDir,
  } as unknown as PluginInput
  const hooks = await createOpenCodeV1Hooks(input, {
    packageRoot: PACKAGE_ROOT,
  })
  const tool = hooks.tool?.systematic_search
  if (tool === undefined) throw new Error('v1 did not register the tool')
  return {
    name: 'v1',
    async search(root, args) {
      const result = await tool.execute(
        args as never,
        toolContext(root) as never,
      )
      return typeof result === 'string' ? result : result.output
    },
  }
}

interface V2ToolStub {
  name: string
  input: Record<string, unknown>
  options?: { codemode?: boolean }
  execute(
    input: unknown,
    context: Record<string, unknown>,
  ): Promise<{ content: string }>
}

/** Runs the real v2 setup against a fake host and replays its tool transforms. */
async function createV2Host(
  directory: string | undefined,
  homeDir?: string,
): Promise<{
  tool: V2ToolStub | undefined
  added: string[]
  preexisting: (names: string[]) => Promise<string[]>
}> {
  const transforms: ((editor: unknown) => void)[] = []
  const ctx = {
    location: directory === undefined ? {} : { directory },
    session: { async hook() {} },
    agent: { async transform() {} },
    skill: { async transform() {} },
    command: {
      async list() {
        return { data: [] }
      },
      async transform() {},
    },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        transforms.push(callback)
      },
    },
    permission: {
      async assert() {
        throw new Error('search must not assert a permission')
      },
    },
  } as unknown as Plugin.Context
  const home =
    homeDir ??
    temp.track(fs.mkdtempSync(path.join(os.tmpdir(), 'search-v2-home-')))
  await setupOpenCodeV2(ctx, { packageRoot: PACKAGE_ROOT, homeDir: home })
  const replay = (existing: string[]) => {
    const tools = new Map<string, V2ToolStub>()
    for (const name of existing) {
      tools.set(name, {
        name,
        input: {},
        execute: async () => ({ content: '' }),
      })
    }
    const added: string[] = []
    const editor = {
      get: (id: string) => tools.get(id),
      add(tool: V2ToolStub) {
        added.push(tool.name)
        tools.set(tool.name, tool)
      },
    }
    for (const transform of transforms) transform(editor)
    return { tools, added }
  }
  const first = replay([])
  return {
    tool: first.tools.get('systematic_search'),
    added: first.added,
    preexisting: async (names) => replay(names).added,
  }
}

async function createV2Surface(directory: string): Promise<Surface> {
  const host = await createV2Host(directory)
  const tool = host.tool
  if (tool === undefined) throw new Error('v2 did not register the tool')
  return {
    name: 'v2',
    async search(_root, args) {
      const result = await tool.execute(args, {
        sessionID: 's',
        agent: 'a',
        messageID: 'm',
        id: 'c',
        progress: async () => {},
      })
      return result.content
    },
  }
}

interface PiHost {
  tool: ToolDefinition | undefined
  tools: ToolDefinition[]
}

async function initPi(): Promise<PiHost> {
  const tools: ToolDefinition[] = []
  const api = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool)
    },
    on() {},
  } as unknown as ExtensionAPI
  await piExtension(api)
  return { tool: tools.find((t) => t.name === 'systematic_search'), tools }
}

function piCall(tool: ToolDefinition, root: string, args: unknown) {
  return tool.execute('call-1', args as never, undefined, undefined, {
    cwd: root,
  } as never)
}

async function createPiSurface(): Promise<Surface> {
  const host = await initPi()
  const tool = host.tool
  if (tool === undefined) throw new Error('Pi did not register the tool')
  return {
    name: 'pi',
    async search(root, args) {
      const result = await piCall(tool, root, args)
      const first = result.content[0]
      if (first?.type !== 'text') throw new Error('Pi returned no text')
      return first.text
    },
  }
}

async function allSurfaces(root: string): Promise<Surface[]> {
  return [
    await createV1Surface(),
    await createV2Surface(root),
    await createPiSurface(),
  ]
}

describe('search adapters parity (AE5: v1, v2, Pi)', () => {
  test('the same query over one corpus yields byte-identical text on every host', async () => {
    const root = makeProject()
    const surfaces = await allSurfaces(root)
    const texts = await Promise.all(
      surfaces.map((surface) => surface.search(root, { query: QUERY })),
    )

    expect(texts[0]).toContain('docs/solutions/parity-a.md')
    expect(texts[0]).toContain('Zebra crossing flake')
    expect(texts[1]).toBe(texts[0])
    expect(texts[2]).toBe(texts[0])
  })

  test('kind and limit pass through every adapter to the same result', async () => {
    const root = makeProject()
    const surfaces = await allSurfaces(root)
    const texts = await Promise.all(
      surfaces.map((surface) =>
        surface.search(root, { query: QUERY, kind: 'solution', limit: 1 }),
      ),
    )
    expect(texts[1]).toBe(texts[0])
    expect(texts[2]).toBe(texts[0])
    expect(texts[0]).toContain('parity-a.md')
    expect(texts[0]).not.toContain('parity-b.md')
  })

  test('no ESC, BEL or OSC 52 payload reaches any host output', async () => {
    const root = makeProject()
    for (const surface of await allSurfaces(root)) {
      const text = await surface.search(root, {
        query: `zebra evil ${ESC}[31mquery`,
      })
      expect(text).toContain('zebra')
      expect(text).not.toContain(ESC)
      expect(text).not.toContain(BEL)
      expect(text).not.toContain('QUJD')
      expect(text).not.toContain('WFla')
      expect(text).not.toContain('SGVsbG8')
    }
  })

  test('limit 0 and limit 21 get the core fixed error on every adapter', async () => {
    const root = makeProject()
    for (const surface of await allSurfaces(root)) {
      for (const limit of [0, MAX_LIMIT + 1, 2.5, 'x']) {
        const text = await surface.search(root, { query: QUERY, limit })
        expect(text).toBe(SEARCH_ERRORS.limitInvalid)
      }
    }
  })

  test('an empty query and an unknown kind get the core fixed errors', async () => {
    const root = makeProject()
    for (const surface of await allSurfaces(root)) {
      expect(await surface.search(root, { query: '   ' })).toBe(
        SEARCH_ERRORS.queryEmpty,
      )
      expect(await surface.search(root, { query: 'a', kind: 'plan' })).toBe(
        SEARCH_ERRORS.kindUnknown,
      )
    }
  })

  test('a doc written between two calls appears in the second on every host', async () => {
    const root = makeProject()
    const surfaces = await allSurfaces(root)
    for (const surface of surfaces) {
      expect(await surface.search(root, { query: 'quokkaword' })).not.toContain(
        'quokka-note.md',
      )
    }
    writeDoc(root, 'quokka-note.md', '---\ntitle: Quokkaword\n---\n\nbody\n')
    for (const surface of surfaces) {
      expect(await surface.search(root, { query: 'quokkaword' })).toContain(
        'quokka-note.md',
      )
    }
  })

  test('every adapter makes no permission request', async () => {
    // The stub contexts throw from `ask` and `permission.assert`, so a
    // prompt would surface as a failure text instead of results.
    const root = makeProject()
    for (const surface of await allSurfaces(root)) {
      const text = await surface.search(root, { query: QUERY })
      expect(text).toContain('parity-a.md')
    }
  })
})

describe('search adapters: start directory', () => {
  test('v1 searches context.directory, not the init directory', async () => {
    const root = makeProject()
    const v1 = await createV1Surface()
    expect(await v1.search(root, { query: QUERY })).toContain('parity-a.md')
  })

  test('v1 with a context that carries no directory returns the no-project note and does not search the init directory', async () => {
    const initDir = makeProject()
    const hooks = await createOpenCodeV1Hooks(
      {
        client: { app: { log: async () => {} } },
        directory: initDir,
      } as unknown as PluginInput,
      { packageRoot: PACKAGE_ROOT },
    )
    const tool = hooks.tool?.systematic_search
    if (tool === undefined) throw new Error('v1 did not register the tool')
    const { directory: _omitted, ...withoutDirectory } = toolContext(initDir)
    const result = await tool.execute(
      { query: QUERY } as never,
      withoutDirectory as never,
    )
    const text = typeof result === 'string' ? result : result.output
    expect(text).toMatch(NO_PROJECT_NOTE_PATTERN)
    expect(text).not.toContain('parity-a.md')
  })

  test('two Pi calls with different cwd search their own projects', async () => {
    const first = makeProject()
    const second = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-pi-b-'))),
    )
    fs.mkdirSync(path.join(second, '.git'))
    writeDoc(second, 'other.md', '---\ntitle: Quokka only here\n---\n\nbody\n')
    const pi = await createPiSurface()

    expect(await pi.search(first, { query: 'zebra' })).toContain('parity-a.md')
    const secondText = await pi.search(second, { query: 'quokka' })
    expect(secondText).toContain('other.md')
    expect(secondText).not.toContain('parity-a.md')
  })

  test('v2 with no location directory returns a no-project note and does not throw', async () => {
    const host = await createV2Host(undefined)
    const tool = host.tool
    if (tool === undefined) throw new Error('v2 did not register the tool')
    const result = await tool.execute(
      { query: QUERY },
      {
        sessionID: 's',
        agent: 'a',
        messageID: 'm',
        id: 'c',
        progress: async () => {},
      },
    )
    expect(result.content).toMatch(NO_PROJECT_NOTE_PATTERN)
    expect(result.content).not.toContain('parity-a.md')
  })
})

describe('search adapters: registration', () => {
  test('v1 keys the tool map with systematic_skill and systematic_search and leaves the hook list alone', async () => {
    const hooks = await createOpenCodeV1Hooks(
      {
        client: { app: { log: async () => {} } },
        directory: makeProject(),
      } as unknown as PluginInput,
      { packageRoot: PACKAGE_ROOT },
    )
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      'systematic_search',
      'systematic_skill',
    ])
    expect(Object.keys(hooks).sort()).toEqual([
      'config',
      'experimental.chat.messages.transform',
      'experimental.chat.system.transform',
      'tool',
      'tool.execute.after',
    ])
  })

  test('v2 registers the tool with codemode off and a plain-integer limit', async () => {
    const host = await createV2Host(makeProject())
    const tool = host.tool
    if (tool === undefined) throw new Error('v2 did not register the tool')
    expect(tool.options).toEqual({ codemode: false })
    const properties = tool.input.properties as Record<
      string,
      Record<string, unknown>
    >
    expect(properties.limit?.type).toBe('integer')
    expect(properties.limit).not.toHaveProperty('minimum')
    expect(properties.limit).not.toHaveProperty('maximum')
    expect(String(properties.limit?.description)).toContain('1 to 20')
    expect(tool.input.required).toEqual(['query'])
  })

  test('Pi registers search with a plain-integer limit', async () => {
    const host = await initPi()
    const tool = host.tool
    if (tool === undefined) throw new Error('Pi did not register the tool')
    const schema = tool.parameters as unknown as {
      properties: Record<string, Record<string, unknown>>
      required?: string[]
    }
    expect(schema.properties.limit?.type).toBe('integer')
    expect(schema.properties.limit).not.toHaveProperty('minimum')
    expect(schema.properties.limit).not.toHaveProperty('maximum')
    expect(String(schema.properties.limit?.description)).toContain('1 to 20')
    expect(schema.required).toEqual(['query'])
  })

  test('v2 with a pre-existing systematic_search reports a diagnostic and adds no duplicate', async () => {
    const host = await createV2Host(makeProject())
    const added = await host.preexisting(['systematic_search'])
    expect(added).not.toContain('systematic_search')
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('systematic_search'),
      ),
    ).toBe(true)
  })

  test('search.enabled false removes the tool from v1, v2 and Pi', async () => {
    writeUserConfig({ search: { enabled: false } })
    const hooks = await createOpenCodeV1Hooks(
      {
        client: { app: { log: async () => {} } },
        directory: makeProject(),
      } as unknown as PluginInput,
      { packageRoot: PACKAGE_ROOT },
    )
    expect(Object.keys(hooks.tool ?? {})).toEqual(['systematic_skill'])

    const v2 = await createV2Host(makeProject(), isolatedHome)
    expect(v2.tool).toBeUndefined()
    expect(v2.added).not.toContain('systematic_search')

    const pi = await initPi()
    expect(pi.tool).toBeUndefined()
    expect(pi.tools.map((t) => t.name)).not.toContain('systematic_search')
  })
})

describe('search adapters: failure mapping', () => {
  test('a core failure becomes one fixed line on every host and never throws', async () => {
    const root = makeProject()
    // A start directory that does not exist makes the walk-up fall back to a
    // path with no corpus; force a real throw by handing the adapters a
    // non-string query through a hostile getter instead.
    const hostile = {
      get query(): string {
        throw new Error('secret-detail-from-host')
      },
    }
    for (const surface of await allSurfaces(root)) {
      const text = await surface.search(root, hostile)
      expect(text.split('\n')).toHaveLength(1)
      expect(text).not.toContain('secret-detail-from-host')
      expect(text).toStartWith('Error:')
    }
  })
})

describe('search adapters: Pi delegates', () => {
  /**
   * Runs the real extension's `systematic_delegate`, with the SDK's session
   * construction replaced by a recorder, and returns what the child session
   * would have been built with.
   */
  async function dispatchDelegate(persona: string, cwd: string) {
    const api = {
      tools: [] as ToolDefinition[],
      registerTool(tool: ToolDefinition) {
        this.tools.push(tool)
      },
      on() {},
    }
    await piExtension(api as unknown as ExtensionAPI)
    const delegate = api.tools.find((t) => t.name === 'systematic_delegate')
    if (delegate === undefined) throw new Error('no delegate tool')

    const runtime = REAL_PI_DELEGATE_SESSION_RUNTIME
    const original = { ...runtime }
    let sessionOptions: CreateAgentSessionOptions | undefined
    runtime.createResourceLoader = () =>
      ({ reload: async () => {} }) as unknown as ReturnType<
        typeof original.createResourceLoader
      >
    runtime.createAgentSession = async (options) => {
      sessionOptions = options
      return {
        session: {
          subscribe: () => () => {},
          prompt: async () => {},
          abort: async () => {},
          dispose: () => {},
          getLastAssistantText: () => 'done',
        },
      } as unknown as CreateAgentSessionResult
    }
    try {
      await delegate.execute(
        'call-1',
        { agent: persona, task: 'find a learning' } as never,
        undefined,
        undefined,
        {
          cwd,
          model: { provider: 'p', id: 'm' },
          modelRegistry: { find: () => undefined },
        } as never,
      )
    } finally {
      Object.assign(runtime, original)
    }
    return sessionOptions
  }

  test('a persona with no tools line gets search allowed and the one shared definition, and it returns the parent text', async () => {
    const root = makeProject()
    const options = await dispatchDelegate('git-history-analyzer', root)

    expect(options?.tools).toContain('systematic_search')
    expect(options?.customTools?.map((tool) => tool.name)).toEqual([
      'systematic_search',
    ])
    const child = options?.customTools?.[0]
    if (child === undefined) throw new Error('no custom tool')
    const childResult = await piCall(child, root, { query: QUERY })
    const first = childResult.content[0]
    if (first?.type !== 'text') throw new Error('no text')
    const parent = await (await createPiSurface()).search(root, {
      query: QUERY,
    })
    expect(first.text).toBe(parent)
  })

  test('search.enabled false gives a delegate no custom tool', async () => {
    writeUserConfig({ search: { enabled: false } })
    const options = await dispatchDelegate(
      'git-history-analyzer',
      makeProject(),
    )
    expect(options?.customTools).toEqual([])
  })
})
