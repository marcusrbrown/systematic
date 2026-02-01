import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as agents from '../../src/lib/agents.ts'
import * as commands from '../../src/lib/commands.ts'
import * as frontmatter from '../../src/lib/frontmatter.ts'
import * as skills from '../../src/lib/skills.ts'

describe('skills', () => {
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
      const result = skills.extractFrontmatter(filePath)
      expect(result.name).toBe('test-skill')
      expect(result.description).toBe('A test skill')
    })

    test('returns empty strings for missing frontmatter', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(filePath, '# Just a heading\nSome content')
      const result = skills.extractFrontmatter(filePath)
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
      const result = skills.extractFrontmatter(filePath)
      expect(result.name).toBe('')
      expect(result.description).toBe('')
    })

    test('extracts OpenCode SDK fields', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
license: MIT
compatibility: opencode
---
# Skill Content`,
      )
      const result = skills.extractFrontmatter(filePath)
      expect(result.license).toBe('MIT')
      expect(result.compatibility).toBe('opencode')
    })

    test('extracts metadata object with string values', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
metadata:
  author: Test Author
  version: '1.0.0'
---
# Skill Content`,
      )
      const result = skills.extractFrontmatter(filePath)
      expect(result.metadata).toEqual({
        author: 'Test Author',
        version: '1.0.0',
      })
    })

    test('extracts Claude Code converted fields', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
disable-model-invocation: true
user-invocable: false
agent: oracle
model: gpt-4
argument-hint: "[file]"
allowed-tools: read,write
---
# Skill Content`,
      )
      const result = skills.extractFrontmatter(filePath)
      expect(result.disableModelInvocation).toBe(true)
      expect(result.userInvocable).toBe(false)
      expect(result.agent).toBe('oracle')
      expect(result.model).toBe('gpt-4')
      expect(result.argumentHint).toBe('[file]')
      expect(result.allowedTools).toBe('read,write')
    })

    test('derives subtask from context: fork', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
context: fork
---
# Skill Content`,
      )
      const result = skills.extractFrontmatter(filePath)
      expect(result.subtask).toBe(true)
    })

    test('subtask is undefined when context is not fork', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
context: other
---
# Skill Content`,
      )
      const result = skills.extractFrontmatter(filePath)
      expect(result.subtask).toBeUndefined()
    })

    test('strips quotes from argument-hint', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-skill
description: A test skill
argument-hint: '"[pattern]"'
---
# Skill Content`,
      )
      const result = skills.extractFrontmatter(filePath)
      expect(result.argumentHint).toBe('[pattern]')
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

      const result = skills.findSkillsInDir(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('my-skill')
    })

    test('returns empty array for non-existent directory', () => {
      const result = skills.findSkillsInDir('/nonexistent/path')
      expect(result).toEqual([])
    })

    test('uses directory name if no name in frontmatter', () => {
      const skillDir = path.join(testDir, 'unnamed-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Just content')

      const result = skills.findSkillsInDir(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('unnamed-skill')
    })
  })
})

describe('frontmatter', () => {
  describe('stripFrontmatter', () => {
    test('removes frontmatter from content', () => {
      const content = `---
name: test
---
# Content Here`
      const result = frontmatter.stripFrontmatter(content)
      expect(result).toBe('# Content Here')
    })

    test('returns content unchanged if no frontmatter', () => {
      const content = '# No frontmatter'
      const result = frontmatter.stripFrontmatter(content)
      expect(result).toBe('# No frontmatter')
    })
  })
})

describe('agents', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
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

      const result = agents.findAgentsInDir(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('my-agent')
    })
  })
})

describe('commands', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('findCommandsInDir', () => {
    test('finds command markdown files', () => {
      fs.writeFileSync(
        path.join(testDir, 'sys-test.md'),
        `---
name: sys-test
description: Test command
---
# Test Command`,
      )

      const result = commands.findCommandsInDir(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('/sys-test')
    })

    test('handles non-sys commands', () => {
      fs.writeFileSync(path.join(testDir, 'other-cmd.md'), '# Other')

      const result = commands.findCommandsInDir(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('/other-cmd')
    })
  })
})
