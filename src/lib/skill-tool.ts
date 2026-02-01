import path from 'node:path'
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
    '  </skill>',
  ])

  return ['<available_skills>', ...skillLines, '</available_skills>'].join(' ')
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
      'Load a skill to get detailed instructions for a specific task.',
      'Skills provide specialized knowledge and step-by-step guidance.',
      "Use this when a task matches an available skill's description.",
      'Only the skills listed here are available:',
      systematicXml,
    ].join(' ')
  }

  const buildParameterHint = (): string => {
    const skills = getSystematicSkills()
    const examples = skills
      .slice(0, 3)
      .map((s) => `'systematic:${s.name}'`)
      .join(', ')
    const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ''
    return `The skill identifier from available_skills${hint}`
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
        `## Skill: ${matchedSkill.prefixedName}`,
        '',
        `**Base directory**: ${dir}`,
        '',
        body.trim(),
      ].join('\n')
    },
  })
}
