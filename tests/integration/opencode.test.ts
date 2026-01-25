import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 90_000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2_000

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

describe.skipIf(!OPENCODE_AVAILABLE)('opencode integration', () => {
  let testEnv: {
    tempDir: string
    projectDir: string
    homeDir: string
    originalCwd: string
  }

  beforeEach(() => {
    const tempBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-opencode-'),
    )

    testEnv = {
      tempDir: tempBase,
      projectDir: path.join(tempBase, 'project'),
      homeDir: path.join(tempBase, 'home'),
      originalCwd: process.cwd(),
    }

    fs.mkdirSync(testEnv.projectDir, { recursive: true })
    fs.mkdirSync(
      path.join(testEnv.homeDir, '.config/opencode/skills/personal-test'),
      { recursive: true },
    )

    fs.writeFileSync(
      path.join(
        testEnv.homeDir,
        '.config/opencode/skills/personal-test/SKILL.md',
      ),
      `---
name: personal-test
description: Personal test skill for integration testing
---
# Personal Test Skill

This is a personal test skill.

PERSONAL_SKILL_MARKER_12345
`,
    )

    copyEnvFileIfExists(REPO_ROOT, testEnv.projectDir)
    copyEnvFileIfExists(REPO_ROOT, testEnv.homeDir)
  })

  afterEach(() => {
    process.chdir(testEnv.originalCwd)
    if (testEnv.tempDir) {
      fs.rmSync(testEnv.tempDir, { recursive: true, force: true })
    }
  })

  function copyEnvFileIfExists(srcDir: string, destDir: string): void {
    const envFile = path.join(srcDir, '.env')
    if (fs.existsSync(envFile)) {
      fs.copyFileSync(envFile, path.join(destDir, '.env'))
    }
  }

  async function runOpencodeWithRetry(
    prompt: string,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let lastResult: { stdout: string; stderr: string; exitCode: number } = {
      stdout: '',
      stderr: '',
      exitCode: -1,
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = Bun.spawnSync(
        ['opencode', 'run', '--print-logs', prompt],
        {
          cwd: cwd || testEnv.projectDir,
          env: {
            ...process.env,
            HOME: testEnv.homeDir,
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
        lastResult.exitCode === -1 ||
        lastResult.stderr.includes('timeout') ||
        lastResult.stderr.includes('ETIMEDOUT')

      const isRateLimit =
        lastResult.stderr.includes('rate limit') ||
        lastResult.stderr.includes('429') ||
        lastResult.stderr.includes('too many requests')

      if (!isTimeout && !isRateLimit && lastResult.exitCode === 0) {
        return lastResult
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt
        console.log(
          `Attempt ${attempt}/${MAX_RETRIES} failed (timeout/rate-limit), retrying in ${delay}ms...`,
        )
        await Bun.sleep(delay)
      }
    }

    return lastResult
  }

  test(
    'find_skills tool discovers bundled skills',
    async () => {
      const result = await runOpencodeWithRetry(
        'Use the find_skills tool to list available skills. Just call the tool and show me the raw output.',
      )

      expect(result.stdout.toLowerCase()).toMatch(
        /brainstorming|using-systematic|available skills/i,
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
