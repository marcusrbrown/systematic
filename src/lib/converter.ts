import fs from 'node:fs'
import path from 'node:path'

export type ConvertType = 'skill' | 'agent' | 'command'

export interface ConvertOptions {
  dryRun?: boolean
  output?: string
}

export interface ConvertResult {
  type: ConvertType
  sourcePath: string
  outputPath: string
  converted: boolean
  files: string[]
}

interface FrontmatterData {
  description?: string
  mode?: string
  model?: string
  temperature?: number
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: raw }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return { data: {}, body: raw }
  }

  const yamlLines = lines.slice(1, endIndex)
  const body = lines.slice(endIndex + 1).join('\n')
  const data: Record<string, unknown> = {}

  for (const line of yamlLines) {
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (match) {
      const [, key, value] = match
      if (value === 'true') data[key] = true
      else if (value === 'false') data[key] = false
      else if (/^\d+(\.\d+)?$/.test(value)) data[key] = parseFloat(value)
      else data[key] = value
    }
  }

  return { data, body }
}

function formatFrontmatter(data: FrontmatterData, body: string): string {
  const lines: string[] = []
  if (data.description) lines.push(`description: ${data.description}`)
  if (data.mode) lines.push(`mode: ${data.mode}`)
  if (data.model) lines.push(`model: ${data.model}`)
  if (data.temperature !== undefined) lines.push(`temperature: ${data.temperature}`)

  if (lines.length === 0) return body

  return ['---', ...lines, '---', '', body].join('\n')
}

function inferTemperature(name: string, description?: string): number {
  const sample = `${name} ${description || ''}`.toLowerCase()
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
  if (/^claude-/.test(model)) return `anthropic/${model}`
  if (/^(gpt-|o1-|o3-)/.test(model)) return `openai/${model}`
  if (/^gemini-/.test(model)) return `google/${model}`
  return `anthropic/${model}`
}

export function convertAgent(sourcePath: string, options: ConvertOptions = {}): ConvertResult {
  const content = fs.readFileSync(sourcePath, 'utf-8')
  const name = path.basename(sourcePath, '.md')
  const { data, body } = parseFrontmatter(content)

  const existingDescription = data.description as string | undefined
  const existingModel = data.model as string | undefined

  let description = existingDescription
  if (!description) {
    const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'))
    description = firstLine?.slice(0, 100) || `${name} agent`
  }

  const frontmatter: FrontmatterData = {
    description,
    mode: 'subagent',
    temperature: inferTemperature(name, description),
  }

  if (existingModel && existingModel !== 'inherit') {
    frontmatter.model = normalizeModel(existingModel)
  }

  const converted = formatFrontmatter(frontmatter, body.trim())
  const outputPath = options.output || sourcePath

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, converted)
  }

  return {
    type: 'agent',
    sourcePath,
    outputPath,
    converted: true,
    files: [path.basename(outputPath)],
  }
}

export function convertCommand(sourcePath: string, options: ConvertOptions = {}): ConvertResult {
  const content = fs.readFileSync(sourcePath, 'utf-8')
  const outputPath = options.output || sourcePath

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, content)
  }

  return {
    type: 'command',
    sourcePath,
    outputPath,
    converted: true,
    files: [path.basename(outputPath)],
  }
}

export function convertSkill(sourcePath: string, options: ConvertOptions = {}): ConvertResult {
  const stats = fs.statSync(sourcePath)
  if (!stats.isDirectory()) {
    throw new Error(`Skill source must be a directory: ${sourcePath}`)
  }

  const skillName = path.basename(sourcePath)
  const outputPath = options.output || sourcePath
  const files: string[] = []

  function copyDir(src: string, dest: string): void {
    if (!options.dryRun) {
      fs.mkdirSync(dest, { recursive: true })
    }

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        copyDir(srcPath, destPath)
      } else {
        files.push(path.relative(outputPath, destPath))
        if (!options.dryRun) {
          fs.copyFileSync(srcPath, destPath)
        }
      }
    }
  }

  copyDir(sourcePath, outputPath)

  return {
    type: 'skill',
    sourcePath,
    outputPath,
    converted: true,
    files,
  }
}

export function convert(
  type: ConvertType,
  sourcePath: string,
  options: ConvertOptions = {},
): ConvertResult {
  switch (type) {
    case 'agent':
      return convertAgent(sourcePath, options)
    case 'command':
      return convertCommand(sourcePath, options)
    case 'skill':
      return convertSkill(sourcePath, options)
    default:
      throw new Error(`Unknown type: ${type}`)
  }
}

export function detectType(sourcePath: string): ConvertType | null {
  const stats = fs.statSync(sourcePath)

  if (stats.isDirectory()) {
    if (fs.existsSync(path.join(sourcePath, 'SKILL.md'))) {
      return 'skill'
    }
    return null
  }

  if (!sourcePath.endsWith('.md')) return null

  const parentDir = path.basename(path.dirname(sourcePath))
  if (parentDir === 'agents' || ['review', 'research', 'design', 'docs', 'workflow'].includes(parentDir)) {
    return 'agent'
  }
  if (parentDir === 'commands' || parentDir === 'workflows') {
    return 'command'
  }

  return null
}
