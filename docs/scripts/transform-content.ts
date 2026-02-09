#!/usr/bin/env bun
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const OUTPUT_DIR = path.join(__dirname, '../src/content/docs/reference')

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

function parseFrontmatter(content: string): {
  data: Frontmatter
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/)
  if (!match) return { data: {}, body: content }

  try {
    const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA })
    return { data: (parsed ?? {}) as Frontmatter, body: match[2] }
  } catch {
    return { data: {}, body: match[2] }
  }
}

function transformFrontmatter(data: Frontmatter): Record<string, unknown> {
  const transformed: Record<string, unknown> = {}
  if (data.name) transformed.title = data.name
  if (data.description)
    transformed.description = data.description
      .replace(/<[^>]+>/g, '')
      .replace(/\\\\n/g, '\n')
  return transformed
}

function generatePage(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: -1 }).trim()
  const cleanedBody = body
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return `---\n${fm}\n---\n\n${cleanedBody}`
}

function processDirectory(
  sourceDir: string,
  outputSubdir: string,
  filePattern: RegExp = /\.md$/,
) {
  const outputDir = path.join(OUTPUT_DIR, outputSubdir)
  fs.mkdirSync(outputDir, { recursive: true })

  const files: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (filePattern.test(entry.name)) files.push(fullPath)
    }
  }
  walk(sourceDir)

  let count = 0
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    const { data, body } = parseFrontmatter(content)

    const name = data.name ?? path.basename(file, '.md')
    const frontmatter = transformFrontmatter({ ...data, name })
    const mdx = generatePage(frontmatter, body)

    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    fs.writeFileSync(path.join(outputDir, `${slug}.mdx`), mdx)
    count++
  }

  return count
}

console.log('Generating reference documentation...')

const skillsCount = processDirectory(
  path.join(PROJECT_ROOT, 'skills'),
  'skills',
  /SKILL\.md$/,
)
const agentsCount = processDirectory(
  path.join(PROJECT_ROOT, 'agents'),
  'agents',
)
const commandsCount = processDirectory(
  path.join(PROJECT_ROOT, 'commands'),
  'commands',
)

console.log(
  `✓ Generated ${skillsCount} skills, ${agentsCount} agents, ${commandsCount} commands`,
)
