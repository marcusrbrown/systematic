/**
 * Zod schema for the user-facing `systematic.json` / `systematic.jsonc` config.
 *
 * ## Zod 4 API notes (verified against zod@4.4.3 during implementation)
 *
 * - `z.toJSONSchema(schema, { target: 'draft-7' })` produces draft-07 JSON Schema.
 * - `.default(value)` DOES round-trip into JSON Schema `default`.
 * - `.meta({ description, examples })` attaches documentation metadata visible in
 *   JSON Schema output and via `schema.description`.
 * - `z.object().strict()` rejects unknown keys with `unrecognized_keys` issues that
 *   include the offending key names and the path to the containing object.
 * - `z.record(keySchema, valueSchema)` is the canonical 2-arg form (Zod 4 types
 *   require both key and value schemas). A single-arg overload works at runtime
 *   but is not reflected in the type declarations for this Zod 4 minor.
 */

import { z } from 'zod'
import { OPENCODE_AGENT_COLOR_TOKENS } from './agent-colors.js'

const permissionSettingSchema = z.enum(['ask', 'allow', 'deny'] as const)

const permissionRuleSchema = z.union([
  permissionSettingSchema,
  z.record(z.string(), permissionSettingSchema),
])

const permissionSchema = z.record(z.string(), permissionRuleSchema).meta({
  description: 'Permission overrides per tool',
  examples: [{ edit: 'allow', bash: { curl: 'allow', rm: 'deny' } }],
})

const MODEL_FORMAT_MESSAGE =
  'must be in provider/model format (e.g., "anthropic/claude-sonnet-4")'

/**
 * Pattern for provider/model format.
 * Provider: one or more non-whitespace, non-slash chars (e.g., "anthropic", "openai").
 * Model: one or more non-whitespace chars — may contain slashes for multi-segment
 *        paths such as "openrouter/anthropic/claude-sonnet-4".
 *
 * This is an exact regex translation of the original isValidModelFormat check:
 * "no whitespace anywhere, at least one char before the first slash, at least one
 * char after it." Using .regex() instead of .refine() so the constraint round-trips
 * into JSON Schema as a `pattern` field and IDEs can validate model strings.
 */
const MODEL_FORMAT_REGEX = /^[^\s/]+\/\S+$/

const modelSchema = z
  .string()
  .min(1)
  .regex(MODEL_FORMAT_REGEX, MODEL_FORMAT_MESSAGE)
  .nullable()
  .meta({
    description:
      'Model identifier in provider/model format, or null to inherit parent model',
    examples: ['anthropic/claude-sonnet-4', null],
  })

const variantSchema = z
  .string()
  .min(1)
  .regex(/^\S+$/, 'must be a non-empty string without whitespace')
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

/**
 * Color schema as a union of named tokens and hex literals.
 * Using z.union() + z.enum() + .regex() instead of .refine() so both branches
 * round-trip into JSON Schema as anyOf:[{enum:[...]},{pattern:"..."}].
 * This lets IDEs validate color values against the published schema.
 * Only 6-digit hex is accepted (#RRGGBB) — matches isValidAgentColor in agent-colors.ts.
 */
const colorSchema = z
  .union([
    z.enum(OPENCODE_AGENT_COLOR_TOKENS),
    z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color (#RRGGBB)'),
  ])
  .meta({
    description:
      'Agent color — named token from OpenCode or 6-digit hex color (#RRGGBB)',
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
  examples: [['ce:plan', 'ce:review']],
})

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
    examples: [
      {
        model: 'anthropic/claude-opus-4.7',
        temperature: 0.1,
        mode: 'subagent',
      },
    ],
  })

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
    examples: [{ model: 'anthropic/claude-opus-4.7', temperature: 0.1 }],
  })

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
        examples: ['~/.config/opencode/bootstrap.md'],
      }),
  })
  .strict()
  .meta({
    description: 'Bootstrap prompt configuration',
    examples: [{ enabled: true }, { enabled: false }],
  })

export const SystematicConfigSchema = z
  .object({
    $schema: z
      .string()
      .url()
      .optional()
      .meta({
        description:
          'JSON Schema URL for IDE autocomplete. The value is informational only — the loader does not fetch or validate against it. Add this to enable IDE schema activation and field-level autocomplete in editors that support JSON Schema (VSCode, Zed, IntelliJ).',
        examples: [
          'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
        ],
      }),
    agents: z
      .record(z.string(), AgentOverlaySchema)
      .default({})
      .meta({
        description: 'Per-agent configuration overlays keyed by agent name',
        examples: [{ 'correctness-reviewer': { temperature: 0.1 } }, {}],
      }),
    categories: z
      .record(z.string(), CategoryOverlaySchema)
      .default({})
      .meta({
        description:
          'Per-category configuration overlays keyed by category name',
        examples: [{ review: { model: 'anthropic/claude-opus-4.7' } }, {}],
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
        examples: [['previous-comments-reviewer', 'cli-readiness-reviewer']],
      }),
    disabled_commands: z
      .array(z.string())
      .default([])
      .meta({
        description: 'Array of command names to disable globally',
        examples: [['deprecated-migration-helper']],
      }),
    bootstrap: BootstrapSchema.default({ enabled: true }).meta({
      description: 'Bootstrap prompt configuration',
      examples: [
        { enabled: true },
        { enabled: false, file: '.opencode/custom-prompt.md' },
      ],
    }),
  })
  .strict()
  .meta({
    description:
      'Systematic user configuration file (systematic.json / systematic.jsonc)',
    examples: [{ disabled_skills: ['ce:plan'], bootstrap: { enabled: false } }],
  })

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

const SourceCategoryModelDefaultsSchema = z
  .record(
    z.string(),
    z
      .array(z.string().min(1).regex(MODEL_FORMAT_REGEX, MODEL_FORMAT_MESSAGE))
      .min(1),
  )
  .meta({
    description: 'Validates source category model defaults shape',
    examples: [{ design: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7'] }],
  })

export function assertSourceCategoryModelDefaults(
  defaults: Record<string, unknown>,
): void {
  SourceCategoryModelDefaultsSchema.parse(defaults)
}

/**
 * Overlay fields that require a project-or-higher trust source.
 *
 * This list is co-located with the schema definitions above so that any
 * future field additions that need trust protection are added here at the
 * same time. The regression tests in tests/unit/config-schema.test.ts
 * assert that this list agrees with every field tagged `.meta({ trust:
 * 'project-or-higher' })` in AgentOverlaySchema — preventing silent drift.
 *
 * Matches the hand-coded `SECURITY_OVERLAY_FIELDS` set in `src/lib/config.ts`.
 */
export const SECURITY_OVERLAY_FIELDS: readonly string[] = [
  'model',
  'variant',
  'skills',
  'permission',
] as const
