import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type BundledAgentInventory,
  buildBundledAgentInventory,
  validateAgentOverlays,
} from '../../src/lib/agent-overlays.js'
import type { SourcedOverlayConfig } from '../../src/lib/config.js'

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-overlays-'))
  try {
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function createAgent(root: string, category: string, stem: string): void {
  const categoryDir = path.join(root, category)
  fs.mkdirSync(categoryDir, { recursive: true })
  fs.writeFileSync(
    path.join(categoryDir, `${stem}.md`),
    `---\nname: ${stem}\ndescription: ${stem}\n---\nPrompt`,
  )
}

function source(
  mapKey: 'agents' | 'categories',
  key: string,
  value: Record<string, unknown>,
): SourcedOverlayConfig {
  return {
    value,
    sourcePath: '/tmp/systematic.json',
    keyPath: `${mapKey}.${key}`,
  }
}

function createInventory(): BundledAgentInventory {
  return {
    agentsByQualifiedId: {
      'review/correctness-reviewer': {
        id: 'review/correctness-reviewer',
        key: 'correctness-reviewer',
        category: 'review',
        file: '/agents/review/correctness-reviewer.md',
        disabled: false,
      },
      'workflow/disabled-helper': {
        id: 'workflow/disabled-helper',
        key: 'disabled-helper',
        category: 'workflow',
        file: '/agents/workflow/disabled-helper.md',
        disabled: true,
      },
    },
    aliases: {
      'correctness-reviewer': 'review/correctness-reviewer',
      'review/correctness-reviewer': 'review/correctness-reviewer',
      'disabled-helper': 'workflow/disabled-helper',
      'workflow/disabled-helper': 'workflow/disabled-helper',
    },
    categories: ['review', 'workflow'],
  }
}

describe('buildBundledAgentInventory', () => {
  test('builds direct category inventory with qualified ids and unique aliases', () => {
    withTempDir((dir) => {
      createAgent(dir, 'review', 'correctness-reviewer')

      const inventory = buildBundledAgentInventory(dir, [])

      expect(inventory.categories).toEqual(['review'])
      expect(inventory.aliases['correctness-reviewer']).toBe(
        'review/correctness-reviewer',
      )
      expect(inventory.aliases['review/correctness-reviewer']).toBe(
        'review/correctness-reviewer',
      )
    })
  })

  test('rejects duplicate bundled stems before config application', () => {
    withTempDir((dir) => {
      createAgent(dir, 'review', 'shared')
      createAgent(dir, 'workflow', 'shared')

      expect(() => buildBundledAgentInventory(dir, [])).toThrow(
        /Duplicate bundled agent stem "shared"/,
      )
    })
  })
})

describe('validateAgentOverlays', () => {
  test('unqualified unique key and qualified key each resolve to same bundled agent when used alone', () => {
    const inventory = createInventory()

    const unqualified = validateAgentOverlays({
      inventory,
      overlays: {
        agents: {
          'correctness-reviewer': source('agents', 'correctness-reviewer', {
            model: 'openai/gpt-4',
          }),
        },
        categories: {},
      },
      nativeAgents: {},
    })
    const qualified = validateAgentOverlays({
      inventory,
      overlays: {
        agents: {
          'review/correctness-reviewer': source(
            'agents',
            'review/correctness-reviewer',
            { model: 'openai/gpt-4' },
          ),
        },
        categories: {},
      },
      nativeAgents: {},
    })

    expect(unqualified.agents[0]?.target.id).toBe('review/correctness-reviewer')
    expect(qualified.agents[0]?.target.id).toBe('review/correctness-reviewer')
  })

  test('both key forms for same target fail duplicate-target validation', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              model: 'openai/gpt-4',
            }),
            'review/correctness-reviewer': source(
              'agents',
              'review/correctness-reviewer',
              { temperature: 0.2 },
            ),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).toThrow(
      /Duplicate Systematic agent overlay target.*agents\.correctness-reviewer.*agents\.review\/correctness-reviewer/s,
    )
  })

  test('known category validates and unknown category lists valid categories', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {},
          categories: {
            review: source('categories', 'review', { temperature: 0.2 }),
          },
        },
        nativeAgents: {},
      }),
    ).not.toThrow()

    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {},
          categories: {
            unknown: source('categories', 'unknown', { temperature: 0.2 }),
          },
        },
        nativeAgents: {},
      }),
    ).toThrow(/categories\.unknown.*Valid categories: review, workflow/)
  })

  test('rejects unknown and unsupported fields with key path', () => {
    for (const field of [
      'unknown',
      'tools',
      'prompt',
      'description',
      'options',
      'mcps',
    ]) {
      expect(() =>
        validateAgentOverlays({
          inventory: createInventory(),
          overlays: {
            agents: {
              'correctness-reviewer': source('agents', 'correctness-reviewer', {
                [field]: true,
              }),
            },
            categories: {},
          },
          nativeAgents: {},
        }),
      ).toThrow(new RegExp(`agents\\.correctness-reviewer\\.${field}`))
    }
  })

  test('rejects category disable but accepts exact disable', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {},
          categories: {
            review: source('categories', 'review', { disable: true }),
          },
        },
        nativeAgents: {},
      }),
    ).toThrow(/categories\.review\.disable/)

    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              disable: true,
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
  })

  test('malformed scalar fields and permission fail with source path and key path', () => {
    const invalidCases: Array<[string, unknown]> = [
      ['model', 'gpt-4'],
      ['model', 'inherit'],
      ['variant', ''],
      ['temperature', Number.NaN],
      ['top_p', Number.POSITIVE_INFINITY],
      ['mode', 'background'],
      ['steps', 0],
      ['hidden', 'true'],
      ['color', 'not a color'],
      ['permission', { read: 'maybe' }],
    ]

    for (const [field, value] of invalidCases) {
      expect(() =>
        validateAgentOverlays({
          inventory: createInventory(),
          overlays: {
            agents: {
              'correctness-reviewer': source('agents', 'correctness-reviewer', {
                [field]: value,
              }),
            },
            categories: {},
          },
          nativeAgents: {},
        }),
      ).toThrow(
        new RegExp(
          `/tmp/systematic\\.json.*agents\\.correctness-reviewer\\.${field}`,
        ),
      )
    }
  })

  test('native replacement conflicts with exact unqualified and qualified overlays', () => {
    for (const key of ['correctness-reviewer', 'review/correctness-reviewer']) {
      expect(() =>
        validateAgentOverlays({
          inventory: createInventory(),
          overlays: {
            agents: {
              [key]: source('agents', key, { model: 'openai/gpt-4' }),
            },
            categories: {},
          },
          nativeAgents: { 'correctness-reviewer': { prompt: 'native' } },
        }),
      ).toThrow(/native OpenCode agent\.correctness-reviewer/)
    }
  })

  test('disabled exact overlay validates unless same emitted key is native replacement', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'disabled-helper': source('agents', 'disabled-helper', {
              model: 'openai/gpt-4',
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()

    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'disabled-helper': source('agents', 'disabled-helper', {
              model: 'openai/gpt-4',
            }),
          },
          categories: {},
        },
        nativeAgents: { 'disabled-helper': { prompt: 'native' } },
      }),
    ).toThrow(/native OpenCode agent\.disabled-helper/)
  })

  test('validates OpenCode permission shapes without MCP/provider semantics', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              permission: {
                read: 'allow',
                grep: { '**/*.ts': 'allow' },
                skill: { 'ce:*': 'allow' },
                bash: { '*': 'ask' },
                'custom.tool': { 'provider/*': 'deny' },
              },
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
  })

  test('rejects same overlay object with managed skills and explicit permission.skill', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              skills: ['ce:review'],
              permission: { skill: { '*': 'deny' } },
            }),
          },
          categories: {},
        },
        nativeAgents: {},
        enabledSkills: ['ce:review'],
      }),
    ).toThrow(
      /agents\.correctness-reviewer.*cannot set both skills and permission\.skill/,
    )
  })

  test('rejects unknown or disabled managed skill names', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              skills: ['missing-skill'],
            }),
          },
          categories: {},
        },
        nativeAgents: {},
        enabledSkills: ['ce:review'],
      }),
    ).toThrow(
      /agents\.correctness-reviewer\.skills.*unknown or disabled skill "missing-skill"/,
    )
  })

  test('model requires provider/model and does not normalize shorthand', () => {
    for (const model of ['gpt-4', 'inherit']) {
      expect(() =>
        validateAgentOverlays({
          inventory: createInventory(),
          overlays: {
            agents: {
              'correctness-reviewer': source('agents', 'correctness-reviewer', {
                model,
              }),
            },
            categories: {},
          },
          nativeAgents: {},
        }),
      ).toThrow(/agents\.correctness-reviewer\.model/)
    }

    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              model: 'openai/gpt-4',
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()

    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              model: 'openrouter/anthropic/claude-sonnet-4',
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
  })
})
