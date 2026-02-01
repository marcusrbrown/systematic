import fs from 'node:fs'
import { formatFrontmatter, parseFrontmatter } from './frontmatter.js'
import {
  type AgentMode,
  isAgentMode,
  isToolsMap,
  normalizePermission,
} from './validation.js'

export type ContentType = 'skill' | 'agent' | 'command'
export type SourceType = 'bundled' | 'external'

export interface ConvertOptions {
  source?: SourceType
  agentMode?: AgentMode
  /** Skip body content transformations (tool names, paths, etc.) */
  skipBodyTransform?: boolean
}

interface CacheEntry {
  mtimeMs: number
  converted: string
}

const cache = new Map<string, CacheEntry>()

/**
 * Claude Code tool names mapped to OpenCode equivalents.
 * Only includes tools that need transformation (case changes or renames).
 *
 * Task transformation strategy:
 * - Match Task followed by parentheses or agent-name pattern (tool invocation)
 * - Match "Task tool" explicitly
 * - Avoid standalone "Task" as noun (e.g., "Complete the Task")
 */
const TOOL_MAPPINGS: ReadonlyArray<readonly [RegExp, string]> = [
  // Semantic tool renames (different names in OC)
  // Task tool explicit reference
  [/\bTask\s+tool\b/gi, 'delegate_task tool'],
  // Task followed by agent name + colon: Task agent-name: "prompt"
  [/\bTask\s+([\w-]+)\s*:/g, 'delegate_task $1:'],
  // Task followed by agent name + parens: Task agent-name(args)
  [/\bTask\s+([\w-]+)\s*\(/g, 'delegate_task $1('],
  // Task with immediate parens: Task(args) or Task (args)
  [/\bTask\s*\(/g, 'delegate_task('],
  // Task followed by "to" verb pattern: use Task to spawn
  [/\bTask\b(?=\s+to\s+\w)/g, 'delegate_task'],
  [/\bTodoWrite\b/g, 'todowrite'],
  [/\bAskUserQuestion\b/g, 'question'],
  [/\bWebSearch\b/g, 'google_search'],
  // Case normalization (CC uses PascalCase, OC uses lowercase)
  [/\bRead\b(?=\s+tool|\s+to\s+|\()/g, 'read'],
  [/\bWrite\b(?=\s+tool|\s+to\s+|\()/g, 'write'],
  [/\bEdit\b(?=\s+tool|\s+to\s+|\()/g, 'edit'],
  [/\bBash\b(?=\s+tool|\s+to\s+|\()/g, 'bash'],
  [/\bGrep\b(?=\s+tool|\s+to\s+|\()/g, 'grep'],
  [/\bGlob\b(?=\s+tool|\s+to\s+|\()/g, 'glob'],
  [/\bWebFetch\b/g, 'webfetch'],
  // Skill tool invocation: Skill("name") or Skill tool reference
  [/\bSkill\b(?=\s+tool|\s*\()/g, 'skill'],
] as const

/**
 * Path and reference replacements for CC → OC migration.
 */
const PATH_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.claude\/skills\//g, '.opencode/skills/'],
  [/\.claude\/commands\//g, '.opencode/commands/'],
  [/\.claude\/agents\//g, '.opencode/agents/'],
  [/~\/\.claude\//g, '~/.config/opencode/'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/\/compound-engineering:/g, '/systematic:'],
  [/compound-engineering:/g, 'systematic:'],
] as const

/**
 * CC-only frontmatter fields that should be removed from skills.
 */
const CC_ONLY_SKILL_FIELDS = [
  'model',
  'allowed-tools',
  'allowedTools',
  'disable-model-invocation',
  'disableModelInvocation',
  'user-invocable',
  'userInvocable',
  'context',
  'agent',
] as const

/**
 * CC-only frontmatter fields that should be removed from commands.
 */
const CC_ONLY_COMMAND_FIELDS = ['argument-hint', 'argumentHint'] as const

function inferTemperature(name: string, description?: string): number {
  const sample = `${name} ${description ?? ''}`.toLowerCase()
  if (
    /(review|audit|security|sentinel|oracle|lint|verification|guardian)/.test(
      sample,
    )
  ) {
    return 0.1
  }
  if (
    /(plan|planning|architecture|strategist|analysis|research)/.test(sample)
  ) {
    return 0.2
  }
  if (/(doc|readme|changelog|editor|writer)/.test(sample)) {
    return 0.3
  }
  if (/(brainstorm|creative|ideate|design|concept)/.test(sample)) {
    return 0.6
  }
  return 0.3
}

const CODE_BLOCK_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g

function transformBody(body: string): string {
  const codeBlocks: string[] = []
  let placeholderIndex = 0

  const withPlaceholders = body.replace(CODE_BLOCK_PATTERN, (match) => {
    codeBlocks.push(match)
    return `__CODE_BLOCK_${placeholderIndex++}__`
  })

  let result = withPlaceholders

  for (const [pattern, replacement] of TOOL_MAPPINGS) {
    result = result.replace(pattern, replacement)
  }

  for (const [pattern, replacement] of PATH_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }

  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i])
  }

  return result
}

function removeFields(
  data: Record<string, unknown>,
  fieldsToRemove: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!fieldsToRemove.includes(key)) {
      result[key] = value
    }
  }
  return result
}

function transformSkillFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return removeFields(data, CC_ONLY_SKILL_FIELDS)
}

function transformCommandFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = removeFields(data, CC_ONLY_COMMAND_FIELDS)

  if (typeof cleaned.model === 'string' && cleaned.model !== 'inherit') {
    cleaned.model = normalizeModel(cleaned.model)
  } else if (cleaned.model === 'inherit') {
    delete cleaned.model
  }

  return cleaned
}

function normalizeModel(model: string): string {
  if (model.includes('/')) return model
  if (model === 'inherit') return model
  if (/^claude-/.test(model)) return `anthropic/${model}`
  if (/^(gpt-|o1-|o3-)/.test(model)) return `openai/${model}`
  if (/^gemini-/.test(model)) return `google/${model}`
  return `anthropic/${model}`
}

function addOptionalFields(
  target: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  if (typeof data.top_p === 'number') target.top_p = data.top_p
  if (isToolsMap(data.tools)) target.tools = data.tools
  if (typeof data.disable === 'boolean') target.disable = data.disable
  if (typeof data.color === 'string') target.color = data.color
  if (typeof data.maxSteps === 'number') target.maxSteps = data.maxSteps

  const permission = normalizePermission(data.permission)
  if (permission) target.permission = permission
}

function transformAgentFrontmatter(
  data: Record<string, unknown>,
  agentMode: AgentMode,
): Record<string, unknown> {
  const name = typeof data.name === 'string' ? data.name : ''
  const description =
    typeof data.description === 'string' ? data.description : ''

  const mode = isAgentMode(data.mode) ? data.mode : agentMode

  const newData: Record<string, unknown> = { mode }
  if (description) {
    newData.description = description
  } else if (name) {
    newData.description = `${name} agent`
  }

  if (typeof data.model === 'string' && data.model !== 'inherit') {
    newData.model = normalizeModel(data.model)
  }

  newData.temperature =
    typeof data.temperature === 'number'
      ? data.temperature
      : inferTemperature(name, description)

  addOptionalFields(newData, data)

  return newData
}

export function convertContent(
  content: string,
  type: ContentType,
  options: ConvertOptions = {},
): string {
  if (content === '') return ''

  const { data, body, hadFrontmatter, parseError } =
    parseFrontmatter<Record<string, unknown>>(content)

  if (!hadFrontmatter) {
    return options.skipBodyTransform ? content : transformBody(content)
  }

  if (parseError) {
    return content
  }

  const shouldTransformBody = !options.skipBodyTransform
  const transformedBody = shouldTransformBody ? transformBody(body) : body

  if (type === 'agent') {
    const agentMode = options.agentMode ?? 'subagent'
    const transformedData = transformAgentFrontmatter(data, agentMode)
    return `${formatFrontmatter(transformedData)}\n${transformedBody}`
  }

  if (type === 'skill') {
    const transformedData = transformSkillFrontmatter(data)
    return `${formatFrontmatter(transformedData)}\n${transformedBody}`
  }

  if (type === 'command') {
    const transformedData = transformCommandFrontmatter(data)
    return `${formatFrontmatter(transformedData)}\n${transformedBody}`
  }

  return content
}

export function convertFileWithCache(
  filePath: string,
  type: ContentType,
  options: ConvertOptions = {},
): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stats = fs.fstatSync(fd)
    const cacheKey = `${filePath}:${type}:${options.source ?? 'bundled'}:${options.agentMode ?? 'subagent'}:${options.skipBodyTransform ?? false}`
    const cached = cache.get(cacheKey)

    if (cached != null && cached.mtimeMs === stats.mtimeMs) {
      return cached.converted
    }

    const content = fs.readFileSync(fd, 'utf8')
    const converted = convertContent(content, type, options)

    cache.set(cacheKey, { mtimeMs: stats.mtimeMs, converted })
    return converted
  } finally {
    fs.closeSync(fd)
  }
}

export function clearConverterCache(): void {
  cache.clear()
}
