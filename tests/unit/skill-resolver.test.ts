import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from '../../src/lib/skill-resolver.ts'

function makeSkillsDir(): string {
  const testDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-skill-resolver-test-'),
  )
  const skillDir = path.join(testDir, 'load-test')
  fs.mkdirSync(skillDir)
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: load-test
description: Skill for loading test
---
# Load Test Skill

This is the skill content.`,
  )
  return testDir
}

describe('skill-resolver (harness-neutral core)', () => {
  test('resolveSkill returns the matched skill for a prefixed name', () => {
    const testDir = makeSkillsDir()
    try {
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'systematic:load-test',
      )
      expect(skill.name).toBe('load-test')
      expect(skill.prefixedName).toBe('systematic:load-test')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('resolveSkill throws byte-identical not-found error text', () => {
    const testDir = makeSkillsDir()
    try {
      expect(() =>
        resolveSkill(
          { bundledSkillsDir: testDir, disabledSkills: [] },
          'nonexistent',
        ),
      ).toThrow(
        'Skill "nonexistent" not found. Available systematic skills: systematic:load-test',
      )
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillToolDescription matches catalog-derived description', () => {
    const testDir = makeSkillsDir()
    try {
      const description = buildSkillToolDescription({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })
      expect(description).toContain('systematic:load-test')
      expect(description).toContain('Skill for loading test')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillToolParameterHint includes example skill names', () => {
    const testDir = makeSkillsDir()
    try {
      const hint = buildSkillToolParameterHint({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })
      expect(hint).toContain('The name of the skill from available_skills')
      expect(hint).toContain("'systematic:load-test'")
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillContentOutput wraps skill content and reports skillDir', () => {
    const testDir = makeSkillsDir()
    try {
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'load-test',
      )
      const { output, dir } = buildSkillContentOutput(skill)

      expect(dir).toBe(path.join(testDir, 'load-test'))
      expect(output).toStartWith('<skill_content name="systematic:load-test">')
      expect(output).toContain('# Skill: systematic:load-test')
      expect(output).toContain('# Load Test Skill')
      expect(output).toContain('This is the skill content.')
      expect(output).toContain(`Base directory for this skill: file://${dir}`)
      expect(output).toEndWith('</skill_content>')
      // No extra files beyond SKILL.md in this fixture: no <skill_files> block.
      expect(output).not.toContain('<skill_files>')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })
})
