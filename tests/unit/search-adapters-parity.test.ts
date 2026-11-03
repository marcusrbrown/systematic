/**
 * Parity across the search tool adapters. Each adapter's real entry runs over
 * one fixture corpus and the rendered text is compared byte for byte (AE5 for
 * v1, v2 and Pi). A shared-core test would not prove this: the adapters pick
 * their own start directory and map their own errors.
 *
 * The corpus is the committed lifecycle fixture plus documents written here at
 * run time, because a file name carrying an ESC byte cannot live in git. The
 * CLI (`systematic search`), the in-process `systematic-search` bin entry and
 * the built bin run under real Node join the three hosts here (AE5 in full).
 * Later units add the hybrid cases to this same file.
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
import { spawnSync } from 'node:child_process'
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
import { Type } from 'typebox'
import {
  buildSearchBundle,
  CLAUDE_CODE_SEARCH_BIN,
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.js'
import { runClaudeCodeSearch } from '../../src/claude-code-search.js'
import { searchCliInputs } from '../../src/cli.js'
import { createOpenCodeV1Hooks } from '../../src/lib/opencode-v1.js'
import { setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import { REAL_PI_DELEGATE_SESSION_RUNTIME } from '../../src/lib/pi-delegate-session.js'
import {
  runSearchCli,
  SEARCH_CLI_DISABLED_NOTICE,
} from '../../src/lib/search-cli.js'
import {
  MAX_LIMIT,
  runSearch,
  SEARCH_ERRORS,
  SEARCH_NOTICES,
} from '../../src/lib/search-core.js'
import {
  createPiSearchTool,
  createSearchTool,
} from '../../src/lib/search-tool.js'
import type { UserLevelConfigDirOptions } from '../../src/lib/search-user-config.js'
import piExtension from '../../src/pi.js'
import { NODE_BIN } from '../helpers/real-node.js'
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
  fs.rmSync(builtBinHome, { recursive: true, force: true })
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

/** The `Notes:` lines of a reply. */
function noteLines(text: string | undefined): string[] {
  return (text ?? '').split('\n').filter((line) => line.startsWith('Notes:'))
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

/** `makeProject()` plus a plan, a brainstorm and an ideation doc that all mention the zebra. */
function makeMixedProject(): string {
  const root = makeProject()
  const write = (relative: string, content: string) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  write(
    'docs/plans/2026-10-01-001-feat-zebra-plan.md',
    '---\ntitle: "feat: Zebra flake rollout"\nstatus: completed\n---\n\nPlan for the zebra flake retry change.\n',
  )
  write(
    'docs/brainstorms/2026-10-02-zebra-requirements.md',
    '---\ntopic: Zebra flake ideas\nstatus: abandoned\n---\n\nWe rejected a zebra flake retry rewrite.\n',
  )
  write(
    'docs/ideation/2026-10-03-zebra-ideation.md',
    '---\ntopic: Zebra survey\n---\n\nIdeas about zebra flake retries.\n',
  )
  return root
}

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
  // The isolated home, so a test's user config reaches v2 like the other surfaces.
  const host = await createV2Host(directory, isolatedHome)
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

/** The three host tools. Tests that poke a tool's own failure mapping use these. */
async function allSurfaces(root: string): Promise<Surface[]> {
  return [
    await createV1Surface(),
    await createV2Surface(root),
    await createPiSurface(),
  ]
}

/** Turn a tool-style args record into the argv `systematic search` takes. */
function toArgv(args: Record<string, unknown>): string[] {
  const argv = [String(args.query)]
  if (args.kind !== undefined) argv.push('--kind', String(args.kind))
  if (args.limit !== undefined) argv.push('--limit', String(args.limit))
  return argv
}

/** What a user sees from a CLI run: stdout on success, the stderr message on a usage error. */
function cliOutput(status: number, stdout: string[], stderr: string[]): string {
  if (status === 0) return stdout.join('\n')
  // A usage error prints one fixed message and nothing on stdout.
  expect(stdout).toEqual([])
  return stderr.join('\n')
}

/** `systematic search`: the real runner with the real `cli.ts` settings adapter. */
function createCliSurface(): Surface {
  return {
    name: 'cli',
    async search(root, args) {
      const stdout: string[] = []
      const stderr: string[] = []
      const status = await runSearchCli({
        argv: toArgv(args),
        cwd: root,
        usageName: 'systematic search',
        ...searchCliInputs({
          homeDir: isolatedHome,
          userConfigDir: path.join(isolatedHome, '.config/opencode'),
          customConfigDir: null,
        }),
        outputSink: (message) => stdout.push(message),
        errorSink: (message) => stderr.push(message),
      })
      return cliOutput(status, stdout, stderr)
    },
  }
}

/** The `systematic-search` bin entry, in process, reading the user-level files. */
function createBinSurface(): Surface {
  return {
    name: 'bin',
    async search(root, args) {
      const stdout: string[] = []
      const stderr: string[] = []
      const status = await runClaudeCodeSearch({
        argv: toArgv(args),
        cwd: root,
        userLevel: { homeDir: isolatedHome, customConfigDir: null },
        outputSink: (message) => stdout.push(message),
        errorSink: (message) => stderr.push(message),
      })
      return cliOutput(status, stdout, stderr)
    },
  }
}

let builtBinPath: Promise<string> | undefined
/** Kept for the whole file (the per-test cleanup would remove it), removed in `afterAll`. */
const builtBinHome = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'search-bin-')),
)

/** The production-built bin, written once per file the way the plugin build writes it. */
function installBuiltBin(): Promise<string> {
  builtBinPath ??= (async () => {
    const outDir = path.join(builtBinHome, 'plugin')
    const files = generatePluginFiles(
      PACKAGE_ROOT,
      Buffer.from('placeholder validator bundle'),
      (await buildSearchBundle(PACKAGE_ROOT)).bundle,
    )
    writePluginFiles(
      new Map(
        [...files].filter(([rel]) => rel === `bin/${CLAUDE_CODE_SEARCH_BIN}`),
      ),
      outDir,
    )
    return path.join(outDir, 'bin', CLAUDE_CODE_SEARCH_BIN)
  })()
  return builtBinPath
}

/**
 * The built bin run under real Node from the project directory, which holds no
 * `node_modules`, with stdin closed and a timeout.
 */
async function createBuiltBinSurface(): Promise<Surface> {
  const bin = await installBuiltBin()
  return {
    name: 'built bin (node)',
    async search(root, args) {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      }
      delete env.OPENCODE_CONFIG_DIR
      delete env.XDG_CONFIG_HOME
      const result = spawnSync(NODE_BIN, [bin, ...toArgv(args)], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(result.error).toBeUndefined()
      const out = (result.stdout ?? '').replace(/\n$/, '')
      const err = (result.stderr ?? '').replace(/\n$/, '')
      return cliOutput(
        result.status ?? -1,
        out === '' ? [] : [out],
        err === '' ? [] : [err],
      )
    },
  }
}

/** The three hosts plus the CLI and the in-process bin entry. */
async function everySurface(root: string): Promise<Surface[]> {
  return [...(await allSurfaces(root)), createCliSurface(), createBinSurface()]
}

describe('search adapters parity (AE5: v1, v2, Pi, CLI, bin)', () => {
  test('the same query over one corpus yields byte-identical text on every surface', async () => {
    const root = makeProject()
    const surfaces = await everySurface(root)
    const texts = await Promise.all(
      surfaces.map((surface) => surface.search(root, { query: QUERY })),
    )

    expect(texts[0]).toContain('docs/solutions/parity-a.md')
    expect(texts[0]).toContain('Zebra crossing flake')
    for (const text of texts) expect(text).toBe(texts[0] as string)
  })

  test('kind all and kind plan give byte-identical text on every surface, built bin included', async () => {
    const root = makeMixedProject()
    const surfaces = [
      ...(await everySurface(root)),
      await createBuiltBinSurface(),
    ]
    for (const kind of ['all', 'plan', 'brainstorm', 'ideation']) {
      const texts = await Promise.all(
        surfaces.map((surface) => surface.search(root, { query: QUERY, kind })),
      )
      for (const text of texts) expect(text).toBe(texts[0] as string)
    }
    const all = await surfaces[0]?.search(root, { query: QUERY, kind: 'all' })
    expect(all).toContain('Corpus: solution ')
    for (const kind of ['solution', 'plan', 'brainstorm', 'ideation']) {
      expect(all).toContain(`Kind: ${kind}`)
    }
    expect(all).toContain('docs/brainstorms/2026-10-02-zebra-requirements.md')
    expect(all).toContain('Status: abandoned')
    expect(all).toContain('Title: feat: Zebra flake rollout')
  }, 60_000)

  test('the built bin, run under real node from a directory with no node_modules, prints the same text as every other surface', async () => {
    const root = makeProject()
    const built = await createBuiltBinSurface()
    const reference = await (await createV1Surface()).search(root, {
      query: QUERY,
    })
    expect(await built.search(root, { query: QUERY })).toBe(reference)
    expect(
      await built.search(root, { query: QUERY, kind: 'solution', limit: 1 }),
    ).toBe(
      await (await createCliSurface()).search(root, {
        query: QUERY,
        kind: 'solution',
        limit: 1,
      }),
    )
    for (const surface of await everySurface(root)) {
      expect(await surface.search(root, { query: QUERY })).toBe(reference)
    }
  }, 60_000)

  test('kind and limit pass through every surface to the same result', async () => {
    const root = makeProject()
    const surfaces = await everySurface(root)
    const texts = await Promise.all(
      surfaces.map((surface) =>
        surface.search(root, { query: QUERY, kind: 'solution', limit: 1 }),
      ),
    )
    for (const text of texts) expect(text).toBe(texts[0] as string)
    expect(texts[0]).toContain('parity-a.md')
    expect(texts[0]).not.toContain('parity-b.md')
  })

  test('no ESC, BEL or OSC 52 payload reaches any surface output', async () => {
    const root = makeProject()
    const surfaces = [
      ...(await everySurface(root)),
      await createBuiltBinSurface(),
    ]
    for (const surface of surfaces) {
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

  test('limit 0 and limit 21 get the core fixed error on every surface', async () => {
    const root = makeProject()
    for (const surface of await everySurface(root)) {
      for (const limit of [0, MAX_LIMIT + 1, 2.5, 'x']) {
        const text = await surface.search(root, { query: QUERY, limit })
        expect(text).toBe(SEARCH_ERRORS.limitInvalid)
      }
    }
  })

  test('an empty query and an unknown kind get the core fixed errors', async () => {
    const root = makeProject()
    for (const surface of await everySurface(root)) {
      expect(await surface.search(root, { query: '   ' })).toBe(
        SEARCH_ERRORS.queryEmpty,
      )
      for (const kind of ['bogus', 'ALL', 'all ', '']) {
        expect(await surface.search(root, { query: 'a', kind })).toBe(
          SEARCH_ERRORS.kindUnknown,
        )
      }
    }
  })

  test('a doc written between two calls appears in the second on every surface', async () => {
    const root = makeProject()
    const surfaces = await everySurface(root)
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

describe('search adapters parity: unreadable config', () => {
  test('an invalid user search block gives identical text, with the config unreadable note, on all five surfaces', async () => {
    writeUserConfig({ search: { enabled: 'SECRET-VALUE-no' } })
    // The loaders warn once per load; this test is about the result text.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = makeProject()
      const surfaces = await everySurface(root)
      const texts = await Promise.all(
        surfaces.map((surface) => surface.search(root, { query: QUERY })),
      )

      expect(texts[0]).toContain('Notes: config unreadable')
      expect(texts[0]).toContain('docs/solutions/parity-a.md')
      expect(texts[0]).not.toContain('Lanes')
      surfaces.forEach((surface, index) => {
        expect([surface.name, texts[index]]).toEqual([
          surface.name,
          texts[0] as string,
        ])
      })
      expect(texts.join('\n')).not.toContain('SECRET-VALUE')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('a readable config adds no note on any surface', async () => {
    writeUserConfig({ search: { enabled: true } })
    const root = makeProject()
    for (const surface of await everySurface(root)) {
      expect(await surface.search(root, { query: QUERY })).not.toContain(
        'config unreadable',
      )
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

describe('search adapters: tool text names every kind', () => {
  const WORDS = [
    'solution',
    'plan',
    'brainstorm',
    'ideation',
    'all',
    'external',
  ]

  function expectKindText(text: string): void {
    for (const word of WORDS) expect(text).toContain(`"${word}"`)
    expect(text).not.toContain('exists today')
  }

  test('v1 describes the tool and its kind argument', async () => {
    const hooks = await createOpenCodeV1Hooks(
      {
        client: { app: { log: async () => {} } },
        directory: makeProject(),
      } as unknown as PluginInput,
      { packageRoot: PACKAGE_ROOT },
    )
    const tool = hooks.tool?.systematic_search
    if (tool === undefined) throw new Error('v1 did not register the tool')
    const kind = (
      tool.args as unknown as Record<string, { description?: string }>
    ).kind
    expectKindText(kind?.description ?? '')
    expect(tool.description).toContain('docs/plans')
  })

  test('v2 describes the tool and its kind argument', async () => {
    const host = await createV2Host(makeProject())
    const tool = host.tool
    if (tool === undefined) throw new Error('v2 did not register the tool')
    const properties = tool.input.properties as Record<
      string,
      Record<string, unknown>
    >
    expectKindText(String(properties.kind?.description))
  })

  test('Pi describes the tool and its kind argument', async () => {
    const host = await initPi()
    const tool = host.tool
    if (tool === undefined) throw new Error('Pi did not register the tool')
    const schema = tool.parameters as unknown as {
      properties: Record<string, Record<string, unknown>>
    }
    expectKindText(String(schema.properties.kind?.description))
    expect(tool.description).toContain('docs/brainstorms')
    expect(tool.promptSnippet).toContain('docs/plans')
    expect(tool.promptSnippet).toContain('all')
    expect(tool.promptSnippet).toContain('"external"')
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

// --- kind: "external" ---------------------------------------------------------

const EXTERNAL_QUERY = 'zebra'

interface ExternalFixture {
  readonly root: string
  readonly wiki: string
}

function writeProjectSearch(root: string, search: unknown): void {
  fs.mkdirSync(path.join(root, '.opencode'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.opencode/systematic.json'),
    JSON.stringify({ search }),
  )
}

/**
 * A project that proposes `decisions` (with a committed symlink plant inside
 * it), a user wiki mapped to the project, and a user config that allows the
 * project's main root. The home and every root sit in temp directories.
 */
function makeExternalProject(
  options: { allow?: boolean; userSource?: boolean } = {},
): ExternalFixture {
  const { allow = true, userSource = true } = options
  const root = makeProject()
  const outside = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-outside-'))),
  )
  fs.writeFileSync(
    path.join(outside, 'secret.md'),
    '---\ntitle: Outside secret\n---\n\nzebra OUTSIDE-SECRET-BODY\n',
  )
  const decisions = path.join(root, 'docs/decisions')
  fs.mkdirSync(decisions, { recursive: true })
  fs.writeFileSync(
    path.join(decisions, 'zebra-rollback.md'),
    '---\ntitle: Zebra rollback decision\nstatus: accepted\n---\n\nWe roll the zebra flake fix back when retries overlap.\n',
  )
  fs.symlinkSync(
    path.join(outside, 'secret.md'),
    path.join(decisions, 'leak.md'),
  )
  writeProjectSearch(root, {
    sources: [
      { name: 'decisions', format: 'markdown', roots: ['docs/decisions'] },
    ],
  })

  const wiki = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-wiki-'))),
  )
  fs.writeFileSync(
    path.join(wiki, 'zebra-wiki.md'),
    '# Zebra wiki page\n\nThe zebra flake is documented here.\n',
  )
  writeUserConfig({
    search: {
      ...(allow && { allow_project_sources: [root] }),
      ...(userSource && {
        sources: [
          { name: 'wiki', format: 'markdown', roots: [wiki], projects: [root] },
        ],
      }),
    },
  })
  return { root, wiki }
}

/** Every surface, built bin included. */
async function externalSurfaces(root: string): Promise<Surface[]> {
  return [...(await everySurface(root)), await createBuiltBinSurface()]
}

async function externalTexts(
  surfaces: readonly Surface[],
  root: string,
  args: Record<string, unknown> = { query: EXTERNAL_QUERY, kind: 'external' },
): Promise<string[]> {
  const texts: string[] = []
  // One at a time: the built bin and the hosts share the isolated home.
  for (const surface of surfaces) texts.push(await surface.search(root, args))
  return texts
}

function expectIdentical(
  surfaces: readonly Surface[],
  texts: readonly string[],
): void {
  surfaces.forEach((surface, index) => {
    expect([surface.name, texts[index]]).toEqual([
      surface.name,
      texts[0] as string,
    ])
  })
}

describe('search adapters parity: kind external', () => {
  test('the same fixture gives byte-identical external text on every surface, built bin included, and the symlink plant stays out', async () => {
    const { root } = makeExternalProject()
    const surfaces = await externalSurfaces(root)
    const texts = await externalTexts(surfaces, root)

    expect(texts[0]).toStartWith(`External sources for "${EXTERNAL_QUERY}":`)
    expect(texts[0]).toContain('decisions (project)')
    expect(texts[0]).toContain('wiki (user)')
    expect(texts[0]).toContain('decisions/zebra-rollback.md')
    expect(texts[0]).not.toContain('leak.md')
    expect(texts[0]).not.toContain('OUTSIDE-SECRET')
    expectIdentical(surfaces, texts)
  }, 120_000)

  test('with the allow entry removed every surface gives the identical not-allowed text and reads nothing from the project', async () => {
    const { root } = makeExternalProject({ allow: false })
    const surfaces = await externalSurfaces(root)
    const texts = await externalTexts(surfaces, root)

    expect(texts[0]).toContain('wiki (user)')
    expect(texts[0]).toContain('Project sources: 1 proposed source not read')
    expect(texts[0]).toContain(root)
    expect(texts[0]).not.toContain('decisions (project)')
    expect(texts[0]).not.toContain('zebra-rollback.md')
    expectIdentical(surfaces, texts)
  }, 120_000)

  test('with no user source either, every surface returns the identical fixed not-allowed reply', async () => {
    const { root } = makeExternalProject({ allow: false, userSource: false })
    const surfaces = await externalSurfaces(root)
    const texts = await externalTexts(surfaces, root)

    expect(texts[0]).toContain('but it is not in search.allow_project_sources')
    expect(texts[0]).toContain(`add "${root}"`)
    expect(texts[0]).not.toContain('decisions')
    expectIdentical(surfaces, texts)
  }, 120_000)

  test('with sources active, every built-in selector is byte-identical to its output with none', async () => {
    const root = makeMixedProject()
    const surfaces = await everySurface(root)
    const kinds = [
      undefined,
      'solution',
      'plan',
      'brainstorm',
      'ideation',
      'all',
    ]
    const before = new Map<string, string>()
    for (const surface of surfaces) {
      for (const kind of kinds) {
        before.set(
          `${surface.name}/${kind}`,
          await surface.search(root, { query: QUERY, kind }),
        )
      }
    }

    // Sources become active: a project proposal, an allow entry and a user wiki.
    const wiki = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-wiki-'))),
    )
    fs.writeFileSync(
      path.join(wiki, 'z.md'),
      '# Zebra flake\n\nzebra flake retry\n',
    )
    writeProjectSearch(root, {
      sources: [
        { name: 'decisions', format: 'markdown', roots: ['docs/plans'] },
      ],
    })
    writeUserConfig({
      search: {
        allow_project_sources: [root],
        sources: [
          { name: 'wiki', format: 'markdown', roots: [wiki], projects: [root] },
        ],
      },
    })
    const external = await surfaces[0]?.search(root, {
      query: QUERY,
      kind: 'external',
    })
    expect(external).toContain('wiki (user)')

    for (const surface of surfaces) {
      for (const kind of kinds) {
        const after = await surface.search(root, { query: QUERY, kind })
        expect([surface.name, kind, after]).toEqual([
          surface.name,
          kind,
          before.get(`${surface.name}/${kind}`) as string,
        ])
        expect(after).not.toContain('External sources')
        expect(after).not.toContain('wiki (user)')
      }
    }
  }, 120_000)

  test('editing the allow list between two calls changes the second call on every surface, with nothing restarted', async () => {
    const { root } = makeExternalProject({ allow: false, userSource: false })
    const surfaces = await everySurface(root)
    for (const surface of surfaces) {
      expect(
        await surface.search(root, { query: EXTERNAL_QUERY, kind: 'external' }),
      ).toContain('not in search.allow_project_sources')
    }
    writeUserConfig({ search: { allow_project_sources: [root] } })
    for (const surface of surfaces) {
      expect([
        surface.name,
        await surface.search(root, { query: EXTERNAL_QUERY, kind: 'external' }),
      ]).toEqual([surface.name, expect.stringContaining('decisions (project)')])
    }
  })

  test('an invalid enabled beside valid sources gives one note and the same sections on all surfaces: no fixed failure line anywhere', async () => {
    const { root, wiki } = makeExternalProject()
    writeUserConfig({
      search: {
        enabled: 'SECRET-VALUE-no',
        allow_project_sources: [root],
        sources: [
          { name: 'wiki', format: 'markdown', roots: [wiki], projects: [root] },
        ],
      },
    })
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const surfaces = await everySurface(root)
      const texts = await externalTexts(surfaces, root)
      // The note is the `Notes:` line. A warning may mention the same words, and
      // whether the 200-character cap cuts it short depends on the path length.
      expect(noteLines(texts[0])).toEqual(['Notes: config unreadable'])
      expect(texts[0]).toContain('wiki (user)')
      expect(texts[0]).toContain('decisions (project)')
      expect(texts[0]).not.toContain(SEARCH_NOTICES.failed)
      expect(texts.join('\n')).not.toContain('SECRET-VALUE')
      expectIdentical(surfaces, texts)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('search.enabled false: the CLI and the bin print the disabled notice for external, and no tool registers', async () => {
    const { root } = makeExternalProject()
    writeUserConfig({
      search: { enabled: false, allow_project_sources: [root] },
    })
    for (const surface of [createCliSurface(), createBinSurface()]) {
      expect(
        await surface.search(root, { query: EXTERNAL_QUERY, kind: 'external' }),
      ).toBe(SEARCH_CLI_DISABLED_NOTICE)
    }
    expect((await createV2Host(root, isolatedHome)).tool).toBeUndefined()
    expect((await initPi()).tool).toBeUndefined()
  })

  test('a Pi call whose cwd has no .git ancestor gets the core no-project reply; a v2 call with no host directory gets the adapter line', async () => {
    makeExternalProject()
    const bare = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-bare-'))),
    )
    const pi = await createPiSurface()
    const text = await pi.search(bare, {
      query: EXTERNAL_QUERY,
      kind: 'external',
    })
    expect(text).toStartWith(
      `External sources for "${EXTERNAL_QUERY}": no project`,
    )
    expect(text).toBe(
      (
        await runSearch(
          { query: EXTERNAL_QUERY, kind: 'external' },
          { startDir: bare },
        )
      ).text,
    )

    const host = await createV2Host(undefined)
    const result = await host.tool?.execute(
      { query: EXTERNAL_QUERY, kind: 'external' },
      {
        sessionID: 's',
        agent: 'a',
        messageID: 'm',
        id: 'c',
        progress: async () => {},
      },
    )
    expect(result?.content).toBe(SEARCH_NOTICES.noProject)
  })

  test('a v2 project file with a valid shape but a bad sources entry leaves setup intact: built-in search works and external warns', async () => {
    const root = makeProject()
    writeProjectSearch(root, {
      sources: [
        { name: 'decisions', format: 'markdown', roots: ['docs/decisions'] },
        { name: 'bad', format: 'markdown', roots: ['.'] },
      ],
    })
    fs.mkdirSync(path.join(root, 'docs/decisions'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'docs/decisions/zebra-rollback.md'),
      '---\ntitle: Zebra rollback decision\n---\n\nzebra\n',
    )
    writeUserConfig({ search: { allow_project_sources: [root] } })

    // The config loader warns once per load; this test is about the replies.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const v2 = await createV2Surface(root)
      expect(await v2.search(root, { query: QUERY })).toContain('parity-a.md')
      const external = await v2.search(root, {
        query: EXTERNAL_QUERY,
        kind: 'external',
      })
      expect(external).toContain('decisions (project)')
      expect(external).toContain('Warnings:')
      expect(external).toContain('bad')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('search adapters: config-dir option and note merge', () => {
  function altConfig(root: string, wiki: string): UserLevelConfigDirOptions {
    const home = temp.track(
      fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'search-alt-home-')),
      ),
    )
    const dir = path.join(home, '.config/opencode')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      JSON.stringify({
        search: {
          sources: [
            {
              name: 'altwiki',
              format: 'markdown',
              roots: [wiki],
              projects: [root],
            },
          ],
        },
      }),
    )
    return { homeDir: home, customConfigDir: null }
  }

  async function callV1(
    tool: ReturnType<typeof createSearchTool>,
    root: string,
  ): Promise<string> {
    const result = await tool.execute(
      { query: EXTERNAL_QUERY, kind: 'external' } as never,
      toolContext(root) as never,
    )
    return typeof result === 'string' ? result : result.output
  }

  test('v1 and Pi hand their config-dir option to the external reader and select the allow list it names', async () => {
    const { root, wiki } = makeExternalProject({
      allow: false,
      userSource: false,
    })
    const configOptions = altConfig(root, wiki)

    const v1 = createSearchTool({ settings: undefined, configOptions })
    const v1Text = await callV1(v1, root)
    expect(v1Text).toContain('altwiki (user)')

    const pi = createPiSearchTool({ settings: undefined, configOptions, Type })
    const piText = await piCall(pi, root, {
      query: EXTERNAL_QUERY,
      kind: 'external',
    })
    const first = piText.content[0]
    expect(first?.type === 'text' ? first.text : '').toBe(v1Text)

    // Without the option the adapter reads the isolated default home: no wiki.
    const plain = createSearchTool({ settings: undefined })
    expect(await callV1(plain, root)).not.toContain('altwiki')
  })

  test('a registration-time note and a per-call failure print one note; a repair clears the note from the next external call but not from built-in calls', async () => {
    const { root, wiki } = makeExternalProject({
      allow: false,
      userSource: false,
    })
    const configOptions = altConfig(root, wiki)
    const configFile = path.join(
      configOptions.homeDir as string,
      '.config/opencode/systematic.json',
    )
    const good = fs.readFileSync(configFile, 'utf8')
    const count = (text: string) =>
      noteLines(text).filter((line) => line.includes('config unreadable'))
        .length

    const unflagged = createSearchTool({ settings: undefined, configOptions })
    const flagged = createSearchTool({
      settings: undefined,
      unreadable: true,
      configOptions,
    })

    fs.writeFileSync(configFile, '{ broken')
    expect(count(await callV1(unflagged, root))).toBe(1)
    expect(count(await callV1(flagged, root))).toBe(1)

    fs.writeFileSync(configFile, good)
    expect(count(await callV1(unflagged, root))).toBe(0)
    expect(count(await callV1(flagged, root))).toBe(0)

    // Built-in calls keep the init-time note: they read no per-call config.
    const builtIn = async (tool: ReturnType<typeof createSearchTool>) => {
      const result = await tool.execute(
        { query: EXTERNAL_QUERY } as never,
        toolContext(root) as never,
      )
      return typeof result === 'string' ? result : result.output
    }
    expect(count(await builtIn(flagged))).toBe(1)
    expect(count(await builtIn(unflagged))).toBe(0)
  })
})
