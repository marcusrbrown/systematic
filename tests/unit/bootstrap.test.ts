import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
} from '../../src/lib/bootstrap.ts'
import { TOOL_NAME_MAP } from '../../src/lib/converter.ts'

/**
 * Reconstruct the production skip predicate from src/index.ts:91-97 using the
 * exported INTERNAL_AGENT_SIGNATURES constant. This mirrors the inline check
 * in the experimental.chat.system.transform hook without duplicating the data.
 *
 * If the production logic changes shape (e.g., joins with a different
 * separator, or stops lowercasing), both the production code and this helper
 * must be updated together.
 */
function shouldSkipBootstrap(system: readonly string[]): boolean {
  const existingSystem = system.join('\n').toLowerCase()
  return INTERNAL_AGENT_SIGNATURES.some((sig) =>
    existingSystem.includes(sig.toLowerCase()),
  )
}

// ---------------------------------------------------------------------------
// getBootstrapContent
// ---------------------------------------------------------------------------

describe('getBootstrapContent', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-bootstrap-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function makeBundledSkillsDir(usingSystematicBody?: string): string {
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(bundledSkillsDir, { recursive: true })
    if (usingSystematicBody !== undefined) {
      fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'))
      fs.writeFileSync(
        path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'),
        usingSystematicBody,
      )
    }
    return bundledSkillsDir
  }

  test('default config returns content with SYSTEMATIC_WORKFLOWS wrapper', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('</SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('Bootstrap body content here.')
    expect(content).toContain('**Tool Mapping for OpenCode:**')
  })

  test('config.bootstrap.enabled = false returns null', () => {
    const bundledSkillsDir = makeBundledSkillsDir('body')
    const config = {
      bootstrap: { enabled: false, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    expect(getBootstrapContent(config, { bundledSkillsDir })).toBeNull()
  })

  test('custom config.bootstrap.file returns the file contents verbatim when it exists', () => {
    const bundledSkillsDir = makeBundledSkillsDir('bundled body')
    const customPath = path.join(testDir, 'custom-bootstrap.md')
    fs.writeFileSync(customPath, 'CUSTOM bootstrap override content')

    const config = {
      bootstrap: { enabled: true, file: customPath },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).toBe('CUSTOM bootstrap override content')
    // Must NOT be wrapped with <SYSTEMATIC_WORKFLOWS> when using a custom file.
    expect(content).not.toContain('<SYSTEMATIC_WORKFLOWS>')
  })

  test('custom config.bootstrap.file with ~/ prefix expands to the home directory', () => {
    const bundledSkillsDir = makeBundledSkillsDir('bundled body')
    // Write a file in the real home dir (use a timestamped filename to avoid conflicts)
    const homeFilename = `.systematic-test-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    const realHomePath = path.join(os.homedir(), homeFilename)
    fs.writeFileSync(realHomePath, 'HOME-DIR bootstrap')
    try {
      const config = {
        bootstrap: { enabled: true, file: `~/${homeFilename}` },
        disabled_skills: [] as string[],
        disabled_agents: [] as string[],
        disabled_commands: [] as string[],
      }
      expect(getBootstrapContent(config, { bundledSkillsDir })).toBe(
        'HOME-DIR bootstrap',
      )
    } finally {
      fs.unlinkSync(realHomePath)
    }
  })

  test('custom config.bootstrap.file pointing to nonexistent path falls through to the bundled skill', () => {
    // CORRECTNESS: bootstrap.ts:40-47 does not return early when the custom
    // file is missing — it falls through to the bundled using-systematic path.
    // This test locks in that intentional fallback. Change only with a
    // behavior change (e.g., return null on missing custom file).
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBundled body',
    )
    const config = {
      bootstrap: {
        enabled: true,
        file: path.join(testDir, 'does-not-exist.md'),
      },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })
    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('Bundled body')
  })

  test('returns null when using-systematic/SKILL.md is missing from bundledSkillsDir', () => {
    const bundledSkillsDir = makeBundledSkillsDir() // no SKILL.md
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    expect(getBootstrapContent(config, { bundledSkillsDir })).toBeNull()
  })

  test('strips YAML frontmatter from the bundled skill content', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\ndescription: Test skill\n---\n\nActual body content.',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('Actual body content.')
    expect(content).not.toContain('---')
    expect(content).not.toContain('description: Test skill')
  })

  test('embeds bundledSkillsDir absolute path in the tool-mapping template', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nbody',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).not.toContain(bundledSkillsDir)
    expect(content).toContain(
      'Bundled skills ship with the Systematic plugin and are discoverable via `systematic_skill`.',
    )
  })
})

// ---------------------------------------------------------------------------
// INTERNAL_AGENT_SIGNATURES skip heuristic (src/index.ts:91-97)
// ---------------------------------------------------------------------------

describe('INTERNAL_AGENT_SIGNATURES skip heuristic', () => {
  test('exports the 3 documented signatures', () => {
    expect(INTERNAL_AGENT_SIGNATURES).toEqual([
      'You are a title generator',
      'You are a helpful AI assistant tasked with summarizing conversations',
      'Summarize what was done in this conversation',
    ])
  })

  test('skips when any signature appears in the joined system prompt', () => {
    for (const sig of INTERNAL_AGENT_SIGNATURES) {
      expect(shouldSkipBootstrap([`Context\n\n${sig}\n\nRules...`])).toBe(true)
    }
  })

  test('is case-insensitive', () => {
    expect(shouldSkipBootstrap(['YOU ARE A TITLE GENERATOR'])).toBe(true)
    expect(shouldSkipBootstrap(['you are a title generator'])).toBe(true)
    expect(shouldSkipBootstrap(['You Are A Title Generator'])).toBe(true)
  })

  test('joins the system array with newline before matching', () => {
    // Signature split across array entries: if production joined with an empty
    // string, the substring would still match; but newline is the documented
    // separator, so this test pins the behavior.
    const split = ['You are a', 'title generator']
    const joined = split.join('\n').toLowerCase()
    expect(joined.includes('you are a title generator')).toBe(false) // split by \n
    expect(shouldSkipBootstrap(split)).toBe(false)
  })

  test('does not skip for unrelated prompts', () => {
    expect(
      shouldSkipBootstrap([
        'You are a helpful assistant doing domain work.',
        'Rules: follow the plan, write tests, stay scoped.',
      ]),
    ).toBe(false)
    expect(shouldSkipBootstrap([])).toBe(false)
    expect(shouldSkipBootstrap([''])).toBe(false)
  })

  test('FRAGILITY: a legitimate prompt containing a signature substring triggers skip', () => {
    // FRAGILITY: the skip heuristic uses substring matching on the joined
    // system prompt. A legitimate prompt that happens to contain a signature
    // phrase ("You are a title generator") will incorrectly skip bootstrap
    // injection. Documented as acceptable in docs/brainstorms/
    // 2026-04-18-infra-improvements-requirements.md (trade-off: refactoring to
    // a frontmatter-based opt-out is a separate design decision, deferred).
    //
    // If a future refactor moves to an explicit opt-out (e.g., frontmatter
    // flag or first-line marker), this test must be updated intentionally:
    // the legitimate prompt below should no longer trigger the skip.
    const legitimate = [
      'You are an agent building a UI for a CMS.',
      'Users can configure pages. You are a title generator panel designer.',
      'Generate layout recommendations.',
    ]
    expect(shouldSkipBootstrap(legitimate)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TOOL_NAME_MAP ↔ bootstrap template consistency
// ---------------------------------------------------------------------------

describe('TOOL_NAME_MAP / bootstrap template consistency', () => {
  // Track temp dirs created by createTempBundledSkillsDir for cleanup.
  const tempDirs: string[] = []
  afterAll(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  /**
   * Extract all CC tool names from the left side of `→` arrows in the
   * "Tool Mapping for OpenCode" section of the bootstrap template.
   *
   * Handles all three bullet forms found in the template:
   *   - `X` → `y`              (simple 1:1, backtick-delimited OC name)
   *   - `X` tool with … → prose  (prose RHS; extracts X only)
   *   - `A`, `B`, `C` → prose  (multi-name LHS; extracts A, B, C)
   *
   * Note: this is an overlap-subset check, not a full-map consistency check.
   * The bootstrap prose and the converter map only partially overlap by design —
   * the bootstrap is instructional text, not a serialised TOOL_NAME_MAP.
   */
  // Section heading used to locate the tool-mapping block in the bootstrap
  // template. Must match the literal heading in src/lib/bootstrap.ts's
  // getToolMappingTemplate(). If that heading changes, this must be updated.
  const TOOL_MAPPING_HEADING = '**Tool Mapping for OpenCode:**'

  // Matches the start of the NEXT bold markdown heading after the tool-mapping
  // section. The negative lookahead (?!Tool Mapping) prevents matching the
  // section's own heading if it appears in a self-referential context.
  // A new bold heading starting with "Tool" (but not "Tool Mapping") will
  // correctly terminate the section — the lookahead only exempts the exact
  // phrase "Tool Mapping".
  const NEXT_BOLD_HEADING_RE = /\n\*\*(?!Tool Mapping)/

  function extractCCToolNames(template: string): string[] {
    // Isolate the tool-mapping section to avoid false-positive matches on
    // unrelated `→` arrows elsewhere in the bootstrap content.
    const sectionStart = template.indexOf(TOOL_MAPPING_HEADING)
    if (sectionStart === -1) return []
    const rest = template.slice(sectionStart)
    const nextHeading = rest.search(NEXT_BOLD_HEADING_RE)
    const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest

    // For each bullet line, extract backtick-quoted tokens from the LHS of `→`.
    // Uses flatMap to avoid nested loops that inflate cognitive complexity.
    return section
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .flatMap((line) => {
        const arrowIdx = line.indexOf(' → ')
        const lhs = arrowIdx >= 0 ? line.slice(0, arrowIdx) : line
        return [...lhs.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')
      })
      .filter(Boolean)
  }

  /**
   * Names that appear in the template mapping section but are intentionally
   * Systematic-specific rather than imported from CC. These do not need a
   * TOOL_NAME_MAP entry (the map covers CC→Systematic converter renames only).
   */
  const SYSTEMATIC_ONLY_TOOLS = new Set(['systematicskill'])

  test('rendered template contains at least one CC tool reference', () => {
    const content = getBootstrapContent(
      {
        bootstrap: { enabled: true, file: undefined },
        disabled_skills: [],
        disabled_agents: [],
        disabled_commands: [],
      },
      { bundledSkillsDir: createTempBundledSkillsDir() },
    )
    expect(content).not.toBeNull()
    expect(extractCCToolNames(content ?? '').length).toBeGreaterThan(0)
  })

  test('every CC tool name in the template mapping section is a key in TOOL_NAME_MAP', () => {
    const content = getBootstrapContent(
      {
        bootstrap: { enabled: true, file: undefined },
        disabled_skills: [],
        disabled_agents: [],
        disabled_commands: [],
      },
      { bundledSkillsDir: createTempBundledSkillsDir() },
    )
    const ccNames = extractCCToolNames(content ?? '')
    // Guard against section-parse regressions
    expect(ccNames.length).toBeGreaterThan(0)

    for (const cc of ccNames) {
      const normalized = cc.toLowerCase()
      if (SYSTEMATIC_ONLY_TOOLS.has(normalized)) continue
      expect(
        TOOL_NAME_MAP,
        `Bootstrap template references "${cc}" but TOOL_NAME_MAP has no key "${normalized}"`,
      ).toHaveProperty(normalized)
    }
  })

  function createTempBundledSkillsDir(): string {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-bootstrap-consistency-'),
    )
    tempDirs.push(dir)
    fs.mkdirSync(path.join(dir, 'skills', 'using-systematic'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(dir, 'skills', 'using-systematic', 'SKILL.md'),
      '---\nname: using-systematic\n---\nbody',
    )
    return path.join(dir, 'skills')
  }
})
