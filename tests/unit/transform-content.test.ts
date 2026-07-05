import { describe, expect, test } from 'bun:test'
import { generateDefinitionHeader } from '../../docs/scripts/transform-content.ts'

describe('generateDefinitionHeader', () => {
  const baseOptions = {
    sourcePath: 'skills/git-commit/SKILL.md',
  }

  describe('skill install command', () => {
    test('happy path: non-deprecated skill emits --skill <name>', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        name: 'git-commit',
        definitionType: 'skill',
      })
      expect(result).toContain('--skill git-commit')
      expect(result).toContain('npx skills add marcusrbrown/systematic')
    })

    test('edge: colon-form name passes through verbatim', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        sourcePath: 'skills/ce-plan/SKILL.md',
        name: 'ce:plan',
        definitionType: 'skill',
      })
      expect(result).toContain('--skill ce:plan')
      // must not be escaped or quoted
      expect(result).not.toContain('--skill "ce:plan"')
      expect(result).not.toContain("--skill 'ce:plan'")
      expect(result).not.toContain('--skill ce%3Aplan')
    })

    test('edge: name falls back to dir basename and emits valid command', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        sourcePath: 'skills/my-skill/SKILL.md',
        name: 'my-skill',
        definitionType: 'skill',
      })
      expect(result).toContain(
        'npx skills add marcusrbrown/systematic --skill my-skill',
      )
    })

    test('error path: deprecated skill emits NO install command', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        name: 'orchestrating-subagents',
        definitionType: 'skill',
        deprecated: true,
      })
      expect(result).not.toContain('npx skills')
      expect(result).not.toContain('--skill')
    })

    test('skills-only: agent definition emits NO install command', () => {
      const result = generateDefinitionHeader({
        sourcePath: 'agents/review/reviewer.md',
        name: 'reviewer',
        definitionType: 'agent',
        category: 'Review',
      })
      expect(result).not.toContain('npx skills')
      expect(result).not.toContain('--skill')
    })
  })

  describe('existing header structure', () => {
    test('always includes View source link', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        name: 'git-commit',
        definitionType: 'skill',
      })
      expect(result).toContain('View source')
      expect(result).toContain('definition-source')
    })

    test('includes category span when category is provided', () => {
      const result = generateDefinitionHeader({
        sourcePath: 'agents/review/reviewer.md',
        name: 'reviewer',
        definitionType: 'agent',
        category: 'Review',
      })
      expect(result).toContain('definition-category')
      expect(result).toContain('Review')
    })

    test('omits category span when category is absent', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        name: 'git-commit',
        definitionType: 'skill',
      })
      expect(result).not.toContain('definition-category')
    })

    test('install command is a fenced bash code block', () => {
      const result = generateDefinitionHeader({
        ...baseOptions,
        name: 'git-commit',
        definitionType: 'skill',
      })
      expect(result).toContain('```bash')
      expect(result).toContain('```')
    })
  })
})
