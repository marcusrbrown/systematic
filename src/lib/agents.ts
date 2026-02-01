import { parseFrontmatter } from './frontmatter.js'
import {
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
  maxSteps?: number
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

function extractString(
  data: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = data[key]
  return typeof value === 'string' ? value : fallback
}

function extractNumber(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key]
  return typeof value === 'number' ? value : undefined
}

function extractBoolean(
  data: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = data[key]
  return typeof value === 'boolean' ? value : undefined
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
    model: extractString(data, 'model') || undefined,
    temperature: extractNumber(data, 'temperature'),
    top_p: extractNumber(data, 'top_p'),
    tools: isToolsMap(data.tools) ? data.tools : undefined,
    disable: extractBoolean(data, 'disable'),
    mode: isAgentMode(data.mode) ? data.mode : undefined,
    color: extractString(data, 'color') || undefined,
    maxSteps: extractNumber(data, 'maxSteps'),
    permission: normalizePermission(data.permission),
  }
}
