import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  isValidAgentColor,
  OPENCODE_AGENT_COLOR_TOKENS,
} from '../../src/lib/agent-colors.js'
import {
  AgentOverlaySchema,
  assertSourceCategoryModelDefaults,
  BootstrapSchema,
  CategoryOverlaySchema,
  SECURITY_OVERLAY_FIELDS,
  SystematicConfigSchema,
  validateConfig,
} from '../../src/lib/config-schema.js'

const EXPECTED_COLOR_TOKENS: readonly string[] = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
]

describe('SystematicConfigSchema', () => {
  test('parses a complete valid config with all fields populated', () => {
    const input = {
      agents: {
        explorer: {
          model: 'openai/gpt-4',
          variant: 'v2',
          temperature: 0.3,
          top_p: 0.9,
          mode: 'subagent' as const,
          color: 'primary',
          steps: 10,
          hidden: false,
          disable: false,
          skills: ['ce:plan'],
          permission: { edit: 'allow' as const },
        },
      },
      categories: {
        review: {
          model: 'anthropic/claude-3',
          temperature: 0.1,
        },
      },
      disabled_skills: ['skill-1'],
      disabled_agents: ['agent-1'],
      disabled_commands: ['cmd-1'],
      bootstrap: {
        enabled: false,
        file: '/tmp/prompt.md',
      },
    }

    const result = SystematicConfigSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agents.explorer.model).toBe('openai/gpt-4')
      expect(result.data.agents.explorer.temperature).toBe(0.3)
      expect(result.data.agents.explorer.mode).toBe('subagent')
      expect(result.data.agents.explorer.color).toBe('primary')
      expect(result.data.categories.review.model).toBe('anthropic/claude-3')
      expect(result.data.disabled_skills).toEqual(['skill-1'])
      expect(result.data.disabled_agents).toEqual(['agent-1'])
      expect(result.data.disabled_commands).toEqual(['cmd-1'])
      expect(result.data.bootstrap.enabled).toBe(false)
      expect(result.data.bootstrap.file).toBe('/tmp/prompt.md')
    }
  })

  test('parses an empty config and returns default values', () => {
    const result = SystematicConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.disabled_skills).toEqual([])
      expect(result.data.disabled_agents).toEqual([])
      expect(result.data.disabled_commands).toEqual([])
      expect(result.data.bootstrap.enabled).toBe(true)
      expect(result.data.agents).toEqual({})
      expect(result.data.categories).toEqual({})
      // Verify all six top-level keys exist
      expect(Object.keys(result.data).sort()).toEqual([
        'agents',
        'bootstrap',
        'categories',
        'disabled_agents',
        'disabled_commands',
        'disabled_skills',
      ])
    }
  })

  test('rejects unknown top-level keys with a path-named error', () => {
    const result = SystematicConfigSchema.safeParse({ foo: 'bar' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0)
      const issue = result.error.issues[0] as {
        code: string
        keys?: string[]
        message: string
      }
      expect(issue.code).toBe('unrecognized_keys')
      expect(issue.keys).toContain('foo')
      expect(issue.message).toContain('foo')
    }
  })

  test('rejects temperature as string (expected number)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { temperature: 'high' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'temperature'])
      expect(issue.message).toMatch(/number/i)
    }
  })

  test('rejects top_p > 1 (out of range 0-1)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { top_p: 1.5 } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'top_p'])
      expect(issue.message).toMatch(/<=1|too big|max/i)
    }
  })

  test('rejects invalid color "purple" with path-named error', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { color: 'purple' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // colorSchema is a z.union([z.enum(tokens), z.string().regex(...)]) so
      // the path is the same but the issue may be a union-level error or one
      // of the branch errors. Just verify the correct field path is named and
      // that the overall parse rejected the value.
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p === 'agents.explorer.color')).toBe(true)
    }
  })

  test('rejects invalid mode "weird" and lists valid options', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { mode: 'weird' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'mode'])
      const message = issue.message.toLowerCase()
      expect(message).toContain('subagent')
      expect(message).toContain('primary')
      expect(message).toContain('all')
    }
  })

  test('rejects steps as negative integer', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { steps: -1 } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'steps'])
    }
  })

  test('rejects steps as zero (must be positive)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { steps: 0 } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'steps'])
      // positive means > 0
      expect(issue.message).toMatch(/0|positive|>0|minimum/i)
    }
  })

  test('rejects hidden as string instead of boolean', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { hidden: 'yes' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'hidden'])
      expect(issue.message).toMatch(/boolean/i)
    }
  })

  test('rejects permission as string (expected object)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { permission: 'open' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'permission'])
    }
  })

  test('rejects empty model string in category overlay', () => {
    const result = SystematicConfigSchema.safeParse({
      categories: { review: { model: '' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['categories', 'review', 'model'])
      expect(issue.message).toMatch(/1|empty|min/i)
    }
  })

  test('rejects unknown field in agent overlay with path-named error', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { explorer: { foo: 'bar' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0] as {
        code: string
        keys?: string[]
        path: (string | number)[]
      }
      expect(issue.code).toBe('unrecognized_keys')
      expect(issue.keys).toContain('foo')
      // Path should indicate the agent overlay context
      expect(issue.path).toEqual(['agents', 'explorer'])
    }
  })
})

describe('assertSourceCategoryModelDefaults', () => {
  test('passes for the actual SOURCE_CATEGORY_MODEL_DEFAULTS constant', () => {
    const actualConstants = {
      design: ['openai/gpt-5.5', 'anthropic/claude-opus-4-7'],
      docs: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
      'document-review': ['anthropic/claude-opus-4-7', 'openai/gpt-5.5'],
      research: ['openai/gpt-5.5', 'anthropic/claude-opus-4-7'],
      review: ['anthropic/claude-opus-4-7', 'openai/gpt-5.5'],
      workflow: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
    }

    expect(() =>
      assertSourceCategoryModelDefaults(actualConstants),
    ).not.toThrow()
  })

  test('throws with a path-named error for an intentionally bad mock', () => {
    // A record with invalid values (numbers instead of string arrays)
    const badMock = {
      design: 42,
      research: ['openai/valid-model'],
    }

    expect(() => assertSourceCategoryModelDefaults(badMock)).toThrow()
    // Specifically check the error message contains the offending field path
    try {
      assertSourceCategoryModelDefaults(badMock)
    } catch (err) {
      const error = err as Error
      expect(error.message).toMatch(/design/)
      expect(error.message).not.toMatch(/research/)
    }
  })

  test('throws for empty array (must have at least one entry)', () => {
    const badMock = { design: [] }
    expect(() => assertSourceCategoryModelDefaults(badMock)).toThrow()
    try {
      assertSourceCategoryModelDefaults(badMock)
    } catch (err) {
      const error = err as Error
      expect(error.message).toMatch(/design/)
    }
  })

  test('throws for empty string in model defaults', () => {
    const badMock = { design: [''] }
    expect(() => assertSourceCategoryModelDefaults(badMock)).toThrow()
    try {
      assertSourceCategoryModelDefaults(badMock)
    } catch (err) {
      const error = err as Error
      expect(error.message).toMatch(/design/)
    }
  })
})

describe('OPENCODE_AGENT_COLOR_TOKENS', () => {
  test('contains all seven expected theme tokens', () => {
    // Single source of truth (src/lib/agent-colors.ts). No duplication to drift.
    expect(OPENCODE_AGENT_COLOR_TOKENS).toEqual(EXPECTED_COLOR_TOKENS)
  })
})

describe('validateConfig wrapper', () => {
  test('returns success with data for valid input', () => {
    const result = validateConfig({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeDefined()
      expect(result.data.bootstrap.enabled).toBe(true)
    }
  })

  test('returns failure with errors for invalid input', () => {
    const result = validateConfig({ foo: 'bar' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors).toBeDefined()
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  test('discriminated union: success branch narrows data without optional chaining', () => {
    const result = validateConfig({})
    if (result.success) {
      // After narrowing via result.success, result.data is non-optional.
      // This test compiles only if ValidationResult is a discriminated union.
      const enabled: boolean = result.data.bootstrap.enabled
      expect(enabled).toBe(true)
    } else {
      throw new Error('Expected success')
    }
  })

  test('discriminated union: failure branch narrows errors without optional chaining', () => {
    const result = validateConfig({ foo: 'bar' })
    if (!result.success) {
      // After narrowing via !result.success, result.errors is non-optional.
      const count: number = result.errors.length
      expect(count).toBeGreaterThan(0)
    } else {
      throw new Error('Expected failure')
    }
  })
})

describe('AgentOverlaySchema', () => {
  test('parses a minimal valid overlay', () => {
    const result = AgentOverlaySchema.safeParse({ model: 'openai/gpt-4' })
    expect(result.success).toBe(true)
  })

  test('accepts null model (opt-out)', () => {
    const result = AgentOverlaySchema.safeParse({ model: null })
    expect(result.success).toBe(true)
  })

  test('rejects unknown fields via strict mode', () => {
    const result = AgentOverlaySchema.safeParse({
      model: 'openai/gpt-4',
      nonexistent: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].code).toBe('unrecognized_keys')
    }
  })

  test('rejects disable field? (disable is allowed for agents)', () => {
    // disable IS allowed in AgentOverlaySchema
    const result = AgentOverlaySchema.safeParse({ disable: true })
    expect(result.success).toBe(true)
  })
})

describe('CategoryOverlaySchema', () => {
  test('parses a minimal valid category overlay', () => {
    const result = CategoryOverlaySchema.safeParse({
      model: 'anthropic/claude-3',
    })
    expect(result.success).toBe(true)
  })

  test('rejects disable field (only valid for agents)', () => {
    const result = CategoryOverlaySchema.safeParse({ disable: true })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0] as {
        code: string
        keys?: string[]
        message: string
      }
      expect(issue.code).toBe('unrecognized_keys')
      expect(issue.keys).toContain('disable')
    }
  })
})

describe('BootstrapSchema', () => {
  test('defaults enabled to true', () => {
    const result = BootstrapSchema.parse({})
    expect(result.enabled).toBe(true)
  })

  test('accepts explicit enabled: false', () => {
    const result = BootstrapSchema.parse({ enabled: false })
    expect(result.enabled).toBe(false)
  })

  test('accepts file path', () => {
    const result = BootstrapSchema.parse({
      file: '/home/user/.opencode/bootstrap.md',
    })
    expect(result.enabled).toBe(true)
    expect(result.file).toBe('/home/user/.opencode/bootstrap.md')
  })
})

/**
 * Helper: unwrap ZodOptional/ZodDefault to reach the base schema so we can
 * inspect its metadata from z.globalRegistry. Used only in parity tests.
 */
function unwrapForMeta(schema: z.ZodType): z.ZodType {
  const def = schema._def as { type?: string; innerType?: z.ZodType }
  if (def.type === 'optional' || def.type === 'default') {
    const inner = def.innerType
    if (inner) return inner
  }
  return schema
}

describe('color validation parity (9b)', () => {
  test('rejects 3-digit hex: both isValidAgentColor and schema agree', () => {
    const value = '#fff'
    expect(isValidAgentColor(value)).toBe(false)
    const result = AgentOverlaySchema.safeParse({ color: value })
    expect(result.success).toBe(false)
  })

  test('accepts 6-digit hex: both isValidAgentColor and schema agree', () => {
    const value = '#FFFFFF'
    expect(isValidAgentColor(value)).toBe(true)
    const result = AgentOverlaySchema.safeParse({ color: value })
    expect(result.success).toBe(true)
  })

  test('rejects non-token named color: both isValidAgentColor and schema agree', () => {
    const value = 'blue'
    expect(isValidAgentColor(value)).toBe(false)
    const result = AgentOverlaySchema.safeParse({ color: value })
    expect(result.success).toBe(false)
  })

  test('accepts valid token "primary": both isValidAgentColor and schema agree', () => {
    const value = 'primary'
    expect(isValidAgentColor(value)).toBe(true)
    const result = AgentOverlaySchema.safeParse({ color: value })
    expect(result.success).toBe(true)
  })

  test('all OPENCODE_AGENT_COLOR_TOKENS are accepted by both isValidAgentColor and schema', () => {
    for (const token of OPENCODE_AGENT_COLOR_TOKENS) {
      expect(isValidAgentColor(token)).toBe(true)
      const result = AgentOverlaySchema.safeParse({ color: token })
      expect(result.success).toBe(true)
    }
  })

  test('lowercase hex is accepted by both: #aabbcc', () => {
    const value = '#aabbcc'
    expect(isValidAgentColor(value)).toBe(true)
    const result = AgentOverlaySchema.safeParse({ color: value })
    expect(result.success).toBe(true)
  })

  test('7-digit hex is rejected by both', () => {
    const value = '#aabbccd'
    expect(isValidAgentColor(value)).toBe(false)
    const result = AgentOverlaySchema.safeParse({ color: value })
    expect(result.success).toBe(false)
  })
})

describe('$schema top-level field', () => {
  test('accepts $schema with a valid URL', () => {
    const input = {
      $schema:
        'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
    }
    const result = SystematicConfigSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.$schema).toBe(input.$schema)
    }
  })

  test('rejects $schema with an invalid URL', () => {
    const result = SystematicConfigSchema.safeParse({ $schema: 'not-a-url' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p === '$schema')).toBe(true)
    }
  })

  test('$schema accepted but other unknown keys still rejected by strict mode', () => {
    const result = SystematicConfigSchema.safeParse({
      $schema: 'https://example.com/x.json',
      foo: 'bar',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0] as {
        code: string
        keys?: string[]
      }
      expect(issue.code).toBe('unrecognized_keys')
      expect(issue.keys).not.toContain('$schema')
      expect(issue.keys).toContain('foo')
    }
  })
})

describe('SECURITY_OVERLAY_FIELDS parity (9c)', () => {
  test('SECURITY_OVERLAY_FIELDS matches schema trust-tagged fields (forward check)', () => {
    // Every entry in SECURITY_OVERLAY_FIELDS must be a field in AgentOverlaySchema
    // that carries .meta({ trust: 'project-or-higher' }).
    const shape = AgentOverlaySchema._def.shape as Record<string, z.ZodType>
    for (const field of SECURITY_OVERLAY_FIELDS) {
      expect(field in shape).toBe(true)
      const base = unwrapForMeta(shape[field] as z.ZodType)
      const meta = z.globalRegistry.get(base) as
        | Record<string, unknown>
        | undefined
      expect(meta?.trust).toBe('project-or-higher')
    }
  })

  test('schema trust-tagged fields match SECURITY_OVERLAY_FIELDS (reverse check)', () => {
    // Every field in AgentOverlaySchema with trust:'project-or-higher' must be
    // in SECURITY_OVERLAY_FIELDS. Prevents silent omission when a new protected
    // field is added to the schema without updating the constant.
    const shape = AgentOverlaySchema._def.shape as Record<string, z.ZodType>
    const securitySet = new Set<string>(SECURITY_OVERLAY_FIELDS)

    for (const [key, field] of Object.entries(shape)) {
      const base = unwrapForMeta(field)
      const meta = z.globalRegistry.get(base) as
        | Record<string, unknown>
        | undefined
      if (meta?.trust === 'project-or-higher') {
        expect(securitySet.has(key)).toBe(true)
      }
    }
  })
})
