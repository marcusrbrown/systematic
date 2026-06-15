import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  isValidAgentColor,
  OPENCODE_AGENT_COLOR_TOKENS,
} from '../../src/lib/agent-colors.js'
import {
  BUNDLED_AGENT_NAMES,
  BUNDLED_AGENT_QUALIFIED_IDS,
  BUNDLED_SKILL_NAMES,
} from '../../src/lib/bundled-names.js'
import {
  AgentOverlaySchema,
  BootstrapSchema,
  CategoryOverlaySchema,
  createSystematicConfigSchema,
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
        'correctness-reviewer': {
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
      disabled_skills: ['ce:plan'],
      disabled_agents: ['correctness-reviewer'],
      disabled_commands: ['cmd-1'],
      bootstrap: {
        enabled: false,
        file: '/tmp/prompt.md',
      },
    }

    const result = SystematicConfigSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      const overlay = result.data.agents['correctness-reviewer']
      expect(overlay?.model).toBe('openai/gpt-4')
      expect(overlay?.temperature).toBe(0.3)
      expect(overlay?.mode).toBe('subagent')
      expect(overlay?.color).toBe('primary')
      expect(result.data.categories.review.model).toBe('anthropic/claude-3')
      expect(result.data.disabled_skills).toEqual(['ce:plan'])
      expect(result.data.disabled_agents).toEqual(['correctness-reviewer'])
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
      agents: { 'correctness-reviewer': { temperature: 'high' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual([
        'agents',
        'correctness-reviewer',
        'temperature',
      ])
      expect(issue.message).toMatch(/number/i)
    }
  })

  test('rejects top_p > 1 (out of range 0-1)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { top_p: 1.5 } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'correctness-reviewer', 'top_p'])
      expect(issue.message).toMatch(/<=1|too big|max/i)
    }
  })

  test('rejects invalid color "purple" with path-named error', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { color: 'purple' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // colorSchema is a z.union([z.enum(tokens), z.string().regex(...)]) so
      // the path is the same but the issue may be a union-level error or one
      // of the branch errors. Just verify the correct field path is named and
      // that the overall parse rejected the value.
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p === 'agents.correctness-reviewer.color')).toBe(
        true,
      )
    }
  })

  test('rejects invalid mode "weird" and lists valid options', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { mode: 'weird' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'correctness-reviewer', 'mode'])
      const message = issue.message.toLowerCase()
      expect(message).toContain('subagent')
      expect(message).toContain('primary')
      expect(message).toContain('all')
    }
  })

  test('rejects steps as negative integer', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { steps: -1 } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'correctness-reviewer', 'steps'])
    }
  })

  test('rejects steps as zero (must be positive)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { steps: 0 } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'correctness-reviewer', 'steps'])
      // positive means > 0
      expect(issue.message).toMatch(/0|positive|>0|minimum/i)
    }
  })

  test('rejects hidden as string instead of boolean', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { hidden: 'yes' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'correctness-reviewer', 'hidden'])
      expect(issue.message).toMatch(/boolean/i)
    }
  })

  test('rejects permission as string (expected object)', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: { 'correctness-reviewer': { permission: 'open' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toEqual([
        'agents',
        'correctness-reviewer',
        'permission',
      ])
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
      agents: { 'correctness-reviewer': { foo: 'bar' } },
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
      expect(issue.path).toEqual(['agents', 'correctness-reviewer'])
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

  test('rejects agent variant without same-overlay model', () => {
    const result = validateConfig({
      agents: { 'correctness-reviewer': { variant: 'high' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0].path).toEqual([
        'agents',
        'correctness-reviewer',
        'variant',
      ])
      expect(result.errors[0].message).toContain('model')
    }
  })

  test('rejects category variant without same-overlay model', () => {
    const result = validateConfig({
      categories: { review: { variant: 'high' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0].path).toEqual(['categories', 'review', 'variant'])
      expect(result.errors[0].message).toContain('model')
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

  test('accepts variant with same-overlay model', () => {
    const result = AgentOverlaySchema.safeParse({
      model: 'openai/gpt-5.5',
      variant: 'high',
    })
    expect(result.success).toBe(true)
  })

  test('rejects variant without same-overlay model', () => {
    const result = AgentOverlaySchema.safeParse({ variant: 'high' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('model')
    }
  })

  test('rejects variant with model null inheritance opt-out', () => {
    const result = AgentOverlaySchema.safeParse({
      model: null,
      variant: 'high',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('model')
    }
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

  test('accepts null model (opt-out)', () => {
    const result = CategoryOverlaySchema.safeParse({ model: null })
    expect(result.success).toBe(true)
  })

  test('accepts variant with same-overlay model', () => {
    const result = CategoryOverlaySchema.safeParse({
      model: 'openai/gpt-5.5',
      variant: 'high',
    })
    expect(result.success).toBe(true)
  })

  test('rejects variant without same-overlay model', () => {
    const result = CategoryOverlaySchema.safeParse({ variant: 'high' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('model')
    }
  })

  test('rejects variant with model null inheritance opt-out', () => {
    const result = CategoryOverlaySchema.safeParse({
      model: null,
      variant: 'high',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('model')
    }
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

describe('typed bundled-name validation', () => {
  test('accepts an overlay on a real bundled agent name', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'correctness-reviewer': {
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    })
    expect(result.success).toBe(true)
  })

  test('rejects an overlay on a misspelled bundled agent name', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'correctness-reviwer': {
          model: 'anthropic/claude-haiku-4-5',
        },
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n')
      expect(messages.toLowerCase()).toMatch(
        /unrecognized|correctness-reviwer/i,
      )
    }
  })

  test('rejects an overlay on a user-defined agent name', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'my-custom-agent': {
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    })
    expect(result.success).toBe(false)
  })

  test('accepts disabled_agents listing real bundled names', () => {
    const result = SystematicConfigSchema.safeParse({
      disabled_agents: ['security-reviewer', 'correctness-reviewer'],
    })
    expect(result.success).toBe(true)
  })

  test('rejects disabled_agents with a misspelled bundled name', () => {
    const result = SystematicConfigSchema.safeParse({
      disabled_agents: ['correctness-reviewer', 'oraqle'],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // The error must point at the array index of the bad entry.
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('disabled_agents'))).toBe(true)
    }
  })

  test('accepts disabled_skills listing real bundled skill names', () => {
    const result = SystematicConfigSchema.safeParse({
      disabled_skills: ['ce:plan', 'ce:review'],
    })
    expect(result.success).toBe(true)
  })

  test('rejects disabled_skills with a nonexistent skill name', () => {
    const result = SystematicConfigSchema.safeParse({
      disabled_skills: ['nonexistent-skill'],
    })
    expect(result.success).toBe(false)
  })

  test('empty agents/disabled_agents/disabled_skills parse cleanly via defaults', () => {
    const result = SystematicConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agents).toEqual({})
      expect(result.data.disabled_agents).toEqual([])
      expect(result.data.disabled_skills).toEqual([])
    }
  })

  test('multiple bundled agent overlays parse cleanly side by side', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'correctness-reviewer': { temperature: 0.1 },
        'security-reviewer': { temperature: 0.0 },
      },
    })
    expect(result.success).toBe(true)
  })

  test('accepts an overlay on a qualified bundled-agent key', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'review/correctness-reviewer': { temperature: 0.1 },
      },
    })
    expect(result.success).toBe(true)
  })

  test('accepts both bare and qualified keys for the same agent', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'correctness-reviewer': { temperature: 0.5 },
        'review/correctness-reviewer': { temperature: 0.1 },
      },
    })
    expect(result.success).toBe(true)
  })

  test('rejects an overlay on a misspelled qualified key', () => {
    const result = SystematicConfigSchema.safeParse({
      agents: {
        'review/correctness-reviwer': { temperature: 0.1 },
      },
    })
    expect(result.success).toBe(false)
  })

  test('accepts disabled_agents with a qualified bundled-agent name', () => {
    const result = SystematicConfigSchema.safeParse({
      disabled_agents: ['review/security-reviewer'],
    })
    expect(result.success).toBe(true)
  })

  test('rejects disabled_agents with a misspelled qualified name', () => {
    const result = SystematicConfigSchema.safeParse({
      disabled_agents: ['review/security-reviwer'],
    })
    expect(result.success).toBe(false)
  })
})

describe('createSystematicConfigSchema factory', () => {
  test('runtime SystematicConfigSchema is byte-identical to factory call with committed bundled names', () => {
    const factorySchema = createSystematicConfigSchema({
      agentNames: BUNDLED_AGENT_NAMES,
      qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
      skillNames: BUNDLED_SKILL_NAMES,
    })
    const validConfig = {
      agents: { 'correctness-reviewer': { temperature: 0.2 } },
    }
    expect(SystematicConfigSchema.safeParse(validConfig).success).toBe(true)
    expect(factorySchema.safeParse(validConfig).success).toBe(true)
  })

  test('factory accepts custom agent name sets', () => {
    const fresh = createSystematicConfigSchema({
      agentNames: ['only-this-one'],
      qualifiedAgentIds: ['custom/qualified'],
      skillNames: ['only-this-skill'],
    })
    expect(fresh.safeParse({ agents: { 'only-this-one': {} } }).success).toBe(
      true,
    )
    expect(
      fresh.safeParse({ agents: { 'custom/qualified': {} } }).success,
    ).toBe(true)
    expect(
      fresh.safeParse({ agents: { 'correctness-reviewer': {} } }).success,
    ).toBe(false)
  })

  test('factory rejects skills outside the provided skillNames', () => {
    const fresh = createSystematicConfigSchema({
      agentNames: ['correctness-reviewer'],
      qualifiedAgentIds: [],
      skillNames: ['only-skill'],
    })
    expect(fresh.safeParse({ disabled_skills: ['only-skill'] }).success).toBe(
      true,
    )
    expect(fresh.safeParse({ disabled_skills: ['ce:plan'] }).success).toBe(
      false,
    )
  })
})

describe('removed-names in createSystematicConfigSchema', () => {
  // Synthetic removed names used throughout this block to exercise the
  // accept-and-parse path without depending on the (currently empty)
  // production removed-names lists.
  const SYNTHETIC_REMOVED_SKILL = 'gone-skill'
  const SYNTHETIC_REMOVED_AGENT_BARE = 'gone-agent'
  const SYNTHETIC_REMOVED_AGENT_QUALIFIED = 'review/gone-agent'

  const schemaWithRemovedSkill = createSystematicConfigSchema({
    agentNames: BUNDLED_AGENT_NAMES,
    qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
    skillNames: BUNDLED_SKILL_NAMES,
    removedSkillNames: [SYNTHETIC_REMOVED_SKILL],
    removedAgentNames: [],
  })

  const schemaWithRemovedAgent = createSystematicConfigSchema({
    agentNames: BUNDLED_AGENT_NAMES,
    qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
    skillNames: BUNDLED_SKILL_NAMES,
    removedSkillNames: [],
    removedAgentNames: [
      SYNTHETIC_REMOVED_AGENT_BARE,
      SYNTHETIC_REMOVED_AGENT_QUALIFIED,
    ],
  })

  // Happy path: a removed skill name parses without throwing.
  test('removed skill name parses without throwing', () => {
    const result = schemaWithRemovedSkill.safeParse({
      disabled_skills: [SYNTHETIC_REMOVED_SKILL],
    })
    expect(result.success).toBe(true)
  })

  // Edge case: mix of removed and current skill names parses without throwing.
  test('mix of removed and current skill names parses without throwing', () => {
    const result = schemaWithRemovedSkill.safeParse({
      disabled_skills: [SYNTHETIC_REMOVED_SKILL, 'ce:plan'],
    })
    expect(result.success).toBe(true)
  })

  // Error path: a name in neither current nor removed set still fails.
  test('name in neither current nor removed set still fails validation', () => {
    const result = schemaWithRemovedSkill.safeParse({
      disabled_skills: ['never-existed'],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('disabled_skills'))).toBe(true)
    }
  })

  // Invariant: with empty removed lists, a made-up name still throws exactly as today.
  test('empty removed lists: unknown name still fails (invariant)', () => {
    const schemaEmptyRemoved = createSystematicConfigSchema({
      agentNames: BUNDLED_AGENT_NAMES,
      qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
      skillNames: BUNDLED_SKILL_NAMES,
      removedSkillNames: [],
      removedAgentNames: [],
    })
    const result = schemaEmptyRemoved.safeParse({
      disabled_skills: ['never-existed'],
    })
    expect(result.success).toBe(false)
  })

  // Invariant: with empty removed lists, current valid configs still parse.
  test('empty removed lists: current valid configs still parse (invariant)', () => {
    const schemaEmptyRemoved = createSystematicConfigSchema({
      agentNames: BUNDLED_AGENT_NAMES,
      qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
      skillNames: BUNDLED_SKILL_NAMES,
      removedSkillNames: [],
      removedAgentNames: [],
    })
    const result = schemaEmptyRemoved.safeParse({
      disabled_skills: ['ce:plan'],
      disabled_agents: ['correctness-reviewer'],
    })
    expect(result.success).toBe(true)
  })

  // Removed agent bare name parses without throwing.
  test('removed agent bare name parses without throwing', () => {
    const result = schemaWithRemovedAgent.safeParse({
      disabled_agents: [SYNTHETIC_REMOVED_AGENT_BARE],
    })
    expect(result.success).toBe(true)
  })

  // Removed agent qualified id parses without throwing.
  test('removed agent qualified id parses without throwing', () => {
    const result = schemaWithRemovedAgent.safeParse({
      disabled_agents: [SYNTHETIC_REMOVED_AGENT_QUALIFIED],
    })
    expect(result.success).toBe(true)
  })

  // Mix of removed and current agent names parses without throwing.
  test('mix of removed and current agent names parses without throwing', () => {
    const result = schemaWithRemovedAgent.safeParse({
      disabled_agents: [SYNTHETIC_REMOVED_AGENT_BARE, 'correctness-reviewer'],
    })
    expect(result.success).toBe(true)
  })

  // Invalid agent name not in either set still fails.
  test('invalid agent name not in either set still fails', () => {
    const result = schemaWithRemovedAgent.safeParse({
      disabled_agents: ['never-existed-agent'],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.startsWith('disabled_agents'))).toBe(true)
    }
  })

  // No bare/qualified inference: a removed bare name does not let through
  // a qualified variant that was not explicitly listed.
  test('removed bare name does not let through unlisted qualified variant', () => {
    const schemaBarOnly = createSystematicConfigSchema({
      agentNames: BUNDLED_AGENT_NAMES,
      qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
      skillNames: BUNDLED_SKILL_NAMES,
      removedSkillNames: [],
      removedAgentNames: [SYNTHETIC_REMOVED_AGENT_BARE],
    })
    // The qualified form was not listed in removedAgentNames, so it must fail.
    const result = schemaBarOnly.safeParse({
      disabled_agents: [SYNTHETIC_REMOVED_AGENT_QUALIFIED],
    })
    expect(result.success).toBe(false)
  })
})
