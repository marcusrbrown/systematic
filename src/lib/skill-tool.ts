import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import {
  buildCatalogEntries,
  escapeXml,
  renderCatalogCompact,
} from './skill-catalog.js'
import {
  extractSkillBody,
  formatSkillCommandName,
  type LoadedSkill,
  loadSkill,
} from './skill-loader.js'
import {
  findSkillsInDir,
  type SkillDeprecated,
  type SkillInfo,
} from './skills.js'

export interface SkillToolOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
}

/**
 * Formats skills as XML for tool description.
 * Uses indented format matching OpenCode's native skill tool.
 */
export function formatSkillsXml(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''

  // Match OpenCode's native skill tool format exactly:
  // Uses space-delimited join with indented XML structure
  const skillLines = skills.flatMap((skill) => [
    '  <skill>',
    `    <name>${escapeXml(formatSkillCommandName(skill.name))}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    `    <location>${pathToFileURL(skill.path).href}</location>`,
    '  </skill>',
  ])

  return ['<available_skills>', ...skillLines, '</available_skills>'].join(' ')
}

/**
 * Discovers skill files in a directory and formats them as XML tags.
 * Recursively searches subdirectories, includes hidden files, excludes .git and SKILL.md.
 * Matches OpenCode v1.1.50 behavior exactly.
 *
 * @param dir - Directory path to search for skill files
 * @param limit - Maximum number of files to return (default: 10)
 * @returns String with absolute file paths formatted as XML tags, one per line
 */
export function discoverSkillFiles(dir: string, limit = 10): string {
  const files: string[] = []

  function shouldSkipDirectory(name: string): boolean {
    return name === '.git'
  }

  function shouldIncludeFile(name: string): boolean {
    return name !== 'SKILL.md'
  }

  function handleEntry(entry: fs.Dirent, currentDir: string): void {
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        recurse(path.resolve(currentDir, entry.name))
      }
    } else if (shouldIncludeFile(entry.name)) {
      files.push(path.resolve(currentDir, entry.name))
    }
  }

  function recurse(currentDir: string): void {
    if (files.length >= limit) return

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        if (files.length >= limit) break
        handleEntry(entry, currentDir)
      }
    } catch {
      // Silently ignore read errors
    }
  }

  recurse(dir)
  return files.map((file) => `  <file>${file}</file>`).join('\n')
}

function formatDeprecationMessage(
  name: string,
  deprecated: SkillDeprecated,
): string {
  let msg = `[systematic] skill "${name}" is deprecated since ${deprecated.since}; will be removed in ${deprecated.removal}.`
  if (deprecated.replacement) {
    msg += ` Replacement: ${deprecated.replacement}`
    if (!deprecated.replacement.endsWith('.')) {
      msg += '.'
    }
  }
  if (deprecated.reason) {
    msg += ` Reason: ${deprecated.reason}`
    if (!deprecated.reason.endsWith('.')) {
      msg += '.'
    }
  }
  return msg
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const { bundledSkillsDir, disabledSkills } = options
  // Per-createSkillTool instance, intentionally not per-session. OpenCode's
  // current per-session plugin-init behavior makes this de facto per-session
  // today. If a future OpenCode reuses plugin instances across sessions, the
  // warning de-emits indefinitely — acceptable since deprecation is informational.
  const warnedSkills = new Set<string>()

  const getAllSkills = (): LoadedSkill[] => {
    return findSkillsInDir(bundledSkillsDir)
      .filter((s) => !disabledSkills.includes(s.name))
      .map((skillInfo) => loadSkill(skillInfo))
      .filter((s): s is LoadedSkill => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const buildDescription = (): string => {
    const catalog = renderCatalogCompact({ bundledSkillsDir, disabledSkills })

    return `Load a specialized skill that provides domain-specific instructions and workflows.

When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.

The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.

Tool output includes a \`<skill_content name="...">\` block with the loaded content.

${catalog}`
  }

  const buildParameterHint = (): string => {
    const entries = buildCatalogEntries({ bundledSkillsDir, disabledSkills })
    const examples = entries
      .slice(0, 3)
      .map((s) => `'${s.prefixedName}'`)
      .join(', ')
    const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ''
    return `The name of the skill from available_skills${hint}`
  }

  let cachedDescription: string | null = null
  let cachedParameterHint: string | null = null

  return tool({
    get description() {
      if (cachedDescription == null) {
        cachedDescription = buildDescription()
      }
      return cachedDescription
    },
    args: {
      name: tool.schema.string().describe(
        (() => {
          if (cachedParameterHint == null) {
            cachedParameterHint = buildParameterHint()
          }
          return cachedParameterHint
        })(),
      ),
    },
    async execute(args: { name: string }, context): Promise<string> {
      const requestedName = args.name

      const normalizedName = requestedName.startsWith('systematic:')
        ? requestedName.slice('systematic:'.length)
        : requestedName

      const skills = getAllSkills()
      const matchedSkill = skills.find((s) => s.name === normalizedName)

      if (!matchedSkill) {
        const availableSystematic = buildCatalogEntries({
          bundledSkillsDir,
          disabledSkills,
        }).map((s) => s.prefixedName)
        throw new Error(
          `Skill "${requestedName}" not found. Available systematic skills: ${availableSystematic.join(', ')}`,
        )
      }

      if (matchedSkill.deprecated && !warnedSkills.has(matchedSkill.name)) {
        console.warn(
          formatDeprecationMessage(matchedSkill.name, matchedSkill.deprecated),
        )
        warnedSkills.add(matchedSkill.name)
      }

      const body = extractSkillBody(matchedSkill.wrappedTemplate)
      const dir = path.dirname(matchedSkill.skillFile)
      const base = pathToFileURL(dir).href
      const files = discoverSkillFiles(dir)

      await context.ask({
        permission: 'skill',
        patterns: [matchedSkill.prefixedName],
        always: [matchedSkill.prefixedName],
        metadata: {},
      })

      context.metadata({
        title: `Loaded skill: ${matchedSkill.prefixedName}`,
        metadata: {
          name: matchedSkill.prefixedName,
          dir,
        },
      })

      const output = [
        `<skill_content name="${matchedSkill.prefixedName}">`,
        `# Skill: ${matchedSkill.prefixedName}`,
        '',
        body.trim(),
        '',
        `Base directory for this skill: ${base}`,
        'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
        'Note: file list is sampled.',
      ]

      if (files) {
        output.push('', '<skill_files>', files, '</skill_files>')
      }

      output.push('</skill_content>')
      return output.join('\n')
    },
  })
}
