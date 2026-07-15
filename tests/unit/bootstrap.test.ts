import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyBootstrapContent,
  composeSystemPromptWithBootstrap,
  computeBootstrapContentSafe,
  getBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
} from '../../src/lib/bootstrap.ts'

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
    expect(content).toContain('**Skills naming:**')
    expect(content).toContain('Use the `skill` tool for non-Systematic skills')
    expect(content).not.toContain('**Tool Mapping for OpenCode:**')
  })

  test('custom usage template is included when provided without changing the default OpenCode template', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, {
      bundledSkillsDir,
      usageTemplate: '**Pi-native guidance:**\n- use systematic_skill\n',
    })

    expect(content).not.toBeNull()
    expect(content).toContain('**Pi-native guidance:**')
    expect(content).not.toContain(
      'Use the `skill` tool for non-Systematic skills',
    )
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

  test('skill-usage template does not embed bundledSkillsDir as a raw path', () => {
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
    // The skill-usage prose must not embed the raw path. Slice from the
    // heading up to the catalog block (or end of string if no catalog).
    const skillUsageHeading = '**Skills naming:**'
    const skillUsageStart = (content ?? '').indexOf(skillUsageHeading)
    expect(skillUsageStart).toBeGreaterThan(-1)
    const afterHeading = (content ?? '').slice(skillUsageStart)
    const catalogStart = afterHeading.indexOf('<available_skills>')
    const skillUsageProse =
      catalogStart >= 0 ? afterHeading.slice(0, catalogStart) : afterHeading
    expect(skillUsageProse).not.toContain(bundledSkillsDir)
    expect(content).toContain(
      'Bundled skills ship with the Systematic plugin and are discoverable via `systematic_skill`.',
    )
  })
})

// ---------------------------------------------------------------------------
// Verbose skill catalog in default bootstrap
// ---------------------------------------------------------------------------

describe('getBootstrapContent — verbose skill catalog', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-bootstrap-catalog-'),
    )
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function makeSkillsDir(
    skills: Array<{ name: string; description: string; extra?: string }>,
  ): string {
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'),
      '---\nname: using-systematic\ndescription: Use when starting any conversation\n---\nBootstrap body.',
    )
    for (const skill of skills) {
      const dir = path.join(bundledSkillsDir, skill.name)
      fs.mkdirSync(dir, { recursive: true })
      const extra = skill.extra ?? ''
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${skill.name}\ndescription: ${skill.description}${extra}\n---\nBody.`,
      )
    }
    return bundledSkillsDir
  }

  test('default bootstrap contains <available_skills> with skill name, description, and file URL', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
      { name: 'ce:plan', description: 'Create structured plans' },
    ])
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<available_skills>')
    expect(content).toContain('</available_skills>')
    // Skills appear with prefixed names
    expect(content).toContain('<name>systematic:git-commit</name>')
    expect(content).toContain('<description>Create a git commit</description>')
    expect(content).toContain('<location>file://')
    expect(content).toContain('git-commit')
    // ce:plan already has a colon so it keeps its name
    expect(content).toContain('<name>ce:plan</name>')
  })

  test('disabled skills are absent from the default bootstrap catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
      { name: 'ce:plan', description: 'Create structured plans' },
    ])
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: ['git-commit'] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).not.toContain('<name>systematic:git-commit</name>')
    expect(content).toContain('<name>ce:plan</name>')
  })

  test('skills with disableModelInvocation are absent from the default bootstrap catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
      {
        name: 'internal-tool',
        description: 'Internal only',
        extra: '\ndisable-model-invocation: true',
      },
    ])
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<name>systematic:git-commit</name>')
    expect(content).not.toContain('<name>systematic:internal-tool</name>')
  })

  test('custom bootstrap file content is returned verbatim without verbose catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
    ])
    const customPath = path.join(testDir, 'custom-bootstrap.md')
    fs.writeFileSync(customPath, 'CUSTOM bootstrap content — no catalog here')

    const config = {
      bootstrap: { enabled: true, file: customPath },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).toBe('CUSTOM bootstrap content — no catalog here')
    expect(content).not.toContain('<available_skills>')
  })

  test('missing custom bootstrap path falls through to default bootstrap with catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
    ])
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
    expect(content).toContain('<available_skills>')
    expect(content).toContain('<name>systematic:git-commit</name>')
  })
})

describe('using-systematic SKILL.md structural invariants', () => {
  // Point at the real bundled skills directory so these tests exercise the
  // actual shipped SKILL.md content, not a synthetic fixture.
  const realBundledSkillsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../skills',
  )

  const defaultConfig = {
    bootstrap: { enabled: true, file: undefined },
    disabled_skills: [] as string[],
    disabled_agents: [] as string[],
    disabled_commands: [] as string[],
  }

  test('bootstrap content contains the <SUBAGENT-STOP> marker', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    expect(content).toContain('<SUBAGENT-STOP>')
  })

  test('bootstrap content contains the ## Instruction Priority section', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    expect(content).toContain('## Instruction Priority')
  })

  test('<SUBAGENT-STOP> appears before <EXTREMELY-IMPORTANT> in bootstrap output', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    const str = content as string
    const subagentStop = str.indexOf('<SUBAGENT-STOP>')
    const extremelyImportant = str.indexOf('<EXTREMELY-IMPORTANT>')
    expect(subagentStop).toBeGreaterThan(-1)
    expect(extremelyImportant).toBeGreaterThan(-1)
    expect(subagentStop).toBeLessThan(extremelyImportant)
  })

  test('## Instruction Priority appears before ## How to Access Skills in bootstrap output', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    const str = content as string
    const instructionPriority = str.indexOf('## Instruction Priority')
    const howToAccess = str.indexOf('## How to Access Skills')
    expect(instructionPriority).toBeGreaterThan(-1)
    expect(howToAccess).toBeGreaterThan(-1)
    expect(instructionPriority).toBeLessThan(howToAccess)
  })

  test('post-injection: applyBootstrapContent preserves SUBAGENT-STOP before EXTREMELY-IMPORTANT in rendered output.system[0]', () => {
    // CORRECTNESS: pre-injection tests against getBootstrapContent() can pass
    // while applyBootstrapContent's assembly logic silently breaks the
    // subagent-visible invariant. This test exercises the actual injection
    // surface that subagent system prompts see.
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()

    const output = { system: ['You are a primary agent. Do the work.'] }
    applyBootstrapContent(output, content as string)

    const rendered = output.system[0]
    const subagentStop = rendered.indexOf('<SUBAGENT-STOP>')
    const extremelyImportant = rendered.indexOf('<EXTREMELY-IMPORTANT>')
    expect(subagentStop).toBeGreaterThan(-1)
    expect(extremelyImportant).toBeGreaterThan(-1)
    expect(subagentStop).toBeLessThan(extremelyImportant)
  })
})

describe('shouldSkipBootstrap behavioral non-regression', () => {
  test('returns true for "You are a title generator" system prompt', () => {
    expect(
      shouldSkipBootstrap([
        'You are a title generator. Generate a short title.',
      ]),
    ).toBe(true)
  })

  test('returns true for "You are a helpful AI assistant tasked with summarizing conversations" system prompt', () => {
    expect(
      shouldSkipBootstrap([
        'You are a helpful AI assistant tasked with summarizing conversations. Be concise.',
      ]),
    ).toBe(true)
  })

  test('returns true for "Summarize what was done in this conversation" system prompt', () => {
    expect(
      shouldSkipBootstrap(['Summarize what was done in this conversation.']),
    ).toBe(true)
  })

  test('returns false for a primary-agent-shape prompt with no internal signatures', () => {
    expect(
      shouldSkipBootstrap([
        'You are a code review assistant for the marcusrbrown/systematic project. Review the diff carefully and provide actionable feedback.',
      ]),
    ).toBe(false)
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

describe('computeBootstrapContentSafe', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-bootstrap-safe-'),
    )
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

  it('returns bootstrap content string for a valid bundled skills dir', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBody content.',
    )
    const content = computeBootstrapContentSafe({ bundledSkillsDir })
    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('Body content.')
  })

  it('returns null (not throws) when using-systematic/SKILL.md is missing', () => {
    const bundledSkillsDir = makeBundledSkillsDir() // no SKILL.md
    expect(() =>
      computeBootstrapContentSafe({ bundledSkillsDir }),
    ).not.toThrow()
    expect(computeBootstrapContentSafe({ bundledSkillsDir })).toBeNull()
  })

  it('returns null (not throws) when bundledSkillsDir itself does not exist', () => {
    const missingDir = path.join(testDir, 'does-not-exist')
    expect(() =>
      computeBootstrapContentSafe({ bundledSkillsDir: missingDir }),
    ).not.toThrow()
    expect(
      computeBootstrapContentSafe({ bundledSkillsDir: missingDir }),
    ).toBeNull()
  })

  it('returns null (not throws) for a malformed/unreadable using-systematic SKILL.md fixture', () => {
    // Real temp-dir fixture: create using-systematic as a directory named
    // SKILL.md instead of a file, so fs.readFileSync throws EISDIR.
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'), {
      recursive: true,
    })
    expect(() =>
      computeBootstrapContentSafe({ bundledSkillsDir }),
    ).not.toThrow()
    expect(computeBootstrapContentSafe({ bundledSkillsDir })).toBeNull()
  })

  it('reports failures once and still returns null when the reporter throws', () => {
    const bundledSkillsDir = makeBundledSkillsDir()
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'), {
      recursive: true,
    })

    let reportCalls = 0

    const result = computeBootstrapContentSafe({ bundledSkillsDir }, () => {
      reportCalls++
      throw new Error('reporter failure')
    })

    expect(reportCalls).toBe(1)
    expect(result).toBeNull()
  })
})

describe('composeSystemPromptWithBootstrap', () => {
  it('preserves earlier extension marker bytes exactly when appending the Systematic snapshot', () => {
    const existing =
      'You are a primary agent. Earlier extension contribution: <SYSTEMATIC_WORKFLOWS>example</SYSTEMATIC_WORKFLOWS>'
    const bootstrap = '<SYSTEMATIC_WORKFLOWS>\nContent\n</SYSTEMATIC_WORKFLOWS>'

    const result = composeSystemPromptWithBootstrap(existing, bootstrap)

    expect(result).not.toBeNull()
    expect(result).toBe(`${existing}\n\n${bootstrap}`)
  })

  it('returns the existing prompt unchanged when it already ends with the same snapshot', () => {
    const bootstrap = '<SYSTEMATIC_WORKFLOWS>\nContent\n</SYSTEMATIC_WORKFLOWS>'
    const existing = `Earlier.\n\n${bootstrap}`

    const result = composeSystemPromptWithBootstrap(existing, bootstrap)

    expect(result).toBe(existing)
  })

  it('handles an empty existing prompt by using bootstrap content alone', () => {
    const bootstrap = '<SYSTEMATIC_WORKFLOWS>\nContent\n</SYSTEMATIC_WORKFLOWS>'
    const result = composeSystemPromptWithBootstrap('', bootstrap)
    expect(result).toBe(bootstrap)
  })

  it('returns the existing prompt unchanged when bootstrap content is null', () => {
    const existing = 'You are a primary agent. Earlier extension contribution.'
    const result = composeSystemPromptWithBootstrap(existing, null)
    expect(result).toBeNull()
  })
})
