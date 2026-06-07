#!/usr/bin/env bun
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const OUTPUT_DIR = path.join(__dirname, '../src/content/docs/reference')
const GITHUB_BASE = 'https://github.com/marcusrbrown/systematic/blob/main'
const SITE_BASE = '/systematic'

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

interface DefinitionEntry {
  title: string
  description: string
  slug: string
  category?: string
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

function cleanDescription(raw: string): string {
  // Trust boundary: `raw` is the description field of bundled SKILL.md / agent
  // frontmatter we ship in this repo. It is not user-supplied at runtime — the
  // docs build only ever runs against committed source. The HTML-tag strip is
  // cosmetic (descriptions occasionally include `<br>` etc.), not a security
  // control. The regex is still iterated to a fixed point so the static analyzer
  // (CodeQL `js/incomplete-multi-character-sanitization`, alert #31) sees a
  // sanitizer that cannot leave a stripped prefix behind on adversarial input
  // like `<<tag>` — defense in depth in case this helper is ever reused on
  // untrusted input by a future change.
  let cleaned = raw
  let previous: string
  do {
    previous = cleaned
    cleaned = cleaned.replace(/<[^>]+>/g, '')
  } while (cleaned !== previous)
  return cleaned.replace(/\\\\n/g, '\n')
}

function transformFrontmatter(
  data: Frontmatter,
  category?: string,
): Record<string, unknown> {
  const transformed: Record<string, unknown> = {}
  if (data.name) transformed.title = toTitleCase(data.name)
  if (data.description && typeof data.description === 'string')
    transformed.description = cleanDescription(data.description)

  if (category != null) {
    const categoryVariant: Record<string, string> = {
      review: 'note',
      research: 'success',
      design: 'tip',
      docs: 'default',
      workflow: 'caution',
    }
    transformed.sidebar = {
      badge: {
        text: category,
        variant: categoryVariant[category.toLowerCase()] ?? 'default',
      },
    }
  }

  return transformed
}

type DefinitionType = 'skill' | 'agent'

function generatePage(
  frontmatter: Record<string, unknown>,
  body: string,
  header: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: -1 }).trim()
  const cleanedBody = body.replace(/\n{3,}/g, '\n\n').trim()
  return `---\n${fm}\n---\n\n${header}\n${cleanedBody}`
}

export function generateDefinitionHeader(options: {
  category?: string
  sourcePath: string
  name?: string
  definitionType?: DefinitionType
  deprecated?: boolean
}): string {
  const githubUrl = `${GITHUB_BASE}/${options.sourcePath}`
  const parts: string[] = []

  if (options.category != null) {
    parts.push(`<span class="definition-category">${options.category}</span>`)
  }
  parts.push(`<a class="definition-source" href="${githubUrl}">View source</a>`)

  const header = `<div class="definition-header not-content">\n${parts.map((p) => `  ${p}`).join('\n')}\n</div>\n`

  if (
    options.definitionType === 'skill' &&
    options.name != null &&
    !options.deprecated
  ) {
    const installBlock = `\`\`\`bash\nnpx skills add marcusrbrown/systematic --skill ${options.name}\n\`\`\`\n`
    return `${header}\n${installBlock}`
  }

  return header
}

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

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function firstSentence(text: string): string {
  const cleaned = cleanDescription(text)
  const match = cleaned.match(/^[^.!?]+[.!?]/)
  return match ? match[0].trim() : cleaned.split('\n')[0].trim()
}

const AGENT_CATEGORY_ORDER = [
  'Review',
  'Research',
  'Design',
  'Document-review',
  'Docs',
  'Workflow',
] as const

const INDEX_META: Record<
  DefinitionType,
  { title: string; description: string; intro: string }
> = {
  skill: {
    title: 'Skills Reference',
    description: 'Bundled Systematic skills and when to use them.',
    intro:
      'Skills provide specialized knowledge and step-by-step guidance for specific tasks. They are loaded on demand and inject detailed instructions into the conversation.',
  },
  agent: {
    title: 'Agents Reference',
    description: 'Bundled Systematic agents and their review focus areas.',
    intro:
      'Agents are specialized for specific review, research, or workflow tasks. They can be invoked by @mention or via commands.',
  },
}

function renderLinkCard(entry: DefinitionEntry, outputSubdir: string): string {
  const href = `${SITE_BASE}/reference/${outputSubdir}/${entry.slug}/`
  const desc = escapeAttr(firstSentence(entry.description))
  const title = escapeAttr(entry.title)
  return `  <LinkCard title="${title}" description="${desc}" href="${href}" />`
}

function renderCardGrid(
  entries: DefinitionEntry[],
  outputSubdir: string,
): string {
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title))
  const cards = sorted.map((e) => renderLinkCard(e, outputSubdir))
  return `<CardGrid>\n${cards.join('\n')}\n</CardGrid>`
}

function generateIndexPage(
  entries: DefinitionEntry[],
  definitionType: DefinitionType,
  outputSubdir: string,
): void {
  const meta = INDEX_META[definitionType]
  const lines: string[] = []

  lines.push('---')
  lines.push(`title: ${meta.title}`)
  lines.push(`description: ${meta.description}`)
  lines.push('sidebar:')
  lines.push('  order: 1')
  lines.push('---')
  lines.push('')
  lines.push(
    "import { CardGrid, LinkCard } from '@astrojs/starlight/components';",
  )
  lines.push('')
  lines.push(meta.intro)
  lines.push('')

  if (definitionType === 'agent') {
    for (const cat of AGENT_CATEGORY_ORDER) {
      const group = entries.filter((e) => e.category === cat)
      if (group.length === 0) continue
      lines.push(`## ${cat}`)
      lines.push('')
      lines.push(renderCardGrid(group, outputSubdir))
      lines.push('')
    }
  } else {
    lines.push(renderCardGrid(entries, outputSubdir))
    lines.push('')
  }

  const outputPath = path.join(OUTPUT_DIR, outputSubdir, 'index.mdx')
  fs.writeFileSync(outputPath, lines.join('\n'))
}

function processDirectory(
  sourceDir: string,
  outputSubdir: string,
  definitionType: DefinitionType,
  filePattern: RegExp = /\.md$/,
): { count: number; entries: DefinitionEntry[] } {
  const outputDir = path.join(OUTPUT_DIR, outputSubdir)
  try {
    fs.mkdirSync(outputDir, { recursive: true })
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      fs.rmSync(path.join(outputDir, entry.name), {
        recursive: true,
        force: true,
      })
    }
  } catch (error) {
    console.error(`✗ Failed to create output directory: ${outputDir}`, error)
    process.exit(1)
  }

  if (!fs.existsSync(sourceDir)) {
    console.warn(`⚠️  Source directory not found: ${sourceDir}`)
    return { count: 0, entries: [] }
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
  const entries: DefinitionEntry[] = []
  const slugsSeen = new Map<string, string>()
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8')
      const parsed = parseFrontmatter<Frontmatter>(content)
      if (parsed.parseError) {
        console.warn(`⚠️  Failed to parse frontmatter in: ${file}`)
      }
      const { data, body } = parsed

      const name = deriveName(data, file, definitionType)
      const category = deriveCategory(file, definitionType)
      const frontmatter = transformFrontmatter({ ...data, name }, category)
      const sourcePath = path
        .relative(PROJECT_ROOT, file)
        .split(path.sep)
        .join('/')
      const deprecated = data.deprecated != null
      const header = generateDefinitionHeader({
        category,
        sourcePath,
        name,
        definitionType,
        deprecated,
      })
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

      const descText =
        data.description && typeof data.description === 'string'
          ? data.description
          : ''
      entries.push({
        title: toTitleCase(name),
        description: descText,
        slug,
        category,
      })
    } catch (error) {
      console.error(`✗ Failed to process file: ${file}`, error)
    }
  }

  generateIndexPage(entries, definitionType, outputSubdir)
  return { count, entries }
}

if (import.meta.main) {
  console.log('Generating reference documentation...')

  const { count: skillsCount } = processDirectory(
    path.join(PROJECT_ROOT, 'skills'),
    'skills',
    'skill',
    /SKILL\.md$/,
  )
  const { count: agentsCount } = processDirectory(
    path.join(PROJECT_ROOT, 'agents'),
    'agents',
    'agent',
  )
  console.log(`✓ Generated ${skillsCount} skills, ${agentsCount} agents`)
}
