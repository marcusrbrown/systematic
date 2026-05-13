import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSourceCategoryModelCoverage,
  type BundledAgentInventory,
  buildBundledAgentInventory,
  inferBuiltInTemperature,
  validateAgentOverlays,
  validateSourceCategoryModelDefaults,
} from '../../src/lib/agent-overlays.js'
import type { SourcedOverlayConfig } from '../../src/lib/config.js'
import { createConfigHandler } from '../../src/lib/config-handler.js'
import { SECURITY_OVERLAY_FIELDS } from '../../src/lib/config-schema.js'

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

  test('category overlays accept hidden', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {},
          categories: {
            review: source('categories', 'review', { hidden: true }),
          },
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
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

  test('rejects fallback_models in exact agent overlays', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              fallback_models: ['openai/gpt-4'],
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).toThrow(/agents\.correctness-reviewer\.fallback_models/)
  })

  test('rejects fallback_models in category overlays', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {},
          categories: {
            review: source('categories', 'review', {
              fallback_models: ['openai/gpt-4'],
            }),
          },
        },
        nativeAgents: {},
      }),
    ).toThrow(/categories\.review\.fallback_models/)
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
      ['model', ' openai/gpt-4'],
      ['variant', ''],
      ['variant', ' small'],
      ['temperature', Number.NaN],
      ['temperature', -0.1],
      ['top_p', Number.POSITIVE_INFINITY],
      ['top_p', 1.1],
      ['mode', 'background'],
      ['steps', 0],
      ['hidden', 'true'],
      ['color', ' cyan'],
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

  test.each(['', ' cyan', '12345'])('rejects invalid color %p', (color) => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              color,
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).toThrow(/agents\.correctness-reviewer\.color/)
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

    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              skills: [' ce:review'],
            }),
          },
          categories: {},
        },
        nativeAgents: {},
        enabledSkills: ['ce:review'],
      }),
    ).toThrow(/agents\.correctness-reviewer\.skills/)
  })

  test('accepts null model as high-trust inheritance opt-out', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              model: null,
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
  })

  test('accepts null model in category overlays', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {},
          categories: {
            review: source('categories', 'review', { model: null }),
          },
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
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

describe('inferBuiltInTemperature', () => {
  test.each([
    ['correctness-reviewer', 'Reviews code', 0.1],
    ['security-sentinel', 'Audits risk', 0.1],
    ['architecture-strategist', 'Plans architecture', 0.2],
    ['repo-research-analyst', 'Researches repositories', 0.2],
    ['readme-writer', 'Writes docs', 0.3],
    ['changelog-editor', 'Edits release notes', 0.3],
    ['design-iterator', 'Creates visual concepts', 0.6],
    ['creative-ideator', 'Brainstorms product ideas', 0.6],
    ['general-helper', 'Handles miscellaneous work', 0.3],
  ])('returns %p temperature for %s', (name, description, expected) => {
    expect(inferBuiltInTemperature(name, description)).toBe(expected)
  })
})

describe('source category model defaults', () => {
  test('covers every discovered bundled category intentionally', () => {
    const inventory = buildBundledAgentInventory(
      path.join(process.cwd(), 'agents'),
      [],
    )

    expect(() =>
      assertSourceCategoryModelCoverage(inventory.categories),
    ).not.toThrow()
  })

  test('rejects malformed source model defaults through the shared model validator', () => {
    expect(() =>
      validateSourceCategoryModelDefaults({ review: 'gpt-5' }),
    ).toThrow(/review/)
  })

  test('rejects empty array in source category model defaults', () => {
    expect(() => validateSourceCategoryModelDefaults({ review: [] })).toThrow(
      /review/,
    )
  })

  test('rejects array with malformed model entry through shared model validator', () => {
    expect(() =>
      validateSourceCategoryModelDefaults({ review: ['malformed-no-slash'] }),
    ).toThrow(/review/)
  })

  test('accepts multi-entry valid array in source category model defaults', () => {
    expect(() =>
      validateSourceCategoryModelDefaults({
        review: ['openai/gpt-5.5', 'anthropic/claude-opus-4-7'],
      }),
    ).not.toThrow()
  })
})

describe('variant emission via overlay flow', () => {
  // Security-sensitive overlay fields (model, variant) can only be set in
  // user config or OPENCODE_CONFIG_DIR config, not project-level config.
  // Tests mock os.homedir() to isolate from the real user config.
  function withVariantTestEnv(
    systematicJson: Record<string, unknown> | null,
    run: (agentsDir: string, projectDir: string) => Promise<void>,
  ): Promise<void> {
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-variant-'),
    )
    const agentsDir = path.join(testDir, 'agents')
    const projectDir = path.join(testDir, 'project')
    const fakeHome = path.join(testDir, 'home')
    fs.mkdirSync(path.join(agentsDir, 'review'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
    fs.mkdirSync(path.join(fakeHome, '.config/opencode'), { recursive: true })
    fs.writeFileSync(
      path.join(agentsDir, 'review', 'correctness-reviewer.md'),
      '---\nname: correctness-reviewer\ndescription: Reviews code\n---\nPrompt',
    )
    if (systematicJson !== null) {
      // Write to user config (under fakeHome) — security overlay fields allowed here
      fs.writeFileSync(
        path.join(fakeHome, '.config/opencode/systematic.json'),
        JSON.stringify(systematicJson),
      )
    }
    const prevHomedir = os.homedir
    os.homedir = () => fakeHome
    return run(agentsDir, projectDir).finally(() => {
      os.homedir = prevHomedir
      fs.rmSync(testDir, { recursive: true, force: true })
    })
  }

  function makeClient(
    availability: string[],
  ): Parameters<typeof createConfigHandler>[0]['client'] {
    return {
      config: {
        providers: async () => ({
          data: {
            providers: availability.map((key) => {
              const slash = key.indexOf('/')
              const id = key.slice(0, slash)
              const model = key.slice(slash + 1)
              return { id, models: { [model]: {} } }
            }),
            default: {},
          },
          error: undefined,
        }),
      },
    }
  }

  test('integration: source variant emitted when no override', async () => {
    await withVariantTestEnv(null, async (agentsDir, projectDir) => {
      // review category, last-resort: anthropic/claude-sonnet-4-6, no variant
      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(agentsDir, '..', 'skills'),
        bundledAgentsDir: agentsDir,
        bundledCommandsDir: path.join(agentsDir, '..', 'commands'),
        client: makeClient([]),
      })
      const config: Record<string, unknown> = {}
      await handler(config as Parameters<typeof handler>[0])
      const agent = (config.agent as Record<string, unknown> | undefined)?.[
        'correctness-reviewer'
      ] as Record<string, unknown> | undefined
      expect(agent?.model).toBe('anthropic/claude-sonnet-4-6')
      expect(agent?.variant).toBeUndefined()
    })
  })

  test('integration: variant override at category level wins over source', async () => {
    await withVariantTestEnv(
      { categories: { review: { variant: 'high' } } },
      async (agentsDir, projectDir) => {
        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(agentsDir, '..', 'skills'),
          bundledAgentsDir: agentsDir,
          bundledCommandsDir: path.join(agentsDir, '..', 'commands'),
          client: makeClient([]),
        })
        const config: Record<string, unknown> = {}
        await handler(config as Parameters<typeof handler>[0])
        const agent = (config.agent as Record<string, unknown> | undefined)?.[
          'correctness-reviewer'
        ] as Record<string, unknown> | undefined
        expect(agent?.variant).toBe('high')
      },
    )
  })

  test('integration: partial model override at category level clears source variant', async () => {
    // review category resolves to anthropic/claude-sonnet-4-6 (no variant) by default.
    // Override model at category level without variant → no variant in emitted config.
    await withVariantTestEnv(
      { categories: { review: { model: 'openai/gpt-5.5' } } },
      async (agentsDir, projectDir) => {
        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(agentsDir, '..', 'skills'),
          bundledAgentsDir: agentsDir,
          bundledCommandsDir: path.join(agentsDir, '..', 'commands'),
          client: makeClient([]),
        })
        const config: Record<string, unknown> = {}
        await handler(config as Parameters<typeof handler>[0])
        const agent = (config.agent as Record<string, unknown> | undefined)?.[
          'correctness-reviewer'
        ] as Record<string, unknown> | undefined
        expect(agent?.model).toBe('openai/gpt-5.5')
        expect(agent?.variant).toBeUndefined()
      },
    )
  })

  test('integration: variant absence preserved when source has no variant', async () => {
    await withVariantTestEnv(null, async (agentsDir, projectDir) => {
      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(agentsDir, '..', 'skills'),
        bundledAgentsDir: agentsDir,
        bundledCommandsDir: path.join(agentsDir, '..', 'commands'),
        client: makeClient([]),
      })
      const config: Record<string, unknown> = {}
      await handler(config as Parameters<typeof handler>[0])
      const agent = (config.agent as Record<string, unknown> | undefined)?.[
        'correctness-reviewer'
      ] as Record<string, unknown> | undefined
      expect(Object.hasOwn(agent ?? {}, 'variant')).toBe(false)
    })
  })
})

describe('Zod-backed overlay validation', () => {
  test('SECURITY_OVERLAY_FIELDS derived from schema matches the hand-coded set', () => {
    const derived = Array.from(SECURITY_OVERLAY_FIELDS)
    const expected = ['model', 'variant', 'skills', 'permission']
    expect(derived.sort()).toEqual(expected.sort())
  })

  test('assertSourceCategoryModelDefaults passes for actual constants', () => {
    const actualConstants = {
      design: ['openai/gpt-5.5', 'anthropic/claude-opus-4-7'],
      docs: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
      'document-review': ['anthropic/claude-opus-4-7', 'openai/gpt-5.5'],
      research: ['openai/gpt-5.5', 'anthropic/claude-opus-4-7'],
      review: ['anthropic/claude-opus-4-7', 'openai/gpt-5.5'],
      workflow: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
    }
    expect(() =>
      validateSourceCategoryModelDefaults(actualConstants),
    ).not.toThrow()
  })

  test('validateAgentOverlays accepts trust-sensitive field from high-trust source', () => {
    const inventory = createInventory()
    expect(() =>
      validateAgentOverlays({
        inventory,
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              model: 'anthropic/claude-sonnet-4',
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).not.toThrow()
  })

  test('validateAgentOverlays produces errors with field paths for invalid input', () => {
    expect(() =>
      validateAgentOverlays({
        inventory: createInventory(),
        overlays: {
          agents: {
            'correctness-reviewer': source('agents', 'correctness-reviewer', {
              temperature: 'not-a-number',
            }),
          },
          categories: {},
        },
        nativeAgents: {},
      }),
    ).toThrow(/agents\.correctness-reviewer\.temperature/)
  })
})
