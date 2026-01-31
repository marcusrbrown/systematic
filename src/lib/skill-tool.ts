import path from 'node:path'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import {
  extractSkillBody,
  type LoadedSkill,
  loadSkill,
} from './skill-loader.js'
import { findSkillsInDir, formatSkillsXml } from './skills.js'

export interface SkillToolOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const { bundledSkillsDir, disabledSkills } = options

  const getSystematicSkills = (): LoadedSkill[] => {
    return findSkillsInDir(bundledSkillsDir)
      .filter((s) => !disabledSkills.includes(s.name))
      .map((skillInfo) => loadSkill(skillInfo))
      .filter((s): s is LoadedSkill => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const buildDescription = (): string => {
    const skills = getSystematicSkills()
    const skillInfos = skills.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path,
      skillFile: s.skillFile,
    }))
    const systematicXml = formatSkillsXml(skillInfos)

    const baseDescription = `Load a skill to get detailed instructions for a specific task.

Skills provide specialized knowledge and step-by-step guidance.
Use this when a task matches an available skill's description.`

    return `${baseDescription}\n\n${systematicXml}`
  }

  let cachedDescription: string | null = null

  return tool({
    get description() {
      if (cachedDescription == null) {
        cachedDescription = buildDescription()
      }
      return cachedDescription
    },
    args: {
      name: tool.schema
        .string()
        .describe(
          "The skill identifier from available_skills (e.g., 'systematic:brainstorming')",
        ),
    },
    async execute(args: { name: string }): Promise<string> {
      const requestedName = args.name

      const normalizedName = requestedName.startsWith('systematic:')
        ? requestedName.slice('systematic:'.length)
        : requestedName

      const skills = getSystematicSkills()
      const matchedSkill = skills.find((s) => s.name === normalizedName)

      if (matchedSkill) {
        const body = extractSkillBody(matchedSkill.wrappedTemplate)
        const dir = path.dirname(matchedSkill.skillFile)

        return `## Skill: ${matchedSkill.prefixedName}

**Base directory**: ${dir}

${body}`
      }

      const availableSystematic = skills.map((s) => s.prefixedName)
      throw new Error(
        `Skill "${requestedName}" not found. Available systematic skills: ${availableSystematic.join(', ')}`,
      )
    },
  })
}
