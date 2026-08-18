import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AllowlistEntry,
  BANNED_PATTERNS,
  checkAgentColors,
  checkAgentMode,
  checkAgentModel,
  checkAgentStemUniqueness,
  checkAgentTemperature,
  checkArgumentHint,
  checkBannedPatterns,
  checkCodemapCompleteness,
  checkContentIntegrity,
  checkDispatchIdentifiers,
  checkFrontmatter,
  checkFrontmatterParseSafety,
  checkHookParity,
  checkMigratedSkillIdentifiers,
  checkReferenceIntegrity,
  checkRemovedNamesOverlap,
  checkSkillReferenceIntegrity,
  checkSubfileReferences,
  collectScanTargets,
  discoverCategories,
  loadAllowlist,
  matchesPathGlob,
  SUBFILE_DIRECTORY_NAMES,
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
  // Bundled agents must omit the `model` field, declare `mode: subagent`,
  // and declare an explicit `temperature:` per content-integrity gate invariants.
  writeFile(
    root,
    `agents/${category}/${name}.md`,
    `---\nname: ${name}\nmode: subagent\ntemperature: 0.3\n---\nagent body`,
  )
}

function writeSkill(root: string, name: string, body: string): void {
  writeFile(root, `skills/${name}/SKILL.md`, body)
}

function writeCompliantSkill(root: string, name: string, body: string): void {
  writeSkill(
    root,
    name,
    `---\nname: ${name}\ndescription: Test skill\n---\n${body}`,
  )
}

function writeMigratedSkill(root: string, name: string, body: string): void {
  writeSkill(
    root,
    name,
    `---\nname: ${name}\ndescription: Test skill\nmetadata:\n  harness-portability: neutral-v1\n---\n${body}`,
  )
}

function writePluginEntryPoint(root: string, hooks: readonly string[]): void {
  const properties = hooks
    .map((hook) => {
      const key = /^[a-z_$][a-z0-9_$]*$/i.test(hook) ? hook : `'${hook}'`
      return `    ${key}: async () => {},`
    })
    .join('\n')
  writeFile(
    root,
    'src/index.ts',
    `const initializePlugin = async () => {\n  return {\n${properties}\n  }\n}\n`,
  )
}

const FIXTURE_PLUGIN_HOOKS = [
  'config',
  'tool',
  'tool.execute.before',
  'tool.execute.after',
  'event',
  'experimental.chat.system.transform',
] as const

// ---------------------------------------------------------------------------

describe('BANNED_PATTERNS', () => {
  test('exposes the 8 global banned patterns documented in the plan', () => {
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

  test('collects the named root documents for source-checked hook parity', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'ARCHITECTURE.md', 'architecture')
      writeFile(root, 'STRUCTURE.md', 'structure')
      writeFile(root, 'AGENTS.md', 'agents')
      writeFile(root, '.github/copilot-instructions.md', 'copilot')
      writeFile(root, 'docs/not-scanned.md', 'should be excluded')

      expect(collectScanTargets(root).rootDocuments).toEqual([
        '.github/copilot-instructions.md',
        'AGENTS.md',
        'ARCHITECTURE.md',
        'STRUCTURE.md',
      ])
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

describe('checkHookParity', () => {
  test('fails for the pre-fix three-hook claim before source scanning is wired', () => {
    const root = makeFixtureRepo()
    try {
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(
        root,
        'ARCHITECTURE.md',
        'The plugin registers three hooks:\n' +
          '- **`config`**\n' +
          '- **`tool`**\n' +
          '- **`event`**\n',
      )

      const violations = checkHookParity(root, ['ARCHITECTURE.md'])

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'ARCHITECTURE.md',
        claimedHooks: ['config', 'event', 'tool'],
        missingHooks: [
          'experimental.chat.system.transform',
          'tool.execute.after',
          'tool.execute.before',
        ],
        unregisteredHooks: [],
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('passes when a document names exactly the registered hooks', () => {
    const root = makeFixtureRepo()
    try {
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(
        root,
        'ARCHITECTURE.md',
        `The plugin registers these hooks:\n${FIXTURE_PLUGIN_HOOKS.map((hook) => `- **\`${hook}\`**`).join('\n')}\n`,
      )

      expect(checkHookParity(root, ['ARCHITECTURE.md'])).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('fails when a document claims a hook that source does not register', () => {
    const root = makeFixtureRepo()
    try {
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(
        root,
        'ARCHITECTURE.md',
        'The plugin registers these hooks:\n' +
          '- **`config`**\n' +
          '- **`not-a-real-hook`**\n',
      )

      const violations = checkHookParity(root, ['ARCHITECTURE.md'])

      expect(violations[0]?.unregisteredHooks).toEqual(['not-a-real-hook'])
      expect(violations[0]?.message).toContain('not-a-real-hook')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('ignores hook discussion that does not assert the registered set', () => {
    const root = makeFixtureRepo()
    try {
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(
        root,
        'ARCHITECTURE.md',
        'Hooks are implemented in src/index.ts.\n',
      )

      expect(checkHookParity(root, ['ARCHITECTURE.md'])).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips a document listed in the explicit exemption set', () => {
    const root = makeFixtureRepo()
    try {
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(
        root,
        'AGENTS.md',
        'The plugin registers three hooks: `config`.\n',
      )

      expect(
        checkHookParity(root, ['AGENTS.md'], new Set(['AGENTS.md'])),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkContentIntegrity — hook parity wiring', () => {
  test('surfaces hook parity violations and counts them toward the gate exit status', () => {
    const root = makeFixtureRepo()
    try {
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(
        root,
        'ARCHITECTURE.md',
        'The plugin registers three hooks:\n' +
          '- **`config`**\n' +
          '- **`tool`**\n' +
          '- **`event`**\n',
      )

      const result = checkContentIntegrity(root)

      expect(result.hookParityViolations).toHaveLength(1)
      expect(result.hookParityViolations[0]?.missingHooks).toContain(
        'tool.execute.before',
      )

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(1)
      expect(proc.stderr.toString()).toContain('Plugin hook parity violations')
      expect(proc.stderr.toString()).toContain('tool.execute.before')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkCodemapCompleteness', () => {
  test('passes when every library module is named in the codemap', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'src/lib/alpha.ts', 'export const alpha = true\n')
      writeFile(root, 'src/lib/nested/beta.ts', 'export const beta = true\n')
      writeFile(
        root,
        'ARCHITECTURE.md',
        '## Codemap\n' +
          '- `src/lib/alpha.ts` — alpha\n' +
          '- `src/lib/nested/beta.ts` — beta\n' +
          '\n## Invariants\n',
      )

      expect(checkCodemapCompleteness(root)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports a module on disk that is absent from the codemap', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'src/lib/alpha.ts', 'export const alpha = true\n')
      writeFile(root, 'ARCHITECTURE.md', '## Codemap\n\n## Invariants\n')

      const violations = checkCodemapCompleteness(root)

      expect(violations).toMatchObject([
        {
          kind: 'missing-from-codemap',
          module: 'src/lib/alpha.ts',
        },
      ])
      expect(violations[0]?.message).toContain('src/lib/alpha.ts')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports a codemap entry whose module no longer exists', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'ARCHITECTURE.md',
        '## Codemap\n- `src/lib/ghost.ts` — deleted\n\n## Invariants\n',
      )

      const violations = checkCodemapCompleteness(root)

      expect(violations).toMatchObject([
        {
          kind: 'missing-on-disk',
          module: 'src/lib/ghost.ts',
        },
      ])
      expect(violations[0]?.message).toContain('src/lib/ghost.ts')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips an excluded module and keeps the exclusion visible in the document', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'src/lib/internal.ts', 'export const internal = true\n')
      const architecture =
        '## Codemap\n\n' +
        '## Codemap exclusions\n' +
        '- `src/lib/internal.ts` — generated compatibility shim, intentionally omitted.\n' +
        '\n## Invariants\n'
      writeFile(root, 'ARCHITECTURE.md', architecture)

      expect(checkCodemapCompleteness(root)).toEqual([])
      expect(
        fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8'),
      ).toContain('`src/lib/internal.ts`')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkContentIntegrity — codemap completeness wiring', () => {
  test('counts codemap violations and the CLI exits non-zero when an entry is removed', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'src/lib/alpha.ts', 'export const alpha = true\n')
      writePluginEntryPoint(root, FIXTURE_PLUGIN_HOOKS)
      writeFile(root, 'ARCHITECTURE.md', '## Codemap\n\n## Invariants\n')

      const result = checkContentIntegrity(root)

      expect(result.codemapCompletenessViolations).toHaveLength(1)
      expect(result.codemapCompletenessViolations[0]?.module).toBe(
        'src/lib/alpha.ts',
      )

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(1)
      expect(proc.stderr.toString()).toContain(
        'Architecture codemap completeness violations',
      )
      expect(proc.stderr.toString()).toContain('src/lib/alpha.ts')
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

  test('isBroadPathGlob: agents/** (1 segment) is broad; agents/research/** (2 segments) is not', () => {
    // Pins the ≥2-segment threshold so a comment/code mismatch is caught immediately.
    const root = makeFixtureRepo()
    try {
      writeAllowlist(root, [
        {
          pathGlob: 'agents/**',
          patterns: ['Claude Code'],
          reason:
            'Broad glob covering all agents, intentionally broad for test.',
        },
        {
          pathGlob: 'agents/research/**',
          patterns: ['Claude Code'],
          reason: 'Narrow glob covering only research agents for this test.',
        },
      ])
      const scanned = ['agents/research/real-agent.md']
      const { warnings } = loadAllowlist(root, scanned)
      const broadWarnings = warnings.filter((w) => w.kind === 'broad-pathglob')
      // agents/** → 1 segment → broad
      expect(broadWarnings.some((w) => w.pathGlob === 'agents/**')).toBe(true)
      // agents/research/** → 2 segments → specific
      expect(
        broadWarnings.some((w) => w.pathGlob === 'agents/research/**'),
      ).toBe(false)
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

describe('checkSkillReferenceIntegrity', () => {
  test('flags a phantom ce:<name> reference with no matching skills/ce-<name>/ dir', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        'Route to ce:debug for investigation before planning.\n',
      )
      const targets = collectScanTargets(root)
      const phantoms = checkSkillReferenceIntegrity(root, targets.markdown)

      expect(phantoms).toHaveLength(1)
      expect(phantoms[0]).toMatchObject({
        file: 'skills/foo/SKILL.md',
        line: 1,
        reference: 'ce:debug',
        name: 'debug',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag a real ce:<name> reference with a matching skill dir', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'ce-work', 'body')
      writeSkill(root, 'foo', 'See ce:work for execution.\n')
      const targets = collectScanTargets(root)
      const phantoms = checkSkillReferenceIntegrity(root, targets.markdown)
      expect(phantoms).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ce-review bounded review prompt contract', () => {
  test('shared reviewer prompt stays diff-first, bounded, and stop-conditioned', () => {
    const subagentTemplate = fs.readFileSync(
      path.join(REPO_ROOT, 'skills/ce-review/references/subagent-template.md'),
      'utf8',
    )

    expect(subagentTemplate).toMatch(/diff is the primary source of truth/i)
    expect(subagentTemplate).toMatch(
      /read each unresolved surrounding range or symbol once/i,
    )
    expect(subagentTemplate).toMatch(
      /re-read only when a concrete ambiguity remains or the file changed/i,
    )
    expect(subagentTemplate).toMatch(
      /stop and (?:emit|return) (?:a )?(?:finding|verdict).*evidence is sufficient/i,
    )
    expect(subagentTemplate).toMatch(
      /within this bounded pass.*explicit blocker or residual risk/i,
    )
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

describe('checkFrontmatter', () => {
  test('allows minimal skill frontmatter with name and description', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(root, 'foo', 'body')
      const targets = collectScanTargets(root)
      expect(checkFrontmatter(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('allows every runtime-recognized skill frontmatter field', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        [
          '---',
          'name: foo',
          'description: Test skill',
          'argument-hint: "[topic]"',
          'disable-model-invocation: true',
          'allowed-tools: read, grep',
          'license: MIT',
          'compatibility: opencode',
          'metadata:',
          '  owner: systematic',
          'user-invocable: true',
          'agent: general',
          'model: anthropic/claude-haiku-4-5',
          'context: fork',
          'subtask: true',
          '---',
          'body',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      expect(checkFrontmatter(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags banned preconditions field but allows context and subtask', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        [
          '---',
          'name: foo',
          'description: Test skill',
          'preconditions: must run first',
          'context: fork',
          'subtask: true',
          '---',
          'body',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkFrontmatter(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'skills/foo/SKILL.md',
        rule: 'banned-field',
        field: 'preconditions',
      })
      expect(violations[0]?.message).toContain('preconditions')
      expect(violations[0]?.remediation).toContain('systematic:writing-skills')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags unknown fields one violation per field', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        [
          '---',
          'name: foo',
          'description: Test skill',
          'experimental: true',
          'owner: platform',
          '---',
          'body',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkFrontmatter(root, targets.markdown)
      expect(violations.map((v) => v.field).sort()).toEqual([
        'experimental',
        'owner',
      ])
      expect(violations.every((v) => v.rule === 'unknown-field')).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags missing, null, and empty required fields distinctly', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'missing-name',
        '---\ndescription: Test skill\n---\nbody',
      )
      writeSkill(
        root,
        'bare-name',
        '---\nname:\ndescription: Test skill\n---\nbody',
      )
      writeSkill(
        root,
        'null-name',
        '---\nname: ~\ndescription: Test skill\n---\nbody',
      )
      writeSkill(
        root,
        'empty-name',
        '---\nname: ""\ndescription: Test skill\n---\nbody',
      )
      writeSkill(
        root,
        'blank-name',
        '---\nname: "   "\ndescription: Test skill\n---\nbody',
      )
      writeSkill(
        root,
        'blank-description',
        '---\nname: blank-description\ndescription: "   "\n---\nbody',
      )
      writeSkill(
        root,
        'missing-description',
        '---\nname: missing-description\n---\nbody',
      )

      const targets = collectScanTargets(root)
      const violations = checkFrontmatter(root, targets.markdown)
      expect(
        violations.map((v) => `${v.file}:${v.field}:${v.rule}`).sort(),
      ).toEqual([
        'skills/bare-name/SKILL.md:name:missing-required-field',
        'skills/blank-description/SKILL.md:description:empty-required-field',
        'skills/blank-name/SKILL.md:name:empty-required-field',
        'skills/empty-name/SKILL.md:name:empty-required-field',
        'skills/missing-description/SKILL.md:description:missing-required-field',
        'skills/missing-name/SKILL.md:name:missing-required-field',
        'skills/null-name/SKILL.md:name:missing-required-field',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('short-circuits parse edge cases without cascading field violations', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'missing-frontmatter', '# no frontmatter\n')
      writeSkill(
        root,
        'malformed-frontmatter',
        '---\nname: [unterminated\ndescription: Test skill\n---\nbody',
      )

      const targets = collectScanTargets(root)
      const violations = checkFrontmatter(root, targets.markdown)
      expect(violations).toHaveLength(2)
      expect(
        violations.map((v) => `${v.file}:${v.rule}:${v.field ?? ''}`).sort(),
      ).toEqual([
        'skills/malformed-frontmatter/SKILL.md:malformed-frontmatter:',
        'skills/missing-frontmatter/SKILL.md:missing-frontmatter:',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans only skill entry files', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/a.md',
        '---\nname: a\nexperimental: true\n---\nagent',
      )
      writeFile(
        root,
        'skills/foo/references/ref.md',
        '---\nexperimental: true\n---\nreference',
      )
      writeCompliantSkill(root, 'foo', 'body')
      const targets = collectScanTargets(root)
      expect(checkFrontmatter(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkFrontmatter — deprecated block surfaces via unknown-field rule', () => {
  test('bundled skill with a deprecated block gets an unknown-field violation', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'my-skill',
        [
          '---',
          'name: my-skill',
          'description: A skill',
          'deprecated:',
          '  since: v2.19.0',
          '  removal: v3.0.0',
          '  reason: "Use the new-skill instead."',
          '---',
          'body',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkFrontmatter(root, targets.markdown)
      const match = violations.filter(
        (v) => v.rule === 'unknown-field' && v.field === 'deprecated',
      )
      expect(match).toHaveLength(1)
      expect(match[0]?.file).toBe('skills/my-skill/SKILL.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkMigratedSkillIdentifiers', () => {
  test.each([
    'task(',
    'subagent_type',
    'todowrite',
    'TodoWrite',
    'request_user_input',
    'ask_user',
    'AskUserQuestion',
    'update_plan',
    'question',
  ] as const)('flags %s in migrated skill prose', (identifier) => {
    const root = makeFixtureRepo()
    try {
      const token = identifier === 'question' ? '`question`' : identifier
      writeMigratedSkill(root, 'migrated', `Use ${token} here.\n`)
      const violations = checkMigratedSkillIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )
      expect(violations.map((v) => v.identifier)).toEqual([identifier])
      expect(violations[0]?.line).toBe(7)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags the backtick-delimited question token but not plain prose', () => {
    const root = makeFixtureRepo()
    try {
      writeMigratedSkill(
        root,
        'migrated',
        'Use `question` here.\nUse question here.\n',
      )
      const violations = checkMigratedSkillIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )
      expect(violations.map((v) => v.identifier)).toEqual(['question'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('allows task( inside a profile fence', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'skills/using-systematic/references/opencode-profile.md',
        '```text\ntask(\n```\n',
      )
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('allows identifiers in profile prose', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'skills/using-systematic/references/pi-profile.md',
        'Do not mention todowrite in prose.\n',
      )
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('honors the marker when metadata has a boolean sibling value', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'malformed-metadata',
        '---\nname: malformed-metadata\ndescription: Test skill\nmetadata:\n  harness-portability: neutral-v1\n  enabled: true\n---\nUse task( here.\n',
      )
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('honors the marker when metadata has an array sibling value', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'array-metadata',
        '---\nname: array-metadata\ndescription: Test skill\nmetadata:\n  harness-portability: neutral-v1\n  tags: [one, two]\n---\nUse task( here.\n',
      )
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not scan unmigrated skills', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(root, 'unmigrated', 'Use task( here.\n')
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exempts the sanctioned interaction idiom line', () => {
    const root = makeFixtureRepo()
    try {
      writeMigratedSkill(
        root,
        'idiom',
        'Use request_user_input in OpenCode and ask_user in Pi.\n',
      )
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not exempt non-question identifiers on the sanctioned idiom line', () => {
    const root = makeFixtureRepo()
    try {
      writeMigratedSkill(
        root,
        'idiom-with-todo',
        'Use question in OpenCode and todowrite in Pi.\n',
      )
      expect(
        checkMigratedSkillIdentifiers(
          root,
          collectScanTargets(root).markdown,
        ).map((v) => v.identifier),
      ).toEqual(['todowrite'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exempts backtick-delimited question on the sanctioned idiom line', () => {
    const root = makeFixtureRepo()
    try {
      writeMigratedSkill(
        root,
        'idiom-question',
        'Use `question` in OpenCode and `question` in Pi.\n',
      )
      expect(
        checkMigratedSkillIdentifiers(root, collectScanTargets(root).markdown),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags banned identifiers in description frontmatter', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'frontmatter-description',
        '---\nname: frontmatter-description\ndescription: Use task( here\nmetadata:\n  harness-portability: neutral-v1\n---\nBody\n',
      )
      const violations = checkMigratedSkillIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )
      expect(violations).toMatchObject([{ identifier: 'task(', line: 3 }])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags banned identifiers in argument-hint frontmatter', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'frontmatter-hint',
        '---\nname: frontmatter-hint\ndescription: Test\nargument-hint: task( input\nmetadata:\n  harness-portability: neutral-v1\n---\nBody\n',
      )
      const violations = checkMigratedSkillIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )
      expect(violations).toMatchObject([{ identifier: 'task(', line: 4 }])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkAgentColors', () => {
  test('allows OpenCode theme tokens and hex colors', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/info.md',
        '---\nname: info\ncolor: info\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/accent.md',
        '---\nname: accent\ncolor: accent\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/hex.md',
        '---\nname: hex\ncolor: "#abcdef"\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/no-color.md',
        '---\nname: no-color\n---\nbody',
      )
      const targets = collectScanTargets(root)
      expect(checkAgentColors(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags ad-hoc color names rejected by OpenCode schema', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/purple.md',
        '---\nname: purple\ncolor: purple\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/blue.md',
        '---\nname: blue\ncolor: blue\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/short-hex.md',
        '---\nname: short-hex\ncolor: "#abc"\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentColors(root, targets.markdown)
      expect(violations.map((v) => v.file).sort()).toEqual([
        'agents/research/blue.md',
        'agents/research/purple.md',
        'agents/research/short-hex.md',
      ])
      expect(violations.every((v) => v.message.includes('OpenCode'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans only agent markdown files', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(root, 'foo', 'color: purple\n')
      writeFile(root, 'skills/foo/references/ref.md', 'color: purple\n')
      writeAgent(root, 'research', 'a')
      const targets = collectScanTargets(root)
      expect(checkAgentColors(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkAgentModel', () => {
  test('allows agents with model field omitted', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'a')
      const targets = collectScanTargets(root)
      expect(checkAgentModel(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags any present model value (including inherit, hardcoded, empty, null)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/inherit.md',
        '---\nname: inherit\nmodel: inherit\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/hardcoded.md',
        '---\nname: hardcoded\nmodel: anthropic/claude-haiku-4-5\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/empty.md',
        '---\nname: empty\nmodel: ""\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/null.md',
        '---\nname: null\nmodel: ~\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentModel(root, targets.markdown)
      expect(violations.map((v) => v.file).sort()).toEqual([
        'agents/research/empty.md',
        'agents/research/hardcoded.md',
        'agents/research/inherit.md',
        'agents/research/null.md',
      ])
      expect(
        violations.every((v) =>
          v.message.includes('Bundled agents must omit the `model` field'),
        ),
      ).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('ignores non-object frontmatter (no model key to flag)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/list.md',
        '---\n- model: inherit\n---\nbody',
      )

      const targets = collectScanTargets(root)
      expect(checkAgentModel(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans only agent markdown files', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(root, 'foo', 'model: anthropic/claude-haiku-4-5\n')
      writeFile(root, 'skills/foo/references/ref.md', 'model: anthropic/x\n')
      writeAgent(root, 'research', 'a')
      const targets = collectScanTargets(root)
      expect(checkAgentModel(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkAgentMode', () => {
  test('returns no violations when all agents declare mode: subagent', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/analyst.md',
        '---\nname: analyst\nmode: subagent\n---\nbody',
      )
      writeFile(
        root,
        'agents/review/sentinel.md',
        '---\nname: sentinel\nmode: subagent\n---\nbody',
      )
      const targets = collectScanTargets(root)
      expect(checkAgentMode(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent with no mode field', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/no-mode.md',
        '---\nname: no-mode\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentMode(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/no-mode.md')
      expect(violations[0]?.message).toContain('mode: subagent')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent with mode set to a non-subagent value', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/wrong-mode.md',
        '---\nname: wrong-mode\nmode: all\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentMode(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/wrong-mode.md')
      expect(violations[0]?.message).toContain('mode: subagent')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag non-agent markdown files under agents/ (e.g. README-style files excluded by isAgentFile)', () => {
    const root = makeFixtureRepo()
    try {
      // A file at agents/README.md has only 2 path parts — isAgentFile requires exactly 3.
      writeFile(root, 'agents/README.md', '---\nname: readme\n---\nbody')
      // A skill file is also not an agent file.
      writeCompliantSkill(root, 'foo', 'body')
      const targets = collectScanTargets(root)
      expect(checkAgentMode(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans only agent markdown files, not skill files', () => {
    const root = makeFixtureRepo()
    try {
      // Skill with no mode field — must not be flagged.
      writeCompliantSkill(root, 'foo', 'body')
      // Agent with correct mode — no violation.
      writeFile(
        root,
        'agents/research/a.md',
        '---\nname: a\nmode: subagent\n---\nbody',
      )
      const targets = collectScanTargets(root)
      expect(checkAgentMode(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent whose frontmatter is a valid YAML list (non-object top-level)', () => {
    const root = makeFixtureRepo()
    try {
      // A YAML list at the top level is valid YAML but not a record — the agent
      // cannot declare mode: subagent, so it must be flagged.
      writeFile(
        root,
        'agents/research/list-fm.md',
        '---\n- name: list-fm\n- mode: subagent\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentMode(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/list-fm.md')
      expect(violations[0]?.message).toContain('mode: subagent')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkAgentTemperature', () => {
  test('returns no violations when all agents declare an explicit temperature', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/analyst.md',
        '---\nname: analyst\nmode: subagent\ntemperature: 0.2\n---\nbody',
      )
      writeFile(
        root,
        'agents/review/sentinel.md',
        '---\nname: sentinel\nmode: subagent\ntemperature: 0.1\n---\nbody',
      )
      const targets = collectScanTargets(root)
      expect(checkAgentTemperature(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent with no temperature field', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/no-temp.md',
        '---\nname: no-temp\nmode: subagent\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentTemperature(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/no-temp.md')
      expect(violations[0]?.message).toContain('temperature')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent whose frontmatter is a valid YAML list (non-object top-level, fail-closed)', () => {
    // A YAML list at the top level is valid YAML but not a record — the agent
    // cannot declare temperature, so it must be flagged (fail closed, not skipped).
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/list-fm.md',
        '---\n- name: list-fm\n- temperature: 0.3\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentTemperature(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/list-fm.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans only agent markdown files, not skill files', () => {
    const root = makeFixtureRepo()
    try {
      // Skill with no temperature field — must not be flagged.
      writeCompliantSkill(root, 'foo', 'body')
      // Agent with explicit temperature — no violation.
      writeFile(
        root,
        'agents/research/a.md',
        '---\nname: a\nmode: subagent\ntemperature: 0.3\n---\nbody',
      )
      const targets = collectScanTargets(root)
      expect(checkAgentTemperature(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent with temperature: null (null is not a finite number)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/null-temp.md',
        '---\nname: null-temp\nmode: subagent\ntemperature: null\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentTemperature(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/null-temp.md')
      expect(violations[0]?.message).toContain('temperature')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent with temperature: "0.3" (string is not a finite number)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/string-temp.md',
        '---\nname: string-temp\nmode: subagent\ntemperature: "0.3"\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentTemperature(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/string-temp.md')
      expect(violations[0]?.message).toContain('temperature')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags an agent with empty temperature: (YAML null, not a finite number)', () => {
    // `temperature:` with no value parses as null in YAML — same as temperature: null.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/empty-temp.md',
        '---\nname: empty-temp\nmode: subagent\ntemperature:\n---\nbody',
      )
      const targets = collectScanTargets(root)
      const violations = checkAgentTemperature(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('agents/research/empty-temp.md')
      expect(violations[0]?.message).toContain('temperature')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('passes for an agent with temperature: 0.3 (finite number)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/valid-temp.md',
        '---\nname: valid-temp\nmode: subagent\ntemperature: 0.3\n---\nbody',
      )
      const targets = collectScanTargets(root)
      expect(checkAgentTemperature(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('integration: gate passes against the current hardened real tree (all agents have explicit temperature)', () => {
    const violations = checkAgentTemperature(
      REPO_ROOT,
      collectScanTargets(REPO_ROOT).markdown,
    )
    expect(violations).toEqual([])
  })
})

describe('checkContentIntegrity — agentTemperatureViolations wiring', () => {
  test('populates agentTemperatureViolations when an agent is missing temperature', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/no-temp.md',
        '---\nname: no-temp\nmode: subagent\n---\nagent body',
      )

      const result = checkContentIntegrity(root)

      expect(result.agentTemperatureViolations).toHaveLength(1)
      expect(result.agentTemperatureViolations[0]?.file).toBe(
        'agents/research/no-temp.md',
      )
      expect(result.agentTemperatureViolations[0]?.message).toContain(
        'temperature',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('agentTemperatureViolations counts toward totalViolations (CLI exits 1)', () => {
    // Proves the wiring end-to-end: agentTemperatureViolations must cause the
    // CLI to exit 1. A result with only agentTemperatureViolations non-empty
    // and all other arrays empty must produce a non-zero exit — deleting the
    // agentTemperatureViolations term from totalViolations() would break this.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/no-temp.md',
        '---\nname: no-temp\nmode: subagent\n---\nagent body',
      )

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('printAgentTemperatureViolations — CLI print path', () => {
  test('emits the agent-temperature-violation heading and offending file to stderr', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'agents/research/no-temp.md',
        '---\nname: no-temp\nmode: subagent\n---\nagent body',
      )

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(proc.exitCode).toBe(1)
      const stderr = proc.stderr.toString()
      expect(stderr).toContain('Agent temperature violations (1)')
      expect(stderr).toContain('agents/research/no-temp.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkAgentStemUniqueness', () => {
  test('flags duplicate bundled agent stems across categories with both paths', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'duplicate-reviewer')
      writeAgent(root, 'review', 'duplicate-reviewer')

      const targets = collectScanTargets(root)
      const violations = checkAgentStemUniqueness(root, targets.markdown)

      expect(violations).toHaveLength(1)
      expect(violations[0]?.stem).toBe('duplicate-reviewer')
      expect(violations[0]?.files.sort()).toEqual([
        'agents/research/duplicate-reviewer.md',
        'agents/review/duplicate-reviewer.md',
      ])
      expect(violations[0]?.message).toContain('stem-only OpenCode agent keys')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('allows unique bundled agent stems across categories', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'repo-research-analyst')
      writeAgent(root, 'review', 'security-sentinel')

      const targets = collectScanTargets(root)
      expect(checkAgentStemUniqueness(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkDispatchIdentifiers', () => {
  test('flags unresolvable subagent types, including examples in fenced code', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'workflow', 'systematic-implementer')
      writeAgent(root, 'research', 'repo-research-analyst')
      writeSkill(
        root,
        'foo',
        'The `subagent_type` parameter selects a specialist.\n' +
          'task({ subagent_type: "NotARealAgent" })\n' +
          '```typescript\n' +
          "task({ subagent_type: 'AlsoNotReal' })\n" +
          '```\n' +
          'task({ subagent_type: repo-research-analyst })\n' +
          "task({ subagent_type: 'repo-research-analyst' })\n" +
          'task({ subagent_type: "systematic-implementer" })\n',
      )

      const targets = collectScanTargets(root)
      const violations = checkDispatchIdentifiers(root, targets.markdown)

      expect(violations).toHaveLength(2)
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unresolvable-subagent-type',
            file: 'skills/foo/SKILL.md',
            line: 2,
            identifier: 'NotARealAgent',
          }),
          expect.objectContaining({
            kind: 'unresolvable-subagent-type',
            file: 'skills/foo/SKILL.md',
            line: 4,
            identifier: 'AlsoNotReal',
          }),
        ]),
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not swallow the closing backtick of an inline-code dispatch example', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'workflow', 'systematic-implementer')
      writeAgent(root, 'research', 'repo-research-analyst')
      writeSkill(
        root,
        'foo',
        'Bundled agent inline: `subagent_type: repo-research-analyst`\n' +
          'Another bundled agent: `subagent_type: systematic-implementer`\n' +
          'Bogus inline: `subagent_type: NotARealAgent`\n',
      )

      const targets = collectScanTargets(root)
      const violations = checkDispatchIdentifiers(root, targets.markdown)

      // The bundled values must not fire. An unquoted capture that ran to the
      // closing backtick would yield "repo-research-analyst`", which resolves to
      // nothing and false-positives on correct content.
      expect(violations).toHaveLength(1)
      expect(violations[0]).toEqual(
        expect.objectContaining({
          kind: 'unresolvable-subagent-type',
          line: 3,
          identifier: 'NotARealAgent',
        }),
      )
      expect(violations[0]?.identifier).not.toContain('`')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags quoted subagent_type property keys without accepting mismatched quotes', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        'JSON dispatch: task({ "subagent_type": "ce-implementer" })\n' +
          'Mismatched dispatch: task({ "subagent_type\': "ce-implementer" })\n',
      )

      const violations = checkDispatchIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        kind: 'unresolvable-subagent-type',
        line: 1,
        identifier: 'ce-implementer',
      })
      expect(violations[0]?.message).toContain(
        'use a filename stem from agents/**',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('stops unquoted captures at prose quotes and still flags unresolved quoted error messages', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'repo-research-analyst')
      writeSkill(
        root,
        'foo',
        'If you see "Unknown subagent_type: ce-architecture-strategist", use the canonical form.\n' +
          'The documented value is "subagent_type: repo-research-analyst".\n',
      )

      const violations = checkDispatchIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        kind: 'unresolvable-subagent-type',
        line: 1,
        identifier: 'ce-architecture-strategist',
      })
      expect(violations[0]?.identifier).not.toMatch(/["']/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not close a longer fence with a shorter same-character fence', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'review', 'architecture-strategist')
      writeSkill(
        root,
        'foo',
        '````\n' +
          'Opened with FOUR backticks.\n' +
          '```\n' +
          'This near-miss remains inside the outer fence: `ce-architecture-strategist`\n' +
          '````\n',
      )

      expect(
        checkDispatchIdentifiers(root, collectScanTargets(root).markdown),
      ).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans each inline-code token independently when one token is a path', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'review', 'architecture-strategist')
      writeSkill(
        root,
        'foo',
        '`agents/review/architecture-strategist.md or ce-architecture-strategist`\n',
      )

      const violations = checkDispatchIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        kind: 'near-miss-agent-identifier',
        identifier: 'ce-architecture-strategist',
        matchedStem: 'architecture-strategist',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag a skill directory name that shadows an agent stem', () => {
    const root = makeFixtureRepo()
    try {
      // A bundled agent literally named `plan` makes `ce-plan` look like a
      // near miss. Without the skill-name exclusion, every reference to the
      // real `ce-plan` skill across the bundle would fail at once.
      writeAgent(root, 'workflow', 'plan')
      writeSkill(root, 'ce-plan', 'Placeholder.\n')
      writeSkill(
        root,
        'foo',
        'Real skill reference: `ce-plan`\n' +
          'Genuine near miss: `ce-nonexistent-plan`\n',
      )

      const violations = checkDispatchIdentifiers(
        root,
        collectScanTargets(root).markdown,
      )

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        kind: 'near-miss-agent-identifier',
        identifier: 'ce-nonexistent-plan',
        matchedStem: 'plan',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags near-miss bundled agent identifiers only in inline code', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'review', 'architecture-strategist')
      writeSkill(
        root,
        'foo',
        'Use `ce-architecture-strategist` when dispatching.\n' +
          'The path `agents/review/architecture-strategist.md` is valid.\n' +
          'The canonical reference `systematic:review:architecture-strategist` is valid.\n' +
          'Skill names `ce-plan` and `ce-review` are not agent identifiers.\n' +
          'Plain ce-architecture-strategist prose is not an inline-code token.\n',
      )

      const targets = collectScanTargets(root)
      const violations = checkDispatchIdentifiers(root, targets.markdown)

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        kind: 'near-miss-agent-identifier',
        file: 'skills/foo/SKILL.md',
        line: 1,
        identifier: 'ce-architecture-strategist',
        matchedStem: 'architecture-strategist',
      })
      expect(violations[0]?.message).toContain(
        'Did you mean `architecture-strategist`?',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkContentIntegrity — dispatch identifier wiring', () => {
  test('surfaces a dispatch-only violation and counts it toward the CLI exit status', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(
        root,
        'foo',
        'task({ subagent_type: "not-a-bundled-agent" })\n',
      )

      const result = checkContentIntegrity(root)

      expect(result.dispatchIdentifierViolations).toHaveLength(1)
      expect(result.dispatchIdentifierViolations[0]?.identifier).toBe(
        'not-a-bundled-agent',
      )
      expect(result.phantomRefs).toEqual([])
      expect(result.phantomSkillRefs).toEqual([])
      expect(result.brokenSubfileRefs).toEqual([])
      expect(result.bannedPatterns).toEqual([])
      expect(result.frontmatterViolations).toEqual([])
      expect(result.parseSafetyViolations).toEqual([])
      expect(result.agentModelViolations).toEqual([])
      expect(result.agentModeViolations).toEqual([])
      expect(result.agentColorViolations).toEqual([])
      expect(result.agentStemViolations).toEqual([])
      expect(result.agentTemperatureViolations).toEqual([])
      expect(result.argumentHintViolations).toEqual([])
      expect(result.migratedSkillIdentifierViolations).toEqual([])
      expect(result.removedNamesOverlapViolations).toEqual([])

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(1)
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
      writeCompliantSkill(root, 'foo', 'See systematic:research:a.\n')
      writeFile(root, 'src/lib/foo.ts', '// clean\nexport const x = 1\n')

      const result = checkContentIntegrity(root)
      expect(result.phantomRefs).toEqual([])
      expect(result.brokenSubfileRefs).toEqual([])
      expect(result.bannedPatterns).toEqual([])
      expect(result.frontmatterViolations).toEqual([])
      expect(result.agentModelViolations).toEqual([])
      expect(result.agentStemViolations).toEqual([])
      expect(result.dispatchIdentifierViolations).toEqual([])
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

  test('exposes frontmatter and agent-model violations in one pass', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        '---\nname: foo\ndescription: Test skill\npreconditions: before use\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/a.md',
        '---\nname: a\nmodel: inherit\n---\nagent',
      )

      const result = checkContentIntegrity(root)
      expect(result.frontmatterViolations).toHaveLength(1)
      expect(result.frontmatterViolations[0]?.rule).toBe('banned-field')
      expect(result.agentModelViolations).toHaveLength(1)
      expect(result.agentModelViolations[0]?.file).toBe('agents/research/a.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exposes duplicate bundled agent stem violations in one pass', () => {
    const root = makeFixtureRepo()
    try {
      writeAgent(root, 'research', 'same-stem')
      writeAgent(root, 'review', 'same-stem')

      const result = checkContentIntegrity(root)

      expect(result.agentStemViolations).toHaveLength(1)
      expect(result.agentStemViolations[0]?.files.sort()).toEqual([
        'agents/research/same-stem.md',
        'agents/review/same-stem.md',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('populates agentModeViolations when an agent is missing mode: subagent', () => {
    const root = makeFixtureRepo()
    try {
      // Agent without mode field — the gate must surface this through the
      // aggregate entry point, proving the wiring from checkAgentMode into
      // checkContentIntegrity is intact.
      writeFile(
        root,
        'agents/research/no-mode.md',
        '---\nname: no-mode\n---\nagent body',
      )

      const result = checkContentIntegrity(root)

      expect(result.agentModeViolations).toHaveLength(1)
      expect(result.agentModeViolations[0]?.file).toBe(
        'agents/research/no-mode.md',
      )
      expect(result.agentModeViolations[0]?.message).toContain('mode: subagent')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// checkFrontmatterParseSafety — adversarial fixture suite
// ---------------------------------------------------------------------------

describe('checkFrontmatterParseSafety', () => {
  test('flags unquoted value containing space-hash (truncation trigger)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: cache miss # under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'problem',
      })
      expect(violations[0]?.message).toContain('#')
      expect(violations[0]?.remediation).toContain('Quote')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a double-quoted value containing hash (safe)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: "cache miss # under load"',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a single-quoted value containing hash (safe)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          "problem: 'cache miss # under load'",
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a full-line YAML comment (not a value)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          '# this is a real YAML comment',
          'problem: cache miss',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a URL with #fragment inside a quoted value', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'url: "https://example.com/page#section"',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags a hash at the start of an unquoted value (value-start # is a comment trigger)', () => {
    // `tag: #important` — the ban rule applies: value starts with #.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        ['---', 'tag: #important', 'date: 2026-01-01', '---', 'body'].join(
          '\n',
        ),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'tag',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a list item line (not a flat key: scalar)', () => {
    // List items like `  - cache miss # under load` are not flat key: scalar lines.
    // The check skips them to avoid false positives on YAML arrays.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'symptoms:',
          '  - cache miss # under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a hash inside a value when no space precedes it', () => {
    // e.g. `title: MDX {#anchor} syntax` — {# has no space before #
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'title: MDX heading anchor syntax `{#anchor}` crashes the build',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns empty for a file with no frontmatter', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'docs/solutions/test-doc.md', '# Just a heading\n\nbody')
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns empty for a file with clean frontmatter (no space-hash in values)', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: cache miss under load',
          'date: 2026-01-01',
          'severity: high',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags multiple truncating fields in the same file', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: cache miss # under load',
          'solution: add index # on column',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(2)
      const fields = violations.map((v) => v.field).sort()
      expect(fields).toEqual(['problem', 'solution'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags tab-before-hash (tab is whitespace, same comment trigger as space)', () => {
    // `problem: cache miss\t# under load` — tab counts as whitespace; the ban
    // rule applies: unquoted value with whitespace-before-#.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: cache miss\t# under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'problem',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags hash-at-value-start (value-start # is a comment trigger)', () => {
    // `tag: #important` — the ban rule applies: value starts with #.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        ['---', 'tag: #important', 'date: 2026-01-01', '---', 'body'].join(
          '\n',
        ),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'tag',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags anchor-prefixed value with inline comment (whitespace-before-#)', () => {
    // `problem: &p cache miss # under load` — unquoted value with whitespace-before-#;
    // the anchor prefix does not exempt the line from the ban.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: &p cache miss # under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'problem',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag anchor-prefixed value with no inline comment', () => {
    // `key: &anchor value` — has no `#`, so the ban rule does not apply.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        ['---', 'key: &anchor value', 'date: 2026-01-01', '---', 'body'].join(
          '\n',
        ),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags trailing comment on boolean scalar (unquoted value with whitespace-#)', () => {
    // `draft: false # intentionally published` — the ban rule applies to all
    // unquoted values with whitespace-before-#, including booleans. Policy:
    // inline comments in solution-doc frontmatter are banned regardless of
    // whether the YAML parser happens to preserve the value.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'draft: false # intentionally published',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'draft',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags trailing comment on date string scalar (unquoted value with whitespace-#)', () => {
    // `date: 2026-01-01 # created` — the ban rule applies: unquoted value with
    // whitespace-before-#. Authors should quote: date: "2026-01-01".
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'problem: cache miss',
          'date: 2026-01-01 # created',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        rule: 'parse-safety',
        field: 'date',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags string value with trailing inline comment (whitespace-before-#)', () => {
    // `title: My Feature # draft` — unquoted value with whitespace-before-#; banned.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'title: My Feature # draft',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'title',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags value with multiple spaces before hash (multi-space whitespace-before-#)', () => {
    // `field: value  # comment` (2+ spaces) — whitespace-before-# still matches; banned.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'field: value  # comment',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        file: 'docs/solutions/test-doc.md',
        rule: 'parse-safety',
        field: 'field',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT flag a space-hash inside a nested (indented) mapping value', () => {
    // Indented lines are out of scope by design — the check covers flat
    // top-level `key: value` lines only. A `#` inside a nested mapping value
    // such as `  note: cache miss # under load` is not scanned.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/test-doc.md',
        [
          '---',
          'meta:',
          '  note: cache miss # under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const violations = checkFrontmatterParseSafety(root, [
        'docs/solutions/test-doc.md',
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// collectScanTargets — docs/solutions/ isolation
// ---------------------------------------------------------------------------

describe('collectScanTargets — docs/solutions/ isolation', () => {
  test('solutionMarkdown collects markdown under docs/solutions/', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(root, 'docs/solutions/best-practices/foo.md', '# foo')
      writeFile(root, 'docs/solutions/workflow-issues/bar.md', '# bar')
      writeFile(
        root,
        'skills/my-skill/SKILL.md',
        '---\nname: x\ndescription: y\n---\nbody',
      )

      const targets = collectScanTargets(root)

      // solutionMarkdown must contain the docs/solutions/ files
      expect(targets.solutionMarkdown).toContain(
        'docs/solutions/best-practices/foo.md',
      )
      expect(targets.solutionMarkdown).toContain(
        'docs/solutions/workflow-issues/bar.md',
      )

      // docs/solutions/ files must NOT appear in targets.markdown (banned-pattern scope)
      expect(targets.markdown).not.toContain(
        'docs/solutions/best-practices/foo.md',
      )
      expect(targets.markdown).not.toContain(
        'docs/solutions/workflow-issues/bar.md',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('solutionMarkdown is empty when docs/solutions/ does not exist', () => {
    const root = makeFixtureRepo()
    try {
      const targets = collectScanTargets(root)
      expect(targets.solutionMarkdown).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('existing markdown and typescript targets are unaffected by docs/solutions/ addition', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'skills/foo/SKILL.md',
        '---\nname: foo\ndescription: bar\n---\nbody',
      )
      writeFile(root, 'agents/research/a.md', '---\nname: a\n---\nagent')
      writeFile(root, 'src/lib/foo.ts', '// ts')
      writeFile(root, 'docs/solutions/best-practices/doc.md', '# doc')

      const targets = collectScanTargets(root)

      // Existing scopes unchanged
      expect(targets.markdown).toContain('skills/foo/SKILL.md')
      expect(targets.markdown).toContain('agents/research/a.md')
      expect(targets.typescript).toContain('src/lib/foo.ts')

      // docs/solutions/ isolated
      expect(targets.solutionMarkdown).toContain(
        'docs/solutions/best-practices/doc.md',
      )
      expect(targets.markdown).not.toContain(
        'docs/solutions/best-practices/doc.md',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// checkContentIntegrity — parse-safety integration
// ---------------------------------------------------------------------------

describe('checkContentIntegrity — parse-safety integration', () => {
  test('a malformed docs/solutions/ fixture is now picked up by the gate', () => {
    // This is the key integration proof: before this change, docs/solutions/
    // was unscanned. Now a truncating value in a solution doc is detected.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/best-practices/truncating.md',
        [
          '---',
          'problem: cache miss # under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )

      const result = checkContentIntegrity(root)
      expect(result.parseSafetyViolations).toHaveLength(1)
      expect(result.parseSafetyViolations[0]).toMatchObject({
        file: 'docs/solutions/best-practices/truncating.md',
        rule: 'parse-safety',
        field: 'problem',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a clean docs/solutions/ fixture produces no parse-safety violations', () => {
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/best-practices/clean.md',
        [
          '---',
          'problem: cache miss under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )

      const result = checkContentIntegrity(root)
      expect(result.parseSafetyViolations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('regression: existing skill/agent frontmatter checks still pass unchanged', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(root, 'foo', 'body')
      writeAgent(root, 'research', 'a')

      const result = checkContentIntegrity(root)
      expect(result.frontmatterViolations).toEqual([])
      expect(result.agentModelViolations).toEqual([])
      expect(result.parseSafetyViolations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('docs/solutions/ files are NOT subject to banned-pattern enforcement', () => {
    // Historical solution docs may legitimately reference CC/CEP terms in
    // their problem descriptions. They must not be scanned for banned patterns.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/workflow-issues/historical.md',
        [
          '---',
          'problem: migrated from Claude Code',
          'date: 2026-01-01',
          '---',
          'We used Claude Code before switching.',
        ].join('\n'),
      )

      const result = checkContentIntegrity(root)
      // No banned-pattern hits from the solution doc
      expect(result.bannedPatterns).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('allowlist zero-match warning still fires when glob covers docs/solutions/ but solutionMarkdown is excluded from allScannedFiles', () => {
    // solutionMarkdown must NOT leak into allScannedFiles (which feeds loadAllowlist).
    // A docs/solutions/** allowlist entry should produce a zero-match warning
    // because no scanned file (skills/agents/src) matches that glob.
    // We include a skill so allScannedFiles is non-empty (zero-match check only
    // runs when scannedFiles.length > 0).
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/best-practices/doc.md',
        ['---', 'problem: cache miss', 'date: 2026-01-01', '---', 'body'].join(
          '\n',
        ),
      )
      // A skill gives allScannedFiles a non-empty entry so the zero-match check runs.
      writeCompliantSkill(root, 'foo', 'body')
      writeAllowlist(root, [
        {
          pathGlob: 'docs/solutions/**',
          patterns: ['Claude Code'],
          reason: 'Historical solution docs may reference Claude Code by name.',
        },
      ])

      const result = checkContentIntegrity(root)
      // The allowlist entry covers docs/solutions/** but no scanned file
      // (skills/agents/src) matches it → zero-match warning must appear.
      const zeroMatch = result.allowlistWarnings.filter(
        (w) => w.kind === 'zero-match' && w.pathGlob === 'docs/solutions/**',
      )
      expect(zeroMatch).toHaveLength(1)
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

describe('SUBFILE_DIRECTORY_NAMES', () => {
  test('covers the four conventional skill sub-directories', () => {
    expect(SUBFILE_DIRECTORY_NAMES).toEqual([
      'references',
      'scripts',
      'templates',
      'assets',
    ])
  })
})

describe('checkSubfileReferences', () => {
  test('returns empty when no SKILL.md files exist', () => {
    const root = makeFixtureRepo()
    try {
      const broken = checkSubfileReferences(root, [])
      expect(broken).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns empty when every referenced sub-file resolves', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        '# foo\n\nRead `references/handoff.md` and follow its loop.\n',
      )
      writeFile(root, 'skills/foo/references/handoff.md', '# handoff')
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      expect(broken).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags references inside backticks, markdown links, and bare prose', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        [
          '# foo',
          '',
          'Read `references/missing-backtick.md` first.',
          'See [the doc](./references/missing-link.md) for context.',
          'Read references/missing-bare.md before continuing.',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      const refs = broken.map((b) => b.reference).sort()
      expect(refs).toEqual([
        'references/missing-backtick.md',
        'references/missing-bare.md',
        'references/missing-link.md',
      ])
      const lines = broken
        .map((b) => `${b.file}:${b.line}`)
        .every((s) => s.startsWith('skills/foo/SKILL.md:'))
      expect(lines).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag prefixed paths from other skills (false-positive shield)', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'compound-docs',
        [
          '# compound-docs',
          '',
          // Documentation example — refers to a hypothetical OTHER skill.
          // Should NOT be flagged because the boundary preceding `references/`',
          // is `-` (part of the skill name), not whitespace/paren/backtick.
          'Add to `hotwire-native/references/examples.md` with a link.',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      expect(broken).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag .github/workflows/ paths (Github Actions, not skill sub-files)', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'deploy-docs',
        '# deploy-docs\n\nCreate `.github/workflows/deploy-docs.yml` with the workflow.\n',
      )
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      expect(broken).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag bare filenames without a sub-directory prefix', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        '# foo\n\nDetermine which file (resources.md, patterns.md, or examples.md) to edit.\n',
      )
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      expect(broken).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('only scans skills/<name>/SKILL.md, not nested reference files', () => {
    const root = makeFixtureRepo()
    try {
      // SKILL.md is clean. The nested reference contains a fake path that
      // would be flagged if the gate scanned non-entry files.
      writeSkill(root, 'foo', '# foo\n')
      writeFile(
        root,
        'skills/foo/references/notes.md',
        'Internal notes mention `references/another-missing.md` as an example.\n',
      )
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      expect(broken).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('handles all four conventional sub-directories', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        [
          '# foo',
          '',
          'Read `references/missing.md`.',
          'Run `scripts/missing.sh`.',
          'Use `templates/missing.md`.',
          'Reference `assets/missing.md`.',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      const refs = broken.map((b) => b.reference).sort()
      expect(refs).toEqual([
        'assets/missing.md',
        'references/missing.md',
        'scripts/missing.sh',
        'templates/missing.md',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not flag workflows paths after removing workflows as a skill sub-directory', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', '# foo\n\nWorkflow at `workflows/missing.yml`.\n')
      const targets = collectScanTargets(root)
      expect(checkSubfileReferences(root, targets.markdown)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports resolvedPath relative to rootDir for actionable error messages', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', '# foo\n\nRead `references/missing.md`.\n')
      const targets = collectScanTargets(root)
      const broken = checkSubfileReferences(root, targets.markdown)
      expect(broken).toHaveLength(1)
      expect(broken[0]?.resolvedPath).toBe('skills/foo/references/missing.md')
      expect(broken[0]?.reference).toBe('references/missing.md')
      expect(broken[0]?.file).toBe('skills/foo/SKILL.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkContentIntegrity (sub-file refs)', () => {
  test('top-level result exposes brokenSubfileRefs alongside other checks', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', '# foo\n\nRead `references/ghost.md`.\n')
      const result = checkContentIntegrity(root)
      expect(result.brokenSubfileRefs).toHaveLength(1)
      expect(result.brokenSubfileRefs[0]?.reference).toBe('references/ghost.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('CLI exits 1 when a broken sub-file ref is present', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(root, 'foo', '# foo\n\nRead `references/ghost.md`.\n')
      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root])
      expect(proc.exitCode).toBe(1)
      const stderr = proc.stderr.toString()
      expect(stderr).toContain('Broken sub-file references (1)')
      expect(stderr).toContain('references/ghost.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Throws a descriptive error when a violation array is non-empty.
 * Keeps the integration test body flat and under the cognitive-complexity limit.
 */
function assertNoViolations(
  violations: readonly unknown[],
  format: (v: unknown) => string,
  label: string,
): void {
  if (violations.length > 0) {
    const details = violations.map(format).join('\n  ')
    throw new Error(`${label}:\n  ${details}`)
  }
}

describe('integration: real repo', () => {
  test('content-integrity gate passes against current HEAD', () => {
    const result = checkContentIntegrity(REPO_ROOT)

    // Zero phantoms, zero non-exempt banned patterns, zero warnings.
    assertNoViolations(
      result.phantomRefs,
      (v) => {
        const p = v as (typeof result.phantomRefs)[number]
        return `${p.file}:${p.line}  ${p.reference}`
      },
      'Phantom references in repo',
    )
    assertNoViolations(
      result.bannedPatterns,
      (v) => {
        const h = v as (typeof result.bannedPatterns)[number]
        return `${h.file}:${h.line}  ${JSON.stringify(h.pattern)}  ${h.lineContent}`
      },
      'Banned patterns outside allowlist',
    )
    assertNoViolations(
      result.brokenSubfileRefs,
      (v) => {
        const r = v as (typeof result.brokenSubfileRefs)[number]
        return `${r.file}:${r.line}  ${r.reference}  → ${r.resolvedPath}`
      },
      'Broken sub-file references in repo',
    )
    assertNoViolations(
      result.frontmatterViolations,
      (v) => {
        const fv = v as (typeof result.frontmatterViolations)[number]
        return `${fv.file}  ${fv.rule}  ${fv.field ?? ''}`
      },
      'Frontmatter violations in repo',
    )
    assertNoViolations(
      result.agentModelViolations,
      (v) => {
        const av = v as (typeof result.agentModelViolations)[number]
        return `${av.file}  ${av.message}`
      },
      'Agent model violations in repo',
    )
    assertNoViolations(
      result.agentStemViolations,
      (v) => {
        const sv = v as (typeof result.agentStemViolations)[number]
        return `${sv.stem}  ${sv.files.join(', ')}`
      },
      'Duplicate bundled agent stems in repo',
    )
    assertNoViolations(
      result.parseSafetyViolations,
      (v) => {
        const pv = v as (typeof result.parseSafetyViolations)[number]
        return `${pv.file}  ${pv.field ?? ''}  ${pv.message}`
      },
      'Parse-safety violations in repo',
    )
    assertNoViolations(
      result.agentModeViolations,
      (v) => {
        const mv = v as (typeof result.agentModeViolations)[number]
        return `${mv.file}  ${mv.message}`
      },
      'Agent mode violations in repo',
    )
    assertNoViolations(
      result.agentTemperatureViolations,
      (v) => {
        const tv = v as (typeof result.agentTemperatureViolations)[number]
        return `${tv.file}  ${tv.message}`
      },
      'Agent temperature violations in repo',
    )

    expect(result.phantomRefs).toEqual([])
    expect(result.brokenSubfileRefs).toEqual([])
    expect(result.bannedPatterns).toEqual([])
    expect(result.frontmatterViolations).toEqual([])
    expect(result.agentModelViolations).toEqual([])
    expect(result.agentStemViolations).toEqual([])
    expect(result.parseSafetyViolations).toEqual([])
    expect(result.agentModeViolations).toEqual([])
    expect(result.agentTemperatureViolations).toEqual([])
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
      writeCompliantSkill(root, 'foo', 'Clean skill. systematic:research:a\n')

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
      writeCompliantSkill(root, 'foo', 'systematic:research:ghost\n')

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
      writeCompliantSkill(
        root,
        'foo',
        'Reintroduced TaskCreate accidentally.\n',
      )

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

  test('exits 1 when a parse-safety violation exists in docs/solutions/', () => {
    // A docs/solutions/ file with a truncating frontmatter value must cause
    // the CLI to exit 1 and report the violation path and rule.
    const root = makeFixtureRepo()
    try {
      writeFile(
        root,
        'docs/solutions/truncating.md',
        [
          '---',
          'problem: cache miss # under load',
          'date: 2026-01-01',
          '---',
          'body',
        ].join('\n'),
      )
      const result = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(1)
      const stderr = result.stderr.toString()
      expect(stderr).toContain('Parse-safety violations')
      expect(stderr).toContain('truncating.md')
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

  test('exits 1 when enforced frontmatter and agent-model violations exist', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'foo',
        '---\nname: foo\ndescription: Test skill\npreconditions: before use\n---\nbody',
      )
      writeFile(
        root,
        'agents/research/a.md',
        '---\nname: a\nmodel: inherit\n---\nagent',
      )

      const result = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(1)
      const stderr = result.stderr.toString()
      expect(stderr).toContain('Frontmatter violations (1)')
      expect(stderr).toContain('Agent model violations (1)')
      expect(stderr).toContain('preconditions')
      expect(stderr).toContain(
        'fix: Update frontmatter to match systematic:writing-skills',
      )
      expect(stderr).toContain('agents/research/a.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// ce-work -> systematic-implementer dispatch contract
// ---------------------------------------------------------------------------

describe('ce-work -> systematic-implementer dispatch contract', () => {
  test('skills/ce-work/SKILL.md dispatches to systematic-implementer subagent', () => {
    const skillPath = path.join(REPO_ROOT, 'skills/ce-work/SKILL.md')
    const content = fs.readFileSync(skillPath, 'utf8')
    expect(content).toContain('subagent_type: "systematic-implementer"')
  })

  test('agents/workflow/systematic-implementer.md has matching frontmatter', () => {
    const agentPath = path.join(
      REPO_ROOT,
      'agents/workflow/systematic-implementer.md',
    )
    const content = fs.readFileSync(agentPath, 'utf8')
    // Split on --- to extract frontmatter between first two fences
    const [, frontmatter] = content.split('---')
    expect(frontmatter).toBeDefined()

    expect(frontmatter).toMatch(/^name:\s*"?systematic-implementer"?$/m)
    expect(frontmatter).toMatch(/^mode:\s*"?subagent"?$/m)
    expect(frontmatter).not.toMatch(/^model:/m)
  })
})

// ---------------------------------------------------------------------------
// checkArgumentHint
// ---------------------------------------------------------------------------

describe('checkArgumentHint', () => {
  test('flags skill body referencing $ARGUMENTS without argument-hint in frontmatter', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'needs-hint',
        [
          '---',
          'name: needs-hint',
          'description: A skill that uses arguments',
          '---',
          'Pass $ARGUMENTS to the tool.',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkArgumentHint(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('skills/needs-hint/SKILL.md')
      expect(violations[0]?.message).toContain('argument-hint')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('no violation when body references $ARGUMENTS and frontmatter has argument-hint', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'has-hint',
        [
          '---',
          'name: has-hint',
          'description: A skill that uses arguments',
          'argument-hint: "[topic]"',
          '---',
          'Pass $ARGUMENTS to the tool.',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkArgumentHint(root, targets.markdown)
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('no violation when body has neither $ARGUMENTS nor argument-hint', () => {
    const root = makeFixtureRepo()
    try {
      writeCompliantSkill(
        root,
        'plain',
        'Just a plain skill body with no arguments.',
      )
      const targets = collectScanTargets(root)
      const violations = checkArgumentHint(root, targets.markdown)
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('no violation when $ARGUMENTS appears only inside a fenced code block (fence-stripping works)', () => {
    // A skill that DOCUMENTS $ARGUMENTS inside a code fence must not be flagged.
    // The check must strip fenced code blocks before scanning for the literal.
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'docs-only',
        [
          '---',
          'name: docs-only',
          'description: Documents the $ARGUMENTS placeholder',
          '---',
          'This skill shows how to use the placeholder:',
          '',
          '```',
          'bun run skill $ARGUMENTS',
          '```',
          '',
          'The above is just an example.',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkArgumentHint(root, targets.markdown)
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('flags skill when $ARGUMENTS appears both inside and outside a fenced code block', () => {
    // Outside-fence occurrence must still trigger the violation even when
    // there is also an inside-fence occurrence.
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'mixed',
        [
          '---',
          'name: mixed',
          'description: Mixed usage',
          '---',
          'Run with $ARGUMENTS as the input.',
          '',
          '```',
          'example: $ARGUMENTS',
          '```',
        ].join('\n'),
      )
      const targets = collectScanTargets(root)
      const violations = checkArgumentHint(root, targets.markdown)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.file).toBe('skills/mixed/SKILL.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scans only skill entry files (SKILL.md), not agent files or sub-files', () => {
    const root = makeFixtureRepo()
    try {
      // Agent file with $ARGUMENTS in body -- must not be flagged.
      writeFile(
        root,
        'agents/research/a.md',
        '---\nname: a\nmode: subagent\ntemperature: 0.3\n---\nUse $ARGUMENTS here.',
      )
      // Skill sub-file with $ARGUMENTS -- must not be flagged.
      writeFile(
        root,
        'skills/foo/references/ref.md',
        'Reference using $ARGUMENTS.',
      )
      // Compliant SKILL.md with no $ARGUMENTS -- no violation.
      writeCompliantSkill(root, 'foo', 'body')
      const targets = collectScanTargets(root)
      const violations = checkArgumentHint(root, targets.markdown)
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('no crash on malformed frontmatter (non-object data)', () => {
    // Malformed frontmatter produces non-object parsed.data; the check must
    // not throw. Fail-closed: if we cannot parse frontmatter we skip the file.
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'malformed',
        '---\n- item: one\n---\nBody with $ARGUMENTS here.',
      )
      const targets = collectScanTargets(root)
      // Must not throw regardless of outcome.
      expect(() => checkArgumentHint(root, targets.markdown)).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('integration: real repo skills produce zero argument-hint violations', () => {
    const violations = checkArgumentHint(
      REPO_ROOT,
      collectScanTargets(REPO_ROOT).markdown,
    )
    expect(violations).toEqual([])
  })
})

describe('checkContentIntegrity -- argumentHintViolations wiring', () => {
  test('populates argumentHintViolations when a skill uses $ARGUMENTS without argument-hint', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'needs-hint',
        [
          '---',
          'name: needs-hint',
          'description: A skill',
          '---',
          'Run with $ARGUMENTS.',
        ].join('\n'),
      )

      const result = checkContentIntegrity(root)

      expect(result.argumentHintViolations).toHaveLength(1)
      expect(result.argumentHintViolations[0]?.file).toBe(
        'skills/needs-hint/SKILL.md',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('argumentHintViolations counts toward totalViolations (CLI exits 1)', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'needs-hint',
        [
          '---',
          'name: needs-hint',
          'description: A skill',
          '---',
          'Run with $ARGUMENTS.',
        ].join('\n'),
      )

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('printArgumentHintViolations -- CLI print path', () => {
  test('emits the argument-hint-violation heading and offending file to stderr', () => {
    const root = makeFixtureRepo()
    try {
      writeSkill(
        root,
        'needs-hint',
        [
          '---',
          'name: needs-hint',
          'description: A skill',
          '---',
          'Run with $ARGUMENTS.',
        ].join('\n'),
      )

      const proc = Bun.spawnSync(['bun', SCRIPT_PATH, root], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(proc.exitCode).toBe(1)
      const stderr = proc.stderr.toString()
      expect(stderr).toContain('Argument-hint violations')
      expect(stderr).toContain('skills/needs-hint/SKILL.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkRemovedNamesOverlap', () => {
  // Disjoint lists: no overlap between removed and current bundled names.
  test('disjoint removed and current names: no violations', () => {
    const violations = checkRemovedNamesOverlap(
      ['gone-skill'],
      [],
      ['ce:plan', 'ce:review'],
      [],
      [],
    )
    expect(violations).toHaveLength(0)
  })

  // A removed skill name that equals a current bundled skill name must fail.
  test('removed skill name overlapping current bundled skill name: violation', () => {
    const violations = checkRemovedNamesOverlap(
      ['ce:plan'],
      [],
      ['ce:plan', 'ce:review'],
      [],
      [],
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((v) => v.name === 'ce:plan')).toBe(true)
  })

  // A removed agent name that equals a current bundled agent bare name must fail.
  test('removed agent name overlapping current bundled agent bare name: violation', () => {
    const violations = checkRemovedNamesOverlap(
      [],
      ['correctness-reviewer'],
      [],
      ['correctness-reviewer'],
      [],
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((v) => v.name === 'correctness-reviewer')).toBe(true)
  })

  // A removed agent name that equals a current bundled qualified id must fail.
  test('removed agent name overlapping current bundled qualified id: violation', () => {
    const violations = checkRemovedNamesOverlap(
      [],
      ['review/correctness-reviewer'],
      [],
      [],
      ['review/correctness-reviewer'],
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(
      violations.some((v) => v.name === 'review/correctness-reviewer'),
    ).toBe(true)
  })

  // Multiple overlaps are all reported.
  test('multiple overlapping names: all reported', () => {
    const violations = checkRemovedNamesOverlap(
      ['ce:plan', 'ce:review'],
      ['correctness-reviewer'],
      ['ce:plan', 'ce:review'],
      ['correctness-reviewer'],
      [],
    )
    expect(violations.length).toBe(3)
  })

  // Empty removed lists: no violations regardless of current names.
  test('empty removed lists: no violations', () => {
    const violations = checkRemovedNamesOverlap(
      [],
      [],
      ['ce:plan', 'ce:review'],
      ['correctness-reviewer'],
      ['review/correctness-reviewer'],
    )
    expect(violations).toHaveLength(0)
  })

  // Regression: v3 cleanup unit 1 populates REMOVED_BUNDLED_SKILL_NAMES with
  // the two deleted skills. The gate must pass only when those names are
  // absent from the live bundled skill set and present in the removed set —
  // and must fail if either name were still shipped as a bundled skill.
  test('v3 cleanup: removed skill names absent from bundled set passes the gate', () => {
    const violations = checkRemovedNamesOverlap(
      ['orchestrating-swarms', 'claude-permissions-optimizer'],
      [],
      ['orchestrating-subagents', 'ce:plan', 'ce:review'],
      [],
      [],
    )
    expect(violations).toHaveLength(0)
  })

  test('v3 cleanup: a removed name still present as a bundled skill fails the gate', () => {
    const violations = checkRemovedNamesOverlap(
      ['orchestrating-swarms', 'claude-permissions-optimizer'],
      [],
      ['orchestrating-swarms', 'ce:plan'],
      [],
      [],
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((v) => v.name === 'orchestrating-swarms')).toBe(true)
  })
})
