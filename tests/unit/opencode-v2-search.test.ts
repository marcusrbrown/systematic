/**
 * The v2 `search` installer on its own: registration mechanics against a fake
 * `ctx.tool.transform`. What the tool prints, and that it matches v1 and Pi, is
 * pinned in `search-adapters-parity.test.ts`.
 */
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
import {
  createSafeGuard,
  setupOpenCodeV2,
  type V2Snapshot,
} from '../../src/lib/opencode-v2.js'
import { SEARCH_NOTICES } from '../../src/lib/search-core.js'
import { installSearch } from '../../src/lib/search-tool.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..')
const temp = createTempDirTracker()
let errorSpy: Mock<typeof console.error>

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  temp.cleanup()
})

interface StubTool {
  name: string
  input: Record<string, unknown>
  options?: { codemode?: boolean }
  execute(
    input: unknown,
    context: Record<string, unknown>,
  ): Promise<{ content: string; metadata: Record<string, unknown> }>
}

function fakeHost(location: Record<string, unknown>) {
  const transforms: ((editor: unknown) => void)[] = []
  const assertions: unknown[] = []
  const ctx = {
    location,
    permission: {
      async assert(call: unknown) {
        assertions.push(call)
      },
    },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        transforms.push(callback)
      },
    },
  } as unknown as Plugin.Context
  return { ctx, transforms, assertions }
}

function snapshotWith(search: unknown): V2Snapshot {
  return {
    config: { search },
    packageRoot: PACKAGE_ROOT,
  } as unknown as V2Snapshot
}

async function install(
  host: ReturnType<typeof fakeHost>,
  search: unknown = undefined,
) {
  const lines: string[] = []
  await installSearch({
    ctx: host.ctx,
    snapshot: snapshotWith(search),
    guard: createSafeGuard(),
    report: (message) => lines.push(message),
  })
  return lines
}

function editorWith(existing: string[] = []) {
  const tools = new Map<string, StubTool>()
  for (const name of existing) {
    tools.set(name, { name } as StubTool)
  }
  return {
    tools,
    get: (id: string) => tools.get(id),
    add(tool: StubTool) {
      tools.set(tool.name, tool)
    },
  }
}

describe('installSearch', () => {
  test('registers one transform that adds systematic_search with codemode off', async () => {
    const host = fakeHost({ directory: '/somewhere' })
    await install(host)

    expect(host.transforms).toHaveLength(1)
    const editor = editorWith()
    host.transforms[0]?.(editor)
    const tool = editor.tools.get('systematic_search')
    expect(tool?.options).toEqual({ codemode: false })
    expect([...editor.tools.keys()]).toEqual(['systematic_search'])
  })

  test('search.enabled false never reaches the host', async () => {
    const host = fakeHost({ directory: '/somewhere' })
    await install(host, { enabled: false })
    expect(host.transforms).toHaveLength(0)
  })

  test('enabled true still registers the tool', async () => {
    const host = fakeHost({ directory: '/somewhere' })
    await install(host, { enabled: true })
    expect(host.transforms).toHaveLength(1)
  })

  test('a name another plugin holds is left alone and reported once across replays', async () => {
    const host = fakeHost({ directory: '/somewhere' })
    const lines = await install(host)

    const editor = editorWith(['systematic_search'])
    host.transforms[0]?.(editor)
    host.transforms[0]?.(editor)

    expect(editor.tools.get('systematic_search')?.execute).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('systematic_search')
    expect(lines[0]).toContain('already registered')
  })

  test('a failing add is reported through the guard and never thrown into the host', async () => {
    const host = fakeHost({ directory: '/somewhere' })
    await install(host)
    const editor = {
      get: () => undefined,
      add() {
        throw new Error('add exploded')
      },
    }

    expect(() => host.transforms[0]?.(editor)).not.toThrow()
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('add exploded'),
      ),
    ).toBe(true)
  })

  test('execute never asks the host for a permission', async () => {
    const dir = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-search-'))),
    )
    fs.mkdirSync(path.join(dir, '.git'))
    const host = fakeHost({ directory: dir })
    await install(host)
    const editor = editorWith()
    host.transforms[0]?.(editor)
    const tool = editor.tools.get('systematic_search')

    const result = await tool?.execute(
      { query: 'anything' },
      { sessionID: 's', agent: 'a', messageID: 'm', id: 'c' },
    )

    expect(result?.content).toContain('corpus: none')
    expect(host.assertions).toEqual([])
  })

  test('the start directory is read per call, so a late location is honoured', async () => {
    const location: Record<string, unknown> = {}
    const host = fakeHost(location)
    await install(host)
    const editor = editorWith()
    host.transforms[0]?.(editor)
    const tool = editor.tools.get('systematic_search')
    const context = { sessionID: 's', agent: 'a', messageID: 'm', id: 'c' }

    const before = await tool?.execute({ query: 'x' }, context)
    expect(before?.content).toBe(SEARCH_NOTICES.noProject)

    const dir = temp.track(
      fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'v2-search-late-')),
      ),
    )
    fs.mkdirSync(path.join(dir, '.git'))
    location.directory = dir
    const after = await tool?.execute({ query: 'x' }, context)
    expect(after?.content).toContain('corpus: none')
  })
})

describe('setupOpenCodeV2 search slot', () => {
  test('the default installers register search after skills and before commands', async () => {
    const order: string[] = []
    const home = temp.track(
      fs.mkdtempSync(path.join(os.tmpdir(), 'v2-search-home-')),
    )
    const project = temp.track(
      fs.mkdtempSync(path.join(os.tmpdir(), 'v2-search-project-')),
    )
    const transformOrder: string[] = []
    const ctx = {
      location: { directory: project },
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
          const names: string[] = []
          callback({
            get: () => undefined,
            add: (tool: { name: string }) => names.push(tool.name),
          })
          transformOrder.push(...names)
        },
      },
    } as unknown as Plugin.Context

    await setupOpenCodeV2(ctx, {
      packageRoot: PACKAGE_ROOT,
      homeDir: home,
      installers: {
        agents: () => {
          order.push('agents')
        },
        commands: () => {
          order.push('commands')
        },
        bootstrap: () => {
          order.push('bootstrap')
        },
      },
    })

    expect(transformOrder).toEqual(['systematic_skill', 'systematic_search'])
    expect(order).toEqual(['agents', 'commands', 'bootstrap'])
  })
})

/**
 * A project file that holds a bad `search.sources` never fails v2 setup, and
 * neither does one that cannot be parsed: the loader skips that file.
 */
describe('setupOpenCodeV2 with a project search.sources problem', () => {
  const TOOL_CONTEXT = { sessionID: 's', agent: 'a', messageID: 'm', id: 'c' }

  function makeHost(project: string) {
    const added: StubTool[] = []
    const ctx = {
      location: { directory: project },
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
          callback({
            get: () => undefined,
            add: (tool: StubTool) => added.push(tool),
          })
        },
      },
    } as unknown as Plugin.Context
    return { ctx, added }
  }

  function makeEnv(projectFile: string) {
    const home = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-src-home-'))),
    )
    const project = temp.track(
      fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'v2-src-project-')),
      ),
    )
    fs.mkdirSync(path.join(project, '.git'))
    fs.mkdirSync(path.join(project, '.opencode'))
    fs.writeFileSync(
      path.join(project, '.opencode/systematic.json'),
      projectFile,
    )
    fs.mkdirSync(path.join(project, 'docs/solutions'), { recursive: true })
    fs.writeFileSync(
      path.join(project, 'docs/solutions/zebra.md'),
      '---\ntitle: Zebra flake\n---\n\nzebra\n',
    )
    return { home, project }
  }

  test.each([
    ['sources that is not an array', '{ "search": { "sources": "nope" } }'],
    [
      'an entry with a root the project rules reject',
      '{ "search": { "sources": [ { "name": "bad", "format": "markdown", "roots": ["."] } ] } }',
    ],
  ])(
    '%s leaves setup intact, built-in search working and external reporting it',
    async (_label, projectFile) => {
      const { home, project } = makeEnv(projectFile)
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const host = makeHost(project)
        await setupOpenCodeV2(host.ctx, {
          packageRoot: PACKAGE_ROOT,
          homeDir: home,
        })

        const tool = host.added.find(
          (entry) => entry.name === 'systematic_search',
        )
        expect(tool).toBeDefined()
        const builtin = await tool?.execute({ query: 'zebra' }, TOOL_CONTEXT)
        expect(builtin?.content).toContain('docs/solutions/zebra.md')
        const external = await tool?.execute(
          { query: 'zebra', kind: 'external' },
          TOOL_CONTEXT,
        )
        expect(external?.content).toStartWith('External sources for "zebra":')
        expect(external?.content).toContain('no external sources are active')
      } finally {
        warnSpy.mockRestore()
      }
    },
  )

  describe('the init warnings about the entries of a project', () => {
    const PROPOSALS = JSON.stringify({
      search: {
        sources: [
          {
            name: 'quokka-notes',
            format: 'markdown',
            roots: ['docs/quokka'],
            exclude: ['[bad]'],
          },
          { name: 'quokka-broken', format: 'markdown', roots: ['.'] },
        ],
      },
    })

    async function initWarnings(allowed: boolean): Promise<string> {
      const { home, project } = makeEnv(PROPOSALS)
      if (allowed) {
        const userDir = path.join(home, '.config/opencode')
        fs.mkdirSync(userDir, { recursive: true })
        fs.writeFileSync(
          path.join(userDir, 'systematic.json'),
          JSON.stringify({ search: { allow_project_sources: [project] } }),
        )
      }
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await setupOpenCodeV2(makeHost(project).ctx, {
          packageRoot: PACKAGE_ROOT,
          homeDir: home,
        })
        return warnSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      } finally {
        warnSpy.mockRestore()
      }
    }

    test('name no proposal when the project is not on the allow list', async () => {
      expect(await initWarnings(false)).not.toContain('quokka')
    })

    test('name the dropped entry and the dropped pattern when the project is allowed', async () => {
      const text = await initWarnings(true)
      expect(text).toContain('"quokka-broken"')
      expect(text).toContain('`exclude[0]` of search source "quokka-notes"')
    })
  })

  test('a project file that cannot be parsed is skipped: setup resolves and the host keeps the plugin', async () => {
    const { home, project } = makeEnv('{ broken')
    const host = makeHost(project)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        setupOpenCodeV2(host.ctx, { packageRoot: PACKAGE_ROOT, homeDir: home }),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
    expect(host.added.length).toBeGreaterThan(0)
  })
})
