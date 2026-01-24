import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as skillsCore from '../../src/lib/skills-core.ts'

describe('skill priority resolution', () => {
  let testEnv: {
    tempDir: string
    bundledDir: string
    userDir: string
    projectDir: string
  }

  beforeEach(() => {
    const tempBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-priority-'),
    )

    testEnv = {
      tempDir: tempBase,
      bundledDir: path.join(tempBase, 'bundled'),
      userDir: path.join(tempBase, 'user'),
      projectDir: path.join(tempBase, 'project'),
    }

    fs.mkdirSync(testEnv.bundledDir, { recursive: true })
    fs.mkdirSync(testEnv.userDir, { recursive: true })
    fs.mkdirSync(testEnv.projectDir, { recursive: true })
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

  test('project skills override user skills', () => {
    createSkill(testEnv.userDir, 'priority-test', 'user')
    createSkill(testEnv.projectDir, 'priority-test', 'project')

    const result = skillsCore.resolveSkillPath(
      'priority-test',
      testEnv.bundledDir,
      testEnv.userDir,
      testEnv.projectDir,
    )

    expect(result).not.toBeNull()
    const content = fs.readFileSync(result!.skillFile, 'utf-8')
    expect(content).toContain('PRIORITY_MARKER_PROJECT_VERSION')
  })

  test('user skills override bundled skills', () => {
    createSkill(testEnv.bundledDir, 'priority-test', 'bundled')
    createSkill(testEnv.userDir, 'priority-test', 'user')

    const result = skillsCore.resolveSkillPath(
      'priority-test',
      testEnv.bundledDir,
      testEnv.userDir,
      null,
    )

    expect(result).not.toBeNull()
    const content = fs.readFileSync(result!.skillFile, 'utf-8')
    expect(content).toContain('PRIORITY_MARKER_USER_VERSION')
  })

  test('project skills override both user and bundled', () => {
    createSkill(testEnv.bundledDir, 'priority-test', 'bundled')
    createSkill(testEnv.userDir, 'priority-test', 'user')
    createSkill(testEnv.projectDir, 'priority-test', 'project')

    const result = skillsCore.resolveSkillPath(
      'priority-test',
      testEnv.bundledDir,
      testEnv.userDir,
      testEnv.projectDir,
    )

    expect(result).not.toBeNull()
    const content = fs.readFileSync(result!.skillFile, 'utf-8')
    expect(content).toContain('PRIORITY_MARKER_PROJECT_VERSION')
  })

  test('falls back to bundled when no overrides exist', () => {
    createSkill(testEnv.bundledDir, 'bundled-only', 'bundled')

    const result = skillsCore.resolveSkillPath(
      'bundled-only',
      testEnv.bundledDir,
      testEnv.userDir,
      testEnv.projectDir,
    )

    expect(result).not.toBeNull()
    const content = fs.readFileSync(result!.skillFile, 'utf-8')
    expect(content).toContain('PRIORITY_MARKER_BUNDLED_VERSION')
  })

  test('returns null when skill not found in any location', () => {
    const result = skillsCore.resolveSkillPath(
      'nonexistent-skill',
      testEnv.bundledDir,
      testEnv.userDir,
      testEnv.projectDir,
    )

    expect(result).toBeNull()
  })

  test('findSkillsInDir returns correct sourceType labels', () => {
    createSkill(testEnv.projectDir, 'project-skill', 'project')
    createSkill(testEnv.userDir, 'user-skill', 'user')
    createSkill(testEnv.bundledDir, 'bundled-skill', 'bundled')

    const projectSkills = skillsCore.findSkillsInDir(
      testEnv.projectDir,
      'project',
    )
    const userSkills = skillsCore.findSkillsInDir(testEnv.userDir, 'user')
    const bundledSkills = skillsCore.findSkillsInDir(
      testEnv.bundledDir,
      'bundled',
    )

    expect(projectSkills[0].sourceType).toBe('project')
    expect(userSkills[0].sourceType).toBe('user')
    expect(bundledSkills[0].sourceType).toBe('bundled')
  })

  test('deduplication respects priority order', () => {
    createSkill(testEnv.projectDir, 'shared-skill', 'project')
    createSkill(testEnv.userDir, 'shared-skill', 'user')
    createSkill(testEnv.bundledDir, 'shared-skill', 'bundled')

    const projectSkills = skillsCore.findSkillsInDir(
      testEnv.projectDir,
      'project',
    )
    const userSkills = skillsCore.findSkillsInDir(testEnv.userDir, 'user')
    const bundledSkills = skillsCore.findSkillsInDir(
      testEnv.bundledDir,
      'bundled',
    )

    const seen = new Set<string>()
    const deduped: Array<{ name: string; sourceType: string }> = []

    for (const list of [projectSkills, userSkills, bundledSkills]) {
      for (const skill of list) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name)
          deduped.push(skill)
        }
      }
    }

    expect(deduped).toHaveLength(1)
    expect(deduped[0].sourceType).toBe('project')
  })
})
