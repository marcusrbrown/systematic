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

export interface SkillDeprecated {
  since: string
  removal: string
  replacement?: string
  reason?: string
}

export interface SkillFrontmatter {
  name: string
  description: string
  // OpenCode SDK fields
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  deprecated?: SkillDeprecated
  // Claude Code converted fields
  disableModelInvocation?: boolean // from YAML key: disable-model-invocation
  userInvocable?: boolean // from YAML key: user-invocable
  subtask?: boolean // from YAML key: subtask, or derived from context: "fork"
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
  deprecated?: SkillDeprecated
  // Claude Code converted fields
  disableModelInvocation?: boolean
  userInvocable?: boolean
  subtask?: boolean
  agent?: string
  model?: string
  argumentHint?: string
  allowedTools?: string
}

export const SKILL_FRONTMATTER_FIELDS = [
  'name',
  'description',
  'argument-hint',
  'disable-model-invocation',
  'allowed-tools',
  'license',
  'compatibility',
  'metadata',
  'deprecated',
  'user-invocable',
  'agent',
  'model',
  'context',
  'subtask',
] as const

function parseMetadata(
  data: Record<string, unknown>,
): Record<string, string> | undefined {
  const metadataRaw = data.metadata
  if (!isRecord(metadataRaw)) {
    return undefined
  }
  const entries = Object.entries(metadataRaw)
  if (!entries.every(([, v]) => typeof v === 'string')) {
    return undefined
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function parseDeprecated(
  data: Record<string, unknown>,
): SkillDeprecated | undefined {
  const deprecatedRaw = data.deprecated
  if (!isRecord(deprecatedRaw)) {
    return undefined
  }

  const since =
    typeof deprecatedRaw.since === 'string' && deprecatedRaw.since !== ''
      ? deprecatedRaw.since
      : undefined
  const removal =
    typeof deprecatedRaw.removal === 'string' && deprecatedRaw.removal !== ''
      ? deprecatedRaw.removal
      : undefined
  if (since === undefined || removal === undefined) {
    return undefined
  }

  const deprecated: SkillDeprecated = { since, removal }
  if (typeof deprecatedRaw.replacement === 'string') {
    deprecated.replacement = deprecatedRaw.replacement
  }
  if (typeof deprecatedRaw.reason === 'string') {
    deprecated.reason = deprecatedRaw.reason
  }
  return deprecated
}

/**
 * Parse skill frontmatter from already-read file content. Split out from
 * `extractFrontmatter` so callers that also need the body (e.g. discovered-skill
 * command emission) can read the file once and derive both. Never throws.
 */
export function extractFrontmatterFromContent(
  content: string,
): SkillFrontmatter {
  const { data, parseError } =
    parseFrontmatter<Record<string, unknown>>(content)

  if (parseError) {
    return { name: '', description: '' }
  }

  const metadata = parseMetadata(data)
  const deprecated = parseDeprecated(data)

  const argumentHintRaw = extractNonEmptyString(data, 'argument-hint')
  const argumentHint = argumentHintRaw?.replace(/^["']|["']$/g, '') || undefined

  return {
    name: extractString(data, 'name'),
    description: extractString(data, 'description'),
    license: extractNonEmptyString(data, 'license'),
    compatibility: extractNonEmptyString(data, 'compatibility'),
    metadata,
    deprecated,
    disableModelInvocation: extractBoolean(data, 'disable-model-invocation'),
    userInvocable: extractBoolean(data, 'user-invocable'),
    subtask:
      data.context === 'fork'
        ? true
        : (extractBoolean(data, 'subtask') ?? undefined),
    agent: extractNonEmptyString(data, 'agent'),
    model: extractNonEmptyString(data, 'model'),
    argumentHint: argumentHint !== '' ? argumentHint : undefined,
    allowedTools: extractNonEmptyString(data, 'allowed-tools'),
  }
}

export function extractFrontmatter(filePath: string): SkillFrontmatter {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return extractFrontmatterFromContent(content)
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
        deprecated: frontmatter.deprecated,
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
