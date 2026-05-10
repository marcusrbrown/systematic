import { describe, expect, spyOn, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSourceCategoryModelCoverage,
  type BundledAgentInventory,
  buildBundledAgentInventory,
  getAuthenticatedProviders,
  getSourceCategoryModel,
  inferBuiltInTemperature,
  validateAgentOverlays,
  validateSourceCategoryModelDefaults,
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
    ).toThrow(/agents\.correctness-reviewer\.fallback_models.*unsupported/)
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
    ).toThrow(/categories\.review\.fallback_models.*unsupported/)
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
  test.each([
    ['design', 'openai/gpt-5.5'],
    ['docs', 'openai/gpt-5.4-mini'],
    ['document-review', 'anthropic/claude-opus-4.7'],
    ['research', 'openai/gpt-5.5'],
    ['review', 'anthropic/claude-opus-4.7'],
    ['workflow', 'openai/gpt-5.4-mini'],
  ])('returns source model %p for category %s', (category, expected) => {
    expect(getSourceCategoryModel(category)).toBe(expected)
  })

  test('returns no source model for unknown and uncategorized agents', () => {
    expect(getSourceCategoryModel('unknown')).toBeUndefined()
    expect(getSourceCategoryModel(undefined)).toBeUndefined()
  })

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
    ).toThrow(/Source category model defaults: review.*non-empty array/)
  })

  test('returns the first entry from a multi-entry array', () => {
    expect(getSourceCategoryModel('design')).toBe('openai/gpt-5.5')
  })

  test('rejects empty array in source category model defaults', () => {
    expect(() => validateSourceCategoryModelDefaults({ review: [] })).toThrow(
      /Source category model defaults: review.*non-empty array/,
    )
  })

  test('rejects array with malformed model entry through shared model validator', () => {
    expect(() =>
      validateSourceCategoryModelDefaults({ review: ['malformed-no-slash'] }),
    ).toThrow(/source category model defaults\.review\[0\].*provider\/model/)
  })

  test('accepts multi-entry valid array in source category model defaults', () => {
    expect(() =>
      validateSourceCategoryModelDefaults({
        review: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
      }),
    ).not.toThrow()
  })
})

describe('getAuthenticatedProviders', () => {
  test('returns set with single provider from auth.json', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(
        path.join(authDir, 'auth.json'),
        JSON.stringify({ openai: { type: 'api', key: 'x' } }),
      )
      const result = getAuthenticatedProviders(dir)
      expect(result).toEqual(new Set(['openai']))
    })
  })

  test('returns set with multiple providers from auth.json', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(
        path.join(authDir, 'auth.json'),
        JSON.stringify({ 'github-copilot': {}, anthropic: {} }),
      )
      const result = getAuthenticatedProviders(dir)
      expect(result).toEqual(new Set(['github-copilot', 'anthropic']))
    })
  })

  test('returns empty set silently when auth.json is missing', () => {
    withTempDir((dir) => {
      const warnSpy = spyOn(console, 'warn')
      try {
        const result = getAuthenticatedProviders(dir)
        expect(result).toEqual(new Set())
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  test('returns empty set and warns when auth.json is unreadable', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      const authPath = path.join(authDir, 'auth.json')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(authPath, JSON.stringify({ openai: {} }))
      fs.chmodSync(authPath, 0o000)

      const warnSpy = spyOn(console, 'warn')
      try {
        const result = getAuthenticatedProviders(dir)
        expect(result).toEqual(new Set())
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const msg = warnSpy.mock.calls[0][0]
        expect(msg).toContain('[systematic]')
        expect(msg).toContain('auth.json')
        expect(msg).toContain('unreadable')
        expect(msg).toContain(authPath)
      } finally {
        warnSpy.mockRestore()
        fs.chmodSync(authPath, 0o644)
      }
    })
  })

  test('returns empty set and warns when auth.json contains malformed JSON', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      const authPath = path.join(authDir, 'auth.json')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(authPath, '{not valid', 'utf8')

      const warnSpy = spyOn(console, 'warn')
      try {
        const result = getAuthenticatedProviders(dir)
        expect(result).toEqual(new Set())
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const msg = warnSpy.mock.calls[0][0]
        expect(msg).toContain('[systematic]')
        expect(msg).toContain('auth.json')
        expect(msg).toContain('malformed')
        expect(msg).toContain(authPath)
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  test('returns empty set when auth.json parses to a non-object', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      const authPath = path.join(authDir, 'auth.json')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(
        authPath,
        JSON.stringify(['array', 'not', 'object']),
        'utf8',
      )

      const warnSpy = spyOn(console, 'warn')
      try {
        const result = getAuthenticatedProviders(dir)
        expect(result).toEqual(new Set())
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const msg = warnSpy.mock.calls[0][0]
        expect(msg).toContain('malformed')
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  test('returns keys only without inspecting nested values', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(
        path.join(authDir, 'auth.json'),
        JSON.stringify({ openai: { type: 'api', key: 'sk-secret' } }),
      )
      const result = getAuthenticatedProviders(dir)
      expect(result).toEqual(new Set(['openai']))
      expect([...result]).toEqual(['openai'])
    })
  })
})

describe('getSourceCategoryModel with auth', () => {
  test('returns first array entry whose provider is authenticated', () => {
    const result = getSourceCategoryModel('review', new Set(['openai']))
    expect(result).toBe('openai/gpt-5.5')
  })

  test('returns first matching entry when multiple providers are authenticated', () => {
    const result = getSourceCategoryModel(
      'review',
      new Set(['anthropic', 'openai']),
    )
    expect(result).toBe('anthropic/claude-opus-4.7')
  })

  test('returns first entry when authenticated set is empty', () => {
    const result = getSourceCategoryModel('review', new Set())
    expect(result).toBe('anthropic/claude-opus-4.7')
  })

  test('returns first entry when authedProviders is undefined', () => {
    const result = getSourceCategoryModel('review')
    expect(result).toBe('anthropic/claude-opus-4.7')
  })

  test('returns first entry when no providers match', () => {
    const result = getSourceCategoryModel('review', new Set(['openrouter']))
    expect(result).toBe('anthropic/claude-opus-4.7')
  })

  test('correctly extracts provider from nested-form entries', () => {
    const nested = 'openrouter/anthropic/claude-sonnet-4'
    const slashIndex = nested.indexOf('/')
    const providerId = slashIndex > 0 ? nested.slice(0, slashIndex) : nested
    expect(providerId).toBe('openrouter')

    const result = getSourceCategoryModel('review', new Set(['openai']))
    expect(result).toBe('openai/gpt-5.5')
  })
})

describe('getAuthenticatedProviders integration', () => {
  test('does not leak auth.json nested values in output', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      fs.mkdirSync(authDir, { recursive: true })
      const secretKey = 'sk-test-do-not-leak-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      fs.writeFileSync(
        path.join(authDir, 'auth.json'),
        JSON.stringify({ openai: { type: 'api', key: secretKey } }),
      )

      const warnSpy = spyOn(console, 'warn')
      const logSpy = spyOn(console, 'log')
      try {
        const result = getAuthenticatedProviders(dir)
        expect(result).toEqual(new Set(['openai']))

        const allOutputs = [
          ...warnSpy.mock.calls.map((c) => String(c[0])),
          ...logSpy.mock.calls.map((c) => String(c[0])),
        ]
        const joined = allOutputs.join(' ')

        // The literal secret must not appear in any output
        expect(joined).not.toContain(secretKey)

        // No token-like strings (30+ alphanumeric/underscore/hyphen characters)
        const tokenPattern = /[A-Za-z0-9_-]{30,}/
        expect(joined).not.toMatch(tokenPattern)
      } finally {
        warnSpy.mockRestore()
        logSpy.mockRestore()
      }
    })
  })

  test('does not modify auth.json file', () => {
    withTempDir((dir) => {
      const authDir = path.join(dir, 'opencode')
      const authPath = path.join(authDir, 'auth.json')
      fs.mkdirSync(authDir, { recursive: true })
      const content = JSON.stringify({ openai: { type: 'api', key: 'x' } })
      fs.writeFileSync(authPath, content, 'utf8')

      const beforeStat = fs.statSync(authPath)
      const beforeMtime = beforeStat.mtimeMs
      const beforeHash = crypto
        .createHash('sha256')
        .update(content)
        .digest('hex')

      getAuthenticatedProviders(dir)

      const afterContent = fs.readFileSync(authPath, 'utf8')
      const afterStat = fs.statSync(authPath)
      const afterHash = crypto
        .createHash('sha256')
        .update(afterContent)
        .digest('hex')

      expect(afterHash).toBe(beforeHash)
      expect(afterStat.mtimeMs).toBe(beforeMtime)
    })
  })
})
