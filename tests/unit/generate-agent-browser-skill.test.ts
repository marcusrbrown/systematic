import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyVersionToAttributions,
  normalizeForCompare,
  readPinnedVersion,
  stripHiddenFromFrontmatter,
} from '../../scripts/generate-agent-browser-skill.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = []

function makeTempDir(): string {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'generate-agent-browser-skill-'),
  )
  TEMP_ROOTS.push(tmp)
  return tmp
}

function writeFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
  return full
}

function writePackageJson(
  dir: string,
  devDependencies: Record<string, unknown>,
): string {
  return writeFile(dir, 'package.json', JSON.stringify({ devDependencies }))
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// stripHiddenFromFrontmatter
// ---------------------------------------------------------------------------

describe('stripHiddenFromFrontmatter', () => {
  test('removes hidden: true from frontmatter', () => {
    const input = `---
name: agent-browser
description: Browser automation.
allowed-tools: Bash(agent-browser:*)
hidden: true
---

# agent-browser

Body content here.
`
    const result = stripHiddenFromFrontmatter(input)
    expect(result).not.toContain('hidden: true')
    expect(result).toContain('name: agent-browser')
    expect(result).toContain('description: Browser automation.')
    expect(result).toContain('allowed-tools: Bash(agent-browser:*)')
    expect(result).toContain('Body content here.')
  })

  test('line above and below the stripped hidden line are intact (no join artifacts)', () => {
    const input = `---
name: agent-browser
description: Browser automation.
hidden: true
allowed-tools: Bash(agent-browser:*)
---

Body.
`
    const result = stripHiddenFromFrontmatter(input)
    // Both surrounding lines are preserved
    expect(result).toContain('description: Browser automation.')
    expect(result).toContain('allowed-tools: Bash(agent-browser:*)')
    // They remain on separate lines (not joined into one)
    const lines = result.split('\n')
    const descLine = lines.find((l) => l.startsWith('description:'))
    const toolsLine = lines.find((l) => l.startsWith('allowed-tools:'))
    expect(descLine).toBeDefined()
    expect(toolsLine).toBeDefined()
    // Neither line contains the content of the other
    expect(descLine).not.toContain('allowed-tools:')
    expect(toolsLine).not.toContain('description:')
    // Frontmatter closes correctly
    expect(result).toMatch(/^---\n[\s\S]*\n---\n/)
  })

  test('returns content unchanged when hidden: true is absent', () => {
    const input = `---
name: agent-browser
description: Browser automation.
allowed-tools: Bash(agent-browser:*)
---

Body content.
`
    const result = stripHiddenFromFrontmatter(input)
    expect(result).toBe(input)
  })

  test('returns content unchanged when there is no frontmatter block', () => {
    const input = `# No Frontmatter

Just a body.

hidden: true is here but not in frontmatter.
`
    const result = stripHiddenFromFrontmatter(input)
    expect(result).toBe(input)
  })

  test('does not strip hidden with a different value (e.g. hidden: false)', () => {
    const input = `---
name: test
hidden: false
description: Visible.
---

Body.
`
    const result = stripHiddenFromFrontmatter(input)
    expect(result).toContain('hidden: false')
  })

  test('does not strip indented hidden: true (non-toplevel frontmatter key)', () => {
    const input = `---
name: test
metadata:
  hidden: true
description: Visible.
---

Body.
`
    const result = stripHiddenFromFrontmatter(input)
    expect(result).toContain('  hidden: true')
  })

  test('does not touch hidden: true occurrences in the body (only frontmatter)', () => {
    const input = `---
name: test
description: Something.
hidden: true
---

The body mentions hidden: true for documentation.
`
    const result = stripHiddenFromFrontmatter(input)
    expect(result).not.toContain('hidden: true\n---')
    // Body mention survives
    expect(result).toContain('hidden: true for documentation')
  })
})

// ---------------------------------------------------------------------------
// applyVersionToAttributions
// ---------------------------------------------------------------------------

const SECTION_HEADING = '## vercel-labs/agent-browser — Apache-2.0'

/** Minimal ATTRIBUTIONS.md with just the agent-browser section */
function makeAttributions(version: string, extra = ''): string {
  return `# Attributions

## Other Section — MIT

Some other entry with no version refs.

${SECTION_HEADING}

**Source repository:** [\`vercel-labs/agent-browser\`](https://github.com/vercel-labs/agent-browser)
**Pinned version:** \`v${version}\` (npm \`agent-browser@${version}\`)
**License:** Apache-2.0

### Upstream Apache-2.0 license text

The following is from \`agent-browser@${version}\`:

\`\`\`
                         Apache License
                   Version 2.0, January 2004
\`\`\`
${extra}
`
}

describe('applyVersionToAttributions', () => {
  test('updates `v<semver>` and `agent-browser@<semver>` in the agent-browser section', () => {
    const content = makeAttributions('0.33.0')
    const result = applyVersionToAttributions(content, '0.34.0')

    expect(result).toContain('`v0.34.0`')
    expect(result).toContain('`agent-browser@0.34.0`')
    expect(result).not.toContain('`v0.33.0`')
    expect(result).not.toContain('`agent-browser@0.33.0`')
  })

  test('does not touch the Apache license body text ("Version 2.0")', () => {
    const content = makeAttributions('0.33.0')
    const result = applyVersionToAttributions(content, '0.34.0')

    // "Version 2.0" in the license body has no backticks — must survive unchanged
    expect(result).toContain('Apache License\n                   Version 2.0')
  })

  test('does not modify sections other than vercel-labs/agent-browser', () => {
    const contentWithOtherVersion = `# Attributions

## Other Section — MIT

**Pinned commit:** \`v1.2.3\` and \`obra@1.2.3\` mentioned here.

${SECTION_HEADING}

**Pinned version:** \`v0.33.0\` (npm \`agent-browser@0.33.0\`)

`
    const result = applyVersionToAttributions(contentWithOtherVersion, '0.34.0')

    // agent-browser section is updated
    expect(result).toContain('`v0.34.0`')
    expect(result).toContain('`agent-browser@0.34.0`')

    // Other section's version refs are untouched
    expect(result).toContain('`v1.2.3`')
    expect(result).toContain('`obra@1.2.3`')
  })

  test('is idempotent: applying the same version twice produces identical output', () => {
    const content = makeAttributions('0.33.0')
    const once = applyVersionToAttributions(content, '0.34.0')
    const twice = applyVersionToAttributions(once, '0.34.0')
    expect(twice).toBe(once)
  })

  test('throws with context when the section heading is missing', () => {
    const noSection = `# Attributions\n\nNo agent-browser section here.\n`
    expect(() => applyVersionToAttributions(noSection, '0.34.0')).toThrow(
      /vercel-labs\/agent-browser/,
    )
  })

  test('scopes to next ## heading — section after agent-browser is untouched', () => {
    const content = `${SECTION_HEADING}

**Pinned version:** \`v0.33.0\` (npm \`agent-browser@0.33.0\`)

## Anthropic — CC-BY-4.0

Retrieved \`v0.33.0\` from somewhere.
`
    const result = applyVersionToAttributions(content, '0.34.0')

    // Section above updated
    expect(result).toContain(
      '**Pinned version:** `v0.34.0` (npm `agent-browser@0.34.0`)',
    )
    // Section below untouched
    expect(result).toContain('Retrieved `v0.33.0` from somewhere.')
  })
})

// ---------------------------------------------------------------------------
// normalizeForCompare
// ---------------------------------------------------------------------------

describe('normalizeForCompare', () => {
  test('trims trailing whitespace and newlines', () => {
    expect(normalizeForCompare('foo\n\n  ')).toBe('foo')
    expect(normalizeForCompare('foo')).toBe('foo')
  })

  test('normalizes CRLF to LF', () => {
    expect(normalizeForCompare('foo\r\nbar\r\n')).toBe('foo\nbar')
  })

  test('preserves interior whitespace', () => {
    expect(normalizeForCompare('foo\n\nbar')).toBe('foo\n\nbar')
  })
})

// ---------------------------------------------------------------------------
// readPinnedVersion
// ---------------------------------------------------------------------------

describe('readPinnedVersion', () => {
  test('reads an exact-pinned version from package.json', () => {
    const tmp = makeTempDir()
    writePackageJson(tmp, { 'agent-browser': '0.33.0' })
    const pkgPath = path.join(tmp, 'package.json')
    expect(readPinnedVersion(pkgPath)).toBe('0.33.0')
  })

  test('strips a ^ range specifier and returns bare semver', () => {
    const tmp = makeTempDir()
    writePackageJson(tmp, { 'agent-browser': '^0.33.0' })
    const pkgPath = path.join(tmp, 'package.json')
    expect(readPinnedVersion(pkgPath)).toBe('0.33.0')
  })

  test('strips a ~ range specifier and returns bare semver', () => {
    const tmp = makeTempDir()
    writePackageJson(tmp, { 'agent-browser': '~1.2.3' })
    const pkgPath = path.join(tmp, 'package.json')
    expect(readPinnedVersion(pkgPath)).toBe('1.2.3')
  })

  test('throws when agent-browser is not in devDependencies', () => {
    const tmp = makeTempDir()
    writePackageJson(tmp, { 'some-other-package': '1.0.0' })
    const pkgPath = path.join(tmp, 'package.json')
    expect(() => readPinnedVersion(pkgPath)).toThrow(/agent-browser/)
  })

  test('throws when devDependencies is missing entirely', () => {
    const tmp = makeTempDir()
    writeFile(tmp, 'package.json', JSON.stringify({ name: 'test' }))
    const pkgPath = path.join(tmp, 'package.json')
    expect(() => readPinnedVersion(pkgPath)).toThrow(/devDependencies/)
  })

  test('throws when the version string is not valid semver', () => {
    const tmp = makeTempDir()
    writePackageJson(tmp, { 'agent-browser': 'not-a-version' })
    const pkgPath = path.join(tmp, 'package.json')
    expect(() => readPinnedVersion(pkgPath)).toThrow(/semver/)
  })

  test('throws when the package.json file does not exist', () => {
    expect(() => readPinnedVersion('/nonexistent/path/package.json')).toThrow(
      /Failed to read/,
    )
  })

  test('reads the real repo package.json and returns the pinned version', () => {
    const pkgPath = path.join(REPO_ROOT, 'package.json')
    const version = readPinnedVersion(pkgPath)
    // Must be a valid semver string
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// ---------------------------------------------------------------------------
// --check integration: real repo artifacts are in sync
// ---------------------------------------------------------------------------

describe('--check integration', () => {
  test('drift check passes on the real repo (both artifacts up to date)', () => {
    const result = Bun.spawnSync(
      [
        'bun',
        path.join(REPO_ROOT, 'scripts/generate-agent-browser-skill.ts'),
        '--check',
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('up to date')
  })
})
