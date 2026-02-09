import { describe, expect, test } from 'bun:test'
import { extractAgentFrontmatter } from '../../src/lib/agents.js'

describe('extractAgentFrontmatter', () => {
  test('extracts name from frontmatter', () => {
    const content = `---
name: security-sentinel
description: Security review agent
---
Be a security expert.`
    const result = extractAgentFrontmatter(content)
    expect(result.name).toBe('security-sentinel')
  })

  test('extracts description from frontmatter', () => {
    const content = `---
name: security-sentinel
description: Security review agent
---
Be a security expert.`
    const result = extractAgentFrontmatter(content)
    expect(result.description).toBe('Security review agent')
  })

  test('extracts prompt (body content)', () => {
    const content = `---
name: security-sentinel
description: Security review agent
---
Be a security expert.`
    const result = extractAgentFrontmatter(content)
    expect(result.prompt.trim()).toBe('Be a security expert.')
  })

  test('handles missing frontmatter gracefully', () => {
    const content = 'Be a security expert.'
    const result = extractAgentFrontmatter(content)
    expect(result.name).toBe('')
    expect(result.description).toBe('')
    expect(result.prompt.trim()).toBe('Be a security expert.')
  })

  test('handles empty/malformed frontmatter', () => {
    const content = `---
malformed
---
Be a security expert.`
    const result = extractAgentFrontmatter(content)
    expect(result.name).toBe('')
    expect(result.description).toBe('')
    expect(result.prompt.trim()).toBe('Be a security expert.')
  })

  describe('new fields (Task 3)', () => {
    test('extracts model', () => {
      const content = '---\nmodel: gpt-4o\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.model).toBe('gpt-4o')
    })

    test('extracts temperature', () => {
      const content = '---\ntemperature: 0.7\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.temperature).toBe(0.7)
    })

    test('extracts top_p', () => {
      const content = '---\ntop_p: 0.9\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.top_p).toBe(0.9)
    })

    test('extracts tools', () => {
      const content = '---\ntools:\n  bash: true\n  read: false\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.tools).toEqual({ bash: true, read: false })
    })

    test('ignores tools with non-boolean values', () => {
      const content = '---\ntools:\n  bash: true\n  read: "yes"\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.tools).toBeUndefined()
    })

    test('extracts disable', () => {
      const content = '---\ndisable: true\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.disable).toBe(true)
    })

    test('extracts mode', () => {
      const content = '---\nmode: subagent\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.mode).toBe('subagent')
    })

    test('extracts color', () => {
      const content = '---\ncolor: "#ff0000"\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.color).toBe('#ff0000')
    })

    test('extracts steps', () => {
      const content = '---\nsteps: 10\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.steps).toBe(10)
    })

    test('extracts permission', () => {
      const content =
        '---\npermission:\n  edit: allow\n  bash: ask\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toEqual({ edit: 'allow', bash: 'ask' })
    })

    test('extracts per-command bash permission', () => {
      const content = '---\npermission:\n  bash:\n    rm: deny\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toEqual({ bash: { rm: 'deny' } })
    })

    test('ignores permission with invalid settings', () => {
      const content = '---\npermission:\n  edit: maybe\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toBeUndefined()
    })

    test('ignores permission with invalid bash map values', () => {
      const content = '---\npermission:\n  bash:\n    rm: maybe\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toBeUndefined()
    })

    test('extracts mode: all', () => {
      const content = '---\nmode: all\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.mode).toBe('all')
    })

    test('extracts mode: primary', () => {
      const content = '---\nmode: primary\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.mode).toBe('primary')
    })

    test('ignores invalid mode values', () => {
      const content = '---\nmode: invalid\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.mode).toBeUndefined()
    })

    test('extracts all permission fields', () => {
      const content = `---
permission:
  edit: allow
  bash: deny
  webfetch: ask
  doom_loop: allow
  external_directory: deny
---
Prompt`
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toEqual({
        edit: 'allow',
        bash: 'deny',
        webfetch: 'ask',
        doom_loop: 'allow',
        external_directory: 'deny',
      })
    })

    test('returns undefined permission for empty permission object', () => {
      const content = '---\npermission: {}\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toBeUndefined()
    })

    test('ignores unknown permission keys', () => {
      const content =
        '---\npermission:\n  edit: allow\n  unknown: maybe\n---\nPrompt'
      const result = extractAgentFrontmatter(content)
      expect(result.permission).toEqual({ edit: 'allow' })
    })
  })
})
