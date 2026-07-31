import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config, PluginInput } from '@opencode-ai/plugin'

import SystematicPlugin from '../../src/index.js'
import {
  assertMixedVersionProbeEvents,
  assertOk,
  assertProbeCapturedEvents,
  buildChildEnv,
  buildIsolatedOpencodeEnv,
  cleanupPackedTarball,
  createIsolatedFixture,
  createProbePlugin,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  type IsolatedFixture,
  isProbeToolEvent,
  MAX_RETRIES,
  OPENCODE_AVAILABLE,
  type OpencodeResult,
  packTarballOnce,
  parseProbeEvent,
  REPO_ROOT,
  runOpencode,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

// Snapshot the repo's .opencode tree at module load so tests can assert that
// live OpenCode subprocesses do not mutate the real repository state.
const REPO_OPENCODE_DIR = path.join(REPO_ROOT, '.opencode')
type OpencodeTreeSnapshot = ReadonlyMap<string, string>

const REPO_OPENCODE_SNAPSHOT: OpencodeTreeSnapshot | null = (() => {
  if (!fs.existsSync(REPO_OPENCODE_DIR)) return null
  return snapshotDirectoryTree(REPO_OPENCODE_DIR)
})()

type AgentConfig = NonNullable<Config['agent']>[string]

function skillPermission(agent: AgentConfig | undefined): unknown {
  return (agent?.permission as { skill?: unknown } | undefined)?.skill
}

function snapshotDirectoryTree(rootDir: string): OpencodeTreeSnapshot {
  const entries = new Map<string, string>()

  function walk(currentDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name)
      const relativePath = path.relative(rootDir, entryPath)

      if (entry.isDirectory()) {
        entries.set(relativePath, 'dir')
        walk(entryPath)
        continue
      }

      if (entry.isSymbolicLink()) {
        entries.set(relativePath, `symlink:${fs.readlinkSync(entryPath)}`)
        continue
      }

      if (entry.isFile()) {
        const content = fs.readFileSync(entryPath)
        const digest = createHash('sha256').update(content).digest('hex')
        entries.set(relativePath, `file:${digest}:${content.byteLength}`)
      }
    }
  }

  walk(rootDir)
  return entries
}

function assertTreeUnchanged(
  before: OpencodeTreeSnapshot | null,
  afterDir: string,
): void {
  if (before === null) {
    expect(fs.existsSync(afterDir)).toBe(false)
    return
  }

  const after = snapshotDirectoryTree(afterDir)
  const sortedBefore = Array.from(before.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  const sortedAfter = Array.from(after.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  expect(sortedAfter).toEqual(sortedBefore)
}

test('snapshotDirectoryTree records symlink targets', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-symlink-'))
  try {
    const targetFile = path.join(tempRoot, 'target.txt')
    const linkFile = path.join(tempRoot, 'link.txt')
    fs.writeFileSync(targetFile, 'linked content')
    fs.symlinkSync('target.txt', linkFile)

    const snapshot = snapshotDirectoryTree(tempRoot)

    expect(snapshot.get('link.txt')).toBe('symlink:target.txt')
    expect(snapshot.get('target.txt')).toMatch(/^file:/)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('assertTreeUnchanged ignores snapshot entry order', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-tree-'))
  try {
    fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'one')
    fs.writeFileSync(path.join(tempRoot, 'b.txt'), 'two')

    const actual = snapshotDirectoryTree(tempRoot)
    const before = new Map<string, string>([
      ['b.txt', actual.get('b.txt') ?? ''],
      ['a.txt', actual.get('a.txt') ?? ''],
    ])

    expect(() => assertTreeUnchanged(before, tempRoot)).not.toThrow()
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('parseProbeEvent rejects invalid system transform kind', () => {
  expect(() =>
    parseProbeEvent(
      JSON.stringify({
        type: 'system',
        kind: 'bogus',
        input: {},
        system: [],
      }),
      0,
    ),
  ).toThrow(/malformed probe event/i)
})

test('assertOk redacts token-like diagnostics while keeping context', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY
  const originalOpenaiKey = process.env.OPENAI_API_KEY

  process.env.ANTHROPIC_API_KEY = 'sk-test-1234567890abcdef'
  process.env.OPENAI_API_KEY = 'ghp_1234567890abcdef'

  try {
    expect(() =>
      assertOk({
        exitCode: 1,
        stdout:
          'bootstrap ok\napi token: sk-test-1234567890abcdef\nmore context',
        stderr: 'stderr context\nerror key: ghp_1234567890abcdef\nextra detail',
      }),
    ).toThrow(
      /bootstrap ok[\s\S]*\[REDACTED\][\s\S]*stderr context[\s\S]*\[REDACTED\]/,
    )

    try {
      assertOk({
        exitCode: 1,
        stdout:
          'bootstrap ok\napi token: sk-test-1234567890abcdef\nmore context',
        stderr: 'stderr context\nerror key: ghp_1234567890abcdef\nextra detail',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('[REDACTED]')
      expect(message).toContain('bootstrap ok')
      expect(message).toContain('stderr context')
      expect(message).not.toContain('sk-test-1234567890abcdef')
      expect(message).not.toContain('ghp_1234567890abcdef')
    }
  } finally {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey

    if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenaiKey
  }
})

function assertFixtureEnvironmentRoots(fixture: IsolatedFixture): void {
  const childEnv = buildChildEnv({
    HOME: fixture.homeDir,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
  })

  expect(childEnv.HOME).toBe(fixture.homeDir)
  expect(childEnv.XDG_CONFIG_HOME).toBe(fixture.xdgConfigHome)
  expect(childEnv.XDG_DATA_HOME).toBe(fixture.xdgDataHome)
  expect(childEnv.XDG_CACHE_HOME).toBe(fixture.xdgCacheHome)
  expect(childEnv.XDG_STATE_HOME).toBe(fixture.xdgStateHome)
}

interface EnvBackup {
  HOME: string | undefined
  XDG_CONFIG_HOME: string | undefined
  XDG_DATA_HOME: string | undefined
  XDG_CACHE_HOME: string | undefined
  XDG_STATE_HOME: string | undefined
  OPENCODE_CONFIG_DIR: string | undefined
  OPENCODE_CONFIG_CONTENT: string | undefined
}

function restoreEnv(backup: EnvBackup): void {
  if (backup.OPENCODE_CONFIG_DIR === undefined)
    delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = backup.OPENCODE_CONFIG_DIR

  if (backup.OPENCODE_CONFIG_CONTENT === undefined)
    delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = backup.OPENCODE_CONFIG_CONTENT

  if (backup.HOME === undefined) delete process.env.HOME
  else process.env.HOME = backup.HOME

  if (backup.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = backup.XDG_CONFIG_HOME

  if (backup.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = backup.XDG_DATA_HOME

  if (backup.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = backup.XDG_CACHE_HOME

  if (backup.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = backup.XDG_STATE_HOME
}

test('fixture env overrides parent HOME and XDG roots', () => {
  const fixture = createIsolatedFixture()
  const originalHome = process.env.HOME
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
  const originalXdgDataHome = process.env.XDG_DATA_HOME
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME
  const originalXdgStateHome = process.env.XDG_STATE_HOME

  process.env.HOME = '/poisoned/home'
  process.env.XDG_CONFIG_HOME = '/poisoned/xdg-config'
  process.env.XDG_DATA_HOME = '/poisoned/xdg-data'
  process.env.XDG_CACHE_HOME = '/poisoned/xdg-cache'
  process.env.XDG_STATE_HOME = '/poisoned/xdg-state'

  try {
    const childEnv = buildChildEnv({
      HOME: fixture.homeDir,
      XDG_CONFIG_HOME: fixture.xdgConfigHome,
      XDG_DATA_HOME: fixture.xdgDataHome,
      XDG_CACHE_HOME: fixture.xdgCacheHome,
      XDG_STATE_HOME: fixture.xdgStateHome,
    })

    expect(childEnv.HOME).toBe(fixture.homeDir)
    expect(childEnv.XDG_CONFIG_HOME).toBe(fixture.xdgConfigHome)
    expect(childEnv.XDG_DATA_HOME).toBe(fixture.xdgDataHome)
    expect(childEnv.XDG_CACHE_HOME).toBe(fixture.xdgCacheHome)
    expect(childEnv.XDG_STATE_HOME).toBe(fixture.xdgStateHome)
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome

    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome

    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalXdgDataHome

    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome

    if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalXdgStateHome

    destroyIsolatedFixture(fixture)
  }
})

function assertParentNpmConfigNotForwarded(): void {
  const env = buildChildEnv({})
  expect(env.npm_config_cache).toBeUndefined()
  expect(env.npm_config_prefix).toBeUndefined()
}

test('buildChildEnv ignores parent npm_config env unless explicitly overridden', () => {
  const originalCache = process.env.npm_config_cache
  const originalPrefix = process.env.npm_config_prefix

  process.env.npm_config_cache = '/parent/cache'
  process.env.npm_config_prefix = '/parent/prefix'

  try {
    assertParentNpmConfigNotForwarded()

    const overridden = buildChildEnv({
      npm_config_cache: '/fixture/cache',
      npm_config_prefix: '/fixture/prefix',
    })

    expect(overridden.npm_config_cache).toBe('/fixture/cache')
    expect(overridden.npm_config_prefix).toBe('/fixture/prefix')
  } finally {
    if (originalCache === undefined) delete process.env.npm_config_cache
    else process.env.npm_config_cache = originalCache
    if (originalPrefix === undefined) delete process.env.npm_config_prefix
    else process.env.npm_config_prefix = originalPrefix
  }
})

function buildSourceLocalConfig(): string {
  const pluginPath = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({ plugin: [pluginPath] })
}

function buildDistLocalConfig(): string {
  const pluginPath = `file://${path.join(REPO_ROOT, 'dist/index.js')}`
  return JSON.stringify({ plugin: [pluginPath] })
}

const DIST_INDEX = path.join(REPO_ROOT, 'dist/index.js')
const DIST_LOCAL_AVAILABLE = fs.existsSync(DIST_INDEX)

function expectSetupSkillLoaded(result: OpencodeResult): void {
  assertOk(result)
  expect(result.stderr).toMatch(
    /(?:Skill\s+"?git-clean-gone-branches"?|systematic_skill\s*\{"name":"(?:systematic:)?git-clean-gone-branches"\})/i,
  )
  expect(result.stdout).toMatch(/(?:branch|repositor(?:y|ies)|\brepo\b)/i)
}

test('expectSetupSkillLoaded accepts git-clean-gone-branches output without tool id mention', () => {
  expect(() =>
    expectSetupSkillLoaded({
      exitCode: 0,
      stdout: 'No stale branches found',
      stderr: '→ Skill "git-clean-gone-branches"\n',
    }),
  ).not.toThrow()
})

describe('SystematicPlugin config hook integration', () => {
  let tempDir: string
  let projectDir: string
  let homeDir: string
  let originalHomedir: typeof os.homedir

  beforeEach(() => {
    originalHomedir = os.homedir
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-plugin-'))

    // Isolate from real user config (~/.config/opencode/systematic.json)
    // by mocking os.homedir to point at an empty temp directory.
    homeDir = path.join(tempDir, 'fake-home')
    fs.mkdirSync(homeDir, { recursive: true })
    os.homedir = () => homeDir

    projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    // Restore os.homedir before cleanup so nothing snags on a deleted dir.
    os.homedir = originalHomedir
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.XDG_DATA_HOME
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function writeSystematicConfig(config: Record<string, unknown>): void {
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, '.opencode/systematic.json'),
      JSON.stringify(config),
    )
  }

  function writeCustomSystematicConfig(config: Record<string, unknown>): void {
    const customDir = path.join(tempDir, 'custom-config')
    process.env.OPENCODE_CONFIG_DIR = customDir
    fs.mkdirSync(customDir, { recursive: true })
    fs.writeFileSync(
      path.join(customDir, 'systematic.json'),
      JSON.stringify(config),
    )
  }

  async function runConfigHook(config: Config): Promise<void> {
    const input = {
      directory: projectDir,
      client: {
        app: {
          log: async () => {},
        },
      },
    } as unknown as PluginInput

    // Exercise the duplicate plugin-factory path that happens when multiple
    // OpenCode config sources reference Systematic in the same process. Both
    // invocations must expose the real config hook surface.
    const firstHooks = await SystematicPlugin(input)
    const hooks = await SystematicPlugin(input)

    expect(firstHooks.config).toBeDefined()
    expect(hooks.config).toBeDefined()
    await hooks.config?.(config)
  }

  test('exact overlay emits a tuned bundled agent', async () => {
    writeCustomSystematicConfig({
      agents: {
        'correctness-reviewer': {
          model: 'openrouter/anthropic/claude-sonnet-4',
          temperature: 0.33,
          top_p: 0.8,
          mode: 'subagent',
        },
      },
    })

    const config: Config = {}
    await runConfigHook(config)

    expect(config.agent?.['correctness-reviewer']).toMatchObject({
      model: 'openrouter/anthropic/claude-sonnet-4',
      temperature: 0.33,
      top_p: 0.8,
      mode: 'subagent',
    })
    expect(config.agent?.['correctness-reviewer']?.description).toContain(
      '(Correctness-Reviewer - Systematic)',
    )
  })

  test('category overlay tunes category members and skips native replacements', async () => {
    writeCustomSystematicConfig({
      categories: {
        review: {
          temperature: 0.21,
          skills: ['ce:review'],
        },
      },
    })

    const config: Config = {
      agent: {
        'security-reviewer': {
          description: 'Native security reviewer',
          prompt: 'Native prompt',
        },
      },
    }
    await runConfigHook(config)

    expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.21)
    expect(skillPermission(config.agent?.['correctness-reviewer'])).toEqual({
      '*': 'deny',
      'ce:review': 'allow',
    })
    expect(config.agent?.['security-reviewer']).toEqual({
      description: 'Native security reviewer',
      prompt: 'Native prompt',
    })
  })

  test('native-replaced category member is partitioned out before overlay application', async () => {
    writeCustomSystematicConfig({
      categories: {
        review: {
          temperature: 0.44,
          color: '#123abc',
          skills: ['ce:review'],
        },
      },
    })

    const nativeSecurityReviewer = {
      description: 'Native owns this key',
      prompt: 'Native prompt',
    }
    const config: Config = {
      agent: {
        'security-reviewer': nativeSecurityReviewer,
      },
    }
    await runConfigHook(config)

    expect(config.agent?.['security-reviewer']).toBe(nativeSecurityReviewer)
    expect(config.agent?.['security-reviewer']?.temperature).toBeUndefined()
    expect(config.agent?.['security-reviewer']?.color).toBeUndefined()
    expect(config.agent?.['security-reviewer']?.permission).toBeUndefined()
    expect(config.agent?.['security-reviewer']?.description).not.toContain(
      'Systematic',
    )
  })

  test('exact overlay plus native same-name agent fails before partial mutation', async () => {
    writeSystematicConfig({
      agents: {
        'correctness-reviewer': { temperature: 0.11 },
      },
    })

    const config: Config = {
      agent: {
        'correctness-reviewer': {
          description: 'Native correctness reviewer',
          prompt: 'Native prompt',
        },
      },
      command: {
        native: {
          description: 'Native command',
          template: 'Native template',
        },
      },
    }
    const before = structuredClone(config)

    await expect(runConfigHook(config)).rejects.toThrow(/native/i)
    expect(config).toEqual(before)
  })

  test('loads with category model overlays and exact agent overlay without throwing', async () => {
    writeCustomSystematicConfig({
      categories: {
        design: { model: 'openai/gpt-4' },
        'document-review': { model: 'openai/gpt-4' },
        research: { model: 'openai/gpt-4' },
        review: { model: 'openai/gpt-4' },
      },
      agents: {
        'systematic-implementer': {
          model: 'anthropic/claude-sonnet-4',
          variant: 'full',
        },
      },
    })

    const config: Config = {}
    await runConfigHook(config)

    // Category model overlays are applied to bundled agents from each category.
    expect(config.agent).toBeDefined()
    expect(Object.keys(config.agent ?? {}).length).toBeGreaterThan(0)
    expect(config.agent?.['design-iterator']?.model).toBe('openai/gpt-4')
    expect(config.agent?.['adversarial-document-reviewer']?.model).toBe(
      'openai/gpt-4',
    )
    expect(config.agent?.['best-practices-researcher']?.model).toBe(
      'openai/gpt-4',
    )
    expect(config.agent?.['adversarial-reviewer']?.model).toBe('openai/gpt-4')

    // Exact agent overlay is applied with model and variant.
    expect(config.agent?.['systematic-implementer']).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      variant: 'full',
    })

    // Skills registered as commands.
    expect(config.command).toBeDefined()
    expect(Object.keys(config.command ?? {}).length).toBeGreaterThan(0)

    // Skills paths registered.
    const configWithSkills = config as Config & {
      skills?: { paths?: string[] }
    }
    expect(configWithSkills.skills?.paths).toBeDefined()
    expect(configWithSkills.skills?.paths?.length ?? 0).toBeGreaterThan(0)
    expect(configWithSkills.skills?.paths).toContain(
      path.resolve(REPO_ROOT, 'skills'),
    )
  })

  test('every emitted bundled-agent color matches OpenCode `/config` schema', async () => {
    // Regression for v2.7.x crash: invalid colors (purple, blue, etc.) on
    // bundled agents made OpenCode `/config` HttpApi validation reject the
    // body, returning HTTP 400 and crashing TUI launch with empty error body.
    // OpenCode accepts hex `#RRGGBB` or one of the seven theme tokens.
    const VALID_TOKENS = new Set([
      'primary',
      'secondary',
      'accent',
      'success',
      'warning',
      'error',
      'info',
    ])
    const HEX_REGEX = /^#[0-9a-fA-F]{6}$/

    const config: Config = {}
    await runConfigHook(config)

    const offenders: { name: string; color: string }[] = []
    for (const [name, agent] of Object.entries(config.agent ?? {})) {
      const color = agent?.color
      if (color === undefined) continue
      if (typeof color !== 'string') {
        offenders.push({ name, color: String(color) })
        continue
      }
      if (HEX_REGEX.test(color)) continue
      if (VALID_TOKENS.has(color)) continue
      offenders.push({ name, color })
    }

    expect(offenders).toEqual([])
  })

  test('well-shaped nonexistent explicit model passes validation and emits unchanged', async () => {
    writeCustomSystematicConfig({
      agents: {
        'correctness-reviewer': {
          model: 'nonexistent-provider/nonexistent-model',
        },
      },
    })

    const config: Config = {}
    await runConfigHook(config)

    expect(config.agent?.['correctness-reviewer']?.model).toBe(
      'nonexistent-provider/nonexistent-model',
    )
  })

  test('loads project config from systematic.jsonc with comments', async () => {
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, '.opencode/systematic.jsonc'),
      '{\n  // JSONC config with comment\n  "agents": {\n    "correctness-reviewer": { "temperature": 0.44 }\n  }\n}\n',
    )

    const config: Config = {}
    await runConfigHook(config)

    expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.44)
  })
})

describe.skipIf(!OPENCODE_AVAILABLE)('opencode integration', () => {
  let fixture: IsolatedFixture

  beforeEach(() => {
    fixture = createIsolatedFixture()
  })

  afterEach(() => {
    destroyIsolatedFixture(fixture)
  })

  test(
    'source-local plugin loads systematic skill with prefix',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
        { fixture, configContent: buildSourceLocalConfig() },
      )

      expectSetupSkillLoaded(result)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'source-local plugin loads systematic skill without prefix',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load git-clean-gone-branches',
        { fixture, configContent: buildSourceLocalConfig() },
      )

      expectSetupSkillLoaded(result)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test.skipIf(!DIST_LOCAL_AVAILABLE)(
    'dist-local plugin registers systematic_skill and loads git-clean-gone-branches skill after bun run build',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load git-clean-gone-branches',
        { fixture, configContent: buildDistLocalConfig() },
      )

      expectSetupSkillLoaded(result)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'fixture env overrides parent OPENCODE_CONFIG_DIR and OPENCODE_CONFIG_CONTENT',
    async () => {
      // Verify that the child process sees the fixture's env values, not any
      // poison values that might be set in the parent process. If the parent
      // env leaked through, the child would load the poison config and the
      // systematic plugin would not register systematic_skill.
      const backup: EnvBackup = {
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
      }
      try {
        process.env.OPENCODE_CONFIG_DIR = '/nonexistent-poison-config-dir'
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          plugin: ['/nonexistent-poison-plugin.js'],
        })
        process.env.HOME = '/nonexistent-poison-home'
        process.env.XDG_CONFIG_HOME = '/nonexistent-poison-xdg-config'
        process.env.XDG_DATA_HOME = '/nonexistent-poison-xdg-data'
        process.env.XDG_CACHE_HOME = '/nonexistent-poison-xdg-cache'
        process.env.XDG_STATE_HOME = '/nonexistent-poison-xdg-state'

        assertFixtureEnvironmentRoots(fixture)

        const result = await runOpencode(
          'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
          { fixture, configContent: buildSourceLocalConfig() },
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toMatch(/systematic_skill/)
        expect(result.stderr).toMatch(/git-clean-gone-branches/)
        expect(result.stderr).not.toContain('/nonexistent-poison-home')
        expect(result.stderr).not.toContain('/nonexistent-poison-xdg-config')
        expect(result.stderr).not.toContain('/nonexistent-poison-xdg-data')
        expect(result.stderr).not.toContain('/nonexistent-poison-xdg-cache')
        expect(result.stderr).not.toContain('/nonexistent-poison-xdg-state')
      } finally {
        restoreEnv(backup)
      }
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'fixture run does not write into repo .opencode directory',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
        { fixture, configContent: buildSourceLocalConfig() },
      )

      expectSetupSkillLoaded(result)
      assertTreeUnchanged(REPO_OPENCODE_SNAPSHOT, REPO_OPENCODE_DIR)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )
})

/** Model-free `opencode debug config` invocation, isolated the same way as `runOpencode`. */
function runOpencodeDebugConfig(
  fixture: IsolatedFixture,
  configContent: string,
): OpencodeResult {
  const childEnv = buildIsolatedOpencodeEnv(fixture, configContent)
  const result = Bun.spawnSync(
    ['opencode', 'debug', 'config', '--print-logs', '--log-level', 'ERROR'],
    { cwd: fixture.projectDir, env: childEnv, timeout: TIMEOUT_MS },
  )
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? -1,
  }
}

// Requires real `tar` and symlink semantics for artifact extraction; POSIX only.
describe.skipIf(!OPENCODE_AVAILABLE || process.platform === 'win32')(
  'packaged-plugin runtime validation',
  () => {
    let fixture: IsolatedFixture

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(() => {
      cleanupPackedTarball()
    })

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    // Relies on `opencode/big-pickle`, confirmed public/no-auth by the
    // isolated-HOME test above. Provider outage is a genuine integration
    // failure here, not a skip condition.
    test(
      'packaged plugin loads, warns on a removed disabled_skills name, and exposes a compliant catalog',
      async () => {
        const probe = createProbePlugin(fixture)
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['orchestrating-swarms'] }),
        )
        const configContent = JSON.stringify({
          plugin: [pluginUrl, probe.url],
        })

        const result = await runOpencode(
          'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
          { fixture, configContent },
        )

        // Tool actually being invoked and its output surfacing proves the
        // packaged plugin's hooks registered and ran startup successfully.
        expectSetupSkillLoaded(result)
        expect(result.stderr).toContain(
          '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored.',
        )

        const events = assertProbeCapturedEvents(probe)
        const toolEvents = events.filter(isProbeToolEvent)
        expect(toolEvents.length).toBeGreaterThan(0)
        for (const event of toolEvents) {
          expect(event.description).toContain(
            'systematic:orchestrating-subagents',
          )
          expect(event.description).not.toContain(
            'systematic:orchestrating-swarms',
          )
          expect(event.description).not.toContain(
            'systematic:claude-permissions-optimizer',
          )
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )

    test(
      'packaged plugin rejects an unrecognized disabled_skills name, model-free',
      () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['never-existed-skill'] }),
        )
        const configContent = JSON.stringify({ plugin: [pluginUrl] })

        const result = runOpencodeDebugConfig(fixture, configContent)

        // OpenCode 1.17.18 host contract: plugin-factory rejections are
        // caught and logged, hooks omitted, host exits 0
        // (.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/plugin/index.ts:219-235).
        // Asserting exitCode === 0 (not just log content) prevents a hang
        // or crash from silently passing.
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain('failed to load plugin')
        expect(result.stderr).toContain('Invalid Systematic config in')
      },
      TIMEOUT_MS,
    )
  },
)

const MIXED_VERSION_ENABLED = process.env.SYSTEMATIC_MIXED_VERSION_TEST === '1'

function buildMixedVersionConfig(probePluginUrl: string): string {
  // Pin the published package to a known-good OpenCode integration surface;
  // bump this only when intentionally revalidating a newer release here.
  const pinnedPackage = '@fro.bot/systematic@2.14.1'
  const localSource = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({
    plugin: [pinnedPackage, localSource, probePluginUrl],
  })
}

describe.skipIf(!OPENCODE_AVAILABLE)(
  'opencode mixed-version integration',
  () => {
    let fixture: IsolatedFixture

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    test.skipIf(!MIXED_VERSION_ENABLED)(
      'pinned package plus local source keep systematic_skill deterministic and converge bootstrap',
      async () => {
        const probe = createProbePlugin(fixture)
        const result = await runOpencode(
          'Use the systematic_skill tool to load ce:review',
          {
            fixture,
            configContent: buildMixedVersionConfig(probe.url),
            extraEnv: {
              npm_config_cache: path.join(fixture.tempRoot, 'npm-cache'),
              npm_config_prefix: path.join(fixture.tempRoot, 'npm-prefix'),
            },
          },
        )

        assertOk(result)
        expect(result.stderr).toMatch(/systematic_skill/)
        expect(result.stdout).toMatch(/ce:review/i)

        const events = assertProbeCapturedEvents(probe)

        assertMixedVersionProbeEvents(events)

        const toolEvents = events.filter(isProbeToolEvent)
        expect(toolEvents.length).toBeGreaterThanOrEqual(2)
        expect(new Set(toolEvents.map((event) => event.description)).size).toBe(
          1,
        )
        expect(
          new Set(toolEvents.map((event) => JSON.stringify(event.parameters)))
            .size,
        ).toBe(1)
        for (const event of toolEvents) {
          expect(event.description).toContain('## Available Systematic Skills')
          expect(event.description).toMatch(
            /ce:brainstorm|systematic:git-clean-gone-branches/,
          )
          expect(event.description).not.toContain('<available_skills>')
          expect(event.description).not.toContain('<location>')
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )
  },
)
