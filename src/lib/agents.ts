import { parseFrontmatter, stripFrontmatter } from './frontmatter.js'
import { walkDir } from './walk-dir.js'

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
  const { data, parseError } = parseFrontmatter<{
    name?: string
    description?: string
  }>(content)

  return {
    name: !parseError && typeof data.name === 'string' ? data.name : '',
    description:
      !parseError && typeof data.description === 'string'
        ? data.description
        : '',
    prompt: stripFrontmatter(content),
  }
}
