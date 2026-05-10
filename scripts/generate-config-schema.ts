#!/usr/bin/env bun
/**
 * Generate the JSON Schema for `systematic-config` from the Zod source.
 *
 * Reads the `SystematicConfigSchema` from `src/lib/config-schema.ts`, generates
 * a draft-07 JSON Schema, and writes it to three locations:
 *   1. docs/public/schemas/v<MAJOR>/systematic-config.schema.json  (major-versioned docs URL)
 *   2. docs/public/schemas/latest/systematic-config.schema.json    (latest mirror)
 *   3. dist/schemas/systematic-config.schema.json                  (bundled npm copy)
 *
 * All three copies are byte-identical and share the same `$id`.
 *
 * Usage:
 *   bun scripts/generate-config-schema.ts                         # Resolves version, generates + writes
 *   bun scripts/generate-config-schema.ts --check                 # Exit 1 if generated output differs from disk
 *   bun scripts/generate-config-schema.ts --version 3.0.0         # Explicit version override
 */
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { SystematicConfigSchema } from '../src/lib/config-schema.js'

/**
 * Run Biome's formatter over JSON content via stdin. Used to keep the
 * generated schema files in lockstep with the repo's lint rules (Biome
 * prefers short arrays on a single line, multi-line for longer ones).
 * Without this pass the generator's plain `JSON.stringify(..., null, 2)`
 * output drifts from `bun run lint` expectations and the lint job fails
 * on otherwise-correct generated artifacts.
 *
 * Mirrors the pattern used in `scripts/generate-registry.ts`.
 */
function formatJsonWithBiome(content: string, fileName: string): string {
  const result = spawnSync(
    'bun',
    ['biome', 'format', `--stdin-file-path=${fileName}`],
    { input: content, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(
      `biome format failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/

/**
 * Template for the schema's $id field.
 * %MAJOR% is replaced with the computed major version.
 */
export const SCHEMA_ID_TEMPLATE =
  'https://fro.bot/systematic/schemas/v%MAJOR%/systematic-config.schema.json'

/**
 * Resolve the version to use for schema generation.
 *
 * Fallback chain:
 *   1. Explicit `--version` flag input — validates semver, uses as-is
 *   2. `git describe --tags --abbrev=0` — strips leading `v`, validates semver
 *   3. `package.json` version — REJECTS `0.0.0-semantic-release` placeholder
 *   4. Hard-fail with "no resolvable version" error
 *
 * @param explicit Explicit version from CLI flag, or null
 * @param rootDir Project root directory (defaults to PROJECT_ROOT)
 * @returns Resolved semver string
 * @throws Error if version cannot be resolved
 */
export function resolveVersion(
  explicit: string | null,
  rootDir = PROJECT_ROOT,
): string {
  if (explicit != null) {
    if (!SEMVER_REGEX.test(explicit)) {
      throw new Error(
        `Error: Invalid version format "${explicit}". Must be valid semver (e.g., 3.0.0)`,
      )
    }
    return explicit
  }

  // Try git tag
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf-8',
      cwd: rootDir,
    }).trim()
    if (tag.length > 0) {
      const normalized = tag.startsWith('v') ? tag.slice(1) : tag
      if (SEMVER_REGEX.test(normalized)) {
        return normalized
      }
      throw new Error(
        `Error: Invalid git tag format "${tag}". Expected semver or v-prefixed semver (e.g., v1.2.3)`,
      )
    }
  } catch {
    // git tag failed, fall through to package.json
  }

  // Try package.json
  const pkgPath = path.join(rootDir, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      version?: string
    }
    const v = pkg.version
    if (
      typeof v === 'string' &&
      v.length > 0 &&
      !v.includes('semantic-release')
    ) {
      return v
    }
  } catch {
    // package.json read failed, fall through to error
  }

  throw new Error(
    'Error: No resolvable version. Specify --version <semver>, ensure a git tag exists, or set a valid semver in package.json.',
  )
}

/**
 * Extract the major version component from a semver string.
 * Examples: "2.11.0" → "2", "3.0.0-rc.1" → "3"
 */
export function getMajorVersion(version: string): string {
  const parts = version.split('.')
  return parts[0]
}

/**
 * Walk a JSON Schema object tree and remove fields from `required` arrays
 * when the corresponding Zod shape field has a `.default()` wrapper.
 *
 * A field with a runtime default is optional from the user's perspective:
 * Zod fills it in if absent. Leaving it in `required` causes IDEs to
 * redline valid minimal configs that the runtime accepts fine.
 *
 * Handles both the top-level object and nested objects (e.g., `bootstrap`).
 *
 * @param jsonNode  The JSON Schema object node to process (mutated in-place)
 * @param zodNode   The corresponding Zod schema node (used to detect defaults)
 */
function removeDefaultFieldsFromRequired(
  jsonNode: Record<string, unknown>,
  zodNode: z.ZodType,
): void {
  // Unwrap ZodDefault / ZodOptional wrappers to reach the inner ZodObject.
  let inner: z.ZodType = zodNode
  for (;;) {
    const def = inner._def as { type?: string; innerType?: z.ZodType }
    if (def.type === 'default' || def.type === 'optional') {
      inner = def.innerType as z.ZodType
    } else {
      break
    }
  }

  // Only ZodObject has ._def.shape; skip everything else (ZodRecord, ZodArray, …)
  // In this Zod 4 build, shape is a plain object (not a lazy function).
  const innerDef = inner._def as { shape?: Record<string, z.ZodType> }
  const shape = innerDef.shape
  if (shape == null) return

  // Remove keys from `required` when the Zod shape field is ZodDefault
  if (Array.isArray(jsonNode.required)) {
    const filtered = (jsonNode.required as string[]).filter((key) => {
      const field = shape[key]
      if (field == null) return true
      const fieldDef = field._def as { type?: string }
      return fieldDef.type !== 'default'
    })
    if (filtered.length === 0) {
      delete jsonNode.required
    } else {
      jsonNode.required = filtered
    }
  }

  // Recurse into `properties` to catch nested object schemas (e.g., `bootstrap`)
  const props = jsonNode.properties as
    | Record<string, Record<string, unknown>>
    | undefined
  if (props == null) return

  for (const [key, field] of Object.entries(shape)) {
    const propNode = props[key]
    if (propNode != null) {
      removeDefaultFieldsFromRequired(propNode, field)
    }
  }
}

/**
 * Generate the JSON Schema content string for the given version.
 *
 * The schema's $id is set to the major-versioned docs URL
 * (e.g., `https://fro.bot/systematic/schemas/v3/systematic-config.schema.json`).
 *
 * @param version Semver string (e.g., "3.0.0")
 * @returns Pretty-printed JSON string of the generated schema
 */
export function generateSchemaContent(version: string): string {
  const major = getMajorVersion(version)
  const schemaId = SCHEMA_ID_TEMPLATE.replace('%MAJOR%', major)

  const result = z.toJSONSchema(SystematicConfigSchema, {
    target: 'draft-7',
    override: (ctx) => {
      // Only set $id at the root schema level (path length === 0)
      if (ctx.path.length === 0) {
        ctx.jsonSchema.$id = schemaId
      }
    },
  })

  // zod's toJSONSchema adds a "~standard" field that is internal metadata;
  // strip it out for the published schema (it's not valid JSON Schema).
  const { '~standard': _standard, ...clean } = result as Record<
    string,
    unknown
  > &
    typeof result

  // Post-process: remove fields with runtime defaults from `required` arrays.
  // Zod emits `required:[all fields]` for every object, including fields with
  // `.default()`. From the user's perspective those fields are optional — the
  // runtime fills them in. Without this step, IDEs redline valid minimal configs.
  removeDefaultFieldsFromRequired(
    clean as Record<string, unknown>,
    SystematicConfigSchema,
  )

  const raw = `${JSON.stringify(clean, null, 2)}\n`
  return formatJsonWithBiome(raw, 'systematic-config.schema.json')
}

/**
 * Write schema content to all three target locations.
 *
 * @param content The schema content string to write
 * @param version Semver string for computing major version
 * @param rootDir Project root directory
 * @returns Array of absolute paths that were written
 */
export function generateAndWrite(
  content: string,
  version: string,
  rootDir = PROJECT_ROOT,
): string[] {
  const major = getMajorVersion(version)

  const targetPaths = [
    path.join(
      rootDir,
      'docs/public/schemas',
      `v${major}`,
      'systematic-config.schema.json',
    ),
    path.join(
      rootDir,
      'docs/public/schemas',
      'latest',
      'systematic-config.schema.json',
    ),
    path.join(rootDir, 'dist/schemas', 'systematic-config.schema.json'),
  ]

  const written: string[] = []

  for (const targetPath of targetPaths) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })

    // Check if the file already exists with the same content
    // to avoid unnecessary writes (preserving mtime).
    let skip = false
    try {
      const existing = fs.readFileSync(targetPath, 'utf-8')
      if (normalizeForCompare(existing) === normalizeForCompare(content)) {
        skip = true
      }
    } catch {
      // File doesn't exist or can't be read — write it
    }

    if (!skip) {
      fs.writeFileSync(targetPath, content, 'utf-8')
    }

    written.push(targetPath)
  }

  return written
}

/**
 * Normalize content for byte-by-byte comparison.
 * Strips trailing whitespace and normalizes CRLF → LF.
 */
export function normalizeForCompare(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

/**
 * Check whether the generated schema files on disk match the expected output.
 * Used by `--check` mode for CI drift detection.
 *
 * @param rootDir Project root directory
 * @param explicitVersion Optional explicit version override
 * @returns Object with `ok` (boolean) and `message` (string)
 */
export function checkSchemaFiles(
  rootDir = PROJECT_ROOT,
  explicitVersion: string | null = null,
): { ok: boolean; message: string } {
  const version = resolveVersion(explicitVersion, rootDir)
  const expected = generateSchemaContent(version)
  const major = getMajorVersion(version)

  const majorPath = path.join(
    rootDir,
    'docs/public/schemas',
    `v${major}`,
    'systematic-config.schema.json',
  )

  // Only the v<MAJOR>/ file is the canonical committed version — MUST match.
  // dist/schemas/ is a publish-only artifact regenerated by prepublishOnly; it
  // is absent after a clean `bun run build` and must not be checked here.
  // latest/ is regenerated at docs:generate time and is gitignored — not checked.
  const checkPaths: string[] = [majorPath]

  let allOk = true
  let firstFailure = ''

  for (const filePath of checkPaths) {
    const relPath = path.relative(rootDir, filePath)

    if (!fs.existsSync(filePath)) {
      allOk = false
      if (!firstFailure) {
        firstFailure = `${relPath} does not exist. Run \`bun scripts/generate-config-schema.ts\` to create it.`
      }
      continue
    }

    const existing = fs.readFileSync(filePath, 'utf-8')
    if (normalizeForCompare(existing) !== normalizeForCompare(expected)) {
      allOk = false
      if (!firstFailure) {
        firstFailure = `${relPath} is out of date. Run \`bun scripts/generate-config-schema.ts\` to update it.`
      }
    }
  }

  if (allOk) {
    return {
      ok: true,
      message: `Schema files are up to date (v${major}).`,
    }
  }

  return { ok: false, message: firstFailure }
}

function parseArgs(argv: string[]): {
  check: boolean
  version: string | null
} {
  const args = argv.slice(2)
  let check = false
  let version: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--check') {
      check = true
    } else if (arg === '--version') {
      const next = args[i + 1]
      if (next == null || next.startsWith('--')) {
        console.error('Error: --version requires a value')
        process.exit(1)
      }
      version = next
      i++
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    }
  }

  return { check, version }
}

function main(): void {
  const { check, version: explicitVersion } = parseArgs(process.argv)

  if (check) {
    const result = checkSchemaFiles(PROJECT_ROOT, explicitVersion)
    if (result.ok) {
      console.log(result.message)
      process.exit(0)
    }
    console.error(`Error: ${result.message}`)
    process.exit(1)
  }

  let resolvedVersion: string
  try {
    resolvedVersion = resolveVersion(explicitVersion)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  const content = generateSchemaContent(resolvedVersion)
  const paths = generateAndWrite(content, resolvedVersion)

  const major = getMajorVersion(resolvedVersion)
  const relPaths = paths.map((p) => path.relative(PROJECT_ROOT, p))

  console.log(`Systematic Config Schema v${major} (${resolvedVersion})`)
  console.log(`  ${relPaths[0]}`)
  console.log(`  ${relPaths[1]}`)
  console.log(`  ${relPaths[2]}`)
}

if (import.meta.main) {
  main()
}
