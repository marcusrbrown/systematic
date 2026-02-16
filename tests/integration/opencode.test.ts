import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/sdk'
import { createConfigHandler } from '../../src/lib/config-handler.ts'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 120_000
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 3_000
const OPENCODE_TEST_MODEL = 'opencode/big-pickle'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

interface PrecheckSummary {
  hashChanges: string[]
  newUpstream: string[]
  deletions: string[]
  skipped: string[]
  converterVersionChanged: boolean
}

interface OpencodeResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface PrecheckResult {
  exitCode: number
  summary?: PrecheckSummary
  raw: string
}

interface RunSyncWorkflowParams {
  summary: PrecheckSummary
  exitCode: number
  scope: string
  dryRun: boolean
  cwd: string
}

interface RunSyncWorkflowResult {
  ran: boolean
  result?: OpencodeResult
  prompt: string
}

function buildOpencodeConfig(): string {
  const pluginPath = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({
    plugin: [pluginPath],
  })
}

function buildSyncPrompt(
  summary: PrecheckSummary,
  scope: string,
  dryRun: boolean,
): string {
  return `You are Fro Bot running in CEP sync mode.
- Use the pre-check summary provided below. Do not rerun the pre-check.
- Run /sync-cep with the provided scope and dry-run flag.
- Always update or create a tracking issue labeled "sync-cep".

Pre-check summary (JSON, compact): ${JSON.stringify(summary)}

Scope: ${scope}
Dry run: ${dryRun}`
}

function shouldRunSync(exitCode: number): boolean {
  return exitCode === 1
}

function runPrecheckScript(): PrecheckResult {
  const result = Bun.spawnSync(['bun', 'scripts/check-cep-upstream.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
    },
  })

  const stdout = result.stdout.toString()
  const exitCode = result.exitCode ?? -1
  let summary: PrecheckSummary | undefined

  try {
    const parsed = JSON.parse(stdout)
    if (parsed && typeof parsed === 'object') {
      summary = parsed as PrecheckSummary
    }
  } catch {
    summary = undefined
  }

  return {
    exitCode,
    summary,
    raw: stdout,
  }
}

async function runSyncWorkflow({
  summary,
  exitCode,
  scope,
  dryRun,
  cwd,
}: RunSyncWorkflowParams): Promise<RunSyncWorkflowResult> {
  const prompt = buildSyncPrompt(summary, scope, dryRun)

  if (!shouldRunSync(exitCode)) {
    return {
      ran: false,
      prompt,
    }
  }

  const result = await runOpencode(prompt, cwd)
  return {
    ran: true,
    result,
    prompt,
  }
}

async function runOpencode(
  prompt: string,
  cwd: string,
): Promise<OpencodeResult> {
  let lastResult: { stdout: string; stderr: string; exitCode: number } = {
    stdout: '',
    stderr: '',
    exitCode: -1,
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = Bun.spawnSync(
      ['opencode', 'run', '--model', OPENCODE_TEST_MODEL, prompt],
      {
        cwd,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: buildOpencodeConfig(),
        },
        timeout: TIMEOUT_MS,
      },
    )

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
    'systematic_skill tool loads systematic:brainstorming skill',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load systematic:brainstorming',
        testEnv.projectDir,
      )

      expect(result.stdout).toMatch(
        /<skill-instruction>|brainstorm|systematic|skill loaded|loaded/i,
      )
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'systematic_skill tool lists systematic skills in description',
    async () => {
      const result = await runOpencode(
        'What skills are available? List the systematic skills you can load.',
        testEnv.projectDir,
      )

      expect(result.stdout).toMatch(/brainstorming|systematic.*skills/i)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )
})

describe('sync-cep workflow simulation', () => {
  const fixtures = [
    {
      name: 'hash-change',
      summary: {
        hashChanges: ['skills/brainstorming'],
        newUpstream: [],
        deletions: [],
        skipped: [],
        converterVersionChanged: false,
      },
    },
    {
      name: 'report-only',
      summary: {
        hashChanges: [],
        newUpstream: ['skills/new-skill'],
        deletions: ['agents/review/security-sentinel'],
        skipped: [],
        converterVersionChanged: false,
      },
    },
    {
      name: 'converter-version',
      summary: {
        hashChanges: [],
        newUpstream: [],
        deletions: [],
        skipped: [],
        converterVersionChanged: true,
      },
    },
  ]

  test.each(fixtures)('builds sync prompt for $name', ({ summary }) => {
    const prompt = buildSyncPrompt(summary, 'all', true)
    expect(prompt).toContain(JSON.stringify(summary))
    expect(prompt).toContain('Dry run: true')
    expect(prompt).toContain('Scope: all')
  })

  test('sync gate honors precheck exit codes', () => {
    expect(shouldRunSync(0)).toBe(false)
    expect(shouldRunSync(1)).toBe(true)
    expect(shouldRunSync(2)).toBe(false)
  })

  test('sync workflow skips opencode run on exit code 0', async () => {
    const result = await runSyncWorkflow({
      summary: fixtures[0].summary,
      exitCode: 0,
      scope: 'all',
      dryRun: true,
      cwd: REPO_ROOT,
    })

    expect(result.ran).toBe(false)
    expect(result.result).toBeUndefined()
  })

  test.skipIf(!OPENCODE_AVAILABLE)(
    'runs sync prompt in repo with dry-run flag',
    async () => {
      const result = await runSyncWorkflow({
        summary: fixtures[0].summary,
        exitCode: 1,
        scope: 'all',
        dryRun: true,
        cwd: REPO_ROOT,
      })

      expect(result.ran).toBe(true)
      expect(result.result?.exitCode).toBe(0)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test.skipIf(!OPENCODE_AVAILABLE || !process.env.GITHUB_TOKEN)(
    'uses live precheck output when available',
    async () => {
      const precheck = runPrecheckScript()
      expect(precheck.exitCode).toBeGreaterThanOrEqual(0)

      if (precheck.exitCode !== 1 || precheck.summary == null) {
        return
      }

      const result = await runSyncWorkflow({
        summary: precheck.summary,
        exitCode: precheck.exitCode,
        scope: 'all',
        dryRun: true,
        cwd: REPO_ROOT,
      })

      expect(result.ran).toBe(true)
      expect(result.result?.exitCode).toBe(0)
    },
    TIMEOUT_MS * MAX_RETRIES,
  )
})

describe('config handler integration', () => {
  let testEnv: {
    tempDir: string
    bundledDir: string
    projectDir: string
  }

  beforeEach(() => {
    const tempBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-config-integration-'),
    )

    testEnv = {
      tempDir: tempBase,
      bundledDir: path.join(tempBase, 'bundled'),
      projectDir: path.join(tempBase, 'project'),
    }

    fs.mkdirSync(path.join(testEnv.bundledDir, 'skills', 'test-skill'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(testEnv.bundledDir, 'agents'), { recursive: true })
    fs.mkdirSync(path.join(testEnv.bundledDir, 'commands'), { recursive: true })
    fs.mkdirSync(testEnv.projectDir, { recursive: true })

    fs.writeFileSync(
      path.join(testEnv.bundledDir, 'skills', 'test-skill', 'SKILL.md'),
      `---
name: test-skill
description: A skill for integration testing
---
# Test Skill

Integration test content.`,
    )
  })

  afterEach(() => {
    if (testEnv.tempDir) {
      fs.rmSync(testEnv.tempDir, { recursive: true, force: true })
    }
  })

  test('registers skills with systematic: prefix in command name', async () => {
    const handler = createConfigHandler({
      directory: testEnv.projectDir,
      bundledSkillsDir: path.join(testEnv.bundledDir, 'skills'),
      bundledAgentsDir: path.join(testEnv.bundledDir, 'agents'),
      bundledCommandsDir: path.join(testEnv.bundledDir, 'commands'),
    })

    const config: Config = {}
    await handler(config)

    const commandNames = Object.keys(config.command || {})
    expect(commandNames).toContain('systematic:test-skill')
    expect(commandNames).not.toContain('test-skill')
  })

  test('adds (Systematic - Skill) prefix to skill descriptions', async () => {
    const handler = createConfigHandler({
      directory: testEnv.projectDir,
      bundledSkillsDir: path.join(testEnv.bundledDir, 'skills'),
      bundledAgentsDir: path.join(testEnv.bundledDir, 'agents'),
      bundledCommandsDir: path.join(testEnv.bundledDir, 'commands'),
    })

    const config: Config = {}
    await handler(config)

    const skillCommand = config.command?.['systematic:test-skill']
    expect(skillCommand?.description).toMatch(/^\(Systematic - Skill\) /)
    expect(skillCommand?.description).toBe(
      '(Systematic - Skill) A skill for integration testing',
    )
  })

  test('wraps skill template in <skill-instruction> tags', async () => {
    const handler = createConfigHandler({
      directory: testEnv.projectDir,
      bundledSkillsDir: path.join(testEnv.bundledDir, 'skills'),
      bundledAgentsDir: path.join(testEnv.bundledDir, 'agents'),
      bundledCommandsDir: path.join(testEnv.bundledDir, 'commands'),
    })

    const config: Config = {}
    await handler(config)

    const skillCommand = config.command?.['systematic:test-skill']
    expect(skillCommand?.template).toContain('<skill-instruction>')
    expect(skillCommand?.template).toContain('</skill-instruction>')
    expect(skillCommand?.template).toContain('Base directory for this skill:')
    expect(skillCommand?.template).toContain('Integration test content.')
  })

  test('skill template does not contain frontmatter', async () => {
    const handler = createConfigHandler({
      directory: testEnv.projectDir,
      bundledSkillsDir: path.join(testEnv.bundledDir, 'skills'),
      bundledAgentsDir: path.join(testEnv.bundledDir, 'agents'),
      bundledCommandsDir: path.join(testEnv.bundledDir, 'commands'),
    })

    const config: Config = {}
    await handler(config)

    const skillCommand = config.command?.['systematic:test-skill']
    expect(skillCommand?.template).not.toContain('name: test-skill')
    expect(skillCommand?.template).not.toContain(
      'description: A skill for integration testing',
    )
  })
})

describe('opencode availability check', () => {
  test('reports opencode installation status', () => {
    console.log(`OpenCode available: ${OPENCODE_AVAILABLE}`)
    if (!OPENCODE_AVAILABLE) {
      console.log('OpenCode not installed. Install from: https://opencode.ai')
    }
    expect(true).toBe(true)
  })
})
