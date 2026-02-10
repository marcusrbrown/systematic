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
      test('preserves name field and adds mode field', () => {
        const input = `---
name: security-sentinel
description: Security review agent
---
Agent content`
        const result = convertContent(input, 'agent')
        expect(result).toContain('name: security-sentinel')
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

      test('preserves non-boolean tools map as-is', () => {
        const content = `---
name: test-agent
tools:
  read: true
  write: maybe
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('read: true')
        expect(result).toContain('write: maybe')
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

      test('maps maxSteps to steps', () => {
        const content = `---
name: test-agent
maxSteps: 10
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('steps: 10')
        expect(result).not.toContain('maxSteps:')
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

      test('preserves invalid permission settings as-is', () => {
        const content = `---
name: test-agent
permission:
  edit: maybe
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('edit: maybe')
      })

      test('preserves invalid permission bash map values as-is', () => {
        const content = `---
name: test-agent
permission:
  bash:
    rm: maybe
---
Prompt`
        const result = convertContent(content, 'agent')
        expect(result).toContain('rm: maybe')
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
      test('preserves CC fields in skill frontmatter and normalizes model', () => {
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
        expect(result).toContain('model: anthropic/sonnet')
        expect(result).toContain('allowed-tools:')
        expect(result).toContain('disable-model-invocation: false')
      })

      test('preserves camelCase CC fields in skill frontmatter', () => {
        const input = `---
name: my-skill
description: A skill
allowedTools: Read, Grep
disableModelInvocation: false
userInvocable: true
---
Skill content`
        const result = convertContent(input, 'skill')
        expect(result).toContain('allowedTools:')
        expect(result).toContain('disableModelInvocation: false')
        expect(result).toContain('userInvocable: true')
      })

      test('preserves context and agent fields, maps fork to subtask', () => {
        const input = `---
name: my-skill
description: A skill
context: fork
agent: oracle
---
Skill content`
        const result = convertContent(input, 'skill')
        expect(result).toContain('context: fork')
        expect(result).toContain('agent: oracle')
        expect(result).toContain('subtask: true')
      })

      test('preserves argument-hint in command frontmatter', () => {
        const input = `---
name: my-command
description: A command
argument-hint: <file>
---
Command content`
        const result = convertContent(input, 'command')
        expect(result).toContain('argument-hint:')
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
      test('transforms body even when frontmatter has parse error', () => {
        const input =
          '---\nname: test\ninvalid yaml: [unclosed\n---\nUse TodoWrite to track.'
        const result = convertContent(input, 'skill')
        expect(result).toContain('todowrite')
      })

      test('returns original content on parse error when body transform skipped', () => {
        const input = '---\nname: test\ninvalid yaml: [unclosed\n---\nBody'
        const result = convertContent(input, 'skill', {
          skipBodyTransform: true,
        })
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

        expect(result).toContain('name: review-agent')
        expect(result).toContain('description: Code review agent')
        expect(result).toContain('mode: subagent')
        expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
        expect(result).toContain('temperature: 0.1')
        expect(result).toContain('# Review Agent')
        expect(result).toContain('Use todowrite to track')
      })
    })

    describe('Field mapping', () => {
      describe('tools array → map', () => {
        test('converts CC tools array to OC tools map', () => {
          const input = `---
name: test-agent
tools:
  - Read
  - Grep
  - Bash
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('read: true')
          expect(result).toContain('grep: true')
          expect(result).toContain('bash: true')
        })

        test('handles empty tools array', () => {
          const input = `---
name: test-agent
tools: []
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).not.toContain('tools:')
        })

        test('canonicalizes tool names to lowercase', () => {
          const input = `---
name: test-agent
tools:
  - READ
  - BASH
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('read: true')
          expect(result).toContain('bash: true')
        })

        test('applies tool renames (WebSearch → google_search)', () => {
          const input = `---
name: test-agent
tools:
  - WebSearch
  - Task
  - AskUserQuestion
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('google_search: true')
          expect(result).toContain('delegate_task: true')
          expect(result).toContain('question: true')
        })

        test('leaves non-boolean tools object untouched', () => {
          const input = `---
name: test-agent
tools:
  bash: allow
  read: deny
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('bash: allow')
          expect(result).toContain('read: deny')
        })
      })

      describe('disallowedTools', () => {
        test('converts disallowedTools to false entries in tools map', () => {
          const input = `---
name: test-agent
disallowedTools:
  - Write
  - Bash
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('write: false')
          expect(result).toContain('bash: false')
          expect(result).not.toContain('disallowedTools:')
        })

        test('disallowed overrides allowed on conflict', () => {
          const input = `---
name: test-agent
tools:
  - Bash
  - Read
disallowedTools:
  - Bash
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('bash: false')
          expect(result).toContain('read: true')
        })

        test('merges disallowedTools into existing tools map', () => {
          const input = `---
name: test-agent
tools:
  read: true
  bash: true
disallowedTools:
  - Write
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('read: true')
          expect(result).toContain('bash: true')
          expect(result).toContain('write: false')
          expect(result).not.toContain('disallowedTools:')
        })
      })

      describe('steps migration', () => {
        test('maps maxTurns to steps', () => {
          const input = `---
name: test-agent
maxTurns: 5
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('steps: 5')
          expect(result).not.toContain('maxTurns:')
        })

        test('maps maxSteps to steps', () => {
          const input = `---
name: test-agent
maxSteps: 10
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('steps: 10')
          expect(result).not.toContain('maxSteps:')
        })

        test('prefers steps over maxTurns/maxSteps', () => {
          const input = `---
name: test-agent
steps: 3
maxTurns: 5
maxSteps: 10
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('steps: 3')
          expect(result).not.toContain('maxTurns:')
          expect(result).not.toContain('maxSteps:')
        })

        test('uses minimum when both maxTurns and maxSteps present', () => {
          const input = `---
name: test-agent
maxTurns: 5
maxSteps: 10
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('steps: 5')
        })

        test('cleans up maxTurns/maxSteps after mapping', () => {
          const input = `---
name: test-agent
maxTurns: 5
maxSteps: 10
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).not.toContain('maxTurns:')
          expect(result).not.toContain('maxSteps:')
        })

        test('rejects non-positive-integer steps values', () => {
          const input = `---
name: test-agent
maxSteps: -1
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).not.toContain('steps:')
          expect(result).toContain('maxSteps: -1')
        })

        test('preserves original fields when steps value is zero', () => {
          const input = `---
name: test-agent
maxTurns: 0
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).not.toContain('steps:')
          expect(result).toContain('maxTurns: 0')
        })
      })

      describe('permissionMode', () => {
        test('maps full permissionMode to allow permissions', () => {
          const input = `---
name: test-agent
permissionMode: full
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('edit: allow')
          expect(result).toContain('bash: allow')
          expect(result).toContain('webfetch: allow')
          expect(result).not.toContain('permissionMode:')
        })

        test('maps default permissionMode to ask permissions', () => {
          const input = `---
name: test-agent
permissionMode: default
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('edit: ask')
          expect(result).toContain('bash: ask')
          expect(result).toContain('webfetch: ask')
        })

        test('maps plan permissionMode to deny/ask permissions', () => {
          const input = `---
name: test-agent
permissionMode: plan
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('edit: deny')
          expect(result).toContain('bash: deny')
          expect(result).toContain('webfetch: ask')
        })

        test('unknown permissionMode defaults to ask', () => {
          const input = `---
name: test-agent
permissionMode: unknown-mode
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('edit: ask')
          expect(result).toContain('bash: ask')
          expect(result).toContain('webfetch: ask')
          expect(result).not.toContain('permissionMode:')
        })

        test('existing valid permission takes precedence over permissionMode', () => {
          const input = `---
name: test-agent
permission:
  edit: allow
  bash: deny
permissionMode: full
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('edit: allow')
          expect(result).toContain('bash: deny')
          expect(result).not.toContain('permissionMode:')
          expect(result).not.toContain('webfetch: allow')
        })

        test('falls back to permissionMode when permission is invalid', () => {
          const input = `---
name: test-agent
permission:
  edit: maybe
permissionMode: full
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('edit: allow')
          expect(result).toContain('bash: allow')
          expect(result).not.toContain('permissionMode:')
        })
      })

      describe('hidden field', () => {
        test('maps disable-model-invocation to hidden', () => {
          const input = `---
name: test-agent
disable-model-invocation: true
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('hidden: true')
          expect(result).not.toContain('disable-model-invocation:')
        })

        test('maps camelCase disableModelInvocation to hidden', () => {
          const input = `---
name: test-agent
disableModelInvocation: true
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('hidden: true')
          expect(result).not.toContain('disableModelInvocation:')
        })

        test('does not set hidden when disable-model-invocation is false', () => {
          const input = `---
name: test-agent
disable-model-invocation: false
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).not.toContain('hidden: true')
        })
      })

      describe('agent name preservation', () => {
        test('preserves agent name in converted output', () => {
          const input = `---
name: my-agent
description: Test agent
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('name: my-agent')
        })
      })

      describe('pass-through', () => {
        test('preserves unknown CC fields on agents', () => {
          const input = `---
name: test-agent
description: Test
hooks:
  pre_run: echo hello
memory: persistent
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('hooks:')
          expect(result).toContain('pre_run: echo hello')
          expect(result).toContain('memory: persistent')
        })

        test('preserves unknown CC fields on skills', () => {
          const input = `---
name: test-skill
description: Test
custom_field: value
---
Content`
          const result = convertContent(input, 'skill')
          expect(result).toContain('custom_field: value')
        })

        test('preserves unknown CC fields on commands', () => {
          const input = `---
name: test-command
description: Test
custom_field: value
---
Content`
          const result = convertContent(input, 'command')
          expect(result).toContain('custom_field: value')
        })

        test('preserves hooks field', () => {
          const input = `---
name: test-agent
hooks:
  post_run: cleanup
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('post_run: cleanup')
        })

        test('preserves mcpServers field', () => {
          const input = `---
name: test-agent
mcpServers:
  - name: server1
---
Prompt`
          const result = convertContent(input, 'agent')
          expect(result).toContain('name: server1')
        })
      })

      describe('skill-specific mappings', () => {
        test('normalizes model on skills', () => {
          const input = `---
name: test-skill
description: Test
model: claude-sonnet-4-20250514
---
Content`
          const result = convertContent(input, 'skill')
          expect(result).toContain('model: anthropic/claude-sonnet-4-20250514')
        })

        test('maps context: fork to subtask: true', () => {
          const input = `---
name: test-skill
description: Test
context: fork
---
Content`
          const result = convertContent(input, 'skill')
          expect(result).toContain('subtask: true')
          expect(result).toContain('context: fork')
        })

        test('removes inherit model from skills', () => {
          const input = `---
name: test-skill
description: Test
model: inherit
---
Content`
          const result = convertContent(input, 'skill')
          expect(result).not.toContain('model:')
        })
      })
    })

    describe('Idempotency', () => {
      test('converting already-converted agent content is idempotent', () => {
        const input = `---
name: test-agent
description: Test agent
model: claude-sonnet-4-20250514
maxSteps: 10
permissionMode: full
tools:
  - Read
  - Bash
---
Use TodoWrite to track.`
        const first = convertContent(input, 'agent')
        const second = convertContent(first, 'agent')
        expect(second).toBe(first)
      })

      test('model normalization is idempotent', () => {
        const input = `---
name: test-agent
model: anthropic/claude-sonnet-4-20250514
---
Content`
        const first = convertContent(input, 'agent')
        const second = convertContent(first, 'agent')
        expect(second).toBe(first)
      })

      test('tools map conversion is idempotent', () => {
        const input = `---
name: test-agent
tools:
  read: true
  bash: false
---
Content`
        const first = convertContent(input, 'agent')
        const second = convertContent(first, 'agent')
        expect(second).toBe(first)
      })

      test('steps mapping is idempotent', () => {
        const input = `---
name: test-agent
steps: 10
---
Content`
        const first = convertContent(input, 'agent')
        const second = convertContent(first, 'agent')
        expect(second).toBe(first)
      })

      test('permission mapping is idempotent', () => {
        const input = `---
name: test-agent
permission:
  edit: allow
  bash: ask
---
Content`
        const first = convertContent(input, 'agent')
        const second = convertContent(first, 'agent')
        expect(second).toBe(first)
      })

      test('skill conversion is idempotent', () => {
        const input = `---
name: test-skill
description: Test
model: anthropic/claude-sonnet-4-20250514
context: fork
---
Content`
        const first = convertContent(input, 'skill')
        const second = convertContent(first, 'skill')
        expect(second).toBe(first)
      })

      test('command conversion is idempotent', () => {
        const input = `---
name: test-command
description: Test
model: anthropic/claude-sonnet-4-20250514
argument-hint: <file>
---
Content`
        const first = convertContent(input, 'command')
        const second = convertContent(first, 'command')
        expect(second).toBe(first)
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
