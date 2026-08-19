import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractCommandFrontmatter,
  findCommandsInDir,
} from '../../src/lib/commands.ts'

describe('findCommandsInDir README exclusion', () => {
  test('does not register a category README as a command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commands-readme-'))
    try {
      const category = join(dir, 'git')
      mkdirSync(category)
      writeFileSync(join(category, 'README.md'), 'Docs about this directory.')
      writeFileSync(join(category, 'commit.md'), 'Real command.')

      const names = findCommandsInDir(dir).map((c) => c.name)
      expect(names).toEqual(['/git:commit'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('excludes README regardless of filename casing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commands-readme-case-'))
    try {
      writeFileSync(join(dir, 'readme.md'), 'lowercase')
      expect(findCommandsInDir(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('extractCommandFrontmatter', () => {
  test('extracts agent field when present', () => {
    const content = `---
name: test-cmd
agent: my-agent
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.agent).toBe('my-agent')
  })

  test('extracts model field when present', () => {
    const content = `---
name: test-cmd
model: gpt-4
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.model).toBe('gpt-4')
  })

  test('extracts subtask: true when present', () => {
    const content = `---
name: test-cmd
subtask: true
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.subtask).toBe(true)
  })

  test('extracts subtask: false when present', () => {
    const content = `---
name: test-cmd
subtask: false
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.subtask).toBe(false)
  })

  test('extracts subtask from string values', () => {
    const content = `---
name: test-cmd
subtask: "true"
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.subtask).toBe(true)
  })

  test('returns undefined for missing optional fields', () => {
    const content = `---
name: test-cmd
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.agent).toBeUndefined()
    expect(result.model).toBeUndefined()
    expect(result.subtask).toBeUndefined()
  })

  test('empty strings become undefined for agent and model', () => {
    const content = `---
name: test-cmd
agent: ""
model: ''
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.agent).toBeUndefined()
    expect(result.model).toBeUndefined()
  })

  test('whitespace-only agent and model are ignored', () => {
    const content = `---
name: test-cmd
agent: "   "
model: "\t"
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.agent).toBeUndefined()
    expect(result.model).toBeUndefined()
  })

  test('existing fields still work correctly', () => {
    const content = `---
name: test-cmd
description: A test command
argument-hint: "[file]"
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.name).toBe('test-cmd')
    expect(result.description).toBe('A test command')
    expect(result.argumentHint).toBe('[file]')
  })

  test('handles missing frontmatter gracefully', () => {
    const content = '# No frontmatter here'
    const result = extractCommandFrontmatter(content)
    expect(result.name).toBe('')
    expect(result.description).toBe('')
    expect(result.argumentHint).toBe('')
    expect(result.agent).toBeUndefined()
    expect(result.model).toBeUndefined()
    expect(result.subtask).toBeUndefined()
  })

  test('returns undefined for invalid subtask string values', () => {
    const content = `---
name: test-cmd
subtask: "yes"
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.subtask).toBeUndefined()
  })

  test('returns undefined for subtask with numeric value', () => {
    const content = `---
name: test-cmd
subtask: 1
---
Template content`
    const result = extractCommandFrontmatter(content)
    expect(result.subtask).toBeUndefined()
  })

  test('handles malformed frontmatter gracefully', () => {
    const content = `---
name: test
  bad: indentation
---
Content`
    const result = extractCommandFrontmatter(content)
    expect(result.name).toBe('')
    expect(result.agent).toBeUndefined()
    expect(result.model).toBeUndefined()
    expect(result.subtask).toBeUndefined()
  })
})
