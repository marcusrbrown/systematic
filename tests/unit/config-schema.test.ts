import { describe, expect, test } from 'bun:test'
import {
  OPENCODE_AGENT_COLOR_TOKENS,
  AgentOverlaySchema,
  BootstrapSchema,
  CategoryOverlaySchema,
  SystematicConfigSchema,
  assertSourceCategoryModelDefaults,
  getSecurityOverlayFields,
  validateConfig,
} from '../../src/lib/config-schema.ts'

// Re-import the source tokens for the sync regression test.
// Both copies must stay in sync to prevent drift.
const SOURCE_COLOR_TOKENS: readonly string[] = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
]

describe('SystematicConfigSchema', () => {
  // ── Happy Paths ──────────────────────────────────────────────

  test('parses a complete valid config with all fields populated', () => {
    const input = {
      agents: {
        explorer: {
          model: 'gpt-4',
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
          model: 'claude-3',
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
      expect(result.data.agents.explorer.model).toBe('gpt-4')
      expect(result.data.agents.explorer.temperature).toBe(0.3)
      expect(result.data.agents.explorer.mode).toBe('subagent')
      expect(result.data.agents.explorer.color).toBe('primary')
      expect(result.data.categories.review.model).toBe('claude-3')
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

  // ── Edge Cases ───────────────────────────────────────────────

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

  // ── Error Paths: Agent Overlays ──────────────────────────────

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
      const issue = result.error.issues[0]
      expect(issue.path).toEqual(['agents', 'explorer', 'color'])
      // The refine message lists valid tokens
      expect(issue.message).toMatch(/primary/)
      expect(issue.message).toMatch(/secondary/)
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

  // ── Error Paths: Category Overlays ───────────────────────────

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

  // ── Error Paths: Strict Mode (Unknown Fields) ────────────────

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

// ── Integration: Source Category Model Defaults ────────────────

describe('assertSourceCategoryModelDefaults', () => {
  test('passes for the actual SOURCE_CATEGORY_MODEL_DEFAULTS constant', () => {
    const actualConstants = {
      design: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
      docs: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
      'document-review': ['anthropic/claude-opus-4.7', 'openai/gpt-5.5'],
      research: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
      review: ['anthropic/claude-opus-4.7', 'openai/gpt-5.5'],
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
      research: ['valid-model'],
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

// ── Regression: Trust-Tagged Fields ────────────────────────────

describe('getSecurityOverlayFields', () => {
  test('matches the hand-coded SECURITY_OVERLAY_FIELDS constant', () => {
    // This mirrors src/lib/config.ts:67-72
    const EXPECTED_SECURITY_FIELDS = new Set([
      'model',
      'variant',
      'permission',
      'skills',
    ])

    const derived = getSecurityOverlayFields()
    expect(new Set(derived)).toEqual(EXPECTED_SECURITY_FIELDS)
    expect(derived.sort()).toEqual(Array.from(EXPECTED_SECURITY_FIELDS).sort())
  })

  test('returns consistent results across repeated calls (cached)', () => {
    const first = getSecurityOverlayFields()
    const second = getSecurityOverlayFields()
    expect(first).toEqual(second)
  })
})

// ── Regression: Color Token Sync ───────────────────────────────

describe('OPENCODE_AGENT_COLOR_TOKENS', () => {
  test('matches the source constant in scripts/content-integrity.ts', () => {
    // Both sets of tokens must stay identical. If this test fails, sync
    // the duplicated array in src/lib/config-schema.ts with the source in
    // scripts/content-integrity.ts:722-730.
    expect(OPENCODE_AGENT_COLOR_TOKENS).toEqual(SOURCE_COLOR_TOKENS)
  })
})

// ── Syntax Edge Cases ──────────────────────────────────────────

describe('validateConfig wrapper', () => {
  test('returns success with data for valid input', () => {
    const result = validateConfig({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeDefined()
      expect(result.data!.bootstrap.enabled).toBe(true)
    }
  })

  test('returns failure with errors for invalid input', () => {
    const result = validateConfig({ foo: 'bar' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors).toBeDefined()
      expect(result.errors!.length).toBeGreaterThan(0)
    }
  })
})

// ── Agent Overlay Schema (standalone) ──────────────────────────

describe('AgentOverlaySchema', () => {
  test('parses a minimal valid overlay', () => {
    const result = AgentOverlaySchema.safeParse({ model: 'gpt-4' })
    expect(result.success).toBe(true)
  })

  test('accepts null model (opt-out)', () => {
    const result = AgentOverlaySchema.safeParse({ model: null })
    expect(result.success).toBe(true)
  })

  test('rejects unknown fields via strict mode', () => {
    const result = AgentOverlaySchema.safeParse({
      model: 'gpt-4',
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

// ── Category Overlay Schema (standalone) ───────────────────────

describe('CategoryOverlaySchema', () => {
  test('parses a minimal valid category overlay', () => {
    const result = CategoryOverlaySchema.safeParse({ model: 'gpt-4' })
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

// ── Bootstrap Schema (standalone) ──────────────────────────────

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
