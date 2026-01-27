import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { convertContent } from './converter.js'
import type { SkillInfo } from './skills-core.js'
import { findSkillsInDir, stripFrontmatter } from './skills-core.js'

const HOOK_KEY = 'systematic_skill_tool_hooked'
const SYSTEMATIC_MARKER = '__systematic_skill_tool__'

interface HookState {
  hookedTool: ToolDefinition | null
  hookedDescription: string | null
  initialized: boolean
}

const globalStore = globalThis as unknown as Record<string, HookState | undefined>

function getHookState(): HookState {
  let state = globalStore[HOOK_KEY]
  if (state == null) {
    state = {
      hookedTool: null,
      hookedDescription: null,
      initialized: false,
    }
    globalStore[HOOK_KEY] = state
  }
  return state
}

export function isAlreadyHooked(): boolean {
  const state = globalStore[HOOK_KEY]
  return state != null && state.initialized
}

export function setHookedTool(hookedTool: ToolDefinition | null): void {
  const state = getHookState()
  state.hookedTool = hookedTool
  state.initialized = true
  if (hookedTool != null) {
    state.hookedDescription =
      typeof hookedTool.description === 'string' ? hookedTool.description : null
  } else {
    state.hookedDescription = null
  }
}

export function getHookedTool(): ToolDefinition | null {
  return getHookState().hookedTool
}

export function resetHookState(): void {
  delete globalStore[HOOK_KEY]
}

function formatSkillsXml(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''

  const skillsXml = skills
    .map((skill) => {
      const lines = [
        '  <skill>',
        `    <name>systematic:${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
      ]
      lines.push('  </skill>')
      return lines.join('\n')
    })
    .join('\n')

  return `<available_skills>\n${skillsXml}\n</available_skills>`
}

function mergeDescriptions(
  baseDescription: string,
  hookedDescription: string | null,
  systematicSkillsXml: string
): string {
  if (hookedDescription == null || hookedDescription.trim() === '') {
    return `${baseDescription}\n\n${systematicSkillsXml}`
  }

  const availableSkillsMatch = hookedDescription.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/
  )

  if (availableSkillsMatch) {
    const existingSkillsContent = availableSkillsMatch[1]
    const systematicSkillsContent = systematicSkillsXml
      .replace('<available_skills>', '')
      .replace('</available_skills>', '')
      .trim()

    const mergedContent = `<available_skills>\n${systematicSkillsContent}\n${existingSkillsContent}</available_skills>`
    return hookedDescription.replace(
      /<available_skills>[\s\S]*?<\/available_skills>/,
      mergedContent
    )
  }

  return `${hookedDescription}\n\n${systematicSkillsXml}`
}

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
    return findSkillsInDir(bundledSkillsDir, 'bundled', 3)
      .filter((s) => !disabledSkills.includes(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const buildDescription = (): string => {
    const skills = getSystematicSkills()
    const systematicXml = formatSkillsXml(skills)

    const baseDescription = `Load a skill to get detailed instructions for a specific task.

Skills provide specialized knowledge and step-by-step guidance.
Use this when a task matches an available skill's description.`

    const hookState = getHookState()
    return mergeDescriptions(
      baseDescription,
      hookState.hookedDescription,
      systematicXml
    )
  }

  let cachedDescription: string | null = null

  const toolDef = tool({
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

      const hookedTool = getHookedTool()
      if (hookedTool != null && typeof hookedTool.execute === 'function') {
        try {
          return await (hookedTool.execute as (args: { name: string }) => Promise<string>)(args)
        } catch {
          // Fallback failed, continue to error below
        }
      }

      const availableSystematic = skills.map((s) => `systematic:${s.name}`)
      throw new Error(
        `Skill "${requestedName}" not found. Available systematic skills: ${availableSystematic.join(', ')}`
      )
    },
  })

  Object.defineProperty(toolDef, SYSTEMATIC_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
  })

  return toolDef
}
