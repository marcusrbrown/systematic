#!/usr/bin/env bun
/**
 * Generate OCX Registry
 *
 * Auto-generates skill and agent components in `registry/registry.jsonc` from the
 * filesystem. Bundles, profiles, and plugin entries are hand-curated and preserved
 * (with bundle `dependencies` arrays auto-populated for bundles named `skills` or `agents`).
 *
 * Output is V2 OCX format:
 *   - Unprefixed types (skill, agent, bundle, profile, plugin)
 *   - String shorthand for generated file entries (path === target)
 *   - Repo-root-relative paths
 *   - V2 schema URL
 *
 * Component names derive from filesystem paths:
 *   - Skills: skill directory name with underscores replaced by hyphens
 *   - Agents: `agent-` + filename stem (without `.md`) with underscores replaced by hyphens
 *
 * Frontmatter `description` is required for every component. The generator exits
 * with an error if any component has missing or empty description.
 *
 * Usage:
 *   bun scripts/generate-registry.ts             # Regenerate registry.jsonc in place
 *   bun scripts/generate-registry.ts --check     # Exit non-zero if registry would change
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'
import { extractAgentFrontmatter, findAgentsInDir } from '../src/lib/agents.js'
import { findSkillsInDir } from '../src/lib/skills.js'
import { walkDir } from '../src/lib/walk-dir.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

export const SCHEMA_URL = 'https://ocx.kdco.dev/schemas/v2/registry.json'

export const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  '.gitkeep',
  'AGENTS.md',
])

export const EXCLUDED_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /\.bak$/,
  /\.tmp$/,
  /~$/,
]

export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  '__pycache__',
  '.pytest_cache',
  'node_modules',
])

const CURATED_TYPES = new Set(['bundle', 'profile', 'plugin'])

type FileEntry = string | { path: string; target: string }

export interface ComponentEntry {
  name: string
  type: string
  description?: string
  files?: FileEntry[]
  dependencies?: string[]
  opencode?: Record<string, unknown>
  [key: string]: unknown
}

interface RegistrySource {
  $schema?: string
  name?: string
  namespace?: string
  version?: string
  author?: string
  components?: ComponentEntry[]
}

export interface RegistryOutput {
  $schema: string
  name: string
  namespace: string
  version: string
  author: string
  components: ComponentEntry[]
}

/** V2 schema requires `^[a-z0-9]+(-[a-z0-9]+)*$` — replace underscores with hyphens. */
export function sanitizeComponentName(name: string): string {
  return name.replace(/_/g, '-')
}

export function isExcludedFile(filePath: string): boolean {
  const basename = path.basename(filePath)
  if (EXCLUDED_FILE_NAMES.has(basename)) return true
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
    return true
  }
  const segments = filePath.split(path.sep)
  return segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))
}

/**
 * Tagged error for generator-detected validation failures (e.g. empty description).
 * Plain Error + tag keeps the codebase class-free; callers detect via `code` field.
 */
type GenerationError = Error & { code: 'GENERATION_ERROR' }

function generationError(message: string): GenerationError {
  return Object.assign(new Error(message), {
    code: 'GENERATION_ERROR' as const,
  })
}

function isGenerationError(err: unknown): err is GenerationError {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === 'GENERATION_ERROR'
  )
}

function requireDescription(componentName: string, description: string): void {
  if (description.trim().length === 0) {
    throw generationError(
      `Component "${componentName}" has empty description. V2 schema requires a non-empty description.`,
    )
  }
}

function generateSkillComponents(rootDir: string): ComponentEntry[] {
  const skillsDir = path.join(rootDir, 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const skills = findSkillsInDir(skillsDir)
  const components: ComponentEntry[] = []

  for (const skill of skills) {
    const componentName = sanitizeComponentName(path.basename(skill.path))

    const fileEntries = walkDir(skill.path, {
      filter: (e) => !e.isDirectory && !isExcludedFile(e.path),
    })

    const files = fileEntries.map((e) => path.relative(rootDir, e.path)).sort()

    if (files.length === 0) {
      console.warn(
        `Warning: Skill "${componentName}" has no files after exclusions, skipping`,
      )
      continue
    }

    requireDescription(componentName, skill.description)

    components.push({
      name: componentName,
      type: 'skill',
      description: skill.description,
      files,
    })
  }

  return components
}

function generateAgentComponents(rootDir: string): ComponentEntry[] {
  const agentsDir = path.join(rootDir, 'agents')
  if (!fs.existsSync(agentsDir)) return []

  const agents = findAgentsInDir(agentsDir)
  const components: ComponentEntry[] = []

  for (const agent of agents) {
    const stem = sanitizeComponentName(agent.name)
    const componentName = `agent-${stem}`

    const content = fs.readFileSync(agent.file, 'utf8')
    const frontmatter = extractAgentFrontmatter(content)

    requireDescription(componentName, frontmatter.description)

    components.push({
      name: componentName,
      type: 'agent',
      description: frontmatter.description,
      files: [path.relative(rootDir, agent.file)],
    })
  }

  return components
}

function migrateCuratedType(component: ComponentEntry): ComponentEntry {
  if (component.type.startsWith('ocx:')) {
    return { ...component, type: component.type.slice('ocx:'.length) }
  }
  return component
}

function loadCuratedComponents(registryPath: string): {
  curated: ComponentEntry[]
  source: RegistrySource
} {
  if (!fs.existsSync(registryPath)) {
    return { curated: [], source: {} }
  }

  const raw = fs.readFileSync(registryPath, 'utf8')
  const parsed = parseJsonc(raw) as RegistrySource | undefined

  if (parsed == null || !Array.isArray(parsed.components)) {
    return { curated: [], source: {} }
  }

  const curated = parsed.components
    .map(migrateCuratedType)
    .filter((c) => CURATED_TYPES.has(c.type))

  return { curated, source: parsed }
}

function autoPopulateBundleDependencies(
  curated: ComponentEntry[],
  skillNames: string[],
  agentNames: string[],
): ComponentEntry[] {
  return curated.map((component) => {
    if (component.type !== 'bundle') return component
    if (component.name === 'skills') {
      return { ...component, dependencies: [...skillNames].sort() }
    }
    if (component.name === 'agents') {
      return { ...component, dependencies: [...agentNames].sort() }
    }
    return component
  })
}

const HEADER_COMMENT = [
  '// OCX Registry Source for Systematic',
  '// https://ocx.kdco.dev',
  '//',
  '// Skill and agent components are auto-generated by `bun scripts/generate-registry.ts`.',
  '// Do not hand-edit those entries — re-run the generator instead.',
  '// Bundles, profiles, and plugin entries are hand-curated.',
  '//',
  '// Version is a placeholder (0.0.0) — injected by build script at publish time.',
].join('\n')

function buildRegistryOutput(
  source: RegistrySource,
  generated: ComponentEntry[],
  curated: ComponentEntry[],
): RegistryOutput {
  return {
    $schema: SCHEMA_URL,
    name: source.name ?? 'Systematic',
    namespace: source.namespace ?? 'systematic',
    version: source.version ?? '0.0.0',
    author: source.author ?? '',
    components: [...generated, ...curated],
  }
}

/**
 * Run Biome's formatter over JSONC content via stdin. The generator does this
 * to keep its output stable under `bun run lint` — `JSON.stringify` always uses
 * multi-line arrays, while Biome inlines short single-element arrays, so without
 * this step the drift check would false-positive after every lint run.
 *
 * Using Biome directly (instead of replicating its inlining rules) means the
 * generator inherits any future Biome formatting changes for free.
 */
function formatWithBiome(content: string, fileName: string): string {
  const result = spawnSync(
    'bunx',
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

/**
 * Generate the registry.jsonc file content for the given repo root. Pure function:
 * reads from `<rootDir>/skills/`, `<rootDir>/agents/`, and `<rootDir>/registry/registry.jsonc`,
 * but does not write anything. Throws GenerationError on any component with empty description.
 */
export function generateRegistryContent(rootDir: string): string {
  const registryPath = path.join(rootDir, 'registry/registry.jsonc')
  const skillComponents = generateSkillComponents(rootDir)
  const agentComponents = generateAgentComponents(rootDir)
  const generated = [...skillComponents, ...agentComponents].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  const { curated, source } = loadCuratedComponents(registryPath)
  const skillNames = skillComponents.map((c) => c.name)
  const agentNames = agentComponents.map((c) => c.name)
  const updatedCurated = autoPopulateBundleDependencies(
    curated,
    skillNames,
    agentNames,
  )

  const registry = buildRegistryOutput(source, generated, updatedCurated)
  const raw = `${HEADER_COMMENT}\n${JSON.stringify(registry, null, 2)}\n`
  return formatWithBiome(raw, 'registry.jsonc')
}

export function countComponents(content: string): number {
  const parsed = parseJsonc(content) as RegistrySource | undefined
  return parsed?.components?.length ?? 0
}

export function normalizeForCompare(content: string): string {
  // Normalize CRLF -> LF first (Windows / git autocrlf) then strip trailing whitespace.
  return content.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

function parseArgs(argv: string[]): { check: boolean } {
  const args = argv.slice(2)
  return { check: args.includes('--check') }
}

function checkRegistry(rootDir: string): void {
  const registryPath = path.join(rootDir, 'registry/registry.jsonc')
  const relPath = path.relative(rootDir, registryPath)

  let generated: string
  try {
    generated = generateRegistryContent(rootDir)
  } catch (err) {
    if (isGenerationError(err)) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  if (!fs.existsSync(registryPath)) {
    console.error(
      `Error: ${relPath} does not exist. Run \`bun scripts/generate-registry.ts\` to create it.`,
    )
    process.exit(1)
  }

  const existing = fs.readFileSync(registryPath, 'utf8')
  if (normalizeForCompare(existing) === normalizeForCompare(generated)) {
    console.log(
      `${relPath} is up to date (${countComponents(generated)} components)`,
    )
    process.exit(0)
  }

  console.error(
    `Error: ${relPath} is out of date. Run \`bun scripts/generate-registry.ts\` to update it.`,
  )
  process.exit(1)
}

function main(rootDir: string): void {
  const { check } = parseArgs(process.argv)

  if (check) {
    checkRegistry(rootDir)
    return
  }

  let content: string
  try {
    content = generateRegistryContent(rootDir)
  } catch (err) {
    if (isGenerationError(err)) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  const registryPath = path.join(rootDir, 'registry/registry.jsonc')
  fs.writeFileSync(registryPath, content)
  console.log(
    `Generated ${path.relative(rootDir, registryPath)} (${countComponents(content)} components)`,
  )
}

// Only run main() when this file is invoked directly (not when imported by tests).
if (import.meta.main) {
  main(PROJECT_ROOT)
}
