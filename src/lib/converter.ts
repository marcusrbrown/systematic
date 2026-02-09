import fs from 'node:fs'
import { formatFrontmatter, parseFrontmatter } from './frontmatter.js'
import {
  type AgentMode,
  isAgentMode,
  isToolsMap,
  normalizePermission,
  type PermissionConfig,
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

// Bump when mapping logic changes to invalidate cached conversions
const CONVERTER_VERSION = 2

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
 * Tool name mapping for frontmatter `tools` arrays.
 * Derived from TOOL_MAPPINGS to ensure frontmatter tool keys match OC tool IDs.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  task: 'delegate_task',
  todowrite: 'todowrite',
  askuserquestion: 'question',
  websearch: 'google_search',
  webfetch: 'webfetch',
  skill: 'skill',
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  glob: 'glob',
}

/**
 * CC permissionMode values mapped to OC permission equivalents.
 * Security-sensitive: unknown modes default to most restrictive usable default.
 */
const PERMISSION_MODE_MAP: Record<string, PermissionConfig> = {
  full: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
  },
  default: {
    edit: 'ask',
    bash: 'ask',
    webfetch: 'ask',
  },
  plan: {
    edit: 'deny',
    bash: 'deny',
    webfetch: 'ask',
  },
  bypassPermissions: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
  },
}

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

function normalizeModel(model: string): string {
  if (model.includes('/')) return model
  if (model === 'inherit') return model
  if (/^claude-/.test(model)) return `anthropic/${model}`
  if (/^(gpt-|o1-|o3-)/.test(model)) return `openai/${model}`
  if (/^gemini-/.test(model)) return `google/${model}`
  return `anthropic/${model}`
}

function canonicalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase()
  return TOOL_NAME_MAP[lower] ?? lower
}

function isValidSteps(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  )
}

/**
 * Map CC maxTurns/maxSteps to OC steps.
 * Precedence: steps (kept if valid) > min(maxTurns, maxSteps).
 * Invalid values are preserved as-is without mapping.
 */
function mapStepsField(data: Record<string, unknown>): void {
  if (data.steps !== undefined) {
    if (isValidSteps(data.steps)) {
      delete data.maxTurns
      delete data.maxSteps
    }
    return
  }

  const candidates: number[] = []
  if (isValidSteps(data.maxTurns)) candidates.push(data.maxTurns)
  if (isValidSteps(data.maxSteps)) candidates.push(data.maxSteps)

  if (candidates.length > 0) {
    data.steps = Math.min(...candidates)
    delete data.maxTurns
    delete data.maxSteps
  }
}

/**
 * Map CC tools array to OC tools map.
 * If tools is already a valid map, merges disallowedTools. If it's an object
 * but not all-boolean, preserves as-is.
 */
function mapToolsField(data: Record<string, unknown>): void {
  if (data.tools !== undefined && !Array.isArray(data.tools)) {
    if (isToolsMap(data.tools)) {
      mergeDisallowedTools(data)
    }
    return
  }

  if (Array.isArray(data.tools)) {
    const toolsMap: Record<string, boolean> = {}
    for (const tool of data.tools) {
      if (typeof tool === 'string') {
        toolsMap[canonicalizeToolName(tool)] = true
      }
    }
    if (Object.keys(toolsMap).length > 0) {
      data.tools = toolsMap
    } else {
      delete data.tools
    }
  }

  mergeDisallowedTools(data)
}

function mergeDisallowedTools(data: Record<string, unknown>): void {
  if (!Array.isArray(data.disallowedTools)) return

  const existing: Record<string, boolean> = isToolsMap(data.tools)
    ? (data.tools as Record<string, boolean>)
    : {}

  for (const tool of data.disallowedTools) {
    if (typeof tool === 'string') {
      existing[canonicalizeToolName(tool)] = false
    }
  }

  if (Object.keys(existing).length > 0) {
    data.tools = existing
  }

  delete data.disallowedTools
}

/**
 * Map CC permissionMode to OC permission.
 * Prefers existing valid permission; falls back to permissionMode mapping.
 * Unknown modes default to ask — most restrictive usable default (security).
 */
function mapPermissionMode(data: Record<string, unknown>): void {
  if (data.permission !== undefined) {
    const normalized = normalizePermission(data.permission)
    if (normalized) {
      data.permission = normalized
      delete data.permissionMode
      return
    }
  }

  if (typeof data.permissionMode !== 'string') return

  const mapped = PERMISSION_MODE_MAP[data.permissionMode]
  data.permission = mapped ?? { edit: 'ask', bash: 'ask', webfetch: 'ask' }
  delete data.permissionMode
}

function mapHiddenField(data: Record<string, unknown>): void {
  if (
    data['disable-model-invocation'] === true ||
    data.disableModelInvocation === true
  ) {
    data.hidden = true
    delete data['disable-model-invocation']
    delete data.disableModelInvocation
  }
}

function normalizeModelField(data: Record<string, unknown>): void {
  if (typeof data.model === 'string' && data.model !== 'inherit') {
    data.model = normalizeModel(data.model)
  } else if (data.model === 'inherit') {
    delete data.model
  }
}

function transformAgentFrontmatter(
  data: Record<string, unknown>,
  agentMode: AgentMode,
): Record<string, unknown> {
  const result = { ...data }

  result.mode = isAgentMode(data.mode) ? data.mode : agentMode

  const name = typeof data.name === 'string' ? data.name : ''
  const description =
    typeof data.description === 'string' ? data.description : ''
  if (description) {
    result.description = description
  } else if (name) {
    result.description = `${name} agent`
  }

  normalizeModelField(result)

  result.temperature =
    typeof data.temperature === 'number'
      ? data.temperature
      : inferTemperature(name, description)

  mapStepsField(result)
  mapToolsField(result)
  mapPermissionMode(result)
  mapHiddenField(result)

  return result
}

function transformSkillFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data }

  normalizeModelField(result)

  if (result.context === 'fork') {
    result.subtask = true
  }

  return result
}

function transformCommandFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data }

  normalizeModelField(result)

  return result
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
    return options.skipBodyTransform ? content : transformBody(content)
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
    const cacheKey = `${CONVERTER_VERSION}:${filePath}:${type}:${options.source ?? 'bundled'}:${options.agentMode ?? 'subagent'}:${options.skipBodyTransform ?? false}`
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
