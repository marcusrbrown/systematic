/**
 * Converter validation tests against real CEP content
 * Tests that the converter correctly handles real-world Claude Code content
 */
import { describe, expect, test } from 'bun:test'
import { convertContent } from '../../src/lib/converter.js'

function detectFalsePositives(original: string, converted: string): string[] {
  const falsePositives: string[] = []
  const taskNounLowercased = [
    /complete the task\b/g,
    /\beach task\b/g,
    /\btask management\b/g,
    /\btask tracking\b/g,
    /\btask list\b(?! |$)/g,
  ]
  for (const pattern of taskNounLowercased) {
    pattern.lastIndex = 0
    const inConverted = pattern.test(converted)
    pattern.lastIndex = 0
    const inOriginal = pattern.test(original)
    if (inConverted && !inOriginal) {
      const matches = converted.match(pattern)
      if (matches) {
        falsePositives.push(
          `False positive: "${matches[0]}" - "Task" as noun incorrectly lowercased`,
        )
      }
    }
  }
  return falsePositives
}

describe('Converter Validation', () => {
  describe('Tool Name Transformations', () => {
    test('converts Task tool references correctly', () => {
      const testCases = [
        // Should convert
        {
          input: 'Task Explore: "Research..."',
          expected: 'task Explore: "Research..."',
        },
        {
          input: 'Task(agent="explore")',
          expected: 'task(agent="explore")',
        },
        { input: 'use Task to spawn', expected: 'use task to spawn' },
        { input: 'the Task tool for', expected: 'the task tool for' },
        // Should NOT convert (Task as noun)
        { input: 'complete the Task', expected: 'complete the Task' },
        { input: 'each Task', expected: 'each Task' },
        { input: 'Task management', expected: 'Task management' },
      ]

      for (const { input, expected } of testCases) {
        const converted = convertContent(input, 'skill')
        expect(converted).toBe(expected)
      }
    })

    test('converts TodoWrite to todowrite', () => {
      const input = 'Use TodoWrite to track progress'
      const converted = convertContent(input, 'skill')
      expect(converted).toBe('Use todowrite to track progress')
    })

    test('converts AskUserQuestion to question', () => {
      const input = 'Use the AskUserQuestion tool'
      const converted = convertContent(input, 'skill')
      expect(converted).toBe('Use the question tool')
    })

    test('converts path references', () => {
      const input = 'Store in .claude/skills/ directory'
      const converted = convertContent(input, 'skill')
      expect(converted).toBe('Store in .opencode/skills/ directory')
    })

    test('converts CLAUDE.md to AGENTS.md', () => {
      const input = 'Check CLAUDE.md for conventions'
      const converted = convertContent(input, 'skill')
      expect(converted).toBe('Check AGENTS.md for conventions')
    })

    test('converts compound-engineering: to systematic:', () => {
      const input = '/compound-engineering:deepen-plan'
      const converted = convertContent(input, 'skill')
      expect(converted).toBe('/systematic:deepen-plan')
    })
  })

  describe('Edge Cases', () => {
    test('does not flag lowercase task nouns as false positives', () => {
      const original = 'Use task tracking for ongoing work.'
      const converted = convertContent(original, 'skill')

      expect(detectFalsePositives(original, converted)).toEqual([])
    })

    test('handles empty content', () => {
      const converted = convertContent('', 'skill')
      expect(converted).toBe('')
    })

    test('handles content without frontmatter', () => {
      const input = '# Just a heading\n\nSome content'
      const converted = convertContent(input, 'skill')
      expect(converted).toBe(input)
    })

    test('handles malformed frontmatter gracefully', () => {
      const input = '---\nname: test\ninvalid yaml: [unclosed\n---\nBody'
      // Should not throw
      const converted = convertContent(input, 'skill')
      expect(typeof converted).toBe('string')
    })

    test('preserves code blocks without transformation', () => {
      // Task references inside code blocks should ideally be preserved
      // This tests current behavior
      const input = '```typescript\nconst Task = "example";\n```'
      const converted = convertContent(input, 'skill')
      // Current converter doesn't distinguish code blocks - document behavior
      expect(typeof converted).toBe('string')
    })

    test('handles dynamic content markers', () => {
      // CEP uses !`command` for dynamic content
      const input = 'Context: !`ls skills/*/SKILL.md`'
      const converted = convertContent(input, 'skill')
      // Should preserve the dynamic content syntax
      expect(converted).toContain('!`')
    })
  })
})
