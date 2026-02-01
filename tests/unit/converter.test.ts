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

      test('preserves explicit frontmatter mode over option', () => {
        const input = `---
name: my-agent
description: Some agent
mode: primary
---
Content`
        const result = convertContent(input, 'agent', { agentMode: 'subagent' })
        expect(result).toContain('mode: primary')
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

      test('preserves top_p field', () => {
        const content = `---
name: test-agent
top_p: 0.9
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('top_p: 0.9')
      })

      test('preserves tools object', () => {
        const content = `---
name: test-agent
tools:
  read: true
  write: false
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('read: true')
        expect(result).toContain('write: false')
      })

      test('drops invalid tools map entries', () => {
        const content = `---
name: test-agent
tools:
  read: true
  write: maybe
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).not.toContain('tools:')
      })

      test('preserves disable field', () => {
        const content = `---
name: test-agent
disable: true
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('disable: true')
      })

      test('preserves color field', () => {
        const content = `---
name: test-agent
color: blue
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('color: blue')
      })

      test('preserves maxSteps field', () => {
        const content = `---
name: test-agent
maxSteps: 10
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('maxSteps: 10')
      })

      test('preserves permission object', () => {
        const content = `---
name: test-agent
permission:
  edit: allow
  bash: ask
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('edit: allow')
        expect(result).toContain('bash: ask')
      })

      test('drops invalid permission settings', () => {
        const content = `---
name: test-agent
permission:
  edit: maybe
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).not.toContain('permission:')
      })

      test('drops invalid permission bash map values', () => {
        const content = `---
name: test-agent
permission:
  bash:
    rm: maybe
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).not.toContain('permission:')
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

    describe('Skills and commands transformation', () => {
      test('removes CC-only fields from skill frontmatter', () => {
        const input = `---
name: my-skill
description: A skill
model: sonnet
allowed-tools: Read, Grep
disable-model-invocation: false
---
Skill content`
        const result = convertContent(input, 'skill')
        expect(result).toContain('name: my-skill')
        expect(result).toContain('description: A skill')
        expect(result).not.toContain('model:')
        expect(result).not.toContain('allowed-tools:')
        expect(result).not.toContain('disable-model-invocation:')
      })

      test('removes camelCase CC-only fields from skill frontmatter', () => {
        const input = `---
name: my-skill
description: A skill
allowedTools: Read, Grep
disableModelInvocation: false
userInvocable: true
---
Skill content`
        const result = convertContent(input, 'skill')
        expect(result).not.toContain('allowedTools:')
        expect(result).not.toContain('disableModelInvocation:')
        expect(result).not.toContain('userInvocable:')
      })

      test('removes context and agent fields from skill frontmatter', () => {
        const input = `---
name: my-skill
description: A skill
context: fork
agent: oracle
---
Skill content`
        const result = convertContent(input, 'skill')
        expect(result).not.toContain('context:')
        expect(result).not.toContain('agent:')
      })

      test('removes argument-hint from command frontmatter', () => {
        const input = `---
name: my-command
description: A command
argument-hint: <file>
---
Command content`
        const result = convertContent(input, 'command')
        expect(result).not.toContain('argument-hint:')
        expect(result).toContain('name: my-command')
      })

      test('normalizes model in command frontmatter', () => {
        const input = `---
name: my-command
description: A command
model: claude-sonnet-4-20250514
---
Command content`
        const result = convertContent(input, 'command')
        expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
      })

      test('removes inherit model from command frontmatter', () => {
        const input = `---
name: my-command
description: A command
model: inherit
---
Command content`
        const result = convertContent(input, 'command')
        expect(result).not.toContain('model:')
      })
    })

    describe('Body content transformations', () => {
      test('transforms tool names in body', () => {
        const input = `---
name: my-skill
description: A skill
---
Use TodoWrite to track progress.
Then use Task to spawn agents.
Use AskUserQuestion when unclear.`
        const result = convertContent(input, 'skill')
        expect(result).toContain('todowrite')
        expect(result).toContain('delegate_task')
        expect(result).toContain('question')
      })

      test('transforms path references in body', () => {
        const input = `---
name: my-skill
description: A skill
---
Check .claude/skills/ for other skills.
Also look in ~/.claude/ for user config.
Reference CLAUDE.md for setup.`
        const result = convertContent(input, 'skill')
        expect(result).toContain('.opencode/skills/')
        expect(result).toContain('~/.config/opencode/')
        expect(result).toContain('AGENTS.md')
      })

      test('transforms prefix references', () => {
        const input = `---
name: my-skill
description: A skill
---
Use /compound-engineering:skill-name to invoke.
The compound-engineering:brainstorming skill is useful.`
        const result = convertContent(input, 'skill')
        expect(result).toContain('/systematic:skill-name')
        expect(result).toContain('systematic:brainstorming')
      })

      test('transforms WebSearch and WebFetch', () => {
        const input = `---
name: my-skill
description: A skill
---
Use WebSearch to find info.
Use WebFetch to get page content.`
        const result = convertContent(input, 'skill')
        expect(result).toContain('google_search')
        expect(result).toContain('webfetch')
      })

      test('preserves Skill in non-tool contexts', () => {
        const input = `---
name: my-skill
description: A skill
---
This skill is powerful. Use the Skill tool to load skills.`
        const result = convertContent(input, 'skill')
        expect(result).toContain('This skill is powerful')
        expect(result).toContain('skill tool')
      })

      test('skips body transformation when option set', () => {
        const input = `---
name: my-skill
description: A skill
---
Use TodoWrite to track. Check .claude/skills/ for more.`
        const result = convertContent(input, 'skill', {
          skipBodyTransform: true,
        })
        expect(result).toContain('TodoWrite')
        expect(result).toContain('.claude/skills/')
      })

      test('transforms body for content without frontmatter', () => {
        const input = `Use TodoWrite to track. Check .claude/skills/ for more.`
        const result = convertContent(input, 'skill')
        expect(result).toContain('todowrite')
        expect(result).toContain('.opencode/skills/')
      })

      test('agent body is also transformed', () => {
        const input = `---
name: test-agent
description: Test
---
Use TodoWrite to track. Task explorer(find files). Check .claude/skills/.`
        const result = convertContent(input, 'agent')
        expect(result).toContain('todowrite')
        expect(result).toContain('delegate_task')
        expect(result).toContain('.opencode/skills/')
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

    describe('Malformed frontmatter handling', () => {
      test('returns original content when frontmatter is invalid', () => {
        const input = '---\nname: test\ninvalid yaml: [unclosed\n---\nBody'
        const result = convertContent(input, 'skill')
        expect(result).toBe(input)
      })
    })

    describe('Combined transformations', () => {
      test('produces correct output format for agent with transformed body', () => {
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
        expect(result).toContain('Use todowrite to track')
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
