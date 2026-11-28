/**
 * Shared asset plan.
 *
 * The plan is the host-neutral half of what the v1 `config` hook used to do
 * inline: which agents, commands and enabled skills exist, and an *ordered*
 * list of permission triples per agent. The v1 adapter folds that list back
 * into today's object map. These tests pin the plan against the v1 handler
 * output (the v1 golden tests pin the bytes; this file pins the seam).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/sdk'
import {
  type AssetPlan,
  type AssetPlanInput,
  buildAssetPlan,
  type PermissionRuleTriple,
  type PlannedAgent,
} from '../../src/lib/asset-plan.js'
import { loadConfigWithSources } from '../../src/lib/config.js'
import {
  createConfigHandler,
  foldPermissionRulesToV1Map,
  toV1AgentConfig,
} from '../../src/lib/config-handler.js'
import { isRecord } from '../../src/lib/validation.js'
import {
  GOLDEN_ASSET_FILES,
  GOLDEN_DISCOVERED_SKILL_FILES,
} from '../fixtures/opencode-v1-goldens/assets.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const tempDirs = createTempDirTracker()

interface Fixture {
  root: string
  bundledRoot: string
  homeDir: string
  project: string
  customDir: string
}

let fixture: Fixture
let originalHomedir: typeof os.homedir
let originalConfigDirEnv: string | undefined

function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

beforeEach(() => {
  originalHomedir = os.homedir
  originalConfigDirEnv = process.env.OPENCODE_CONFIG_DIR

  const root = tempDirs.track(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asset-plan-')),
  )
  fixture = {
    root,
    bundledRoot: path.join(root, 'bundled'),
    homeDir: path.join(root, 'home'),
    project: path.join(root, 'project'),
    customDir: path.join(root, 'custom'),
  }
  fs.mkdirSync(fixture.homeDir, { recursive: true })
  fs.mkdirSync(fixture.project, { recursive: true })
  writeTree(fixture.bundledRoot, GOLDEN_ASSET_FILES)
  writeTree(fixture.project, GOLDEN_DISCOVERED_SKILL_FILES)

  os.homedir = () => fixture.homeDir
  delete process.env.OPENCODE_CONFIG_DIR
})

afterEach(() => {
  os.homedir = originalHomedir
  if (originalConfigDirEnv === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDirEnv
  tempDirs.cleanup()
})

function writeSystematicConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(fixture.customDir, { recursive: true })
  fs.writeFileSync(
    path.join(fixture.customDir, 'systematic.json'),
    JSON.stringify(config),
  )
  process.env.OPENCODE_CONFIG_DIR = fixture.customDir
}

function bundledDirs() {
  return {
    bundledSkillsDir: path.join(fixture.bundledRoot, 'skills'),
    bundledAgentsDir: path.join(fixture.bundledRoot, 'agents'),
    bundledCommandsDir: path.join(fixture.bundledRoot, 'commands'),
  }
}

function planInput(nativeAgentNames: readonly string[] = []): AssetPlanInput {
  const { config, overlays } = loadConfigWithSources(fixture.project)
  return {
    config,
    overlays,
    nativeAgentNames,
    directory: fixture.project,
    homeDir: fixture.homeDir,
    opencodeConfigDir: path.join(fixture.homeDir, '.config/opencode'),
    opencodeConfigDirOverride: process.env.OPENCODE_CONFIG_DIR,
    ...bundledDirs(),
  }
}

function planWith(
  config: Record<string, unknown> | undefined,
  nativeAgentNames: readonly string[] = [],
): AssetPlan {
  if (config !== undefined) writeSystematicConfig(config)
  return buildAssetPlan(planInput(nativeAgentNames))
}

async function runV1Handler(incoming: Config = {}): Promise<Config> {
  const handler = createConfigHandler({
    directory: fixture.project,
    homeDir: fixture.homeDir,
    ...bundledDirs(),
  })
  await handler(incoming)
  return incoming
}

function agentNamed(plan: AssetPlan, name: string): PlannedAgent {
  const agent = plan.agents[name]
  if (agent === undefined) throw new Error(`Plan has no agent ${name}`)
  return agent
}

function managedRules(
  plan: AssetPlan,
  name: string,
): readonly PermissionRuleTriple[] {
  const { permission } = agentNamed(plan, name)
  if (permission.kind !== 'managed') {
    throw new Error(`Agent ${name} has no managed permission rules`)
  }
  return permission.rules
}

function skillTriples(
  rules: readonly PermissionRuleTriple[],
): [string, string][] {
  return rules
    .filter((rule) => rule.permission === 'skill')
    .map((rule) => [rule.pattern, rule.setting])
}

describe('buildAssetPlan: agreement with the v1 handler', () => {
  test('lists the same agents, commands and enabled skills as the folded v1 map for the golden tree', async () => {
    const plan = planWith(undefined)
    const emitted = await runV1Handler()

    expect(Object.keys(plan.agents)).toEqual(Object.keys(emitted.agent ?? {}))
    expect(Object.keys(plan.commands)).toEqual(
      Object.keys(emitted.command ?? {}),
    )
    // The two integer-like fixture skills are enabled alongside the named ones.
    expect([...plan.enabledSkills].sort()).toEqual(
      [
        '10',
        '2',
        'fixture-alpha',
        'fixture-args',
        'fixture-beta',
        'ns:fixture-gamma',
        'fixture-hidden',
        'fixture-manual',
        'fixture-routed',
        'git-worktree',
        'using-systematic',
      ].sort(),
    )
    expect(plan.skillsDir).toBe(bundledDirs().bundledSkillsDir)

    // Folding each planned agent reproduces the handler's agent bytes.
    for (const [name, planned] of Object.entries(plan.agents)) {
      const folded = toV1AgentConfig(planned)
      expect(JSON.stringify(folded)).toBe(JSON.stringify(emitted.agent?.[name]))
    }
    for (const [name, command] of Object.entries(plan.commands)) {
      expect(JSON.stringify(command)).toBe(
        JSON.stringify(emitted.command?.[name]),
      )
    }
  })

  test('folded permission output matches the handler for an overlay scenario', async () => {
    writeSystematicConfig({
      categories: {
        review: {
          permission: {
            bash: 'ask',
            edit: { '*': 'deny', 'src/**': 'allow' },
          },
        },
      },
      agents: { 'correctness-reviewer': { skills: ['fixture-beta'] } },
    })
    const plan = buildAssetPlan(planInput())
    const emitted = await runV1Handler()

    for (const [name, planned] of Object.entries(plan.agents)) {
      expect(JSON.stringify(toV1AgentConfig(planned))).toBe(
        JSON.stringify(emitted.agent?.[name]),
      )
    }
  })
})

describe('buildAssetPlan: agent set', () => {
  test('an empty nativeAgentNames keeps every bundled agent', () => {
    const plan = planWith(undefined, [])
    expect(Object.keys(plan.agents).sort()).toEqual([
      'adversarial-reviewer',
      'correctness-reviewer',
      'repo-research-analyst',
      'security-reviewer',
    ])
  })

  test('a native agent name drops the bundled agent of the same name and nothing else', () => {
    const plan = planWith(undefined, ['security-reviewer'])
    expect(Object.keys(plan.agents).sort()).toEqual([
      'adversarial-reviewer',
      'correctness-reviewer',
      'repo-research-analyst',
    ])
  })

  test('disabled skills, agents and commands are absent from the plan', () => {
    const plan = planWith({
      disabled_skills: ['git-worktree'],
      disabled_agents: ['adversarial-reviewer'],
      disabled_commands: ['fixture-command'],
    })
    expect(plan.enabledSkills).not.toContain('git-worktree')
    expect(plan.commands).not.toHaveProperty('systematic:git-worktree')
    expect(plan.commands).not.toHaveProperty('systematic:fixture-command')
    expect(plan.agents).not.toHaveProperty('adversarial-reviewer')
    expect(plan.commands).toHaveProperty('systematic:fixture-alpha')
  })

  test('skills_as_commands=false drops discovered skills but keeps bundled skill commands', () => {
    const baseline = planWith(undefined)
    expect(Object.keys(baseline.commands)).toContain('fixture-discovered')

    const off = planWith({ skills_as_commands: false })
    expect(Object.keys(off.commands)).not.toContain('fixture-discovered')
    expect(Object.keys(off.commands)).toContain('systematic:fixture-alpha')
  })
})

describe('buildAssetPlan: routing fields of discovered skills', () => {
  function writeRoutedSkill(name: string, routing: string): void {
    const dir = path.join(fixture.project, '.claude/skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Routed ${name}\n${routing}---\n# ${name}\n\nBody.\n`,
    )
  }

  test('a discovered command never carries routing fields; the declared values are listed apart', () => {
    writeRoutedSkill('routed', 'context: fork\nagent: Explore\nmodel: sonnet\n')
    const plan = planWith(undefined)

    expect(Object.keys(plan.commands.routed ?? {}).sort()).toEqual([
      'description',
      'template',
    ])
    expect(plan.discoveredRouting).toEqual({
      routed: { agent: 'Explore', model: 'sonnet', subtask: true },
    })
  })

  test('a discovered skill that declares nothing is not listed', () => {
    const plan = planWith(undefined)

    expect(plan.commands).toHaveProperty('fixture-discovered')
    expect(plan.discoveredRouting).toEqual({})
  })

  test('a routing declaration is dropped from the list when its command is suppressed', () => {
    writeRoutedSkill('routed', 'context: fork\n')
    const plan = planWith({ disabled_commands: ['routed'] })

    expect(plan.commands).not.toHaveProperty('routed')
    expect(plan.discoveredRouting).toEqual({})
  })
})

describe('buildAssetPlan: agent overlay fields', () => {
  // The config schema rejects a wrongly-typed value for any of these fields
  // when the config loads, so a bad value never reaches the planner and there
  // is no negative case to pin here.
  test('an exact overlay setting all six fields reaches the planned agent config', () => {
    const plan = planWith({
      agents: {
        'adversarial-reviewer': {
          temperature: 0.3,
          top_p: 0.8,
          steps: 7,
          mode: 'primary',
          color: '#112233',
          hidden: true,
        },
      },
    })

    const { config } = agentNamed(plan, 'adversarial-reviewer')
    expect(config.temperature).toBe(0.3)
    expect(config.top_p).toBe(0.8)
    expect(config.steps).toBe(7)
    // The bundled agent's own frontmatter says `subagent`; the overlay wins.
    expect(config.mode).toBe('primary')
    expect(config.color).toBe('#112233')
    expect(config.hidden).toBe(true)
  })
})

describe('buildAssetPlan: ordered permission triples', () => {
  test('an agent without a permission overlay is unmanaged and keeps its own permission', () => {
    const plan = planWith(undefined)
    const agent = agentNamed(plan, 'adversarial-reviewer')
    expect(agent.permission).toEqual({ kind: 'unmanaged' })
    expect(agent.config.permission).toBeUndefined()

    const frontmatterOwned = agentNamed(plan, 'correctness-reviewer')
    expect(frontmatterOwned.permission).toEqual({ kind: 'unmanaged' })
    expect(frontmatterOwned.config.permission).toBeDefined()
  })

  test('a managed skills list is deny * then one allow per skill, in list order', () => {
    const plan = planWith({
      agents: {
        'correctness-reviewer': { skills: ['fixture-beta', 'fixture-alpha'] },
      },
    })
    expect(managedRules(plan, 'correctness-reviewer')).toEqual([
      { permission: 'edit', pattern: '*', setting: 'deny' },
      {
        permission: 'skill',
        pattern: '*',
        setting: 'deny',
        fromSkillsList: true,
      },
      {
        permission: 'skill',
        pattern: 'fixture-beta',
        setting: 'allow',
        fromSkillsList: true,
      },
      {
        permission: 'skill',
        pattern: 'fixture-alpha',
        setting: 'allow',
        fromSkillsList: true,
      },
    ])
  })

  test('a hand-written rule that overrides a list rule for the same skill is no longer marked as from the list', () => {
    const plan = planWith({
      categories: { review: { skills: ['fixture-alpha', 'fixture-beta'] } },
      agents: {
        'correctness-reviewer': {
          permission: { skill: { 'fixture-alpha': 'allow' } },
        },
      },
    })
    const marked = managedRules(plan, 'correctness-reviewer')
      .filter((rule) => rule.permission === 'skill')
      .map((rule) => [rule.pattern, rule.fromSkillsList === true])
    expect(marked).toEqual([
      ['*', true],
      ['fixture-beta', true],
      ['fixture-alpha', false],
    ])
  })

  test('an exact skills overlay over a category overlay re-appends * after the category allows', () => {
    const plan = planWith({
      categories: { review: { skills: ['fixture-alpha', 'fixture-beta'] } },
      agents: {
        'correctness-reviewer': { skills: ['fixture-beta'] },
        'repo-research-analyst': { skills: [] },
      },
    })
    expect(skillTriples(managedRules(plan, 'correctness-reviewer'))).toEqual([
      ['fixture-alpha', 'allow'],
      ['*', 'deny'],
      ['fixture-beta', 'allow'],
    ])
    // An explicitly empty managed list is deny-all with no allows.
    expect(skillTriples(managedRules(plan, 'repo-research-analyst'))).toEqual([
      ['*', 'deny'],
    ])
  })

  test('integer-like skill names keep true insertion order in the list, and the v1 fold reproduces the hoisted map', () => {
    const plan = planWith({
      agents: {
        'correctness-reviewer': { skills: ['10', 'fixture-alpha', '2'] },
      },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    // The ordered list is NOT hoisted: * deny first, then the allows as given.
    expect(skillTriples(rules)).toEqual([
      ['*', 'deny'],
      ['10', 'allow'],
      ['fixture-alpha', 'allow'],
      ['2', 'allow'],
    ])

    // The v1 fold is a plain object, so it hoists '2' and '10' ahead of '*'.
    // This is today's v1 behavior, pinned by the v1 golden tests; it is a known
    // hazard, deliberately not fixed here.
    const folded = foldPermissionRulesToV1Map(rules)
    // The list's allows also carry the prefixed form, placed after each bare one.
    expect(Object.entries(folded?.skill ?? {})).toEqual([
      ['2', 'allow'],
      ['10', 'allow'],
      ['*', 'deny'],
      ['systematic:10', 'allow'],
      ['fixture-alpha', 'allow'],
      ['systematic:fixture-alpha', 'allow'],
      ['systematic:2', 'allow'],
    ])
  })
})

describe('foldPermissionRulesToV1Map', () => {
  test('returns undefined for an empty list', () => {
    expect(foldPermissionRulesToV1Map([])).toBeUndefined()
  })

  test('groups by permission in first-appearance order and keeps pattern order', () => {
    const folded = foldPermissionRulesToV1Map([
      { permission: 'edit', pattern: '*', setting: 'deny' },
      { permission: 'bash', pattern: '*', setting: 'ask' },
      { permission: 'edit', pattern: 'src/**', setting: 'allow' },
    ])
    expect(Object.keys(folded ?? {})).toEqual(['edit', 'bash'])
    expect(Object.entries(folded?.edit ?? {})).toEqual([
      ['*', 'deny'],
      ['src/**', 'allow'],
    ])
  })

  test('a repeated permission and pattern is last-match-wins and moves to the end', () => {
    const folded = foldPermissionRulesToV1Map([
      { permission: 'skill', pattern: '*', setting: 'deny' },
      { permission: 'skill', pattern: 'a', setting: 'allow' },
      { permission: 'skill', pattern: '*', setting: 'allow' },
    ])
    expect(Object.entries(folded?.skill ?? {})).toEqual([
      ['a', 'allow'],
      ['*', 'allow'],
    ])
  })

  test('an explicit prefixed allow set before the list still reaches systematic_skill', () => {
    const folded = foldPermissionRulesToV1Map([
      { permission: 'skill', pattern: 'systematic:a', setting: 'allow' },
      {
        permission: 'skill',
        pattern: '*',
        setting: 'deny',
        fromSkillsList: true,
      },
      {
        permission: 'skill',
        pattern: 'a',
        setting: 'allow',
        fromSkillsList: true,
      },
    ])
    expect(Object.entries(folded?.skill ?? {})).toEqual([
      ['*', 'deny'],
      ['a', 'allow'],
      ['systematic:a', 'allow'],
    ])
  })
})

describe('buildAssetPlan: invalid config', () => {
  test('the builder never reads config files; the throw stays at the v1 loader seam', async () => {
    writeSystematicConfig({ disabled_skills: ['git-worktree'] })
    const input = planInput()

    // Break the file after it was loaded. The plan is built from `input`.
    fs.writeFileSync(
      path.join(fixture.customDir, 'systematic.json'),
      '{ "disabled_skills": "not-an-array" }',
    )
    const plan = buildAssetPlan(input)
    expect(plan.enabledSkills).not.toContain('git-worktree')

    // The v1 handler re-reads config on every call and throws, exactly as before.
    await expect(runV1Handler()).rejects.toThrow('Invalid Systematic config in')
    expect(() => loadConfigWithSources(fixture.project)).toThrow(
      'Invalid Systematic config in',
    )
  })
})

describe('buildAssetPlan: purity', () => {
  test('the same input yields the same plan and the input is not mutated', () => {
    writeSystematicConfig({
      agents: { 'correctness-reviewer': { skills: ['fixture-alpha'] } },
    })
    const input = planInput(['security-reviewer'])
    const before = structuredClone({
      config: input.config,
      overlays: input.overlays,
      nativeAgentNames: input.nativeAgentNames,
    })

    const first = buildAssetPlan(input)
    const second = buildAssetPlan(input)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect({
      config: input.config,
      overlays: input.overlays,
      nativeAgentNames: input.nativeAgentNames,
    }).toEqual(before)
    expect(isRecord(first.agents)).toBe(true)
  })
})

describe('buildAssetPlan: an ordered allow list in frontmatter', () => {
  const LISTED_TOOLS = [
    'read',
    'grep',
    'glob',
    'bash',
    'webfetch',
    'systematic_search',
    'execute',
  ] as const

  const BLOCK_ORDER = [
    '*',
    ...LISTED_TOOLS,
    'external_directory',
  ] as const satisfies readonly string[]

  const ALLOW_LIST_AGENT = `---
name: correctness-reviewer
description: Reads with an ordered allow list
mode: subagent
permission:
  '*': deny
${LISTED_TOOLS.map((tool) => `  ${tool}: allow`).join('\n')}
  external_directory: allow
---
# Correctness Reviewer

Fixture prompt.
`

  const blockTriples: PermissionRuleTriple[] = BLOCK_ORDER.map(
    (permission) => ({
      permission,
      pattern: '*',
      setting: permission === '*' ? 'deny' : 'allow',
    }),
  )

  // Overlay targets must be bundled agent names, so the fixture reviewer's
  // file is replaced by one that carries the block.
  beforeEach(() => {
    writeTree(fixture.bundledRoot, {
      'agents/review/correctness-reviewer.md': ALLOW_LIST_AGENT,
    })
  })

  /** The last rule that matches `tool`, or nothing: last match wins. */
  function outcome(
    rules: readonly PermissionRuleTriple[],
    tool: string,
  ): PermissionRuleTriple['setting'] | undefined {
    return rules.findLast(
      (rule) => rule.permission === '*' || rule.permission === tool,
    )?.setting
  }

  test('without an overlay the agent keeps the block as written, in order', () => {
    const agent = agentNamed(planWith(undefined), 'correctness-reviewer')

    expect(agent.permission).toEqual({ kind: 'unmanaged' })
    expect(Object.entries(agent.config.permission ?? {})).toEqual(
      blockTriples.map(({ permission, setting }) => [permission, setting]),
    )
  })

  test('without an overlay the v1 agent config carries the block in order', () => {
    const folded = toV1AgentConfig(
      agentNamed(planWith(undefined), 'correctness-reviewer'),
    )

    expect(Object.keys(folded.permission ?? {})).toEqual([...BLOCK_ORDER])
    expect(folded.permission).toEqual(
      Object.fromEntries(
        blockTriples.map(({ permission, setting }) => [permission, setting]),
      ),
    )
  })

  test('an overlay that sets another permission keeps the block first, in order, as triples', () => {
    const plan = planWith({
      agents: { 'correctness-reviewer': { permission: { edit: 'ask' } } },
    })

    expect(managedRules(plan, 'correctness-reviewer')).toEqual([
      ...blockTriples,
      { permission: 'edit', pattern: '*', setting: 'ask' },
    ])
  })

  test('an overlay bash: deny makes deny the last rule for bash, in the block place', () => {
    const plan = planWith({
      agents: { 'correctness-reviewer': { permission: { bash: 'deny' } } },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    expect(rules).toEqual(
      blockTriples.map((rule) =>
        rule.permission === 'bash' ? { ...rule, setting: 'deny' } : rule,
      ),
    )
    expect(outcome(rules, 'bash')).toBe('deny')
    expect(outcome(rules, 'read')).toBe('allow')
    expect(foldPermissionRulesToV1Map(rules)?.bash).toEqual({ '*': 'deny' })
  })

  test('an overlay systematic_skill: allow comes after every rule of the block', () => {
    const plan = planWith({
      agents: {
        'correctness-reviewer': { permission: { systematic_skill: 'allow' } },
      },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    expect(rules).toEqual([
      ...blockTriples,
      { permission: 'systematic_skill', pattern: '*', setting: 'allow' },
    ])
    expect(outcome(rules, 'systematic_skill')).toBe('allow')
    expect(outcome(rules, 'write')).toBe('deny')
  })

  test("an overlay '*': deny does not turn the listed allows off (current behaviour)", () => {
    const plan = planWith({
      agents: { 'correctness-reviewer': { permission: { '*': 'deny' } } },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    expect(rules).toEqual(blockTriples)
    for (const tool of [...LISTED_TOOLS, 'external_directory']) {
      expect(outcome(rules, tool)).toBe('allow')
    }
    expect(outcome(rules, 'write')).toBe('deny')
  })

  test("an overlay '*': ask moves the wildcard group in place and leaves the listed allows in force", () => {
    const plan = planWith({
      agents: { 'correctness-reviewer': { permission: { '*': 'ask' } } },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    expect(rules).toEqual(
      blockTriples.map((rule) =>
        rule.permission === '*' ? { ...rule, setting: 'ask' } : rule,
      ),
    )
    expect(outcome(rules, 'read')).toBe('allow')
    expect(outcome(rules, 'write')).toBe('ask')
  })

  test('external_directory: allow after the wildcard survives in order through the fold', () => {
    const plan = planWith({
      agents: { 'correctness-reviewer': { permission: { edit: 'ask' } } },
    })
    const folded = foldPermissionRulesToV1Map(
      managedRules(plan, 'correctness-reviewer'),
    )

    expect(Object.keys(folded ?? {})).toEqual([...BLOCK_ORDER, 'edit'])
    expect(folded?.['*']).toEqual({ '*': 'deny' })
    expect(folded?.external_directory).toEqual({ '*': 'allow' })
  })
})

describe('buildAssetPlan: an overlay rule for a tool the shipped reviewer block names', () => {
  /** The last whole-tool rule that matches `tool`: last match wins. */
  function outcome(
    rules: readonly PermissionRuleTriple[],
    tool: string,
  ): PermissionRuleTriple['setting'] | undefined {
    return rules.findLast(
      (rule) =>
        rule.pattern === '*' &&
        (rule.permission === '*' || rule.permission === tool),
    )?.setting
  }

  const SHIPPED_REVIEWER = fs.readFileSync(
    path.join(import.meta.dir, '../../agents/review/correctness-reviewer.md'),
    'utf8',
  )

  beforeEach(() => {
    writeTree(fixture.bundledRoot, {
      'agents/review/correctness-reviewer.md': SHIPPED_REVIEWER,
    })
  })

  test('with no wildcard overlay, an agent allow brings the tool back', () => {
    const plan = planWith({
      agents: {
        'correctness-reviewer': { permission: { systematic_skill: 'allow' } },
      },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    expect(outcome(rules, 'systematic_skill')).toBe('allow')
    expect(outcome(rules, 'task')).toBe('deny')
  })

  // The block seeds each named tool before any overlay, and a later rule for
  // that tool is set in place. A wildcard written by an overlay comes after it.
  test("under an overlay '*': deny, an allow for a tool the block names stays hidden", () => {
    const plan = planWith({
      categories: { review: { permission: { '*': 'deny' } } },
      agents: {
        'correctness-reviewer': {
          permission: { systematic_skill: 'allow', read: 'allow' },
        },
      },
    })
    const rules = managedRules(plan, 'correctness-reviewer')

    expect(outcome(rules, 'systematic_skill')).toBe('deny')
    expect(outcome(rules, 'read')).toBe('allow')
  })
})
