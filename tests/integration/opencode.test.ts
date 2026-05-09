import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config, PluginInput } from '@opencode-ai/plugin'
import SystematicPlugin from '../../src/index.ts'
import { _resetPluginSingleton } from '../../src/lib/plugin-singleton.ts'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 90_000
const MAX_RETRIES = 1
const RETRY_DELAY_MS = 3_000
const OPENCODE_TEST_MODEL = 'opencode/big-pickle'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

type AgentConfig = NonNullable<Config['agent']>[string]

function skillPermission(agent: AgentConfig | undefined): unknown {
  return (agent?.permission as { skill?: unknown } | undefined)?.skill
}

interface OpencodeResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface RunOpencodeOptions {
  cwd: string
  configContent?: string
}

function buildOpencodeConfig(): string {
  const pluginPath = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({
    plugin: [pluginPath],
  })
}

async function runOpencode(
  prompt: string,
  options: RunOpencodeOptions,
): Promise<OpencodeResult> {
  let lastResult: { stdout: string; stderr: string; exitCode: number } = {
    stdout: '',
    stderr: '',
    exitCode: -1,
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const env = {
      ...process.env,
      ...(options.configContent
        ? { OPENCODE_CONFIG_CONTENT: options.configContent }
        : {}),
    }
    const args = ['opencode', 'run', '--model', OPENCODE_TEST_MODEL, prompt]
    const result = Bun.spawnSync(args, {
      cwd: options.cwd,
      env,
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

function expectSetupSkillLoaded(result: OpencodeResult): void {
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toMatch(/systematic_skill/)
  expect(result.stderr).toMatch(/setup/)
  expect(result.stdout).toMatch(/ce:review/i)
}

describe('SystematicPlugin config hook integration', () => {
  let tempDir: string
  let projectDir: string

  beforeEach(() => {
    _resetPluginSingleton()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-plugin-'))
    projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    _resetPluginSingleton()
    delete process.env.OPENCODE_CONFIG_DIR
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
    const hooks = await SystematicPlugin({
      directory: projectDir,
      client: {
        app: {
          log: async () => {},
        },
      },
    } as unknown as PluginInput)

    expect(hooks.config).toBeDefined()
    await hooks.config?.(config)
  }

  test('exact overlay emits a tuned bundled agent', async () => {
    writeSystematicConfig({
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

  test('no user model config leaves emitted bundled agents without default models', async () => {
    const config: Config = {}
    await runConfigHook(config)

    const modeledAgents = Object.entries(config.agent ?? {}).filter(
      ([, agent]) => agent?.model !== undefined,
    )

    expect(modeledAgents).toEqual([])
    expect(config.agent?.['correctness-reviewer']?.temperature).toBeDefined()
  })

  test('well-shaped nonexistent explicit model passes validation and emits unchanged', async () => {
    writeSystematicConfig({
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
})

describe.skipIf(!OPENCODE_AVAILABLE)('opencode integration', () => {
  let testEnv: {
    tempDir: string
    projectDir: string
    originalCwd: string
  }

  beforeEach(() => {
    const tempBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-opencode-'),
    )

    testEnv = {
      tempDir: tempBase,
      projectDir: path.join(tempBase, 'project'),
      originalCwd: process.cwd(),
    }

    fs.mkdirSync(testEnv.projectDir, { recursive: true })
  })

  afterEach(() => {
    process.chdir(testEnv.originalCwd)
    if (testEnv.tempDir) {
      fs.rmSync(testEnv.tempDir, { recursive: true, force: true })
    }
  })

  test(
    'systematic_skill tool loads systematic skill with prefix',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load systematic:setup',
        {
          cwd: testEnv.projectDir,
          configContent: buildOpencodeConfig(),
        },
      )

      expectSetupSkillLoaded(result)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'systematic_skill tool loads systematic skill without prefix',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load setup',
        {
          cwd: testEnv.projectDir,
          configContent: buildOpencodeConfig(),
        },
      )

      expectSetupSkillLoaded(result)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )
})
