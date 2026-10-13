import fs from 'node:fs'
import path from 'node:path'

export const CHANGELOG_SENTINEL = '<!-- release-entries -->'

export const CHANGELOG_HEADER = fs
  .readFileSync(path.resolve(import.meta.dir, 'changelog-header.md'), 'utf8')
  .trimEnd()

export interface ChangelogEntry {
  version: string
  text: string
}

export interface RenderChangelogInput {
  current: string | null
  entry: string
  version: string
  existingTags: ReadonlySet<string>
}

const ENTRY_HEADING = /^## \[?(\d+\.\d+\.\d+)/
const SENTINEL_LINE = /^<!-- release-entries -->[ \t]*$/m

function splitAtSentinel(
  content: string,
): { before: string; after: string } | null {
  const match = SENTINEL_LINE.exec(content)
  if (match === null) return null
  return {
    before: content.slice(0, match.index),
    after: content.slice(match.index + match[0].length),
  }
}

/** Entries after the sentinel; each runs from its heading to the next one. */
export function parseEntries(content: string): ChangelogEntry[] {
  const parts = splitAtSentinel(content)
  if (parts === null) return []

  const entries: ChangelogEntry[] = []
  let version: string | null = null
  let lines: string[] = []
  const flush = () => {
    if (version !== null) {
      entries.push({ version, text: lines.join('\n').trim() })
    }
  }

  for (const line of parts.after.split('\n')) {
    const heading = ENTRY_HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      flush()
      version = heading[1]
      lines = [line]
    } else if (version !== null) {
      lines.push(line)
    }
  }
  flush()
  return entries
}

export function renderChangelog(input: RenderChangelogInput): string {
  const { current, version, existingTags } = input
  const entry = input.entry.trim()

  const entryVersion = ENTRY_HEADING.exec(entry)?.[1]
  if (entryVersion !== version) {
    throw new Error(
      `Changelog entry must start with a "## " heading for version ${version}, found ${
        entryVersion === undefined ? 'no version heading' : entryVersion
      }`,
    )
  }

  if (current === null) {
    return `${CHANGELOG_HEADER}\n\n${CHANGELOG_SENTINEL}\n\n${entry}\n`
  }

  const parts = splitAtSentinel(current)
  if (parts === null) {
    throw new Error(
      `CHANGELOG.md is missing the ${CHANGELOG_SENTINEL} sentinel line`,
    )
  }

  const existing = parseEntries(current)
  const kept = existing.filter(
    (e) => e.version !== version && existingTags.has(`v${e.version}`),
  )
  const dropped = existing.filter((e) => !kept.includes(e))

  if (existingTags.size === 0 && dropped.length > 0) {
    throw new Error(
      'Refusing to drop CHANGELOG.md entries: the tag listing is empty, so the tag lookup likely failed',
    )
  }

  return `${[
    `${parts.before}${CHANGELOG_SENTINEL}`,
    entry,
    ...kept.map((e) => e.text),
  ].join('\n\n')}\n`
}
