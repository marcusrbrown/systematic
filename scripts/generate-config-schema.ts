#!/usr/bin/env bun
/**
 * Generate the JSON Schema for `systematic-config` from the Zod source.
 *
 * Discovers bundled agent and skill names from the filesystem, calls
 * `createSystematicConfigSchema` with the fresh names, then serializes the
 * resulting Zod schema to draft-07 JSON Schema for IDE autocomplete and
 * runtime validation parity. Writes to three byte-identical locations:
 *   1. docs/public/schemas/v<MAJOR>/systematic-config.schema.json  (major-versioned docs URL)
 *   2. docs/public/schemas/latest/systematic-config.schema.json    (latest mirror)
 *   3. dist/schemas/systematic-config.schema.json                  (bundled npm copy)
 *
 * All three copies share the same `$id`.
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
import { findAgentsInDir } from '../src/lib/agents.js'
import {
  createSystematicConfigSchema,
  SystematicConfigSchema,
} from '../src/lib/config-schema.js'
import { findSkillsInDir } from '../src/lib/skills.js'
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
 * Upper bound on how many levels of `$ref` / `allOf-wrapper` indirection
 * resolveRef() will follow before giving up. Set generously above observed
 * Zod-emitted chains (ref → wrapper → ref → ... ~3 levels in practice) to
 * absorb future generator changes without becoming a magic-number cliff.
 */
const MAX_SCHEMA_REF_RESOLUTION_DEPTH = 8

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
  root: Record<string, unknown>,
  jsonNode: Record<string, unknown>,
  zodNode: z.ZodType,
  mutated = new WeakSet<Record<string, unknown>>(),
): void {
  // Only ZodObject has a shape; skip everything else (ZodRecord, ZodArray, …)
  // In this Zod 4 build, shape is a plain object (not a lazy function).
  const shape = getZodObjectShape(unwrapZodWrappers(zodNode))
  if (shape == null) return

  pruneRequiredArray(jsonNode, shape)

  // Recurse into `properties` to catch nested object schemas (e.g., `bootstrap`).
  // With `reused: 'ref'`, a property node may be a `{ "$ref": "..." }` indirection
  // rather than an inline object with its own `properties`. Resolve through any
  // ref/allOf-wrapper indirection before recursing so we mutate the shared
  // definition (which propagates to every referrer). Track already-mutated
  // definitions in a WeakSet to avoid double-processing shared definitions.
  const props = jsonNode.properties as
    | Record<string, Record<string, unknown>>
    | undefined
  if (props == null) return

  for (const [key, field] of Object.entries(shape)) {
    const propNode = props[key]
    if (propNode == null) continue

    // Resolve any $ref / allOf-wrapper indirection to get the structural body.
    const resolved = resolveRef(root, propNode) ?? propNode
    if (mutated.has(resolved)) continue
    mutated.add(resolved)

    removeDefaultFieldsFromRequired(root, resolved, field, mutated)
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

/**
 * Resolve a node that may be a `{ "$ref": "#/definitions/__schemaN" }` indirection
 * to the underlying definition object. Returns the node itself if it is not a ref,
 * or null if the ref is unresolvable. Mutating the returned object mutates the
 * shared definition — which is the point when injecting cross-field constraints
 * that should apply to every referrer.
 *
 * Also unwraps trivial `allOf: [{ $ref: ... }]` wrappers that Zod emits when a
 * schema carries metadata (`.describe()`, `.default()`) AND is referenced via
 * `reused: 'ref'`. The metadata wrapper holds the description/default; the
 * underlying object structure (`properties`, `additionalProperties`) lives in
 * the wrapped definition. Without unwrapping, callers walking `properties.foo`
 * paths see only the wrapper and miss the real schema body.
 *
 * Supports JSON Schema draft-07 (`#/definitions/...`) only — the target this
 * generator currently emits.
 */
function resolveRef(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
): Record<string, unknown> | null {
  let current: Record<string, unknown> | null = node

  // Follow at most a handful of levels of indirection (ref → wrapper → ref → ...)
  // to defend against malformed schemas without risking an infinite loop.
  for (
    let i = 0;
    current !== null && i < MAX_SCHEMA_REF_RESOLUTION_DEPTH;
    i++
  ) {
    const ref = current['$ref']
    if (typeof ref === 'string') {
      const prefix = '#/definitions/'
      if (!ref.startsWith(prefix)) return null
      const defKey = ref.slice(prefix.length)
      const definitions = asObject(root.definitions)
      if (definitions === null) return null
      current = asObject(definitions[defKey])
      continue
    }

    // Unwrap a trivial single-ref allOf wrapper. Zod uses this shape when a
    // schema has metadata (description, default, examples) at the wrapper
    // level and the structural body (properties, additionalProperties) at the
    // wrapped level.
    const allOf = current['allOf']
    if (Array.isArray(allOf) && allOf.length === 1) {
      const wrapped = asObject(allOf[0])
      if (wrapped !== null && '$ref' in wrapped) {
        current = wrapped
        continue
      }
    }

    return current
  }

  // The loop exhausted MAX_SCHEMA_REF_RESOLUTION_DEPTH without finding a
  // concrete (non-ref, non-allOf-wrapper) node. This means Zod emitted a
  // longer ref/wrapper chain than expected. Warn loudly so the next Zod
  // upgrade surfaces it instead of silently skipping cross-field constraints
  // and required-pruning on the affected node.
  console.warn(
    `[generate-config-schema] resolveRef exhausted MAX_SCHEMA_REF_RESOLUTION_DEPTH (${MAX_SCHEMA_REF_RESOLUTION_DEPTH}). ` +
      'A schema node was not resolved; downstream post-processors will skip it. ' +
      'If this triggers after a Zod upgrade, raise the depth bound.',
  )
  return null
}

function cloneSchemaNode(
  node: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(node)) as Record<string, unknown>
}

function getNonNullModelBranch(
  root: Record<string, unknown>,
  overlayNode: Record<string, unknown>,
): Record<string, unknown> | null {
  const properties = asObject(overlayNode.properties)
  const modelNode = asObject(properties?.model)
  if (modelNode === null) return null

  // With `reused: 'ref'`, the model field is several layers of ref/wrapper
  // indirection (overlay.properties.model → ref → allOf wrapper → ref → anyOf).
  // Resolve through them to reach the anyOf union that lists the string and
  // null branches.
  const modelBody = resolveRef(root, modelNode)
  const anyOf = modelBody?.anyOf
  if (!Array.isArray(anyOf)) return null

  for (const candidate of anyOf) {
    const branch = asObject(candidate)
    if (branch === null) continue
    // The string branch may itself be a $ref to a definition that holds the
    // type/pattern constraints; resolve it before checking `type === 'string'`.
    const resolved = resolveRef(root, branch)
    if (resolved?.type === 'string') return cloneSchemaNode(resolved)
  }

  return null
}

function addVariantRequiresExplicitModel(
  root: Record<string, unknown>,
  overlayNode: Record<string, unknown>,
): void {
  const modelStringBranch = getNonNullModelBranch(root, overlayNode)
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
  // With `reused: 'ref'`, repeated overlay shapes live under `#/definitions/__schemaN`
  // and are referenced from `properties.agents.properties.<agentName>` (one ref per
  // bundled agent) and from `properties.categories.additionalProperties`. Resolving
  // the ref before mutating lets a single allOf injection propagate to every
  // referrer.
  //
  // Track which definition nodes have already received the constraint so we don't
  // double-inject when multiple referrers (categories + 102 agents) share the same
  // underlying definition.
  const mutated = new WeakSet<Record<string, unknown>>()

  const applyConstraint = (node: Record<string, unknown> | null): void => {
    if (node === null) return
    const target = resolveRef(root, node)
    if (target === null || mutated.has(target)) return
    mutated.add(target)
    addVariantRequiresExplicitModel(root, target)
  }

  // categories: still uses additionalProperties (z.record). The root path
  // `properties.categories` may be a ref to a metadata-wrapped def; resolveRef
  // unwraps both layers to reach the structural body that holds
  // `additionalProperties`.
  const categoriesNode = getSchemaNode(root, ['properties', 'categories'])
  const categoriesBody =
    categoriesNode === null ? null : resolveRef(root, categoriesNode)
  if (categoriesBody !== null) {
    applyConstraint(asObject(categoriesBody['additionalProperties']))
  }

  // agents: a typed object whose container is itself behind a ref/wrapper.
  // Resolve the container first to expose `properties`, then iterate per-agent
  // entries (each of which is a ref to the shared overlay definition).
  // Resolving once and mutating the overlay definition covers all 102 keys.
  const agentsNode = getSchemaNode(root, ['properties', 'agents'])
  const agentsBody = agentsNode === null ? null : resolveRef(root, agentsNode)
  const agentProperties = asObject(agentsBody?.['properties'])
  if (agentProperties !== null) {
    for (const key of Object.keys(agentProperties)) {
      applyConstraint(asObject(agentProperties[key]))
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
  return generateSchemaContentFromSchema(version, SystematicConfigSchema)
}

/**
 * Generate the JSON Schema content string for the given version, using the
 * provided Zod schema. Separating the schema parameter from the version allows
 * `main()` to pass a dynamically-imported fresh schema after rewriting
 * `bundled-names.ts`, avoiding the stale-static-import problem.
 *
 * @param version Semver string (e.g., "3.0.0")
 * @param schema The Zod schema to convert (typically SystematicConfigSchema)
 * @returns Pretty-printed JSON string of the generated schema
 */
export function generateSchemaContentFromSchema(
  version: string,
  schema: z.ZodType,
): string {
  const major = getMajorVersion(version)
  const schemaId = SCHEMA_ID_TEMPLATE.replace('%MAJOR%', major)

  const result = z.toJSONSchema(schema, {
    target: 'draft-7',
    // Deduplicate repeated schema shapes by extracting them to definitions.
    // Without this, the agents.<key> overlay (and its embedded sub-schemas)
    // is inlined once per bundled agent (~100x), bloating the schema by ~15K
    // lines. With `reused: 'ref'`, repeated shapes become a single definition
    // referenced via $ref, collapsing the schema to a fraction of its size.
    reused: 'ref',
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
    clean as Record<string, unknown>,
    schema,
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
 * Path to the generated `bundled-names.ts` artifact, relative to a project root.
 */
export const BUNDLED_NAMES_RELATIVE_PATH = 'src/lib/bundled-names.ts'

/**
 * Walk the project's `agents/` and `skills/` directories and return the
 * lexicographically-sorted list of bundled agent and skill names. Pure helper
 * exposed for testing — pass a project root, get back the discovered sets.
 *
 * Returns empty arrays when a directory is missing or contains no matching
 * files. Generator callers must apply a separate sanity check before emitting
 * (see `generateBundledNamesContent` below).
 */
export function discoverBundledNames(rootDir: string): {
  agents: string[]
  agentQualifiedIds: string[]
  skills: string[]
} {
  const agentsDir = path.join(rootDir, 'agents')
  const skillsDir = path.join(rootDir, 'skills')

  const agentInfos = fs.existsSync(agentsDir) ? findAgentsInDir(agentsDir) : []
  const agents = agentInfos.map((info) => info.name).sort()
  const agentQualifiedIds = agentInfos
    .filter((info) => info.category !== undefined)
    .map((info) => `${info.category}/${info.name}`)
    .sort()

  const skills = fs.existsSync(skillsDir)
    ? findSkillsInDir(skillsDir)
        .map((info) => info.name)
        .sort()
    : []

  return { agents, agentQualifiedIds, skills }
}

/**
 * Generate the contents of `src/lib/bundled-names.ts` from a discovered set
 * of agent and skill names. Pure function — does not write to disk.
 *
 * Applies a sanity check:
 *   - Empty discovery (either list empty) → aborts with an `empty` error
 *   - Shrinkage from a previous committed count → aborts unless `allowShrink`
 *
 * First-run callers (file does not yet exist) leave `previousAgentCount` /
 * `previousSkillCount` undefined; only the empty-discovery branch fires.
 *
 * Maintainers who intentionally remove a bundled agent or skill set
 * `allowShrink: true` (wired to the script's `--allow-shrink` CLI flag).
 * CI never sets this flag; the shrink check is a local guardrail.
 */
export function generateBundledNamesContent(
  agents: string[],
  skills: string[],
  options: {
    previousAgentCount?: number
    previousSkillCount?: number
    allowShrink?: boolean
    agentQualifiedIds?: string[]
  } = {},
): string {
  if (agents.length === 0 || skills.length === 0) {
    throw new Error(
      'Error: bundled-names discovery is empty. Either the agents/ or skills/ directory was not found or contains no matching files. Refusing to emit an empty enum that would brick every config validation.',
    )
  }

  const {
    previousAgentCount,
    previousSkillCount,
    allowShrink = false,
    agentQualifiedIds = [],
  } = options

  if (!allowShrink) {
    if (
      previousAgentCount !== undefined &&
      agents.length < previousAgentCount
    ) {
      throw new Error(
        `Error: bundled-agent count shrank from ${previousAgentCount} to ${agents.length}. ` +
          'If this is an intentional removal, regenerate with `bun scripts/generate-config-schema.ts --allow-shrink`. ' +
          'If not, investigate before committing — partial discovery (filesystem permission issues, truncated walks, symlink edge cases) can manifest as unintended shrinkage.',
      )
    }
    if (
      previousSkillCount !== undefined &&
      skills.length < previousSkillCount
    ) {
      throw new Error(
        `Error: bundled-skill count shrank from ${previousSkillCount} to ${skills.length}. ` +
          'If this is an intentional removal, regenerate with `bun scripts/generate-config-schema.ts --allow-shrink`. ' +
          'If not, investigate before committing — partial discovery can manifest as unintended shrinkage.',
      )
    }
  }

  const agentLiterals = agents.map((n) => `  ${JSON.stringify(n)},`).join('\n')
  const qualifiedLiterals = agentQualifiedIds
    .map((n) => `  ${JSON.stringify(n)},`)
    .join('\n')
  const skillLiterals = skills.map((n) => `  ${JSON.stringify(n)},`).join('\n')

  const qualifiedBlock =
    qualifiedLiterals.length > 0
      ? `\nexport const BUNDLED_AGENT_QUALIFIED_IDS = [\n${qualifiedLiterals}\n] as const\n`
      : '\nexport const BUNDLED_AGENT_QUALIFIED_IDS: readonly string[] = []\n'

  const raw = `// Generated by scripts/generate-config-schema.ts — DO NOT EDIT BY HAND.
// Re-run \`bun scripts/generate-config-schema.ts\` to regenerate.
//
// Source of truth for the bundled-agent and bundled-skill name sets that
// drive typed config validation in src/lib/config-schema.ts and the
// published JSON Schema. Walks agents/ and skills/ at codegen time.

export const BUNDLED_AGENT_NAMES = [
${agentLiterals}
] as const
${qualifiedBlock}
export const BUNDLED_SKILL_NAMES = [
${skillLiterals}
] as const

export type BundledAgentName = (typeof BUNDLED_AGENT_NAMES)[number]
export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number]
`

  return formatJsonWithBiome(raw, 'bundled-names.ts')
}

/**
 * Read the previously-committed `bundled-names.ts` file (if any) and extract
 * the lengths of `BUNDLED_AGENT_NAMES` and `BUNDLED_SKILL_NAMES`.
 *
 * Returns `undefined` for missing fields when the file doesn't exist or
 * can't be parsed — the generator treats this as the first-run case and
 * skips the shrink check (only empty-discovery enforced).
 */
export function readCommittedBundledNamesCounts(rootDir: string): {
  previousAgentCount?: number
  previousSkillCount?: number
} {
  const filePath = path.join(rootDir, BUNDLED_NAMES_RELATIVE_PATH)
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return {}
  }

  const countEntries = (block: string): number => {
    return block
      .split('\n')
      .filter((line) => /^\s*['"][^'"]+['"],\s*$/.test(line)).length
  }

  const agentMatch = content.match(
    /export const BUNDLED_AGENT_NAMES = \[([\s\S]*?)\] as const/,
  )
  const skillMatch = content.match(
    /export const BUNDLED_SKILL_NAMES = \[([\s\S]*?)\] as const/,
  )

  return {
    previousAgentCount: agentMatch ? countEntries(agentMatch[1]) : undefined,
    previousSkillCount: skillMatch ? countEntries(skillMatch[1]) : undefined,
  }
}

/**
 * Write the generated bundled-names content to `src/lib/bundled-names.ts`,
 * relative to the given project root.
 *
 * Mirrors the mtime-preservation pattern from `generateAndWrite`: skip the
 * write when on-disk content already matches.
 */
export function writeBundledNamesFile(
  content: string,
  rootDir = PROJECT_ROOT,
): string {
  const targetPath = path.join(rootDir, BUNDLED_NAMES_RELATIVE_PATH)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  try {
    const existing = fs.readFileSync(targetPath, 'utf-8')
    if (normalizeForCompare(existing) === normalizeForCompare(content)) {
      return targetPath
    }
  } catch {
    // File doesn't exist — write it
  }

  fs.writeFileSync(targetPath, content, 'utf-8')
  return targetPath
}

/**
 * Describes a single committed artifact that the drift gate must verify.
 * Each artifact has an independent `produce` pipeline and a path on disk.
 */
interface CheckArtifact {
  /** Returns the expected content string for this artifact. */
  produce: () => string
  /** Absolute path to the committed file on disk. */
  pathOnDisk: string
  /** Human-readable identifier for error messages (relative path). */
  displayName: string
}

/**
 * Check whether the generated schema files on disk match the expected output.
 * Used by `--check` mode for CI drift detection.
 *
 * Checks two committed artifacts:
 *   1. docs/public/schemas/v<MAJOR>/systematic-config.schema.json
 *   2. src/lib/bundled-names.ts
 *
 * All failures are aggregated so a stale-both scenario surfaces both errors
 * at once instead of falsely clearing the second after the first is fixed.
 *
 * @param rootDir Project root directory
 * @param explicitVersion Optional explicit version override
 * @returns Object with `ok` (boolean) and `message` (string)
 */
export function checkSchemaFiles(
  rootDir = PROJECT_ROOT,
  explicitVersion: string | null = null,
): { ok: boolean; message: string } {
  // ── Artifact 1: bundled-names.ts (version-agnostic) ─────────────────────
  // Resolved first so its result is always available regardless of whether
  // version resolution succeeds for the JSON Schema artifact.
  const bundledNamesArtifact: CheckArtifact = {
    produce: () => {
      const { agents, skills, agentQualifiedIds } =
        discoverBundledNames(rootDir)
      const previous = readCommittedBundledNamesCounts(rootDir)
      return generateBundledNamesContent(agents, skills, {
        ...previous,
        agentQualifiedIds,
      })
    },
    pathOnDisk: path.join(rootDir, BUNDLED_NAMES_RELATIVE_PATH),
    displayName: BUNDLED_NAMES_RELATIVE_PATH,
  }

  // ── Artifact 2: versioned JSON Schema ────────────────────────────────────
  // Only the v<MAJOR>/ file is the canonical committed version — MUST match.
  // dist/schemas/ is a publish-only artifact regenerated by prepublishOnly; it
  // is absent after a clean `bun run build` and must not be checked here.
  // latest/ is regenerated at docs:generate time and is gitignored — not checked.
  let schemaArtifact: CheckArtifact | null = null
  let versionFailureMessage: string | null = null
  let resolvedMajor = ''

  try {
    const version = resolveVersion(explicitVersion, rootDir)
    const major = getMajorVersion(version)
    resolvedMajor = major
    const majorPath = path.join(
      rootDir,
      'docs/public/schemas',
      `v${major}`,
      'systematic-config.schema.json',
    )
    schemaArtifact = {
      // --check uses the static SystematicConfigSchema (committed bundled names)
      // rather than the factory with fresh discovery. This is intentional: drift
      // detection compares the committed JSON Schema against what the committed
      // bundled-names.ts produces. main() uses the factory because it's writing
      // fresh artifacts; --check is reading them.
      produce: () => generateSchemaContent(version),
      pathOnDisk: majorPath,
      displayName: path.relative(rootDir, majorPath),
    }
  } catch (err) {
    versionFailureMessage = (err as Error).message
  }

  // ── Drift loop ───────────────────────────────────────────────────────────
  const failures: string[] = []

  const artifacts: CheckArtifact[] = [bundledNamesArtifact]
  if (schemaArtifact !== null) {
    artifacts.push(schemaArtifact)
  }

  for (const artifact of artifacts) {
    const { pathOnDisk, displayName } = artifact

    if (!fs.existsSync(pathOnDisk)) {
      failures.push(
        `${displayName} does not exist. Run \`bun scripts/generate-config-schema.ts\` to create it.`,
      )
      continue
    }

    let expected: string
    try {
      expected = artifact.produce()
    } catch (err) {
      failures.push(
        `${displayName} drift check failed: ${(err as Error).message}`,
      )
      continue
    }

    const existing = fs.readFileSync(pathOnDisk, 'utf-8')
    if (normalizeForCompare(existing) !== normalizeForCompare(expected)) {
      failures.push(
        `${displayName} is out of date. Run \`bun scripts/generate-config-schema.ts\` to update it.`,
      )
    }
  }

  if (versionFailureMessage !== null) {
    failures.push(versionFailureMessage)
  }

  if (failures.length === 0) {
    const vSuffix = resolvedMajor ? ` (v${resolvedMajor})` : ''
    return {
      ok: true,
      message: `Schema files are up to date${vSuffix}.`,
    }
  }

  return { ok: false, message: failures.join('\n\n') }
}

function parseArgs(argv: string[]): {
  check: boolean
  version: string | null
  allowShrink: boolean
} {
  const args = argv.slice(2)
  let check = false
  let version: string | null = null
  let allowShrink = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--check') {
      check = true
    } else if (arg === '--allow-shrink') {
      allowShrink = true
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

  return { check, version, allowShrink }
}

async function main(): Promise<void> {
  const {
    check,
    version: explicitVersion,
    allowShrink,
  } = parseArgs(process.argv)

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

  // Step 1: Discover bundled names from the filesystem and write bundled-names.ts
  // BEFORE generating the JSON Schema. The factory in Step 2 takes the discovered
  // names as parameters, so the schema always reflects the current filesystem state.
  let bundledNamesPath: string
  let agents: string[]
  let agentQualifiedIds: string[]
  let skills: string[]
  try {
    ;({ agents, agentQualifiedIds, skills } =
      discoverBundledNames(PROJECT_ROOT))
    const previous = readCommittedBundledNamesCounts(PROJECT_ROOT)
    const bundledContent = generateBundledNamesContent(agents, skills, {
      ...previous,
      allowShrink,
      agentQualifiedIds,
    })
    bundledNamesPath = writeBundledNamesFile(bundledContent, PROJECT_ROOT)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  console.log(`Bundled names ${path.relative(PROJECT_ROOT, bundledNamesPath)}`)

  // Step 2: Build a fresh schema from the just-discovered names. The factory
  // takes names as parameters, so there is no need for a cache-busting dynamic
  // import — the static SystematicConfigSchema export (built from the committed
  // bundled-names.ts at module load) is intentionally bypassed here.
  const freshSchema = createSystematicConfigSchema({
    agentNames: agents,
    qualifiedAgentIds: agentQualifiedIds,
    skillNames: skills,
  })

  const schemaContent = generateSchemaContentFromSchema(
    resolvedVersion,
    freshSchema,
  )
  const schemaPaths = generateAndWrite(schemaContent, resolvedVersion)

  const major = getMajorVersion(resolvedVersion)
  const relPaths = schemaPaths.map((p) => path.relative(PROJECT_ROOT, p))

  console.log(`Systematic Config Schema v${major} (${resolvedVersion})`)
  console.log(`  ${relPaths[0]}`)
  console.log(`  ${relPaths[1]}`)
  console.log(`  ${relPaths[2]}`)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error((err as Error).message)
    process.exit(1)
  })
}
