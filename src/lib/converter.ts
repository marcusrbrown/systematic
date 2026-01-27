import fs from 'node:fs'

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

interface ParsedFrontmatter {
  data: Record<string, string | number | boolean>
  body: string
  raw: string
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: content, raw: '' }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return { data: {}, body: content, raw: '' }
  }

  const yamlLines = lines.slice(1, endIndex)
  const body = lines.slice(endIndex + 1).join('\n')
  const raw = lines.slice(0, endIndex + 1).join('\n')
  const data: Record<string, string | number | boolean> = {}

  for (const line of yamlLines) {
    const match = line.match(/^([\w-]+):\s*(.*)$/)
    if (match) {
      const [, key, value] = match
      if (value === 'true') data[key] = true
      else if (value === 'false') data[key] = false
      else if (/^\d+(\.\d+)?$/.test(value)) data[key] = parseFloat(value)
      else data[key] = value
    }
  }

  return { data, body, raw }
}

function formatFrontmatter(data: Record<string, string | number | boolean>): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push('---')
  return lines.join('\n')
}

function inferTemperature(name: string, description?: string): number {
  const sample = `${name} ${description ?? ''}`.toLowerCase()
  if (/(review|audit|security|sentinel|oracle|lint|verification|guardian)/.test(sample)) {
    return 0.1
  }
  if (/(plan|planning|architecture|strategist|analysis|research)/.test(sample)) {
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
  agentMode: AgentMode
): Record<string, string | number | boolean> {
  const name = typeof data.name === 'string' ? data.name : ''
  const description = typeof data.description === 'string' ? data.description : ''

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
  options: ConvertOptions = {}
): string {
  if (content === '') return ''

  const { data, body, raw } = parseFrontmatter(content)
  const hasFrontmatter = raw !== ''

  if (!hasFrontmatter) {
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
  options: ConvertOptions = {}
): string {
  const stats = fs.statSync(filePath)
  const cacheKey = `${filePath}:${type}:${options.source ?? 'bundled'}:${options.agentMode ?? 'subagent'}`
  const cached = cache.get(cacheKey)

  if (cached != null && cached.mtimeMs === stats.mtimeMs) {
    return cached.converted
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const converted = convertContent(content, type, options)

  cache.set(cacheKey, { mtimeMs: stats.mtimeMs, converted })
  return converted
}

export function clearConverterCache(): void {
  cache.clear()
}
