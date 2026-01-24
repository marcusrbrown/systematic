import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as skillsCore from '../../src/lib/skills-core.ts'

describe('skills-core', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('extractFrontmatter', () => {
    test('extracts valid YAML frontmatter from file', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
---
# Skill Content`,
      )
      const result = skillsCore.extractFrontmatter(filePath)
      expect(result.name).toBe('test-skill')
      expect(result.description).toBe('A test skill')
    })

    test('returns empty strings for missing frontmatter', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(filePath, '# Just a heading\nSome content')
      const result = skillsCore.extractFrontmatter(filePath)
      expect(result.name).toBe('')
      expect(result.description).toBe('')
    })

    test('handles empty frontmatter', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
---
# Content`,
      )
      const result = skillsCore.extractFrontmatter(filePath)
      expect(result.name).toBe('')
      expect(result.description).toBe('')
    })
  })

  describe('stripFrontmatter', () => {
    test('removes frontmatter from content', () => {
      const content = `---
name: test
---
# Content Here`
      const result = skillsCore.stripFrontmatter(content)
      expect(result).toBe('# Content Here')
    })

    test('returns content unchanged if no frontmatter', () => {
      const content = '# No frontmatter'
      const result = skillsCore.stripFrontmatter(content)
      expect(result).toBe('# No frontmatter')
    })
  })

  describe('findSkillsInDir', () => {
    test('finds skills in valid directory structure', () => {
      const skillDir = path.join(testDir, 'my-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: Test skill
---
# My Skill`,
      )

      const skills = skillsCore.findSkillsInDir(testDir, 'bundled')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('my-skill')
      expect(skills[0].sourceType).toBe('bundled')
    })

    test('returns empty array for non-existent directory', () => {
      const skills = skillsCore.findSkillsInDir('/nonexistent/path', 'bundled')
      expect(skills).toEqual([])
    })

    test('uses directory name if no name in frontmatter', () => {
      const skillDir = path.join(testDir, 'unnamed-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Just content')

      const skills = skillsCore.findSkillsInDir(testDir, 'project')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('unnamed-skill')
    })
  })

  describe('findAgentsInDir', () => {
    test('finds agent markdown files', () => {
      fs.writeFileSync(
        path.join(testDir, 'my-agent.md'),
        `---
name: my-agent
description: Test agent
---
# My Agent`,
      )

      const agents = skillsCore.findAgentsInDir(testDir, 'user')
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('my-agent')
      expect(agents[0].sourceType).toBe('user')
    })
  })

  describe('findCommandsInDir', () => {
    test('finds command markdown files and converts sys- to /sys:', () => {
      fs.writeFileSync(
        path.join(testDir, 'sys-test.md'),
        `---
name: sys-test
description: Test command
---
# Test Command`,
      )

      const commands = skillsCore.findCommandsInDir(testDir, 'project')
      expect(commands).toHaveLength(1)
      expect(commands[0].name).toBe('/sys-test')
      expect(commands[0].sourceType).toBe('project')
    })

    test('handles non-sys commands', () => {
      fs.writeFileSync(path.join(testDir, 'other-cmd.md'), '# Other')

      const commands = skillsCore.findCommandsInDir(testDir, 'bundled')
      expect(commands).toHaveLength(1)
      expect(commands[0].name).toBe('/other-cmd')
    })
  })

  describe('resolveSkillPath', () => {
    test('resolves skill path from bundled directory', () => {
      const skillDir = path.join(testDir, 'test-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test')

      const result = skillsCore.resolveSkillPath(
        'test-skill',
        testDir,
        null,
        null,
      )
      expect(result).not.toBeNull()
      expect(result?.skillFile).toBe(path.join(skillDir, 'SKILL.md'))
      expect(result?.sourceType).toBe('bundled')
    })

    test('returns null for non-existent skill', () => {
      const result = skillsCore.resolveSkillPath(
        'nonexistent',
        testDir,
        null,
        null,
      )
      expect(result).toBeNull()
    })

    test('project skills override user and bundled', () => {
      const bundledDir = path.join(testDir, 'bundled')
      const userDir = path.join(testDir, 'user')
      const projectDir = path.join(testDir, 'project')

      for (const dir of [bundledDir, userDir, projectDir]) {
        const skillDir = path.join(dir, 'test-skill')
        fs.mkdirSync(skillDir, { recursive: true })
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${dir}`)
      }

      const result = skillsCore.resolveSkillPath(
        'test-skill',
        bundledDir,
        userDir,
        projectDir,
      )
      expect(result).not.toBeNull()
      expect(result?.sourceType).toBe('project')
    })

    test('sys: prefix forces bundled resolution', () => {
      const bundledDir = path.join(testDir, 'bundled')
      const projectDir = path.join(testDir, 'project')

      for (const dir of [bundledDir, projectDir]) {
        const skillDir = path.join(dir, 'test-skill')
        fs.mkdirSync(skillDir, { recursive: true })
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${dir}`)
      }

      const result = skillsCore.resolveSkillPath(
        'sys:test-skill',
        bundledDir,
        null,
        projectDir,
      )
      expect(result).not.toBeNull()
      expect(result?.sourceType).toBe('bundled')
    })
  })
})
