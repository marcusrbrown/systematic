import { parseFrontmatter } from './frontmatter.js'
import {
  extractBoolean,
  extractNonEmptyString,
  extractString,
} from './validation.js'
import { walkDir } from './walk-dir.js'

export interface CommandFrontmatter {
  name: string
  description: string
  argumentHint: string
  /** Agent ID to use for this command */
  agent?: string
  /** Model override for this command */
  model?: string
  /** Whether this command should run as a subtask */
  subtask?: boolean
}

export interface CommandInfo {
  name: string
  file: string
  category?: string
}

export function findCommandsInDir(dir: string, maxDepth = 2): CommandInfo[] {
  const entries = walkDir(dir, {
    maxDepth,
    filter: (e) => !e.isDirectory && e.name.endsWith('.md'),
  })

  return entries.map((entry) => {
    const baseName = entry.name.replace(/\.md$/, '')
    const commandName = entry.category
      ? `/${entry.category}:${baseName}`
      : `/${baseName}`
    return {
      name: commandName,
      file: entry.path,
      category: entry.category,
    }
  })
}

export function extractCommandFrontmatter(content: string): CommandFrontmatter {
  const { data, parseError } =
    parseFrontmatter<Record<string, unknown>>(content)

  if (parseError) {
    return {
      name: '',
      description: '',
      argumentHint: '',
      agent: undefined,
      model: undefined,
      subtask: undefined,
    }
  }

  const argumentHintRaw = extractString(data, 'argument-hint')

  return {
    name: extractString(data, 'name'),
    description: extractString(data, 'description'),
    argumentHint: argumentHintRaw.replace(/^["']|["']$/g, ''),
    agent: extractNonEmptyString(data, 'agent'),
    model: extractNonEmptyString(data, 'model'),
    subtask: extractBoolean(data, 'subtask'),
  }
}
