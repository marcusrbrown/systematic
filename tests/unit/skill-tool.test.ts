import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSkillTool,
  getHookedTool,
  isAlreadyHooked,
  resetHookState,
  setHookedTool,
} from '../../src/lib/skill-tool.ts'

const mockContext = {} as never

describe('skill-tool', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-skill-test-'))
    resetHookState()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
    resetHookState()
  })

  describe('hook state management', () => {
    test('isAlreadyHooked returns false before initialization', () => {
      expect(isAlreadyHooked()).toBe(false)
    })

    test('isAlreadyHooked returns true after setHookedTool', () => {
      setHookedTool(null)
      expect(isAlreadyHooked()).toBe(true)
    })

    test('getHookedTool returns null after initialization with null', () => {
      setHookedTool(null)
      expect(getHookedTool()).toBeNull()
    })

    test('getHookedTool returns set tool', () => {
      const mockTool = {
        description: 'Mock tool',
        args: {},
        execute: async () => 'result',
      }
      setHookedTool(mockTool as never)
      expect(getHookedTool()).toBe(mockTool)
    })
  })

  describe('createSkillTool', () => {
    test('creates tool with description property', () => {
      const skillDir = path.join(testDir, 'test-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill for unit testing
---
# Test Skill Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).toContain('systematic:test-skill')
      expect(tool.description).toContain('A test skill for unit testing')
    })

    test('filters out disabled skills from description', () => {
      const skill1Dir = path.join(testDir, 'enabled-skill')
      const skill2Dir = path.join(testDir, 'disabled-skill')
      fs.mkdirSync(skill1Dir)
      fs.mkdirSync(skill2Dir)

      fs.writeFileSync(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: enabled-skill
description: Enabled
---
# Content`,
      )

      fs.writeFileSync(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: disabled-skill
description: Disabled
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: ['disabled-skill'],
      })

      expect(tool.description).toContain('systematic:enabled-skill')
      expect(tool.description).not.toContain('systematic:disabled-skill')
    })

    test('merges hooked tool description', () => {
      const skillDir = path.join(testDir, 'my-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: My skill
---
# Content`,
      )

      const mockHookedTool = {
        description: `Load a skill.

<available_skills>
  <skill>
    <name>other-skill</name>
    <description>Other skill from hooked tool</description>
  </skill>
</available_skills>`,
        args: {},
        execute: async () => 'hooked result',
      }

      setHookedTool(mockHookedTool as never)

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).toContain('systematic:my-skill')
      expect(tool.description).toContain('other-skill')
    })
  })

  describe('execute', () => {
    test('loads systematic skill with prefix', async () => {
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

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'systematic:load-test' },
        mockContext,
      )

      expect(result).toContain('systematic:load-test')
      expect(result).toContain('<skill_instruction>')
      expect(result).toContain('# Load Test Skill')
      expect(result).toContain('This is the skill content.')
    })

    test('loads systematic skill without prefix', async () => {
      const skillDir = path.join(testDir, 'no-prefix')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: no-prefix
description: Test
---
# No Prefix Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute({ name: 'no-prefix' }, mockContext)

      expect(result).toContain('systematic:no-prefix')
      expect(result).toContain('# No Prefix Content')
    })

    test('falls back to hooked tool for unknown skill', async () => {
      fs.mkdirSync(path.join(testDir, 'known-skill'))
      fs.writeFileSync(
        path.join(testDir, 'known-skill', 'SKILL.md'),
        `---
name: known-skill
description: Known
---
# Known`,
      )

      const mockHookedTool = {
        description: 'Mock',
        args: {},
        execute: async (args: { name: string }) =>
          `Hooked skill loaded: ${args.name}`,
      }

      setHookedTool(mockHookedTool as never)

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'unknown-external-skill' },
        mockContext,
      )

      expect(result).toBe('Hooked skill loaded: unknown-external-skill')
    })

    test('throws error when skill not found and no hooked tool', async () => {
      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      await expect(
        tool.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Skill "nonexistent" not found')
    })

    test('strips frontmatter from loaded skill content', async () => {
      const skillDir = path.join(testDir, 'frontmatter-strip')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: frontmatter-strip
description: Test frontmatter stripping
---
# Actual Content

No frontmatter visible here.`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'frontmatter-strip' },
        mockContext,
      )

      expect(result).not.toContain('description: Test frontmatter stripping')
      expect(result).toContain('# Actual Content')
    })

    test('wraps content with skill_instruction tags', async () => {
      const skillDir = path.join(testDir, 'wrap-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: wrap-test
description: Test wrapper
---
# Wrapped Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute({ name: 'wrap-test' }, mockContext)

      expect(result).toContain('<skill_instruction>')
      expect(result).toContain('</skill_instruction>')
      expect(result).toContain('Base directory for this skill:')
    })
  })
})
