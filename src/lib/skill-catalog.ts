import { pathToFileURL } from 'node:url'
import { formatSkillCommandName } from './skill-loader.js'
import { findSkillsInDir } from './skills.js'

export interface CatalogEntry {
  name: string
  prefixedName: string
  description: string
  path: string
  skillFile: string
}

export interface CatalogOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
}

/**
 * Discovers and filters bundled Systematic skills into catalog entries.
 * Excludes disabled skills and skills with disableModelInvocation === true.
 * Returns entries sorted by name.
 */
export function buildCatalogEntries(options: CatalogOptions): CatalogEntry[] {
  const { bundledSkillsDir, disabledSkills } = options

  return findSkillsInDir(bundledSkillsDir)
    .filter((s) => !disabledSkills.includes(s.name))
    .filter((s) => s.disableModelInvocation !== true)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      prefixedName: formatSkillCommandName(s.name),
      description: s.description,
      path: s.path,
      skillFile: s.skillFile,
    }))
}

/**
 * Renders discoverable skills as native-style verbose XML for bootstrap content.
 * Returns empty string when no skills are available.
 */
export function renderCatalogVerbose(options: CatalogOptions): string {
  const entries = buildCatalogEntries(options)

  if (entries.length === 0) return ''

  const skillLines = entries.flatMap((entry) => [
    '  <skill>',
    `    <name>${entry.prefixedName}</name>`,
    `    <description>${entry.description}</description>`,
    `    <location>${pathToFileURL(entry.path).href}</location>`,
    '  </skill>',
  ])

  return ['<available_skills>', ...skillLines, '</available_skills>'].join('\n')
}

/**
 * Renders discoverable skills as a compact markdown list for tool descriptions.
 * Always includes the heading; renders an explicit no-skills message when empty.
 */
export function renderCatalogCompact(options: CatalogOptions): string {
  const entries = buildCatalogEntries(options)

  const heading = '## Available Systematic Skills'

  if (entries.length === 0) {
    return `${heading}\n\nNo Systematic skills are currently available.`
  }

  const bullets = entries
    .map((entry) => `- ${entry.prefixedName}: ${entry.description}`)
    .join('\n')

  return `${heading}\n\n${bullets}`
}
