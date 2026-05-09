import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 90_000
const MAX_RETRIES = 1
const RETRY_DELAY_MS = 3_000
const OPENCODE_TEST_MODEL = 'opencode/big-pickle'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

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
