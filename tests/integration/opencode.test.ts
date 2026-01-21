import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

const TIMEOUT_MS = 60_000

describe.skipIf(!OPENCODE_AVAILABLE)(
  'opencode integration',
  () => {
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
    })

    afterEach(() => {
      process.chdir(testEnv.originalCwd)
      if (testEnv.tempDir) {
        fs.rmSync(testEnv.tempDir, { recursive: true, force: true })
      }
    })

    function runOpencode(
      prompt: string,
      cwd?: string,
    ): { stdout: string; stderr: string; exitCode: number } {
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

      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode ?? -1,
      }
    }

    test(
      'find_skills tool discovers bundled skills',
      () => {
        const result = runOpencode(
          'Use the find_skills tool to list available skills. Just call the tool and show me the raw output.',
        )

        expect(result.stdout.toLowerCase()).toMatch(
          /brainstorming|using-superpowers|available skills/i,
        )
      },
      TIMEOUT_MS,
    )

    test(
      'use_skill tool loads skill content',
      () => {
        const result = runOpencode(
          'Use the use_skill tool to load the personal-test skill and show me what you get.',
        )

        expect(result.stdout.toLowerCase()).toMatch(
          /personal_skill_marker_12345|personal test skill|launching skill/i,
        )
      },
      TIMEOUT_MS,
    )
  },
)

describe('opencode availability check', () => {
  test('reports opencode installation status', () => {
    console.log(`OpenCode available: ${OPENCODE_AVAILABLE}`)
    if (!OPENCODE_AVAILABLE) {
      console.log(
        'OpenCode not installed. Install from: https://opencode.ai',
      )
    }
    expect(true).toBe(true)
  })
})
