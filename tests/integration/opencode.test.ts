import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Config, PluginInput } from '@opencode-ai/plugin'

import SystematicPlugin from '../../src/index.js'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 90_000
const MAX_RETRIES = 1
const RETRY_DELAY_MS = 3_000
const OPENCODE_TEST_MODEL = 'opencode/big-pickle'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

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

interface OpencodeResult {
  stdout: string
  stderr: string
  exitCode: number
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

// Environment variable name patterns whose values must not appear in
// diagnostic output because they may carry credentials.
const REDACT_PATTERNS = [/TOKEN/i, /KEY/i, /SECRET/i, /PAT/i, /AUTH/i]

// Variables forwarded from the parent process into isolated OpenCode child
// processes. Everything else is either overridden by the fixture or dropped.
const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Node/Bun resolution
  'NODE_PATH',
  // OpenCode model auth — forwarded so the test model can authenticate.
  // Token values are redacted from failure diagnostics before surfacing.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENCODE_API_KEY',
])

function redactSensitive(text: string): string {
  let result = text
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue
    if (REDACT_PATTERNS.some((pattern) => pattern.test(key))) {
      result = result.replaceAll(value, '[REDACTED]')
    }
  }
  return result
}

function buildChildEnv(
  overrides: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      base[key] = value
    }
  }
  return { ...base, ...overrides }
}

/*
 * Isolation rationale for live OpenCode subprocess tests:
 *
 * OPENCODE_CONFIG_DIR alone is not enough. OpenCode and its plugins resolve
 * config, cache, data, and state through multiple root paths — including HOME
 * (~/.config/opencode, ~/.local/share, etc.) and the XDG base directories.
 * Without overriding all of them, a test process can silently read the
 * developer's real user config or write sessions into the real TUI session
 * list. Each test therefore gets its own temp root with isolated HOME,
 * XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, and XDG_STATE_HOME so
 * OpenCode has no path back to the real user environment.
 */
interface IsolatedFixture {
  tempRoot: string
  projectDir: string
  configDir: string
  homeDir: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgCacheHome: string
  xdgStateHome: string
}

function createIsolatedFixture(): IsolatedFixture {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-opencode-'),
  )
  const projectDir = path.join(tempRoot, 'project')
  const configDir = path.join(tempRoot, 'opencode-config')
  const homeDir = path.join(tempRoot, 'home')
  const xdgConfigHome = path.join(tempRoot, 'xdg-config')
  const xdgDataHome = path.join(tempRoot, 'xdg-data')
  const xdgCacheHome = path.join(tempRoot, 'xdg-cache')
  const xdgStateHome = path.join(tempRoot, 'xdg-state')

  for (const dir of [
    projectDir,
    configDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // A minimal package.json makes OpenCode treat this directory as an isolated
  // project root rather than walking up into the real repository.
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'systematic-integration-fixture',
      private: true,
      type: 'module',
    }),
  )

  return {
    tempRoot,
    projectDir,
    configDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  }
}

function destroyIsolatedFixture(fixture: IsolatedFixture): void {
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true })
}

interface RunOpencodeOptions {
  fixture: IsolatedFixture
  configContent: string
  extraEnv?: Record<string, string>
}

type ProbeTransformKind = 'chat' | 'title' | 'unknown'

interface ProbeLoadedEvent {
  type: 'loaded'
}

interface ProbeSystemEvent {
  type: 'system'
  kind: ProbeTransformKind
  input: Record<string, unknown>
  system: string[]
}

interface ProbeToolEvent {
  type: 'tool'
  description: string
  parameters: unknown
}

type ProbeEvent = ProbeLoadedEvent | ProbeSystemEvent | ProbeToolEvent
const PROBE_SYSTEM_KINDS = new Set<ProbeTransformKind>([
  'chat',
  'title',
  'unknown',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  )
}

function isProbeEvent(value: unknown): value is ProbeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  if (value.type === 'loaded') return Object.keys(value).length === 1

  if (value.type === 'system') {
    return (
      typeof value.kind === 'string' &&
      PROBE_SYSTEM_KINDS.has(value.kind as ProbeTransformKind) &&
      isRecord(value.input) &&
      isStringArray(value.system)
    )
  }

  if (value.type === 'tool') {
    return typeof value.description === 'string' && 'parameters' in value
  }

  return false
}

function parseProbeEvent(line: string, index: number): ProbeEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch (error) {
    throw new Error(`invalid JSONL capture line ${index + 1}: ${String(error)}`)
  }

  if (!isProbeEvent(parsed)) {
    throw new Error(`malformed probe event at line ${index + 1}: ${line}`)
  }

  return parsed
}

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

function countWorkflowBlocks(system: readonly string[]): number {
  return system.reduce(
    (count, entry) => count + entry.split('<SYSTEMATIC_WORKFLOWS>').length - 1,
    0,
  )
}

function createProbePlugin(fixture: IsolatedFixture): {
  url: string
  capturePath: string
} {
  const probeDir = path.join(fixture.tempRoot, 'probe-plugin')
  const probePath = path.join(probeDir, 'index.mjs')
  const capturePath = path.join(fixture.tempRoot, 'probe-capture.jsonl')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(
    path.join(probeDir, 'package.json'),
    JSON.stringify({
      name: 'systematic-integration-probe',
      type: 'module',
      main: './index.mjs',
    }),
  )
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}

function append(entry) {
  fs.appendFileSync(capturePath, JSON.stringify(entry) + '\\n')
}

function classifyTransformInput(input) {
  if (!input || typeof input !== 'object') return 'unknown'
  if (typeof input.sessionID === 'string' && 'model' in input) return 'chat'
  if ('model' in input && !('sessionID' in input)) return 'title'
  return 'unknown'
}

export default async function probe() {
  append({ type: 'loaded' })
  return {
    'tool.definition': async (input, output) => {
      if (input.toolID !== 'systematic_skill') return
      append({
        type: 'tool',
        description: output.description,
        parameters: output.parameters,
      })
    },
    'experimental.chat.system.transform': async (input, output) => {
      append({ type: 'system', kind: classifyTransformInput(input), input, system: output.system })
    },
  }
}
`,
  )

  return { url: pathToFileURL(probeDir).href, capturePath }
}

function readProbeEvents(capturePath: string): ProbeEvent[] {
  if (!fs.existsSync(capturePath)) return []
  const content = fs.readFileSync(capturePath, 'utf8').trim()
  if (content === '') return []
  return content
    .split('\n')
    .map((line: string, index: number) => parseProbeEvent(line, index))
}

function assertProbeCapturedEvents(probe: {
  capturePath: string
}): ProbeEvent[] {
  const events = readProbeEvents(probe.capturePath)
  if (events.length > 0) return events

  throw new Error(
    `probe plugin did not capture any events at ${probe.capturePath}`,
  )
}

function assertOk(result: OpencodeResult): void {
  if (result.exitCode === 0) return
  const stdoutTail = redactSensitive(result.stdout.slice(-2000))
  const stderrTail = redactSensitive(result.stderr.slice(-2000))
  throw new Error(
    `opencode exited with code ${result.exitCode}\n` +
      `--- stdout (tail) ---\n${stdoutTail}\n` +
      `--- stderr (tail) ---\n${stderrTail}`,
  )
}

function assertMixedVersionProbeEvents(events: ProbeEvent[]): void {
  const systemEvents = events.filter((event) => event.type === 'system')
  const chatSystemEvents = systemEvents.filter((event) => event.kind === 'chat')
  const titleSystemEvents = systemEvents.filter(
    (event) => event.kind === 'title',
  )
  expect(chatSystemEvents.length).toBeGreaterThan(0)

  const workflowSystems = chatSystemEvents
    .map((event) => event.system)
    .filter((system) => countWorkflowBlocks(system) > 0)
  expect(workflowSystems.length).toBeGreaterThan(0)

  for (const system of workflowSystems) {
    expect(countWorkflowBlocks(system)).toBe(1)
    expect(system[0]).toContain('<SYSTEMATIC_WORKFLOWS>')
    for (const [index, entry] of system.entries()) {
      if (index > 0) {
        expect(entry).not.toContain('<SYSTEMATIC_WORKFLOWS>')
      }
    }
    expect(system[0]).toContain('<available_skills>')
    expect(system[0]).toMatch(/ce:brainstorm|systematic:setup/)
  }

  if (titleSystemEvents.length > 0) {
    for (const event of titleSystemEvents) {
      expect(countWorkflowBlocks(event.system)).toBe(0)
    }
  }
}

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

async function runOpencode(
  prompt: string,
  options: RunOpencodeOptions,
): Promise<OpencodeResult> {
  const { fixture, configContent, extraEnv } = options

  // Build a narrow child environment. Override all OpenCode config/state paths
  // so the subprocess cannot read or write the real user environment.
  const childEnv = buildChildEnv({
    // Suppress first-boot side effects that are irrelevant to plugin tests:
    // OPENCODE_DISABLE_AUTOUPDATE prevents the binary from self-updating mid-test;
    // OPENCODE_DISABLE_LSP_DOWNLOAD skips language-server downloads that would
    // hit the network and write into the fixture's data dir;
    // OPENCODE_DISABLE_MODELS_FETCH skips the provider model-list fetch that
    // would make an outbound API call on every startup;
    // OPENCODE_DISABLE_PRUNE prevents session-storage pruning that could race
    // with the test's own filesystem assertions.
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    ...extraEnv,
    HOME: fixture.homeDir,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
    OPENCODE_CONFIG_DIR: fixture.configDir,
    OPENCODE_CONFIG_CONTENT: configContent,
  })

  let lastResult: OpencodeResult = { stdout: '', stderr: '', exitCode: -1 }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const args = ['opencode', 'run', '--model', OPENCODE_TEST_MODEL, prompt]
    const result = Bun.spawnSync(args, {
      cwd: fixture.projectDir,
      env: childEnv,
      timeout: TIMEOUT_MS,
    })

    lastResult = {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? -1,
    }

    const isTimeout =
      lastResult.exitCode === -1 || lastResult.stderr.includes('ETIMEDOUT')
    const isRateLimit =
      lastResult.stderr.includes('rate limit') ||
      lastResult.stderr.includes('429')

    if (!isTimeout && !isRateLimit && lastResult.exitCode === 0) {
      return lastResult
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * attempt
      console.log(
        `Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms...`,
      )
      await Bun.sleep(delay)
    }
  }

  return lastResult
}

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
    /(?:Skill\s+"?setup"?|systematic_skill\s*\{"name":"(?:systematic:)?setup"\})/i,
  )
  expect(result.stdout).toMatch(/ce:review/i)
}

test('expectSetupSkillLoaded accepts setup output without tool id mention', () => {
  expect(() =>
    expectSetupSkillLoaded({
      exitCode: 0,
      stdout: 'Loaded ce:review',
      stderr: '→ Skill "setup"\n',
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
        docs: { model: 'openai/gpt-4' },
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
    expect(config.agent?.['ankane-readme-writer']?.model).toBe('openai/gpt-4')
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
        'Use the systematic_skill tool to load systematic:setup',
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
        'Use the systematic_skill tool to load setup',
        { fixture, configContent: buildSourceLocalConfig() },
      )

      expectSetupSkillLoaded(result)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test.skipIf(!DIST_LOCAL_AVAILABLE)(
    'dist-local plugin registers systematic_skill and loads setup skill after bun run build',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load setup',
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
      const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
      const originalConfigContent = process.env.OPENCODE_CONFIG_CONTENT
      try {
        process.env.OPENCODE_CONFIG_DIR = '/nonexistent-poison-config-dir'
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          plugin: ['/nonexistent-poison-plugin.js'],
        })

        const result = await runOpencode(
          'Use the systematic_skill tool to load systematic:setup',
          { fixture, configContent: buildSourceLocalConfig() },
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toMatch(/systematic_skill/)
      } finally {
        if (originalConfigDir === undefined) {
          delete process.env.OPENCODE_CONFIG_DIR
        } else {
          process.env.OPENCODE_CONFIG_DIR = originalConfigDir
        }
        if (originalConfigContent === undefined) {
          delete process.env.OPENCODE_CONFIG_CONTENT
        } else {
          process.env.OPENCODE_CONFIG_CONTENT = originalConfigContent
        }
      }
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'fixture run does not write into repo .opencode directory',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load systematic:setup',
        { fixture, configContent: buildSourceLocalConfig() },
      )

      expectSetupSkillLoaded(result)
      assertTreeUnchanged(REPO_OPENCODE_SNAPSHOT, REPO_OPENCODE_DIR)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )
})

const MIXED_VERSION_ENABLED = process.env.SYSTEMATIC_MIXED_VERSION_TEST === '1'

function buildMixedVersionConfig(probePluginUrl: string): string {
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

        const toolEvents = events.filter((event) => event.type === 'tool')
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
          expect(event.description).toMatch(/ce:brainstorm|systematic:setup/)
          expect(event.description).not.toContain('<available_skills>')
          expect(event.description).not.toContain('<location>')
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )
  },
)
