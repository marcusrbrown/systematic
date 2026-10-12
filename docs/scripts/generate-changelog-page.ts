#!/usr/bin/env bun
/**
 * Generate the docs "Changelog" page from the repo's `CHANGELOG.md`.
 *
 * `CHANGELOG.md` is maintained by the release pull request: a header, the
 * `<!-- release-entries -->` sentinel, then one entry per release, newest
 * first. The page is plain `.md` (never `.mdx`) so MDX never evaluates it, and
 * every fragment goes through the same sanitizer as the release-notes page —
 * raw HTML dropped, images reduced to alt text, only https links kept, braces
 * escaped.
 *
 * Usage:
 *   bun docs/scripts/generate-changelog-page.ts [--deploy-tag vX.Y.Z]
 *
 * `--deploy-tag` (deploy builds) keeps only entries at or below that tag's
 * version, so a pending, untagged entry is never published, and fails unless
 * the top kept entry is exactly the tag's version (a guard against deploying
 * the wrong tree). Without it (PR and local builds) every entry renders, so a
 * release PR proves its entry parses.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import {
  CHANGELOG_SENTINEL,
  type ChangelogEntry,
  parseEntries,
} from '../../scripts/release/changelog.ts'
import { sanitizeBody } from './generate-release-notes.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const CHANGELOG_PATH = path.join(__dirname, '../../CHANGELOG.md')
export const OUTPUT_PATH = path.join(
  __dirname,
  '../src/content/docs/reference/changelog.md',
)

const RELEASES_PAGE_URL = 'https://github.com/marcusrbrown/systematic/releases'

const PAGE_FRONTMATTER = {
  title: 'Changelog',
  description:
    'What changed in each Systematic release, newest first, maintained by the release pull request.',
  tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
}

export interface GenerateChangelogOptions {
  /** Contents of CHANGELOG.md, or null when the file does not exist. */
  content: string | null
  /** Release tag (`vX.Y.Z`) being deployed; enables the deploy guard. */
  deployTag?: string
}

type Version = readonly [number, number, number]

function parseVersion(version: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function renderPage(body: string): string {
  const fm = yaml.dump(PAGE_FRONTMATTER, { lineWidth: -1 }).trim()
  return `---\n${fm}\n---\n\n${body.trim()}\n`
}

export function renderPlaceholderPage(): string {
  return renderPage(
    `Entries begin with the first release made through the release pull request. Earlier releases are listed on [GitHub Releases](${RELEASES_PAGE_URL}).`,
  )
}

/** Header prose: everything before the sentinel, minus the `# Changelog` h1. */
function headerProse(content: string): string {
  const sentinelAt = content.indexOf(CHANGELOG_SENTINEL)
  const before = sentinelAt === -1 ? '' : content.slice(0, sentinelAt)
  return before
    .replace(/\r\n?/g, '\n')
    .replace(/^# .*$/m, '')
    .trim()
}

/**
 * Entry heading becomes h2 and its sections h3. The sanitizer places the
 * shallowest heading of a body at h3, so the heading line is sanitized on its
 * own (and lifted one level) and the sections are sanitized separately.
 */
function renderEntry(entry: ChangelogEntry, index: number): string {
  const [headingLine = '', ...rest] = entry.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const heading = sanitizeBody(
    `## ${headingLine.replace(/^##\s+/, '')}`,
    `e${index}h-`,
  ).replace(/^### /, '## ')
  const sections = sanitizeBody(rest.join('\n'), `e${index}-`)
  return sections === '' ? heading : `${heading}\n\n${sections}`
}

function parseDeployTagVersion(deployTag: string): Version {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(deployTag)
  const version = match?.[1] === undefined ? null : parseVersion(match[1])
  if (version === null) {
    throw new Error(
      `Invalid deploy tag "${deployTag}"; expected the form vX.Y.Z`,
    )
  }
  return version
}

/** Entries at or below the deploy tag; the top one must be the tag itself. */
function selectDeployEntries(
  entries: ChangelogEntry[],
  deployTag: string,
  deployVersion: Version,
): ChangelogEntry[] {
  const kept = entries.filter((entry) => {
    const version = parseVersion(entry.version)
    return version !== null && compareVersions(version, deployVersion) <= 0
  })
  const top = kept[0]
  if (top === undefined || `v${top.version}` !== deployTag) {
    throw new Error(
      `CHANGELOG.md top entry is ${top === undefined ? 'missing' : top.version}, expected ${deployTag.slice(1)} for deploy tag ${deployTag}`,
    )
  }
  return kept
}

export function generateChangelogPage(
  options: GenerateChangelogOptions,
): string {
  const { content, deployTag } = options
  // Validate the tag even when the file is empty, so a typo never passes.
  const deployVersion =
    deployTag === undefined ? null : parseDeployTagVersion(deployTag)

  const all = content === null ? [] : parseEntries(content)
  if (content === null || all.length === 0) return renderPlaceholderPage()

  const kept =
    deployTag === undefined || deployVersion === null
      ? all
      : selectDeployEntries(all, deployTag, deployVersion)

  const parts: string[] = []
  const header = headerProse(content)
  if (header !== '') parts.push(sanitizeBody(header, 'h-'))
  parts.push(...kept.map((entry, index) => renderEntry(entry, index)))
  return renderPage(parts.join('\n\n'))
}

function parseDeployTag(argv: string[]): string | undefined {
  const index = argv.indexOf('--deploy-tag')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--deploy-tag requires a value like v1.2.3')
  }
  return value
}

if (import.meta.main) {
  try {
    const deployTag = parseDeployTag(process.argv.slice(2))
    const content = fs.existsSync(CHANGELOG_PATH)
      ? fs.readFileSync(CHANGELOG_PATH, 'utf8')
      : null
    if (content === null) {
      console.log('No CHANGELOG.md found; writing placeholder changelog page')
    }
    const page = generateChangelogPage({ content, deployTag })
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
    fs.writeFileSync(OUTPUT_PATH, page)
    console.log(`✓ Generated changelog page: ${OUTPUT_PATH}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
