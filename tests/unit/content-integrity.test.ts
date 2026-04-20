import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AllowlistEntry,
  BANNED_PATTERNS,
  checkBannedPatterns,
  checkContentIntegrity,
  checkReferenceIntegrity,
  collectScanTargets,
  discoverCategories,
  loadAllowlist,
  matchesPathGlob,
} from '../../scripts/content-integrity.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/content-integrity.ts')

/**
 * Build a minimal fixture repo with the scan-target directory shape the gate
 * expects. Returns the temp root; tests create skills/agents/src files beneath.
 */
function makeFixtureRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-integrity-'))
  fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'src', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true })
  return tmp
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function writeAllowlist(root: string, exemptions: AllowlistEntry[]): void {
  writeFile(
    root,
    'scripts/.drift-allowlist.json',
    JSON.stringify({ exemptions }, null, 2),
  )
}

function writeAgent(root: string, category: string, name: string): void {
  writeFile(
    root,
    `agents/${category}/${name}.md`,
    `---\nname: ${name}\n---\nagent body`,
  )
}

function writeSkill(root: string, name: string, body: string): void {
  writeFile(root, `skills/${name}/SKILL.md`, body)
}

// ---------------------------------------------------------------------------

describe('BANNED_PATTERNS', () => {
  test('exposes the 8 patterns documented in the plan', () => {
    expect(BANNED_PATTERNS).toEqual([
      'Claude Code',
      'TaskCreate',
      'AskUserQuestion',
      'compound-engineering:',
      'CLAUDE.md',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal string the gate scans for.
      '${CLAUDE_PLUGIN_ROOT}',
      '.claude/',
      '.context/compound-engineering/',
    ])
  })
})

describe('matchesPathGlob', () => {
  test('matches exact path', () => {
    expect(
      matchesPathGlob('src/lib/converter.ts', 'src/lib/converter.ts'),
    ).toBe(true)
    expect(matchesPathGlob('src/lib/other.ts', 'src/lib/converter.ts')).toBe(
      false,
    )
  })

  test('matches /** prefix including nested files', () => {
    expect(matchesPathGlob('skills/foo/SKILL.md', 'skills/foo/**')).toBe(true)
    expect(
      matchesPathGlob('skills/foo/references/bar.md', 'skills/foo/**'),
    ).toBe(true)
  })

  test('does not match the bare prefix itself (/** requires a child path)', () => {
    // `skills/foo/**` means "any file under skills/foo/" — not the directory
    // itself. The old behavior (true for the prefix) was semantically wrong
    // and never occurs in practice (scanned files are always file paths).
    expect(matchesPathGlob('skills/foo', 'skills/foo/**')).toBe(false)
  })

  test('bare segment glob (no /**) matches only exact paths', () => {
    // A pathGlob without /** is an exact-path match; it does not act as
    // a directory prefix.
    expect(matchesPathGlob('src', 'src')).toBe(true)
    expect(matchesPathGlob('src/lib/x.ts', 'src')).toBe(false)
    expect(matchesPathGlob('src/lib/x.ts', 'src/lib/x.ts')).toBe(true)
  })

  test('does not match sibling directories with a similar prefix', () => {
    expect(matchesPathGlob('skills/foobar/SKILL.md', 'skills/foo/**')).toBe(
      false,
    )
  })
})

describe('discoverCategories', () => {
  test('lists agents/ subdirectories at runtime', () => {
    const root = makeFixtureRepo()
    try {
      fs.mkdirSync(path.join(root, 'agents', 'research'))
      fs.mkdirSync(path.join(root, 'agents', 'review'))
      fs.mkdirSync(path.join(root, 'agents', 'workflow'))

      expect(discoverCategories(root)).toEqual([
        'research',
        'review',
        'workflow',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips hidden directories (names starting with .)', () => {
    const root = makeFixtureRepo()
    try {
      fs.mkdirSync(path.join(root, 'agents', 'research'))
      fs.mkdirSync(path.join(root, 'agents', '.tmp'))

      expect(discoverCategories(root)).toEqual(['research'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns empty array when agents/ does not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-agents-'))
    try {
      expect(discoverCategories(tmp)).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('collectScanTargets', () => {
  test('collects markdown from skills/ and agents/, typescript from src/', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'skills/foo/SKILL.md', 'skill')
      writeFile(root, 'skills/foo/references/ref.md', 'ref')
      writeFile(root, 'agents/research/a.md', 'agent')
      writeFile(root, 'src/lib/foo.ts', 'ts')
      writeFile(root, 'docs/not-scanned.md', 'should be excluded')
      writeFile(root, 'src/lib/AGENTS.md', 'docs markdown in src excluded')

      const targets = collectScanTargets(root)

      expect(targets.markdown).toEqual([
        'agents/research/a.md',
        'skills/foo/SKILL.md',
        'skills/foo/references/ref.md',
      ])
      expect(targets.typescript).toEqual(['src/lib/foo.ts'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips *.md files under src/ (developer-facing documentation)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'src/lib/notes.md', 'docs — should be excluded from scan')
      writeFile(root, 'src/lib/code.ts', 'code')

      const targets = collectScanTargets(root)
      expect(targets.markdown).not.toContain('src/lib/notes.md')
      expect(targets.typescript).toContain('src/lib/code.ts')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('loadAllowlist', () => {
  test('returns empty allowlist and no warnings when file is missing', () => {
    const root = makeFixtureRepo()
    try {
      const { allowlist, warnings } = loadAllowlist(root)
      expect(allowlist).toEqual({ exemptions: [] })
      expect(warnings).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('loads a valid allowlist with structured entries', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/foo/**',
          patterns: ['Claude Code'],
          reason: 'Documents a CC-targeting skill explicitly by design.',
        },
      ])
      const { allowlist } = loadAllowlist(root)
      expect(allowlist.exemptions).toHaveLength(1)
      expect(allowlist.exemptions[0]?.patterns).toEqual(['Claude Code'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('throws on malformed JSON', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'scripts/.drift-allowlist.json', '{ not valid json')
      expect(() => loadAllowlist(root)).toThrow(/Invalid JSON/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('throws on missing exemptions array', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'scripts/.drift-allowlist.json', '{}')
      expect(() => loadAllowlist(root)).toThrow(
        /expected \{ exemptions: \[\.\.\.\] \}/,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('throws on empty pathGlob', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: '',
          patterns: ['Claude Code'],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])
      expect(() => loadAllowlist(root)).toThrow(
        /pathGlob must be a non-empty string/,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('throws on unknown banned pattern', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/foo/**',
          patterns: ['NotARealPattern' as never],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])
      expect(() => loadAllowlist(root)).toThrow(/not a known banned pattern/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('throws on reason shorter than 20 chars', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/foo/**',
          patterns: ['Claude Code'],
          reason: 'too short',
        },
      ])
      expect(() => loadAllowlist(root)).toThrow(/at least 20 characters/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('throws on unsupported glob syntax (? or [abc])', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/[abc]/**',
          patterns: ['Claude Code'],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])
      expect(() => loadAllowlist(root)).toThrow(/unsupported glob syntax/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('emits zero-match warning for pathGlob that matches no scanned files', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/nonexistent/**',
          patterns: ['Claude Code'],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])
      const scanned = ['skills/other/SKILL.md']
      const { warnings } = loadAllowlist(root, scanned)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.kind).toBe('zero-match')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('emits broad-pathglob warning for skills/** (no subdirectory prefix)', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/**',
          patterns: ['Claude Code'],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])
      const scanned = ['skills/foo/SKILL.md']
      const { warnings } = loadAllowlist(root, scanned)
      const broad = warnings.find((w) => w.kind === 'broad-pathglob')
      expect(broad).toBeDefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not warn on specific prefixes like skills/foo/**', () => {
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'skills/foo/**',
          patterns: ['Claude Code'],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])
      const scanned = ['skills/foo/SKILL.md']
      const { warnings } = loadAllowlist(root, scanned)
      expect(warnings.filter((w) => w.kind === 'broad-pathglob')).toHaveLength(
        0,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkReferenceIntegrity', () => {
  test('resolves references that exist and flags ones that do not', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'real-agent')
      writeSkill(
        root,
        'foo',
        'See systematic:research:real-agent for details.\n' +
          'Dispatch systematic:research:ghost-agent as needed.\n',
      )

      const targets = collectScanTargets(root)
      const phantoms = checkReferenceIntegrity(root, targets.markdown, [
        'research',
      ])

      expect(phantoms).toHaveLength(1)
      expect(phantoms[0]).toMatchObject({
        file: 'skills/foo/SKILL.md',
        line: 2,
        reference: 'systematic:research:ghost-agent',
        category: 'research',
        name: 'ghost-agent',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports multiple phantoms on the same line', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        'See systematic:research:a and systematic:review:b on the same line.',
      )
      const targets = collectScanTargets(root)
      const phantoms = checkReferenceIntegrity(root, targets.markdown, [
        'research',
        'review',
      ])
      expect(phantoms).toHaveLength(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns empty when categories list is empty', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', 'systematic:research:anything')
      const targets = collectScanTargets(root)
      expect(checkReferenceIntegrity(root, targets.markdown, [])).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('auto-extends coverage when a new category is added at runtime', () => {
    const root = makeFixtureRepo()
    try {
      // Category "new-category" doesn't match the legacy hardcoded regex, but
      // the gate reads agents/ at runtime, so references resolve or fail correctly.
      writeAgent(root, 'new-category', 'foo')
      writeSkill(root, 'bar', 'Dispatch systematic:new-category:foo.\n')

      const categories = discoverCategories(root)
      expect(categories).toContain('new-category')

      const targets = collectScanTargets(root)
      const phantoms = checkReferenceIntegrity(
        root,
        targets.markdown,
        categories,
      )
      expect(phantoms).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkBannedPatterns', () => {
  test('flags banned patterns in markdown outside the allowlist', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', 'Use TaskCreate here.\n')
      const targets = collectScanTargets(root)
      const { hits, exempt } = checkBannedPatterns(
        root,
        [...targets.markdown, ...targets.typescript],
        { exemptions: [] },
      )
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({
        file: 'skills/foo/SKILL.md',
        line: 1,
        pattern: 'TaskCreate',
      })
      expect(exempt).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags banned patterns in typescript files too', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'src/lib/has-ban.ts',
        "const msg = 'Claude Code is not this project'\n",
      )
      const targets = collectScanTargets(root)
      const { hits } = checkBannedPatterns(
        root,
        [...targets.markdown, ...targets.typescript],
        { exemptions: [] },
      )
      expect(hits).toHaveLength(1)
      expect(hits[0]?.pattern).toBe('Claude Code')
      expect(hits[0]?.file).toBe('src/lib/has-ban.ts')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('routes allowlisted files to exemptHits rather than hits', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'cc-skill',
        'Use TaskCreate and `.claude/` paths here.\n',
      )
      const targets = collectScanTargets(root)
      const { hits, exempt } = checkBannedPatterns(
        root,
        [...targets.markdown, ...targets.typescript],
        {
          exemptions: [
            {
              pathGlob: 'skills/cc-skill/**',
              patterns: ['TaskCreate', '.claude/'],
              reason: 'CC-targeting skill; both patterns are intentional.',
            },
          ],
        },
      )
      expect(hits).toEqual([])
      expect(exempt).toHaveLength(2)
      expect(exempt[0]?.reason).toContain('CC-targeting')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('BLIND SPOT: banned pattern split across two lines is not detected (line-by-line scan)', () => {
    // The gate scans each line independently. A banned pattern whose characters
    // span a line break will NOT be detected. This is a known limitation — the
    // patterns are short ASCII strings and in practice are never intentionally
    // split across lines in skill/agent content.
    //
    // This test pins the current behavior. If the implementation moves to a
    // whole-file scan (e.g., content.includes(pattern) before splitting into
    // lines), this test must be updated intentionally.
    const root = makeFixtureRepo()
    try {
      // "Claude Code" split across a line: "Claude\nCode" — neither line
      // contains the full banned string, so the gate returns zero hits.
      writeSkill(root, 'foo', 'Claude\nCode\n')
      const targets = collectScanTargets(root)
      const { hits } = checkBannedPatterns(
        root,
        [...targets.markdown, ...targets.typescript],
        { exemptions: [] },
      )
      // KNOWN LIMITATION: split pattern is not detected.
      expect(hits).toHaveLength(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('only exempts patterns listed in the matching allowlist entry', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'cc-skill',
        'TaskCreate is exempt here.\nAskUserQuestion is not.\n',
      )
      const targets = collectScanTargets(root)
      const { hits, exempt } = checkBannedPatterns(
        root,
        [...targets.markdown, ...targets.typescript],
        {
          exemptions: [
            {
              pathGlob: 'skills/cc-skill/**',
              patterns: ['TaskCreate'],
              reason: 'Only TaskCreate is intentional in this skill.',
            },
          ],
        },
      )
      expect(exempt).toHaveLength(1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.pattern).toBe('AskUserQuestion')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkContentIntegrity (top-level)', () => {
  test('clean repo with no violations returns empty arrays', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'a')
      writeSkill(root, 'foo', 'See systematic:research:a.\n')
      writeFile(root, 'src/lib/foo.ts', '// clean\nexport const x = 1\n')

      const result = checkContentIntegrity(root)
      expect(result.phantomRefs).toEqual([])
      expect(result.bannedPatterns).toEqual([])
      expect(result.scanStats.markdownFiles).toBe(2) // SKILL.md + agent a.md
      expect(result.scanStats.typescriptFiles).toBe(1)
      expect(result.categories).toEqual(['research'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports both phantom refs and banned patterns in one pass', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'real')
      writeSkill(
        root,
        'foo',
        'systematic:research:real is fine.\n' +
          'systematic:research:phantom is not.\n' +
          'TaskCreate is also not.\n',
      )

      const result = checkContentIntegrity(root)
      expect(result.phantomRefs).toHaveLength(1)
      expect(result.phantomRefs[0]?.name).toBe('phantom')
      expect(result.bannedPatterns).toHaveLength(1)
      expect(result.bannedPatterns[0]?.pattern).toBe('TaskCreate')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('propagates allowlist warnings into the result', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', 'Clean content only.\n')
      writeAllowlist(root, [
        {
          pathGlob: 'skills/nonexistent-dir/**',
          patterns: ['Claude Code'],
          reason: 'Reason long enough to pass the minimum-length check.',
        },
      ])

      const result = checkContentIntegrity(root)
      expect(result.allowlistWarnings).toHaveLength(1)
      expect(result.allowlistWarnings[0]?.kind).toBe('zero-match')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Integration smoke: run the gate against the real repo. This is the test
// that catches both v2.4.0 cycle bugs if they reintroduce themselves, and the
// one that actually fails CI when content drifts.
// ---------------------------------------------------------------------------

describe('integration: real repo', () => {
  test('content-integrity gate passes against current HEAD', () => {
    const result = checkContentIntegrity(REPO_ROOT)

    // Zero phantoms, zero non-exempt banned patterns, zero warnings.
    if (result.phantomRefs.length > 0) {
      const details = result.phantomRefs
        .map((p) => `${p.file}:${p.line}  ${p.reference}`)
        .join('\n  ')
      throw new Error(`Phantom references in repo:\n  ${details}`)
    }

    if (result.bannedPatterns.length > 0) {
      const details = result.bannedPatterns
        .map(
          (h) =>
            `${h.file}:${h.line}  ${JSON.stringify(h.pattern)}  ${h.lineContent}`,
        )
        .join('\n  ')
      throw new Error(`Banned patterns outside allowlist:\n  ${details}`)
    }

    expect(result.phantomRefs).toEqual([])
    expect(result.bannedPatterns).toEqual([])
    expect(result.allowlistWarnings).toEqual([])
    expect(result.scanStats.markdownFiles).toBeGreaterThan(0)
    expect(result.scanStats.typescriptFiles).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// CLI smoke: the script exits 0 on a clean repo.
// ---------------------------------------------------------------------------

describe('CLI', () => {
  test('exits 0 against a clean fixture repo', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'a')
      writeSkill(root, 'foo', 'Clean skill. systematic:research:a\n')

      const result = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('content-integrity: clean')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exits 1 when phantom references exist', () => {
    const root = makeFixtureRepo()
    try {
      // At least one agents/ category must exist for the reference regex to build.
      fs.mkdirSync(path.join(root, 'agents', 'research'), { recursive: true })
      writeSkill(root, 'foo', 'systematic:research:ghost\n')

      const result = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain('Phantom references')
      expect(result.stderr.toString()).toContain('ghost')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exits 1 when banned patterns are outside the allowlist', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', 'Reintroduced TaskCreate accidentally.\n')

      const result = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(
        'Banned patterns outside allowlist',
      )
      expect(result.stderr.toString()).toContain('TaskCreate')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exits 1 when the allowlist file contains malformed JSON', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'scripts/.drift-allowlist.json', '{ invalid json }')

      const result = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain('content-integrity:')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
