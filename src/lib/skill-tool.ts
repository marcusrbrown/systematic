import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import {
  extractSkillBody,
  type LoadedSkill,
  loadSkill,
} from './skill-loader.js'
import { findSkillsInDir, type SkillInfo } from './skills.js'

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
    `    <name>systematic:${skill.name}</name>`,
    `    <description>${skill.description}</description>`,
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
  try {
    const files: string[] = []

    function walk(currentDir: string): void {
      if (files.length >= limit) return

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch {
        return // Skip unreadable directories
      }

      for (const entry of entries) {
        if (files.length >= limit) return

        const entryPath = path.join(currentDir, entry.name)

        // Skip .git directory (matches OpenCode's --glob=!.git/*)
        if (entry.name === '.git') continue

        // Skip SKILL.md files
        if (entry.name === 'SKILL.md') continue

        if (entry.isDirectory()) {
          walk(entryPath)
        } else if (entry.isFile()) {
          // Use absolute path (matches OpenCode's path.resolve behavior)
          files.push(path.resolve(entryPath))
        }
      }
    }

    walk(dir)

    return files
      .sort()
      .slice(0, limit)
      .map((file) => `  <file>${file}</file>`)
      .join('\n')
  } catch {
    return ''
  }
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const { bundledSkillsDir, disabledSkills } = options

  const getSystematicSkills = (): LoadedSkill[] => {
    return findSkillsInDir(bundledSkillsDir)
      .filter((s) => !disabledSkills.includes(s.name))
      .map((skillInfo) => loadSkill(skillInfo))
      .filter((s): s is LoadedSkill => s !== null)
      .filter((s) => s.disableModelInvocation !== true)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const buildDescription = (): string => {
    const skills = getSystematicSkills()

    if (skills.length === 0) {
      return 'Load a skill to get detailed instructions for a specific task. No skills are currently available.'
    }

    const skillInfos = skills.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path,
      skillFile: s.skillFile,
    }))
    const systematicXml = formatSkillsXml(skillInfos)

    return [
      'Load a specialized skill that provides domain-specific instructions and workflows.',
      '',
      'When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.',
      '',
      'The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.',
      '',
      'Tool output includes a `<skill_content name="...">` block with the loaded content.',
      '',
      'The following skills provide specialized sets of instructions for particular tasks.',
      'Invoke this tool to load a skill when a task matches one of the available skills listed below:',
      '',
      systematicXml,
    ].join('\n')
  }

  const buildParameterHint = (): string => {
    const skills = getSystematicSkills()
    const examples = skills
      .slice(0, 3)
      .map((s) => `'systematic:${s.name}'`)
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

      const skills = getSystematicSkills()
      const matchedSkill = skills.find((s) => s.name === normalizedName)

      if (!matchedSkill) {
        const availableSystematic = skills.map((s) => s.prefixedName)
        throw new Error(
          `Skill "${requestedName}" not found. Available systematic skills: ${availableSystematic.join(', ')}`,
        )
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

      return [
        `<skill_content name="${matchedSkill.prefixedName}">`,
        `# Skill: ${matchedSkill.prefixedName}`,
        '',
        body.trim(),
        '',
        `Base directory for this skill: ${base}`,
        'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
        'Note: file list is sampled.',
        '',
        '<skill_files>',
        files,
        '</skill_files>',
        '</skill_content>',
      ].join('\n')
    },
  })
}
