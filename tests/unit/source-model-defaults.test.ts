import { describe, expect, test } from 'bun:test'
import {
  AgentOverlaySchema,
  CategoryOverlaySchema,
} from '../../src/lib/config-schema.js'
import {
  resolveSourceModel,
  SOURCE_CATEGORY_MODEL_DEFAULTS,
  SourceCategoryDefaultsSchema,
} from '../../src/lib/source-model-defaults.js'

describe('SOURCE_CATEGORY_MODEL_DEFAULTS', () => {
  test('happy path: schema parse of the actual constant succeeds', () => {
    const result = SourceCategoryDefaultsSchema.safeParse(
      SOURCE_CATEGORY_MODEL_DEFAULTS,
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(SOURCE_CATEGORY_MODEL_DEFAULTS)
    }
  })

  test('covers all 6 Systematic categories', () => {
    const keys = Object.keys(SOURCE_CATEGORY_MODEL_DEFAULTS)
    expect(keys).toContain('design')
    expect(keys).toContain('docs')
    expect(keys).toContain('document-review')
    expect(keys).toContain('research')
    expect(keys).toContain('review')
    expect(keys).toContain('workflow')
    expect(keys).toHaveLength(6)
  })

  test('every category has a non-empty rationale string', () => {
    for (const [_category, entry] of Object.entries(
      SOURCE_CATEGORY_MODEL_DEFAULTS,
    )) {
      expect(typeof entry.rationale).toBe('string')
      expect(entry.rationale.length).toBeGreaterThan(0)
      expect(entry.rationale.trim()).toBe(entry.rationale)
    }
  })

  test('every category has at least one provider with at least one model', () => {
    for (const [_category, entry] of Object.entries(
      SOURCE_CATEGORY_MODEL_DEFAULTS,
    )) {
      expect(entry.providers.length).toBeGreaterThan(0)
      for (const providerEntry of entry.providers) {
        expect(providerEntry.models.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('SourceCategoryDefaultsSchema validation', () => {
  test('edge case: category with providers: [] fails with non-empty error', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/non.?empty|too_small|minimum/)
    }
  })

  test('edge case: provider entry with models: [] fails with non-empty error', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/non.?empty|too_small|minimum/)
    }
  })

  test('edge case: duplicate provider ID within a category fails validation', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [{ model: 'claude-opus-4-7' }],
          },
          {
            provider: 'anthropic',
            models: [{ model: 'claude-sonnet-4-6' }],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/duplicate|unique|provider/)
    }
  })

  test('edge case: duplicate (model, variant) pair within a provider entry fails validation', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [
              { model: 'claude-opus-4-7', variant: 'max' },
              { model: 'claude-opus-4-7', variant: 'max' },
            ],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/duplicate|unique|model/)
    }
  })

  test('error path: unknown provider ID (not in 7-catalog) fails validation', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'mistral',
            models: [{ model: 'mistral-large' }],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      // The Zod literal union will produce an "invalid_union" or "invalid_literal" error
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  test('error path: variant with whitespace fails validation', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [{ model: 'claude-opus-4-7', variant: 'max extended' }],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/whitespace|non.?empty|pattern/)
    }
  })

  test('error path: empty string variant fails validation', () => {
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [{ model: 'claude-opus-4-7', variant: '' }],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  test('error path: variant longer than 128 chars fails validation', () => {
    const longVariant = 'a'.repeat(129)
    const input = {
      design: {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [{ model: 'claude-opus-4-7', variant: longVariant }],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/128|max|too_big|long/)
    }
  })

  test('error path: category key not matching agents/<category>/ directory fails validation', () => {
    const input = {
      'nonexistent-category': {
        rationale: 'Test rationale',
        providers: [
          {
            provider: 'anthropic',
            models: [{ model: 'claude-opus-4-7' }],
          },
        ],
      },
    }
    const result = SourceCategoryDefaultsSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/category|bundled|agents/)
    }
  })

  test('integration: round-trip JSON.stringify → parse → schema-parse → deep-equal original', () => {
    const serialized = JSON.stringify(SOURCE_CATEGORY_MODEL_DEFAULTS)
    const parsed = JSON.parse(serialized) as unknown
    const result = SourceCategoryDefaultsSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(SOURCE_CATEGORY_MODEL_DEFAULTS)
    }
  })
})

describe('resolveSourceModel', () => {
  test('happy path: first provider hits — returns first available model with variant', () => {
    // anthropic is the first provider for document-review
    const availability = new Set(['anthropic/claude-opus-4-7'])
    const result = resolveSourceModel('document-review', availability)
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-opus-4-7')
    expect(result.variant).toBe('max')
  })

  test('happy path: fallthrough — first provider unavailable, second provider hits', () => {
    // document-review: anthropic first, openai second
    // availability lacks anthropic models but has openai
    const availability = new Set(['openai/gpt-5.5'])
    const result = resolveSourceModel('document-review', availability)
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.5')
    expect(result.variant).toBe('high')
  })

  test('edge case: provider connected but no model match — walks to next provider', () => {
    // anthropic is in availability but with a different model than what document-review lists
    // document-review lists anthropic/claude-opus-4-7 — availability has anthropic/some-other-model
    const availability = new Set(['anthropic/some-other-model'])
    const result = resolveSourceModel('document-review', availability)
    // Should NOT return anthropic since the specific model isn't available
    // Falls through to openai (not available either), then github-copilot (not available), then opencode (not available)
    // Last resort: first provider's first model
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-opus-4-7')
    expect(result.variant).toBe('max')
  })

  test('edge case: last-resort fallback — empty availability returns first provider first model', () => {
    const availability = new Set<string>()
    const result = resolveSourceModel('document-review', availability)
    // document-review first provider is anthropic, first model is claude-opus-4-7 with variant max
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-opus-4-7')
    expect(result.variant).toBe('max')
  })

  test('edge case: last-resort with multi-model first provider — returns FIRST model not second', () => {
    // Use a category where first provider has multiple models
    // Currently all categories have one model per provider, so we test with review
    // review: anthropic/claude-sonnet-4-6 (no variant)
    const availability = new Set<string>()
    const result = resolveSourceModel('review', availability)
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.variant).toBeUndefined()
  })

  test('edge case: resolved entry has no variant — result has variant undefined', () => {
    // review: anthropic/claude-sonnet-4-6 has no variant
    const availability = new Set(['anthropic/claude-sonnet-4-6'])
    const result = resolveSourceModel('review', availability)
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.variant).toBeUndefined()
  })

  test('error path: unknown category throws descriptive error', () => {
    expect(() => resolveSourceModel('not-a-category', new Set())).toThrow(
      /unknown category/,
    )
  })

  test('provider check is model-key membership, not provider-ID membership', () => {
    // Verify that having anthropic/some-other-model does NOT match anthropic/claude-opus-4-7
    // document-review first provider is anthropic with model claude-opus-4-7
    // If we have anthropic/different-model, it should NOT match
    const availability = new Set([
      'anthropic/different-model',
      'openai/gpt-5.5',
    ])
    const result = resolveSourceModel('document-review', availability)
    // anthropic/claude-opus-4-7 not in availability, so anthropic provider is skipped
    // openai/gpt-5.5 IS in availability
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.5')
    expect(result.variant).toBe('high')
  })
})

describe('user-facing variantSchema bounds (config-schema.ts)', () => {
  test('error path: empty string variant in AgentOverlaySchema fails', () => {
    const result = AgentOverlaySchema.safeParse({ variant: '' })
    expect(result.success).toBe(false)
  })

  test('error path: variant with whitespace in AgentOverlaySchema fails', () => {
    const result = AgentOverlaySchema.safeParse({ variant: 'max extended' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/whitespace|pattern/)
    }
  })

  test('error path: variant longer than 128 chars in AgentOverlaySchema fails', () => {
    const longVariant = 'a'.repeat(129)
    const result = AgentOverlaySchema.safeParse({ variant: longVariant })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages.toLowerCase()).toMatch(/128|max|too_big|long/)
    }
  })

  test('happy path: variant of exactly 128 chars in AgentOverlaySchema passes', () => {
    const maxVariant = 'a'.repeat(128)
    const result = AgentOverlaySchema.safeParse({ variant: maxVariant })
    expect(result.success).toBe(true)
  })

  test('error path: empty string variant in CategoryOverlaySchema fails', () => {
    const result = CategoryOverlaySchema.safeParse({ variant: '' })
    expect(result.success).toBe(false)
  })

  test('error path: variant with whitespace in CategoryOverlaySchema fails', () => {
    const result = CategoryOverlaySchema.safeParse({ variant: 'max extended' })
    expect(result.success).toBe(false)
  })

  test('error path: variant longer than 128 chars in CategoryOverlaySchema fails', () => {
    const longVariant = 'a'.repeat(129)
    const result = CategoryOverlaySchema.safeParse({ variant: longVariant })
    expect(result.success).toBe(false)
  })

  test('happy path: variant of exactly 128 chars in CategoryOverlaySchema passes', () => {
    const maxVariant = 'a'.repeat(128)
    const result = CategoryOverlaySchema.safeParse({ variant: maxVariant })
    expect(result.success).toBe(true)
  })
})
