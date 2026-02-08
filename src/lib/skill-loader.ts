import path from 'node:path'
import { convertFileWithCache } from './converter.js'
import { parseFrontmatter } from './frontmatter.js'
import type { SkillInfo } from './skills.js'

const SKILL_PREFIX = 'systematic:'
const SKILL_DESCRIPTION_PREFIX = '(Systematic - Skill) '

export interface LoadedSkill {
  name: string
  prefixedName: string
  description: string
  path: string
  skillFile: string
  wrappedTemplate: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  subtask?: boolean
  agent?: string
  model?: string
  argumentHint?: string
}

export function formatSkillCommandName(name: string): string {
  if (name.startsWith(SKILL_PREFIX)) {
    return name
  }
  return `${SKILL_PREFIX}${name}`
}

export function formatSkillDescription(
  description: string,
  fallbackName: string,
): string {
  const desc = description || `${fallbackName} skill`
  if (desc.startsWith(SKILL_DESCRIPTION_PREFIX)) {
    return desc
  }
  return `${SKILL_DESCRIPTION_PREFIX}${desc}`
}

export function wrapSkillTemplate(skillPath: string, body: string): string {
  const skillDir = path.dirname(skillPath)
  return `<skill-instruction>
Base directory for this skill: ${skillDir}/
File references (@path) in this skill are relative to this directory.

${body.trim()}
</skill-instruction>

<user-request>
$ARGUMENTS
</user-request>`
}

export function extractSkillBody(wrappedTemplate: string): string {
  const match = wrappedTemplate.match(
    /<skill-instruction>([\s\S]*?)<\/skill-instruction>/,
  )
  return match ? match[1].trim() : wrappedTemplate
}

export function loadSkill(skillInfo: SkillInfo): LoadedSkill | null {
  try {
    const converted = convertFileWithCache(skillInfo.skillFile, 'skill', {
      source: 'bundled',
    })
    const { body } = parseFrontmatter(converted)
    const wrappedTemplate = wrapSkillTemplate(skillInfo.skillFile, body)

    return {
      name: skillInfo.name,
      prefixedName: formatSkillCommandName(skillInfo.name),
      description: formatSkillDescription(
        skillInfo.description,
        skillInfo.name,
      ),
      path: skillInfo.path,
      skillFile: skillInfo.skillFile,
      wrappedTemplate,
      disableModelInvocation: skillInfo.disableModelInvocation,
      userInvocable: skillInfo.userInvocable,
      subtask: skillInfo.subtask,
      agent: skillInfo.agent,
      model: skillInfo.model,
      argumentHint: skillInfo.argumentHint,
    }
  } catch {
    return null
  }
}
