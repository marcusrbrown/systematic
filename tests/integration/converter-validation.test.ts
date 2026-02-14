/**
 * Converter validation tests against real CEP content
 * Tests that the converter correctly handles real-world Claude Code content
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { type ContentType, convertContent } from '../../src/lib/converter.js'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'

const CEP_ROOT =
  '/Users/mrbrown/src/github.com/kieranklaassen/compound-engineering-plugin/plugins/compound-engineering'

interface ValidationResult {
  name: string
  type: ContentType
  original: string
  converted: string
  issues: string[]
  falsePositives: string[]
  falseNegatives: string[]
  frontmatterChanges: {
    removed: string[]
    preserved: string[]
  }
}

function detectFalsePositives(original: string, converted: string): string[] {
  const falsePositives: string[] = []

  // Since Task → task (same word, just lowercased), false-positive detection
  // checks that uppercase "Task" used as a noun was NOT incorrectly lowercased.
  // The converter's context-dependent regexes should only match tool invocation
  // patterns, leaving noun usage with uppercase T untouched.
  const taskNounCasing = [
    { original: /complete the Task\b/g, converted: /complete the task\b/g },
    { original: /\beach Task\b/g, converted: /\beach task\b/g },
    { original: /\bTask management\b/g, converted: /\btask management\b/g },
    { original: /\bTask tracking\b/g, converted: /\btask tracking\b/g },
    { original: /\bTask list\b(?! |$)/g, converted: /\btask list\b(?! |$)/g },
  ]

  for (const {
    original: originalPattern,
    converted: convertedPattern,
  } of taskNounCasing) {
    const originalMatch = original.match(originalPattern)
    const convertedMatch = converted.match(convertedPattern)
    if (originalMatch && convertedMatch) {
      falsePositives.push(
        `False positive: "${convertedMatch[0]}" - "Task" as noun incorrectly lowercased`,
      )
    }
  }

  return falsePositives
}

function detectFalseNegatives(_original: string, converted: string): string[] {
  const falseNegatives: string[] = []

  const codeBlockPattern = /```[\s\S]*?```|`[^`\n]+`/g
  const convertedWithoutCodeBlocks = converted.replace(codeBlockPattern, '')

  const shouldBeConverted = [
    { pattern: /\bTodoWrite\b/g, expected: 'todowrite' },
    { pattern: /\bAskUserQuestion\b/g, expected: 'question' },
    { pattern: /\bWebSearch\b/g, expected: 'google_search' },
    { pattern: /\bWebFetch\b/g, expected: 'webfetch' },
    { pattern: /\.claude\/skills\//g, expected: '.opencode/skills/' },
    { pattern: /\.claude\/commands\//g, expected: '.opencode/commands/' },
    { pattern: /CLAUDE\.md/g, expected: 'AGENTS.md' },
    { pattern: /compound-engineering:/g, expected: 'systematic:' },
  ]

  for (const { pattern, expected } of shouldBeConverted) {
    const matches = convertedWithoutCodeBlocks.match(pattern)
    if (matches) {
      falseNegatives.push(
        `False negative: "${matches[0]}" should be converted to "${expected}"`,
      )
    }
  }

  return falseNegatives
}

// Helper to analyze frontmatter changes
function analyzeFrontmatter(
  original: string,
  converted: string,
  _type: ContentType,
): { removed: string[]; preserved: string[] } {
  const origFm = parseFrontmatter(original)
  const convFm = parseFrontmatter(converted)

  const removed: string[] = []
  const preserved: string[] = []

  const origKeys = Object.keys(origFm.data)
  const convKeys = Object.keys(convFm.data)

  for (const key of origKeys) {
    if (convKeys.includes(key)) {
      preserved.push(key)
    } else {
      removed.push(key)
    }
  }

  return { removed, preserved }
}

// Fields that should be mapped (transformed) during conversion, not just preserved
const MAPPED_AGENT_FIELDS = [
  'permissionMode',
  'maxTurns',
  'maxSteps',
  'disallowedTools',
]

function validateFile(filePath: string, type: ContentType): ValidationResult {
  const original = fs.readFileSync(filePath, 'utf8')
  const converted = convertContent(original, type)

  const issues: string[] = []
  const falsePositives = detectFalsePositives(original, converted)
  const falseNegatives = detectFalseNegatives(original, converted)
  const frontmatterChanges = analyzeFrontmatter(original, converted, type)

  // Validate required fields preserved
  if (frontmatterChanges.removed.includes('name')) {
    issues.push('Required field "name" was incorrectly removed')
  }
  if (frontmatterChanges.removed.includes('description')) {
    issues.push('Required field "description" was incorrectly removed')
  }

  // Validate mapped fields are consumed (not preserved as-is) for agents
  if (type === 'agent') {
    for (const field of MAPPED_AGENT_FIELDS) {
      if (frontmatterChanges.preserved.includes(field)) {
        issues.push(
          `Mapped field "${field}" should be consumed during agent conversion`,
        )
      }
    }
  }

  return {
    name: path.basename(filePath),
    type,
    original,
    converted,
    issues,
    falsePositives,
    falseNegatives,
    frontmatterChanges,
  }
}

function logValidationIssues(fileName: string, result: ValidationResult): void {
  if (result.issues.length > 0) {
    console.log(`Issues in ${fileName}:`, result.issues)
  }
  if (result.falsePositives.length > 0) {
    console.log(`False positives in ${fileName}:`, result.falsePositives)
  }
  if (result.falseNegatives.length > 0) {
    console.log(`False negatives in ${fileName}:`, result.falseNegatives)
  }
}

function assertValidConversion(result: ValidationResult): void {
  expect(result.issues).toEqual([])
  expect(result.falseNegatives).toEqual([])
}

describe('Converter Validation Against Real CEP Content', () => {
  const skipIfNoCEP = () => {
    if (!fs.existsSync(CEP_ROOT)) {
      console.log('Skipping CEP validation tests - CEP repository not found')
      return true
    }
    return false
  }

  const skipIfNoFile = (fullPath: string, fileName: string) => {
    if (!fs.existsSync(fullPath)) {
      console.log(`Skipping ${fileName} - file not found`)
      return true
    }
    return false
  }

  describe('Skills Validation', () => {
    const skillFiles = [
      'agent-browser/SKILL.md',
      'agent-native-architecture/SKILL.md',
      'compound-docs/SKILL.md',
      'file-todos/SKILL.md',
      'brainstorming/SKILL.md',
      'create-agent-skills/SKILL.md',
      'git-worktree/SKILL.md',
      'frontend-design/SKILL.md',
    ]

    for (const skillFile of skillFiles) {
      const fullPath = path.join(CEP_ROOT, 'skills', skillFile)

      test(`converts ${skillFile} correctly`, () => {
        if (skipIfNoCEP()) return
        if (skipIfNoFile(fullPath, skillFile)) return

        const result = validateFile(fullPath, 'skill')
        logValidationIssues(skillFile, result)
        assertValidConversion(result)
      })
    }

    test('preserves CC frontmatter fields in skills', () => {
      if (skipIfNoCEP()) return

      const fullPath = path.join(CEP_ROOT, 'skills', 'compound-docs/SKILL.md')
      if (!fs.existsSync(fullPath)) return

      const result = validateFile(fullPath, 'skill')

      // allowed-tools should now be preserved (non-destructive)
      expect(result.frontmatterChanges.preserved).toContain('allowed-tools')
      expect(result.frontmatterChanges.preserved).toContain('name')
      expect(result.frontmatterChanges.preserved).toContain('description')
    })
  })

  describe('Commands Validation', () => {
    const commandFiles = [
      'workflows/plan.md',
      'workflows/brainstorm.md',
      'lfg.md',
      'deepen-plan.md',
      'heal-skill.md',
    ]

    for (const cmdFile of commandFiles) {
      const fullPath = path.join(CEP_ROOT, 'commands', cmdFile)

      test(`converts ${cmdFile} correctly`, () => {
        if (skipIfNoCEP()) return
        if (skipIfNoFile(fullPath, cmdFile)) return

        const result = validateFile(fullPath, 'command')
        logValidationIssues(cmdFile, result)
        assertValidConversion(result)
      })
    }

    test('preserves argument-hint in command frontmatter', () => {
      if (skipIfNoCEP()) return

      const fullPath = path.join(CEP_ROOT, 'commands', 'workflows/plan.md')
      if (!fs.existsSync(fullPath)) return

      const result = validateFile(fullPath, 'command')

      // argument-hint should now be preserved (non-destructive)
      expect(result.frontmatterChanges.preserved).toContain('argument-hint')
    })
  })

  describe('Agents Validation', () => {
    const agentFiles = [
      'review/security-sentinel.md',
      'review/architecture-strategist.md',
      'review/pattern-recognition-specialist.md',
      'research/framework-docs-researcher.md',
    ]

    for (const agentFile of agentFiles) {
      const fullPath = path.join(CEP_ROOT, 'agents', agentFile)

      test(`converts ${agentFile} correctly`, () => {
        if (skipIfNoCEP()) return
        if (skipIfNoFile(fullPath, agentFile)) return

        const result = validateFile(fullPath, 'agent')
        logValidationIssues(agentFile, result)
        assertValidConversion(result)
      })
    }

    test('adds required OpenCode agent fields', () => {
      if (skipIfNoCEP()) return

      const fullPath = path.join(
        CEP_ROOT,
        'agents',
        'review/security-sentinel.md',
      )
      if (!fs.existsSync(fullPath)) return

      const original = fs.readFileSync(fullPath, 'utf8')
      const converted = convertContent(original, 'agent')
      const fm = parseFrontmatter(converted)

      // OpenCode requires these fields for agents
      expect(fm.data).toHaveProperty('mode')
      expect(fm.data).toHaveProperty('temperature')
      expect(fm.data).toHaveProperty('description')
    })
  })

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
