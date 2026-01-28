import { walkDir } from './walk-dir.js'
import { stripFrontmatter } from './frontmatter.js'

export interface AgentFrontmatter {
  name: string
  description: string
  prompt: string
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
  const lines = content.split('\n')

  let inFrontmatter = false
  let name = ''
  let description = ''

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
      }
    }
  }

  return { name, description, prompt: stripFrontmatter(content) }
}
