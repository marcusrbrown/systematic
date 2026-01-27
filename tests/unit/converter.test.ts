import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearConverterCache,
  convertContent,
  convertFileWithCache,
} from '../../src/lib/converter.ts'

describe('converter', () => {
  describe('convertContent', () => {
    describe('Agent frontmatter transformation', () => {
      test('removes name field and adds mode field', () => {
        const input = `---
name: security-sentinel
description: Security review agent
---
Agent content`
        const result = convertContent(input, 'agent')
        expect(result).not.toContain('name:')
        expect(result).toContain('mode: subagent')
        expect(result).toContain('description: Security review agent')
      })

      test('uses agentMode option when provided', () => {
        const input = `---
name: my-agent
description: Primary agent
---
Content`
        const result = convertContent(input, 'agent', { agentMode: 'primary' })
        expect(result).toContain('mode: primary')
      })

      test('defaults to subagent mode', () => {
        const input = `---
name: my-agent
description: Some agent
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('mode: subagent')
      })

      test('normalizes unprefixed claude model', () => {
        const input = `---
name: test-agent
description: Test
model: claude-sonnet-4-20250514
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
      })

      test('normalizes unprefixed openai model', () => {
        const input = `---
name: test-agent
description: Test
model: gpt-4o
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('model: openai/gpt-4o')
      })

      test('normalizes unprefixed gemini model', () => {
        const input = `---
name: test-agent
description: Test
model: gemini-2.0-flash
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('model: google/gemini-2.0-flash')
      })

      test('preserves already-prefixed model', () => {
        const input = `---
name: test-agent
description: Test
model: anthropic/claude-sonnet-4-20250514
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
      })

      test('does not include model: inherit in output', () => {
        const input = `---
name: test-agent
description: Test
model: inherit
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).not.toContain('model:')
      })
    })

    describe('Agent temperature inference', () => {
      test('infers low temperature for security agents', () => {
        const input = `---
name: security-sentinel
description: Security review agent
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('temperature: 0.1')
      })

      test('infers medium-low temperature for planning agents', () => {
        const input = `---
name: architecture-strategist
description: Architecture planning
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('temperature: 0.2')
      })

      test('infers medium temperature for documentation agents', () => {
        const input = `---
name: readme-writer
description: Documentation writer
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('temperature: 0.3')
      })

      test('infers higher temperature for creative agents', () => {
        const input = `---
name: brainstorm-helper
description: Creative brainstorming
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('temperature: 0.6')
      })

      test('preserves explicit temperature', () => {
        const input = `---
name: security-sentinel
description: Security
temperature: 0.5
---
Content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('temperature: 0.5')
        expect(result).not.toContain('temperature: 0.1')
      })
    })

    describe('Skills and commands - no transformation', () => {
      test('returns skill content unchanged', () => {
        const input = `---
name: my-skill
description: A skill
---
Skill content`
        const result = convertContent(input, 'skill')
        expect(result).toBe(input)
      })

      test('returns command content unchanged', () => {
        const input = `---
name: my-command
description: A command
---
Command content`
        const result = convertContent(input, 'command')
        expect(result).toBe(input)
      })
    })

    describe('Body content - no transformation', () => {
      test('agent body is not transformed', () => {
        const input = `---
name: test-agent
description: Test
---
Use TodoWrite to track. Task explorer(find files). Use Skill tool.`
        const result = convertContent(input, 'agent')
        expect(result).toContain('Use TodoWrite to track')
        expect(result).toContain('Task explorer(find files)')
        expect(result).toContain('Use Skill tool')
      })
    })

    describe('Content without frontmatter', () => {
      test('returns content unchanged if no frontmatter', () => {
        const input = `# No Frontmatter
Just plain content`
        const result = convertContent(input, 'skill')
        expect(result).toBe(input)
      })

      test('handles empty content', () => {
        const result = convertContent('', 'skill')
        expect(result).toBe('')
      })
    })

    describe('Combined transformations', () => {
      test('produces correct output format for agent', () => {
        const input = `---
name: review-agent
description: Code review agent
model: claude-sonnet-4-20250514
---
# Review Agent

Use TodoWrite to track.`
        const result = convertContent(input, 'agent')

        expect(result).toContain('description: Code review agent')
        expect(result).toContain('mode: subagent')
        expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
        expect(result).toContain('temperature: 0.1')
        expect(result).not.toContain('name:')
        expect(result).toContain('# Review Agent')
        expect(result).toContain('Use TodoWrite to track')
      })
    })
  })

  describe('convertFileWithCache', () => {
    let testDir: string

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'converter-test-'))
      clearConverterCache()
    })

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true })
      clearConverterCache()
    })

    test('converts file content and returns result', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-agent
description: Test
model: claude-sonnet-4-20250514
---
Content`,
      )

      const result = convertFileWithCache(filePath, 'agent')
      expect(result).toContain('mode: subagent')
      expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
    })

    test('caches result for same file and mtime', () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-agent
description: Test
---
Content`,
      )

      const result1 = convertFileWithCache(filePath, 'agent')
      const result2 = convertFileWithCache(filePath, 'agent')
      expect(result2).toBe(result1)
    })

    test('invalidates cache when file mtime changes', async () => {
      const filePath = path.join(testDir, 'test.md')
      fs.writeFileSync(
        filePath,
        `---
name: test-agent
description: Test
model: claude-sonnet-4-20250514
---
Content`,
      )

      const result1 = convertFileWithCache(filePath, 'agent')
      expect(result1).toContain('model: anthropic/claude-sonnet-4-20250514')

      await new Promise((resolve) => setTimeout(resolve, 50))

      fs.writeFileSync(
        filePath,
        `---
name: test-agent
description: Test
model: gpt-4o
---
Content`,
      )

      const result2 = convertFileWithCache(filePath, 'agent')
      expect(result2).toContain('model: openai/gpt-4o')
    })

    test('throws for non-existent file', () => {
      const filePath = path.join(testDir, 'nonexistent.md')
      expect(() => convertFileWithCache(filePath, 'skill')).toThrow()
    })
  })
})
