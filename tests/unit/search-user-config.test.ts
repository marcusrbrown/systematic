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

describe('validateSearchBlock', () => {
  test('names field paths and never a value', () => {
    const result = validateSearchBlock({ enabled: 'hunter2-secret' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields).toEqual(['search.enabled'])
    const warning = formatSearchBlockWarning(
      '/tmp/systematic.json',
      result.fields,
    )
    expect(warning).toContain('search.enabled')
    expect(warning).not.toContain('hunter2')
  })

  test('an unknown key is reported against its parent, not by its name', () => {
    const result = validateSearchBlock({ 'secret-key-name': 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields).toEqual(['search'])
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
