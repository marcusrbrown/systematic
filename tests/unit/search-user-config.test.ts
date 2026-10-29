import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfigWithSources } from '../../src/lib/config.js'
import type { SearchSettings } from '../../src/lib/search-core.js'
import {
  formatSearchBlockWarning,
  loadUserLevelSearchSettings,
  mergeSearchSettings,
  resolveUserLevelConfigDirs,
  SearchSettingsSchema,
  type SearchSettingsSource,
  selectConfigFile,
  validateSearchBlock,
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

const EMBEDDINGS = {
  provider: 'ollama',
  base_url: 'http://localhost:11434',
  model: 'nomic-embed-text',
} as const

describe('SearchSettingsSchema', () => {
  test('accepts an empty block and a full block', () => {
    expect(SearchSettingsSchema.safeParse({}).success).toBe(true)
    const full = SearchSettingsSchema.safeParse({
      enabled: true,
      embeddings: {
        provider: 'openai-compatible',
        base_url: 'https://api.example.com/v1',
        model: 'text-embedding-3-small',
        dimensions: 512,
        api_key_env: 'EMBED_KEY_1',
        query_prefix: 'search_query: ',
        document_prefix: 'search_document: ',
        timeout_ms: 20_000,
      },
    })
    expect(full.success).toBe(true)
  })

  test('applies no defaults: a block with no timeout_ms parses to no timeout_ms', () => {
    const result = SearchSettingsSchema.safeParse({ embeddings: EMBEDDINGS })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Object.keys(result.data)).toEqual(['embeddings'])
    expect(Object.keys(result.data.embeddings ?? {}).sort()).toEqual([
      'base_url',
      'model',
      'provider',
    ])
    expect(SearchSettingsSchema.safeParse({}).data).toEqual({})
  })

  test('the parsed output is assignable to the core SearchSettings type', () => {
    const result = SearchSettingsSchema.safeParse({ embeddings: EMBEDDINGS })
    if (!result.success) throw new Error('expected success')
    // Compile-time check: a schema output must satisfy the core's type.
    const settings: SearchSettings = result.data
    expect(settings.embeddings?.model).toBe('nomic-embed-text')
  })

  test.each([
    ['unknown provider', { embeddings: { ...EMBEDDINGS, provider: 'cohere' } }],
    [
      'api_key_env 1BAD',
      { embeddings: { ...EMBEDDINGS, api_key_env: '1BAD' } },
    ],
    [
      'api_key_env with space',
      { embeddings: { ...EMBEDDINGS, api_key_env: 'A B' } },
    ],
    ['api_key_env $X', { embeddings: { ...EMBEDDINGS, api_key_env: '$X' } }],
    [
      'non-integer dimensions',
      { embeddings: { ...EMBEDDINGS, dimensions: 1.5 } },
    ],
    ['zero dimensions', { embeddings: { ...EMBEDDINGS, dimensions: 0 } }],
    ['timeout below 500', { embeddings: { ...EMBEDDINGS, timeout_ms: 499 } }],
    [
      'timeout above 60000',
      { embeddings: { ...EMBEDDINGS, timeout_ms: 60_001 } },
    ],
    [
      'non-integer timeout',
      { embeddings: { ...EMBEDDINGS, timeout_ms: 600.5 } },
    ],
    [
      'missing model',
      { embeddings: { provider: 'ollama', base_url: 'http://x' } },
    ],
    ['unknown key in search', { enabled: true, extra: 1 }],
    [
      'removed first_query_budget_ms',
      { embeddings: { ...EMBEDDINGS, first_query_budget_ms: 1000 } },
    ],
    ['null block', null],
    ['array block', []],
    ['string block', 'on'],
  ])('rejects %s', (_label, value) => {
    expect(SearchSettingsSchema.safeParse(value).success).toBe(false)
  })

  test('accepts the timeout bounds exactly', () => {
    for (const timeout_ms of [500, 60_000]) {
      expect(
        SearchSettingsSchema.safeParse({
          embeddings: { ...EMBEDDINGS, timeout_ms },
        }).success,
      ).toBe(true)
    }
  })
})

describe('validateSearchBlock', () => {
  test('names field paths and never a value', () => {
    const result = validateSearchBlock({
      embeddings: {
        ...EMBEDDINGS,
        base_url: 'https://user:hunter2@example.com/?token=abc',
        api_key_env: 'sk-secret value',
        timeout_ms: 5,
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields).toEqual([
      'search.embeddings.api_key_env',
      'search.embeddings.timeout_ms',
    ])
    const warning = formatSearchBlockWarning(
      '/tmp/systematic.json',
      result.fields,
    )
    expect(warning).toContain('embeddings.api_key_env')
    expect(warning).not.toContain('hunter2')
    expect(warning).not.toContain('sk-secret')
    expect(warning).not.toContain('token=abc')
  })

  test('an unknown key is reported against its parent, not by its name', () => {
    const result = validateSearchBlock({ ['secret-key-name']: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields).toEqual(['search'])
  })
})

describe('mergeSearchSettings', () => {
  const embeddingsA: SearchSettings['embeddings'] = {
    provider: 'ollama',
    base_url: 'http://a',
    model: 'a',
    timeout_ms: 1000,
    api_key_env: 'KEY_A',
  }
  const embeddingsB: SearchSettings['embeddings'] = {
    provider: 'openai-compatible',
    base_url: 'http://b',
    model: 'b',
  }
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
    expect(
      mergeSearchSettings([src({ enabled: true, embeddings: embeddingsA })]),
    ).toEqual({
      settings: { enabled: true, embeddings: embeddingsA },
      unreadable: false,
    })
  })

  test('custom only', () => {
    expect(mergeSearchSettings([src({ embeddings: embeddingsB })])).toEqual({
      settings: { embeddings: embeddingsB },
      unreadable: false,
    })
  })

  test('custom overrides user: enabled is last-defining, embeddings replaced whole', () => {
    const merged = mergeSearchSettings([
      src({ enabled: true, embeddings: embeddingsA }),
      src({ enabled: false, embeddings: embeddingsB }),
    ])
    expect(merged.settings?.enabled).toBe(false)
    // Replaced whole: nothing from A (timeout_ms, api_key_env) leaks in.
    expect(merged.settings?.embeddings).toEqual(embeddingsB)
    expect(merged.settings?.embeddings).not.toHaveProperty('timeout_ms')
    expect(merged.settings?.embeddings).not.toHaveProperty('api_key_env')
  })

  test('custom without enabled keeps the user enabled value, and vice versa for embeddings', () => {
    const merged = mergeSearchSettings([
      src({ enabled: false, embeddings: embeddingsA }),
      src({}),
    ])
    expect(merged.settings).toEqual({ enabled: false, embeddings: embeddingsA })
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

  test('an unreadable source flags the result and contributes no settings', () => {
    const merged = mergeSearchSettings([
      src(undefined, true),
      src({ embeddings: embeddingsB }),
    ])
    expect(merged.unreadable).toBe(true)
    expect(merged.settings).toEqual({ embeddings: embeddingsB })
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
      JSON.stringify({
        search: {
          enabled: true,
          embeddings: { ...EMBEDDINGS, timeout_ms: 900 },
        },
      }),
    )
    fs.writeFileSync(
      path.join(customConfigDir, 'systematic.json'),
      JSON.stringify({
        search: { embeddings: { ...EMBEDDINGS, model: 'custom-model' } },
      }),
    )
    const loaded = loadUserLevelSearchSettings({ homeDir, customConfigDir })
    expect(loaded.unreadable).toBe(false)
    expect(loaded.warnings).toEqual([])
    expect(loaded.settings?.enabled).toBe(true)
    expect(loaded.settings?.embeddings?.model).toBe('custom-model')
    expect(loaded.settings?.embeddings).not.toHaveProperty('timeout_ms')
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
      JSON.stringify({ search: { embeddings: EMBEDDINGS } }),
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
    ['timeout_ms', { ...EMBEDDINGS, timeout_ms: 10 }],
    ['provider', { ...EMBEDDINGS, provider: 'nope' }],
    ['api_key_env', { ...EMBEDDINGS, api_key_env: '1BAD' }],
  ])(
    'a bad %s drops the block with one warning and no value',
    (field, embeddings) => {
      const { homeDir, userConfigDir } = layout()
      fs.writeFileSync(
        path.join(userConfigDir, 'systematic.json'),
        JSON.stringify({ search: { embeddings } }),
      )
      const loaded = loadUserLevelSearchSettings({
        homeDir,
        customConfigDir: null,
      })
      expect(loaded.unreadable).toBe(true)
      expect(loaded.settings).toBeUndefined()
      expect(loaded.warnings).toHaveLength(1)
      expect(loaded.warnings[0]).toContain(`search.embeddings.${field}`)
      expect(loaded.warnings[0]).not.toContain('nope')
      expect(loaded.warnings[0]).not.toContain('1BAD')
    },
  )
})
