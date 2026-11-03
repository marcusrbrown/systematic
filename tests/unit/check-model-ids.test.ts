/**
 * Tests for scripts/check-model-ids.ts: token extraction, the per-occurrence
 * exception list, catalog checks, catalog resolution, and the CLI exit codes.
 *
 * Fixtures only. No network, no disk, no real catalog: the CLI is driven
 * through injected IO (`CliDeps`).
 */

import { describe, expect, test } from 'bun:test'
import {
  type CliDeps,
  checkOccurrences,
  DEFAULT_MODELS_URL,
  EXCEPTIONS,
  exitCodeFor,
  extractOccurrences,
  keepPresent,
  type ModelIdException,
  parseCatalog,
  resolveCatalogPath,
  runCli,
} from '../../scripts/check-model-ids.js'

const catalog = parseCatalog(
  JSON.stringify({
    anthropic: {
      models: {
        'claude-opus-5-5': {
          reasoning_options: [
            { type: 'effort', values: ['low', 'high', 'xhigh', 'max'] },
          ],
        },
        'claude-haiku-5-5': {
          reasoning_options: [
            { type: 'toggle' },
            { type: 'effort', values: ['low', 'high'] },
          ],
        },
        'claude-retired': { status: 'deprecated' },
        'claude-budget': {
          reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        },
        'claude-plain': {},
      },
    },
    openai: { models: { 'gpt-5.3-codex': {} } },
    openrouter: { models: { 'anthropic/claude-opus-5-5': {} } },
    vercel: { models: { 'v0-other': {} } },
    opencode: { models: { 'claude-x': {} } },
  }),
)

const providers = new Set(Object.keys(catalog.providers))

describe('extractOccurrences', () => {
  test('finds a provider/model token with its file and line', () => {
    const occ = extractOccurrences(
      'a.mdx',
      'first line\nuse `anthropic/claude-opus-5-5` here',
      providers,
    )
    expect(occ).toHaveLength(1)
    expect(occ[0]).toMatchObject({
      id: 'anthropic/claude-opus-5-5',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      file: 'a.mdx',
      line: 2,
    })
    expect(occ[0]?.variant).toBeUndefined()
  })

  test('strips a +suffix and keeps it as the variant', () => {
    const occ = extractOccurrences(
      'a.mdx',
      '| `anthropic/claude-opus-5-5+max`, `openai/gpt-5.3-codex` |',
      providers,
    )
    expect(occ.map((o) => [o.id, o.variant, o.raw])).toEqual([
      ['anthropic/claude-opus-5-5', 'max', 'anthropic/claude-opus-5-5+max'],
      ['openai/gpt-5.3-codex', undefined, 'openai/gpt-5.3-codex'],
    ])
  })

  test('splits on the first slash only', () => {
    const [occ] = extractOccurrences(
      'a.ts',
      'e.g. "openrouter/anthropic/claude-opus-5-5"',
      providers,
    )
    expect(occ).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5-5',
    })
  })

  test('skips prose, paths, URLs and unknown providers', () => {
    const text = [
      'see src/lib/config-schema.ts and docs/plans/foo.md',
      'agent/flat, provider/model, user/project',
      'https://github.com/anthropic/claude-opus-5-5 and ./anthropic/claude-x',
      'systematic/frontend-design',
    ].join('\n')
    expect(extractOccurrences('a.mdx', text, providers)).toEqual([])
  })

  test('does not swallow sentence punctuation', () => {
    const occ = extractOccurrences(
      'a.mdx',
      'Use anthropic/claude-opus-5-5. Or (openai/gpt-5.3-codex), or anthropic/claude-haiku-5-5:',
      providers,
    )
    expect(occ.map((o) => o.id)).toEqual([
      'anthropic/claude-opus-5-5',
      'openai/gpt-5.3-codex',
      'anthropic/claude-haiku-5-5',
    ])
  })

  test('reports every occurrence of a repeated id', () => {
    const occ = extractOccurrences(
      'a.mdx',
      'anthropic/claude-opus-5-5\nx\nanthropic/claude-opus-5-5',
      providers,
    )
    expect(occ.map((o) => o.line)).toEqual([1, 3])
  })

  test('pairs a JSON model with its sibling variant key', () => {
    const text = [
      '{',
      '  // comment with openai/gpt-5.3-codex stays a plain token',
      '  "a": {',
      '    "model": "anthropic/claude-opus-5-5",',
      '    "variant": "max", // trailing comma and comments are fine',
      '  },',
      '  "b": { "model": "openai/gpt-5.3-codex" }',
      '}',
    ].join('\n')
    const occ = extractOccurrences('x.jsonc', text, providers)
    expect(occ.map((o) => [o.id, o.line, o.variant])).toEqual([
      ['openai/gpt-5.3-codex', 2, undefined],
      ['anthropic/claude-opus-5-5', 4, 'max'],
      ['openai/gpt-5.3-codex', 7, undefined],
    ])
  })

  test('pairs each model with its own variant when several share one line', () => {
    const text =
      '{ "a": { "model": "anthropic/claude-opus-5-5", "variant": "max" }, ' +
      '"b": { "model": "anthropic/claude-opus-5-5", "variant": "bogus" } }'
    const occ = extractOccurrences('x.json', text, providers)
    expect(occ.map((o) => o.variant)).toEqual(['max', 'bogus'])

    const result = checkOccurrences(occ, catalog, [])
    expect(result.findings.map((f) => [f.kind, f.occurrence.variant])).toEqual([
      ['bad-variant', 'bogus'],
    ])
  })

  test('gives a model without a variant none when a neighbour on the same line has one', () => {
    const text =
      '{ "a": { "model": "anthropic/claude-opus-5-5" }, ' +
      '"b": { "model": "anthropic/claude-opus-5-5", "variant": "max" } }'
    const occ = extractOccurrences('x.json', text, providers)
    expect(occ.map((o) => o.variant)).toEqual([undefined, 'max'])
  })

  describe('complete tokens', () => {
    const only = (file: string, text: string) =>
      extractOccurrences(file, text, providers)

    test('prose: a token followed by stray identifier characters is malformed, with the whole raw text', () => {
      for (const raw of [
        'anthropic/claude-opus-5-5-',
        'anthropic/claude-opus-5-5+123',
        'anthropic/claude-opus-5-5+max+x',
        'anthropic/claude-opus-5-5/',
        'anthropic/claude-opus-5-5+max.5',
      ]) {
        const occ = only('a.mdx', `use ${raw} now`)
        expect(occ).toHaveLength(1)
        expect(occ[0]).toMatchObject({ raw, malformed: true, line: 1 })
        expect(occ[0]?.variant).toBeUndefined()
      }
    })

    test('prose: sentence punctuation after a token is not malformed', () => {
      const occ = only(
        'a.mdx',
        'a anthropic/claude-opus-5-5. b (anthropic/claude-opus-5-5+max), c anthropic/claude-opus-5-5: d anthropic/claude-opus-5-5, "anthropic/claude-opus-5-5" **anthropic/claude-opus-5-5**',
      )
      expect(occ).toHaveLength(6)
      expect(occ.every((o) => !o.malformed)).toBe(true)
    })

    test('JSON: a model value with leftover characters is one malformed occurrence', () => {
      for (const value of [
        'anthropic/claude-opus-5-5-',
        'anthropic/claude-opus-5-5+123',
        ' anthropic/claude-opus-5-5',
        'anthropic/claude-opus-5-5 ',
        'anthropic/claude-opus-5-5 anthropic/claude-haiku-5-5',
      ]) {
        const occ = only('x.json', `{\n  "model": "${value}"\n}`)
        expect(occ).toHaveLength(1)
        expect(occ[0]).toMatchObject({
          raw: value,
          malformed: true,
          line: 2,
        })
      }
    })

    test('JSON: a malformed model value does not also take its sibling variant', () => {
      const occ = only(
        'x.json',
        '{ "model": "anthropic/claude-opus-5-5-", "variant": "max" }',
      )
      expect(occ).toHaveLength(1)
      expect(occ[0]?.variant).toBeUndefined()
    })

    test('JSON: a complete model value is not malformed', () => {
      const occ = only('x.json', '{ "model": "anthropic/claude-opus-5-5+max" }')
      expect(occ).toHaveLength(1)
      expect(occ[0]?.malformed).toBeUndefined()
      expect(occ[0]?.variant).toBe('max')
    })

    test('JSON: a model value with no known provider is ignored', () => {
      expect(only('x.json', '{ "model": "inherit" }')).toEqual([])
      expect(only('x.json', '{ "model": "provider/model" }')).toEqual([])
    })

    test('a malformed occurrence is reported as missing', () => {
      const result = checkOccurrences(
        only('a.mdx', 'anthropic/claude-opus-5-5-'),
        catalog,
        [],
      )
      expect(result.findings.map((f) => f.kind)).toEqual(['missing'])
      expect(result.findings[0]?.detail).toMatch(/complete/)
      expect(exitCodeFor(result)).toBe(1)
    })
  })

  test('does not read variant keys in markdown prose', () => {
    const occ = extractOccurrences(
      'a.mdx',
      '{ "model": "anthropic/claude-opus-5-5", "variant": "bogus" }',
      providers,
    )
    expect(occ[0]?.variant).toBeUndefined()
  })
})

describe('checkOccurrences', () => {
  const check = (
    text: string,
    file = 'docs/x.mdx',
    exceptions: readonly ModelIdException[] = [],
  ) =>
    checkOccurrences(
      extractOccurrences(file, text, providers),
      catalog,
      exceptions,
    )

  test('passes a listed model', () => {
    const result = check('anthropic/claude-opus-5-5')
    expect(result.findings).toEqual([])
    expect(exitCodeFor(result)).toBe(0)
  })

  test('labels an unlisted model and an unlisted provider model as missing', () => {
    const result = check('anthropic/claude-haiku\nopenai/gpt-9')
    expect(result.findings.map((f) => [f.kind, f.occurrence.id])).toEqual([
      ['missing', 'anthropic/claude-haiku'],
      ['missing', 'openai/gpt-9'],
    ])
    expect(exitCodeFor(result)).toBe(1)
  })

  test('does not treat prototype keys as models', () => {
    const result = check('anthropic/constructor')
    expect(result.findings.map((f) => f.kind)).toEqual(['missing'])
  })

  test('labels a deprecated model as deprecated', () => {
    const result = check('anthropic/claude-retired')
    expect(result.findings.map((f) => f.kind)).toEqual(['deprecated'])
    expect(exitCodeFor(result)).toBe(1)
  })

  test('accepts a variant that is one of the effort values', () => {
    const result = check('anthropic/claude-opus-5-5+max')
    expect(result.findings).toEqual([])
    expect(result.unchecked).toEqual([])
  })

  test('uses only the effort entry when a model has several reasoning options', () => {
    expect(check('anthropic/claude-haiku-5-5+high').findings).toEqual([])
    expect(
      check('anthropic/claude-haiku-5-5+max').findings.map((f) => f.kind),
    ).toEqual(['bad-variant'])
  })

  test('labels a variant outside the effort values as bad-variant', () => {
    const result = check('anthropic/claude-opus-5-5+turbo')
    expect(result.findings.map((f) => [f.kind, f.detail])).toEqual([
      ['bad-variant', expect.stringContaining('low, high, xhigh, max')],
    ])
    expect(exitCodeFor(result)).toBe(1)
  })

  test('reports a variant as not checked when the model has no effort entry', () => {
    for (const id of ['claude-budget', 'claude-plain']) {
      const result = check(`anthropic/${id}+high`)
      expect(result.findings).toEqual([])
      expect(result.unchecked.map((o) => o.id)).toEqual([`anthropic/${id}`])
      expect(exitCodeFor(result)).toBe(0)
    }
  })

  test('checks a JSON sibling variant', () => {
    const result = checkOccurrences(
      extractOccurrences(
        'p.jsonc',
        '{ "model": "anthropic/claude-opus-5-5", "variant": "nope" }',
        providers,
      ),
      catalog,
      [],
    )
    expect(result.findings.map((f) => f.kind)).toEqual(['bad-variant'])
  })

  test('reports only missing when both the model and its variant are wrong', () => {
    const result = check('anthropic/claude-gone+max')
    expect(result.findings.map((f) => f.kind)).toEqual(['missing'])
  })

  describe('exceptions', () => {
    const exceptions: ModelIdException[] = [
      { path: 'docs/a.mdx', id: 'openai/gpt-9', reason: 'history' },
    ]

    test('skips the named id in the named path', () => {
      const result = check('openai/gpt-9', 'docs/a.mdx', exceptions)
      expect(result.findings).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(exitCodeFor(result)).toBe(0)
    })

    test('does not skip the same id in another path', () => {
      const result = check('openai/gpt-9', 'docs/b.mdx', exceptions)
      expect(result.findings).toHaveLength(1)
    })

    test('does not skip another id in the same path', () => {
      const result = check(
        'openai/gpt-9\nopenai/gpt-10',
        'docs/a.mdx',
        exceptions,
      )
      expect(result.findings.map((f) => f.occurrence.id)).toEqual([
        'openai/gpt-10',
      ])
    })

    test('matches the raw token, so a +suffix form is a different occurrence', () => {
      const result = check('openai/gpt-9+high', 'docs/a.mdx', exceptions)
      expect(result.findings.map((f) => f.kind)).toEqual(['missing'])
    })
  })
})

describe('EXCEPTIONS', () => {
  test('every entry names one path, one raw id and a reason', () => {
    expect(EXCEPTIONS.length).toBeGreaterThan(0)
    for (const entry of EXCEPTIONS) {
      expect(entry.path).not.toMatch(/[*?[\]{}]/)
      expect(entry.id).toContain('/')
      expect(entry.reason.length).toBeGreaterThan(10)
    }
  })

  test('has no duplicate path + id pairs', () => {
    const keys = EXCEPTIONS.map((e) => `${e.path}\u0000${e.id}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('parseCatalog', () => {
  test('rejects unparseable text', () => {
    expect(() => parseCatalog('{nope')).toThrow(/could not be parsed/)
  })

  test('rejects a non-object root', () => {
    expect(() => parseCatalog('[]')).toThrow(/not a JSON object/)
    expect(() => parseCatalog('null')).toThrow(/not a JSON object/)
  })

  test('rejects a catalog with zero providers', () => {
    expect(() => parseCatalog('{}')).toThrow(/no providers/)
    expect(() => parseCatalog('{"x": {"name": "no models map"}}')).toThrow(
      /no providers/,
    )
  })

  test('rejects a catalog whose providers all have empty models maps', () => {
    expect(() => parseCatalog('{"openai":{"models":{}}}')).toThrow(
      /no model entries/,
    )
    expect(() => parseCatalog('{"a":{"models":{}},"b":{"models":{}}}')).toThrow(
      /no model entries/,
    )
  })

  test('rejects a model entry that is not an object', () => {
    for (const value of ['true', 'null', '[]', '"str"', '5']) {
      expect(() =>
        parseCatalog(`{"anthropic":{"models":{"claude-opus-5-5":${value}}}}`),
      ).toThrow(/anthropic\/claude-opus-5-5.*not an object/)
    }
  })

  test('rejects a bad entry even when other models are fine', () => {
    expect(() =>
      parseCatalog(
        '{"a":{"models":{"ok":{},"bad":true}},"b":{"models":{"m":{}}}}',
      ),
    ).toThrow(/a\/bad/)
  })

  test('accepts an empty provider next to one that has models', () => {
    const parsed = parseCatalog('{"a":{"models":{}},"b":{"models":{"m":{}}}}')
    expect(Object.keys(parsed.providers)).toEqual(['a', 'b'])
  })

  test('keeps only entries that have a models map', () => {
    const parsed = parseCatalog(
      '{"a": {"models": {"m": {}}}, "b": {"id": "b"}, "c": 3}',
    )
    expect(Object.keys(parsed.providers)).toEqual(['a'])
  })
})

describe('keepPresent', () => {
  const failWith = (code: string) => () =>
    Promise.reject(Object.assign(new Error(`${code}: failed`), { code }))

  test('skips a file that is gone from the working tree (ENOENT)', async () => {
    const access = (file: string) =>
      file === 'gone.md' ? failWith('ENOENT')() : Promise.resolve()
    expect(await keepPresent(['a.md', 'gone.md', 'b.md'], access)).toEqual([
      'a.md',
      'b.md',
    ])
  })

  for (const code of ['EACCES', 'EIO']) {
    test(`rethrows ${code} with the path instead of dropping the file`, async () => {
      const access = (file: string) =>
        file === 'locked.md' ? failWith(code)() : Promise.resolve()
      await expect(keepPresent(['a.md', 'locked.md'], access)).rejects.toThrow(
        `locked.md: ${code}: failed`,
      )
    })
  }
})

describe('resolveCatalogPath', () => {
  test('OPENCODE_MODELS_PATH wins', () => {
    expect(
      resolveCatalogPath(
        { OPENCODE_MODELS_PATH: '/x/m.json', XDG_CACHE_HOME: '/xdg' },
        '/home/u',
      ),
    ).toBe('/x/m.json')
  })

  test('then XDG_CACHE_HOME', () => {
    expect(resolveCatalogPath({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(
      '/xdg/opencode/models.json',
    )
  })

  test('then the home cache', () => {
    expect(resolveCatalogPath({}, '/home/u')).toBe(
      '/home/u/.cache/opencode/models.json',
    )
  })

  test('treats empty values as unset', () => {
    expect(
      resolveCatalogPath(
        { OPENCODE_MODELS_PATH: '', XDG_CACHE_HOME: '' },
        '/home/u',
      ),
    ).toBe('/home/u/.cache/opencode/models.json')
  })
})

describe('runCli', () => {
  const MTIME = new Date('2026-11-03T12:00:00.000Z')
  const OMO = 'registry/files/profiles/omo/oh-my-opencode.jsonc'
  const MIGRATION = 'docs/src/content/docs/guides/model-defaults-migration.mdx'

  interface Calls {
    reads: string[]
    fetches: string[]
  }

  function makeDeps(options: {
    catalogText?: string | Error
    sources?: { path: string; text: string }[]
    listError?: Error
    /** Make reading this source path throw. */
    readFails?: { path: string; error: Error }
    env?: Record<string, string | undefined>
    fetchText?: string | Error
  }): { deps: CliDeps; calls: Calls } {
    const calls: Calls = { reads: [], fetches: [] }
    const deps: CliDeps = {
      env: options.env ?? {},
      homedir: '/home/u',
      readText: async (p) => {
        calls.reads.push(p)
        const text = options.catalogText
        if (text === undefined || text instanceof Error) {
          throw text ?? new Error('ENOENT: no such file')
        }
        return text
      },
      mtime: async () => MTIME,
      fetchText: async (url) => {
        calls.fetches.push(url)
        const text = options.fetchText
        if (text === undefined || text instanceof Error) {
          throw text ?? new Error('network down')
        }
        return text
      },
      listSources: async () => {
        if (options.listError) throw options.listError
        return (options.sources ?? []).map((s) => s.path)
      },
      readSource: async (p) => {
        if (options.readFails?.path === p) throw options.readFails.error
        const source = options.sources?.find((s) => s.path === p)
        if (!source) throw new Error(`unexpected read of ${p}`)
        return source.text
      },
    }
    return { deps, calls }
  }

  const catalogText = JSON.stringify({
    anthropic: {
      models: {
        'claude-opus-5-5': {
          reasoning_options: [{ type: 'effort', values: ['max'] }],
        },
        'claude-retired': { status: 'deprecated' },
        'claude-budget': {
          reasoning_options: [{ type: 'budget_tokens', min: 1 }],
        },
      },
    },
    vercel: { models: { 'v0-other': {} } },
    opencode: { models: { 'claude-x': {} } },
  })

  test('passes with exit 0 and prints the catalog source and cache mtime', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [{ path: OMO, text: '"model": "anthropic/claude-opus-5-5"' }],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('/home/u/.cache/opencode/models.json')
    expect(result.stdout).toContain('2026-11-03')
  })

  test('AE1: a profile model the catalog no longer lists exits 1 with file, line and missing', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [
        {
          path: OMO,
          text: '{\n  "quick": {\n    "model": "anthropic/claude-gone"\n  }\n}',
        },
      ],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(`${OMO}:3`)
    expect(result.stdout).toContain('missing')
    expect(result.stdout).toContain('anthropic/claude-gone')
  })

  test('AE2: a deprecated profile model exits 1 labelled deprecated', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [{ path: OMO, text: '"model": "anthropic/claude-retired"' }],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toMatch(/deprecated/)
    expect(result.stdout).toContain('anthropic/claude-retired')
  })

  test('AE3: no cache and no --fetch exits 2 saying no catalog was available', async () => {
    const { deps, calls } = makeDeps({
      catalogText: new Error('ENOENT: no such file'),
      sources: [{ path: OMO, text: '"model": "anthropic/claude-opus-5-5"' }],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/no catalog/i)
    expect(calls.fetches).toEqual([])
  })

  test('AE4: a variant on a model without an effort entry is not checked and does not fail', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [
        {
          path: OMO,
          text: '{ "model": "anthropic/claude-budget", "variant": "high" }',
        },
      ],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/not checked/i)
    expect(result.stdout).toContain('anthropic/claude-budget')
  })

  test('a bad variant exits 1', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [
        {
          path: OMO,
          text: '{ "model": "anthropic/claude-opus-5-5", "variant": "zzz" }',
        },
      ],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('bad-variant')
  })

  test('AE5: the retired-defaults table is skipped per occurrence by the exception list', async () => {
    const row =
      '| `workflow` | `opencode/claude-gone`, `vercel/v0-1.5-md`, `anthropic/claude-opus-4-7+max` |'
    // Prove the rows would fail without the exception: same text, other path.
    const unlisted = makeDeps({
      catalogText,
      sources: [{ path: 'docs/src/content/docs/guides/other.mdx', text: row }],
    })
    expect((await runCli([], unlisted.deps)).exitCode).toBe(1)

    const listed = makeDeps({
      catalogText,
      sources: [
        {
          path: MIGRATION,
          text: '| `workflow` | `vercel/v0-1.5-md` |',
        },
      ],
    })
    const result = await runCli([], listed.deps)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/skipped by exception/i)
  })

  test('the migration page still fails for an id that is not on the exception list', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [{ path: MIGRATION, text: 'anthropic/claude-never-existed' }],
    })
    expect((await runCli([], deps)).exitCode).toBe(1)
  })

  test('exits 2 for an unparseable catalog', async () => {
    const { deps } = makeDeps({ catalogText: '{not json' })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/parse/i)
  })

  test('exits 2 for a catalog with zero providers', async () => {
    const { deps } = makeDeps({ catalogText: '{}' })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/no providers/i)
  })

  test('exits 2 for a catalog with providers but no model entries', async () => {
    const { deps } = makeDeps({
      catalogText: '{"openai":{"models":{}}}',
      sources: [{ path: OMO, text: '"model": "openai/gpt-5.3-codex"' }],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/no model entries/i)
    expect(result.stdout).toBe('')
  })

  test('exits 2 when a catalog model entry is not an object', async () => {
    const { deps } = makeDeps({
      catalogText: '{"anthropic":{"models":{"claude-opus-5-5":true}}}',
      sources: [{ path: OMO, text: '"model": "anthropic/claude-opus-5-5"' }],
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('anthropic/claude-opus-5-5')
    expect(result.stdout).toBe('')
  })

  test('exits 2 with context when source discovery throws', async () => {
    const { deps } = makeDeps({
      catalogText,
      listError: new Error('git: command not found'),
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/source discovery failed/i)
    expect(result.stderr).toContain('git: command not found')
    expect(result.stdout).toBe('')
  })

  test('exits 2 naming the file when reading a source throws', async () => {
    const { deps } = makeDeps({
      catalogText,
      sources: [
        { path: OMO, text: '"model": "anthropic/claude-opus-5-5"' },
        { path: 'docs/src/content/docs/guides/x.mdx', text: '' },
      ],
      readFails: {
        path: 'docs/src/content/docs/guides/x.mdx',
        error: new Error('EACCES: permission denied'),
      },
    })
    const result = await runCli([], deps)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('docs/src/content/docs/guides/x.mdx')
    expect(result.stderr).toContain('EACCES')
    expect(result.stdout).toBe('')
  })

  describe('complete tokens only', () => {
    // Fro Bot's examples: each used to pass because only the valid base ID
    // was pulled out of a longer, broken token.
    const cases = [
      ['anthropic/claude-opus-5-5-', 'trailing hyphen'],
      ['anthropic/claude-opus-5-5+123', 'non-letter variant'],
    ] as const

    for (const [token, label] of cases) {
      test(`JSON: ${label} exits 1 as missing with the raw value`, async () => {
        const { deps } = makeDeps({
          catalogText,
          sources: [{ path: OMO, text: `{"model":"${token}"}` }],
        })
        const result = await runCli([], deps)
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toMatch(
          /missing\s+registry\/files\/profiles\/omo\/oh-my-opencode.jsonc:1\s+/,
        )
        expect(result.stdout).toContain(`  ${token}`)
      })

      test(`MDX: ${label} exits 1 as missing with the raw text`, async () => {
        const { deps } = makeDeps({
          catalogText,
          sources: [
            {
              path: 'docs/src/content/docs/guides/x.mdx',
              text: `Use \`${token}\` here.`,
            },
          ],
        })
        const result = await runCli([], deps)
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain(`  ${token}`)
        expect(result.stdout).toMatch(/missing/)
      })
    }
  })

  test('exits 2 for an unknown flag', async () => {
    const { deps } = makeDeps({ catalogText })
    expect((await runCli(['--nope'], deps)).exitCode).toBe(2)
  })

  test('reads OPENCODE_MODELS_PATH when set', async () => {
    const { deps, calls } = makeDeps({
      catalogText,
      env: { OPENCODE_MODELS_PATH: '/custom/m.json' },
    })
    await runCli([], deps)
    expect(calls.reads).toEqual(['/custom/m.json'])
  })

  describe('--fetch', () => {
    test('reads from models.dev into memory and never touches the cache', async () => {
      const { deps, calls } = makeDeps({
        fetchText: catalogText,
        sources: [{ path: OMO, text: '"model": "anthropic/claude-opus-5-5"' }],
      })
      const result = await runCli(['--fetch'], deps)
      expect(result.exitCode).toBe(0)
      expect(calls.fetches).toEqual([DEFAULT_MODELS_URL])
      expect(calls.reads).toEqual([])
      expect(result.stdout).toContain(DEFAULT_MODELS_URL)
    })

    test('uses OPENCODE_MODELS_URL when set', async () => {
      const { deps, calls } = makeDeps({
        fetchText: catalogText,
        env: { OPENCODE_MODELS_URL: 'https://mirror.example/api.json' },
      })
      await runCli(['--fetch'], deps)
      expect(calls.fetches).toEqual(['https://mirror.example/api.json'])
    })

    test('exits 2 when the fetch fails, without falling back to the cache', async () => {
      const { deps, calls } = makeDeps({
        fetchText: new Error('network down'),
        catalogText,
      })
      const result = await runCli(['--fetch'], deps)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('network down')
      expect(calls.reads).toEqual([])
    })
  })
})
