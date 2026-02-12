#!/usr/bin/env bun
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const OUTPUT_DIR = path.join(__dirname, '../src/content/docs/reference')
const GITHUB_BASE = 'https://github.com/marcusrbrown/systematic/blob/main'

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

function parseFrontmatter(
  content: string,
  sourcePath: string,
): {
  data: Frontmatter
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/)
  if (!match) return { data: {}, body: content }

  try {
    const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA })
    return { data: (parsed ?? {}) as Frontmatter, body: match[2] }
  } catch (error) {
    console.warn(`⚠️  Failed to parse frontmatter in: ${sourcePath}`, error)
    return { data: {}, body: match[2] }
  }
}

const ACRONYMS = new Set([
  'api',
  'cd',
  'ci',
  'cli',
  'css',
  'dhh',
  'html',
  'json',
  'mcp',
  'pr',
  'sdk',
  'ui',
  'ux',
  'yaml',
])

function toTitleCase(name: string): string {
  return name
    .replace(/^workflows:/, 'Workflows: ')
    .split(/[-\s]+/)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ')
    .trim()
}

function transformFrontmatter(
  data: Frontmatter,
  definitionType: DefinitionType,
): Record<string, unknown> {
  const transformed: Record<string, unknown> = {}
  if (data.name) transformed.title = toTitleCase(data.name)
  if (data.description && typeof data.description === 'string')
    transformed.description = data.description
      .replace(/<[^>]+>/g, '')
      .replace(/\\\\n/g, '\n')

  const badgeVariant: Record<DefinitionType, string> = {
    skill: 'tip',
    agent: 'note',
    command: 'caution',
  }
  transformed.sidebar = {
    badge: {
      text: definitionType.charAt(0).toUpperCase() + definitionType.slice(1),
      variant: badgeVariant[definitionType],
    },
  }

  return transformed
}

function generatePage(
  frontmatter: Record<string, unknown>,
  body: string,
  header: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: -1 }).trim()
  const cleanedBody = body.replace(/\n{3,}/g, '\n\n').trim()
  return `---\n${fm}\n---\n\n${header}\n${cleanedBody}`
}

function generateDefinitionHeader(options: {
  category?: string
  sourcePath: string
}): string {
  const githubUrl = `${GITHUB_BASE}/${options.sourcePath}`
  const parts: string[] = []

  if (options.category != null) {
    parts.push(`<span class="definition-category">${options.category}</span>`)
  }
  parts.push(`<a class="definition-source" href="${githubUrl}">View source</a>`)

  return `<div class="definition-header not-content">\n${parts.map((p) => `  ${p}`).join('\n')}\n</div>\n`
}

type DefinitionType = 'skill' | 'agent' | 'command'

function deriveName(
  data: Frontmatter,
  file: string,
  definitionType: DefinitionType,
): string {
  if (data.name) return data.name
  return definitionType === 'skill'
    ? path.basename(path.dirname(file))
    : path.basename(file, '.md')
}

function deriveCategory(
  file: string,
  definitionType: DefinitionType,
): string | undefined {
  if (definitionType !== 'agent') return undefined
  const dir = path.basename(path.dirname(file))
  return dir.charAt(0).toUpperCase() + dir.slice(1)
}

function processDirectory(
  sourceDir: string,
  outputSubdir: string,
  definitionType: DefinitionType,
  filePattern: RegExp = /\.md$/,
) {
  if (!fs.existsSync(sourceDir)) {
    console.warn(`⚠️  Source directory not found: ${sourceDir}`)
    return 0
  }

  const outputDir = path.join(OUTPUT_DIR, outputSubdir)
  try {
    fs.mkdirSync(outputDir, { recursive: true })
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'index.mdx') continue
      fs.rmSync(path.join(outputDir, entry.name), {
        recursive: true,
        force: true,
      })
    }
  } catch (error) {
    console.error(`✗ Failed to create output directory: ${outputDir}`, error)
    process.exit(1)
  }

  const files: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(fullPath)
        else if (filePattern.test(entry.name)) files.push(fullPath)
      }
    } catch (error) {
      console.warn(`⚠️  Failed to read directory: ${dir}`, error)
    }
  }
  walk(sourceDir)

  let count = 0
  const slugsSeen = new Map<string, string>()
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(content, file)

      const name = deriveName(data, file, definitionType)
      const frontmatter = transformFrontmatter(
        { ...data, name },
        definitionType,
      )
      const sourcePath = path
        .relative(PROJECT_ROOT, file)
        .split(path.sep)
        .join('/')
      const category = deriveCategory(file, definitionType)
      const header = generateDefinitionHeader({ category, sourcePath })
      const mdx = generatePage(frontmatter, body, header)

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-')
      if (!slug) {
        console.warn(`⚠️  Could not generate valid slug for: ${name}`)
        continue
      }

      const existingFile = slugsSeen.get(slug)
      if (existingFile != null) {
        console.error(
          `✗ Slug collision: "${slug}" from ${file} overwrites ${existingFile}`,
        )
        process.exitCode = 1
        continue
      }
      slugsSeen.set(slug, file)

      fs.writeFileSync(path.join(outputDir, `${slug}.md`), mdx)
      count++
    } catch (error) {
      console.error(`✗ Failed to process file: ${file}`, error)
    }
  }

  return count
}

console.log('Generating reference documentation...')

const skillsCount = processDirectory(
  path.join(PROJECT_ROOT, 'skills'),
  'skills',
  'skill',
  /SKILL\.md$/,
)
const agentsCount = processDirectory(
  path.join(PROJECT_ROOT, 'agents'),
  'agents',
  'agent',
)
const commandsCount = processDirectory(
  path.join(PROJECT_ROOT, 'commands'),
  'commands',
  'command',
)

console.log(
  `✓ Generated ${skillsCount} skills, ${agentsCount} agents, ${commandsCount} commands`,
)
