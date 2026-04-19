import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INTERNAL_AGENT_SIGNATURES } from '../../src/index.ts'
import { getBootstrapContent } from '../../src/lib/bootstrap.ts'
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
    expect(content).toContain(bundledSkillsDir)
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
  /**
   * Render the tool-mapping template and extract every `` `X` → `y` ``
   * markdown-list mapping. Returns the CC (left) and OC (right) tool names
   * as they appear in the template.
   */
  function extractToolMappings(template: string): { cc: string; oc: string }[] {
    const mappings: { cc: string; oc: string }[] = []
    const lineRe = /^- `([^`]+)` → `([^`]+)`/gm
    for (const match of template.matchAll(lineRe)) {
      mappings.push({ cc: match[1] ?? '', oc: match[2] ?? '' })
    }
    return mappings
  }

  /**
   * Names that appear on the left of `X → y` mappings but are intentionally
   * Systematic-specific rather than imported from CC. These do not need to
   * appear in TOOL_NAME_MAP (which is the CEP→Systematic converter's mapping,
   * not a registry of every tool mentioned in prose).
   */
  const SYSTEMATIC_ONLY_TOOLS = new Set(['systematicskill'])

  test('rendered template contains at least one mapping', () => {
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
    expect(extractToolMappings(content ?? '').length).toBeGreaterThan(0)
  })

  test('every CC tool name in the template is a key in TOOL_NAME_MAP', () => {
    const content = getBootstrapContent(
      {
        bootstrap: { enabled: true, file: undefined },
        disabled_skills: [],
        disabled_agents: [],
        disabled_commands: [],
      },
      { bundledSkillsDir: createTempBundledSkillsDir() },
    )
    const mappings = extractToolMappings(content ?? '')

    for (const { cc, oc } of mappings) {
      const ccLower = cc.toLowerCase()
      if (SYSTEMATIC_ONLY_TOOLS.has(ccLower)) continue
      expect(TOOL_NAME_MAP).toHaveProperty(ccLower)
      expect(TOOL_NAME_MAP[ccLower]).toBe(oc)
    }
  })

  function createTempBundledSkillsDir(): string {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-bootstrap-consistency-'),
    )
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
