import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import {
  extractBoolean,
  extractNonEmptyString,
  extractString,
  isRecord,
} from './validation.js'
import { walkDir } from './walk-dir.js'

export interface SkillFrontmatter {
  name: string
  description: string
  // OpenCode SDK fields
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  // Claude Code converted fields
  disableModelInvocation?: boolean // from YAML key: disable-model-invocation
  userInvocable?: boolean // from YAML key: user-invocable
  subtask?: boolean // derived from context: "fork"
  agent?: string // from YAML key: agent
  model?: string // from YAML key: model
  argumentHint?: string // from YAML key: argument-hint
  allowedTools?: string // from YAML key: allowed-tools
}

export interface SkillInfo {
  path: string
  skillFile: string
  name: string
  description: string
  // OpenCode SDK fields
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  // Claude Code converted fields
  disableModelInvocation?: boolean
  userInvocable?: boolean
  subtask?: boolean
  agent?: string
  model?: string
  argumentHint?: string
  allowedTools?: string
}

export function extractFrontmatter(filePath: string): SkillFrontmatter {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const { data, parseError } =
      parseFrontmatter<Record<string, unknown>>(content)

    if (parseError) {
      return { name: '', description: '' }
    }

    const metadataRaw = data.metadata
    let metadata: Record<string, string> | undefined
    if (isRecord(metadataRaw)) {
      const entries = Object.entries(metadataRaw)
      if (entries.every(([, v]) => typeof v === 'string')) {
        metadata = Object.fromEntries(entries) as Record<string, string>
      }
    }

    const argumentHintRaw = extractNonEmptyString(data, 'argument-hint')
    const argumentHint =
      argumentHintRaw?.replace(/^["']|["']$/g, '') || undefined

    return {
      name: extractString(data, 'name'),
      description: extractString(data, 'description'),
      license: extractNonEmptyString(data, 'license'),
      compatibility: extractNonEmptyString(data, 'compatibility'),
      metadata,
      disableModelInvocation: extractBoolean(data, 'disable-model-invocation'),
      userInvocable: extractBoolean(data, 'user-invocable'),
      subtask: data.context === 'fork' ? true : undefined,
      agent: extractNonEmptyString(data, 'agent'),
      model: extractNonEmptyString(data, 'model'),
      argumentHint: argumentHint !== '' ? argumentHint : undefined,
      allowedTools: extractNonEmptyString(data, 'allowed-tools'),
    }
  } catch {
    return { name: '', description: '' }
  }
}

export function findSkillsInDir(dir: string, maxDepth = 3): SkillInfo[] {
  const skills: SkillInfo[] = []

  const entries = walkDir(dir, {
    maxDepth,
    filter: (e) => e.isDirectory,
  })

  for (const entry of entries) {
    const skillFile = path.join(entry.path, 'SKILL.md')
    if (fs.existsSync(skillFile)) {
      const frontmatter = extractFrontmatter(skillFile)
      skills.push({
        path: entry.path,
        skillFile,
        name: frontmatter.name || entry.name,
        description: frontmatter.description || '',
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
        disableModelInvocation: frontmatter.disableModelInvocation,
        userInvocable: frontmatter.userInvocable,
        subtask: frontmatter.subtask,
        agent: frontmatter.agent,
        model: frontmatter.model,
        argumentHint: frontmatter.argumentHint,
        allowedTools: frontmatter.allowedTools,
      })
    }
  }

  return skills
}
