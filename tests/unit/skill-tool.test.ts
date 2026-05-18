import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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

    test('preserves names that already include a colon prefix', () => {
      const result = formatSkillsXml([
        {
          path: '/test/path',
          skillFile: '/test/path/SKILL.md',
          name: 'ce:plan',
          description: 'Plan workflow skill',
        },
      ])

      expect(result).toContain('<name>ce:plan</name>')
      expect(result).not.toContain('<name>systematic:ce:plan</name>')
    })

    test('escapes XML special chars in name and description', () => {
      const result = formatSkillsXml([
        {
          path: '/test/path',
          skillFile: '/test/path/SKILL.md',
          name: 'a&b',
          description: 'A & B <special>',
        },
      ])

      expect(result).toContain('<name>systematic:a&amp;b</name>')
      expect(result).toContain(
        '<description>A &amp; B &lt;special&gt;</description>',
      )
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

    test('description uses compact catalog format, not verbose XML', () => {
      const skillDir = path.join(testDir, 'ce-brainstorm')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: ce:brainstorm
description: Explore requirements and approaches through collaborative dialogue
---
# Brainstorm Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      // Compact format: markdown bullet list
      expect(tool.description).toContain('ce:brainstorm')
      expect(tool.description).toContain(
        'Explore requirements and approaches through collaborative dialogue',
      )
      // Must NOT contain verbose XML catalog
      expect(tool.description).not.toContain('<available_skills>')
      expect(tool.description).not.toContain('</available_skills>')
      expect(tool.description).not.toContain('<location>')
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

    test('excludes disableModelInvocation skills from description', () => {
      const visibleDir = path.join(testDir, 'visible-skill')
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(visibleDir)
      fs.mkdirSync(hiddenDir)

      fs.writeFileSync(
        path.join(visibleDir, 'SKILL.md'),
        `---
name: visible-skill
description: Visible to model
---
# Content`,
      )

      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).toContain('systematic:visible-skill')
      expect(tool.description).not.toContain('systematic:hidden-skill')
    })

    test('compact description and execution loadability agree on disabled vs disable-model-invocation skills', async () => {
      const normalDir = path.join(testDir, 'normal-skill')
      const disabledDir = path.join(testDir, 'disabled-skill')
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(normalDir)
      fs.mkdirSync(disabledDir)
      fs.mkdirSync(hiddenDir)

      fs.writeFileSync(
        path.join(normalDir, 'SKILL.md'),
        `---
name: normal-skill
description: Normal skill
---
# Normal`,
      )

      fs.writeFileSync(
        path.join(disabledDir, 'SKILL.md'),
        `---
name: disabled-skill
description: Disabled skill
---
# Disabled`,
      )

      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden skill
disable-model-invocation: true
---
# Hidden`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: ['disabled-skill'],
      })

      // Disabled: not in description, not loadable
      expect(tool.description).not.toContain('systematic:disabled-skill')
      await expect(
        tool.execute({ name: 'systematic:disabled-skill' }, mockContext),
      ).rejects.toThrow()

      // Hidden (disableModelInvocation): not in description, IS loadable
      expect(tool.description).not.toContain('systematic:hidden-skill')
      const hiddenResult = await tool.execute(
        { name: 'systematic:hidden-skill' },
        mockContext,
      )
      expect(hiddenResult).toContain('# Hidden')

      // Normal: in description, loadable
      expect(tool.description).toContain('systematic:normal-skill')
      const normalResult = await tool.execute(
        { name: 'systematic:normal-skill' },
        mockContext,
      )
      expect(normalResult).toContain('# Normal')
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

    test('loads skill that uses a non-systematic colon prefix', async () => {
      const skillDir = path.join(testDir, 'ce-plan')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: ce:plan
description: Test CE skill
---
# CE Plan Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute({ name: 'ce:plan' }, mockContext)

      expect(result).toContain('ce:plan')
      expect(result).toContain('# CE Plan Content')
      expect(result).not.toContain('systematic:ce:plan')
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

    test('wraps output with skill_content tags and omits skill_files when no files found', async () => {
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
      // skill_files section should be omitted when no files
      expect(result).not.toContain('<skill_files>')
      expect(result).not.toContain('</skill_files>')
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
      // Check for absolute paths ending with the filenames
      expect(result).toMatch(/<file>.*\/helper\.ts<\/file>/)
      expect(result).toMatch(/<file>.*\/utils\.ts<\/file>/)
      // SKILL.md should not be in the file list
      expect(result).not.toContain('<file>SKILL.md</file>')
      // Hidden files should be included (matches OpenCode v1.1.50 behavior)
      expect(result).toMatch(/<file>.*\/\.hidden<\/file>/)
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
      expect(fileMatches?.length).toBe(10)
      // Verify at least one of the first 10 files is present
      const hasLimitedFiles = /file[0-9]\.ts/.test(result)
      expect(hasLimitedFiles).toBe(true)
    })

    test('loads disableModelInvocation skill when explicitly requested', async () => {
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(hiddenDir)
      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---
# Hidden Skill Content

This skill is only loadable by explicit request.`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).not.toContain('hidden-skill')

      const result = await tool.execute(
        { name: 'systematic:hidden-skill' },
        mockContext,
      )

      expect(result).toContain('systematic:hidden-skill')
      expect(result).toContain('# Hidden Skill Content')
      expect(result).toContain(
        'This skill is only loadable by explicit request.',
      )
    })

    test('does not list disableModelInvocation skills in error suggestions', async () => {
      const visibleDir = path.join(testDir, 'visible-skill')
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(visibleDir)
      fs.mkdirSync(hiddenDir)

      fs.writeFileSync(
        path.join(visibleDir, 'SKILL.md'),
        `---
name: visible-skill
description: Visible to model
---
# Content`,
      )

      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      try {
        await tool.execute({ name: 'nonexistent' }, mockContext)
        expect.unreachable('Should have thrown')
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain('systematic:visible-skill')
        expect(message).not.toContain('hidden-skill')
      }
    })
  })

  describe('deprecated skill warnings', () => {
    function makeDeprecatedSkill(
      dir: string,
      name: string,
      extras: string = '',
    ): void {
      const skillDir = path.join(dir, name)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: ${name}
description: A deprecated skill
deprecated:
  since: v2.19.0
  removal: v3.0.0
  replacement: new-skill
  reason: "Old API no longer supported."
${extras}---
# Deprecated Skill Content`,
      )
    }

    test('emits console.warn with full message when invoking a deprecated skill', async () => {
      makeDeprecatedSkill(testDir, 'old-skill')

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool.execute({ name: 'old-skill' }, mockContext)

      const warnCalls = warnSpy.mock.calls as unknown[][]
      const deprecationWarn = warnCalls.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          args[0].includes('[systematic]') &&
          args[0].includes('"old-skill"') &&
          args[0].includes('deprecated'),
      )
      expect(deprecationWarn).toBeDefined()
      const msg = (deprecationWarn as unknown[])[0] as string
      expect(msg).toBe(
        '[systematic] skill "old-skill" is deprecated since v2.19.0; will be removed in v3.0.0. Replacement: new-skill. Reason: Old API no longer supported.',
      )

      warnSpy.mockRestore()
    })

    test('emits console.warn only once when the same deprecated skill is invoked twice on the same tool instance', async () => {
      makeDeprecatedSkill(testDir, 'old-skill')

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool.execute({ name: 'old-skill' }, mockContext)
      await tool.execute({ name: 'old-skill' }, mockContext)

      const deprecationWarns = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          args[0].includes('[systematic]') &&
          args[0].includes('"old-skill"'),
      )
      expect(deprecationWarns.length).toBe(1)

      warnSpy.mockRestore()
    })

    test('omits Replacement clause when replacement is absent', async () => {
      const skillDir = path.join(testDir, 'no-replacement')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: no-replacement
description: Deprecated without replacement
deprecated:
  since: v2.19.0
  removal: v3.0.0
  reason: "No replacement available."
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool.execute({ name: 'no-replacement' }, mockContext)

      const deprecationWarns = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' && args[0].includes('"no-replacement"'),
      )
      expect(deprecationWarns.length).toBe(1)
      const msg = (deprecationWarns[0] as unknown[])[0] as string
      expect(msg).not.toContain('Replacement:')
      expect(msg).toContain('Reason: No replacement available.')
      // Should not have any double-period artifacts (e.g., ".." at end or ". ." patterns)
      expect(msg).not.toMatch(/\.\.$|\. \./)

      warnSpy.mockRestore()
    })

    test('omits Reason clause when reason is absent', async () => {
      const skillDir = path.join(testDir, 'no-reason')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: no-reason
description: Deprecated without reason
deprecated:
  since: v2.19.0
  removal: v3.0.0
  replacement: better-skill
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool.execute({ name: 'no-reason' }, mockContext)

      const deprecationWarns = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' && args[0].includes('"no-reason"'),
      )
      expect(deprecationWarns.length).toBe(1)
      const msg = (deprecationWarns[0] as unknown[])[0] as string
      expect(msg).not.toContain('Reason:')
      expect(msg).toContain('Replacement: better-skill.')

      warnSpy.mockRestore()
    })

    test('does not produce double-dot when replacement already ends with a period', async () => {
      const skillDir = path.join(testDir, 'trailing-dot-replacement')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: trailing-dot-replacement
description: Deprecated with trailing-dot replacement
deprecated:
  since: v2.19.0
  removal: v3.0.0
  replacement: "new-skill."
  reason: "Old API removed."
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool.execute({ name: 'trailing-dot-replacement' }, mockContext)

      const deprecationWarns = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          args[0].includes('"trailing-dot-replacement"'),
      )
      expect(deprecationWarns.length).toBe(1)
      const msg = (deprecationWarns[0] as unknown[])[0] as string
      expect(msg).not.toMatch(/\.\./u)
      expect(msg).toContain('Replacement: new-skill.')

      warnSpy.mockRestore()
    })

    test('a fresh createSkillTool instance re-emits the warning for the same skill', async () => {
      makeDeprecatedSkill(testDir, 'old-skill')

      const tool1 = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool1.execute({ name: 'old-skill' }, mockContext)

      const warnsAfterFirst = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' && args[0].includes('"old-skill"'),
      ).length
      expect(warnsAfterFirst).toBe(1)

      // New instance — dedup set is fresh
      const tool2 = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      await tool2.execute({ name: 'old-skill' }, mockContext)

      const warnsAfterSecond = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' && args[0].includes('"old-skill"'),
      ).length
      expect(warnsAfterSecond).toBe(2)

      warnSpy.mockRestore()
    })
  })
})
