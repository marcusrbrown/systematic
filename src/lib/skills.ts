import fs from 'node:fs'
import path from 'node:path'
import { walkDir } from './walk-dir.js'

export interface SkillFrontmatter {
  name: string
  description: string
}

export interface SkillInfo {
  path: string
  skillFile: string
  name: string
  description: string
}

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

export function findSkillsInDir(dir: string, maxDepth = 3): SkillInfo[] {
  const skills: SkillInfo[] = []

  const entries = walkDir(dir, {
    maxDepth,
    filter: (e) => e.isDirectory,
  })

  for (const entry of entries) {
    const skillFile = path.join(entry.path, 'SKILL.md')
    if (fs.existsSync(skillFile)) {
      const { name, description } = extractFrontmatter(skillFile)
      skills.push({
        path: entry.path,
        skillFile,
        name: name || entry.name,
        description: description || '',
      })
    }
  }

  return skills
}

export function formatSkillsXml(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''

  const skillsXml = skills
    .map((skill) => {
      const lines = [
        '  <skill>',
        `    <name>systematic:${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
      ]
      lines.push('  </skill>')
      return lines.join('\n')
    })
    .join('\n')

  return `<available_skills>\n${skillsXml}\n</available_skills>`
}
