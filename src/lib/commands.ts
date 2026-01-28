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
    const commandName = entry.category ? `/${entry.category}:${baseName}` : `/${baseName}`
    return {
      name: commandName,
      file: entry.path,
      category: entry.category,
    }
  })
}

export function extractCommandFrontmatter(content: string): CommandFrontmatter {
  const lines = content.split('\n')

  let inFrontmatter = false
  let name = ''
  let description = ''
  let argumentHint = ''

  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) break
      inFrontmatter = true
      continue
    }

    if (inFrontmatter) {
      const match = line.match(/^(\w+(?:-\w+)*):\s*(.*)$/)
      if (match) {
        const [, key, value] = match
        if (key === 'name') name = value.trim()
        if (key === 'description') description = value.trim()
        if (key === 'argument-hint') argumentHint = value.trim().replace(/^["']|["']$/g, '')
      }
    }
  }

  return { name, description, argumentHint }
}
