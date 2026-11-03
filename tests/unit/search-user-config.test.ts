import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { loadConfigWithSources } from '../../src/lib/config.js'
import type { SearchSettings } from '../../src/lib/search-core.js'
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
  validateSearchConfig,
} from '../../src/lib/search-user-config.js'
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
    for (const key of ['name', 'format', 'roots', 'projects']) {
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
    expect(mergeSearchSettings([])).toEqual({
      settings: undefined,
      unreadable: false,
    })
  })

  test('user only', () => {
    expect(mergeSearchSettings([src({ enabled: true })])).toEqual({
      settings: { enabled: true },
      unreadable: false,
    })
  })

  test('an empty block contributes no settings', () => {
    expect(mergeSearchSettings([src({})])).toEqual({
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
    expect(mergeSearchSettings([src({ enabled: false })])).toEqual({
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
    expect(mergeSearchSettings([src(undefined, true)])).toEqual({
      settings: undefined,
      unreadable: true,
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
    ).toEqual({ settings: undefined, warnings: [], unreadable: false })
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

  test('a trailing comma is a parse error, exactly as in the loader: unreadable, one warning, no values', () => {
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
    expect(loaded.unreadable).toBe(true)
    expect(loaded.settings).toBeUndefined()
    expect(loaded.warnings).toHaveLength(1)

    // The loader rejects the same file (unchanged); the reader mirrors that
    // as unreadable instead of throwing.
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    expect(() =>
      loadConfigWithSources(projectDir, {
        homeDir,
        customConfigDir: null,
        warningSink: () => {},
      }),
    ).toThrow(/JSONC parse error/)
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
      ).toEqual({ settings: undefined, warnings: [], unreadable: false })
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
