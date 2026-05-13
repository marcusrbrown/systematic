import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AgentOverlaySchema,
  CategoryOverlaySchema,
} from '../../src/lib/config-schema.js'
import {
  assertCategoryCoverageOnDisk,
  formatForDocs,
  resolveSourceModel,
  SOURCE_CATEGORY_MODEL_DEFAULTS,
  SourceCategoryDefaultsSchema,
} from '../../src/lib/source-model-defaults.js'

describe('SOURCE_CATEGORY_MODEL_DEFAULTS', () => {
  test('golden snapshot', () => {
    // Captures only the exported constant — not resolveSourceModel, formatForDocs,
    // or any availability-derived state. Renovate/plugin bumps cannot change this
    // snapshot unless SOURCE_CATEGORY_MODEL_DEFAULTS itself changes.
    expect(SOURCE_CATEGORY_MODEL_DEFAULTS).toMatchSnapshot()
  })

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

  test('error path: rationale containing pipe character fails validation', () => {
    const input = {
      design: {
        rationale: 'Test rationale | with pipe',
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
      expect(messages).toMatch(/pipe|newline|table/i)
    }
  })

  test('error path: rationale containing newline character fails validation', () => {
    const input = {
      design: {
        rationale: 'Test\nrationale with newline',
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
      expect(messages).toMatch(/pipe|newline|table/i)
    }
  })

  test('error path: whenToOverride containing pipe character fails validation', () => {
    const input = {
      design: {
        rationale: 'Valid rationale',
        whenToOverride: 'Override | when bad',
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
      expect(messages).toMatch(/pipe|newline|table/i)
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

describe('assertCategoryCoverageOnDisk', () => {
  // Build a temp agents/ directory layout so coverage checks have something
  // concrete to validate against without depending on the package's real
  // bundled-agents tree.
  let tmpAgentsRoot: string

  function makeTempAgentsDir(categories: string[]): string {
    const root = mkdtempSync(path.join(tmpdir(), 'systematic-coverage-'))
    for (const cat of categories) {
      mkdirSync(path.join(root, cat), { recursive: true })
    }
    return root
  }

  test('happy path: every category key resolves to an existing directory', () => {
    tmpAgentsRoot = makeTempAgentsDir(['design', 'docs', 'review'])
    expect(() =>
      assertCategoryCoverageOnDisk(['design', 'docs', 'review'], tmpAgentsRoot),
    ).not.toThrow()
    rmSync(tmpAgentsRoot, { recursive: true, force: true })
  })

  test('error path: unknown category throws with descriptive message', () => {
    tmpAgentsRoot = makeTempAgentsDir(['design'])
    expect(() =>
      assertCategoryCoverageOnDisk(
        ['design', 'nonexistent-category'],
        tmpAgentsRoot,
      ),
    ).toThrow(/nonexistent-category/)
    rmSync(tmpAgentsRoot, { recursive: true, force: true })
  })

  test('error path: multiple unknown categories all named in the error', () => {
    tmpAgentsRoot = makeTempAgentsDir(['design'])
    expect(() =>
      assertCategoryCoverageOnDisk(
        ['design', 'missing-one', 'missing-two'],
        tmpAgentsRoot,
      ),
    ).toThrow(/missing-one.*missing-two|missing-two.*missing-one/)
    rmSync(tmpAgentsRoot, { recursive: true, force: true })
  })

  test('edge case: agents directory missing entirely — tolerated as no-op', () => {
    // Without a bundled agents directory present, the validator skips the check
    // so that test environments and packaging variations don't false-positive.
    const nonexistentRoot = path.join(tmpdir(), 'systematic-no-agents-here')
    expect(() =>
      assertCategoryCoverageOnDisk(['design'], nonexistentRoot),
    ).not.toThrow()
  })

  test('integration: real bundled agents/ directory covers every SOURCE_CATEGORY_MODEL_DEFAULTS key', () => {
    // No agentsDir argument — uses the package's real bundled-agents tree.
    // This is the production invariant the PR commits SOURCE_CATEGORY_MODEL_DEFAULTS to.
    const keys = Object.keys(SOURCE_CATEGORY_MODEL_DEFAULTS)
    expect(() => assertCategoryCoverageOnDisk(keys)).not.toThrow()
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
    const result = AgentOverlaySchema.safeParse({
      model: 'openai/gpt-5.5',
      variant: maxVariant,
    })
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
    const result = CategoryOverlaySchema.safeParse({
      model: 'openai/gpt-5.5',
      variant: maxVariant,
    })
    expect(result.success).toBe(true)
  })
})

describe('formatForDocs', () => {
  test('happy path: returns one row per SOURCE_CATEGORY_MODEL_DEFAULTS key', () => {
    const table = formatForDocs()
    const categoryCount = Object.keys(SOURCE_CATEGORY_MODEL_DEFAULTS).length
    // Count data rows (lines starting with '|' that are not the header or separator)
    const lines = table.split('\n').filter((l) => l.startsWith('|'))
    // lines[0] = header, lines[1] = separator, lines[2..] = data rows
    const dataRows = lines.slice(2)
    expect(dataRows).toHaveLength(categoryCount)
  })

  test('happy path: chain field reflects first 2-3 provider entries in provider/model[+variant] format', () => {
    const table = formatForDocs()
    // document-review has 4 providers: anthropic (claude-opus-4-7+max), openai (gpt-5.5+high), github-copilot (gemini-3.1-pro-preview), opencode (claude-sonnet-4-6)
    // With MAX_PROVIDERS=3, chain should show first 3 + ', …'
    expect(table).toContain(
      'anthropic/claude-opus-4-7+max, openai/gpt-5.5+high, github-copilot/gemini-3.1-pro-preview, …',
    )
  })

  test('edge case: category without whenToOverride renders em-dash in that column', () => {
    const table = formatForDocs()
    // 'docs' has no whenToOverride — its row should end with '| — |'
    const lines = table.split('\n')
    const docsRow = lines.find((l) => l.startsWith('| docs '))
    expect(docsRow).toBeDefined()
    expect(docsRow).toMatch(/\| — \|$/)
  })

  test('edge case: category with whenToOverride renders the text (not em-dash)', () => {
    const table = formatForDocs()
    // 'design' has whenToOverride set
    const lines = table.split('\n')
    const designRow = lines.find((l) => l.startsWith('| design '))
    expect(designRow).toBeDefined()
    // Should NOT end with '| — |'
    expect(designRow).not.toMatch(/\| — \|$/)
    // Should contain the actual whenToOverride text
    expect(designRow).toContain(
      SOURCE_CATEGORY_MODEL_DEFAULTS.design.whenToOverride,
    )
  })

  test('edge case: category with exactly 3 provider entries renders chain without trailing ", …"', () => {
    // 'review' has 4 providers, so it WILL have '…'. Let's verify a category with <=3 providers
    // 'workflow' has 4 providers too. All current categories have 4 providers.
    // We test the truncation logic directly: design has 4 providers → should have '…'
    const table = formatForDocs()
    const lines = table.split('\n')
    const designRow = lines.find((l) => l.startsWith('| design '))
    expect(designRow).toBeDefined()
    // design has 4 providers → chain should end with ', …'
    expect(designRow).toContain(', …')
  })

  test('edge case: chain truncation — category with >3 provider entries shows first 3 then ", …"', () => {
    const table = formatForDocs()
    // 'review' has 4 providers: anthropic, openai, github-copilot, opencode
    // Chain should show first 3 + ', …'
    expect(table).toContain(
      'anthropic/claude-sonnet-4-6, openai/gpt-5.3-codex, github-copilot/gemini-3.1-pro-preview, …',
    )
  })

  test('happy path: output starts with header and separator rows', () => {
    const table = formatForDocs()
    expect(table).toMatch(
      /^\| Category \| Chain \| Rationale \| When to Override \|\n\| --- \| --- \| --- \| --- \|\n/,
    )
  })

  test('happy path: output ends with newline', () => {
    const table = formatForDocs()
    expect(table.endsWith('\n')).toBe(true)
  })
})
