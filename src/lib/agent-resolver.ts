/** Runtime persona catalog for `systematic_delegate`. Pi has no agent-discovery of its own, so category is dropped when flattening `agents/<category>/<name>.md` into this catalog. */

import fs from 'node:fs'
import { findAgentsInDir } from './agents.js'
import { parseFrontmatter } from './frontmatter.js'
import { extractString } from './validation.js'

/** A single resolved persona entry in the flattened catalog. */
export interface AgentCatalogEntry {
  /** Flat persona name (category dropped). Used for dispatch matching (`resolveAgent`); may differ from `key` if frontmatter `name` and the file stem diverge. */
  name: string
  /** Human-readable description, used in tool description/parameter hints. */
  description: string
  /** Full persona system-prompt body (frontmatter stripped). */
  body: string
  /** Raw comma-separated `tools:` frontmatter value, if declared. Undefined = not declared. */
  toolsSource: string | undefined
  /** The agent's source file stem (filename without `.md`), used to key into `agents.<key>` overlays for routing (distinct from the display `name`). */
  key: string
  /** The agent's category (source subdirectory name), used to key into `categories.<category>` overlays. `''` when the file has no category subdirectory -- the same no-category sentinel `config-handler.ts` and `pi-subagents-export.ts` use. */
  category: string
  /** Qualified `category/key` id, mirroring `agent-overlays.ts`'s target-id convention, for callers that want a single stable identity. */
  id: string
}

/** Fails closed if the same persona name appears under more than one category. */
export function buildAgentCatalog(agentsDir: string): AgentCatalogEntry[] {
  const infos = findAgentsInDir(agentsDir)
  const byName = new Map<string, string[]>()
  const entries: AgentCatalogEntry[] = []

  for (const info of infos) {
    const content = fs.readFileSync(info.file, 'utf8')
    const parsed = parseValidatedAgentEntry(content, info.file)
    const category = info.category ?? ''
    const key = info.name
    const entry: AgentCatalogEntry = {
      ...parsed,
      key,
      category,
      id: category ? `${category}/${key}` : key,
    }

    try {
      resolveToolAllowlist(entry.toolsSource)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Agent file "${info.file}": ${message}`)
    }

    const existing = byName.get(entry.name)
    if (existing) {
      existing.push(category)
    } else {
      byName.set(entry.name, [category])
    }

    entries.push(entry)
  }

  const duplicates = [...byName.entries()].filter(([, cats]) => cats.length > 1)
  if (duplicates.length > 0) {
    const detail = duplicates
      .map(([name, cats]) => `"${name}" (categories: ${cats.join(', ')})`)
      .join('; ')
    throw new Error(
      `Duplicate persona name(s) detected while flattening the agent catalog: ${detail}. ` +
        'Persona names must be unique across categories once category is dropped.',
    )
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/** Fails closed on invalid/missing frontmatter fields rather than allowing an unusable delegate target into the catalog. */
function parseValidatedAgentEntry(
  content: string,
  sourceFile: string,
): Omit<AgentCatalogEntry, 'key' | 'category' | 'id'> {
  const { data, body, parseError } =
    parseFrontmatter<Record<string, unknown>>(content)
  if (parseError) {
    throw new Error(
      `Failed to parse YAML frontmatter in agent file "${sourceFile}".`,
    )
  }

  const name = extractString(data, 'name')
  if (name.trim() === '') {
    throw new Error(
      `Agent file "${sourceFile}" is missing a non-empty "name" in its frontmatter.`,
    )
  }

  const description = extractString(data, 'description')
  if (description.trim() === '') {
    throw new Error(
      `Agent file "${sourceFile}" is missing a non-empty "description" in its frontmatter.`,
    )
  }

  const prompt = body.trim()
  if (prompt === '') {
    throw new Error(
      `Agent file "${sourceFile}" has an empty persona body (system prompt).`,
    )
  }

  return {
    name,
    description,
    body: prompt,
    toolsSource: extractRawToolsSource(data, sourceFile),
  }
}

/** Requires a non-empty string when `tools` is declared; unsupported YAML shapes (maps, arrays, numbers) fail closed with source-path context. */
function extractRawToolsSource(
  data: Record<string, unknown>,
  sourceFile: string,
): string | undefined {
  if (!('tools' in data)) return undefined
  const value = data.tools
  if (typeof value !== 'string') {
    throw new Error(
      `Agent file "${sourceFile}" has a "tools" frontmatter value that is not a string; expected a comma-separated list (e.g. "Read, Grep, Glob, Bash").`,
    )
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new Error(
      `Agent file "${sourceFile}" declares an empty "tools" frontmatter value.`,
    )
  }
  return trimmed
}

/** Resolves a persona by exact flat name from the catalog. */
export function resolveAgent(
  catalog: AgentCatalogEntry[],
  name: string,
): AgentCatalogEntry | undefined {
  return catalog.find((entry) => entry.name === name)
}

/**
 * Deterministic, bounded description of available personas for the delegation
 * tool's description/parameter hint text. Stable ordering (catalog is pre-sorted).
 */
export function renderAgentCatalogCompact(
  catalog: AgentCatalogEntry[],
): string {
  if (catalog.length === 0) {
    return 'No Systematic personas are currently available.'
  }

  return catalog
    .map((entry) => `- ${entry.name}: ${entry.description}`)
    .join('\n')
}

/** Pi built-in read-only tool names used as the default allowlist. */
export const DEFAULT_READONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const

const OPENCODE_TO_PI_TOOL: Record<string, string> = {
  Read: 'read',
  Grep: 'grep',
  Glob: 'find',
  Bash: 'bash',
  Edit: 'edit',
  Write: 'write',
}

export interface ResolvedToolAllowlist {
  tools: string[]
}

function unknownDeclaredToolError(toolName: string): Error {
  const error = new Error(
    `Unknown declared tool "${toolName}" in persona frontmatter; refusing to map ` +
      'to a Pi built-in (fail-closed). Known tools: ' +
      `${Object.keys(OPENCODE_TO_PI_TOOL).join(', ')}.`,
  )
  error.name = 'UnknownDeclaredToolError'
  return error
}

/** Undeclared tools use the read-only default; unknown or `Task` declarations fail closed. */
export function resolveToolAllowlist(
  toolsSource: string | undefined,
): ResolvedToolAllowlist {
  if (toolsSource === undefined) {
    return { tools: [...DEFAULT_READONLY_TOOLS] }
  }

  const declared = toolsSource
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')

  const mapped: string[] = []
  for (const name of declared) {
    if (name === 'Task') {
      throw unknownDeclaredToolError(name)
    }
    const piName = OPENCODE_TO_PI_TOOL[name]
    if (!piName) {
      throw unknownDeclaredToolError(name)
    }
    mapped.push(piName)
  }

  return { tools: mapped }
}
