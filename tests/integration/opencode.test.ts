import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 120_000
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 3_000

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function buildOpencodeConfig(): string {
  const pluginPath = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({
    plugin: [pluginPath],
  })
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

  async function runOpencode(
    prompt: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let lastResult: { stdout: string; stderr: string; exitCode: number } = {
      stdout: '',
      stderr: '',
      exitCode: -1,
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = Bun.spawnSync(['opencode', 'run', prompt], {
        cwd: testEnv.projectDir,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: buildOpencodeConfig(),
        },
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

  test(
    'systematic_skill tool loads systematic:brainstorming skill',
    async () => {
      const result = await runOpencode(
        'Use the systematic_skill tool to load systematic:brainstorming',
      )

      expect(result.stdout).toMatch(
        /<skill-instruction>|brainstorm|systematic|skill loaded/i,
      )
    },
    TIMEOUT_MS * MAX_RETRIES,
  )

  test(
    'systematic_skill tool lists systematic skills in description',
    async () => {
      const result = await runOpencode(
        'What skills are available? List the systematic skills you can load.',
      )

      expect(result.stdout).toMatch(
        /systematic:brainstorming|systematic:.*|available.*skills/i,
      )
    },
    TIMEOUT_MS * MAX_RETRIES,
  )
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
