import fs from 'node:fs'
import path from 'node:path'

export interface SkillFrontmatter {
  name: string
  description: string
}

export interface SkillInfo {
  path: string
  skillFile: string
  name: string
  description: string
  sourceType: 'bundled'
}

export interface ResolvedSkill {
  skillFile: string
  sourceType: 'bundled'
  skillPath: string
}

/**
 * Extract YAML frontmatter from a skill file.
 * Format:
 * ---
 * name: skill-name
 * description: Use when [condition] - [what it does]
 * ---
 */
export function extractFrontmatter(filePath: string): SkillFrontmatter {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
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
        const match = line.match(/^(\w+):\s*(.*)$/)
        if (match) {
          const [, key, value] = match
          if (key === 'name') name = value.trim()
          if (key === 'description') description = value.trim()
        }
      }
    }

    return { name, description }
  } catch {
    return { name: '', description: '' }
  }
}

/**
 * Strip YAML frontmatter from skill content.
 */
export function stripFrontmatter(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  let frontmatterEnded = false
  const contentLines: string[] = []

  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) {
        frontmatterEnded = true
        continue
      }
      inFrontmatter = true
      continue
    }

    if (frontmatterEnded || !inFrontmatter) {
      contentLines.push(line)
    }
  }

  return contentLines.join('\n').trim()
}

/**
 * Find all SKILL.md files in a directory recursively.
 */
export function findSkillsInDir(
  dir: string,
  sourceType: 'bundled',
  maxDepth = 3
): SkillInfo[] {
  const skills: SkillInfo[] = []

  if (!fs.existsSync(dir)) return skills

  function recurse(currentDir: string, depth: number) {
    if (depth > maxDepth) return

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const { name, description } = extractFrontmatter(skillFile)
          skills.push({
            path: fullPath,
            skillFile,
            name: name || entry.name,
            description: description || '',
            sourceType,
          })
        }
        recurse(fullPath, depth + 1)
      }
    }
  }

  recurse(dir, 0)
  return skills
}

/**
 * Resolve a skill name to its file path.
 *
 * The "systematic:" prefix explicitly requests bundled resolution,
 * but since only bundled skills are supported, all resolutions use bundled.
 */
export function resolveSkillPath(
  skillName: string,
  bundledDir: string,
  _userDir: string | null,
  _projectDir: string | null
): ResolvedSkill | null {
  const actualSkillName = skillName.replace(/^systematic:/, '')

  if (bundledDir) {
    const bundledPath = path.join(bundledDir, actualSkillName)
    const bundledSkillFile = path.join(bundledPath, 'SKILL.md')
    if (fs.existsSync(bundledSkillFile)) {
      return {
        skillFile: bundledSkillFile,
        sourceType: 'bundled',
        skillPath: actualSkillName,
      }
    }
  }

  return null
}

/**
 * Find agents in a directory (supports nested folders like review/, research/)
 */
export function findAgentsInDir(
  dir: string,
  sourceType: 'bundled',
  maxDepth = 2
): Array<{ name: string; file: string; sourceType: string; category?: string }> {
  const agents: Array<{ name: string; file: string; sourceType: string; category?: string }> = []

  if (!fs.existsSync(dir)) return agents

  function recurse(currentDir: string, depth: number, category?: string) {
    if (depth > maxDepth) return

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        recurse(fullPath, depth + 1, entry.name)
      } else if (entry.name.endsWith('.md')) {
        agents.push({
          name: entry.name.replace(/\.md$/, ''),
          file: fullPath,
          sourceType,
          category,
        })
      }
    }
  }

  recurse(dir, 0)
  return agents
}

/**
 * Find commands in a directory (supports nested folders like workflows/)
 */
export function findCommandsInDir(
  dir: string,
  sourceType: 'bundled',
  maxDepth = 2
): Array<{ name: string; file: string; sourceType: string; category?: string }> {
  const commands: Array<{ name: string; file: string; sourceType: string; category?: string }> = []

  if (!fs.existsSync(dir)) return commands

  function recurse(currentDir: string, depth: number, category?: string) {
    if (depth > maxDepth) return

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        recurse(fullPath, depth + 1, entry.name)
      } else if (entry.name.endsWith('.md')) {
        const baseName = entry.name.replace(/\.md$/, '')
        const commandName = category ? `/${category}:${baseName}` : `/${baseName}`
        commands.push({
          name: commandName,
          file: fullPath,
          sourceType,
          category,
        })
      }
    }
  }

  recurse(dir, 0)
  return commands
}

export interface AgentFrontmatter {
  name: string
  description: string
  prompt: string
}

export interface CommandFrontmatter {
  name: string
  description: string
  argumentHint: string
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
