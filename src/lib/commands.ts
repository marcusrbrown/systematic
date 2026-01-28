import { parseFrontmatter } from './frontmatter.js'
import { walkDir } from './walk-dir.js'

export interface CommandFrontmatter {
  name: string
  description: string
  argumentHint: string
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
  const { data, parseError } = parseFrontmatter<{
    name?: string
    description?: string
    'argument-hint'?: string
  }>(content)

  const argumentHintRaw =
    !parseError && typeof data['argument-hint'] === 'string'
      ? data['argument-hint']
      : ''

  return {
    name: !parseError && typeof data.name === 'string' ? data.name : '',
    description:
      !parseError && typeof data.description === 'string'
        ? data.description
        : '',
    argumentHint: argumentHintRaw.replace(/^["']|["']$/g, ''),
  }
}
