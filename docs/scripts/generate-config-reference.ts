#!/usr/bin/env bun
/**
 * Generate the Starlight reference page for `systematic-config` from the Zod schema.
 *
 * Reads the `SystematicConfigSchema` from `src/lib/config-schema.ts`, generates a
 * draft-07 JSON Schema, and emits a Starlight-compatible `.mdx` page at
 * `docs/src/content/docs/reference/systematic-config.mdx`.
 *
 * The page documents every field with its description, type, default, enum values,
 * and at least one example. Every described field MUST have at least one
 * `.meta({ examples: [...] })` annotation; the build fails otherwise.
 *
 * Usage:
 *   bun docs/scripts/generate-config-reference.ts   # Generate + write
 *   bun docs/scripts/generate-config-reference.ts --version 3.0.0  # Explicit version
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  getMajorVersion,
  resolveVersion,
  SCHEMA_ID_TEMPLATE,
} from '../../scripts/generate-config-schema.js'
import { SystematicConfigSchema } from '../../src/lib/config-schema.js'
import { formatForDocs } from '../../src/lib/source-model-defaults.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  'docs/src/content/docs/reference/systematic-config.mdx',
)

/** Top-level config keys in display order for the reference page. */
const TOP_LEVEL_KEYS = [
  '$schema',
  'agents',
  'categories',
  'disabled_skills',
  'disabled_agents',
  'disabled_commands',
  'bootstrap',
] as const

/**
 * Label overrides for human-readable field display.
 * By default the key name is used as-is.
 */
const FIELD_LABELS: Record<string, string> = {
  top_p: 'top_p',
}

/**
 * Overlay fields shared by both `agents` and `categories`.
 * These are the keys under `additionalProperties.properties` in the JSON Schema.
 */
const OVERLAY_FIELD_KEYS = [
  'model',
  'variant',
  'temperature',
  'top_p',
  'mode',
  'color',
  'steps',
  'hidden',
  'disable',
  'skills',
  'permission',
] as const

/** Bootstrap sub-fields. */
const BOOTSTRAP_SUB_FIELDS = ['enabled', 'file'] as const

/**
 * Format a JSON Schema type annotation for display.
 */
function formatType(schema: Record<string, unknown>): string {
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .map((s: Record<string, unknown>) => formatType(s))
      .join(' | ')
  }
  if (schema.type === 'array' && schema.items) {
    const inner = formatType(schema.items as Record<string, unknown>)
    return `${inner}[]`
  }
  if (schema.type === 'object' && schema.additionalProperties) {
    return '`object`'
  }
  return `\`${(schema.type as string) || 'unknown'}\``
}

/**
 * Render the default value for a field, if it exists.
 */
function renderDefault(schema: Record<string, unknown>): string {
  if (!('default' in schema)) return ''
  const val = JSON.stringify(schema.default)
  return `\n**Default:** \`${val}\``
}

/**
 * Render a list of enum values, if the field has an `enum`.
 */
function renderEnum(schema: Record<string, unknown>): string {
  if (!schema.enum || !Array.isArray(schema.enum) || schema.enum.length === 0) {
    return ''
  }
  const values = schema.enum
    .map((v: unknown) => {
      if (typeof v === 'string') return `\`${v}\``
      return `\`${JSON.stringify(v)}\``
    })
    .join(', ')
  return `\n\n**Valid values:** ${values}`
}

/**
 * Format examples block from a schema field's `examples` array.
 */
function renderExamples(examples: unknown): string {
  if (!Array.isArray(examples) || examples.length === 0) return ''
  const blocks = examples
    .map((ex) => {
      const code = typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2)
      return `\`\`\`json\n${code}\n\`\`\``
    })
    .join('\n\n')
  return `\n**Examples:**\n\n${blocks}\n`
}

/**
 * Get the description from a JSON Schema property, or empty string.
 */
function getDescription(schema: Record<string, unknown>): string {
  return typeof schema.description === 'string' ? schema.description : ''
}

/**
 * Build a single field section with description, type, default, enum, examples.
 */
function renderFieldSection(
  heading: string,
  schema: Record<string, unknown>,
): string {
  const desc = getDescription(schema)
  const enumStr = renderEnum(schema)
  const defaultStr = renderDefault(schema)
  const examples = renderExamples(schema.examples)
  return (
    `${heading}\n\n${desc ? `${desc}\n\n` : ''}**Type:** ${formatType(schema)}${enumStr}${defaultStr}\n${examples}`.trimEnd() +
    '\n'
  )
}

/**
 * Render documentation for overlay fields (agent or category sub-fields).
 */
function renderOverlayFields(
  schema: Record<string, unknown>,
  fieldKeys: readonly string[],
  headingLevel: number,
): string {
  const hPrefix = '#'.repeat(headingLevel)
  return fieldKeys
    .map((key) => {
      const fieldSchema = getNestedSchema(schema, key)
      if (!fieldSchema) return null
      const label = FIELD_LABELS[key] || key
      return renderFieldSection(`${hPrefix} ${label}`, fieldSchema)
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Walk into a nested JSON Schema properties tree to find a field value.
 * Handles direct properties, additionalProperties.properties, and anyOf.
 */
function getNestedSchema(
  schema: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  if (
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
  ) {
    const props = schema.properties as Record<string, unknown>
    if (key in props) return props[key] as Record<string, unknown>
  }

  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object'
  ) {
    const addProps = schema.additionalProperties as Record<string, unknown>
    if (
      addProps.properties &&
      typeof addProps.properties === 'object' &&
      !Array.isArray(addProps.properties)
    ) {
      const nestedProps = addProps.properties as Record<string, unknown>
      if (key in nestedProps) return nestedProps[key] as Record<string, unknown>
    }
  }

  return null
}

/**
 * Render a top-level config field section (## section) with its description,
 * type, default, examples, and any sub-fields or cross-references.
 *
 * @param key         JSON Schema property key
 * @param properties  Top-level properties map from the generated JSON Schema
 * @param schemaUrl   Versioned schema URL used in the $schema example code block
 */
function renderTopLevelSection(
  key: string,
  properties: Record<string, unknown>,
  schemaUrl: string,
): string {
  const propSchema = properties[key] as Record<string, unknown> | undefined
  if (!propSchema) return ''

  const desc = getDescription(propSchema)
  const defaultStr = renderDefault(propSchema)

  // $schema: replace the generic examples block with a pasteable copy-paste snippet
  if (key === '$schema') {
    const pasteableLine = `"$schema": "${schemaUrl}"`
    return `## $schema\n\n${desc ? `${desc}\n\n` : ''}**Type:** ${formatType(propSchema)}\n\n**Examples:**\n\n\`\`\`json\n${pasteableLine}\n\`\`\``
  }

  // Top-level examples
  let examplesBlock = ''
  if (
    propSchema.examples &&
    Array.isArray(propSchema.examples) &&
    propSchema.examples.length > 0
  ) {
    const blocks = propSchema.examples.map((ex: unknown) => {
      const code = typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2)
      return `\`\`\`json\n${code}\n\`\`\``
    })
    examplesBlock = `\n**Examples:**\n\n${blocks.join('\n\n')}\n`
  }

  // Bootstrap sub-fields
  let subFields = ''
  if (key === 'bootstrap' && propSchema.properties) {
    const bootstrapProps = propSchema.properties as Record<string, unknown>
    subFields =
      '\n\n' +
      BOOTSTRAP_SUB_FIELDS.map((subKey) => {
        const subSchema = bootstrapProps[subKey] as
          | Record<string, unknown>
          | undefined
        if (!subSchema) return null
        return renderFieldSection(`### ${subKey}`, subSchema)
      })
        .filter(Boolean)
        .join('\n\n')
  }

  // Cross-reference for agent/category overlay sections
  const crossRef =
    key === 'agents' || key === 'categories'
      ? '\n\nPer-entry overlay fields are documented in the [Agent/Category Overlay Fields](#agentcategory-overlay-fields) section above.'
      : ''

  return `## ${key}\n\n${desc ? `${desc}\n\n` : ''}**Type:** ${formatType(propSchema)}${defaultStr}${examplesBlock}${subFields}${crossRef}`
}

/**
 * Generate the .mdx content for the systematic-config reference page.
 *
 * @param version Semver string (e.g., "2.11.0") — if omitted, resolves
 *                using the same fallback chain as the JSON Schema generator.
 * @returns The full .mdx content as a string.
 */
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/

export function generateConfigReference(version?: string): string {
  if (version !== undefined && !SEMVER_REGEX.test(version)) {
    throw new Error(
      `Error: Invalid version format "${version}". Must be valid semver (e.g., 3.0.0)`,
    )
  }
  const resolvedVersion = version ?? resolveVersion(null, PROJECT_ROOT)
  const major = getMajorVersion(resolvedVersion)
  const schemaUrl = SCHEMA_ID_TEMPLATE.replace('%MAJOR%', major)

  // Generate the JSON Schema from the Zod source
  const jsonSchema = z.toJSONSchema(SystematicConfigSchema, {
    target: 'draft-7',
  }) as Record<string, unknown>

  const properties = jsonSchema.properties as
    | Record<string, unknown>
    | undefined
  if (!properties) {
    throw new Error('Generated JSON Schema has no properties')
  }

  // Validate that every described field has at least one example.
  const missingExamples = validateFieldExamples(jsonSchema)
  if (missingExamples.length > 0) {
    throw new Error(
      `Examples check failed:\n${missingExamples
        .map(
          (f) =>
            `Error: Field "${f}" has no examples. Add .meta({ examples: [...] }) to the corresponding Zod schema field.`,
        )
        .join('\n')}`,
    )
  }

  // Agent overlay fields section (shared reference)
  const agentProps = (properties.agents as Record<string, unknown> | undefined)
    ?.additionalProperties as Record<string, unknown> | undefined

  const overlaySection = agentProps?.properties
    ? `## Agent/Category Overlay Fields

The \`agents\` and \`categories\` sections share the same set of per-entry overlay fields.
Each key under \`agents\` or \`categories\` is an object with the following fields.
(The \`disable\` field is only valid under \`agents\`, not \`categories\`.)

${renderOverlayFields(agentProps, OVERLAY_FIELD_KEYS, 3)}`
    : ''

  const sections = TOP_LEVEL_KEYS.map((key) =>
    renderTopLevelSection(key, properties, schemaUrl),
  )
    .filter(Boolean)
    .join('\n\n')

  return `---
title: User Configuration
description: Reference documentation for the Systematic user configuration format (systematic.json / systematic.jsonc).
sidebar:
  order: 1
---

{/*
  NOTE: This page is auto-generated from the Zod schema at src/lib/config-schema.ts.
  Do NOT edit this file directly — your changes will be clobbered on the next \`bun run docs:generate\`.
  Instead, edit the schema's .meta() annotations in src/lib/config-schema.ts and regenerate.
*/}

This page documents the fields available in \`systematic.json\` / \`systematic.jsonc\`.
The configuration file can be placed in one of three locations (searched in order):

1. \`$OPENCODE_CONFIG_DIR/systematic.json\` (or \`.jsonc\`)
2. \`<project>/.opencode/systematic.json\` (or \`.jsonc\`)
3. \`~/.config/opencode/systematic.json\` (or \`.jsonc\`)

When both \`.jsonc\` and \`.json\` exist in the same directory, \`.jsonc\` takes precedence.

${overlaySection}
${sections}

## Offline IDE behavior

The schema's \`$id\` points to the canonical online URL above, so IDEs that prefer fetching the canonical schema may attempt to reach the docs site even when the bundled npm copy is also on disk. If you need strict offline behavior, configure your editor to associate \`systematic.{json,jsonc}\` with \`node_modules/@fro.bot/systematic/dist/schemas/systematic-config.schema.json\` directly.
`
}

/**
 * Walk a JSON Schema properties tree and collect paths of described fields
 * that are missing `examples`.  Exits 1 if any are found (called from main).
 *
 * A field is considered "described" if it has a non-empty `description`.
 * Record-value fields (under `additionalProperties`) use `<name>` as a
 * placeholder for the dynamic key in the path.
 *
 * @param schema  Parsed JSON Schema object (root)
 * @param prefix  Dot-separated path prefix for recursion (internal use)
 * @returns       Array of field paths that are missing examples
 */
export function validateFieldExamples(
  schema: Record<string, unknown>,
  prefix?: string,
): string[] {
  const errors: string[] = []
  const currentPrefix = prefix ?? ''

  // Check direct properties
  if (
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
  ) {
    const props = schema.properties as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      const val = value as Record<string, unknown>
      const fieldPath = currentPrefix ? `${currentPrefix}.${key}` : key

      // Skip objects that serve as containers (they have sub-properties)
      const hasSubProperties =
        (val.properties || val.additionalProperties) &&
        !val.type?.toString().startsWith('array')

      if (hasSubProperties) {
        // Recurse into sub-properties
        const subErrors = validateFieldExamples(val, fieldPath)
        errors.push(...subErrors)
        // Also check the container itself for examples, if it has a description
        if (val.description) {
          checkExamples(val, fieldPath, errors)
        }
      } else if (val.description) {
        checkExamples(val, fieldPath, errors)
      }
    }
  }

  // Check additionalProperties (record-type schemas)
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object' &&
    !Array.isArray(schema.additionalProperties)
  ) {
    const addProps = schema.additionalProperties as Record<string, unknown>
    // If the additional properties value has sub-properties, recurse
    if (addProps.properties && typeof addProps.properties === 'object') {
      const innerProps = addProps.properties as Record<string, unknown>
      for (const [key, value] of Object.entries(innerProps)) {
        const val = value as Record<string, unknown>
        const fieldPath = currentPrefix
          ? `${currentPrefix}.<name>.${key}`
          : `<name>.${key}`

        if (val.description) {
          checkExamples(val, fieldPath, errors)
        }
      }
    }
    // Also check the additionalProperties container itself if it has a description
    if (addProps.description) {
      const fieldPath = currentPrefix ? `${currentPrefix}.<value>` : '<value>'
      checkExamples(addProps, fieldPath, errors)
    }
  }

  return errors
}

function checkExamples(
  schema: Record<string, unknown>,
  fieldPath: string,
  errors: string[],
): void {
  const examples = schema.examples
  if (!examples || !Array.isArray(examples) || examples.length === 0) {
    errors.push(fieldPath)
  }
}

const SOURCE_DEFAULTS_START = '{/* SYSTEMATIC:SOURCE-DEFAULTS:START */}'
const SOURCE_DEFAULTS_END = '{/* SYSTEMATIC:SOURCE-DEFAULTS:END */}'
const SOURCE_DEFAULTS_HEADING = '### Source Category Model Defaults'

/**
 * Inject the generated source-defaults table into `configuration.mdx`.
 *
 * Boundary strategy:
 * - Finds SYSTEMATIC:SOURCE-DEFAULTS:START and SYSTEMATIC:SOURCE-DEFAULTS:END
 *   MDX comment delimiters under the "### Source Category Model Defaults" heading.
 * - Replaces only the content between the delimiters with the generated table.
 * - Preserves all prose outside the delimiters byte-for-byte.
 * - If delimiters are absent, inserts them under the heading on first run.
 * - If delimiters are malformed (only one present, or START after END), throws a clear error.
 * - Idempotent: running twice with no source changes produces byte-identical output.
 *
 * @param mdxPath  Absolute path to the configuration.mdx file.
 * @returns        The updated file content as a string.
 */
export function injectSourceDefaultsTable(mdxPath: string): string {
  const original = fs.readFileSync(mdxPath, 'utf-8')
  const table = formatForDocs()

  const startIdx = original.indexOf(SOURCE_DEFAULTS_START)
  const endIdx = original.indexOf(SOURCE_DEFAULTS_END)

  // Validate delimiter state
  if (startIdx !== -1 && endIdx !== -1) {
    // Both present — validate ordering
    if (startIdx > endIdx) {
      const startLine = original.slice(0, startIdx).split('\n').length
      const endLine = original.slice(0, endIdx).split('\n').length
      throw new Error(
        `Malformed delimiters in ${mdxPath}: START delimiter (line ${startLine}) appears after END delimiter (line ${endLine}). Fix the file manually before running the generator.`,
      )
    }
    // Replace content between delimiters
    const before = original.slice(0, startIdx + SOURCE_DEFAULTS_START.length)
    const after = original.slice(endIdx)
    return `${before}\n${table}${after}`
  }

  if (startIdx !== -1 && endIdx === -1) {
    const startLine = original.slice(0, startIdx).split('\n').length
    throw new Error(
      `Malformed delimiters in ${mdxPath}: START delimiter found at line ${startLine} but END delimiter is missing. Fix the file manually before running the generator.`,
    )
  }

  if (startIdx === -1 && endIdx !== -1) {
    const endLine = original.slice(0, endIdx).split('\n').length
    throw new Error(
      `Malformed delimiters in ${mdxPath}: END delimiter found at line ${endLine} but START delimiter is missing. Fix the file manually before running the generator.`,
    )
  }

  // Neither delimiter present — insert under the heading on first run
  const headingIdx = original.indexOf(`\n${SOURCE_DEFAULTS_HEADING}\n`)
  if (headingIdx === -1) {
    throw new Error(
      `Cannot inject source-defaults table: heading "${SOURCE_DEFAULTS_HEADING}" not found in ${mdxPath}. Add the heading manually or check the file path.`,
    )
  }

  // Find the end of the heading line
  const afterHeadingNewline =
    headingIdx + `\n${SOURCE_DEFAULTS_HEADING}\n`.length
  const before = original.slice(0, afterHeadingNewline)
  const after = original.slice(afterHeadingNewline)

  return `${before}\n${SOURCE_DEFAULTS_START}\n${table}${SOURCE_DEFAULTS_END}\n${after}`
}

/**
 * Run the generator and return an exit code (0 = success, 1 = error).
 * Replaces `process.exit(1)` with a return value for testability.
 */
export async function execMain(version?: string): Promise<number> {
  try {
    const content = generateConfigReference(version)
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
    fs.writeFileSync(OUTPUT_PATH, content, 'utf-8')
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error generating config reference:\n${msg}`)
    return 1
  }
}

function main(): void {
  const args = process.argv.slice(2)
  let version: string | null = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') {
      version = args[++i] ?? null
    } else if (args[i].startsWith('--version=')) {
      version = args[i].slice('--version='.length)
    }
  }

  try {
    const content = generateConfigReference(version ?? undefined)
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
    fs.writeFileSync(OUTPUT_PATH, content, 'utf-8')
    const relPath = path.relative(PROJECT_ROOT, OUTPUT_PATH)
    console.log(`✓ Generated ${relPath}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error generating config reference:\n${msg}`)
    process.exit(1)
  }

  // Inject source-defaults table into configuration.mdx
  const configMdxPath = path.join(
    PROJECT_ROOT,
    'docs/src/content/docs/getting-started/configuration.mdx',
  )
  try {
    const updated = injectSourceDefaultsTable(configMdxPath)
    fs.writeFileSync(configMdxPath, updated, 'utf-8')
    const relPath = path.relative(PROJECT_ROOT, configMdxPath)
    console.log(`✓ Injected source-defaults table into ${relPath}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error injecting source-defaults table:\n${msg}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}
