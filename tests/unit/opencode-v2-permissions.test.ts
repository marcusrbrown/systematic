import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin'

import type { PermissionRuleTriple } from '../../src/lib/asset-plan.js'
import { setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import {
  permissionMapToTriples,
  translatePermissionRules,
  type V2PermissionRule,
} from '../../src/lib/opencode-v2-permissions.js'
import { isRecord } from '../../src/lib/validation.js'
import { GOLDEN_ASSET_FILES } from '../fixtures/opencode-v1-goldens/assets.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

type Effect = 'allow' | 'ask' | 'deny'

const triple = (
  permission: string,
  pattern: string,
  setting: Effect,
): PermissionRuleTriple => ({ permission, pattern, setting })

/** Whole-value wildcard match: `*` is any run, `?` is one character. */
function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
  const source = escaped.replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${source}$`, 's').test(value)
}

/** The v2 rule: last matching rule wins; nothing matching asks. */
function evaluateV2(
  rules: readonly V2PermissionRule[],
  action: string,
  resource: string,
): Effect {
  let outcome: Effect = 'ask'
  for (const rule of rules) {
    if (
      wildcardMatches(rule.action, action) &&
      wildcardMatches(rule.resource, resource)
    ) {
      outcome = rule.effect
    }
  }
  return outcome
}

describe('translatePermissionRules', () => {
  test('keeps the list order and renames bash to shell and task to subagent', () => {
    const rules = translatePermissionRules([
      triple('bash', '*', 'ask'),
      triple('bash', 'git status *', 'allow'),
      triple('task', 'reviewer', 'deny'),
      triple('edit', 'src/**', 'allow'),
    ])

    expect(rules).toEqual([
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'shell', resource: 'git status *', effect: 'allow' },
      { action: 'subagent', resource: 'reviewer', effect: 'deny' },
      { action: 'edit', resource: 'src/**', effect: 'allow' },
    ])
  })

  test('drops doom_loop and lsp without error', () => {
    const rules = translatePermissionRules([
      triple('doom_loop', '*', 'deny'),
      triple('lsp', '*', 'allow'),
      triple('webfetch', '*', 'deny'),
    ])

    expect(rules).toEqual([
      { action: 'webfetch', resource: '*', effect: 'deny' },
    ])
  })

  test('an empty list yields no rules', () => {
    expect(translatePermissionRules([])).toEqual([])
  })

  test('a managed skills list is deny * then one allow per skill, with the skill id as the resource', () => {
    const rules = translatePermissionRules([
      triple('skill', '*', 'deny'),
      triple('skill', 'alpha', 'allow'),
      triple('skill', 'beta', 'allow'),
    ])

    expect(rules).toEqual([
      { action: 'skill', resource: '*', effect: 'deny' },
      { action: 'skill', resource: 'alpha', effect: 'allow' },
      { action: 'skill', resource: 'beta', effect: 'allow' },
    ])
    expect(evaluateV2(rules, 'skill', 'alpha')).toBe('allow')
    expect(evaluateV2(rules, 'skill', 'gamma')).toBe('deny')
  })

  test('integer-like skill ids keep list order, so a later allow beats the earlier deny', () => {
    const rules = translatePermissionRules([
      triple('skill', '*', 'deny'),
      triple('skill', '10', 'allow'),
      triple('skill', 'alpha', 'allow'),
      triple('skill', '2', 'allow'),
    ])

    expect(rules.map((rule) => rule.resource)).toEqual([
      '*',
      '10',
      'alpha',
      '2',
    ])
    for (const id of ['10', 'alpha', '2']) {
      expect(evaluateV2(rules, 'skill', id)).toBe('allow')
    }
    expect(evaluateV2(rules, 'skill', '1')).toBe('deny')
  })

  test('allow then deny * denies, because the last match wins', () => {
    const rules = translatePermissionRules([
      triple('skill', 'alpha', 'allow'),
      triple('skill', '*', 'deny'),
    ])

    expect(evaluateV2(rules, 'skill', 'alpha')).toBe('deny')
  })

  test('translating does not mutate the input list', () => {
    const input = [triple('bash', '*', 'deny')]
    const snapshot = structuredClone(input)

    translatePermissionRules(input)

    expect(input).toEqual(snapshot)
  })
})

describe('permissionMapToTriples', () => {
  test('a scalar setting becomes a * rule and a pattern map keeps its key order', () => {
    expect(
      permissionMapToTriples({
        webfetch: 'deny',
        bash: { '*': 'ask', 'git *': 'allow' },
      }),
    ).toEqual([
      triple('webfetch', '*', 'deny'),
      triple('bash', '*', 'ask'),
      triple('bash', 'git *', 'allow'),
    ])
  })

  test('ignores values that are not permission settings', () => {
    expect(
      permissionMapToTriples({
        edit: 'maybe',
        bash: { '*': 'ask', x: 3 },
        task: null,
      }),
    ).toEqual([triple('bash', '*', 'ask')])
  })

  test('returns nothing for a non-object', () => {
    expect(permissionMapToTriples(undefined)).toEqual([])
    expect(permissionMapToTriples('allow')).toEqual([])
    expect(permissionMapToTriples(['allow'])).toEqual([])
  })
})

// --- Corpus: the v1 goldens' permission outcomes, replayed through v2 ----------

const tempDirs = createTempDirTracker()
const GOLDEN_CONFIG_DIR = path.resolve(
  import.meta.dirname,
  '../fixtures/opencode-v1-goldens/expected/config-hook',
)

interface GoldenAgent {
  permission?: Record<string, unknown>
}

interface GoldenScenario {
  scenario: string
  systematicConfig: unknown
  outcome: string
  config: { agent: Record<string, GoldenAgent> }
}

function readGolden(name: string): GoldenScenario {
  return JSON.parse(
    fs.readFileSync(path.join(GOLDEN_CONFIG_DIR, `${name}.json`), 'utf8'),
  ) as GoldenScenario
}

/**
 * v1 evaluation of an emitted permission map, in the map's own key order:
 * the last matching pattern wins. Nothing matching leaves the host default,
 * which allows.
 */
function evaluateV1(
  permission: Record<string, unknown> | undefined,
  tool: string,
  resource: string,
): Effect {
  const rules = permission?.[tool]
  if (rules === 'allow' || rules === 'ask' || rules === 'deny') return rules
  if (!isRecord(rules)) return 'allow'
  let outcome: Effect = 'allow'
  for (const [pattern, setting] of Object.entries(rules)) {
    if (
      wildcardMatches(pattern, resource) &&
      (setting === 'allow' || setting === 'ask' || setting === 'deny')
    ) {
      outcome = setting
    }
  }
  return outcome
}

function probeResources(permission: Record<string, unknown>): string[] {
  const resources = new Set<string>(['unmatched-resource'])
  for (const rules of Object.values(permission)) {
    if (!isRecord(rules)) continue
    for (const pattern of Object.keys(rules)) {
      resources.add(pattern)
      resources.add(pattern.replaceAll('*', 'x').replaceAll('?', 'y'))
    }
  }
  return [...resources]
}

function writeTree(root: string, files: Readonly<Record<string, string>>) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

interface FakeAgent {
  permissions: V2PermissionRule[]
  request: { settings: object; headers: object; body: object }
}

/** The agents `setup` registers, keyed by id, over a skeleton like the host's default. */
async function registeredAgents(
  systematicConfig: unknown,
): Promise<Record<string, FakeAgent>> {
  const root = tempDirs.track(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-v2-corpus-')),
  )
  const packageRoot = path.join(root, 'pkg')
  const homeDir = path.join(root, 'home')
  const projectDir = path.join(root, 'project')
  writeTree(packageRoot, GOLDEN_ASSET_FILES)
  fs.mkdirSync(path.join(homeDir, '.config/opencode'), { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  // Overlay fields that grant or restrict tools are user-level only.
  fs.writeFileSync(
    path.join(homeDir, '.config/opencode/systematic.json'),
    JSON.stringify(systematicConfig ?? {}),
  )

  const transforms: ((editor: unknown) => void)[] = []
  const ctx = {
    location: { directory: projectDir },
    session: { async hook() {} },
    skill: { async transform() {} },
    command: {
      async list() {
        return { data: [] }
      },
      async transform() {},
    },
    tool: { async transform() {} },
    agent: {
      async transform(callback: (editor: unknown) => void) {
        transforms.push(callback)
      },
    },
  } as unknown as Plugin.Context
  await setupOpenCodeV2(ctx, { packageRoot, homeDir })

  const agents: Record<string, FakeAgent> = {}
  const editor = {
    get: () => undefined,
    update(id: string, update: (agent: FakeAgent) => void) {
      const agent: FakeAgent = {
        permissions: [],
        request: { settings: {}, headers: {}, body: {} },
      }
      update(agent)
      agents[id] = agent
    },
  }
  for (const transform of transforms) transform(editor)
  return agents
}

/** Every action the v1 agent has rules for gets the same outcome on every probed resource. */
function expectSameOutcomes(
  agentName: string,
  v1Agent: GoldenAgent,
  v2Agent: FakeAgent | undefined,
): number {
  const permission = v1Agent.permission
  if (v2Agent === undefined || permission === undefined) return 0
  let compared = 0
  // The host's own default is allow, which the appended rules refine.
  const rules: V2PermissionRule[] = [
    { action: '*', resource: '*', effect: 'allow' },
    ...v2Agent.permissions,
  ]
  for (const tool of Object.keys(permission)) {
    const action = translatePermissionRules([triple(tool, '*', 'ask')])[0]
      ?.action
    if (action === undefined) continue
    for (const resource of probeResources(permission)) {
      compared += 1
      expect({
        agent: agentName,
        action,
        resource,
        effect: evaluateV2(rules, action, resource),
      }).toEqual({
        agent: agentName,
        action,
        resource,
        effect: evaluateV1(permission, tool, resource),
      })
    }
  }
  return compared
}

const savedConfigDir = process.env.OPENCODE_CONFIG_DIR

beforeEach(() => {
  delete process.env.OPENCODE_CONFIG_DIR
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = savedConfigDir
  tempDirs.cleanup()
})

describe('v1 golden corpus replayed on v2', () => {
  const SCENARIOS = [
    'none',
    'category-permission',
    'exact-skills',
    'disabled',
    'skills-as-commands-off',
  ] as const

  for (const name of SCENARIOS) {
    test(`${name}: every agent gets the same allow, ask and deny outcome as v1`, async () => {
      const golden = readGolden(name)
      expect(golden.outcome).toBe('ok')
      const agents = await registeredAgents(golden.systematicConfig)

      // v1 emits these agents; the user's native `security-reviewer` replaces
      // the bundled one there, so v1 and v2 differ on that name only.
      const v1Agents = Object.entries(golden.config.agent).filter(
        ([agentName]) => agentName !== 'security-reviewer',
      )
      for (const [agentName] of v1Agents) {
        expect(Object.keys(agents)).toContain(agentName)
      }
      let compared = 0
      for (const [agentName, v1Agent] of v1Agents) {
        compared += expectSameOutcomes(agentName, v1Agent, agents[agentName])
      }
      // Scenarios that carry permission rules must actually compare something.
      if (name === 'category-permission' || name === 'exact-skills') {
        expect(compared).toBeGreaterThan(5)
      }
    })
  }

  test('integer-skills: v2 keeps list order, so the integer-like ids stay allowed where v1 hoists them behind deny *', async () => {
    const golden = readGolden('integer-skills')
    const v1Permission = golden.config.agent['correctness-reviewer']?.permission
    const agents = await registeredAgents(golden.systematicConfig)
    const rules = agents['correctness-reviewer']?.permissions ?? []

    // v1 folds the list into an object, which hoists '2' and '10' ahead of '*',
    // so `deny *` then wins over them. The pinned v1 output shows it.
    expect(evaluateV1(v1Permission, 'skill', '2')).toBe('deny')
    expect(evaluateV1(v1Permission, 'skill', '10')).toBe('deny')
    expect(evaluateV1(v1Permission, 'skill', 'fixture-alpha')).toBe('allow')

    // v2 translates the list directly, in its true order.
    expect(evaluateV2(rules, 'skill', '10')).toBe('allow')
    expect(evaluateV2(rules, 'skill', 'fixture-alpha')).toBe('allow')
    expect(evaluateV2(rules, 'skill', '2')).toBe('allow')
    expect(evaluateV2(rules, 'skill', 'fixture-beta')).toBe('deny')
    // The edit overlay still denies.
    expect(evaluateV2(rules, 'edit', 'anything')).toBe('deny')
  })
})
