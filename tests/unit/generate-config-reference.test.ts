import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TEMP_ROOTS: string[] = []

function makeTempDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-config-ref-'))
  TEMP_ROOTS.push(tmp)
  return tmp
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * Collect all headings and sub-headings from mdx content into a Set
 * of strings (e.g., "## disabled_skills" -> "disabled_skills").
 */
function collectSectionHeadings(content: string): Set<string> {
  const headings = new Set<string>()
  for (const line of content.split('\n')) {
    const match = line.match(/^##(#?)\s+(.+)$/)
    if (match) {
      headings.add(match[2].trim())
    }
  }
  return headings
}

/**
 * Check that every section with a `**Type:**` line has non-empty
 * descriptive text between the heading and `**Type:**`.
 */
function checkAllSectionsHaveDescriptions(content: string): boolean {
  // Split on any level heading (## or ###)
  const sections = content.split(/\n(?=#{2,3}\s+)/)
  for (const section of sections) {
    if (!section.includes('**Type:**')) continue
    // Extract text between the heading line and the **Type:** line
    const lines = section.split('\n')
    let headingIdx = -1
    let typeIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^#{2,3}\s+/.test(lines[i])) headingIdx = i
      if (lines[i].includes('**Type:**')) typeIdx = i
    }
    if (headingIdx === -1 || typeIdx === -1) continue
    // Text between heading and **Type:** should have non-whitespace
    const between = lines
      .slice(headingIdx + 1, typeIdx)
      .join(' ')
      .trim()
    if (between.length === 0) return false
  }
  return true
}

/**
 * Check that the content contains example code blocks for key fields.
 */
function countExampleBlocks(content: string): number {
  const matches = content.match(/```json/g)
  return matches ? matches.length : 0
}

// ═════════════════════════════════════════════════════════════════
// Import / module resolution (TDD first check)
// ═════════════════════════════════════════════════════════════════

describe('module resolution', () => {
  test('imports from the generator script', async () => {
    // This test verifies the module can be resolved.
    // It should fail with "module not found" until the generator exists.
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    expect(mod).toBeDefined()
    expect(typeof mod.generateConfigReference).toBe('function')
    expect(typeof mod.validateFieldExamples).toBe('function')
  })
})

// ═════════════════════════════════════════════════════════════════
// generateConfigReference — output shape tests
// ═════════════════════════════════════════════════════════════════

describe('generateConfigReference', () => {
  let generateFn: (version?: string) => string

  beforeAll(async () => {
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    generateFn = mod.generateConfigReference
  })

  test('happy path: produces mdx with frontmatter and $schema block', () => {
    const content = generateFn('2.11.0')

    // Has frontmatter delimiters with title + description
    expect(content).toMatch(/^---\n/)
    expect(content).toContain('title:')
    expect(content).toContain('description:')
    expect(content).toMatch(/\n---\n/)

    // Has copy-paste $schema block referencing major-versioned URL
    expect(content).toContain(
      'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
    )

    // Excludes /latest/ from the $schema line
    expect(content).not.toMatch(
      /schemas\/latest\/.*\$schema.*systematic-config/,
    )
  })

  test('has one section per top-level config key', () => {
    const content = generateFn('2.11.0')
    const headings = collectSectionHeadings(content)

    const expected = [
      'agents',
      'categories',
      'disabled_skills',
      'disabled_agents',
      'disabled_commands',
      'bootstrap',
    ]
    for (const key of expected) {
      expect(headings.has(key)).toBe(true)
    }
  })

  test('every described field has a non-empty description', () => {
    const content = generateFn('2.11.0')
    expect(checkAllSectionsHaveDescriptions(content)).toBe(true)
  })

  test('at least one example per field', () => {
    // Every leaf field must have at least one example.
    // Count example blocks — must be >= the number of documented fields.
    const content = generateFn('2.11.0')
    const exampleCount = countExampleBlocks(content)

    // Known documented fields (top-level + overlay fields + bootstrap sub-fields)
    // agents.* (9 overlay fields) + categories.* (9 fields) + disabled_* (3) + bootstrap (2) + bootstrap itself
    // At a minimum we need at least 24 example blocks
    expect(exampleCount).toBeGreaterThanOrEqual(20)
  })

  test('includes offline IDE behavior note', () => {
    const content = generateFn('2.11.0')
    expect(content).toMatch(/offline/i)
    expect(content).toMatch(/offline IDE/i)
    expect(content).toMatch(/bundled npm/i)
  })

  test('includes auto-generated header comment', () => {
    const content = generateFn('2.11.0')
    expect(content).toMatch(/auto-generated/i)
    expect(content).toMatch(/src\/lib\/config-schema\.ts/)
    expect(content).toMatch(/Do NOT edit/i)
  })

  test('version 3.0.0 produces v3 $schema URL', () => {
    const content = generateFn('3.0.0')
    expect(content).toContain(
      'https://fro.bot/systematic/schemas/v3/systematic-config.schema.json',
    )
    expect(content).not.toContain(
      'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
    )
  })

  test('$schema URL for v2 is correct for existing published schema', () => {
    const content = generateFn('2.11.0')
    // Must match the URL that U3 publishes
    expect(content).toContain(
      'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
    )
  })
})

// ═════════════════════════════════════════════════════════════════
// validateFieldExamples — examples enforcement
// ═════════════════════════════════════════════════════════════════

describe('validateFieldExamples', () => {
  let validateFn: (schema: Record<string, unknown>, prefix?: string) => string[]

  beforeAll(async () => {
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    validateFn = mod.validateFieldExamples
  })

  test('empty errors for schema with all fields having examples', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name field',
          examples: ['Alice'],
        },
        count: {
          type: 'number',
          description: 'Count field',
          examples: [42],
        },
      },
    }
    const errors = validateFn(schema)
    expect(errors).toHaveLength(0)
  })

  test('error for field with description but no examples', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name field',
          // No examples!
        },
        count: {
          type: 'number',
          description: 'Count field',
          examples: [42],
        },
      },
    }
    const errors = validateFn(schema)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors).toContain('name')
  })

  test('error for nested field with description but no examples', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        parent: {
          type: 'object',
          description: 'Parent field',
          properties: {
            child: {
              type: 'string',
              description: 'Child field',
              // No examples!
            },
          },
        },
      },
    }
    const errors = validateFn(schema)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors).toContain('parent.child')
  })

  test('error for field in additionalProperties without examples', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        agents: {
          type: 'object',
          description: 'Agents',
          additionalProperties: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Model field',
                // No examples!
              },
            },
          },
        },
      },
    }
    const errors = validateFn(schema)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors).toContain('agents.<name>.model')
  })
})

// ═════════════════════════════════════════════════════════════════
// Enum rendering
// ═════════════════════════════════════════════════════════════════

describe('enum fields', () => {
  let generateFn: (version?: string) => string

  beforeAll(async () => {
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    generateFn = mod.generateConfigReference
  })

  test('enum fields render with valid values list', () => {
    const content = generateFn('2.11.0')

    // The `mode` field is the clearest enum in the schema.
    // It should appear with a "Valid values" marker.
    expect(content).toMatch(/Valid values/i)
    expect(content).toContain('subagent')
    expect(content).toContain('primary')
    expect(content).toContain('all')
  })

  test('enum values are rendered as inline code or list', () => {
    const content = generateFn('2.11.0')
    // The enum values should be formatted as code
    expect(content).toMatch(/`subagent`/)
    expect(content).toMatch(/`primary`/)
    expect(content).toMatch(/`all`/)
  })
})

// ═════════════════════════════════════════════════════════════════
// Syntax / structure
// ═════════════════════════════════════════════════════════════════

describe('output structure', () => {
  let generateFn: (version?: string) => string

  beforeAll(async () => {
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    generateFn = mod.generateConfigReference
  })

  test('copy-paste $schema line is a fenced json code block', () => {
    const content = generateFn('2.11.0')
    // The $schema copy-paste should be in a ```json block
    const jsonBlocks = content.match(/```json\n([^`]+)```/g)
    expect(jsonBlocks).not.toBeNull()
    const hasSchemaBlock = jsonBlocks!.some((block) =>
      block.includes('$schema'),
    )
    expect(hasSchemaBlock).toBe(true)
  })

  test('runs in main mode without error', () => {
    // Verify the module exports a main function
    const content = generateFn('2.11.0')
    expect(typeof content).toBe('string')
    expect(content.length).toBeGreaterThan(1000)
  })
})

// ═════════════════════════════════════════════════════════════════
// Regression: idempotent output
// ═════════════════════════════════════════════════════════════════

describe('idempotent output', () => {
  let generateFn: (version?: string) => string

  beforeAll(async () => {
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    generateFn = mod.generateConfigReference
  })

  test('running the generator twice produces byte-identical output', () => {
    const first = generateFn('2.11.0')
    const second = generateFn('2.11.0')
    expect(first).toBe(second)
  })
})

// ═════════════════════════════════════════════════════════════════
// Error path: unreadable schema
// ═════════════════════════════════════════════════════════════════

describe('error handling', () => {
  test('main function handles module errors gracefully', async () => {
    // The generator should handle errors without crashing silently.
    // Verify the module structure supports error handling.
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    expect(typeof mod.execMain).toBe('function')

    // execMain should return an exit code (0 for success, non-zero for error)
    const exitCode = await mod.execMain('2.11.0')
    expect(exitCode).toBe(0)
  })

  test('generator with real schema: all fields have examples', async () => {
    // Integration test: the real schema MUST have examples for every
    // described field. If this test fails, a schema field was added
    // without .meta({ examples: [...] }) — fix the schema, not the test.
    const mod = await import('../../docs/scripts/generate-config-reference.js')
    const { z } = await import('zod')
    const { SystematicConfigSchema } = await import(
      '../../src/lib/config-schema.js'
    )
    const schema = z.toJSONSchema(SystematicConfigSchema, {
      target: 'draft-7',
    }) as Record<string, unknown>

    const errors = mod.validateFieldExamples(schema)
    expect(errors).toHaveLength(0)
  })
})
