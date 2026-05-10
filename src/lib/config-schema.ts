/**
 * Zod schema for the user-facing `systematic.json` / `systematic.jsonc` config.
 *
 * ## Zod 4 API notes (verified against zod@4.4.3 during implementation)
 *
 * - `z.toJSONSchema(schema, { target: 'draft-7' })` produces draft-07 JSON Schema.
 * - `.default(value)` DOES round-trip into JSON Schema `default`.
 * - `.meta({ description, examples })` attaches documentation metadata visible in
 *   JSON Schema output and via `schema.description`.
 * - Metadata is stored in `z.globalRegistry` (a `Map<ZodType, object>`), accessible
 *   via `z.globalRegistry.get(schema)`.
 * - `z.object().strict()` rejects unknown keys with `unrecognized_keys` issues that
 *   include the offending key names and the path to the containing object.
 * - `z.record(keySchema, valueSchema)` is the canonical 2-arg form (Zod 4 types
 *   require both key and value schemas). A single-arg overload works at runtime
 *   but is not reflected in the type declarations for this Zod 4 minor.
 */

import { z } from 'zod'

// ── Color Tokens ───────────────────────────────────────────────
// Mirrors OPENCODE_AGENT_COLOR_TOKENS from scripts/content-integrity.ts.
// Duplicated here to avoid cross-directory imports (rootDir: src).
// A regression test in config-schema.test.ts asserts they stay in sync.

export const OPENCODE_AGENT_COLOR_TOKENS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const

// ── Shared Primitives ──────────────────────────────────────────

const permissionSettingSchema = z.enum(['ask', 'allow', 'deny'] as const)

const permissionRuleSchema = z.union([
  permissionSettingSchema,
  z.record(z.string(), permissionSettingSchema),
])

const permissionSchema = z.record(z.string(), permissionRuleSchema).meta({
  description: 'Permission overrides per tool',
  examples: [{ edit: 'allow', bash: { curl: 'allow', rm: 'deny' } }],
})

const modelSchema = z
  .string()
  .min(1)
  .nullable()
  .meta({
    description:
      'Model identifier in provider/model format, or null to inherit parent model',
    examples: ['anthropic/claude-sonnet-4', null],
  })

const variantSchema = z
  .string()
  .min(1)
  .meta({
    description: 'Model variant identifier',
    examples: ['v2', 'extended'],
  })

const temperatureSchema = z
  .number()
  .min(0)
  .meta({
    description: 'Sampling temperature (≥0; 0 = deterministic)',
    examples: [0.1, 0.7, 0],
  })

const topPSchema = z
  .number()
  .min(0)
  .max(1)
  .meta({
    description: 'Nucleus sampling parameter (0 to 1)',
    examples: [0.9, 0.1, 1],
  })

const modeSchema = z.enum(['subagent', 'primary', 'all'] as const).meta({
  description: 'Agent execution mode',
  examples: ['subagent', 'primary', 'all'],
})

const hexColorRegex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const colorTokensList = OPENCODE_AGENT_COLOR_TOKENS.join(', ')

const colorSchema = z
  .string()
  .refine(
    (val) =>
      hexColorRegex.test(val) ||
      (OPENCODE_AGENT_COLOR_TOKENS as readonly string[]).includes(val),
    {
      message: `Must be a hex color (#RGB or #RRGGBB) or one of: ${colorTokensList}`,
    },
  )
  .meta({
    description:
      'Agent color — named token from OpenCode or hex color (#RGB / #RRGGBB)',
    examples: ['primary', '#ff6600'],
  })

const stepsSchema = z
  .number()
  .int()
  .positive()
  .meta({
    description: 'Maximum execution steps (positive integer)',
    examples: [10, 50],
  })

const hiddenSchema = z.boolean().meta({
  description: 'Hide agent from UI',
  examples: [true, false],
})

const disableSchema = z.boolean().meta({
  description: 'Disable this agent overlay',
  examples: [true, false],
})

const skillsSchema = z.array(z.string().min(1)).meta({
  description: 'Skills enabled for this agent',
  examples: [['systematic:ce-plan', 'systematic:ce-review']],
})

// ── Trust Metadata Helpers ─────────────────────────────────────

/**
 * Tag an overlay field as "any trust level" — settable by any config source.
 */
function trustAny<T extends z.ZodType>(schema: T): T {
  return schema.meta({ trust: 'any' }) as T
}

/**
 * Tag an overlay field as "project-or-higher" — only user-level or
 * custom-level config sources may set this field. Mirrors the
 * `SECURITY_OVERLAY_FIELDS` set in `src/lib/config.ts`.
 */
function trustProtected<T extends z.ZodType>(schema: T): T {
  return schema.meta({ trust: 'project-or-higher' }) as T
}

// ── Agent Overlay Schema ───────────────────────────────────────

export const AgentOverlaySchema = z
  .object({
    model: trustProtected(modelSchema).optional(),
    variant: trustProtected(variantSchema).optional(),
    temperature: trustAny(temperatureSchema).optional(),
    top_p: trustAny(topPSchema).optional(),
    mode: modeSchema.optional(),
    color: colorSchema.optional(),
    steps: stepsSchema.optional(),
    hidden: hiddenSchema.optional(),
    disable: disableSchema.optional(),
    skills: trustProtected(skillsSchema).optional(),
    permission: trustProtected(permissionSchema).optional(),
  })
  .strict()
  .meta({
    description: 'Per-agent configuration overlay',
    examples: [{ model: 'gpt-4', temperature: 0.3, mode: 'subagent' }],
  })

// ── Category Overlay Schema ────────────────────────────────────

export const CategoryOverlaySchema = z
  .object({
    model: trustProtected(modelSchema).optional(),
    variant: trustProtected(variantSchema).optional(),
    temperature: trustAny(temperatureSchema).optional(),
    top_p: trustAny(topPSchema).optional(),
    mode: modeSchema.optional(),
    color: colorSchema.optional(),
    steps: stepsSchema.optional(),
    hidden: hiddenSchema.optional(),
    skills: trustProtected(skillsSchema).optional(),
    permission: trustProtected(permissionSchema).optional(),
  })
  .strict()
  .meta({
    description:
      'Per-category configuration overlay (same fields as agent minus disable)',
    examples: [{ model: 'gpt-4', temperature: 0.3 }],
  })

// ── Bootstrap Schema ───────────────────────────────────────────

export const BootstrapSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .meta({
        description:
          'Enable bootstrap prompt injection into every conversation',
        examples: [true, false],
      }),
    file: z
      .string()
      .optional()
      .meta({
        description: 'Path to a custom bootstrap prompt file',
        examples: ['/home/user/.opencode/bootstrap.md'],
      }),
  })
  .strict()
  .meta({
    description: 'Bootstrap prompt configuration',
    examples: [{ enabled: true }, { enabled: false }],
  })

// ── Top-Level Config Schema ────────────────────────────────────

export const SystematicConfigSchema = z
  .object({
    agents: z
      .record(z.string(), AgentOverlaySchema)
      .default({})
      .meta({
        description: 'Per-agent configuration overlays keyed by agent name',
        examples: [{ explorer: { temperature: 0.3 } }, {}],
      }),
    categories: z
      .record(z.string(), CategoryOverlaySchema)
      .default({})
      .meta({
        description:
          'Per-category configuration overlays keyed by category name',
        examples: [{ review: { model: 'gpt-4' } }, {}],
      }),
    disabled_skills: z
      .array(z.string())
      .default([])
      .meta({
        description: 'Array of skill names to disable globally',
        examples: [['ce:plan', 'ce:review']],
      }),
    disabled_agents: z
      .array(z.string())
      .default([])
      .meta({
        description: 'Array of agent names to disable globally',
        examples: [['architect-agent', 'redundant-reviewer']],
      }),
    disabled_commands: z
      .array(z.string())
      .default([])
      .meta({
        description: 'Array of command names to disable globally',
        examples: [['outdated-command']],
      }),
    bootstrap: BootstrapSchema.default({ enabled: true }).meta({
      description: 'Bootstrap prompt configuration',
      examples: [
        { enabled: true },
        { enabled: false, file: '/path/to/custom.md' },
      ],
    }),
  })
  .strict()
  .meta({
    description:
      'Systematic user configuration file (systematic.json / systematic.jsonc)',
    examples: [{ disabled_skills: ['ce:plan'], bootstrap: { enabled: false } }],
  })

// ── Validation Helpers ─────────────────────────────────────────

export interface ValidationResult {
  success: boolean
  data?: z.infer<typeof SystematicConfigSchema>
  errors?: readonly z.ZodIssue[]
}

export function validateConfig(input: unknown): ValidationResult {
  const result = SystematicConfigSchema.safeParse(input)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, errors: result.error.issues }
}

// ── Source Category Model Defaults Assertion ────────────────────

const SourceCategoryModelDefaultsSchema = z
  .record(z.string(), z.array(z.string().min(1)).min(1))
  .meta({
    description: 'Validates source category model defaults shape',
    examples: [{ design: ['gpt-4', 'claude-3'] }],
  })

export function assertSourceCategoryModelDefaults(
  defaults: Record<string, unknown>,
): void {
  SourceCategoryModelDefaultsSchema.parse(defaults)
}

// ── Trust-Field Extraction ─────────────────────────────────────

/**
 * Unwrap ZodOptional / ZodDefault wrappers to reach the base schema.
 * In Zod 4, optional wrappers have `_def.type === 'optional'` and
 * default wrappers have `_def.type === 'default'`.
 */
function unwrapMeta(schema: z.ZodType): z.ZodType {
  let inner: z.ZodType = schema
  const def = inner._def as { type?: string; innerType?: z.ZodType }
  if (def.type === 'optional' || def.type === 'default') {
    inner = def.innerType as z.ZodType
  }
  return inner
}

/**
 * Collect overlay field names tagged with a specific trust level by
 * inspecting per-field metadata from `z.globalRegistry`.
 */
function collectTrustTaggedFields(
  schema: z.ZodObject<z.ZodRawShape>,
  trust: 'project-or-higher' | 'any',
): string[] {
  const fields: string[] = []
  const shape = schema._def.shape as Record<string, z.ZodType>

  for (const [key, field] of Object.entries(shape)) {
    const base = unwrapMeta(field)
    const meta = z.globalRegistry.get(base)
    if (meta && (meta as Record<string, unknown>).trust === trust) {
      fields.push(key)
    }
  }

  return fields
}

let _cachedSecurityFields: string[] | null = null

/**
 * Returns overlay fields that require a project-or-higher trust source.
 * Mirrors the hand-coded `SECURITY_OVERLAY_FIELDS` set in `src/lib/config.ts`.
 */
export function getSecurityOverlayFields(): string[] {
  if (_cachedSecurityFields) return _cachedSecurityFields
  _cachedSecurityFields = collectTrustTaggedFields(
    AgentOverlaySchema,
    'project-or-higher',
  )
  return _cachedSecurityFields
}
