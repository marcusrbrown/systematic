import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSkillTool, formatSkillsXml } from '../../src/lib/skill-tool.ts'

const mockContext = {
  ask: async () => {},
  metadata: () => {},
} as never

describe('skill-tool', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-skill-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('formatSkillsXml', () => {
    test('returns empty string for empty skills array', () => {
      const result = formatSkillsXml([])
      expect(result).toBe('')
    })

    test('formats single skill with space delimiters, indented structure, and location field', () => {
      const result = formatSkillsXml([
        {
          path: '/test/path',
          skillFile: '/test/path/SKILL.md',
          name: 'test-skill',
          description: 'A test skill',
        },
      ])
      expect(result).toContain('<available_skills>')
      expect(result).toContain('</available_skills>')
      expect(result).toContain('<name>systematic:test-skill</name>')
      expect(result).toContain('<description>A test skill</description>')
      expect(result).toContain('<location>file:///test/path</location>')
      // Ensure space-delimited format (no newlines)
      expect(result).not.toContain('\n')
    })

    test('formats multiple skills with space delimiters and indented structure', () => {
      const result = formatSkillsXml([
        {
          path: '/test/path1',
          skillFile: '/test/path1/SKILL.md',
          name: 'skill-one',
          description: 'First skill',
        },
        {
          path: '/test/path2',
          skillFile: '/test/path2/SKILL.md',
          name: 'skill-two',
          description: 'Second skill',
        },
      ])
      expect(result).toContain('<available_skills>')
      expect(result).toContain('</available_skills>')
      expect(result).toContain('<name>systematic:skill-one</name>')
      expect(result).toContain('<name>systematic:skill-two</name>')
      expect(result).toContain('<description>First skill</description>')
      expect(result).toContain('<description>Second skill</description>')
      // Ensure no newlines in output (space-delimited format)
      expect(result).not.toContain('\n')
    })

    test('includes skills even when disableModelInvocation is true', () => {
      const result = formatSkillsXml([
        {
          path: '/test/path1',
          skillFile: '/test/path1/SKILL.md',
          name: 'skill-one',
          description: 'First skill',
        },
        {
          path: '/test/path2',
          skillFile: '/test/path2/SKILL.md',
          name: 'skill-two',
          description: 'Second skill',
          disableModelInvocation: true,
        },
      ])
      expect(result).toContain('skill-one')
      expect(result).toContain('skill-two')
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
      expect(result).toContain('# Load Test Skill')
      expect(result).toContain('This is the skill content.')
      expect(result).not.toContain('<skill-instruction>')
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

    test('throws error when skill not found', async () => {
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

    test('wraps output with skill_content tags and uses new format', async () => {
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

      // New wrapper format
      expect(result).toContain('<skill_content name="systematic:wrap-test">')
      expect(result).toContain('</skill_content>')
      // New heading format
      expect(result).toContain('# Skill: systematic:wrap-test')
      // New base directory format with file:// URL
      expect(result).toContain('Base directory for this skill: file://')
      expect(result).toContain('# Wrapped Content')
      // File discovery section
      expect(result).toContain('<skill_files>')
      expect(result).toContain('</skill_files>')
    })

    test('includes discovered files in skill_files section', async () => {
      const skillDir = path.join(testDir, 'file-discovery-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: file-discovery-test
description: Test file discovery
---
# Test Content`,
      )
      // Add extra files to be discovered
      fs.writeFileSync(
        path.join(skillDir, 'helper.ts'),
        'export function helper() {}',
      )
      fs.writeFileSync(
        path.join(skillDir, 'utils.ts'),
        'export function util() {}',
      )
      fs.writeFileSync(path.join(skillDir, '.hidden'), 'hidden file')

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'file-discovery-test' },
        mockContext,
      )

      expect(result).toContain('<skill_files>')
      expect(result).toContain('</skill_files>')
      expect(result).toContain('<file>helper.ts</file>')
      expect(result).toContain('<file>utils.ts</file>')
      // SKILL.md should not be in the file list
      expect(result).not.toContain('<file>SKILL.md</file>')
      // Hidden files should not be included
      expect(result).not.toContain('<file>.hidden</file>')
    })

    test('enforces 10-file limit in skill_files section', async () => {
      const skillDir = path.join(testDir, 'file-limit-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: file-limit-test
description: Test file limit
---
# Test Content`,
      )
      // Create 15 extra files
      for (let i = 1; i <= 15; i++) {
        fs.writeFileSync(
          path.join(skillDir, `file${i}.ts`),
          `export const file${i} = ${i}`,
        )
      }

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'file-limit-test' },
        mockContext,
      )

      // Count the number of <file> tags
      const fileMatches = result.match(/<file>/g)
      expect(fileMatches).toBeDefined()
      expect(fileMatches!.length).toBe(10)
      // Verify at least one of the first 10 files is present
      const hasLimitedFiles = /file[0-9]\.ts/.test(result)
      expect(hasLimitedFiles).toBe(true)
    })
  })
})
