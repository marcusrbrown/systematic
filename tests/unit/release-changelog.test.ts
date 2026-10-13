import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  CHANGELOG_HEADER,
  CHANGELOG_SENTINEL,
  parseEntries,
  renderChangelog,
} from '../../scripts/release/changelog.ts'

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

function entryFor(version: string, date = '2026-10-12'): string {
  return [
    `## [${version}](https://github.com/marcusrbrown/systematic/compare/v0.0.0...v${version}) (${date})`,
    '',
    '### Features',
    '',
    `- ship ${version}`,
  ].join('\n')
}

function fileWith(...entries: string[]): string {
  return `${CHANGELOG_HEADER}\n\n${CHANGELOG_SENTINEL}\n\n${entries.join('\n\n')}\n`
}

const tags = (...versions: string[]) =>
  new Set(versions.map((version) => `v${version}`))

describe('renderChangelog', () => {
  test('creates header + sentinel + entry when there is no file', () => {
    const entry = entryFor('1.0.0')
    const out = renderChangelog({
      current: null,
      entry,
      version: '1.0.0',
      existingTags: tags(),
    })
    expect(out).toBe(
      `${CHANGELOG_HEADER}\n\n${CHANGELOG_SENTINEL}\n\n${entry}\n`,
    )
    expect(out.startsWith('# Changelog\n\nAll notable changes')).toBe(true)
    expect(CHANGELOG_HEADER).toContain(
      '[GitHub Releases](https://github.com/marcusrbrown/systematic/releases)',
    )
  })

  test('prepends the new entry and keeps tagged entries in order', () => {
    const current = fileWith(entryFor('1.1.0'), entryFor('1.0.0'))
    const out = renderChangelog({
      current,
      entry: entryFor('1.2.0'),
      version: '1.2.0',
      existingTags: tags('1.1.0', '1.0.0'),
    })
    expect(out).toBe(
      fileWith(entryFor('1.2.0'), entryFor('1.1.0'), entryFor('1.0.0')),
    )
    expect(parseEntries(out).map((e) => e.version)).toEqual([
      '1.2.0',
      '1.1.0',
      '1.0.0',
    ])
  })

  test('drops phantom entries whose tag does not exist', () => {
    const current = fileWith(
      entryFor('1.1.1'),
      entryFor('1.1.0'),
      entryFor('1.0.0'),
    )
    const out = renderChangelog({
      current,
      entry: entryFor('1.2.0'),
      version: '1.2.0',
      existingTags: tags('1.1.0', '1.0.0'),
    })
    expect(parseEntries(out).map((e) => e.version)).toEqual([
      '1.2.0',
      '1.1.0',
      '1.0.0',
    ])
    expect(out).not.toContain('1.1.1')
  })

  test('a rerun with the same version replaces rather than duplicates', () => {
    const current = fileWith(entryFor('1.2.0', '2026-10-01'), entryFor('1.1.0'))
    const out = renderChangelog({
      current,
      entry: entryFor('1.2.0', '2026-10-12'),
      version: '1.2.0',
      // v1.2.0 is tagged here; it must still be replaced, not kept.
      existingTags: tags('1.2.0', '1.1.0'),
    })
    const versions = parseEntries(out).map((e) => e.version)
    expect(versions).toEqual(['1.2.0', '1.1.0'])
    expect(out).toContain('(2026-10-12)')
    expect(out).not.toContain('(2026-10-01)')
  })

  test('throws when the sentinel is missing', () => {
    expect(() =>
      renderChangelog({
        current: '# Changelog\n\n## 1.0.0 (2026-01-01)\n',
        entry: entryFor('1.1.0'),
        version: '1.1.0',
        existingTags: tags('1.0.0'),
      }),
    ).toThrow(CHANGELOG_SENTINEL)
  })

  test('fails closed on an empty tag set when entries would be dropped', () => {
    const current = fileWith(entryFor('1.0.0'))
    expect(() =>
      renderChangelog({
        current,
        entry: entryFor('1.1.0'),
        version: '1.1.0',
        existingTags: tags(),
      }),
    ).toThrow('tag listing')
  })

  test('an empty tag set is fine when there are no entries to drop', () => {
    const out = renderChangelog({
      current: fileWith(),
      entry: entryFor('1.0.0'),
      version: '1.0.0',
      existingTags: tags(),
    })
    expect(parseEntries(out).map((e) => e.version)).toEqual(['1.0.0'])
  })

  test('throws when the entry heading version differs from input.version', () => {
    expect(() =>
      renderChangelog({
        current: null,
        entry: entryFor('1.0.0'),
        version: '1.0.1',
        existingTags: tags(),
      }),
    ).toThrow()
    expect(() =>
      renderChangelog({
        current: null,
        entry: 'no heading here',
        version: '1.0.0',
        existingTags: tags(),
      }),
    ).toThrow()
  })

  test('preserves everything before the sentinel byte-for-byte', () => {
    const header = '# Custom\n\nHand-edited intro.\n\n'
    const current = `${header}${CHANGELOG_SENTINEL}\n\n${entryFor('1.0.0')}\n`
    const out = renderChangelog({
      current,
      entry: entryFor('1.1.0'),
      version: '1.1.0',
      existingTags: tags('1.0.0'),
    })
    expect(out.startsWith(`${header}${CHANGELOG_SENTINEL}\n\n`)).toBe(true)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})

describe('parseEntries', () => {
  test('parses both the linked and plain heading formats', () => {
    const content = [
      CHANGELOG_SENTINEL,
      '',
      '## [3.22.0](https://example.com/compare) (2026-10-12)',
      '',
      '- a',
      '',
      '## 3.21.0 (2026-10-01)',
      '',
      '- b',
      '',
    ].join('\n')
    const entries = parseEntries(content)
    expect(entries.map((e) => e.version)).toEqual(['3.22.0', '3.21.0'])
    expect(entries[0]?.text).toContain('- a')
    expect(entries[1]?.text).toContain('- b')
    expect(entries[0]?.text).not.toContain('3.21.0')
  })

  test('ignores content before the sentinel', () => {
    const content = `## 9.9.9 (old)\n\n${CHANGELOG_SENTINEL}\n\n## 1.0.0 (x)\n`
    expect(parseEntries(content).map((e) => e.version)).toEqual(['1.0.0'])
  })
})

describe('markdownlint', () => {
  test('output of a fresh changelog and an updated one has no errors', async () => {
    const fresh = renderChangelog({
      current: null,
      entry: entryFor('1.0.0'),
      version: '1.0.0',
      existingTags: tags(),
    })
    const updated = renderChangelog({
      current: fresh,
      entry: entryFor('1.1.0'),
      version: '1.1.0',
      existingTags: tags('1.0.0'),
    })
    expect(await lintMarkdown(fresh)).toEqual([])
    expect(await lintMarkdown(updated)).toEqual([])
  })
})
