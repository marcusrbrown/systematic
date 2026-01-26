import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as skillsCore from '../../src/lib/skills-core.ts'

describe('skill resolution', () => {
  let testEnv: {
    tempDir: string
    bundledDir: string
  }

  beforeEach(() => {
    const tempBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-resolution-'),
    )

    testEnv = {
      tempDir: tempBase,
      bundledDir: path.join(tempBase, 'bundled'),
    }

    fs.mkdirSync(testEnv.bundledDir, { recursive: true })
  })

  afterEach(() => {
    if (testEnv.tempDir) {
      fs.rmSync(testEnv.tempDir, { recursive: true, force: true })
    }
  })

  function createSkill(dir: string, name: string, marker: string): void {
    const skillDir = path.join(dir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: ${name}
description: ${marker} version of the skill
---
# ${name}

This is the ${marker} version.

PRIORITY_MARKER_${marker.toUpperCase()}_VERSION
`,
    )
  }

  test('findSkillsInDir returns correct sourceType labels', () => {
    createSkill(testEnv.bundledDir, 'bundled-skill', 'bundled')

    const bundledSkills = skillsCore.findSkillsInDir(
      testEnv.bundledDir,
      'bundled',
    )

    expect(bundledSkills[0].sourceType).toBe('bundled')
  })
})
