/** Runtime persona catalog for `systematic_delegate`. Pi has no agent-discovery of its own, so category is dropped when flattening `agents/<category>/<name>.md` into this catalog. */

import fs from 'node:fs'
import { extractAgentFrontmatter, findAgentsInDir } from './agents.js'
import { parseFrontmatter } from './frontmatter.js'

/** A single resolved persona entry in the flattened catalog. */
export interface AgentCatalogEntry {
  /** Flat persona name (category dropped). */
  name: string
  /** Human-readable description, used in tool description/parameter hints. */
  description: string
  /** Full persona system-prompt body (frontmatter stripped). */
  body: string
  /** Raw comma-separated `tools:` frontmatter value, if declared. Undefined = not declared. */
  toolsSource: string | undefined
}

/** Fails closed if the same persona name appears under more than one category. */
export function buildAgentCatalog(agentsDir: string): AgentCatalogEntry[] {
  const infos = findAgentsInDir(agentsDir)
  const byName = new Map<string, string[]>()
  const entries: AgentCatalogEntry[] = []

  for (const info of infos) {
    const content = fs.readFileSync(info.file, 'utf8')
    const entry = parseValidatedAgentEntry(content, info.file)

    const existing = byName.get(entry.name)
    if (existing) {
      existing.push(info.category ?? '(root)')
    } else {
      byName.set(entry.name, [info.category ?? '(root)'])
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
): AgentCatalogEntry {
  const { parseError } = parseFrontmatter<Record<string, unknown>>(content)
  if (parseError) {
    throw new Error(
      `Failed to parse YAML frontmatter in agent file "${sourceFile}".`,
    )
  }

  const frontmatter = extractAgentFrontmatter(content)

  if (frontmatter.name.trim() === '') {
    throw new Error(
      `Agent file "${sourceFile}" is missing a non-empty "name" in its frontmatter.`,
    )
  }
  if (frontmatter.description.trim() === '') {
    throw new Error(
      `Agent file "${sourceFile}" is missing a non-empty "description" in its frontmatter.`,
    )
  }
  if (frontmatter.prompt.trim() === '') {
    throw new Error(
      `Agent file "${sourceFile}" has an empty persona body (system prompt).`,
    )
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    body: frontmatter.prompt,
    toolsSource: extractRawToolsSource(content),
  }
}
function extractRawToolsSource(content: string): string | undefined {
  const { data } = parseFrontmatter<Record<string, unknown>>(content)
  const value = data.tools
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed !== '' ? trimmed : undefined
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

export class UnknownDeclaredToolError extends Error {
  constructor(public readonly toolName: string) {
    super(
      `Unknown declared tool "${toolName}" in persona frontmatter; refusing to map ` +
        'to a Pi built-in (fail-closed). Known tools: ' +
        `${Object.keys(OPENCODE_TO_PI_TOOL).join(', ')}.`,
    )
    this.name = 'UnknownDeclaredToolError'
  }
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
      throw new UnknownDeclaredToolError(name)
    }
    const piName = OPENCODE_TO_PI_TOOL[name]
    if (!piName) {
      throw new UnknownDeclaredToolError(name)
    }
    mapped.push(piName)
  }

  return { tools: mapped }
}
