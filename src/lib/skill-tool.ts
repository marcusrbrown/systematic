import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { convertContent } from './converter.js'
import { stripFrontmatter } from './frontmatter.js'
import type { SkillInfo } from './skills.js'
import { findSkillsInDir, formatSkillsXml } from './skills.js'


function wrapSkillContent(skillPath: string, content: string): string {
  const skillDir = path.dirname(skillPath)
  const converted = convertContent(content, 'skill', { source: 'bundled' })
  const body = stripFrontmatter(converted)

  return `<skill-instruction>
Base directory for this skill: ${skillDir}/
File references (@path) in this skill are relative to this directory.

${body.trim()}
</skill-instruction>`
}

export interface SkillToolOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const { bundledSkillsDir, disabledSkills } = options

  const getSystematicSkills = (): SkillInfo[] => {
    return findSkillsInDir(bundledSkillsDir)
      .filter((s) => !disabledSkills.includes(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const buildDescription = (): string => {
    const skills = getSystematicSkills()
    const systematicXml = formatSkillsXml(skills)

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
          "The skill identifier from available_skills (e.g., 'systematic:brainstorming')"
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
        try {
          const content = fs.readFileSync(matchedSkill.skillFile, 'utf8')
          const wrapped = wrapSkillContent(matchedSkill.skillFile, content)

          return `## Skill: systematic:${matchedSkill.name}

**Base directory**: ${matchedSkill.path}

${wrapped}`
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          throw new Error(
            `Failed to load skill "${requestedName}": ${errorMessage}`
          )
        }
      }

      const availableSystematic = skills.map((s) => `systematic:${s.name}`)
      throw new Error(
        `Skill "${requestedName}" not found. Available systematic skills: ${availableSystematic.join(', ')}`
      )
    },
  })
}
