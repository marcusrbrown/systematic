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
import {
  getZodDefaultInnerType,
  getZodObjectShape,
  getZodTypeName,
} from './lib/zod-internals.js'

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

function resolveVersionFromGit(rootDir: string): string | null {
  // Prefer `describe` (locates a tag in the commit's ancestry), then fall
  // back to listing all semver-shaped tags. The fallback covers two real
  // CI cases that `git describe` cannot:
  //   - shallow checkout where the tagged commit isn't in local history
  //   - PR synthetic merge commits that aren't ancestors of any tag
  for (const cmd of [
    'git describe --tags --abbrev=0',
    'git tag -l "v*.*.*" --sort=-v:refname',
  ]) {
    let tag = ''
    try {
      const out = execSync(cmd, { encoding: 'utf-8', cwd: rootDir }).trim()
      tag = out.split('\n')[0]?.trim() ?? ''
    } catch {
      continue
    }
    if (tag.length === 0) continue
    const normalized = tag.startsWith('v') ? tag.slice(1) : tag
    if (SEMVER_REGEX.test(normalized)) return normalized
    throw new Error(
      `Error: Invalid git tag format "${tag}". Expected semver or v-prefixed semver (e.g., v1.2.3)`,
    )
  }
  return null
}

function resolveVersionFromPackageJson(rootDir: string): string | null {
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
    // fall through
  }
  return null
}

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

  const fromGit = resolveVersionFromGit(rootDir)
  if (fromGit != null) return fromGit

  const fromPkg = resolveVersionFromPackageJson(rootDir)
  if (fromPkg != null) return fromPkg

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
 * Unwrap `ZodDefault` / `ZodOptional` wrappers to reach the underlying schema
 * (typically a `ZodObject`). Stops as soon as the inner type is neither.
 */
function unwrapZodWrappers(schema: z.ZodType): z.ZodType {
  let inner: z.ZodType = schema
  for (;;) {
    const typeName = getZodTypeName(inner)
    if (typeName !== 'default' && typeName !== 'optional') return inner
    const next = getZodDefaultInnerType(inner)
    if (next == null) return inner
    inner = next
  }
}

/**
 * Drop keys from `jsonNode.required` whose Zod field has a runtime default.
 * Removes the `required` key entirely when nothing remains.
 */
function pruneRequiredArray(
  jsonNode: Record<string, unknown>,
  shape: Record<string, z.ZodType>,
): void {
  if (!Array.isArray(jsonNode.required)) return
  const filtered = (jsonNode.required as string[]).filter((key) => {
    const field = shape[key]
    if (field == null) return true
    return getZodTypeName(field) !== 'default'
  })
  if (filtered.length === 0) {
    delete jsonNode.required
  } else {
    jsonNode.required = filtered
  }
}

function removeDefaultFieldsFromRequired(
  jsonNode: Record<string, unknown>,
  zodNode: z.ZodType,
): void {
  // Only ZodObject has a shape; skip everything else (ZodRecord, ZodArray, …)
  // In this Zod 4 build, shape is a plain object (not a lazy function).
  const shape = getZodObjectShape(unwrapZodWrappers(zodNode))
  if (shape == null) return

  pruneRequiredArray(jsonNode, shape)

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

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function getSchemaNode(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: Record<string, unknown> | null = root
  for (const segment of path) {
    current = asObject(current?.[segment])
    if (current === null) return null
  }
  return current
}

function cloneSchemaNode(
  node: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(node)) as Record<string, unknown>
}

function getNonNullModelBranch(
  overlayNode: Record<string, unknown>,
): Record<string, unknown> | null {
  const properties = asObject(overlayNode.properties)
  const modelNode = asObject(properties?.model)
  const anyOf = modelNode?.anyOf
  if (!Array.isArray(anyOf)) return null

  for (const candidate of anyOf) {
    const branch = asObject(candidate)
    if (branch?.type === 'string') return cloneSchemaNode(branch)
  }

  return null
}

function addVariantRequiresExplicitModel(
  overlayNode: Record<string, unknown>,
): void {
  const modelStringBranch = getNonNullModelBranch(overlayNode)
  if (modelStringBranch === null) return

  const variantRequiresModel: Record<string, unknown> = {
    if: { required: ['variant'] },
  }
  variantRequiresModel['then'] = {
    required: ['model'],
    properties: {
      model: modelStringBranch,
    },
  }

  const allOf = Array.isArray(overlayNode.allOf) ? overlayNode.allOf : []
  overlayNode.allOf = [...allOf, variantRequiresModel]
}

function addOverlayCrossFieldConstraints(root: Record<string, unknown>): void {
  for (const path of [
    ['properties', 'agents', 'additionalProperties'],
    ['properties', 'categories', 'additionalProperties'],
  ] as const) {
    const overlayNode = getSchemaNode(root, path)
    if (overlayNode !== null) addVariantRequiresExplicitModel(overlayNode)
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
  addOverlayCrossFieldConstraints(clean as Record<string, unknown>)

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
