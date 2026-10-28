/**
 * Characterization goldens for the OpenCode v1 plugin.
 *
 * These pin today's v1 output (the `config` hook result, the `systematic_skill`
 * descriptor and execution, the system transform, and the restore behavior of
 * the after-hook and the messages transform) so the shared-core extraction
 * and the export-shape change can prove v1 stays byte-identical.
 *
 * How it stays synthetic: the plugin derives its bundled asset directories
 * from its own file location (`<package root>/src/index.ts` -> `<root>/skills`).
 * So the test copies `src/` into a temp package root beside a synthetic asset
 * tree (see `tests/fixtures/opencode-v1-goldens/assets.ts`), links the repo's
 * `node_modules`, and imports that copy. The unchanged plugin code therefore
 * runs end to end over fixture assets, and routine edits to the real bundled
 * skills do not churn the goldens.
 *
 * Comparison rules:
 * - Goldens are committed JSON. Comparison canonicalizes whitespace only
 *   (`JSON.stringify(JSON.parse(x))`), so key order and every value is pinned
 *   while the files stay formatter-friendly.
 * - Temp paths are scrubbed to `<TMP>`.
 * - The top-level `agent` and `command` maps are key-sorted before capture
 *   because their insertion order follows `readdir` order, which differs per
 *   filesystem. Everything nested keeps its real order (permission rule order
 *   is part of the contract).
 *
 * Regeneration is an explicit opt-in: set `OPENCODE_V1_GOLDENS_UPDATE=1`
 * (refused when `CI` is set), then run `bunx biome format --write
 * tests/fixtures/opencode-v1-goldens`. Goldens come from the pre-refactor code
 * and must not be regenerated to make a refactor pass.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRecord } from '../../src/lib/validation.js'
import {
  GOLDEN_ASSET_FILES,
  GOLDEN_DISCOVERED_SKILL_FILES,
} from '../fixtures/opencode-v1-goldens/assets.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const GOLDEN_DIR = path.join(
  REPO_ROOT,
  'tests/fixtures/opencode-v1-goldens/expected',
)
const UPDATE_ENV = 'OPENCODE_V1_GOLDENS_UPDATE'

const tempDirs = createTempDirTracker()

// --- Plugin surface (structural, so the test survives an export-shape change) --

interface ZodLike {
  description?: string
  safeParse(value: unknown): { success: boolean }
}

interface ToolContextStub {
  sessionID: string
  callID: string
  ask: (request: unknown) => Promise<void>
  metadata: (update: unknown) => void
}

interface SkillToolShape {
  readonly description: string
  args: Record<string, ZodLike>
  execute(
    args: { name: string; arguments?: string },
    context: ToolContextStub,
  ): Promise<string>
}

interface PluginHooks {
  config: (config: Record<string, unknown>) => Promise<void>
  tool: { systematic_skill: SkillToolShape }
  'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
  'experimental.chat.messages.transform': (
    input: unknown,
    output: unknown,
  ) => Promise<void>
  'experimental.chat.system.transform': (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>
}

interface PluginInputStub {
  client: { app: { log: (entry: unknown) => Promise<void> } }
  directory: string
}

type PluginFactory = (input: PluginInputStub) => Promise<PluginHooks>

/**
 * Today the default export is the plugin function. After the export-shape change it is an object
 * whose `server` is that function. Accept both so the goldens run unchanged
 * through the same hooks on either side of the shape change.
 */
function resolvePluginFactory(entry: unknown): PluginFactory {
  if (typeof entry === 'function') return entry as PluginFactory
  if (isRecord(entry) && typeof entry.server === 'function') {
    const server = entry.server as PluginFactory
    return (input) => server.call(entry, input)
  }
  throw new Error('Plugin default export is neither a function nor {server}')
}

// --- Temp package root -------------------------------------------------------

interface Harness {
  tmpRoot: string
  pkgRoot: string
  homeDir: string
  factory: PluginFactory
}

let harness: Harness
let originalHomedir: typeof os.homedir
let originalConfigDirEnv: string | undefined
let originalProfileEnv: string | undefined

function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

beforeAll(async () => {
  originalHomedir = os.homedir
  originalConfigDirEnv = process.env.OPENCODE_CONFIG_DIR
  originalProfileEnv = process.env.SYSTEMATIC_PROFILE

  const tmpRoot = tempDirs.track(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-v1-golden-')),
  )
  const pkgRoot = path.join(tmpRoot, 'pkg')
  const homeDir = path.join(tmpRoot, 'home')
  fs.mkdirSync(homeDir, { recursive: true })

  // Copy the unchanged plugin source next to the synthetic assets.
  fs.cpSync(path.join(REPO_ROOT, 'src'), path.join(pkgRoot, 'src'), {
    recursive: true,
  })
  fs.symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(pkgRoot, 'node_modules'),
    'dir',
  )
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/systematic', version: '0.0.0-golden' }),
  )
  writeTree(pkgRoot, GOLDEN_ASSET_FILES)

  // Isolate from the developer's real home and OpenCode config.
  os.homedir = () => homeDir
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.SYSTEMATIC_PROFILE

  const entryUrl = pathToFileURL(path.join(pkgRoot, 'src/index.ts')).href
  const mod = (await import(entryUrl)) as { default: unknown }
  harness = {
    tmpRoot,
    pkgRoot,
    homeDir,
    factory: resolvePluginFactory(mod.default),
  }
})

afterAll(() => {
  os.homedir = originalHomedir
  restoreEnv('OPENCODE_CONFIG_DIR', originalConfigDirEnv)
  restoreEnv('SYSTEMATIC_PROFILE', originalProfileEnv)
  if (harness !== undefined) {
    // Remove the node_modules link itself so cleanup can never reach the repo.
    fs.rmSync(path.join(harness.pkgRoot, 'node_modules'), { force: true })
  }
  tempDirs.cleanup()
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// --- Scenario plumbing -------------------------------------------------------

interface Diagnostics {
  warn: string[]
  error: string[]
}

interface ScenarioSetup {
  /** Written as `systematic.json` in the custom (`OPENCODE_CONFIG_DIR`) config dir. */
  config?: Record<string, unknown>
  /** Written verbatim instead of `config`, for invalid-config scenarios. */
  rawConfig?: string
  /** Extra files under the scenario project directory. */
  projectFiles?: Readonly<Record<string, string>>
  /** Make `client.app.log` reject, to prove logging failures are swallowed. */
  logThrows?: boolean
  /** Overwrites `systematic.json` after the plugin starts and before the config hook runs. */
  rawConfigAfterStart?: string
}

interface ScenarioContext {
  project: string
  logs: unknown[]
  diagnostics: Diagnostics
  start(): Promise<PluginHooks>
  /** Applies `setup.rawConfigAfterStart`, if any. */
  applyConfigAfterStart(): void
}

function stringifyArgs(args: unknown[]): string {
  return args.map((arg) => String(arg)).join(' ')
}

async function withScenario<T>(
  name: string,
  setup: ScenarioSetup,
  run: (context: ScenarioContext) => Promise<T>,
): Promise<T> {
  const project = path.join(harness.tmpRoot, 'projects', name)
  const customDir = path.join(harness.tmpRoot, 'custom', name)
  fs.mkdirSync(project, { recursive: true })
  writeTree(project, GOLDEN_DISCOVERED_SKILL_FILES)
  writeTree(project, setup.projectFiles ?? {})
  if (setup.rawConfig !== undefined || setup.config !== undefined) {
    fs.mkdirSync(customDir, { recursive: true })
    fs.writeFileSync(
      path.join(customDir, 'systematic.json'),
      setup.rawConfig ?? JSON.stringify(setup.config),
    )
    process.env.OPENCODE_CONFIG_DIR = customDir
  }

  const diagnostics: Diagnostics = { warn: [], error: [] }
  const warnSpy = spyOn(console, 'warn').mockImplementation(
    (...args: unknown[]) => {
      diagnostics.warn.push(stringifyArgs(args))
    },
  )
  const errorSpy = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      diagnostics.error.push(stringifyArgs(args))
    },
  )

  const logs: unknown[] = []
  try {
    return await run({
      project,
      logs,
      diagnostics,
      applyConfigAfterStart: () => {
        if (setup.rawConfigAfterStart === undefined) return
        fs.mkdirSync(customDir, { recursive: true })
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          setup.rawConfigAfterStart,
        )
        process.env.OPENCODE_CONFIG_DIR = customDir
      },
      start: () =>
        harness.factory({
          client: {
            app: {
              log: async (entry: unknown) => {
                logs.push(entry)
                if (setup.logThrows) throw new Error('log sink offline')
              },
            },
          },
          directory: project,
        }),
    })
  } finally {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    delete process.env.OPENCODE_CONFIG_DIR
  }
}

// --- Scrubbing, canonicalization and golden I/O -------------------------------

function scrubString(value: string): string {
  return value.split(harness.tmpRoot).join('<TMP>')
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map((item) => scrub(item))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrub(item)]),
    )
  }
  return value
}

function sortedKeyCopy(map: unknown): unknown {
  if (!isRecord(map)) return map
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((key) => [key, map[key]]),
  )
}

/** Sort only the readdir-ordered top-level maps; keep every nested order. */
function canonicalizeConfig(config: Record<string, unknown>): unknown {
  return {
    ...config,
    ...(config.agent !== undefined && { agent: sortedKeyCopy(config.agent) }),
    ...(config.command !== undefined && {
      command: sortedKeyCopy(config.command),
    }),
  }
}

function canonicalJson(text: string): string {
  return JSON.stringify(JSON.parse(text))
}

function expectGolden(relativePath: string, actual: unknown): void {
  const text = `${JSON.stringify(scrub(actual), null, 2)}\n`
  const file = path.join(GOLDEN_DIR, relativePath)

  if (process.env[UPDATE_ENV] === '1') {
    if (process.env.CI) {
      throw new Error(`${UPDATE_ENV} is refused when CI is set.`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return
  }

  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing golden ${relativePath}. Goldens are committed; regenerate only with ${UPDATE_ENV}=1 from pre-refactor code.`,
    )
  }
  expect(canonicalJson(text)).toBe(canonicalJson(fs.readFileSync(file, 'utf8')))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- Config hook goldens ------------------------------------------------------

function pick<T extends { name: string }>(list: readonly T[], name: string): T {
  const found = list.find((item) => item.name === name)
  if (found === undefined) throw new Error(`Unknown case: ${name}`)
  return found
}

interface ConfigScenario {
  name: string
  setup: ScenarioSetup
}

const INCOMING_CONFIG = (): Record<string, unknown> => ({
  agent: {
    // A user-native agent: wins over the bundled agent of the same name.
    'security-reviewer': { description: 'User native agent', prompt: 'native' },
    // A prior Systematic emission: refreshed, not preserved.
    'repo-research-analyst': {
      description: 'Stale (Fixture-Planner - Systematic)',
      prompt: 'stale planner',
    },
  },
  command: {
    'native-command': { description: 'Native command', template: 'native' },
    'systematic:fixture-alpha': {
      description: '(Systematic) stale alpha',
      template: 'stale',
    },
  },
  skills: {
    paths: [
      '/fixture-user/.config/opencode/systematic/skills',
      '/fixture-user/own/skills',
    ],
  },
})

const CONFIG_SCENARIOS: readonly ConfigScenario[] = [
  { name: 'none', setup: {} },
  {
    name: 'category-permission',
    setup: {
      config: {
        categories: {
          review: {
            permission: {
              bash: 'ask',
              edit: { '*': 'deny', 'src/**': 'allow' },
            },
          },
        },
      },
    },
  },
  {
    name: 'exact-skills',
    setup: {
      config: {
        categories: { review: { skills: ['fixture-alpha', 'fixture-beta'] } },
        agents: {
          'correctness-reviewer': { skills: ['fixture-beta'] },
          'repo-research-analyst': { skills: [] },
        },
      },
    },
  },
  {
    name: 'integer-skills',
    setup: {
      config: {
        agents: {
          'correctness-reviewer': { skills: ['10', 'fixture-alpha', '2'] },
        },
      },
    },
  },
  {
    name: 'disabled',
    setup: {
      config: {
        disabled_skills: ['git-worktree'],
        disabled_agents: ['adversarial-reviewer'],
        disabled_commands: ['fixture-command'],
      },
    },
  },
  {
    name: 'skills-as-commands-off',
    setup: { config: { skills_as_commands: false } },
  },
  {
    name: 'invalid-config-schema',
    setup: { rawConfig: '{ "disabled_skills": "not-an-array" }' },
  },
  {
    name: 'invalid-config-syntax',
    setup: { rawConfig: '{ this is not json' },
  },
  {
    // Valid at plugin start, broken before the config hook (which re-reads).
    name: 'invalid-config-after-start',
    setup: {
      config: { disabled_skills: ['git-worktree'] },
      rawConfigAfterStart: '{ "disabled_skills": "not-an-array" }',
    },
  },
]

async function captureConfigScenario(
  scenario: ConfigScenario,
): Promise<Record<string, unknown>> {
  return withScenario(
    `config-${scenario.name}`,
    scenario.setup,
    async (context) => {
      let hooks: PluginHooks
      try {
        hooks = await context.start()
      } catch (error) {
        return {
          scenario: scenario.name,
          systematicConfig: scenario.setup.config ?? scenario.setup.rawConfig,
          outcome: { startThrew: errorMessage(error) },
          diagnostics: context.diagnostics,
        }
      }

      context.applyConfigAfterStart()
      const config = INCOMING_CONFIG()
      let outcome: unknown = 'ok'
      try {
        await hooks.config(config)
      } catch (error) {
        outcome = { hookThrew: errorMessage(error) }
      }
      const first = JSON.stringify(canonicalizeConfig(config))

      // Repeating the hook on the same object must not change the bytes.
      let repeat: unknown
      try {
        await hooks.config(config)
        repeat =
          JSON.stringify(canonicalizeConfig(config)) === first
            ? 'identical'
            : 'changed'
      } catch (error) {
        repeat = { hookThrew: errorMessage(error) }
      }

      return {
        scenario: scenario.name,
        systematicConfig: scenario.setup.config ?? scenario.setup.rawConfig,
        outcome,
        repeat,
        config: canonicalizeConfig(config),
        diagnostics: context.diagnostics,
      }
    },
  )
}

function permissionOf(
  captured: Record<string, unknown>,
  agent: string,
  tool: string,
): Record<string, unknown> | undefined {
  const config = captured.config
  if (!isRecord(config) || !isRecord(config.agent)) return undefined
  const entry = config.agent[agent]
  if (!isRecord(entry) || !isRecord(entry.permission)) return undefined
  const rules = entry.permission[tool]
  return isRecord(rules) ? rules : undefined
}

describe('opencode v1 goldens: config hook', () => {
  for (const scenario of CONFIG_SCENARIOS) {
    test(`config hook output matches golden: ${scenario.name}`, async () => {
      const captured = await captureConfigScenario(scenario)
      expectGolden(`config-hook/${scenario.name}.json`, captured)
    })
  }

  test('managed skills list is deny * first, then one allow per skill, in order', async () => {
    const captured = await captureConfigScenario({
      name: 'managed-order-probe',
      setup: {
        config: {
          agents: {
            'correctness-reviewer': {
              skills: ['fixture-beta', 'fixture-alpha'],
            },
          },
        },
      },
    })
    const rules = permissionOf(captured, 'correctness-reviewer', 'skill')
    expect(rules).toBeDefined()
    expect(Object.entries(rules ?? {})).toEqual([
      ['*', 'deny'],
      ['fixture-beta', 'allow'],
      ['fixture-alpha', 'allow'],
    ])
  })

  test('exact skills overlay re-appends * after category allows, so category-only allows precede the final deny', async () => {
    const captured = await captureConfigScenario(
      pick(CONFIG_SCENARIOS, 'exact-skills'),
    )
    expect(
      Object.entries(
        permissionOf(captured, 'correctness-reviewer', 'skill') ?? {},
      ),
    ).toEqual([
      ['fixture-alpha', 'allow'],
      ['*', 'deny'],
      ['fixture-beta', 'allow'],
    ])
    // An explicitly empty managed list is deny-all with no allows.
    expect(
      Object.entries(
        permissionOf(captured, 'repo-research-analyst', 'skill') ?? {},
      ),
    ).toEqual([['*', 'deny']])
  })

  test('integer-like skill names are hoisted ahead of * by the v1 object map (ordered-list hazard)', async () => {
    // Characterization, not endorsement: JS objects enumerate integer-like keys
    // first in ascending numeric order, so today's v1 map lists '2' and '10'
    // before '*'. Under last-match-wins that places the deny after the allows.
    // The shared ordered rule list must fold into exactly this map for v1.
    const captured = await captureConfigScenario(
      pick(CONFIG_SCENARIOS, 'integer-skills'),
    )
    expect(
      Object.entries(
        permissionOf(captured, 'correctness-reviewer', 'skill') ?? {},
      ),
    ).toEqual([
      ['2', 'allow'],
      ['10', 'allow'],
      ['*', 'deny'],
      ['fixture-alpha', 'allow'],
    ])
  })

  test('disabled skill, agent and command are absent from the emitted config', async () => {
    const captured = await captureConfigScenario(
      pick(CONFIG_SCENARIOS, 'disabled'),
    )
    const config = captured.config
    expect(isRecord(config)).toBe(true)
    const record = config as Record<string, Record<string, unknown>>
    expect(record.command).not.toHaveProperty('systematic:git-worktree')
    expect(record.command).not.toHaveProperty('systematic:fixture-command')
    expect(record.agent).not.toHaveProperty('adversarial-reviewer')
    expect(record.command).toHaveProperty('systematic:fixture-alpha')
  })

  test('skills_as_commands=false drops discovered skills but keeps bundled skill commands', async () => {
    const baseline = await captureConfigScenario(pick(CONFIG_SCENARIOS, 'none'))
    const off = await captureConfigScenario(
      pick(CONFIG_SCENARIOS, 'skills-as-commands-off'),
    )
    const commandsOf = (value: Record<string, unknown>) =>
      Object.keys((value.config as { command: object }).command)
    expect(commandsOf(baseline)).toContain('fixture-discovered')
    expect(commandsOf(off)).not.toContain('fixture-discovered')
    expect(commandsOf(off)).toContain('systematic:fixture-alpha')
  })

  test('invalid systematic.json is NOT fail-open today: start throws, and a later config hook rejects', async () => {
    // Characterization of current behavior, which differs from the plan's
    // "fail-open" wording: `loadConfig` throws on invalid sources both at
    // plugin start and inside the config hook, and nothing catches it.
    for (const name of ['invalid-config-schema', 'invalid-config-syntax']) {
      const captured = await captureConfigScenario(pick(CONFIG_SCENARIOS, name))
      expect(captured.outcome).toEqual({
        startThrew: expect.stringContaining('Invalid Systematic config in'),
      })
      expect(captured).not.toHaveProperty('config')
    }

    const afterStart = await captureConfigScenario(
      pick(CONFIG_SCENARIOS, 'invalid-config-after-start'),
    )
    expect(afterStart.outcome).toEqual({
      hookThrew: expect.stringContaining('Invalid Systematic config in'),
    })
    expect(afterStart.repeat).toEqual({
      hookThrew: expect.stringContaining('Invalid Systematic config in'),
    })
  })
})

// --- Tool descriptor and execution goldens -------------------------------------

function describeZod(schema: ZodLike): Record<string, unknown> {
  return {
    description: schema.description,
    acceptsString: schema.safeParse('text').success,
    acceptsUndefined: schema.safeParse(undefined).success,
    acceptsNumber: schema.safeParse(1).success,
  }
}

function describeTool(tool: SkillToolShape): Record<string, unknown> {
  return {
    description: tool.description,
    argNames: Object.keys(tool.args),
    args: Object.fromEntries(
      Object.entries(tool.args).map(([key, schema]) => [
        key,
        describeZod(schema),
      ]),
    ),
  }
}

interface ExecuteRecord {
  request: { name: string; arguments?: string }
  output?: string
  threw?: string
  ask: unknown[]
  metadata: unknown[]
}

async function executeTool(
  hooks: PluginHooks,
  request: { name: string; arguments?: string },
  ids: { sessionID: string; callID: string },
): Promise<ExecuteRecord> {
  const ask: unknown[] = []
  const metadata: unknown[] = []
  const record: ExecuteRecord = { request, ask, metadata }
  try {
    record.output = await hooks.tool.systematic_skill.execute(request, {
      ...ids,
      ask: async (value) => {
        ask.push(value)
      },
      metadata: (value) => {
        metadata.push(value)
      },
    })
  } catch (error) {
    record.threw = errorMessage(error)
  }
  return record
}

describe('opencode v1 goldens: registered hooks and systematic_skill', () => {
  test('registers exactly the five v1 hooks, with systematic_skill as the only tool', async () => {
    await withScenario('hooks-inventory', {}, async (context) => {
      const hooks = await context.start()
      expectGolden('hooks.json', {
        hookKeys: Object.keys(hooks),
        toolKeys: Object.keys(hooks.tool),
      })
    })
  })

  test('descriptor matches golden: default tree', async () => {
    await withScenario('tool-default', {}, async (context) => {
      const hooks = await context.start()
      const descriptor = describeTool(hooks.tool.systematic_skill)
      expectGolden('tool/descriptor-default.json', descriptor)

      // Catalog filtering rules: manual-only skills are hidden from the model,
      // tool-only skills are listed, and the namespaced name is kept verbatim.
      const description = String(descriptor.description)
      expect(description).toContain('- systematic:fixture-hidden:')
      expect(description).not.toContain('fixture-manual')
      expect(description).toContain('- ns:fixture-gamma:')
      expect(description).toContain('- systematic:git-worktree:')
    })
  })

  test('descriptor matches golden and omits the skill: git-worktree disabled', async () => {
    await withScenario(
      'tool-disabled',
      { config: { disabled_skills: ['git-worktree'] } },
      async (context) => {
        const hooks = await context.start()
        const descriptor = describeTool(hooks.tool.systematic_skill)
        expectGolden('tool/descriptor-git-worktree-disabled.json', descriptor)
        expect(String(descriptor.description)).not.toContain('git-worktree')
      },
    )
  })

  test('execute matches golden for loads, argument substitution and refusals', async () => {
    await withScenario(
      'tool-execute',
      { config: { disabled_skills: ['git-worktree'] } },
      async (context) => {
        const hooks = await context.start()
        const cases: { name: string; arguments?: string }[] = [
          { name: 'fixture-alpha' },
          { name: 'systematic:fixture-alpha' },
          { name: 'ns:fixture-gamma' },
          { name: 'fixture-args' },
          { name: 'fixture-args', arguments: 'one "two words" three' },
          { name: 'fixture-args', arguments: '' },
          { name: 'git-worktree' },
          { name: 'does-not-exist' },
        ]
        const records: ExecuteRecord[] = []
        for (const [index, request] of cases.entries()) {
          records.push(
            await executeTool(hooks, request, {
              sessionID: 'ses_golden',
              callID: `call_${index}`,
            }),
          )
        }
        expectGolden('tool/execute.json', records)

        // Disabled skills are refused with the not-found error and are never
        // offered a permission prompt.
        const disabled = records[6]
        expect(disabled?.threw).toContain('Skill "git-worktree" not found')
        expect(disabled?.ask).toEqual([])
        expect(records[0]?.ask).toEqual([
          {
            permission: 'skill',
            patterns: ['systematic:fixture-alpha'],
            always: ['systematic:fixture-alpha'],
            metadata: {},
          },
        ])
      },
    )
  })
})

// --- System transform goldens ---------------------------------------------------

const TITLE_GENERATOR_SYSTEM =
  'You are a title generator. Output a short title.'

interface SystemCase {
  name: string
  setup: ScenarioSetup
  /** Calls to make, each against a fresh `system` array unless `reuse` is set. */
  systems: string[][]
  /** Re-run the transform on the same output array (idempotency). */
  repeat?: boolean
}

const STALE_BLOCK =
  '<SYSTEMATIC_WORKFLOWS>\nOLD CONTENT\n</SYSTEMATIC_WORKFLOWS>'

const SYSTEM_CASES: readonly SystemCase[] = [
  { name: 'default', setup: {}, systems: [['Base system prompt']] },
  { name: 'empty-system', setup: {}, systems: [[]] },
  {
    name: 'repeat-is-idempotent',
    setup: {},
    systems: [['Base system prompt']],
    repeat: true,
  },
  {
    name: 'stale-blocks-removed-and-reinjected-into-first-entry',
    setup: {},
    systems: [['First', `Second\n\n${STALE_BLOCK}\n\ntail`, STALE_BLOCK]],
  },
  {
    name: 'internal-agent-skipped',
    setup: {},
    systems: [[TITLE_GENERATOR_SYSTEM]],
  },
  {
    name: 'git-worktree-disabled-omits-worktree-rule',
    setup: { config: { disabled_skills: ['git-worktree'] } },
    systems: [['Base system prompt']],
  },
  {
    name: 'bootstrap-disabled',
    setup: { config: { bootstrap: { enabled: false } } },
    systems: [['Base system prompt']],
  },
  {
    name: 'custom-bootstrap-file',
    setup: {
      config: { bootstrap: { enabled: true, file: '<PROJECT>/boot.md' } },
      projectFiles: { 'boot.md': 'CUSTOM BOOTSTRAP FILE CONTENT' },
    },
    systems: [['Base system prompt']],
  },
  {
    name: 'log-failure-is-swallowed',
    setup: { logThrows: true },
    systems: [['Base system prompt']],
  },
  {
    name: 'init-log-once-across-requests',
    setup: {},
    systems: [['one'], [TITLE_GENERATOR_SYSTEM], ['two']],
  },
]

async function captureSystemCase(
  systemCase: SystemCase,
): Promise<Record<string, unknown>> {
  const caseName = `system-${systemCase.name}`
  const project = path.join(harness.tmpRoot, 'projects', caseName)
  // The custom bootstrap file path must exist before the config is written.
  const setup: ScenarioSetup = { ...systemCase.setup }
  if (setup.config !== undefined) {
    setup.config = JSON.parse(
      JSON.stringify(setup.config).replaceAll('<PROJECT>', project),
    ) as Record<string, unknown>
  }
  return withScenario(caseName, setup, async (context) => {
    const hooks = await context.start()
    const results: unknown[] = []
    for (const system of systemCase.systems) {
      const output = { system: [...system] }
      const before = [...output.system]
      await hooks['experimental.chat.system.transform']({}, output)
      if (systemCase.repeat) {
        await hooks['experimental.chat.system.transform']({}, output)
      }
      results.push({ before, after: output.system })
    }
    return {
      case: systemCase.name,
      results,
      logs: context.logs,
      diagnostics: context.diagnostics,
    }
  })
}

describe('opencode v1 goldens: system transform', () => {
  for (const systemCase of SYSTEM_CASES) {
    test(`system transform matches golden: ${systemCase.name}`, async () => {
      expectGolden(
        `system-transform/${systemCase.name}.json`,
        await captureSystemCase(systemCase),
      )
    })
  }

  test('bootstrap carries the worktree rule by default and drops it when git-worktree is disabled', async () => {
    const enabled = await captureSystemCase(pick(SYSTEM_CASES, 'default'))
    const disabled = await captureSystemCase(
      pick(SYSTEM_CASES, 'git-worktree-disabled-omits-worktree-rule'),
    )
    const textOf = (captured: Record<string, unknown>): string =>
      JSON.stringify(captured.results)
    expect(textOf(enabled)).toContain('FIXTURE-WORKTREE-RULE-MARKER')
    expect(textOf(enabled)).toContain('FIXTURE-OPENCODE-PROFILE-MARKER')
    expect(textOf(disabled)).not.toContain('FIXTURE-WORKTREE-RULE-MARKER')
    expect(textOf(disabled)).toContain('FIXTURE-OPENCODE-PROFILE-MARKER')
  })

  test('exactly one bootstrap block lands in system[0] and the internal-agent request is untouched', async () => {
    const repeated = await captureSystemCase(
      pick(SYSTEM_CASES, 'repeat-is-idempotent'),
    )
    const [first] = repeated.results as { after: string[] }[]
    expect(first?.after).toHaveLength(1)
    expect(first?.after[0]?.match(/<SYSTEMATIC_WORKFLOWS>/g)).toHaveLength(1)

    const internal = await captureSystemCase(
      pick(SYSTEM_CASES, 'internal-agent-skipped'),
    )
    const [skipped] = internal.results as {
      before: string[]
      after: string[]
    }[]
    expect(skipped?.after).toEqual(skipped?.before)
  })
})

// --- Restore goldens ------------------------------------------------------------

function truncationMarker(kind: 'lines' | 'bytes'): string {
  return `\n\n...12 ${kind} truncated...\n\n`
}

interface RestoreCase {
  name: string
  /** Mutates the host-truncated payload before the hook runs. */
  input: { tool: string; sessionID?: string; callID?: string }
  build: (full: string) => { output: string; metadata: Record<string, unknown> }
  /** Run the config hook with a user tool_output limit before the call. */
  userLimit?: boolean
  /** Call the hook this many times with the same ids (default 1). */
  calls?: number
}

const SKILL_IDS = { sessionID: 'ses_restore', callID: 'call_restore' }

/**
 * The host's preview is a prefix of the full output. Cut at a fixed anchor, not
 * a byte count, so the preview never ends inside a machine-specific temp path.
 */
function previewOf(full: string): string {
  const anchor = '# Fixture Alpha'
  const end = full.indexOf(anchor)
  if (end === -1) throw new Error('Expected the fixture-alpha body anchor')
  return full.slice(0, end + anchor.length)
}

function truncated(
  full: string,
  kind: 'lines' | 'bytes' = 'lines',
): { output: string; metadata: Record<string, unknown> } {
  return {
    output: `${previewOf(full)}${truncationMarker(kind)}HOST-TAIL`,
    metadata: { truncated: true, outputPath: '/host/spill/output.txt' },
  }
}

const RESTORE_CASES: readonly RestoreCase[] = [
  {
    name: 'truncated-lines-restored',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => truncated(full, 'lines'),
  },
  {
    name: 'truncated-bytes-restored',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => truncated(full, 'bytes'),
  },
  {
    name: 'second-call-finds-store-consumed',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => truncated(full),
    calls: 2,
  },
  {
    name: 'user-output-limit-set-leaves-truncation',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => truncated(full),
    userLimit: true,
  },
  {
    name: 'preview-mismatch-left-alone',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => ({
      ...truncated(full),
      output: `NOT-A-PREFIX${truncationMarker('lines')}HOST-TAIL`,
    }),
  },
  {
    name: 'metadata-not-truncated-left-alone',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => ({
      output: full,
      metadata: { truncated: false },
    }),
  },
  {
    name: 'no-marker-left-alone',
    input: { tool: 'systematic_skill', ...SKILL_IDS },
    build: (full) => ({
      output: previewOf(full),
      metadata: { truncated: true },
    }),
  },
  {
    name: 'other-tool-left-alone',
    input: { tool: 'bash', ...SKILL_IDS },
    build: (full) => truncated(full),
  },
  {
    name: 'missing-call-id-left-alone',
    input: { tool: 'systematic_skill', sessionID: 'ses_restore' },
    build: (full) => truncated(full),
  },
  {
    name: 'different-call-id-left-alone',
    input: {
      tool: 'systematic_skill',
      sessionID: 'ses_restore',
      callID: 'call_other',
    },
    build: (full) => truncated(full),
  },
]

async function captureRestoreCase(
  restoreCase: RestoreCase,
): Promise<Record<string, unknown>> {
  return withScenario(`restore-${restoreCase.name}`, {}, async (context) => {
    const hooks = await context.start()
    if (restoreCase.userLimit) {
      await hooks.config({ tool_output: { max_lines: 50 } })
    }
    const execution = await executeTool(
      hooks,
      { name: 'fixture-alpha' },
      SKILL_IDS,
    )
    const full = execution.output ?? ''
    const output = restoreCase.build(full)
    const before = structuredClone(output)

    const calls: unknown[] = []
    for (let index = 0; index < (restoreCase.calls ?? 1); index++) {
      await hooks['tool.execute.after'](restoreCase.input, output)
      calls.push(structuredClone(output))
    }

    return {
      case: restoreCase.name,
      input: restoreCase.input,
      fullSkillOutput: full,
      before,
      afterEachCall: calls,
    }
  })
}

describe('opencode v1 goldens: restore of truncated skill output (tool.execute.after)', () => {
  for (const restoreCase of RESTORE_CASES) {
    test(`after-hook matches golden: ${restoreCase.name}`, async () => {
      expectGolden(
        `restore/after-hook-${restoreCase.name}.json`,
        await captureRestoreCase(restoreCase),
      )
    })
  }

  test('a truncated skill payload is restored in place to the full body and its spill path is dropped', async () => {
    const captured = (await captureRestoreCase(
      pick(RESTORE_CASES, 'truncated-lines-restored'),
    )) as {
      fullSkillOutput: string
      afterEachCall: { output: string; metadata: Record<string, unknown> }[]
    }
    const [after] = captured.afterEachCall
    expect(after?.output).toBe(captured.fullSkillOutput)
    expect(after?.metadata).toEqual({ truncated: false })
  })

  test('the stored body is consumed by the first matching call, restored or not', async () => {
    const captured = (await captureRestoreCase(
      pick(RESTORE_CASES, 'second-call-finds-store-consumed'),
    )) as {
      fullSkillOutput: string
      afterEachCall: { output: string; metadata: Record<string, unknown> }[]
    }
    const [first, second] = captured.afterEachCall
    expect(first?.output).toBe(captured.fullSkillOutput)
    // The second call sees an already-restored payload and changes nothing.
    expect(second).toEqual(first)

    const limited = (await captureRestoreCase(
      pick(RESTORE_CASES, 'user-output-limit-set-leaves-truncation'),
    )) as {
      before: { output: string }
      afterEachCall: { output: string; metadata: Record<string, unknown> }[]
    }
    expect(limited.afterEachCall[0]?.output).toBe(limited.before.output)
    expect(limited.afterEachCall[0]?.metadata.truncated).toBe(true)
  })
})

// --- Pruned (compacted) payload goldens ------------------------------------------

function skillPart(time: Record<string, unknown>, status = 'completed') {
  return {
    type: 'tool',
    tool: 'systematic_skill',
    state: { status, time },
  }
}

interface PruneCase {
  name: string
  messages: () => unknown
}

const PRUNE_CASES: readonly PruneCase[] = [
  {
    name: 'compacted-skill-result-cleared',
    messages: () => ({
      messages: [
        {
          info: { role: 'assistant' },
          parts: [
            skillPart({ start: 1, end: 2, compacted: 3 }),
            { type: 'text', text: 'untouched text' },
          ],
        },
      ],
    }),
  },
  {
    name: 'only-completed-skill-parts-change',
    messages: () => ({
      messages: [
        {
          parts: [
            skillPart({ start: 1, end: 2, compacted: 3 }, 'running'),
            skillPart({ start: 1, end: 2, compacted: 3 }, 'error'),
            {
              type: 'tool',
              tool: 'bash',
              state: {
                status: 'completed',
                time: { start: 1, end: 2, compacted: 3 },
              },
            },
            skillPart({ start: 1, end: 2 }),
            skillPart({ start: 1, end: 2, compacted: 0 }),
            skillPart({ start: 1, end: 2, compacted: 9 }),
          ],
        },
      ],
    }),
  },
  {
    name: 'malformed-input-is-ignored',
    messages: () => ({
      messages: [
        null,
        'text',
        { parts: 'not-an-array' },
        { parts: [null, 7, { type: 'tool', tool: 'systematic_skill' }] },
        {
          parts: [
            {
              type: 'tool',
              tool: 'systematic_skill',
              state: { status: 'completed', time: [1, 2] },
            },
          ],
        },
      ],
    }),
  },
]

describe('opencode v1 goldens: restore of pruned skill output (messages.transform)', () => {
  for (const pruneCase of PRUNE_CASES) {
    test(`messages transform matches golden: ${pruneCase.name}`, async () => {
      await withScenario(`prune-${pruneCase.name}`, {}, async (context) => {
        const hooks = await context.start()
        const output = pruneCase.messages()
        const before = structuredClone(output)
        await hooks['experimental.chat.messages.transform']({}, output)
        expectGolden(`restore/messages-transform-${pruneCase.name}.json`, {
          case: pruneCase.name,
          before,
          after: output,
        })
      })
    })
  }

  test('non-record and message-less inputs never throw', async () => {
    await withScenario('prune-no-throw', {}, async (context) => {
      const hooks = await context.start()
      for (const value of [undefined, null, 'x', 5, {}, { messages: 'no' }]) {
        await hooks['experimental.chat.messages.transform']({}, value)
      }
    })
  })

  test('the compacted flag is cleared in place and sibling time fields survive', async () => {
    await withScenario('prune-in-place', {}, async (context) => {
      const hooks = await context.start()
      const part = skillPart({ start: 1, end: 2, compacted: 3 })
      const output = { messages: [{ parts: [part] }] }
      await hooks['experimental.chat.messages.transform']({}, output)
      expect(output.messages[0]?.parts[0]).toBe(part)
      expect(part.state.time).toEqual({ start: 1, end: 2 })
    })
  })
})

// --- Golden hygiene ------------------------------------------------------------

describe('opencode v1 goldens: hygiene', () => {
  test('every golden is committed JSON with no machine-specific paths', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(GOLDEN_DIR)

    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(file.endsWith('.json')).toBe(true)
      const text = fs.readFileSync(file, 'utf8')
      expect(() => JSON.parse(text)).not.toThrow()
      expect(text).not.toMatch(
        /\/Users\/|\/home\/[a-z]|\/private\/var|\/var\/folders|\/tmp\//u,
      )
    }
  })

  test('tests never write to the committed goldens unless the explicit update flag is set', () => {
    // The only writer is expectGolden, gated on the opt-in flag and refused in CI.
    expect(process.env[UPDATE_ENV]).not.toBe('1')
  })
})
