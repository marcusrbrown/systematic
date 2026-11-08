import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { SystematicConfigSchema } from '../../src/lib/config-schema.js'
import {
  type ConnectConfigOptions,
  checkHostSupport,
  containerRefusal,
  HOST_SUPPORT_TABLE,
  type HostSupportRow,
  loadConnectAllowList,
  MAX_ALLOW_PROJECT_LENGTH,
  MAX_ALLOW_PROJECTS,
  MAX_CONNECT_CONFIG_BYTES,
  resolveAllowEntry,
  resolveAllowList,
  resolveConnectConfigDirs,
  selectConnectConfigFiles,
  validateConnectBlock,
} from '../../src/lib/connect-config.js'
import {
  resolveUserLevelConfigDirs,
  selectUserLevelConfigFiles,
} from '../../src/lib/search-user-config.js'
import {
  cleanupTempDirs,
  createRepo,
  git,
  makeDir,
} from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

interface Dirs {
  readonly home: string
  readonly userDir: string
}

function setupDirs(): Dirs {
  const home = makeDir('connect-home-')
  const userDir = path.join(home, '.config/opencode')
  fs.mkdirSync(userDir, { recursive: true })
  return { home, userDir }
}

function writeConfig(dir: string, name: string, content: unknown): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content),
  )
  return file
}

function optionsFor(dirs: Dirs, customDir: string | null = null) {
  return {
    homeDir: dirs.home,
    userConfigDir: dirs.userDir,
    customConfigDir: customDir,
  } satisfies ConnectConfigOptions
}

function addWorktree(from: string, branch: string): string {
  const target = path.join(makeDir('connect-wt-'), 'wt')
  git(from, ['worktree', 'add', '-q', '-b', branch, target])
  return target
}

describe('loadConnectAllowList: reading', () => {
  it('returns an empty, readable list when no config file exists', () => {
    const dirs = setupDirs()
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(false)
    expect(load.warnings).toEqual([])
  })

  it('reads allow_projects from the user file', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/a', '/work/b'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual(['/work/a', '/work/b'])
    expect(load.unreadable).toBe(false)
  })

  it('merges the four user-level layers as a union in layer order and collapses duplicates', () => {
    const dirs = setupDirs()
    const customDir = path.join(dirs.home, 'custom')
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/a', '/work/b'] },
    })
    writeConfig(dirs.userDir, 'systematic.local.json', {
      connect: { allow_projects: ['/work/b', '/work/c'] },
    })
    writeConfig(customDir, 'systematic.json', {
      connect: { allow_projects: ['/work/d'] },
    })
    writeConfig(customDir, 'systematic.local.json', {
      connect: { allow_projects: ['/work/a', '/work/e'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.allowProjects).toEqual([
      '/work/a',
      '/work/b',
      '/work/c',
      '/work/d',
      '/work/e',
    ])
  })

  it('parses JSONC comments and trailing commas', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.jsonc',
      `{
        // the projects whose lessons may be searched
        "connect": { "allow_projects": ["/work/a",], },
      }`,
    )
    expect(loadConnectAllowList(optionsFor(dirs)).allowProjects).toEqual([
      '/work/a',
    ])
  })

  it('treats an empty connect block as readable and empty', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', { connect: {} })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(false)
  })

  it('selects .jsonc before .json, as the search reader does', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/json'] },
    })
    writeConfig(dirs.userDir, 'systematic.jsonc', {
      connect: { allow_projects: ['/work/jsonc'] },
    })
    expect(loadConnectAllowList(optionsFor(dirs)).allowProjects).toEqual([
      '/work/jsonc',
    ])
  })

  it('reads a local file whose sibling is absent', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.local.json', {
      connect: { allow_projects: ['/work/local'] },
    })
    expect(loadConnectAllowList(optionsFor(dirs)).allowProjects).toEqual([
      '/work/local',
    ])
  })

  it('reads a custom directory that is the user directory once', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/a'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, dirs.userDir))
    expect(load.allowProjects).toEqual(['/work/a'])
    expect(load.warnings).toEqual([])
  })

  it('never reads project config: a project file with a connect block adds nothing', () => {
    const dirs = setupDirs()
    const repo = createRepo()
    writeConfig(repo.work, '.systematic.json', {
      connect: { allow_projects: ['/work/evil'] },
    })
    writeConfig(path.join(repo.work, '.opencode'), 'systematic.json', {
      connect: { allow_projects: ['/work/evil'] },
    })
    const previous = process.cwd()
    process.chdir(repo.work)
    try {
      const load = loadConnectAllowList(optionsFor(dirs))
      expect(load.allowProjects).toEqual([])
    } finally {
      process.chdir(previous)
    }
  })
})

describe('loadConnectAllowList: fail closed', () => {
  it('an unknown key inside connect makes the block unreadable and the list empty', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/a'], allow_everything: true },
    })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(true)
    expect(load.warnings).toHaveLength(1)
  })

  it.each([
    ['connect is not an object', { connect: ['/work/a'] }],
    ['connect is null', { connect: null }],
    ['allow_projects is not an array', { connect: { allow_projects: '/a' } }],
    [
      'an entry is not a string',
      { connect: { allow_projects: ['/work/a', 7] } },
    ],
    ['an entry is empty', { connect: { allow_projects: ['/work/a', ''] } }],
    [
      'an entry is too long',
      {
        connect: {
          allow_projects: [
            '/work/a',
            `/${'x'.repeat(MAX_ALLOW_PROJECT_LENGTH)}`,
          ],
        },
      },
    ],
    [
      'the list is too long',
      {
        connect: {
          allow_projects: Array.from(
            { length: MAX_ALLOW_PROJECTS + 1 },
            (_, i) => `/work/p${i}`,
          ),
        },
      },
    ],
  ])(
    '%s: the whole block is unreadable and the list is empty',
    (_label, config) => {
      const dirs = setupDirs()
      writeConfig(dirs.userDir, 'systematic.json', config)
      const load = loadConnectAllowList(optionsFor(dirs))
      expect(load.allowProjects).toEqual([])
      expect(load.unreadable).toBe(true)
    },
  )

  it('accepts exactly the maximum number of entries', () => {
    const dirs = setupDirs()
    const entries = Array.from(
      { length: MAX_ALLOW_PROJECTS },
      (_, i) => `/work/p${i}`,
    )
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: entries },
    })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual(entries)
    expect(load.unreadable).toBe(false)
  })

  it.each([
    ['a JSONC parse error', '{ "connect": { "allow_projects": [ '],
    ['a root that is not an object', '["connect"]'],
    ['a root that is a string', '"connect"'],
  ])('%s yields an empty list and one warning', (_label, content) => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', content)
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(true)
    expect(load.warnings).toHaveLength(1)
  })

  it('an oversize user config yields an empty list', () => {
    const dirs = setupDirs()
    const padding = ' '.repeat(MAX_CONNECT_CONFIG_BYTES + 1)
    writeConfig(
      dirs.userDir,
      'systematic.json',
      `{ "connect": { "allow_projects": ["/work/a"] }, "x": "${padding}" }`,
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(true)
  })

  it('a directory where the config file should be yields an empty list', () => {
    const dirs = setupDirs()
    fs.mkdirSync(path.join(dirs.userDir, 'systematic.json'))
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(true)
  })

  it('a dangling .jsonc link is selected and fails closed rather than falling back to .json', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/fallback'] },
    })
    fs.symlinkSync(
      path.join(dirs.home, 'gone.jsonc'),
      path.join(dirs.userDir, 'systematic.jsonc'),
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.allowProjects).toEqual([])
    expect(load.unreadable).toBe(true)
  })

  it('a bad layer contributes nothing and never widens the list; a valid layer still contributes its own entries', () => {
    const dirs = setupDirs()
    const customDir = path.join(dirs.home, 'custom')
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/a'], bogus: 1 },
    })
    writeConfig(customDir, 'systematic.json', {
      connect: { allow_projects: ['/work/b'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.allowProjects).toEqual(['/work/b'])
    expect(load.unreadable).toBe(true)
  })

  it('never throws on hostile content', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      '{"connect":{"__proto__":{"allow_projects":["/x"]},"allow_projects":["/work/a"]}}',
    )
    expect(() => loadConnectAllowList(optionsFor(dirs))).not.toThrow()
    expect(loadConnectAllowList(optionsFor(dirs)).allowProjects).not.toContain(
      '/x',
    )
  })

  it('warnings never name an allow-list entry', () => {
    const dirs = setupDirs()
    const secret = '/work/secret-client-project'
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: [secret], bogus: true },
    })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.warnings.length).toBeGreaterThan(0)
    expect(load.warnings.join('\n')).not.toContain(secret)
    expect(load.warnings.join('\n')).not.toContain('secret-client-project')
  })
})

describe('loadConnectAllowList: custom config directory containment', () => {
  it('refuses a custom directory inside a checkout and ignores everything it holds', () => {
    const dirs = setupDirs()
    const repo = createRepo()
    const customDir = path.join(repo.work, '.config-here')
    writeConfig(customDir, 'systematic.json', {
      connect: { allow_projects: ['/work/from-custom'] },
    })
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/user'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.allowProjects).toEqual(['/work/user'])
    expect(load.customDirRefused).toBe('checkout')
    expect(load.warnings).toHaveLength(1)
    expect(load.warnings[0]).toContain('OPENCODE_CONFIG_DIR')
  })

  it('refuses a custom directory inside an allowed root without naming the root', () => {
    const dirs = setupDirs()
    const allowedRoot = path.join(makeDir('connect-allowed-'), 'client-acme')
    fs.mkdirSync(allowedRoot)
    const customDir = path.join(allowedRoot, 'cfg')
    writeConfig(customDir, 'systematic.json', {
      connect: { allow_projects: ['/work/from-custom'] },
    })
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: [allowedRoot] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.allowProjects).toEqual([allowedRoot])
    expect(load.customDirRefused).toBe('allowed-root')
    expect(load.warnings.join('\n')).not.toContain('client-acme')
    expect(load.warnings.join('\n')).not.toContain(allowedRoot)
  })

  it('accepts a custom directory outside every checkout and allowed root', () => {
    const dirs = setupDirs()
    const customDir = path.join(makeDir('connect-custom-'), 'cfg')
    writeConfig(customDir, 'systematic.json', {
      connect: { allow_projects: ['/work/from-custom'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.allowProjects).toEqual(['/work/from-custom'])
    expect(load.customDirRefused).toBeUndefined()
  })

  it('does not refuse a custom directory that is the user directory', () => {
    const dirs = setupDirs()
    fs.mkdirSync(path.join(dirs.home, '.git'))
    const load = loadConnectAllowList(optionsFor(dirs, dirs.userDir))
    expect(load.customDirRefused).toBeUndefined()
  })
})

describe('containerRefusal', () => {
  it('names a checkout among the ancestors, the directory itself included', () => {
    const repo = createRepo()
    expect(containerRefusal(path.join(repo.work, 'a/b'), [])).toBe('checkout')
    expect(containerRefusal(repo.work, [])).toBe('checkout')
  })

  it('names an allowed root among the ancestors, the root itself included', () => {
    const root = makeDir('connect-root-')
    expect(containerRefusal(path.join(root, 'state'), [root])).toBe(
      'allowed-root',
    )
    expect(containerRefusal(root, [root])).toBe('allowed-root')
  })

  it('does not treat a sibling with a shared name prefix as inside', () => {
    const parent = makeDir('connect-prefix-')
    const root = path.join(parent, 'app')
    const sibling = path.join(parent, 'app-state')
    fs.mkdirSync(root)
    fs.mkdirSync(sibling)
    expect(containerRefusal(sibling, [root])).toBeUndefined()
  })

  it('returns undefined for a plain directory outside any checkout', () => {
    expect(containerRefusal(makeDir('connect-plain-'), [])).toBeUndefined()
  })
})

describe('resolveAllowEntry', () => {
  it('resolves a repository root to its verified main root', () => {
    const repo = createRepo()
    const resolution = resolveAllowEntry(repo.work, {})
    expect(resolution).toEqual({
      status: 'resolved',
      entry: repo.work,
      mainRoot: repo.work,
    })
  })

  it('expands ~ against the home directory', () => {
    const home = makeDir('connect-home-')
    const repo = path.join(home, 'src/app')
    fs.mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    expect(resolveAllowEntry('~/src/app', { homeDir: home })).toEqual({
      status: 'resolved',
      entry: '~/src/app',
      mainRoot: fs.realpathSync(repo),
    })
  })

  it('resolves through a symlinked spelling of the root', () => {
    const repo = createRepo()
    const link = path.join(makeDir('connect-link-'), 'link')
    fs.symlinkSync(repo.work, link)
    const resolution = resolveAllowEntry(link, {})
    expect(resolution.status).toBe('resolved')
    if (resolution.status === 'resolved') {
      expect(resolution.mainRoot).toBe(repo.work)
    }
  })

  it('returns not-main-root for a subdirectory of a repository', () => {
    const repo = createRepo()
    const sub = path.join(repo.work, 'packages/inner')
    fs.mkdirSync(sub, { recursive: true })
    expect(resolveAllowEntry(sub, {})).toEqual({
      status: 'unmatched',
      entry: sub,
      reason: 'not-main-root',
    })
  })

  it('returns stale for a path that does not exist', () => {
    const missing = path.join(makeDir('connect-missing-'), 'gone')
    expect(resolveAllowEntry(missing, {})).toEqual({
      status: 'unmatched',
      entry: missing,
      reason: 'stale',
    })
  })

  it('returns stale when a path component is a file', () => {
    const dir = makeDir('connect-enotdir-')
    const file = path.join(dir, 'file')
    fs.writeFileSync(file, 'x')
    expect(resolveAllowEntry(path.join(file, 'child'), {})).toMatchObject({
      status: 'unmatched',
      reason: 'stale',
    })
  })

  it('returns not-a-repository for a directory outside any repository', () => {
    const dir = makeDir('connect-plain-')
    expect(resolveAllowEntry(dir, {})).toEqual({
      status: 'unmatched',
      entry: dir,
      reason: 'not-a-repository',
    })
  })

  it('returns not-a-repository for a file', () => {
    const dir = makeDir('connect-file-')
    const file = path.join(dir, 'file')
    fs.writeFileSync(file, 'x')
    expect(resolveAllowEntry(file, {})).toMatchObject({
      status: 'unmatched',
      reason: 'not-a-repository',
    })
  })

  it.each([
    ['a relative path', 'work/app'],
    ['a dot path', '.'],
    ['a ~user form', '~someone/app'],
  ])('returns not-absolute for %s', (_label, entry) => {
    expect(resolveAllowEntry(entry, { homeDir: makeDir() })).toEqual({
      status: 'unmatched',
      entry,
      reason: 'not-absolute',
    })
  })

  it('returns unreadable for a repository whose layout cannot be verified', () => {
    const dir = makeDir('connect-forged-')
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere/at/all\n')
    expect(resolveAllowEntry(dir, {})).toMatchObject({
      status: 'unmatched',
      reason: 'unreadable',
    })
  })

  it('a linked worktree path is not the main root', () => {
    const repo = createRepo()
    const worktree = addWorktree(repo.work, 'feature-x')
    expect(resolveAllowEntry(worktree, {})).toEqual({
      status: 'unmatched',
      entry: worktree,
      reason: 'not-main-root',
    })
    expect(resolveAllowEntry(repo.work, {})).toMatchObject({
      status: 'resolved',
      mainRoot: repo.work,
    })
  })

  it('a subdirectory of a linked worktree is not the main root', () => {
    const repo = createRepo()
    const worktree = addWorktree(repo.work, 'feature-y')
    const sub = path.join(worktree, 'deep')
    fs.mkdirSync(sub)
    expect(resolveAllowEntry(sub, {})).toMatchObject({
      reason: 'not-main-root',
    })
  })
})

describe('resolveAllowList', () => {
  it('splits resolved from unmatched entries and keeps the unmatched reason', () => {
    const repo = createRepo()
    const stale = path.join(makeDir('connect-missing-'), 'gone')
    const result = resolveAllowList([repo.work, stale], {})
    expect(result.resolved).toEqual([{ entry: repo.work, mainRoot: repo.work }])
    expect(result.unmatched).toEqual([{ entry: stale, reason: 'stale' }])
  })

  it('collapses two spellings of one project into the first', () => {
    const home = makeDir('connect-home-')
    const repo = path.join(home, 'app')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    const result = resolveAllowList(['~/app', repo, '~/app'], { homeDir: home })
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.entry).toBe('~/app')
    expect(result.unmatched).toEqual([])
  })

  it('returns two empty lists for an empty allow list', () => {
    expect(resolveAllowList([], {})).toEqual({ resolved: [], unmatched: [] })
  })
})

describe('layer discovery parity with the search reader', () => {
  const scenarios: ReadonlyArray<{
    readonly label: string
    readonly build: (dirs: Dirs) => ConnectConfigOptions
  }> = [
    {
      label: 'nothing on disk, no custom directory',
      build: (d) => optionsFor(d),
    },
    {
      label: 'user .json only',
      build: (d) => {
        writeConfig(d.userDir, 'systematic.json', {})
        return optionsFor(d)
      },
    },
    {
      label: 'user .jsonc and .json both present',
      build: (d) => {
        writeConfig(d.userDir, 'systematic.json', {})
        writeConfig(d.userDir, 'systematic.jsonc', {})
        return optionsFor(d)
      },
    },
    {
      label: 'local files only',
      build: (d) => {
        writeConfig(d.userDir, 'systematic.local.jsonc', {})
        return optionsFor(d)
      },
    },
    {
      label: 'a dangling .jsonc link next to a .json file',
      build: (d) => {
        writeConfig(d.userDir, 'systematic.json', {})
        fs.symlinkSync(
          path.join(d.home, 'gone.jsonc'),
          path.join(d.userDir, 'systematic.jsonc'),
        )
        return optionsFor(d)
      },
    },
    {
      label: 'a separate custom directory',
      build: (d) => {
        const custom = path.join(d.home, 'custom')
        writeConfig(custom, 'systematic.jsonc', {})
        writeConfig(custom, 'systematic.local.json', {})
        return optionsFor(d, custom)
      },
    },
    {
      label: 'a custom directory spelled as the user directory',
      build: (d) => optionsFor(d, d.userDir),
    },
    {
      label:
        'a custom directory reached through a symlink to the user directory',
      build: (d) => {
        const link = path.join(d.home, 'user-link')
        fs.symlinkSync(d.userDir, link)
        return optionsFor(d, link)
      },
    },
    {
      label: 'a blank custom directory',
      build: (d) => optionsFor(d, '   '),
    },
    {
      label: 'a custom directory with surrounding whitespace',
      build: (d) => {
        const custom = path.join(d.home, 'custom')
        fs.mkdirSync(custom)
        return optionsFor(d, `  ${custom}  `)
      },
    },
  ]

  for (const { label, build } of scenarios) {
    it(label, () => {
      const dirs = setupDirs()
      const options = build(dirs)
      expect(resolveConnectConfigDirs(options)).toEqual(
        resolveUserLevelConfigDirs(options),
      )
      expect(
        selectConnectConfigFiles(resolveConnectConfigDirs(options)),
      ).toEqual(selectUserLevelConfigFiles(resolveUserLevelConfigDirs(options)))
    })
  }

  it('reads OPENCODE_CONFIG_DIR when the option is left out, as the search reader does', () => {
    const dirs = setupDirs()
    const custom = path.join(dirs.home, 'env-custom')
    fs.mkdirSync(custom)
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = custom
    try {
      const options = { homeDir: dirs.home, userConfigDir: dirs.userDir }
      expect(resolveConnectConfigDirs(options)).toEqual(
        resolveUserLevelConfigDirs(options),
      )
      expect(resolveConnectConfigDirs(options).customConfigDir).toBe(custom)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })
})

describe('the zod schema and the reader agree on what a connect block is', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty block', {}],
    ['one entry', { allow_projects: ['/work/a'] }],
    ['an empty list', { allow_projects: [] }],
    ['an unknown key', { allow_projects: ['/work/a'], extra: 1 }],
    ['an empty entry', { allow_projects: [''] }],
    ['a non-string entry', { allow_projects: [1] }],
    ['a non-array list', { allow_projects: '/work/a' }],
    ['a null block', null],
    ['an array block', []],
    [
      'the maximum entries',
      {
        allow_projects: Array.from(
          { length: MAX_ALLOW_PROJECTS },
          (_, i) => `/p${i}`,
        ),
      },
    ],
    [
      'one entry too many',
      {
        allow_projects: Array.from(
          { length: MAX_ALLOW_PROJECTS + 1 },
          (_, i) => `/p${i}`,
        ),
      },
    ],
    [
      'the longest entry',
      { allow_projects: [`/${'x'.repeat(MAX_ALLOW_PROJECT_LENGTH - 1)}`] },
    ],
    [
      'an entry one too long',
      { allow_projects: [`/${'x'.repeat(MAX_ALLOW_PROJECT_LENGTH)}`] },
    ],
  ]

  it.each(cases)('%s', (_label, block) => {
    const zod = SystematicConfigSchema.safeParse({ connect: block })
    expect(validateConnectBlock(block).ok).toBe(zod.success)
  })
})

describe('checkHostSupport', () => {
  const row = (overrides: Partial<HostSupportRow> = {}): HostSupportRow => ({
    host: 'opencode-v1',
    version: '9999.19.5',
    observedBy: 'tests/integration/opencode-v1-isolation.test.ts',
    ...overrides,
  })

  it('lists a pair when no row names it, and the empty table lists nothing', () => {
    expect(checkHostSupport('opencode-v1', '9999.19.5', [])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
  })

  it('accepts a listed pair and returns the row that observed it', () => {
    const v1 = row()
    const table = [v1, row({ host: 'opencode-v2', version: '9999.22.5' })]
    expect(checkHostSupport('opencode-v1', '9999.19.5', table)).toEqual({
      supported: true,
      row: v1,
    })
    expect(checkHostSupport('opencode-v2', '9999.22.5', table)).toMatchObject({
      supported: true,
    })
  })

  it('tolerates a leading v and surrounding whitespace on the observed version', () => {
    const table = [row({ host: 'opencode-v2', version: '9999.22.5' })]
    expect(checkHostSupport('opencode-v2', 'v9999.22.5', table).supported).toBe(
      true,
    )
    expect(
      checkHostSupport('opencode-v2', ' 9999.22.5\n', table).supported,
    ).toBe(true)
  })

  it('rejects an unlisted host', () => {
    expect(checkHostSupport('pi', '1.4.0', [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
  })

  it.each([
    '9999.18.29',
    '9999.19.4',
    '9999.19.6',
    '9999.19.5-beta',
    '2.0.0',
    '9999.19',
  ])('rejects v1 version %s when only 9999.19.5 is listed', (version) => {
    expect(checkHostSupport('opencode-v1', version, [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
  })

  describe('build metadata', () => {
    const listed = row()
    const table = [listed]

    it.each([
      '9999.19.5+harness.bf7f7dfe',
      'v9999.19.5+harness.bf7f7dfe',
      ' 9999.19.5+build.1 ',
      '9999.19.5+a+b',
    ])('ignores everything from the first plus: %s matches', (version) => {
      expect(checkHostSupport('opencode-v1', version, table)).toEqual({
        supported: true,
        row: listed,
      })
    })

    it.each(['9999.19.5-rc.1', '9999.19.5-rc.1+build.7', '9999.19.6+build.1'])(
      'keeps a prerelease or another version significant: %s is unlisted',
      (version) => {
        expect(checkHostSupport('opencode-v1', version, table)).toEqual({
          supported: false,
          reason: 'unlisted',
        })
      },
    )

    it.each(['+', '+abc', 'v+abc', ' +harness '])(
      'treats %s, which has no version before the plus, as unobserved',
      (version) => {
        expect(checkHostSupport('opencode-v1', version, table)).toEqual({
          supported: false,
          reason: 'unobserved',
        })
      },
    )

    it('matches the installed fork build of the pinned release against the shipped v1 row', () => {
      const v1 = HOST_SUPPORT_TABLE.find(
        (entry) => entry.host === 'opencode-v1',
      )
      if (v1 === undefined) throw new Error('no shipped v1 row')
      expect(
        checkHostSupport('opencode-v1', `${v1.version}+harness.bf7f7dfe`)
          .supported,
      ).toBe(true)
      expect(
        checkHostSupport('opencode-v1', `${v1.version}-rc.1`).supported,
      ).toBe(false)
    })
  })

  it('rejects a version listed for another host', () => {
    expect(
      checkHostSupport('opencode-v2', '9999.19.5', [row()]).supported,
    ).toBe(false)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a non-string', 1.195],
  ])(
    'treats %s as an unobserved version and unsupported',
    (_label, version) => {
      expect(checkHostSupport('opencode-v1', version, [row()])).toEqual({
        supported: false,
        reason: 'unobserved',
      })
    },
  )

  it('treats an unknown host name as unsupported', () => {
    expect(checkHostSupport('vscode', '1.0.0', [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
    expect(checkHostSupport(undefined, '9999.19.5', [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
  })

  it.each([
    ['an empty observedBy', ''],
    ['a blank observedBy', '   '],
  ])('a row with %s never matches', (_label, observedBy) => {
    expect(
      checkHostSupport('opencode-v1', '9999.19.5', [row({ observedBy })]),
    ).toEqual({ supported: false, reason: 'unlisted' })
  })

  it('a row with no observedBy key at all never matches', () => {
    const bare = { host: 'opencode-v1', version: '9999.19.5' } as HostSupportRow
    expect(checkHostSupport('opencode-v1', '9999.19.5', [bare]).supported).toBe(
      false,
    )
  })
})

// A row is added only for a host and version where the shipped researcher's
// denies were seen on a real host. These tests keep each row tied to the pin the
// proof runs against and to a proof test that still exists under that title.
describe('the shipped host-support table', () => {
  const root = path.join(import.meta.dirname, '../..')
  const readJson = (file: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  const pins = readJson('scripts/opencode-host-pins.json') as {
    v1: string
    v2: string
    v1Floor: string
  }
  const piPin = (
    readJson('package.json').devDependencies as Record<string, string>
  )['@earendil-works/pi-coding-agent']

  it('has a row for OpenCode v1 and v2 at the current host pins, for Pi at its pinned version, and for Claude Code at the one version its manual run observed', () => {
    expect(
      HOST_SUPPORT_TABLE.map(
        (entry) => `${entry.host} ${entry.version}`,
      ).sort(),
    ).toEqual(
      [
        `opencode-v1 ${pins.v1}`,
        `opencode-v2 ${pins.v2}`,
        `pi ${piPin}`,
        'claude-code 2.1.319',
      ].sort(),
    )
  })

  it('reads the version the skill sends from what `claude --version` prints', () => {
    // The skill sends the first token that starts with a digit: `2.1.319`.
    const printed = '2.1.319 (Claude Code)'
    const sent = printed.split(/\s+/).find((token) => /^v?\d/.test(token))
    expect(sent).toBe('2.1.319')
    expect(checkHostSupport('claude-code', sent)).toMatchObject({
      supported: true,
      row: { host: 'claude-code', version: '2.1.319' },
    })
    // The whole line is not a version, and neither is a nearby release.
    expect(checkHostSupport('claude-code', printed).supported).toBe(false)
    expect(checkHostSupport('claude-code', '2.1.320').supported).toBe(false)
    expect(checkHostSupport('claude-code', '2.1.319-beta').supported).toBe(
      false,
    )
    expect(checkHostSupport('opencode-v1', '2.1.319').supported).toBe(false)
  })

  it('supports each listed pair and nothing next to it', () => {
    for (const entry of HOST_SUPPORT_TABLE) {
      expect(checkHostSupport(entry.host, entry.version)).toEqual({
        supported: true,
        row: entry,
      })
      expect(
        checkHostSupport(entry.host, `${entry.version}-beta`).supported,
      ).toBe(false)
    }
    // The old v1 floor and an older v1 patch were never observed.
    expect(checkHostSupport('opencode-v1', pins.v1Floor).supported).toBe(false)
    expect(checkHostSupport('opencode-v1', '1.19.4').supported).toBe(false)
    expect(checkHostSupport('claude-code', '2.1.312').supported).toBe(false)
    expect(checkHostSupport('claude-code', undefined)).toEqual({
      supported: false,
      reason: 'unobserved',
    })
  })

  const MANUAL_EVIDENCE_FILE = 'HARNESSES.md'

  /** The body of the HARNESSES.md entry with this id, when it exists and is manual evidence. */
  function manualEntry(id: string): string | undefined {
    const text = fs.readFileSync(path.join(root, MANUAL_EVIDENCE_FILE), 'utf8')
    const line = text
      .split('\n')
      .find((candidate) => candidate.startsWith(`- **${id}** — `))
    return line?.includes('Manual evidence') ? line : undefined
  }

  it('names, for every row, a test file and title that still exist, or a manual-evidence entry in HARNESSES.md', () => {
    for (const entry of HOST_SUPPORT_TABLE) {
      const [file, title, ...rest] = entry.observedBy.split(' > ')
      expect(rest).toEqual([])
      expect(file?.trim()).toBeTruthy()
      expect(title?.trim()).toBeTruthy()
      if (file === MANUAL_EVIDENCE_FILE) {
        expect(
          manualEntry(title ?? ''),
          `${MANUAL_EVIDENCE_FILE} has no manual-evidence entry ${title}`,
        ).toBeDefined()
        continue
      }
      const text = fs.readFileSync(path.join(root, file ?? ''), 'utf8')
      expect(
        text.includes(`'${title}'`) || text.includes(`"${title}"`),
        `${file} has no test titled ${title}`,
      ).toBe(true)
    }
  })

  it('allows a manual-evidence row only for a host whose proof cannot be an automated test, and only with a real entry', () => {
    const manual = HOST_SUPPORT_TABLE.filter((entry) =>
      entry.observedBy.startsWith(`${MANUAL_EVIDENCE_FILE} > `),
    )
    expect(manual.map((entry) => entry.host)).toEqual(['claude-code'])
    for (const entry of manual) {
      const id = entry.observedBy.split(' > ')[1] ?? ''
      const body = manualEntry(id) ?? ''
      // The entry records the exact version the row lists, and a verdict.
      expect(body).toContain(entry.version)
      expect(body).toContain('PASS')
    }
    // An entry id that does not exist, or one that is not manual evidence, is not accepted.
    expect(manualEntry('CN-999')).toBeUndefined()
    expect(manualEntry('CN-1')).toBeUndefined()
  })

  it('names a different proof test for each host', () => {
    const named = HOST_SUPPORT_TABLE.map((entry) => entry.observedBy)
    expect(new Set(named).size).toBe(named.length)
  })
})

describe('bundle safety', () => {
  it('bundles without zod, config.ts or config-schema.ts and inlines jsonc-parser', async () => {
    const result = await Bun.build({
      entrypoints: [
        path.join(import.meta.dirname, '../../src/lib/connect-config.ts'),
      ],
      target: 'node',
    })
    expect(result.success).toBe(true)
    const text = (
      await Promise.all(result.outputs.map((output) => output.text()))
    ).join('\n')
    expect(text).not.toMatch(/zod/i)
    expect(text).not.toContain('SystematicConfigSchema')
    expect(text).not.toContain('loadConfigWithSources')
    expect(text).not.toMatch(/from ["']jsonc-parser["']/)
    expect(text).toContain('createScanner')
  })
})
