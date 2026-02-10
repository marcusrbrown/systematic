import { parseFrontmatter } from './frontmatter.js'
import {
  extractBoolean,
  extractNonEmptyString,
  extractNumber,
  extractString,
  isAgentMode,
  isToolsMap,
  normalizePermission,
  type PermissionConfig,
} from './validation.js'
import { walkDir } from './walk-dir.js'

export interface AgentFrontmatter {
  /** Name of the agent */
  name: string
  /** Description of the agent's purpose */
  description: string
  /** The system prompt for the agent */
  prompt: string
  /** Model to use (provider/model format) */
  model?: string
  /** Temperature for generation */
  temperature?: number
  /** Top-p sampling */
  top_p?: number
  /** Tool whitelist/blacklist */
  tools?: Record<string, boolean>
  /** Disable this agent */
  disable?: boolean
  /** Agent mode */
  mode?: 'subagent' | 'primary' | 'all'
  /** Hex color code */
  color?: string
  /** Max agentic iterations */
  steps?: number
  /** Whether this agent is hidden from model invocation */
  hidden?: boolean
  /** Permission settings */
  permission?: PermissionConfig
}

export interface AgentInfo {
  name: string
  file: string
  category?: string
}

export function findAgentsInDir(dir: string, maxDepth = 2): AgentInfo[] {
  const entries = walkDir(dir, {
    maxDepth,
    filter: (e) => !e.isDirectory && e.name.endsWith('.md'),
  })

  return entries.map((entry) => ({
    name: entry.name.replace(/\.md$/, ''),
    file: entry.path,
    category: entry.category,
  }))
}

export function extractAgentFrontmatter(content: string): AgentFrontmatter {
  const { data, parseError, body } =
    parseFrontmatter<Record<string, unknown>>(content)

  if (parseError) {
    return { name: '', description: '', prompt: body.trim() }
  }

  return {
    name: extractString(data, 'name'),
    description: extractString(data, 'description'),
    prompt: body.trim(),
    model: extractNonEmptyString(data, 'model'),
    temperature: extractNumber(data, 'temperature'),
    top_p: extractNumber(data, 'top_p'),
    tools: isToolsMap(data.tools) ? data.tools : undefined,
    disable: extractBoolean(data, 'disable'),
    mode: isAgentMode(data.mode) ? data.mode : undefined,
    color: extractNonEmptyString(data, 'color'),
    steps: extractNumber(data, 'steps'),
    hidden: extractBoolean(data, 'hidden') ?? undefined,
    permission: normalizePermission(data.permission),
  }
}
