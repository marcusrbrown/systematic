import { describe, expect, test } from 'bun:test'
import {
  formatFrontmatter,
  parseFrontmatter,
  stripFrontmatter,
} from '../../src/lib/frontmatter.ts'

describe('frontmatter', () => {
  describe('parseFrontmatter', () => {
    describe('valid frontmatter', () => {
      test('parses simple key-value pairs', () => {
        const content = `---
name: test-skill
description: A test skill
---
# Content`
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(true)
        expect(result.parseError).toBe(false)
        expect(result.data).toEqual({
          name: 'test-skill',
          description: 'A test skill',
        })
        expect(result.body).toBe('# Content')
      })

      test('parses hyphenated keys', () => {
        const content = `---
argument-hint: "[file path]"
allowed-tools: Read, Write
---
Body`
        const result = parseFrontmatter<{
          'argument-hint': string
          'allowed-tools': string
        }>(content)
        expect(result.hadFrontmatter).toBe(true)
        expect(result.parseError).toBe(false)
        expect(result.data['argument-hint']).toBe('[file path]')
        expect(result.data['allowed-tools']).toBe('Read, Write')
      })

      test('parses boolean values', () => {
        const content = `---
enabled: true
disabled: false
---
Body`
        const result = parseFrontmatter<{
          enabled: boolean
          disabled: boolean
        }>(content)
        expect(result.data.enabled).toBe(true)
        expect(result.data.disabled).toBe(false)
      })

      test('parses numeric values', () => {
        const content = `---
temperature: 0.7
count: 42
---
Body`
        const result = parseFrontmatter<{ temperature: number; count: number }>(
          content,
        )
        expect(result.data.temperature).toBe(0.7)
        expect(result.data.count).toBe(42)
      })

      test('parses quoted strings', () => {
        const content = `---
name: "quoted value"
description: 'single quoted'
---
Body`
        const result = parseFrontmatter(content)
        expect(result.data).toEqual({
          name: 'quoted value',
          description: 'single quoted',
        })
      })

      test('preserves body content exactly', () => {
        const content = `---
name: test
---
Line 1
Line 2

Line 4`
        const result = parseFrontmatter(content)
        expect(result.body).toBe('Line 1\nLine 2\n\nLine 4')
      })

      test('handles Windows line endings', () => {
        const content = '---\r\nname: test\r\n---\r\nBody content'
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(true)
        expect(result.data).toEqual({ name: 'test' })
        expect(result.body).toBe('Body content')
      })
    })

    describe('edge cases', () => {
      test('returns hadFrontmatter: false when no delimiters', () => {
        const content = '# Just a heading\nSome content'
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(false)
        expect(result.parseError).toBe(false)
        expect(result.body).toBe(content)
        expect(result.data).toEqual({})
      })

      test('returns hadFrontmatter: false when only opening delimiter', () => {
        const content = '---\nname: test\n# No closing delimiter'
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(false)
        expect(result.body).toBe(content)
      })

      test('handles empty frontmatter', () => {
        const content = `---
---
# Content`
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(true)
        expect(result.parseError).toBe(false)
        expect(result.data).toEqual({})
      })

      test('handles empty content', () => {
        const result = parseFrontmatter('')
        expect(result.hadFrontmatter).toBe(false)
        expect(result.body).toBe('')
        expect(result.data).toEqual({})
      })

      test('handles frontmatter with only newline before closing', () => {
        const content = `---
name: test
---
Body`
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(true)
        expect(result.data).toEqual({ name: 'test' })
      })
    })

    describe('error handling', () => {
      test('sets parseError: true for malformed YAML', () => {
        const content = `---
key: value
  invalid: indentation
---
Body`
        const result = parseFrontmatter(content)
        expect(result.hadFrontmatter).toBe(true)
        expect(result.parseError).toBe(true)
        expect(result.data).toEqual({})
      })

      test('returns empty data on parse error', () => {
        const content = `---
[invalid yaml
---
Body`
        const result = parseFrontmatter(content)
        expect(result.parseError).toBe(true)
        expect(result.data).toEqual({})
        expect(result.body).toBe('Body')
      })
    })

    describe('generic type support', () => {
      interface SkillFrontmatter {
        name: string
        description: string
      }

      test('supports typed frontmatter extraction', () => {
        const content = `---
name: my-skill
description: A skill description
---
Body`
        const result = parseFrontmatter<SkillFrontmatter>(content)
        expect(result.data.name).toBe('my-skill')
        expect(result.data.description).toBe('A skill description')
      })
    })
  })

  describe('formatFrontmatter', () => {
    test('formats key-value pairs', () => {
      const data = { name: 'test', count: 5, enabled: true }
      const result = formatFrontmatter(data)
      expect(result).toBe('---\nname: test\ncount: 5\nenabled: true\n---')
    })

    test('handles empty data', () => {
      const result = formatFrontmatter({})
      expect(result).toBe('---\n---')
    })
  })

  describe('stripFrontmatter', () => {
    test('removes frontmatter from content', () => {
      const content = `---
name: test
---
# Content Here`
      const result = stripFrontmatter(content)
      expect(result).toBe('# Content Here')
    })

    test('returns content unchanged if no frontmatter', () => {
      const content = '# No frontmatter'
      const result = stripFrontmatter(content)
      expect(result).toBe('# No frontmatter')
    })

    test('trims whitespace from body', () => {
      const content = `---
name: test
---

Content with leading newline`
      const result = stripFrontmatter(content)
      expect(result).toBe('Content with leading newline')
    })
  })
})
