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
 *   bun scripts/generate-registry.ts --check     # Exit non-zero if registry would change (Unit 4)
 */
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
const REGISTRY_PATH = path.join(PROJECT_ROOT, 'registry/registry.jsonc')
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills')
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents')

const SCHEMA_URL = 'https://ocx.kdco.dev/schemas/v2/registry.json'

const EXCLUDED_FILE_NAMES = new Set(['.DS_Store', '.gitkeep', 'AGENTS.md'])

const EXCLUDED_FILE_PATTERNS: ReadonlyArray<RegExp> = [/\.bak$/, /\.tmp$/, /~$/]

const EXCLUDED_DIR_NAMES = new Set([
  '__pycache__',
  '.pytest_cache',
  'node_modules',
])

const CURATED_TYPES = new Set(['bundle', 'profile', 'plugin'])

type FileEntry = string | { path: string; target: string }

interface ComponentEntry {
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

interface RegistryOutput {
  $schema: string
  name: string
  namespace: string
  version: string
  author: string
  components: ComponentEntry[]
}

/** V2 schema requires `^[a-z0-9]+(-[a-z0-9]+)*$` — replace underscores with hyphens. */
function sanitizeComponentName(name: string): string {
  return name.replace(/_/g, '-')
}

function isExcludedFile(filePath: string): boolean {
  const basename = path.basename(filePath)
  if (EXCLUDED_FILE_NAMES.has(basename)) return true
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
    return true
  }
  const segments = filePath.split(path.sep)
  return segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))
}

function requireDescription(componentName: string, description: string): void {
  if (description.trim().length === 0) {
    console.error(
      `Error: Component "${componentName}" has empty description. V2 schema requires a non-empty description.`,
    )
    process.exit(1)
  }
}

function generateSkillComponents(): ComponentEntry[] {
  const skills = findSkillsInDir(SKILLS_DIR)
  const components: ComponentEntry[] = []

  for (const skill of skills) {
    const componentName = sanitizeComponentName(path.basename(skill.path))

    const fileEntries = walkDir(skill.path, {
      filter: (e) => !e.isDirectory && !isExcludedFile(e.path),
    })

    const files = fileEntries
      .map((e) => path.relative(PROJECT_ROOT, e.path))
      .sort()

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

function generateAgentComponents(): ComponentEntry[] {
  const agents = findAgentsInDir(AGENTS_DIR)
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
      files: [path.relative(PROJECT_ROOT, agent.file)],
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

function loadCuratedComponents(): {
  curated: ComponentEntry[]
  source: RegistrySource
} {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { curated: [], source: {} }
  }

  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8')
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

export function generateRegistryContent(): string {
  const skillComponents = generateSkillComponents()
  const agentComponents = generateAgentComponents()
  const generated = [...skillComponents, ...agentComponents].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  const { curated, source } = loadCuratedComponents()
  const skillNames = skillComponents.map((c) => c.name)
  const agentNames = agentComponents.map((c) => c.name)
  const updatedCurated = autoPopulateBundleDependencies(
    curated,
    skillNames,
    agentNames,
  )

  const registry = buildRegistryOutput(source, generated, updatedCurated)
  return `${HEADER_COMMENT}\n${JSON.stringify(registry, null, 2)}\n`
}

function main(): void {
  const content = generateRegistryContent()
  fs.writeFileSync(REGISTRY_PATH, content)
  console.log(
    `Generated ${path.relative(PROJECT_ROOT, REGISTRY_PATH)} (${countComponents(content)} components)`,
  )
}

function countComponents(content: string): number {
  const parsed = parseJsonc(content) as RegistrySource | undefined
  return parsed?.components?.length ?? 0
}

main()
