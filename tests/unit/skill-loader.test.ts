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
      expect(formatSkillCommandName('onboarding')).toBe('systematic:onboarding')
    })

    test('does not double-prefix already prefixed name', () => {
      expect(formatSkillCommandName('systematic:onboarding')).toBe(
        'systematic:onboarding',
      )
    })

    test('preserves names with a non-systematic colon prefix', () => {
      expect(formatSkillCommandName('ce:plan')).toBe('ce:plan')
      expect(formatSkillCommandName('ce:brainstorm')).toBe('ce:brainstorm')
    })

    test('handles empty string', () => {
      expect(formatSkillCommandName('')).toBe('systematic:')
    })
  })

  describe('formatSkillDescription', () => {
    test('adds (Systematic) prefix to description', () => {
      expect(formatSkillDescription('A test skill', 'test')).toBe(
        '(Systematic) A test skill',
      )
    })

    test('does not double-prefix already prefixed description', () => {
      expect(formatSkillDescription('(Systematic) A test skill', 'test')).toBe(
        '(Systematic) A test skill',
      )
    })

    test('uses fallback name when description is empty', () => {
      expect(formatSkillDescription('', 'my-skill')).toBe(
        '(Systematic) my-skill skill',
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
      expect(loaded.description).toBe('(Systematic) A test skill')
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

    test('loads the real bundled todos skill with merged create/triage/resolve sections', () => {
      const realSkillDir = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../../skills/todos',
      )
      const skillFile = path.join(realSkillDir, 'SKILL.md')

      const skillInfo: SkillInfo = {
        name: 'todos',
        description: '',
        path: realSkillDir,
        skillFile,
      }

      const loaded = loadSkill(skillInfo)

      expect(loaded).not.toBeNull()
      if (loaded == null) {
        throw new Error('Expected todos skill to load')
      }

      expect(loaded.name).toBe('todos')
      expect(loaded.description.length).toBeGreaterThan(0)
      expect(loaded.wrappedTemplate).toContain('## Create')
      expect(loaded.wrappedTemplate).toContain('## Triage')
      expect(loaded.wrappedTemplate).toContain('## Resolve')
    })

    // Characterization: pins the exact loaded body + frontmatter for a
    // representative real bundled skill (onboarding). Must pass before AND
    // after Unit 2's converter removal — proves the direct fs.readFileSync
    // path produces the same result as the convertFileWithCache path did.
    test('loads the real bundled onboarding skill with expected body and description', () => {
      const realSkillDir = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../../skills/onboarding',
      )
      const skillFile = path.join(realSkillDir, 'SKILL.md')

      const skillInfo: SkillInfo = {
        name: 'onboarding',
        description:
          "Generate or regenerate ONBOARDING.md to help new contributors understand a codebase. Use when the user asks to 'create onboarding docs', 'generate ONBOARDING.md', 'document this project for new developers', 'write onboarding documentation', 'vonboard', 'vonboarding', 'prepare this repo for a new contributor', 'refresh the onboarding doc', or 'update ONBOARDING.md'. Also use when someone needs to onboard a new team member and wants a written artifact, or when a codebase lacks onboarding documentation and the user wants to generate one.",
        path: realSkillDir,
        skillFile,
      }

      const loaded = loadSkill(skillInfo)

      expect(loaded).not.toBeNull()
      if (loaded == null) {
        throw new Error('Expected onboarding skill to load')
      }

      expect(loaded.name).toBe('onboarding')
      expect(loaded.prefixedName).toBe('systematic:onboarding')
      expect(loaded.description).toBe(
        "(Systematic) Generate or regenerate ONBOARDING.md to help new contributors understand a codebase. Use when the user asks to 'create onboarding docs', 'generate ONBOARDING.md', 'document this project for new developers', 'write onboarding documentation', 'vonboard', 'vonboarding', 'prepare this repo for a new contributor', 'refresh the onboarding doc', or 'update ONBOARDING.md'. Also use when someone needs to onboard a new team member and wants a written artifact, or when a codebase lacks onboarding documentation and the user wants to generate one.",
      )
      expect(loaded.wrappedTemplate).toContain('# Generate Onboarding Document')
      expect(loaded.wrappedTemplate).toContain(
        'Crawl a repository and generate `ONBOARDING.md` at the repo root',
      )
      expect(loaded.subtask).toBeUndefined()
      expect(loaded.agent).toBeUndefined()
      expect(loaded.model).toBeUndefined()
    })
  })
})
