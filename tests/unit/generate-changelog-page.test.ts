import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  generateChangelogPage,
  OUTPUT_PATH,
} from '../../docs/scripts/generate-changelog-page.ts'
import {
  type MdNode,
  parseMarkdown,
} from '../../docs/scripts/generate-release-notes.ts'
import {
  CHANGELOG_HEADER,
  CHANGELOG_SENTINEL,
} from '../../scripts/release/changelog.ts'

const RELEASES_URL = 'https://github.com/marcusrbrown/systematic/releases'

const ENTRY_2 = [
  '## [2.0.0](https://github.com/marcusrbrown/systematic/compare/v1.1.0...v2.0.0) (2026-03-01)',
  '',
  '### Features',
  '',
  '- add the thing ([#12](https://github.com/marcusrbrown/systematic/pull/12))',
  '',
  '### Bug Fixes',
  '',
  '- fix the other thing',
].join('\n')

const ENTRY_1 = [
  '## 1.1.0 (2026-02-01)',
  '',
  '### Features',
  '',
  '- older feature',
].join('\n')

const ENTRY_0 = [
  '## 1.0.0 (2026-01-01)',
  '',
  '### Features',
  '',
  '- first',
].join('\n')

function makeChangelog(...entries: string[]): string {
  return `${CHANGELOG_HEADER}\n\n${CHANGELOG_SENTINEL}\n\n${entries.join('\n\n')}\n`
}

function headingLevels(markdown: string): number[] {
  const levels: number[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker
      else if (
        marker.startsWith(fence[0] ?? '') &&
        marker.length >= fence.length
      )
        fence = null
      continue
    }
    if (fence !== null) continue
    const heading = line.match(/^(#{1,6})\s/)
    if (heading?.[1]) levels.push(heading[1].length)
  }
  return levels
}

interface MarkdownlintModule {
  lint: (options: {
    strings: Record<string, string>
    config: Record<string, unknown>
  }) => Promise<Record<string, unknown[]>>
}

async function lintMarkdown(markdown: string): Promise<unknown[]> {
  // markdownlint is a transitive dependency of markdownlint-cli (a devDependency).
  // Under bun's isolated linker it is not resolvable from the repo root, so
  // resolve it relative to the CLI package that depends on it.
  const cliDir = path.dirname(
    Bun.resolveSync('markdownlint-cli/package.json', import.meta.dir),
  )
  const modulePath = Bun.resolveSync('markdownlint/promise', cliDir)
  const markdownlint = (await import(modulePath)) as MarkdownlintModule
  const configPath = path.resolve(import.meta.dir, '../../.markdownlint.yaml')
  const config = yaml.load(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >
  const results = await markdownlint.lint({
    strings: { page: markdown },
    config,
  })
  return results.page ?? []
}

/** Nodes that must never reach a reader: html, images, non-https links. */
function unsafeNodes(markdown: string): string[] {
  const found: string[] = []
  const visit = (node: MdNode) => {
    if (node.type === 'html') found.push('html')
    if (node.type === 'image' || node.type === 'imageReference') {
      found.push(node.type)
    }
    if (
      (node.type === 'link' || node.type === 'definition') &&
      !/^https:/i.test(node.url ?? '')
    ) {
      found.push(`${node.type}:${node.url}`)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(parseMarkdown(markdown))
  return found
}

describe('generateChangelogPage', () => {
  test('writes to the reference changelog page', () => {
    expect(OUTPUT_PATH.endsWith('reference/changelog.md')).toBe(true)
  })

  test('missing file produces the placeholder with the Releases link', () => {
    const page = generateChangelogPage({ content: null })

    expect(page).toContain('title: Changelog')
    expect(page).toContain(
      'Entries begin with the first release made through the release pull request',
    )
    expect(page).toContain(`(${RELEASES_URL})`)
    expect(headingLevels(page)).toEqual([])
  })

  test('a file with no entries produces the placeholder', () => {
    const page = generateChangelogPage({ content: makeChangelog() })

    expect(page).toContain(`(${RELEASES_URL})`)
    expect(page).not.toContain('Bug Fixes')
    expect(headingLevels(page)).toEqual([])
  })

  test('renders entries newest first with h2 versions, h3 sections, no h1', () => {
    const page = generateChangelogPage({
      content: makeChangelog(ENTRY_2, ENTRY_1),
    })

    expect(page.indexOf('2.0.0')).toBeGreaterThan(-1)
    expect(page.indexOf('2.0.0')).toBeLessThan(page.indexOf('1.1.0'))
    expect(headingLevels(page)).toEqual([2, 3, 3, 2, 3])
    expect(page).toContain(
      '[2.0.0](https://github.com/marcusrbrown/systematic/compare/v1.1.0...v2.0.0) (2026-03-01)',
    )
    expect(page).toContain('All notable changes')
  })

  test('frontmatter has title and description', () => {
    const page = generateChangelogPage({ content: makeChangelog(ENTRY_1) })
    const match = page.match(/^---\n([\s\S]*?)\n---\n/)
    const fm = yaml.load(match?.[1] ?? '') as Record<string, unknown>

    expect(fm.title).toBe('Changelog')
    expect(typeof fm.description).toBe('string')
  })

  test('--deploy-tag drops pending entries above the tag', () => {
    const page = generateChangelogPage({
      content: makeChangelog(ENTRY_2, ENTRY_1, ENTRY_0),
      deployTag: 'v1.1.0',
    })

    expect(page).not.toContain('2.0.0')
    expect(page).toContain('## 1.1.0 (2026-02-01)')
    expect(page).toContain('## 1.0.0 (2026-01-01)')
    expect(page.indexOf('1.1.0')).toBeLessThan(page.indexOf('1.0.0'))
  })

  test('without a deploy tag every entry renders', () => {
    const page = generateChangelogPage({
      content: makeChangelog(ENTRY_2, ENTRY_1, ENTRY_0),
    })

    expect(page).toContain('2.0.0')
    expect(page).toContain('1.0.0')
  })

  test('throws when the top kept entry is not the deploy tag', () => {
    expect(() =>
      generateChangelogPage({
        content: makeChangelog(ENTRY_2, ENTRY_0),
        deployTag: 'v1.1.0',
      }),
    ).toThrow(/1\.1\.0/)
  })

  test('throws when every entry is newer than the deploy tag', () => {
    expect(() =>
      generateChangelogPage({
        content: makeChangelog(ENTRY_2),
        deployTag: 'v1.0.0',
      }),
    ).toThrow(/1\.0\.0/)
  })

  test('throws on a malformed deploy tag', () => {
    expect(() =>
      generateChangelogPage({
        content: makeChangelog(ENTRY_1),
        deployTag: 'main',
      }),
    ).toThrow(/deploy tag/i)
  })

  test('compares versions numerically, not lexically', () => {
    const entry10 = '## 1.10.0 (2026-04-01)\n\n### Features\n\n- ten'
    const entry9 = '## 1.9.0 (2026-03-01)\n\n### Features\n\n- nine'
    const page = generateChangelogPage({
      content: makeChangelog(entry10, entry9),
      deployTag: 'v1.9.0',
    })

    expect(page).not.toContain('1.10.0')
    expect(page).toContain('1.9.0')
  })

  test('hostile entry content is neutralized', () => {
    const hostile = [
      '## 1.2.0 (2026-02-02)',
      '',
      '### Features',
      '',
      '<script>alert(1)</script>',
      '',
      '- [click](javascript:alert(1))',
      '- ![tracker](https://tracker.example/x.png)',
      '- leak {process.env.SECRET}',
      '- see http://example.com and www.example.com',
      '',
      '<div onclick=alert(1)>hi</div>',
    ].join('\n')
    const page = generateChangelogPage({ content: makeChangelog(hostile) })

    expect(unsafeNodes(page)).toEqual([])
    expect(page).not.toContain('<script')
    expect(page).not.toContain('javascript:')
    expect(page).not.toContain('![')
    expect(page).toContain('tracker')
    expect(page).toContain('\\{process.env.SECRET\\}')
  })

  test('hostile header prose is neutralized', () => {
    const content = `# Changelog\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![i](https://t.example/i.png)\n\n${CHANGELOG_SENTINEL}\n\n${ENTRY_1}\n`
    const page = generateChangelogPage({ content })

    expect(unsafeNodes(page)).toEqual([])
    expect(headingLevels(page)).toEqual([2, 3])
  })

  test('output passes markdownlint with the repo config', async () => {
    const page = generateChangelogPage({
      content: makeChangelog(ENTRY_2, ENTRY_1, ENTRY_0),
    })
    expect(await lintMarkdown(page)).toEqual([])

    const placeholder = generateChangelogPage({ content: null })
    expect(await lintMarkdown(placeholder)).toEqual([])
  })
})
