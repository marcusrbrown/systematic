/**
 * Provider-grouped source category model defaults for Systematic bundled agents.
 *
 * This module owns the canonical shape, Zod schema, and constant for the
 * per-category model resolution chain. The resolution algorithm walks
 * the provider list in order and picks the first available provider/model pair.
 *
 * Provider catalog is constrained to the 7 IDs with empirical OMO usage-frequency
 * justification: vercel=80, opencode=55, github-copilot=39, opencode-go=26,
 * openai=20, anthropic=18, google=10.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, '..', '..')
const bundledAgentsDir = path.join(packageRoot, 'agents')

/**
 * Zod literal union of the 7 supported provider IDs.
 * Ordered by OMO empirical usage frequency (highest first).
 */
export const ProviderID = z.union([
  z.literal('vercel'),
  z.literal('opencode'),
  z.literal('github-copilot'),
  z.literal('opencode-go'),
  z.literal('openai'),
  z.literal('anthropic'),
  z.literal('google'),
])

export type ProviderID = z.infer<typeof ProviderID>

const variantSchema = z
  .string()
  .min(1, 'variant must be a non-empty string')
  .max(128, 'variant must be at most 128 characters')
  .regex(/^\S+$/, 'variant must not contain whitespace')

/**
 * Table-cell-safe string for `rationale` and `whenToOverride`. Markdown
 * table cells cannot contain raw `|` (pipe — would split the row) or
 * `\r` / `\n` (newline — would terminate the row). The generator interpolates
 * these strings directly into table rows in `formatForDocs()`, so failing
 * fast at the schema level beats producing a malformed table downstream.
 */
const tableCellSchema = z
  .string()
  .min(1, 'must be a non-empty string')
  .regex(
    /^[^|\r\n]+$/,
    'must not contain pipe (|) or newline characters — these break Markdown table generation',
  )

const ModelEntrySchema = z
  .object({
    model: z.string().min(1, 'model must be a non-empty string'),
    variant: variantSchema.optional(),
  })
  .strict()

const ProviderEntrySchema = z
  .object({
    provider: ProviderID,
    models: z
      .array(ModelEntrySchema)
      .min(
        1,
        'models must be non-empty — every provider entry must list at least one model',
      ),
  })
  .strict()
  .refine(
    (entry) => {
      const seen = new Set<string>()
      for (const m of entry.models) {
        const key = `${m.model}::${m.variant ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
      }
      return true
    },
    {
      message:
        'duplicate (model, variant) pair within a provider entry — each model+variant combination must be unique',
    },
  )

const CategoryDefaultSchema = z
  .object({
    rationale: tableCellSchema,
    whenToOverride: tableCellSchema.optional(),
    providers: z
      .array(ProviderEntrySchema)
      .min(
        1,
        'providers must be non-empty — every category must list at least one provider',
      ),
  })
  .strict()
  .refine(
    (cat) => {
      const seen = new Set<string>()
      for (const p of cat.providers) {
        if (seen.has(p.provider)) return false
        seen.add(p.provider)
      }
      return true
    },
    {
      message:
        'duplicate provider ID within a category — each provider must appear at most once per category',
    },
  )

/**
 * Reads the bundled agents directory and returns the set of valid category names.
 *
 * Used by `assertCategoryCoverageOnDisk` to verify that every key in
 * `SOURCE_CATEGORY_MODEL_DEFAULTS` maps to a real bundled-agent category
 * directory. Pure helper — kept separate from the schema so the schema
 * stays free of filesystem I/O.
 */
function readBundledAgentCategories(agentsDir: string): Set<string> {
  if (!fs.existsSync(agentsDir)) return new Set()
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  const categories = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory()) {
      categories.add(entry.name)
    }
  }
  return categories
}

/**
 * Zod schema for the full source category model defaults map.
 *
 * Schema is **pure** — it validates only structural correctness:
 * - Shape correctness (CategoryDefaultSchema per value)
 * - Provider lists non-empty (enforced by CategoryDefaultSchema)
 * - Model lists non-empty (enforced by ProviderEntrySchema)
 * - (model, variant) pairs unique within a provider entry
 * - Provider IDs unique within a category
 * - variant is non-empty, whitespace-free, max 128 chars
 * - `rationale` and `whenToOverride` reject pipe (`|`) and newline characters
 *   so the generator produces well-formed Markdown tables
 *
 * Filesystem coverage (every key resolves to a real `agents/<category>/`
 * directory) is NOT checked here. Use `assertCategoryCoverageOnDisk` to
 * enforce that invariant from tests where it matters; the production
 * runtime path uses `assertSourceCategoryModelCoverage` from
 * `agent-overlays.ts` against an in-memory inventory rather than reading
 * disk again.
 */
export const SourceCategoryDefaultsSchema = z.record(
  z.string(),
  CategoryDefaultSchema,
)

/**
 * Verify that every category key in `categories` maps to a real
 * `agents/<category>/` directory on disk under `agentsDir` (defaulting to
 * the package's bundled-agents directory). Throws with a useful message if
 * any keys are unrecognized.
 *
 * Use from tests to lock the SOURCE_CATEGORY_MODEL_DEFAULTS ↔ agents/
 * directory layout contract. The production runtime path validates the
 * inverse direction (every bundled-agent category has a source default)
 * via `assertSourceCategoryModelCoverage` in `agent-overlays.ts`.
 */
export function assertCategoryCoverageOnDisk(
  categories: readonly string[],
  agentsDir: string = bundledAgentsDir,
): void {
  const validCategories = readBundledAgentCategories(agentsDir)
  if (validCategories.size === 0) return // tolerate environments without bundled agents
  const unknownKeys = categories.filter((k) => !validCategories.has(k))
  if (unknownKeys.length > 0) {
    throw new Error(
      `assertCategoryCoverageOnDisk: no agents/<category>/ directory found for: ${unknownKeys.join(', ')}. Either add the directories or remove the keys from SOURCE_CATEGORY_MODEL_DEFAULTS.`,
    )
  }
}

export interface ModelEntry {
  model: string
  variant?: string
}

export interface ProviderEntry {
  provider: ProviderID
  models: ModelEntry[]
}

export interface CategoryDefault {
  rationale: string
  whenToOverride?: string
  providers: ProviderEntry[]
}

export type SourceCategoryDefaults = Record<string, CategoryDefault>

/**
 * Provider-grouped source model defaults for the 6 Systematic agent categories.
 *
 * Provider chains are ordered by OMO category-fit reasoning. The resolver
 * walks providers in order and picks the first available provider/model pair.
 * If no provider is available, the first entry of the first provider is used as
 * the last-resort fallback.
 *
 * Model choices translate the existing flat-string-array constant in agent-overlays.ts
 * to the new provider-grouped shape, with variant annotations where applicable.
 */
export const SOURCE_CATEGORY_MODEL_DEFAULTS: SourceCategoryDefaults = {
  design: {
    rationale:
      'High-judgment UX, product, and design work benefits from a strong general reasoning model with broad creative capability.',
    whenToOverride:
      'Override to a faster/cheaper model when design tasks are primarily templating or low-stakes layout work.',
    providers: [
      {
        provider: 'github-copilot',
        models: [{ model: 'gemini-3.1-pro-preview' }],
      },
      {
        provider: 'openai',
        models: [{ model: 'gpt-5.5', variant: 'high' }],
      },
      {
        provider: 'anthropic',
        models: [{ model: 'claude-opus-4-7', variant: 'max' }],
      },
      {
        provider: 'vercel',
        models: [{ model: 'v0-1.5-md' }],
      },
    ],
  },
  docs: {
    rationale:
      'Documentation and summarization tasks should start cheaper and faster; quality is sufficient at mid-tier models.',
    providers: [
      {
        provider: 'github-copilot',
        models: [{ model: 'gemini-3.1-pro-preview' }],
      },
      {
        provider: 'openai',
        models: [{ model: 'gpt-5.4-mini' }],
      },
      {
        provider: 'anthropic',
        models: [{ model: 'claude-haiku-4-5' }],
      },
      {
        provider: 'opencode',
        models: [{ model: 'claude-haiku-4-5' }],
      },
    ],
  },
  'document-review': {
    rationale:
      'Requirements and plan critique benefit from the strongest nuanced reasoning to surface non-obvious gaps and contradictions.',
    providers: [
      {
        provider: 'anthropic',
        models: [{ model: 'claude-opus-4-7', variant: 'max' }],
      },
      {
        provider: 'openai',
        models: [{ model: 'gpt-5.5', variant: 'high' }],
      },
      {
        provider: 'github-copilot',
        models: [{ model: 'gemini-3.1-pro-preview' }],
      },
      {
        provider: 'opencode',
        models: [{ model: 'claude-sonnet-4-6' }],
      },
    ],
  },
  research: {
    rationale:
      'Tool-heavy synthesis and source evaluation benefit from a strong general reasoning model with broad knowledge.',
    providers: [
      {
        provider: 'openai',
        models: [{ model: 'gpt-5.4-mini' }],
      },
      {
        provider: 'anthropic',
        models: [{ model: 'claude-sonnet-4-6' }],
      },
      {
        provider: 'github-copilot',
        models: [{ model: 'gemini-3.1-pro-preview' }],
      },
      {
        provider: 'opencode',
        models: [{ model: 'claude-sonnet-4-6' }],
      },
    ],
  },
  review: {
    rationale:
      'Code, security, and adversarial review benefits from the strongest reasoning to catch subtle bugs and security issues.',
    whenToOverride:
      'Override to a faster model when review tasks are primarily style or formatting checks rather than correctness or security analysis.',
    providers: [
      {
        provider: 'anthropic',
        models: [{ model: 'claude-sonnet-4-6' }],
      },
      {
        provider: 'openai',
        models: [{ model: 'gpt-5.3-codex' }],
      },
      {
        provider: 'github-copilot',
        models: [{ model: 'gemini-3.1-pro-preview' }],
      },
      {
        provider: 'opencode',
        models: [{ model: 'claude-sonnet-4-6' }],
      },
    ],
  },
  workflow: {
    rationale:
      'Orchestration and bounded implementation tasks should default cheaper and faster; strong reasoning is rarely needed for routing decisions.',
    providers: [
      {
        provider: 'openai',
        models: [{ model: 'gpt-5.4-mini' }],
      },
      {
        provider: 'anthropic',
        models: [{ model: 'claude-sonnet-4-6' }],
      },
      {
        provider: 'opencode',
        models: [{ model: 'claude-haiku-4-5' }],
      },
      {
        provider: 'opencode-go',
        models: [{ model: 'claude-haiku-4-5' }],
      },
    ],
  },
}

/**
 * Format the SOURCE_CATEGORY_MODEL_DEFAULTS as a GitHub-flavored markdown table
 * for injection into documentation.
 *
 * Columns: Category | Chain | Rationale | When to Override
 *
 * Chain format: comma-separated `provider/model[+variant]` for the first 2–3
 * provider entries (first model per provider). Appends `, …` when there are
 * more than 3 provider entries.
 *
 * Returns a string ending with `\n` for clean concatenation.
 */
export function formatForDocs(): string {
  const header =
    '| Category | Chain | Rationale | When to Override |\n| --- | --- | --- | --- |\n'

  const rows = Object.entries(SOURCE_CATEGORY_MODEL_DEFAULTS)
    .map(([category, entry]) => {
      // Build chain: up to 3 provider entries, first model per provider
      const MAX_PROVIDERS = 3
      const providerEntries = entry.providers
      const shown = providerEntries.slice(0, MAX_PROVIDERS)
      const hasMore = providerEntries.length > MAX_PROVIDERS

      const chainParts = shown.map((pe) => {
        const firstModel = pe.models[0]
        const base = `${pe.provider}/${firstModel.model}`
        return firstModel.variant ? `${base}+${firstModel.variant}` : base
      })

      if (hasMore) {
        chainParts.push('…')
      }

      const chain = chainParts.join(', ')
      const whenToOverride = entry.whenToOverride ?? '—'

      return `| ${category} | ${chain} | ${entry.rationale} | ${whenToOverride} |`
    })
    .join('\n')

  return `${header}${rows}\n`
}

/**
 * Walk the provider-grouped shape for a category and return the first available
 * provider/model pair from the availability set.
 *
 * Algorithm:
 * 1. Look up the category. Unknown category is a programmer error — throw.
 * 2. Walk providers in declared order. For each provider, walk its models in
 *    declared order and test `${provider}/${model}` membership in availabilitySet.
 * 3. On first hit, return { provider, model, variant? }.
 * 4. Last-resort fallback (no available model anywhere): return the first model
 *    entry of the first provider entry, including its variant if present.
 */
export function resolveSourceModel(
  category: string,
  availabilitySet: ReadonlySet<string>,
): { provider: ProviderID; model: string; variant?: string } {
  const categoryDefault = (
    SOURCE_CATEGORY_MODEL_DEFAULTS as Record<
      string,
      CategoryDefault | undefined
    >
  )[category]
  if (!categoryDefault) {
    throw new Error(
      `resolveSourceModel: unknown category "${category}". Valid categories: ${Object.keys(SOURCE_CATEGORY_MODEL_DEFAULTS).join(', ')}`,
    )
  }

  for (const providerEntry of categoryDefault.providers) {
    for (const modelEntry of providerEntry.models) {
      const key = `${providerEntry.provider}/${modelEntry.model}`
      if (availabilitySet.has(key)) {
        return {
          provider: providerEntry.provider,
          model: modelEntry.model,
          variant: modelEntry.variant,
        }
      }
    }
  }

  // Last-resort fallback: first provider's first model
  const firstProvider = categoryDefault.providers[0]
  const firstModel = firstProvider.models[0]
  return {
    provider: firstProvider.provider,
    model: firstModel.model,
    variant: firstModel.variant,
  }
}
