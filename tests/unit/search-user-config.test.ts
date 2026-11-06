import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { loadConfigWithSources } from '../../src/lib/config.js'
import type { SearchSettings } from '../../src/lib/search-core.js'
import { lookupSearchRoot } from '../../src/lib/search-corpus.js'
import {
  loadProjectSearchSources,
  loadUserLevelSearchSettings,
  MAX_PROJECT_CONFIG_BYTES,
  mergeSearchSettings,
  resolveUserLevelConfigDirs,
  SearchSettingsSchema,
  type SearchSettingsSource,
  SearchSourceSchema,
  selectConfigFile,
  selectProjectConfigFile,
  selectUserLevelConfigFiles,
  validateSearchConfig,
} from '../../src/lib/search-user-config.js'
import {
  makeExternalEnv,
  writeProjectSearch,
  writeUserLocalSearch,
  writeUserSearch,
} from '../helpers/search-external-env.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const temp = createTempDirTracker()

afterEach(() => {
  temp.cleanup()
})

function makeTempDir(label: string): string {
  return temp.track(
    fs.mkdtempSync(path.join(os.tmpdir(), `systematic-search-user-${label}-`)),
  )
}

describe('SearchSettingsSchema', () => {
  test('accepts an empty block and an enabled block', () => {
    expect(SearchSettingsSchema.safeParse({}).success).toBe(true)
    expect(SearchSettingsSchema.safeParse({ enabled: true }).success).toBe(true)
    expect(SearchSettingsSchema.safeParse({ enabled: false }).success).toBe(
      true,
    )
  })

  test('applies no defaults: an absent field stays absent', () => {
    expect(SearchSettingsSchema.safeParse({}).data).toEqual({})
    expect(SearchSettingsSchema.safeParse({ enabled: false }).data).toEqual({
      enabled: false,
    })
  })

  test('the parsed output is assignable to the core SearchSettings type', () => {
    const result = SearchSettingsSchema.safeParse({ enabled: false })
    if (!result.success) throw new Error('expected success')
    // Compile-time check: a schema output must satisfy the core's type.
    const settings: SearchSettings = result.data
    expect(settings.enabled).toBe(false)
  })

  test.each([
    ['unknown key in search', { enabled: true, extra: 1 }],
    ['a removed embeddings block', { embeddings: { provider: 'ollama' } }],
    ['non-boolean enabled', { enabled: 'yes' }],
    ['null enabled', { enabled: null }],
    ['null block', null],
    ['array block', []],
    ['string block', 'on'],
  ])('rejects %s', (_label, value) => {
    expect(SearchSettingsSchema.safeParse(value).success).toBe(false)
  })
})

const USER_FILE = '/tmp/systematic.json'

const validUser = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  format: 'markdown' as const,
  roots: ['/srv/docs'],
  projects: ['/work/app'],
  ...extra,
})

describe('SearchSettingsSchema: sources and allow list', () => {
  test('accepts allow_project_sources and sources', () => {
    const parsed = SearchSettingsSchema.safeParse({
      enabled: true,
      allow_project_sources: ['/work/app', '~/src/app'],
      sources: [validUser('wiki', { projects: ['~/src/app'] })],
    })
    expect(parsed.success).toBe(true)
  })

  test.each([
    ['an unknown format', { sources: [validUser('a', { format: 'yaml' })] }],
    ['an empty roots array', { sources: [validUser('a', { roots: [] })] }],
    ['a bad name', { sources: [validUser('has space')] }],
    ['a non-array allow list', { allow_project_sources: '/x' }],
  ])('the whole-block schema rejects %s', (_label, value) => {
    expect(SearchSettingsSchema.safeParse(value).success).toBe(false)
  })

  test('the two user-only fields carry the project-or-higher trust tag, sources and enabled-sibling do not', () => {
    const unwrap = (schema: z.ZodType): z.ZodType => {
      const def = schema._def as { type?: string; innerType?: z.ZodType }
      return def.type === 'optional' && def.innerType ? def.innerType : schema
    }
    const meta = (schema: z.ZodType) =>
      z.globalRegistry.get(unwrap(schema))?.trust as string | undefined
    const { shape } = SearchSettingsSchema
    expect(meta(shape.enabled)).toBe('project-or-higher')
    expect(meta(shape.allow_project_sources)).toBe('project-or-higher')
    expect(meta(shape.sources)).toBeUndefined()
    expect(meta(SearchSettingsSchema)).toBeUndefined()
  })

  test('every nested field has a description and an example', () => {
    const json = z.toJSONSchema(SearchSettingsSchema, {
      target: 'draft-7',
    }) as {
      properties: Record<string, Record<string, unknown>>
    }
    for (const key of ['enabled', 'allow_project_sources', 'sources']) {
      const field = json.properties[key]
      expect(typeof field?.description).toBe('string')
      expect(Array.isArray(field?.examples)).toBe(true)
    }
    const items = json.properties.sources?.items as {
      properties: Record<string, Record<string, unknown>>
    }
    for (const key of ['name', 'format', 'roots', 'projects', 'exclude']) {
      expect(Array.isArray(items.properties[key]?.examples)).toBe(true)
    }
  })
})

describe('validateSearchConfig (user trust)', () => {
  const user = (value: unknown) =>
    validateSearchConfig(value, 'user', USER_FILE)

  test('a valid block keeps every field and raises nothing', () => {
    const result = user({
      enabled: false,
      allow_project_sources: ['/work/app', '~/src/other', '~'],
      sources: [
        validUser('rfcs'),
        {
          name: 'graph',
          format: 'deciduous',
          roots: ['~/src/x/.deciduous/sync'],
          projects: ['/work/app'],
        },
      ],
    })
    expect(result.warnings).toEqual([])
    expect(result.unreadable).toBe(false)
    expect(result.structural).toBe(false)
    expect(result.settings).toEqual({
      enabled: false,
      allow_project_sources: ['/work/app', '~/src/other', '~'],
      sources: [
        validUser('rfcs'),
        {
          name: 'graph',
          format: 'deciduous',
          roots: ['~/src/x/.deciduous/sync'],
          projects: ['/work/app'],
        },
      ],
    })
  })

  test('names field paths and never a value', () => {
    const result = user({ enabled: 'hunter2-secret' })
    expect(result.unreadable).toBe(true)
    expect(result.settings).toEqual({})
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('search.enabled')
    expect(result.warnings[0]).toContain('config unreadable')
    expect(result.warnings[0]).not.toContain('hunter2')
  })

  test('an unknown key is reported without its name and keeps its siblings', () => {
    const result = user({ 'secret-key-name': 1, enabled: false })
    expect(result.unreadable).toBe(true)
    expect(result.settings).toEqual({ enabled: false })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).not.toContain('secret-key-name')
  })

  test.each([
    ['null', null],
    ['a string', 'on'],
    ['an array', []],
  ])('a %s block is a structural error with no settings', (_label, value) => {
    const result = user(value)
    expect(result.structural).toBe(true)
    expect(result.unreadable).toBe(true)
    expect(result.settings).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
  })

  test('sources that is not an array drops all sources and keeps enabled', () => {
    const result = user({ enabled: false, sources: { name: 'x' } })
    expect(result.structural).toBe(true)
    expect(result.unreadable).toBe(true)
    expect(result.settings).toEqual({ enabled: false })
  })

  test('a typo in one source entry never loses enabled:false or a valid sibling', () => {
    const result = user({
      enabled: false,
      sources: [validUser('ok'), validUser('bad', { format: 'yaml' })],
    })
    expect(result.settings).toEqual({
      enabled: false,
      sources: [validUser('ok')],
    })
    expect(result.structural).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('"bad"')
  })

  test('C1: a non-string or relative allow entry allows nothing, keeps valid siblings and sets unreadable', () => {
    const result = user({
      allow_project_sources: ['/work/app', 5, 'relative/path', '', null],
    })
    expect(result.settings).toEqual({ allow_project_sources: ['/work/app'] })
    expect(result.unreadable).toBe(true)
    expect(result.structural).toBe(false)
    expect(result.warnings.join('\n')).not.toContain('relative/path')
  })

  test('an allow list that is not an array allows nothing and sets unreadable', () => {
    const result = user({ allow_project_sources: '/work/app' })
    expect(result.settings).toEqual({})
    expect(result.unreadable).toBe(true)
  })

  test('a duplicate name within one file keeps the first and warns', () => {
    const result = user({
      sources: [
        validUser('dup', { roots: ['/first'] }),
        validUser('dup', { roots: ['/second'] }),
      ],
    })
    expect(result.settings?.sources).toEqual([
      validUser('dup', { roots: ['/first'] }),
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('"dup"')
  })

  test('names are case-sensitive, so Wiki and wiki both stay', () => {
    const result = user({ sources: [validUser('Wiki'), validUser('wiki')] })
    expect(result.settings?.sources).toHaveLength(2)
    expect(result.warnings).toEqual([])
  })

  test.each([
    ['an unknown format', validUser('a', { format: 'yaml' })],
    ['a name with a space', validUser('has space')],
    ['an empty name', validUser('')],
    ['an overlong name', validUser('n'.repeat(41))],
    ['a non-string name', { ...validUser('a'), name: 7 }],
    ['empty roots', validUser('a', { roots: [] })],
    [
      'a ninth root',
      validUser('a', {
        roots: Array.from({ length: 9 }, (_v, i) => `/r${i}`),
      }),
    ],
    ['a relative user root', validUser('a', { roots: ['docs/rfcs'] })],
    ['a non-string root', validUser('a', { roots: [3] })],
    ['a relative projects entry', validUser('a', { projects: ['app'] })],
    ['an unknown entry key', validUser('a', { extra: true })],
    ['a non-object entry', 'wiki'],
  ])('%s drops only its own entry', (_label, entry) => {
    const result = user({ sources: [entry, validUser('keeper')] })
    expect(result.settings?.sources).toEqual([validUser('keeper')])
    expect(result.warnings).toHaveLength(1)
  })

  test('a root with a ninth entry still accepts exactly eight', () => {
    const roots = Array.from({ length: 8 }, (_v, i) => `/r${i}`)
    const result = user({ sources: [validUser('a', { roots })] })
    expect(result.settings?.sources).toHaveLength(1)
  })

  test('user roots may be absolute or ~-prefixed, and may use ..', () => {
    const result = user({
      sources: [validUser('a', { roots: ['/x/../y', '~/docs', '~'] })],
    })
    expect(result.settings?.sources).toHaveLength(1)
  })

  test('a ~user form is not a ~ root', () => {
    const result = user({
      sources: [validUser('a', { roots: ['~someone/docs'] })],
    })
    expect(result.settings?.sources).toBeUndefined()
  })

  test('warnings name sources and fields but never a root, a project or a value', () => {
    const result = user({
      allow_project_sources: ['secret-relative-allow'],
      sources: [
        validUser('s1', { roots: ['secret-relative-root'] }),
        validUser('s2', { projects: ['secret-relative-project'] }),
        validUser('bad name \u001b[31m secret', {}),
      ],
    })
    const text = result.warnings.join('\n')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('\u001b')
    expect(text).toContain('"s1"')
    expect(text).toContain('"s2"')
  })

  test('detail warnings are capped with one summary line', () => {
    const result = user({
      sources: Array.from({ length: 12 }, (_v, i) =>
        validUser(`s${i}`, { format: 'nope' }),
      ),
    })
    expect(result.warnings).toHaveLength(6)
    expect(result.warnings[5]).toContain('7 more')
  })

  test('control characters in the source path are escaped in warnings', () => {
    const result = validateSearchConfig(
      { enabled: 'x' },
      'user',
      '/tmp/\u001b[2Jevil.json',
    )
    expect(result.warnings[0]).not.toContain('\u001b')
  })
})

describe('validateSearchConfig (project trust)', () => {
  const project = (value: unknown) =>
    validateSearchConfig(value, 'project', '/repo/.opencode/systematic.json')
  const one = (root: string, format = 'markdown') =>
    project({ sources: [{ name: 'p', format, roots: [root] }] })

  test.each([
    ['docs/rfcs', 'markdown'],
    ['docs', 'markdown'],
    ['a/b/c', 'markdown'],
    ['docs/', 'markdown'],
    ['.deciduous/sync', 'deciduous'],
    ['.deciduous/sync/nodes', 'deciduous'],
  ])('accepts %s for %s', (root, format) => {
    const result = one(root, format)
    expect(result.warnings).toEqual([])
    expect(result.settings?.sources).toHaveLength(1)
  })

  test.each([
    ['.', 'markdown'],
    ['./docs', 'markdown'],
    ['..', 'markdown'],
    ['../other-repo/docs', 'markdown'],
    ['docs/../..', 'markdown'],
    ['docs/..', 'markdown'],
    ['.slim/clonedeps', 'markdown'],
    ['.slim/clonedeps', 'deciduous'],
    ['.deciduous/sync', 'markdown'],
    ['.deciduous', 'deciduous'],
    ['.deciduous/', 'deciduous'],
    ['.deciduous/.cache', 'deciduous'],
    ['.deciduous/sync/.hidden', 'deciduous'],
    ['.deciduous/../x', 'deciduous'],
    ['docs/.hidden', 'markdown'],
    ['docs\\..\\x', 'markdown'],
    ['/etc', 'markdown'],
    ['/', 'markdown'],
    ['C:\\Users', 'markdown'],
    ['', 'markdown'],
    ['docs/\u0000x', 'markdown'],
  ])('rejects %j for %s', (root, format) => {
    const result = one(root, format)
    expect(result.settings?.sources).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
  })

  test('three bad roots each drop only their own source and a valid sibling stays', () => {
    const result = project({
      sources: [
        { name: 'dot', format: 'markdown', roots: ['.'] },
        { name: 'clone', format: 'markdown', roots: ['.slim/clonedeps'] },
        { name: 'escape', format: 'markdown', roots: ['../other-repo/docs'] },
        { name: 'good', format: 'markdown', roots: ['docs/rfcs'] },
      ],
    })
    expect(result.settings?.sources).toEqual([
      { name: 'good', format: 'markdown', roots: ['docs/rfcs'] },
    ])
    expect(result.warnings).toHaveLength(3)
    for (const name of ['dot', 'clone', 'escape']) {
      expect(
        result.warnings.filter((w) => w.includes(`"${name}"`)),
      ).toHaveLength(1)
    }
    expect(result.warnings.join('\n')).not.toContain('clonedeps')
  })

  test('a source with one bad root among several is dropped whole', () => {
    const result = project({
      sources: [{ name: 'mixed', format: 'markdown', roots: ['docs', '../x'] }],
    })
    expect(result.settings?.sources).toBeUndefined()
  })

  test('a project entry may not carry projects[]', () => {
    const result = project({
      sources: [
        { name: 'p', format: 'markdown', roots: ['docs'], projects: ['/x'] },
      ],
    })
    expect(result.settings?.sources).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
  })

  test('project trust reads sources only: enabled and allow list are ignored here', () => {
    const result = project({
      enabled: false,
      allow_project_sources: ['/x'],
      sources: [{ name: 'p', format: 'markdown', roots: ['docs'] }],
    })
    expect(result.settings).toEqual({
      sources: [{ name: 'p', format: 'markdown', roots: ['docs'] }],
    })
    expect(result.warnings).toEqual([])
  })

  test('sources that is not an array is structural and yields no proposals', () => {
    const result = project({ sources: 'docs' })
    expect(result.structural).toBe(true)
    expect(result.settings?.sources).toBeUndefined()
  })

  test('a project warning does not claim a user-config note', () => {
    const result = one('..')
    expect(result.warnings[0]).not.toContain('config unreadable')
  })
})

describe('the config.ts path and the shared validator agree', () => {
  const MIXED = {
    enabled: false,
    allow_project_sources: ['/work/app', 12],
    sources: [
      validUser('good'),
      validUser('bad-format', { format: 'yaml' }),
      validUser('bad-root', { roots: ['relative'] }),
      validUser('good', { roots: ['/dup'] }),
      validUser('second'),
    ],
  }

  test('one mixed fixture gives the same kept entries and enabled:false through both', () => {
    const root = makeTempDir('mixed')
    const homeDir = path.join(root, 'home')
    const userDir = path.join(homeDir, '.config/opencode')
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(userDir, { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'systematic.json'),
      JSON.stringify({ search: MIXED }),
    )
    const viaConfig = loadConfigWithSources(projectDir, {
      homeDir,
      customConfigDir: null,
      warningSink: () => {},
    }).config
    const viaShared = validateSearchConfig(MIXED, 'user', USER_FILE)
    const viaReader = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })

    expect(viaShared.settings?.enabled).toBe(false)
    expect(viaShared.settings?.sources?.map((s) => s.name)).toEqual([
      'good',
      'second',
    ])
    expect(viaConfig.search).toEqual(viaShared.settings)
    expect(viaReader.settings).toEqual(viaShared.settings)
    expect(viaConfig.searchUnreadable).toBe(true)
    expect(viaReader.unreadable).toBe(true)
  })
})

describe('mergeSearchSettings', () => {
  const src = (
    settings?: SearchSettingsSource['settings'],
    unreadable = false,
  ): SearchSettingsSource => ({ settings, unreadable })

  test('no sources gives nothing and is readable', () => {
    expect(mergeSearchSettings([])).toMatchObject({
      settings: undefined,
      unreadable: false,
    })
  })

  test('user only', () => {
    expect(mergeSearchSettings([src({ enabled: true })])).toMatchObject({
      settings: { enabled: true },
      unreadable: false,
    })
  })

  test('an empty block contributes no settings', () => {
    expect(mergeSearchSettings([src({})])).toMatchObject({
      settings: undefined,
      unreadable: false,
    })
  })

  test('custom overrides user: enabled is last-defining', () => {
    const merged = mergeSearchSettings([
      src({ enabled: true }),
      src({ enabled: false }),
    ])
    expect(merged.settings).toEqual({ enabled: false })
  })

  test('custom without enabled keeps the user enabled value', () => {
    const merged = mergeSearchSettings([src({ enabled: false }), src({})])
    expect(merged.settings).toEqual({ enabled: false })
  })

  test('enabled:false only (custom has no search block) stays false', () => {
    expect(mergeSearchSettings([src({ enabled: false })])).toMatchObject({
      settings: { enabled: false },
      unreadable: false,
    })
    expect(
      mergeSearchSettings([src({ enabled: false }), src(undefined)]).settings,
    ).toEqual({ enabled: false })
  })

  test('allow_project_sources is a union across sources, without duplicates', () => {
    const merged = mergeSearchSettings([
      src({ allow_project_sources: ['/a', '/b'] }),
      src({ allow_project_sources: ['/b', '/c'] }),
    ])
    expect(merged.settings).toEqual({
      allow_project_sources: ['/a', '/b', '/c'],
    })
  })

  test('sources merge by name with the later (custom) entry winning, keeping position', () => {
    const entry = (name: string, root: string) => ({
      name,
      format: 'markdown' as const,
      roots: [root],
    })
    const merged = mergeSearchSettings([
      src({ sources: [entry('a', '/user-a'), entry('b', '/user-b')] }),
      src({ sources: [entry('b', '/custom-b'), entry('c', '/custom-c')] }),
    ])
    expect(merged.settings?.sources).toEqual([
      entry('a', '/user-a'),
      entry('b', '/custom-b'),
      entry('c', '/custom-c'),
    ])
  })

  test('enabled stays last-defining next to the new fields', () => {
    const merged = mergeSearchSettings([
      src({ enabled: false, allow_project_sources: ['/a'] }),
      src({ allow_project_sources: ['/b'] }),
    ])
    expect(merged.settings).toEqual({
      enabled: false,
      allow_project_sources: ['/a', '/b'],
    })
  })

  test('an unreadable source flags the result and contributes no settings', () => {
    const merged = mergeSearchSettings([
      src(undefined, true),
      src({ enabled: false }),
    ])
    expect(merged.unreadable).toBe(true)
    expect(merged.settings).toEqual({ enabled: false })
    expect(mergeSearchSettings([src(undefined, true)])).toMatchObject({
      settings: undefined,
      unreadable: true,
    })
  })

  describe('source layers', () => {
    const layered = (
      layer: SearchSettingsSource['layer'],
      settings: SearchSettingsSource['settings'],
    ): SearchSettingsSource => ({ settings, unreadable: false, layer })
    const entry = (name: string, root: string) => ({
      name,
      format: 'markdown' as const,
      roots: [root],
    })

    test('each surviving source reports the layer that defined it last', () => {
      const merged = mergeSearchSettings([
        layered('user', { sources: [entry('a', '/u-a'), entry('b', '/u-b')] }),
        layered('user.local', { sources: [entry('b', '/l-b')] }),
        layered('custom', { sources: [entry('c', '/c-c')] }),
        layered('custom.local', { sources: [entry('c', '/cl-c')] }),
      ])
      expect([...merged.sourceLayers]).toEqual([
        ['a', 'user'],
        ['b', 'user.local'],
        ['c', 'custom.local'],
      ])
      expect(merged.settings?.sources).toEqual([
        entry('a', '/u-a'),
        entry('b', '/l-b'),
        entry('c', '/cl-c'),
      ])
    })

    test('a source with no layer clears an earlier layer for that name', () => {
      const merged = mergeSearchSettings([
        layered('user', { sources: [entry('a', '/u-a')] }),
        src({ sources: [entry('a', '/x-a')] }),
      ])
      expect(merged.sourceLayers.has('a')).toBe(false)
    })

    test('no layers at all gives an empty map', () => {
      expect(mergeSearchSettings([]).sourceLayers.size).toBe(0)
    })
  })
})

describe('selectConfigFile', () => {
  test('prefers .jsonc over .json and falls back to .json', () => {
    const dir = makeTempDir('select')
    expect(selectConfigFile(dir, 'systematic')).toBe(
      path.join(dir, 'systematic.json'),
    )
    fs.writeFileSync(path.join(dir, 'systematic.json'), '{}')
    expect(selectConfigFile(dir, 'systematic')).toBe(
      path.join(dir, 'systematic.json'),
    )
    fs.writeFileSync(path.join(dir, 'systematic.jsonc'), '{}')
    expect(selectConfigFile(dir, 'systematic')).toBe(
      path.join(dir, 'systematic.jsonc'),
    )
  })
})

describe('selection looks at the directory entry, not the link target', () => {
  const dangling = (file: string) =>
    fs.symlinkSync(path.join(path.dirname(file), 'no-such-target'), file)

  test('selectConfigFile selects a dangling .jsonc link over a valid .json', () => {
    const dir = makeTempDir('dangling-select')
    dangling(path.join(dir, 'systematic.jsonc'))
    fs.writeFileSync(path.join(dir, 'systematic.json'), '{}')
    expect(selectConfigFile(dir, 'systematic')).toBe(
      path.join(dir, 'systematic.jsonc'),
    )
  })

  test('selectProjectConfigFile selects a dangling root link over a valid .opencode file, and names the .opencode file as ignored', () => {
    const root = makeTempDir('dangling-project')
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(path.join(root, '.opencode/systematic.json'), '{}')
    dangling(path.join(root, '.systematic.jsonc'))
    expect(selectProjectConfigFile(root)).toEqual({
      path: path.join(root, '.systematic.jsonc'),
      ignoredPath: path.join(root, '.opencode/systematic.json'),
    })
  })

  test('a dangling .opencode link is an ignored file when a root file wins', () => {
    const root = makeTempDir('dangling-ignored')
    fs.mkdirSync(path.join(root, '.opencode'))
    dangling(path.join(root, '.opencode/systematic.json'))
    fs.writeFileSync(path.join(root, '.systematic.json'), '{}')
    expect(selectProjectConfigFile(root)).toEqual({
      path: path.join(root, '.systematic.json'),
      ignoredPath: path.join(root, '.opencode/systematic.json'),
    })
  })

  test('the project reader reports a dangling root link and applies nothing from .opencode', () => {
    const root = makeTempDir('dangling-reader')
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode/systematic.json'),
      JSON.stringify({
        search: {
          sources: [{ name: 'lower', format: 'markdown', roots: ['docs'] }],
        },
      }),
    )
    const link = path.join(root, '.systematic.jsonc')
    dangling(link)

    const load = loadProjectSearchSources(root)
    expect(load.unreadable).toBe(true)
    expect(load.sources).toEqual([])
    expect(load.warnings.join('\n')).toContain(link)
    expect(load.warnings.join('\n')).toContain('could not be read')
  })

  test('the project reader reports a dangling .opencode link that is the only candidate', () => {
    const root = makeTempDir('dangling-only')
    fs.mkdirSync(path.join(root, '.opencode'))
    const link = path.join(root, '.opencode/systematic.json')
    dangling(link)

    const load = loadProjectSearchSources(root)
    expect(load.unreadable).toBe(true)
    expect(load.warnings.join('\n')).toContain(link)
  })

  test('the user-level reader reports a dangling .jsonc link and does not fall back to the valid .json', () => {
    const root = makeTempDir('dangling-user')
    const homeDir = path.join(root, 'home')
    const userConfigDir = path.join(homeDir, '.config/opencode')
    fs.mkdirSync(userConfigDir, { recursive: true })
    const link = path.join(userConfigDir, 'systematic.jsonc')
    dangling(link)
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )

    const load = loadUserLevelSearchSettings({ homeDir, customConfigDir: null })
    expect(load.unreadable).toBe(true)
    expect(load.settings).toBeUndefined()
    expect(load.readFailures.join('\n')).toContain(link)
  })

  test('the full loader goes through the same selection and names the dangling file', () => {
    const root = makeTempDir('dangling-loader')
    const homeDir = path.join(root, 'home')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.opencode'))
    fs.mkdirSync(homeDir)
    fs.writeFileSync(path.join(repo, '.opencode/systematic.json'), '{}')
    const link = path.join(repo, '.systematic.jsonc')
    dangling(link)

    expect(() =>
      loadConfigWithSources(repo, { homeDir, customConfigDir: null }),
    ).toThrow(link)
  })

  test('a plain missing file is still absent: no entry, no report', () => {
    const root = makeTempDir('missing-still')
    fs.mkdirSync(path.join(root, '.opencode'))
    expect(loadProjectSearchSources(root)).toEqual({
      sources: [],
      warnings: [],
      unreadable: false,
      dropped: [],
      entries: [],
    })
  })
})

describe('resolveUserLevelConfigDirs', () => {
  const ORIGINAL = process.env.OPENCODE_CONFIG_DIR
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = ORIGINAL
  })

  test('defaults to os.homedir()/.config/opencode', () => {
    delete process.env.OPENCODE_CONFIG_DIR
    const dirs = resolveUserLevelConfigDirs()
    expect(dirs.homeDir).toBe(os.homedir())
    expect(dirs.userConfigDir).toBe(path.join(os.homedir(), '.config/opencode'))
    expect(dirs.customConfigDir).toBeUndefined()
  })

  test('trims OPENCODE_CONFIG_DIR and treats blank as unset', () => {
    process.env.OPENCODE_CONFIG_DIR = '  /custom/dir  '
    expect(resolveUserLevelConfigDirs().customConfigDir).toBe('/custom/dir')
    for (const blank of ['', '   ', '\t']) {
      process.env.OPENCODE_CONFIG_DIR = blank
      expect(resolveUserLevelConfigDirs().customConfigDir).toBeUndefined()
    }
  })

  test('explicit options win, and an explicit null suppresses the environment', () => {
    process.env.OPENCODE_CONFIG_DIR = '/from/env'
    expect(
      resolveUserLevelConfigDirs({ homeDir: '/h', customConfigDir: null }),
    ).toEqual({
      homeDir: '/h',
      userConfigDir: path.join('/h', '.config/opencode'),
      customConfigDir: undefined,
    })
    expect(
      resolveUserLevelConfigDirs({
        homeDir: '/h',
        userConfigDir: '/u',
        customConfigDir: ' /c ',
      }),
    ).toEqual({ homeDir: '/h', userConfigDir: '/u', customConfigDir: '/c' })
  })
})

describe('selectUserLevelConfigFiles', () => {
  function dirs() {
    const root = makeTempDir('layers')
    const userConfigDir = path.join(root, 'user')
    const customConfigDir = path.join(root, 'custom')
    fs.mkdirSync(userConfigDir)
    fs.mkdirSync(customConfigDir)
    return { root, homeDir: root, userConfigDir, customConfigDir }
  }

  test('returns user, user.local, custom, custom.local in order', () => {
    const d = dirs()
    const selection = selectUserLevelConfigFiles(d)
    expect(selection.files).toEqual([
      { layer: 'user', path: path.join(d.userConfigDir, 'systematic.json') },
      {
        layer: 'user.local',
        path: path.join(d.userConfigDir, 'systematic.local.json'),
      },
      {
        layer: 'custom',
        path: path.join(d.customConfigDir, 'systematic.json'),
      },
      {
        layer: 'custom.local',
        path: path.join(d.customConfigDir, 'systematic.local.json'),
      },
    ])
    expect(selection.aliased).toBe(false)
  })

  test('returns only the two user pairs without a custom directory', () => {
    const d = dirs()
    for (const customConfigDir of [undefined, '']) {
      const selection = selectUserLevelConfigFiles({ ...d, customConfigDir })
      expect(selection.files.map((file) => file.layer)).toEqual([
        'user',
        'user.local',
      ])
      expect(selection.aliased).toBe(false)
    }
  })

  test('a blank OPENCODE_CONFIG_DIR through the resolver yields no custom pair', () => {
    const d = dirs()
    const selection = selectUserLevelConfigFiles(
      resolveUserLevelConfigDirs({
        homeDir: d.homeDir,
        userConfigDir: d.userConfigDir,
        customConfigDir: '   ',
      }),
    )
    expect(selection.files.map((file) => file.layer)).toEqual([
      'user',
      'user.local',
    ])
  })

  test('selects a local file that has no sibling', () => {
    const d = dirs()
    fs.writeFileSync(path.join(d.userConfigDir, 'systematic.local.json'), '{}')
    fs.writeFileSync(
      path.join(d.customConfigDir, 'systematic.local.jsonc'),
      '{}',
    )
    const selection = selectUserLevelConfigFiles(d)
    expect(selection.files.map((file) => file.path)).toEqual([
      path.join(d.userConfigDir, 'systematic.json'),
      path.join(d.userConfigDir, 'systematic.local.json'),
      path.join(d.customConfigDir, 'systematic.json'),
      path.join(d.customConfigDir, 'systematic.local.jsonc'),
    ])
  })

  test('systematic.local.jsonc beats systematic.local.json', () => {
    const d = dirs()
    fs.writeFileSync(path.join(d.userConfigDir, 'systematic.local.json'), '{}')
    fs.writeFileSync(path.join(d.userConfigDir, 'systematic.local.jsonc'), '{}')
    const local = selectUserLevelConfigFiles(d).files.find(
      (file) => file.layer === 'user.local',
    )
    expect(local?.path).toBe(
      path.join(d.userConfigDir, 'systematic.local.jsonc'),
    )
  })

  test('a base file never stands in for its local, and the reverse', () => {
    const d = dirs()
    fs.writeFileSync(path.join(d.userConfigDir, 'systematic.jsonc'), '{}')
    const files = selectUserLevelConfigFiles(d).files
    expect(files[0]?.path).toBe(path.join(d.userConfigDir, 'systematic.jsonc'))
    expect(files[1]?.path).toBe(
      path.join(d.userConfigDir, 'systematic.local.json'),
    )
  })

  test('flags the same directory as aliased', () => {
    const d = dirs()
    const selection = selectUserLevelConfigFiles({
      ...d,
      customConfigDir: d.userConfigDir,
    })
    expect(selection.aliased).toBe(true)
    // Both layer positions stay, so the custom file keeps its precedence.
    expect(selection.files.map((file) => file.layer)).toEqual([
      'user',
      'user.local',
      'custom',
      'custom.local',
    ])
  })

  test('flags a trailing-slash spelling as aliased', () => {
    const d = dirs()
    expect(
      selectUserLevelConfigFiles({
        ...d,
        customConfigDir: `${d.userConfigDir}${path.sep}`,
      }).aliased,
    ).toBe(true)
  })

  test('flags a symlink to the user directory as aliased', () => {
    const d = dirs()
    const link = path.join(d.root, 'link')
    fs.symlinkSync(d.userConfigDir, link)
    expect(
      selectUserLevelConfigFiles({ ...d, customConfigDir: link }).aliased,
    ).toBe(true)
  })

  test('does not flag two different directories, even when neither exists', () => {
    const d = dirs()
    expect(
      selectUserLevelConfigFiles({
        homeDir: d.homeDir,
        userConfigDir: path.join(d.root, 'missing-a'),
        customConfigDir: path.join(d.root, 'missing-b'),
      }).aliased,
    ).toBe(false)
  })

  test('flags the same missing directory as aliased by path', () => {
    const d = dirs()
    const missing = path.join(d.root, 'missing')
    expect(
      selectUserLevelConfigFiles({
        homeDir: d.homeDir,
        userConfigDir: missing,
        customConfigDir: missing,
      }).aliased,
    ).toBe(true)
  })
})

describe('selectProjectConfigFile', () => {
  function repo() {
    const root = makeTempDir('project')
    fs.mkdirSync(path.join(root, '.opencode'))
    return root
  }
  const rootJsonc = (root: string) => path.join(root, '.systematic.jsonc')
  const rootJson = (root: string) => path.join(root, '.systematic.json')
  const ocJsonc = (root: string) =>
    path.join(root, '.opencode', 'systematic.jsonc')
  const ocJson = (root: string) =>
    path.join(root, '.opencode', 'systematic.json')

  test('a root .jsonc beats a root .json and the .opencode file', () => {
    const root = repo()
    fs.writeFileSync(rootJsonc(root), '{}')
    fs.writeFileSync(rootJson(root), '{}')
    fs.writeFileSync(ocJson(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({
      path: rootJsonc(root),
      ignoredPath: ocJson(root),
    })
  })

  test('a root .json beats the .opencode file and names the ignored path', () => {
    const root = repo()
    fs.writeFileSync(rootJson(root), '{}')
    fs.writeFileSync(ocJsonc(root), '{}')
    fs.writeFileSync(ocJson(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({
      path: rootJson(root),
      ignoredPath: ocJsonc(root),
    })
  })

  test('a root file with no .opencode file ignores nothing', () => {
    const root = repo()
    fs.writeFileSync(rootJsonc(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({ path: rootJsonc(root) })
  })

  test('the .opencode file wins when no root file exists, with nothing ignored', () => {
    const root = repo()
    fs.writeFileSync(ocJson(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({ path: ocJson(root) })
    fs.writeFileSync(ocJsonc(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({ path: ocJsonc(root) })
  })

  test('reports the .opencode/systematic.json path when no file exists anywhere', () => {
    const root = makeTempDir('project-empty')
    expect(selectProjectConfigFile(root)).toEqual({ path: ocJson(root) })
  })

  test('a directory named .systematic.jsonc is selected: existence, not validity', () => {
    const root = repo()
    fs.mkdirSync(rootJsonc(root))
    fs.writeFileSync(rootJson(root), '{}')
    fs.writeFileSync(ocJson(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({
      path: rootJsonc(root),
      ignoredPath: ocJson(root),
    })
  })

  test('an invalid root file still wins over a valid .opencode file', () => {
    const root = repo()
    fs.writeFileSync(rootJson(root), '{ not json')
    fs.writeFileSync(ocJson(root), '{}')
    expect(selectProjectConfigFile(root).path).toBe(rootJson(root))
  })

  test('a .json shadowed by a .jsonc in the same directory is not reported ignored', () => {
    const root = repo()
    fs.writeFileSync(rootJsonc(root), '{}')
    fs.writeFileSync(rootJson(root), '{}')
    expect(selectProjectConfigFile(root)).toEqual({ path: rootJsonc(root) })
  })

  test('a symlinked start directory selects the repository root file', () => {
    const env = makeExternalEnv(temp)
    writeProjectSearch(env, { sources: [] }, 'root')
    writeProjectSearch(env, { sources: [] })
    const app = path.join(env.repo, 'packages', 'app')
    fs.mkdirSync(app, { recursive: true })
    const link = path.join(env.root, 'app-link')
    fs.symlinkSync(app, link)
    const lookup = lookupSearchRoot(link)
    expect(lookup).toEqual({ root: env.repo, foundGit: true })
    expect(selectProjectConfigFile(lookup.root)).toEqual({
      path: rootJson(env.repo),
      ignoredPath: ocJson(env.repo),
    })
  })

  test('the fixture helpers write the files this selection reads', () => {
    const env = makeExternalEnv(temp)
    writeProjectSearch(env, { sources: [] }, 'root')
    writeProjectSearch(env, { sources: [] })
    writeUserSearch(env, {})
    writeUserLocalSearch(env, {})
    expect(selectProjectConfigFile(env.repo)).toEqual({
      path: rootJson(env.repo),
      ignoredPath: ocJson(env.repo),
    })
    expect(
      selectUserLevelConfigFiles(
        resolveUserLevelConfigDirs(env.configOptions),
      ).files.map((file) => file.path),
    ).toEqual([
      path.join(env.userConfigDir, 'systematic.json'),
      path.join(env.userConfigDir, 'systematic.local.json'),
    ])
  })
})

describe('loadUserLevelSearchSettings', () => {
  function layout() {
    const root = makeTempDir('reader')
    const homeDir = path.join(root, 'home')
    const userConfigDir = path.join(homeDir, '.config/opencode')
    const customConfigDir = path.join(root, 'custom')
    fs.mkdirSync(userConfigDir, { recursive: true })
    fs.mkdirSync(customConfigDir, { recursive: true })
    return { root, homeDir, userConfigDir, customConfigDir }
  }

  test('reads nothing and reports nothing when no file exists', () => {
    const { homeDir } = layout()
    expect(
      loadUserLevelSearchSettings({ homeDir, customConfigDir: null }),
    ).toEqual({
      settings: undefined,
      warnings: [],
      unreadable: false,
      dropped: [],
      entries: [],
      sourceLayers: new Map(),
      readFailures: [],
    })
  })

  test('merges user then custom through the shared merge rules', () => {
    const { homeDir, userConfigDir, customConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: true } }),
    )
    fs.writeFileSync(
      path.join(customConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toEqual([])
    expect(loaded.settings).toEqual({ enabled: false })
  })

  test('reads allow_project_sources and sources from both files, custom winning by name', () => {
    const { homeDir, userConfigDir, customConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({
        search: {
          allow_project_sources: ['/work/a'],
          sources: [validUser('wiki', { roots: ['/user'] })],
        },
      }),
    )
    fs.writeFileSync(
      path.join(customConfigDir, 'systematic.json'),
      JSON.stringify({
        search: {
          allow_project_sources: ['/work/b'],
          sources: [validUser('wiki', { roots: ['/custom'] })],
        },
      }),
    )
    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.unreadable).toBe(false)
    expect(loaded.settings?.allow_project_sources).toEqual([
      '/work/a',
      '/work/b',
    ])
    expect(loaded.settings?.sources).toEqual([
      validUser('wiki', { roots: ['/custom'] }),
    ])
  })

  test('a bad sources container keeps enabled:false from the same file', () => {
    const { homeDir, userConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false, sources: 'nope' } }),
    )
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.settings).toEqual({ enabled: false })
    expect(loaded.unreadable).toBe(true)
    expect(loaded.warnings).toHaveLength(1)
  })

  test('a FIFO or a directory at a user-level path is unreadable, not a hang', () => {
    const { homeDir, userConfigDir } = layout()
    const fifo = path.join(userConfigDir, 'systematic.json')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    // A one-shot writer lets a blocking read return, so a reader that still
    // blocks fails the assertions below instead of wedging the run.
    const writer = spawn('sh', ['-c', 'echo "{}" > "$0"', fifo], {
      stdio: 'ignore',
    })
    try {
      const loaded = loadUserLevelSearchSettings({
        homeDir,
        customConfigDir: null,
      })
      expect(loaded.unreadable).toBe(true)
      expect(loaded.readFailures).toHaveLength(1)
      expect(loaded.warnings.join('\n')).toContain(fifo)
    } finally {
      writer.kill()
    }

    const local = path.join(userConfigDir, 'systematic.local.json')
    fs.mkdirSync(local)
    const withDirectory = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(withDirectory.readFailures.join('\n')).toContain(local)
  })

  test('user enabled:false survives a custom file with no search block', () => {
    const { homeDir, userConfigDir, customConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    fs.writeFileSync(
      path.join(customConfigDir, 'systematic.json'),
      JSON.stringify({ disabled_skills: [] }),
    )
    expect(
      loadUserLevelSearchSettings({ homeDir, customConfigDir }).settings,
    ).toEqual({ enabled: false })
  })

  test('accepts JSONC comments, preferring .jsonc to .json', () => {
    const { homeDir, userConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: true } }),
    )
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.jsonc'),
      `{
        // search is switched off here
        "search": { "enabled": false /* inline */ }
      }`,
    )
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.settings).toEqual({ enabled: false })
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toEqual([])
  })

  test('accepts trailing commas without losing the user search opt-out, matching the loader', () => {
    const { root, homeDir, userConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.jsonc'),
      `{
        "search": { "enabled": false, },
      }`,
    )
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.unreadable).toBe(false)
    expect(loaded.settings).toEqual({ enabled: false })
    expect(loaded.warnings).toEqual([])

    // The full loader and the bin-safe reader must preserve the same opt-out.
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    expect(
      loadConfigWithSources(projectDir, {
        homeDir,
        customConfigDir: null,
        warningSink: () => {},
      }).config.search?.enabled,
    ).toBe(false)
  })

  test('falls back to .json when there is no .jsonc', () => {
    const { homeDir, userConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    expect(
      loadUserLevelSearchSettings({ homeDir, customConfigDir: null }).settings,
    ).toEqual({ enabled: false })
  })

  test('never reads project config', () => {
    const { root, homeDir } = layout()
    const projectDir = path.join(root, 'project/.opencode')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    const previousCwd = process.cwd()
    process.chdir(path.join(root, 'project'))
    try {
      expect(
        loadUserLevelSearchSettings({ homeDir, customConfigDir: null }),
      ).toMatchObject({ settings: undefined, warnings: [], unreadable: false })
    } finally {
      process.chdir(previousCwd)
    }
  })

  test('an unparseable file gives unreadable with one warning and never throws', () => {
    const { homeDir, userConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      '{ "search": { "enabled": ',
    )
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.unreadable).toBe(true)
    expect(loaded.settings).toBeUndefined()
    expect(loaded.warnings).toHaveLength(1)
  })

  test('a non-object root gives unreadable', () => {
    const { homeDir, userConfigDir } = layout()
    fs.writeFileSync(path.join(userConfigDir, 'systematic.json'), '[1, 2]')
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.unreadable).toBe(true)
    expect(loaded.warnings).toHaveLength(1)
  })

  test.each([
    ['a removed embeddings block', { embeddings: { provider: 'nope' } }],
    ['a non-boolean enabled', { enabled: 'nope' }],
    ['an unknown key', { nope: true }],
  ])('%s drops the block with one warning and no value', (_label, block) => {
    const { homeDir, userConfigDir } = layout()
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify({ search: block }),
    )
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.unreadable).toBe(true)
    expect(loaded.settings).toBeUndefined()
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('has been ignored')
    expect(loaded.warnings[0]).toContain(
      'results carry a `config unreadable` note',
    )
    expect(loaded.warnings[0]).not.toContain('lexical')
    expect(loaded.warnings[0]).not.toContain('nope')
  })
})

describe('loadProjectSearchSources', () => {
  test('accepts nested trailing commas in a root project config', () => {
    const { root } = checkout()
    fs.writeFileSync(
      path.join(root, '.systematic.jsonc'),
      '{"search": {"sources": [{"name": "rfcs", "format": "markdown", "roots": ["docs/rfcs",],},],},}',
    )

    const loaded = loadProjectSearchSources(root)
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toEqual([])
    expect(loaded.sources).toEqual([GOOD])
  })

  function checkout(): { root: string; dir: string } {
    const root = makeTempDir('project-reader')
    const dir = path.join(root, '.opencode')
    fs.mkdirSync(dir, { recursive: true })
    return { root, dir }
  }

  const GOOD = {
    name: 'rfcs',
    format: 'markdown' as const,
    roots: ['docs/rfcs'],
  }

  /** A valid project config padded with trailing whitespace to exactly `bytes`. */
  function paddedConfig(bytes: number): string {
    const base = JSON.stringify({ search: { sources: [GOOD] } })
    return base + ' '.repeat(bytes - Buffer.byteLength(base))
  }

  test('the cap is 1 MB', () => {
    expect(MAX_PROJECT_CONFIG_BYTES).toBe(1024 * 1024)
  })

  test('a missing file is normal: no sources, no warning, readable', () => {
    const { root } = checkout()
    expect(loadProjectSearchSources(root)).toEqual({
      sources: [],
      warnings: [],
      unreadable: false,
      dropped: [],
      entries: [],
    })
  })

  test('a file without a search block is normal', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      '{"disabled_skills":[]}',
    )
    expect(loadProjectSearchSources(root)).toEqual({
      sources: [],
      warnings: [],
      unreadable: false,
      dropped: [],
      entries: [],
    })
  })

  test('reads valid sources from .json', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      JSON.stringify({ search: { sources: [GOOD] } }),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([GOOD])
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toEqual([])
  })

  test('prefers .jsonc over .json when both exist', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      JSON.stringify({ search: { sources: [{ ...GOOD, name: 'from-json' }] } }),
    )
    fs.writeFileSync(
      path.join(dir, 'systematic.jsonc'),
      '// comment\n{ "search": { "sources": [{ "name": "from-jsonc", "format": "markdown", "roots": ["docs"] }] } }',
    )
    expect(loadProjectSearchSources(root).sources.map((s) => s.name)).toEqual([
      'from-jsonc',
    ])
  })

  test('does not read the user-only fields: enabled and allow list are ignored', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      JSON.stringify({
        search: {
          enabled: false,
          allow_project_sources: ['/x'],
          sources: [GOOD],
        },
      }),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([GOOD])
    expect(loaded).not.toHaveProperty('enabled')
  })

  test('one valid and one invalid entry: the valid one loads, a warning names the other, not unreadable', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      JSON.stringify({
        search: {
          sources: [
            GOOD,
            { name: 'escape', format: 'markdown', roots: ['..'] },
          ],
        },
      }),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([GOOD])
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('"escape"')
  })

  test.each([
    ['malformed JSONC', '{ "search": { "sources": [ '],
    ['a non-object root', '[1]'],
    ['sources that is not an array', '{"search":{"sources":"docs"}}'],
    ['a search block that is not an object', '{"search":"on"}'],
  ])(
    '%s is structural: zero proposals, unreadable, one warning without values',
    (_label, content) => {
      const { root, dir } = checkout()
      fs.writeFileSync(path.join(dir, 'systematic.json'), content)
      const loaded = loadProjectSearchSources(root)
      expect(loaded.sources).toEqual([])
      expect(loaded.unreadable).toBe(true)
      expect(loaded.warnings).toHaveLength(1)
      expect(loaded.warnings[0]).not.toContain('docs')
    },
  )

  test('a project read warning does not claim a user-config note', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(path.join(dir, 'systematic.json'), '{ nope')
    expect(loadProjectSearchSources(root).warnings[0]).not.toContain(
      'config unreadable',
    )
  })

  test('a file that is not a regular file is unreadable and is not read', () => {
    const { root, dir } = checkout()
    fs.mkdirSync(path.join(dir, 'systematic.jsonc'))
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([])
    expect(loaded.unreadable).toBe(true)
    expect(loaded.warnings[0]).toContain('not a regular file')
  })

  test('a file of exactly 1 MB is accepted', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      paddedConfig(MAX_PROJECT_CONFIG_BYTES),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.unreadable).toBe(false)
    expect(loaded.sources).toEqual([GOOD])
  })

  test('a file one byte over 1 MB is rejected', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      paddedConfig(MAX_PROJECT_CONFIG_BYTES + 1),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.unreadable).toBe(true)
    expect(loaded.sources).toEqual([])
    expect(loaded.warnings).toHaveLength(1)
  })

  test('a file far over 1 MB is rejected after reading at most the cap plus one byte', () => {
    const { root, dir } = checkout()
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      paddedConfig(MAX_PROJECT_CONFIG_BYTES * 5),
    )
    const realReadSync = fs.readSync.bind(fs)
    let bytesRead = 0
    const spy = spyOn(fs, 'readSync').mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const count = realReadSync(...args)
      bytesRead += count
      return count
    }) as typeof fs.readSync)
    try {
      const loaded = loadProjectSearchSources(root)
      expect(loaded.unreadable).toBe(true)
      expect(loaded.sources).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(bytesRead).toBeGreaterThan(0)
    expect(bytesRead).toBeLessThanOrEqual(MAX_PROJECT_CONFIG_BYTES + 1)
  })

  test('a file that grows past 1 MB while it is being read is rejected the same way', () => {
    const { root, dir } = checkout()
    const file = path.join(dir, 'systematic.json')
    fs.writeFileSync(file, paddedConfig(600 * 1024))
    const realReadSync = fs.readSync.bind(fs)
    let calls = 0
    let bytesRead = 0
    const spy = spyOn(fs, 'readSync').mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const count = realReadSync(...args)
      bytesRead += count
      calls += 1
      // The file doubles after the first chunk, as a concurrent writer would.
      if (calls === 1) fs.appendFileSync(file, ' '.repeat(600 * 1024))
      return count
    }) as typeof fs.readSync)
    try {
      const loaded = loadProjectSearchSources(root)
      expect(loaded.unreadable).toBe(true)
      expect(loaded.sources).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(calls).toBeGreaterThan(1)
    expect(bytesRead).toBeLessThanOrEqual(MAX_PROJECT_CONFIG_BYTES + 1)
  })
})

describe('a user source must be mapped to at least one project', () => {
  const user = (value: unknown) =>
    validateSearchConfig(value, 'user', USER_FILE)

  const unmapped = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    format: 'markdown' as const,
    roots: ['/srv/docs'],
    ...extra,
  })

  test.each([
    ['omits projects', unmapped('loose')],
    ['has an empty projects array', unmapped('loose', { projects: [] })],
  ])(
    'an entry that %s is dropped with the usual entry warning and its siblings stay',
    (_label, entry) => {
      const keeper = unmapped('keeper', { projects: ['/work/app'] })
      const result = user({ enabled: false, sources: [entry, keeper] })

      expect(result.settings).toEqual({ enabled: false, sources: [keeper] })
      expect(result.structural).toBe(false)
      expect(result.unreadable).toBe(false)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('"loose"')
      expect(result.warnings[0]).toContain('was dropped')
      expect(result.warnings[0]).toContain('projects')
      expect(result.warnings[0]).toContain('Its valid siblings still load')
    },
  )

  test('a non-array projects value is still dropped', () => {
    const result = user({ sources: [unmapped('a', { projects: '/work/app' })] })
    expect(result.settings?.sources).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
  })

  test('project trust still takes an entry without projects', () => {
    const result = validateSearchConfig(
      { sources: [{ name: 'p', format: 'markdown', roots: ['docs'] }] },
      'project',
      '/repo/.opencode/systematic.json',
    )
    expect(result.settings?.sources).toHaveLength(1)
    expect(result.warnings).toEqual([])
  })

  test('the loaders drop an unmapped user entry too', () => {
    const root = makeTempDir('unmapped')
    const homeDir = path.join(root, 'home')
    const userDir = path.join(homeDir, '.config/opencode')
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'systematic.json'),
      JSON.stringify({ search: { sources: [unmapped('loose')] } }),
    )
    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.settings).toBeUndefined()
    expect(loaded.warnings).toHaveLength(1)
    const config = loadConfigWithSources(root, {
      homeDir,
      customConfigDir: null,
      warningSink: () => {},
    }).config
    expect(config.search).toBeUndefined()
  })

  test('the schema says projects is required for a user entry', () => {
    const description = z.globalRegistry.get(
      SearchSourceSchema.shape.projects,
    )?.description
    expect(description).toContain('at least one')
    expect(description).toContain('required')
  })
})

describe('validateSearchConfig: exclude', () => {
  const PROJECT_FILE = '/repo/.opencode/systematic.json'

  const user = (value: unknown) =>
    validateSearchConfig(value, 'user', USER_FILE)

  const withExclude = (exclude: unknown, trust: 'user' | 'project') =>
    trust === 'user'
      ? validateSearchConfig(
          { sources: [validUser('wiki', { exclude })] },
          'user',
          USER_FILE,
        )
      : validateSearchConfig(
          {
            sources: [
              { name: 'wiki', format: 'markdown', roots: ['docs'], exclude },
            ],
          },
          'project',
          PROJECT_FILE,
        )

  const trusts: Array<'user' | 'project'> = ['user', 'project']

  test.each(trusts)(
    'a %s entry keeps valid patterns in order and warns about nothing',
    (trust) => {
      const result = withExclude(['log.md', '.stryker-tmp'], trust)
      expect(result.warnings).toEqual([])
      expect(result.dropped).toEqual([])
      expect(result.settings?.sources?.[0]?.exclude).toEqual([
        'log.md',
        '.stryker-tmp',
      ])
    },
  )

  test.each(trusts)(
    'a %s entry drops one bad pattern alone, names exclude[i] and never the pattern text',
    (trust) => {
      const result = withExclude(['drafts/*.md', '[bad\u001b]'], trust)
      expect(result.settings?.sources?.[0]?.exclude).toEqual(['drafts/*.md'])
      expect(result.warnings).toHaveLength(1)
      const [warning] = result.warnings
      expect(warning).toContain('exclude[1]')
      expect(warning).toContain('"wiki"')
      expect(warning).not.toContain('bad')
      expect(warning).not.toContain('\u001b')
      expect(result.dropped).toEqual([])
      expect(result.unreadable).toBe(false)
      expect(result.structural).toBe(false)
    },
  )

  test('a negated pattern is reported at its index and the later pattern stays as written', () => {
    const result = withExclude(['!log.md', 'a/**/**/**/b'], 'user')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('exclude[0]')
    expect(result.warnings[0]).not.toContain('log.md')
    expect(result.settings?.sources?.[0]?.exclude).toEqual(['a/**/**/**/b'])
  })

  test('a non-string element is dropped as not a string and its neighbours survive', () => {
    const result = withExclude([5, 'ok.md', null], 'user')
    expect(result.settings?.sources?.[0]?.exclude).toEqual(['ok.md'])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('exclude[0]')
    expect(result.warnings[0]).toContain('not a string')
    expect(result.warnings[1]).toContain('exclude[2]')
  })

  test.each(trusts)(
    'a %s exclude that is not an array drops the source, reports it in dropped and keeps siblings',
    (trust) => {
      const result =
        trust === 'user'
          ? validateSearchConfig(
              {
                sources: [
                  validUser('wiki', { exclude: 'secret-pattern.md' }),
                  validUser('keeper'),
                ],
              },
              'user',
              USER_FILE,
            )
          : validateSearchConfig(
              {
                sources: [
                  {
                    name: 'wiki',
                    format: 'markdown',
                    roots: ['docs'],
                    exclude: 'secret-pattern.md',
                  },
                  { name: 'keeper', format: 'markdown', roots: ['docs2'] },
                ],
              },
              'project',
              PROJECT_FILE,
            )
      expect(result.settings?.sources?.map((s) => s.name)).toEqual(['keeper'])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('"wiki"')
      expect(result.warnings[0]).toContain('exclude')
      expect(result.warnings[0]).not.toContain('secret-pattern')
      expect(result.dropped).toHaveLength(1)
      expect(result.dropped[0]?.label).toBe('"wiki"')
      expect(result.dropped[0]?.reason).toContain('exclude')
      expect(result.dropped[0]?.reason).not.toContain('secret-pattern')
    },
  )

  test('an empty exclude is a no-op: no warning, no field on the entry', () => {
    const result = withExclude([], 'user')
    expect(result.warnings).toEqual([])
    expect(result.dropped).toEqual([])
    expect(result.settings?.sources?.[0]).toEqual(validUser('wiki'))
    expect(Object.hasOwn(result.settings?.sources?.[0] ?? {}, 'exclude')).toBe(
      false,
    )
  })

  test('an entry without exclude has no exclude field', () => {
    const result = user({ sources: [validUser('wiki')] })
    expect(Object.hasOwn(result.settings?.sources?.[0] ?? {}, 'exclude')).toBe(
      false,
    )
  })

  test('seventy patterns keep the first sixty-four with one aggregate warning', () => {
    const patterns = Array.from({ length: 70 }, (_v, i) => `p${i}.md`)
    const result = withExclude(patterns, 'user')
    expect(result.settings?.sources?.[0]?.exclude).toEqual(
      patterns.slice(0, 64),
    )
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('exclude[64]')
    expect(result.warnings[0]).toContain('6')
  })

  test('a pattern of 257 characters is dropped and 256 is kept', () => {
    const result = withExclude(['a'.repeat(256), 'b'.repeat(257)], 'user')
    expect(result.settings?.sources?.[0]?.exclude).toEqual(['a'.repeat(256)])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('exclude[1]')
  })

  test('a duplicate-name entry reports the duplicate only, not its exclude issues', () => {
    const result = user({
      sources: [validUser('dup'), validUser('dup', { exclude: ['!x'] })],
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).not.toContain('exclude[')
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.label).toBe('"dup"')
  })

  test('exclude warnings share the detail cap with entry warnings', () => {
    const result = user({
      sources: Array.from({ length: 4 }, (_v, i) =>
        validUser(`s${i}`, { exclude: ['!a', '!b'] }),
      ),
    })
    expect(result.warnings).toHaveLength(6)
    expect(result.warnings[5]).toContain('3 more')
  })

  test('every dropped entry is listed with its label and reason', () => {
    const result = user({
      sources: [
        'not-an-object',
        validUser('bad-format', { format: 'yaml' }),
        validUser('dup'),
        validUser('dup'),
        validUser('ok'),
      ],
    })
    expect(result.dropped.map((d) => d.label)).toEqual([
      '#0',
      '"bad-format"',
      '"dup"',
    ])
    for (const entry of result.dropped) {
      expect(entry.reason.length).toBeGreaterThan(0)
    }
    expect(result.settings?.sources?.map((s) => s.name)).toEqual(['dup', 'ok'])
  })

  test('a valid block and a structural error both give an empty dropped list', () => {
    expect(user({ sources: [validUser('a')] }).dropped).toEqual([])
    expect(user({ sources: 'x' }).dropped).toEqual([])
    expect(user(null).dropped).toEqual([])
  })

  test('the schema accepts exclude and documents it with a description and an example', () => {
    expect(
      SearchSourceSchema.safeParse(validUser('wiki', { exclude: ['log.md'] }))
        .success,
    ).toBe(true)
    const meta = z.globalRegistry.get(SearchSourceSchema.shape.exclude)
    expect(typeof meta?.description).toBe('string')
    expect(meta?.description).toContain('64')
    expect(Array.isArray(meta?.examples)).toBe(true)
  })

  test('the full loader, the reader and the shared validator agree on exclude', () => {
    const search = {
      sources: [
        validUser('wiki', { exclude: ['drafts/*.md', '[bad]', 7, 'a/**/b'] }),
        validUser('broken', { exclude: 'log.md' }),
      ],
    }
    const root = makeTempDir('exclude-parity')
    const homeDir = path.join(root, 'home')
    const userDir = path.join(homeDir, '.config/opencode')
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(userDir, { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'systematic.json'),
      JSON.stringify({ search }),
    )
    const fullWarnings: string[] = []
    const viaConfig = loadConfigWithSources(projectDir, {
      homeDir,
      customConfigDir: null,
      warningSink: (message) => fullWarnings.push(message),
    }).config
    const viaReader = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    const viaShared = validateSearchConfig(
      search,
      'user',
      path.join(userDir, 'systematic.json'),
    )

    const expectedExclude = ['drafts/*.md', 'a/**/b']
    expect(viaShared.settings?.sources?.map((s) => s.name)).toEqual(['wiki'])
    expect(viaShared.settings?.sources?.[0]?.exclude).toEqual(expectedExclude)
    expect(viaConfig.search).toEqual(viaShared.settings)
    expect(viaReader.settings).toEqual(viaShared.settings)

    const normalize = (message: string) =>
      message
        .replaceAll(fs.realpathSync(userDir), '<dir>')
        .replaceAll(userDir, '<dir>')
    const fromFull = fullWarnings
      .filter((message) => message.includes('search source'))
      .map(normalize)
    const fromReader = viaReader.warnings.map(normalize)
    expect(fromFull).toEqual(fromReader)
    expect(fromReader.length).toBeGreaterThanOrEqual(3)
  })
})

describe('loadUserLevelSearchSettings: four layers', () => {
  function layout() {
    const root = makeTempDir('layers')
    const homeDir = path.join(root, 'home')
    const userConfigDir = path.join(homeDir, '.config/opencode')
    const customConfigDir = path.join(root, 'custom')
    fs.mkdirSync(userConfigDir, { recursive: true })
    fs.mkdirSync(customConfigDir, { recursive: true })
    const write = (dir: string, name: string, search: unknown) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ search }))
    return { root, homeDir, userConfigDir, customConfigDir, write }
  }

  const wiki = (roots: string[], projects: string[]) => ({
    name: 'wiki',
    format: 'markdown' as const,
    roots,
    projects,
  })

  test('enabled set at every layer resolves to the custom.local value, and each removal falls to the next', () => {
    const { homeDir, userConfigDir, customConfigDir, write } = layout()
    const files: Array<[string, string, boolean]> = [
      [userConfigDir, 'systematic.json', true],
      [userConfigDir, 'systematic.local.json', false],
      [customConfigDir, 'systematic.json', true],
      [customConfigDir, 'systematic.local.json', false],
    ]
    for (const [dir, name, enabled] of files) write(dir, name, { enabled })
    const read = () =>
      loadUserLevelSearchSettings({ homeDir, customConfigDir }).settings
        ?.enabled

    expect(read()).toBe(false)
    fs.rmSync(path.join(customConfigDir, 'systematic.local.json'))
    expect(read()).toBe(true)
    fs.rmSync(path.join(customConfigDir, 'systematic.json'))
    expect(read()).toBe(false)
    fs.rmSync(path.join(userConfigDir, 'systematic.local.json'))
    expect(read()).toBe(true)
  })

  test('user.local unions the allow list and replaces a same-named source whole, with no field merging', () => {
    const { homeDir, userConfigDir, write } = layout()
    write(userConfigDir, 'systematic.json', {
      allow_project_sources: ['/work/a'],
      sources: [
        {
          ...wiki(['/user-root'], ['/work/a', '/work/b']),
          exclude: ['log.md'],
        },
      ],
    })
    write(userConfigDir, 'systematic.local.json', {
      allow_project_sources: ['/work/b'],
      sources: [wiki(['/local-root'], ['/work/b'])],
    })

    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.settings?.allow_project_sources).toEqual([
      '/work/a',
      '/work/b',
    ])
    expect(loaded.settings?.sources).toEqual([
      wiki(['/local-root'], ['/work/b']),
    ])
    expect(loaded.sourceLayers.get('wiki')).toBe('user.local')
  })

  test('user.local and custom both define a source: custom wins and the layer says so', () => {
    const { homeDir, userConfigDir, customConfigDir, write } = layout()
    write(userConfigDir, 'systematic.local.json', {
      sources: [wiki(['/local-root'], ['/work/a'])],
    })
    write(customConfigDir, 'systematic.json', {
      sources: [wiki(['/custom-root'], ['/work/a'])],
    })

    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.settings?.sources).toEqual([
      wiki(['/custom-root'], ['/work/a']),
    ])
    expect(loaded.sourceLayers.get('wiki')).toBe('custom')
  })

  test('a local file with no sibling is read alone, in both directories', () => {
    const { homeDir, userConfigDir, customConfigDir, write } = layout()
    write(userConfigDir, 'systematic.local.jsonc', {
      allow_project_sources: ['/work/a'],
    })
    write(customConfigDir, 'systematic.local.json', { enabled: false })

    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.settings).toEqual({
      enabled: false,
      allow_project_sources: ['/work/a'],
    })
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toEqual([])
  })

  test('a syntax error in user.local gives one warning naming it and unreadable, while user and custom still merge', () => {
    const { homeDir, userConfigDir, customConfigDir, write } = layout()
    write(userConfigDir, 'systematic.json', { allow_project_sources: ['/a'] })
    write(customConfigDir, 'systematic.json', { enabled: false })
    const brokenLocal = path.join(userConfigDir, 'systematic.local.json')
    fs.writeFileSync(brokenLocal, '{ "search": { "enabled": ')

    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.unreadable).toBe(true)
    expect(loaded.settings).toEqual({
      enabled: false,
      allow_project_sources: ['/a'],
    })
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain(brokenLocal)
    expect(loaded.readFailures).toEqual(loaded.warnings)
  })

  test('a failed custom.local names that file, not its sibling', () => {
    const { homeDir, customConfigDir, write } = layout()
    write(customConfigDir, 'systematic.json', { enabled: false })
    const brokenLocal = path.join(customConfigDir, 'systematic.local.jsonc')
    fs.writeFileSync(brokenLocal, '[1]')

    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.unreadable).toBe(true)
    expect(loaded.settings).toEqual({ enabled: false })
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain(brokenLocal)
  })

  test('a valid enabled:false in a local file is honored beside an invalid sibling', () => {
    const { homeDir, userConfigDir, write } = layout()
    fs.writeFileSync(path.join(userConfigDir, 'systematic.json'), '{ nope')
    write(userConfigDir, 'systematic.local.json', { enabled: false })

    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.settings).toEqual({ enabled: false })
    expect(loaded.unreadable).toBe(true)
  })

  test('a dropped entry is listed with its label and reason, and validation warnings are not read failures', () => {
    const { homeDir, userConfigDir, write } = layout()
    write(userConfigDir, 'systematic.local.json', {
      sources: [
        wiki(['/ok'], ['/work/a']),
        { name: 'bad', format: 'markdown', roots: ['/x'] },
      ],
    })

    const loaded = loadUserLevelSearchSettings({
      homeDir,
      customConfigDir: null,
    })
    expect(loaded.settings?.sources?.map((s) => s.name)).toEqual(['wiki'])
    expect(loaded.dropped).toHaveLength(1)
    expect(loaded.dropped[0]?.label).toBe('"bad"')
    expect(loaded.dropped[0]?.reason).toEqual(expect.any(String))
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.readFailures).toEqual([])
  })

  describe('a custom directory that is the user directory', () => {
    /** Run `body` and count the times it opened `file` to read it. */
    function countReads(file: string, body: () => void): number {
      const real = fs.openSync.bind(fs)
      let count = 0
      const spy = spyOn(fs, 'openSync').mockImplementation(((
        ...args: Parameters<typeof fs.openSync>
      ) => {
        if (String(args[0]) === file) count += 1
        return real(...args)
      }) as typeof fs.openSync)
      try {
        body()
      } finally {
        spy.mockRestore()
      }
      return count
    }

    test('each file is read once, a broken local is reported once, and both layer positions still apply', () => {
      const { homeDir, userConfigDir, write } = layout()
      write(userConfigDir, 'systematic.json', {
        sources: [wiki(['/shared-root'], ['/work/a'])],
      })
      const brokenLocal = path.join(userConfigDir, 'systematic.local.json')
      fs.writeFileSync(brokenLocal, '{ "search": ')
      const userFile = path.join(userConfigDir, 'systematic.json')

      let loaded: ReturnType<typeof loadUserLevelSearchSettings> | undefined
      const reads = countReads(userFile, () => {
        loaded = loadUserLevelSearchSettings({
          homeDir,
          customConfigDir: userConfigDir,
        })
      })
      expect(reads).toBe(1)
      if (loaded === undefined) throw new Error('the reader did not run')
      expect(loaded.warnings).toHaveLength(1)
      expect(loaded.warnings[0]).toContain(brokenLocal)
      // The custom position still ranks the shared file's source.
      expect(loaded.sourceLayers.get('wiki')).toBe('custom')
      expect(loaded.settings?.sources).toEqual([
        wiki(['/shared-root'], ['/work/a']),
      ])
    })

    test('a symlink to the user directory counts as the same directory', () => {
      const { root, homeDir, userConfigDir, write } = layout()
      write(userConfigDir, 'systematic.json', { enabled: false })
      const link = path.join(root, 'linked')
      fs.symlinkSync(userConfigDir, link)
      fs.writeFileSync(
        path.join(userConfigDir, 'systematic.local.json'),
        '{ nope',
      )

      const loaded = loadUserLevelSearchSettings({
        homeDir,
        customConfigDir: link,
      })
      expect(loaded.warnings).toHaveLength(1)
      expect(loaded.settings).toEqual({ enabled: false })
    })

    test('a dropped entry in the shared file is listed once', () => {
      const { homeDir, userConfigDir, write } = layout()
      write(userConfigDir, 'systematic.json', {
        sources: [{ name: 'bad', format: 'markdown', roots: ['/x'] }],
      })
      const loaded = loadUserLevelSearchSettings({
        homeDir,
        customConfigDir: userConfigDir,
      })
      expect(loaded.dropped).toHaveLength(1)
      expect(loaded.warnings).toHaveLength(1)
    })
  })
})

describe('loadProjectSearchSources: project file selection', () => {
  const GOOD = {
    name: 'rfcs',
    format: 'markdown' as const,
    roots: ['docs/rfcs'],
  }
  const OTHER = { ...GOOD, name: 'other', roots: ['docs/other'] }

  function repo() {
    const root = makeTempDir('selection')
    const opencode = path.join(root, '.opencode')
    fs.mkdirSync(opencode, { recursive: true })
    return {
      root,
      rootJsonc: path.join(root, '.systematic.jsonc'),
      rootJson: path.join(root, '.systematic.json'),
      opencodeFile: path.join(opencode, 'systematic.json'),
    }
  }
  const body = (...sources: unknown[]) =>
    JSON.stringify({ search: { sources } })

  test('the root file wins over .opencode/, the warning names both paths, and the files are never merged', () => {
    const { root, rootJson, opencodeFile } = repo()
    fs.writeFileSync(rootJson, body(GOOD))
    fs.writeFileSync(opencodeFile, body(OTHER))

    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources.map((s) => s.name)).toEqual(['rfcs'])
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain(rootJson)
    expect(loaded.warnings[0]).toContain(opencodeFile)
  })

  test('.systematic.jsonc beats .systematic.json', () => {
    const { root, rootJsonc, rootJson } = repo()
    fs.writeFileSync(rootJson, body({ ...GOOD, name: 'from-json' }))
    fs.writeFileSync(
      rootJsonc,
      `// c\n${body({ ...GOOD, name: 'from-jsonc' })}`,
    )
    expect(loadProjectSearchSources(root).sources.map((s) => s.name)).toEqual([
      'from-jsonc',
    ])
  })

  test('a root file alone gives no warning, and .opencode/ alone still works', () => {
    const { root, rootJson, opencodeFile } = repo()
    fs.writeFileSync(rootJson, body(GOOD))
    expect(loadProjectSearchSources(root).warnings).toEqual([])
    fs.rmSync(rootJson)
    fs.writeFileSync(opencodeFile, body(OTHER))
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources.map((s) => s.name)).toEqual(['other'])
    expect(loaded.warnings).toEqual([])
  })

  test('enabled and allow_project_sources in a root file are not read', () => {
    const { root, rootJson } = repo()
    fs.writeFileSync(
      rootJson,
      JSON.stringify({
        search: {
          enabled: false,
          allow_project_sources: ['/x'],
          sources: [GOOD],
        },
      }),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([GOOD])
    expect(loaded.unreadable).toBe(false)
    expect(loaded).not.toHaveProperty('enabled')
    expect(loaded).not.toHaveProperty('settings')
  })

  test('an invalid root file does not fall back to .json or .opencode/, and still reports the shadowed file', () => {
    const { root, rootJsonc, rootJson, opencodeFile } = repo()
    fs.writeFileSync(rootJsonc, '{ broken')
    fs.writeFileSync(rootJson, body(GOOD))
    fs.writeFileSync(opencodeFile, body(OTHER))

    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([])
    expect(loaded.unreadable).toBe(true)
    expect(loaded.warnings.some((w) => w.includes(rootJsonc))).toBe(true)
    expect(loaded.warnings.some((w) => w.includes(opencodeFile))).toBe(true)
  })

  test('an oversized root file is unreadable and does not fall back to .opencode/', () => {
    const { root, rootJson, opencodeFile } = repo()
    const base = body(GOOD)
    fs.writeFileSync(
      rootJson,
      base + ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1 - base.length),
    )
    fs.writeFileSync(opencodeFile, body(OTHER))

    const loaded = loadProjectSearchSources(root)
    expect(loaded.unreadable).toBe(true)
    expect(loaded.sources).toEqual([])
  })

  test('a dropped entry is listed with its label and reason', () => {
    const { root, rootJson } = repo()
    fs.writeFileSync(
      rootJson,
      body(GOOD, { name: 'escape', format: 'markdown', roots: ['..'] }),
    )
    const loaded = loadProjectSearchSources(root)
    expect(loaded.sources).toEqual([GOOD])
    expect(loaded.dropped).toHaveLength(1)
    expect(loaded.dropped[0]?.label).toBe('"escape"')
    expect(loaded.dropped[0]?.reason).toEqual(expect.any(String))
  })
})
