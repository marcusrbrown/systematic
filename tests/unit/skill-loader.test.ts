import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractSkillBody,
  formatSkillCommandName,
  formatSkillDescription,
  loadSkill,
  wrapSkillTemplate,
} from '../../src/lib/skill-loader.ts'
import type { SkillInfo } from '../../src/lib/skills.ts'

describe('skill-loader', () => {
  describe('formatSkillCommandName', () => {
    test('adds systematic: prefix to plain name', () => {
      expect(formatSkillCommandName('brainstorming')).toBe(
        'systematic:brainstorming',
      )
    })

    test('does not double-prefix already prefixed name', () => {
      expect(formatSkillCommandName('systematic:brainstorming')).toBe(
        'systematic:brainstorming',
      )
    })

    test('handles empty string', () => {
      expect(formatSkillCommandName('')).toBe('systematic:')
    })
  })

  describe('formatSkillDescription', () => {
    test('adds (Systematic - Skill) prefix to description', () => {
      expect(formatSkillDescription('A test skill', 'test')).toBe(
        '(Systematic - Skill) A test skill',
      )
    })

    test('does not double-prefix already prefixed description', () => {
      expect(
        formatSkillDescription('(Systematic - Skill) A test skill', 'test'),
      ).toBe('(Systematic - Skill) A test skill')
    })

    test('uses fallback name when description is empty', () => {
      expect(formatSkillDescription('', 'my-skill')).toBe(
        '(Systematic - Skill) my-skill skill',
      )
    })
  })

  describe('wrapSkillTemplate', () => {
    test('wraps content in skill-instruction tags', () => {
      const result = wrapSkillTemplate(
        '/path/to/skill/SKILL.md',
        '# Skill Body',
      )
      expect(result).toContain('<skill-instruction>')
      expect(result).toContain('</skill-instruction>')
      expect(result).toContain('# Skill Body')
    })

    test('includes base directory from skill path', () => {
      const result = wrapSkillTemplate(
        '/bundled/skills/brainstorming/SKILL.md',
        '# Content',
      )
      expect(result).toContain(
        'Base directory for this skill: /bundled/skills/brainstorming/',
      )
    })

    test('includes file reference note', () => {
      const result = wrapSkillTemplate('/path/to/skill/SKILL.md', '# Content')
      expect(result).toContain(
        'File references (@path) in this skill are relative to this directory',
      )
    })

    test('trims body content', () => {
      const result = wrapSkillTemplate(
        '/path/to/skill/SKILL.md',
        '  \n# Skill Body\n  ',
      )
      expect(result).toContain('# Skill Body')
      expect(result).not.toMatch(/\n\s+\n<\/skill-instruction>/)
    })
  })

  describe('extractSkillBody', () => {
    test('extracts body from wrapped template', () => {
      const wrapped = `<skill-instruction>
Base directory for this skill: /path/to/skill/
File references (@path) in this skill are relative to this directory.

# Skill Body

Some content here.
</skill-instruction>`

      const result = extractSkillBody(wrapped)
      expect(result).toContain('# Skill Body')
      expect(result).toContain('Some content here.')
      expect(result).not.toContain('<skill-instruction>')
      expect(result).not.toContain('</skill-instruction>')
    })

    test('returns original content if no wrapper tags', () => {
      const unwrapped = '# Just raw content'
      expect(extractSkillBody(unwrapped)).toBe('# Just raw content')
    })

    test('trims extracted body', () => {
      const wrapped = `<skill-instruction>

  # Body

</skill-instruction>`

      const result = extractSkillBody(wrapped)
      expect(result).toBe('# Body')
    })
  })

  describe('loadSkill', () => {
    let testDir: string

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-test-'))
      fs.mkdirSync(path.join(testDir, 'test-skill'), { recursive: true })
    })

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true })
    })

    test('loads skill with all properties', () => {
      const skillFile = path.join(testDir, 'test-skill', 'SKILL.md')
      fs.writeFileSync(
        skillFile,
        `---
name: test-skill
description: A test skill
---
# Test Content`,
      )

      const skillInfo: SkillInfo = {
        name: 'test-skill',
        description: 'A test skill',
        path: path.join(testDir, 'test-skill'),
        skillFile,
      }

      const loaded = loadSkill(skillInfo)

      expect(loaded).not.toBeNull()
      if (loaded == null) {
        throw new Error('Expected skill to load')
      }

      expect(loaded.name).toBe('test-skill')
      expect(loaded.prefixedName).toBe('systematic:test-skill')
      expect(loaded.description).toBe('(Systematic - Skill) A test skill')
      expect(loaded.wrappedTemplate).toContain('<skill-instruction>')
      expect(loaded.wrappedTemplate).toContain('# Test Content')
    })

    test('returns null for non-existent file', () => {
      const skillInfo: SkillInfo = {
        name: 'missing',
        description: '',
        path: path.join(testDir, 'missing'),
        skillFile: path.join(testDir, 'missing', 'SKILL.md'),
      }

      expect(loadSkill(skillInfo)).toBeNull()
    })

    test('wraps and extracts consistently (roundtrip)', () => {
      const skillFile = path.join(testDir, 'test-skill', 'SKILL.md')
      fs.writeFileSync(
        skillFile,
        `---
name: test-skill
description: A test skill
---
# Original Body

Content here.`,
      )

      const skillInfo: SkillInfo = {
        name: 'test-skill',
        description: 'A test skill',
        path: path.join(testDir, 'test-skill'),
        skillFile,
      }

      const loaded = loadSkill(skillInfo)
      if (loaded == null) {
        throw new Error('Expected skill to load')
      }

      const extracted = extractSkillBody(loaded.wrappedTemplate)

      expect(extracted).toContain('# Original Body')
      expect(extracted).toContain('Content here.')
      expect(extracted).not.toContain('name: test-skill')
    })
  })
})
