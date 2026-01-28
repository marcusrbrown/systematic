import fs from 'node:fs'
import { formatFrontmatter, parseFrontmatter } from './frontmatter.js'

export type ContentType = 'skill' | 'agent' | 'command'
export type SourceType = 'bundled' | 'external'
export type AgentMode = 'primary' | 'subagent'

export interface ConvertOptions {
  source?: SourceType
  agentMode?: AgentMode
}

interface CacheEntry {
  mtimeMs: number
  converted: string
}

const cache = new Map<string, CacheEntry>()

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

function normalizeModel(model: string): string {
  if (model.includes('/')) return model
  if (model === 'inherit') return model
  if (/^claude-/.test(model)) return `anthropic/${model}`
  if (/^(gpt-|o1-|o3-)/.test(model)) return `openai/${model}`
  if (/^gemini-/.test(model)) return `google/${model}`
  return `anthropic/${model}`
}

function transformAgentFrontmatter(
  data: Record<string, string | number | boolean>,
  agentMode: AgentMode,
): Record<string, string | number | boolean> {
  const name = typeof data.name === 'string' ? data.name : ''
  const description =
    typeof data.description === 'string' ? data.description : ''

  const newData: Record<string, string | number | boolean> = {
    description: description || `${name} agent`,
    mode: agentMode,
  }

  if (typeof data.model === 'string' && data.model !== 'inherit') {
    newData.model = normalizeModel(data.model)
  }

  if (typeof data.temperature === 'number') {
    newData.temperature = data.temperature
  } else {
    newData.temperature = inferTemperature(name, description)
  }

  return newData
}

export function convertContent(
  content: string,
  type: ContentType,
  options: ConvertOptions = {},
): string {
  if (content === '') return ''

  const { data, body, hadFrontmatter } =
    parseFrontmatter<Record<string, string | number | boolean>>(content)

  if (!hadFrontmatter) {
    return content
  }

  if (type === 'agent') {
    const agentMode = options.agentMode ?? 'subagent'
    const transformedData = transformAgentFrontmatter(data, agentMode)
    return `${formatFrontmatter(transformedData)}\n${body}`
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
    const cacheKey = `${filePath}:${type}:${options.source ?? 'bundled'}:${options.agentMode ?? 'subagent'}`
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
