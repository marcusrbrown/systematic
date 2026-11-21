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
  type KnownBadHostVersion,
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

describe('loadConnectAllowList: groups', () => {
  const groupsOf = (groups: unknown, allow: string[] = ['/work/a']) => ({
    connect: { allow_projects: allow, groups },
  })

  it('reads a group of project paths under its name', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ 'harness-tools': ['~/a', '~/b'] }),
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.groups).toEqual({ 'harness-tools': ['~/a', '~/b'] })
    expect(load.unreadable).toBe(false)
    expect(load.allowProjects).toEqual(['/work/a'])
  })

  it('reports no groups when none are written', () => {
    const dirs = setupDirs()
    expect(loadConnectAllowList(optionsFor(dirs)).groups).toEqual({})
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/a'] },
    })
    expect(loadConnectAllowList(optionsFor(dirs)).groups).toEqual({})
  })

  it('does not require the group members to be on the allow list', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ team: ['/elsewhere/x'] }),
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.groups).toEqual({ team: ['/elsewhere/x'] })
    expect(load.unreadable).toBe(false)
  })

  it('a later layer replaces a same-named group whole; other groups survive', () => {
    const dirs = setupDirs()
    const customDir = path.join(dirs.home, 'custom')
    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ x: ['/work/1', '/work/2'], early: ['/work/3'] }),
    )
    writeConfig(
      dirs.userDir,
      'systematic.local.json',
      groupsOf({ x: ['/work/4'] }, []),
    )
    writeConfig(customDir, 'systematic.json', groupsOf({ y: ['/work/5'] }, []))
    writeConfig(
      customDir,
      'systematic.local.json',
      groupsOf({ y: ['/work/6', '/work/7'] }, []),
    )
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.groups).toEqual({
      x: ['/work/4'],
      early: ['/work/3'],
      y: ['/work/6', '/work/7'],
    })
  })

  it('keeps the earlier layer group when the later layer does not define it', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ keep: ['/work/1'] }),
    )
    writeConfig(dirs.userDir, 'systematic.local.json', groupsOf({}, []))
    expect(loadConnectAllowList(optionsFor(dirs)).groups).toEqual({
      keep: ['/work/1'],
    })
  })

  it('accepts exactly 32 groups and refuses 33', () => {
    const dirs = setupDirs()
    const make = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`g${i}`, ['/work/a']]),
      )
    writeConfig(dirs.userDir, 'systematic.json', groupsOf(make(32)))
    const ok = loadConnectAllowList(optionsFor(dirs))
    expect(Object.keys(ok.groups)).toHaveLength(32)
    expect(ok.unreadable).toBe(false)

    writeConfig(dirs.userDir, 'systematic.json', groupsOf(make(33)))
    const bad = loadConnectAllowList(optionsFor(dirs))
    expect(bad.groups).toEqual({})
    expect(bad.allowProjects).toEqual([])
    expect(bad.unreadable).toBe(true)
  })

  it('accepts a group of exactly the maximum members and refuses one more', () => {
    const dirs = setupDirs()
    const members = (count: number) =>
      Array.from({ length: count }, (_, i) => `/work/p${i}`)
    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ big: members(64) }, []),
    )
    const ok = loadConnectAllowList(optionsFor(dirs))
    expect(ok.groups.big).toHaveLength(64)
    expect(ok.unreadable).toBe(false)

    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ big: members(65) }, []),
    )
    const bad = loadConnectAllowList(optionsFor(dirs))
    expect(bad.groups).toEqual({})
    expect(bad.unreadable).toBe(true)
  })

  it.each([
    ['a', true],
    ['a-b', true],
    ['9-lives', true],
    ['constructor', true],
    ['x'.repeat(64), true],
    ['A_b', false],
    ['Upper', false],
    ['a_b', false],
    ['-leading', false],
    ['', false],
    ['x'.repeat(65), false],
    ['has space', false],
  ])('the group name %j is accepted: %p', (name, accepted) => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { groups: { [name]: ['/work/a'] } },
    })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.unreadable).toBe(!accepted)
    expect(Object.hasOwn(load.groups, name)).toBe(accepted)
  })

  it('a __proto__ key in groups never becomes a group or changes the record', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      '{"connect":{"groups":{"__proto__":["/work/evil"],"team":["/work/a"]}}}',
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(Object.hasOwn(load.groups, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(load.groups)).toBe(Object.prototype)
    expect(Object.keys(load.groups)).not.toContain('__proto__')
    expect(JSON.stringify(load.groups)).not.toContain('/work/evil')
  })

  it('refuses a group with no members', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', groupsOf({ empty: [] }))
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.unreadable).toBe(true)
    expect(load.groups).toEqual({})
  })

  it.each([
    ['groups is an array', [['/work/a']]],
    ['groups is a string', 'team'],
    ['groups is null', null],
    ['a member list is not an array', { team: '/work/a' }],
    ['a member is not a string', { team: ['/work/a', 7] }],
    ['a member is empty', { team: ['/work/a', ''] }],
    [
      'a member is too long',
      { team: [`/${'x'.repeat(MAX_ALLOW_PROJECT_LENGTH)}`] },
    ],
  ])(
    '%s: the whole layer is unreadable, its allow list too, and other layers are unaffected',
    (_label, groups) => {
      const dirs = setupDirs()
      const customDir = path.join(dirs.home, 'custom')
      writeConfig(
        dirs.userDir,
        'systematic.json',
        groupsOf(groups, ['/work/a']),
      )
      writeConfig(customDir, 'systematic.json', {
        connect: { allow_projects: ['/work/b'], groups: { ok: ['/work/b'] } },
      })
      const load = loadConnectAllowList(optionsFor(dirs, customDir))
      expect(load.unreadable).toBe(true)
      expect(load.allowProjects).toEqual(['/work/b'])
      expect(load.groups).toEqual({ ok: ['/work/b'] })
      expect(load.warnings).toHaveLength(1)
    },
  )

  it('warnings never name a group or its members', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      groupsOf({ 'secret-client': ['/work/secret-client'], bad: [] }),
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.warnings.length).toBeGreaterThan(0)
    expect(load.warnings.join('\n')).not.toContain('secret-client')
  })

  it('never reads groups from a project file', () => {
    const dirs = setupDirs()
    const repo = createRepo()
    writeConfig(path.join(repo.work, '.opencode'), 'systematic.json', {
      connect: { groups: { evil: ['/work/evil'] } },
    })
    const previous = process.cwd()
    process.chdir(repo.work)
    try {
      expect(loadConnectAllowList(optionsFor(dirs)).groups).toEqual({})
    } finally {
      process.chdir(previous)
    }
  })
})

describe('loadConnectAllowList: pins', () => {
  const pinsOf = (pins: unknown, allow: string[] = ['/work/app']) => ({
    connect: { allow_projects: allow, pins },
  })

  it('reports no pins when none are written, with or without a block', () => {
    const dirs = setupDirs()
    expect(loadConnectAllowList(optionsFor(dirs)).pins).toEqual([])
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: { allow_projects: ['/work/app'] },
    })
    expect(loadConnectAllowList(optionsFor(dirs)).pins).toEqual([])
  })

  it('reads the pins of the user file beside the allow list', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', pinsOf([pin()]))
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.pins).toEqual([pin()])
    expect(load.allowProjects).toEqual(['/work/app'])
    expect(load.unreadable).toBe(false)
    expect(load.warnings).toEqual([])
  })

  it('returns the pins of every readable layer in layer order', () => {
    const dirs = setupDirs()
    const customDir = path.join(dirs.home, 'custom')
    writeConfig(
      dirs.userDir,
      'systematic.json',
      pinsOf([pin({ key: 'k.user' })]),
    )
    writeConfig(
      dirs.userDir,
      'systematic.local.json',
      pinsOf([pin({ key: 'k.local' })], []),
    )
    writeConfig(
      customDir,
      'systematic.json',
      pinsOf([pin({ key: 'k.custom' })], []),
    )
    writeConfig(
      customDir,
      'systematic.local.json',
      pinsOf([pin({ key: 'k.custom-local' })], []),
    )
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.pins.map((entry) => entry.key)).toEqual([
      'k.user',
      'k.local',
      'k.custom',
      'k.custom-local',
    ])
  })

  it('collapses the same pin written twice in one layer and across layers', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', pinsOf([pin(), pin()]))
    writeConfig(dirs.userDir, 'systematic.local.json', pinsOf([pin()], []))
    expect(loadConnectAllowList(optionsFor(dirs)).pins).toEqual([pin()])
  })

  it('does not collapse pins that differ in any one of the four values', () => {
    const dirs = setupDirs()
    const variants = [
      pin(),
      pin({ project: '/work/other' }),
      pin({ upstream: 'anomalyco/other' }),
      pin({ file: 'deps.json' }),
      pin({ key: 'other.key' }),
    ]
    writeConfig(dirs.userDir, 'systematic.json', pinsOf(variants))
    expect(loadConnectAllowList(optionsFor(dirs)).pins).toEqual(variants)
  })

  it('keeps two pins that share project, upstream and key but name different files: conflicts are decided later', () => {
    const dirs = setupDirs()
    const first = pin({ file: 'a.json' })
    const second = pin({ file: 'b.json' })
    writeConfig(dirs.userDir, 'systematic.json', pinsOf([first]))
    writeConfig(dirs.userDir, 'systematic.local.json', pinsOf([second], []))
    expect(loadConnectAllowList(optionsFor(dirs)).pins).toEqual([first, second])
  })

  it('accepts a pin whose project is not on the allow list, and does not widen the list', () => {
    const dirs = setupDirs()
    writeConfig(
      dirs.userDir,
      'systematic.json',
      pinsOf([pin({ project: '/not/allowed' })], ['/work/app']),
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.pins).toEqual([pin({ project: '/not/allowed' })])
    expect(load.allowProjects).toEqual(['/work/app'])
    expect(load.groups).toEqual({})
    expect(load.unreadable).toBe(false)
  })

  it('a layer with one bad pin among good ones contributes nothing of any kind, and the warning names the file but no pin', () => {
    const dirs = setupDirs()
    const secret = '/work/secret-client'
    writeConfig(dirs.userDir, 'systematic.json', {
      connect: {
        allow_projects: [secret],
        groups: { team: [secret] },
        pins: [
          pin({ project: secret, key: 'good.one' }),
          pin({ project: secret, file: '../escape' }),
        ],
      },
    })
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.pins).toEqual([])
    expect(load.allowProjects).toEqual([])
    expect(load.groups).toEqual({})
    expect(load.unreadable).toBe(true)
    expect(load.warnings).toHaveLength(1)
    const warning = load.warnings.join('\n')
    expect(warning).toContain('systematic.json')
    for (const leaked of [
      secret,
      'secret-client',
      'escape',
      'good.one',
      'anomalyco',
    ]) {
      expect(warning).not.toContain(leaked)
    }
  })

  it('a failing layer drops only its own pins; the other layers still contribute', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', pinsOf([pin({ key: 'kept' })]))
    writeConfig(
      dirs.userDir,
      'systematic.local.json',
      pinsOf([pin({ key: 'lost' }), { project: '/p' }], []),
    )
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.pins.map((entry) => entry.key)).toEqual(['kept'])
    expect(load.unreadable).toBe(true)
  })

  it('a block with pins as an object is unreadable and yields no pins', () => {
    const dirs = setupDirs()
    writeConfig(dirs.userDir, 'systematic.json', pinsOf(pin()))
    const load = loadConnectAllowList(optionsFor(dirs))
    expect(load.pins).toEqual([])
    expect(load.unreadable).toBe(true)
  })

  it('the pins of a refused custom directory are not read', () => {
    const dirs = setupDirs()
    const repo = createRepo()
    const customDir = path.join(repo.work, '.config-here')
    writeConfig(customDir, 'systematic.json', pinsOf([pin({ key: 'custom' })]))
    writeConfig(dirs.userDir, 'systematic.json', pinsOf([pin({ key: 'user' })]))
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.customDirRefused).toBe('checkout')
    expect(load.pins.map((entry) => entry.key)).toEqual(['user'])
  })
})

describe('validateConnectBlock: groups', () => {
  it('returns the validated groups beside the allow list', () => {
    const result = validateConnectBlock({
      allow_projects: ['/work/a'],
      groups: { team: ['/work/a'] },
    })
    expect(result).toEqual({
      ok: true,
      allowProjects: ['/work/a'],
      groups: { team: ['/work/a'] },
      pins: [],
    })
  })

  it('returns an empty group record when none is written', () => {
    expect(validateConnectBlock({})).toEqual({
      ok: true,
      allowProjects: [],
      groups: {},
      pins: [],
    })
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

  it('accepts a custom directory below a directory that holds only an empty .git directory', () => {
    const dirs = setupDirs()
    const base = makeDir('connect-custom-emptygit-')
    fs.mkdirSync(path.join(base, '.git'))
    const customDir = path.join(base, 'cfg')
    writeConfig(customDir, 'systematic.json', {
      connect: { allow_projects: ['/work/from-custom'] },
    })
    const load = loadConnectAllowList(optionsFor(dirs, customDir))
    expect(load.allowProjects).toEqual(['/work/from-custom'])
    expect(load.customDirRefused).toBeUndefined()
  })

  it('refuses a custom directory below a .git directory that holds a HEAD, and below a .git file', () => {
    const dirs = setupDirs()
    for (const make of [
      (git: string) => {
        fs.mkdirSync(git)
        fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n')
      },
      (git: string) => fs.writeFileSync(git, 'gitdir: /elsewhere\n'),
    ]) {
      const base = makeDir('connect-custom-realgit-')
      make(path.join(base, '.git'))
      const customDir = path.join(base, 'cfg')
      writeConfig(customDir, 'systematic.json', {
        connect: { allow_projects: ['/work/from-custom'] },
      })
      const load = loadConnectAllowList(optionsFor(dirs, customDir))
      expect(load.allowProjects).toEqual([])
      expect(load.customDirRefused).toBe('checkout')
    }
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

describe('containerRefusal: which .git entries make a checkout', () => {
  /** A directory with a `.git` entry made by `make`, and a state directory below it. */
  function below(make: (gitPath: string, base: string) => void): string {
    const base = makeDir('connect-gitkind-')
    make(path.join(base, '.git'), base)
    const state = path.join(base, 'ws', 'state')
    fs.mkdirSync(state, { recursive: true })
    return state
  }

  it('does not count an empty .git directory', () => {
    const state = below((git) => fs.mkdirSync(git))
    expect(containerRefusal(state, [])).toBeUndefined()
  })

  it('does not count a .git directory that holds no HEAD', () => {
    const state = below((git) => {
      fs.mkdirSync(path.join(git, 'refs'), { recursive: true })
      fs.writeFileSync(path.join(git, 'config'), '[core]\n')
    })
    expect(containerRefusal(state, [])).toBeUndefined()
  })

  it('does not count an empty .git directory in the directory itself', () => {
    const base = makeDir('connect-gitkind-')
    fs.mkdirSync(path.join(base, '.git'))
    expect(containerRefusal(base, [])).toBeUndefined()
  })

  it('counts a .git directory that holds a HEAD', () => {
    const state = below((git) => {
      fs.mkdirSync(git)
      fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n')
    })
    expect(containerRefusal(state, [])).toBe('checkout')
  })

  it('counts a .git file that points at a git directory', () => {
    const state = below((git, base) => {
      fs.writeFileSync(git, `gitdir: ${path.join(base, 'elsewhere')}\n`)
    })
    expect(containerRefusal(state, [])).toBe('checkout')
  })

  it('counts a .git symlink, whether it leads to an empty directory or nowhere', () => {
    const toEmpty = below((git, base) => {
      fs.mkdirSync(path.join(base, 'empty'))
      fs.symlinkSync(path.join(base, 'empty'), git)
    })
    expect(containerRefusal(toEmpty, [])).toBe('checkout')
    const dangling = below((git, base) => {
      fs.symlinkSync(path.join(base, 'nowhere'), git)
    })
    expect(containerRefusal(dangling, [])).toBe('checkout')
  })

  it('still refuses when a real repository encloses a directory with an empty .git', () => {
    const repo = createRepo()
    const inner = path.join(repo.work, 'ws')
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true })
    expect(containerRefusal(path.join(inner, 'state'), [])).toBe('checkout')
  })

  it('treats an allow entry below a directory with an empty .git as no repository, not a nested one', () => {
    const base = makeDir('connect-gitkind-')
    fs.mkdirSync(path.join(base, '.git'))
    const entry = path.join(base, 'plain')
    fs.mkdirSync(entry)
    expect(resolveAllowEntry(entry, {})).toEqual({
      status: 'unmatched',
      entry,
      reason: 'not-a-repository',
    })
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

  it('carries each later spelling of a project as an alias of the kept entry, once', () => {
    const home = makeDir('connect-home-')
    const repo = path.join(home, 'app')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    const other = createRepo()
    const result = resolveAllowList(
      ['~/app', repo, '~/app', other.work, `${home}/./app`],
      { homeDir: home },
    )
    expect(result.resolved).toEqual([
      {
        entry: '~/app',
        mainRoot: fs.realpathSync(repo),
        aliases: [repo, `${home}/./app`],
      },
      { entry: other.work, mainRoot: other.work },
    ])
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

const pin = (overrides: Record<string, unknown> = {}) => ({
  project: '/work/app',
  upstream: 'anomalyco/opencode',
  file: 'package.json',
  key: 'dependencies.opencode',
  ...overrides,
})

/** The limits are written out here so that a changed constant fails a test. */
const pinCases: ReadonlyArray<readonly [string, unknown, boolean]> = [
  ['one valid pin', { pins: [pin()] }, true],
  ['an empty pins list', { pins: [] }, true],
  [
    'pins beside an allow list and groups',
    {
      allow_projects: ['/work/app'],
      groups: { t: ['/work/app'] },
      pins: [pin()],
    },
    true,
  ],
  [
    'a project written as a home path',
    { pins: [pin({ project: '~/src/app' })] },
    true,
  ],
  [
    'a project that is not on any allow list',
    { pins: [pin({ project: '/elsewhere/x' })] },
    true,
  ],
  [
    'a project with a control character, as an allow-list entry may have',
    { pins: [pin({ project: '/work/a\nb' })] },
    true,
  ],
  [
    'a mixed-case upstream',
    { pins: [pin({ upstream: 'AnomalyCo/OpenCode' })] },
    true,
  ],
  [
    'a nested file path',
    { pins: [pin({ file: 'packages/app/deps.jsonc' })] },
    true,
  ],
  ['a dotfile', { pins: [pin({ file: '.opencode/version.json' })] }, true],
  [
    'a file segment that only starts with two dots',
    { pins: [pin({ file: 'a/..b/c.json' })] },
    true,
  ],
  ['a single-segment key', { pins: [pin({ key: 'version' })] }, true],
  [
    'a key with spaces inside a segment',
    { pins: [pin({ key: 'a b.c' })] },
    true,
  ],
  [
    'the maximum pins',
    { pins: Array.from({ length: 64 }, (_, i) => pin({ key: `k${i}` })) },
    true,
  ],
  [
    'one pin too many',
    { pins: Array.from({ length: 65 }, (_, i) => pin({ key: `k${i}` })) },
    false,
  ],
  [
    'the longest project',
    { pins: [pin({ project: `/${'x'.repeat(4095)}` })] },
    true,
  ],
  [
    'a project one too long',
    { pins: [pin({ project: `/${'x'.repeat(4096)}` })] },
    false,
  ],
  ['the longest file', { pins: [pin({ file: 'x'.repeat(256) })] }, true],
  ['a file one too long', { pins: [pin({ file: 'x'.repeat(257) })] }, false],
  ['the longest key', { pins: [pin({ key: 'x'.repeat(256) })] }, true],
  ['a key one too long', { pins: [pin({ key: 'x'.repeat(257) })] }, false],
  ['pins as an object', { pins: pin() }, false],
  ['pins as null', { pins: null }, false],
  ['pins as a string', { pins: 'x' }, false],
  ['a null pin', { pins: [null] }, false],
  ['a string pin', { pins: ['/work/app'] }, false],
  ['an array pin', { pins: [[]] }, false],
  ['a pin with an extra key', { pins: [pin({ extra: 1 })] }, false],
  [
    'a pin with no project',
    { pins: [{ upstream: 'a/b', file: 'f.json', key: 'k' }] },
    false,
  ],
  [
    'a pin with no upstream',
    { pins: [{ project: '/p', file: 'f.json', key: 'k' }] },
    false,
  ],
  [
    'a pin with no file',
    { pins: [{ project: '/p', upstream: 'a/b', key: 'k' }] },
    false,
  ],
  [
    'a pin with no key',
    { pins: [{ project: '/p', upstream: 'a/b', file: 'f.json' }] },
    false,
  ],
  ['an empty project', { pins: [pin({ project: '' })] }, false],
  ['an empty upstream', { pins: [pin({ upstream: '' })] }, false],
  ['an empty file', { pins: [pin({ file: '' })] }, false],
  ['an empty key', { pins: [pin({ key: '' })] }, false],
  ['a non-string project', { pins: [pin({ project: 1 })] }, false],
  ['a non-string upstream', { pins: [pin({ upstream: ['a/b'] })] }, false],
  ['a non-string file', { pins: [pin({ file: 1 })] }, false],
  ['a non-string key', { pins: [pin({ key: ['a'] })] }, false],
  [
    'an upstream with no slash',
    { pins: [pin({ upstream: 'opencode' })] },
    false,
  ],
  [
    'an upstream with extra segments',
    { pins: [pin({ upstream: 'a/b/c' })] },
    false,
  ],
  [
    'an upstream with an empty owner',
    { pins: [pin({ upstream: '/b' })] },
    false,
  ],
  [
    'an upstream with an empty repo',
    { pins: [pin({ upstream: 'a/' })] },
    false,
  ],
  [
    'an upstream that is a URL',
    { pins: [pin({ upstream: 'https://github.com/a/b' })] },
    false,
  ],
  ['an upstream with a space', { pins: [pin({ upstream: 'a/b c' })] }, false],
  [
    'an upstream with a control character',
    { pins: [pin({ upstream: 'a/b\n' })] },
    false,
  ],
  [
    'an upstream repo of two dots',
    { pins: [pin({ upstream: 'a/..' })] },
    false,
  ],
  [
    'a file with a dot-dot segment',
    { pins: [pin({ file: '../x.json' })] },
    false,
  ],
  [
    'a file with a dot-dot segment in the middle',
    { pins: [pin({ file: 'a/../x.json' })] },
    false,
  ],
  [
    'a file ending in a dot-dot segment',
    { pins: [pin({ file: 'a/..' })] },
    false,
  ],
  ['a file that is only dot-dot', { pins: [pin({ file: '..' })] }, false],
  ['an absolute file', { pins: [pin({ file: '/etc/passwd' })] }, false],
  ['a file with a space', { pins: [pin({ file: 'a b.json' })] }, false],
  ['a file with a backslash', { pins: [pin({ file: 'a\\b.json' })] }, false],
  [
    'a file with a non-ASCII character',
    { pins: [pin({ file: 'caf\u00e9.json' })] },
    false,
  ],
  [
    'a file with a control character',
    { pins: [pin({ file: 'a\u0000.json' })] },
    false,
  ],
  ['a file with a newline', { pins: [pin({ file: 'a\n.json' })] }, false],
  ['a key with an empty first segment', { pins: [pin({ key: '.a' })] }, false],
  [
    'a key with an empty middle segment',
    { pins: [pin({ key: 'a..b' })] },
    false,
  ],
  ['a key with an empty last segment', { pins: [pin({ key: 'a.' })] }, false],
  ['a key that is only a dot', { pins: [pin({ key: '.' })] }, false],
  ['a key with a newline', { pins: [pin({ key: 'a\nb' })] }, false],
  ['a key with a NUL', { pins: [pin({ key: 'a\u0000b' })] }, false],
  ['a key with a tab', { pins: [pin({ key: 'a\tb' })] }, false],
  ['a key with DEL', { pins: [pin({ key: 'a\u007fb' })] }, false],
  ['a key with a C1 control', { pins: [pin({ key: 'a\u0085b' })] }, false],
  [
    'one bad pin among good ones',
    { pins: [pin(), pin({ file: '../x' }), pin({ key: 'k2' })] },
    false,
  ],
]

const pinParityCases: ReadonlyArray<readonly [string, unknown]> = pinCases.map(
  ([label, block]) => [`pins: ${label}`, block] as const,
)

describe('validateConnectBlock: pins', () => {
  it.each(pinCases)('%s', (_label, block, accepted) => {
    expect(validateConnectBlock(block).ok).toBe(accepted)
  })

  it('returns the validated pins beside the allow list and groups', () => {
    const result = validateConnectBlock({
      allow_projects: ['/work/app'],
      pins: [pin()],
    })
    expect(result).toEqual({
      ok: true,
      allowProjects: ['/work/app'],
      groups: {},
      pins: [pin()],
    })
  })

  it('returns an empty pin list when none is written', () => {
    const result = validateConnectBlock({ allow_projects: ['/work/app'] })
    expect(result.ok && result.pins).toEqual([])
  })

  it('does not alias the caller input', () => {
    const block = { pins: [pin()] }
    const result = validateConnectBlock(block)
    expect(result.ok && result.pins[0]).not.toBe(block.pins[0])
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
    ['groups alone', { groups: { team: ['/work/a'] } }],
    [
      'groups beside an allow list',
      { allow_projects: ['/a'], groups: { t: ['/a'] } },
    ],
    ['an empty groups record', { groups: {} }],
    ['groups as an array', { groups: [['/a']] }],
    ['groups as null', { groups: null }],
    ['groups as a string', { groups: 'team' }],
    ['a group with no members', { groups: { team: [] } }],
    ['a non-array group', { groups: { team: '/a' } }],
    ['a non-string member', { groups: { team: [1] } }],
    ['an empty member', { groups: { team: [''] } }],
    [
      'the longest member',
      { groups: { team: [`/${'x'.repeat(MAX_ALLOW_PROJECT_LENGTH - 1)}`] } },
    ],
    [
      'a member one too long',
      { groups: { team: [`/${'x'.repeat(MAX_ALLOW_PROJECT_LENGTH)}`] } },
    ],
    [
      'the maximum members in a group',
      {
        groups: {
          team: Array.from({ length: MAX_ALLOW_PROJECTS }, (_, i) => `/p${i}`),
        },
      },
    ],
    [
      'one member too many in a group',
      {
        groups: {
          team: Array.from(
            { length: MAX_ALLOW_PROJECTS + 1 },
            (_, i) => `/p${i}`,
          ),
        },
      },
    ],
    [
      'exactly 32 groups',
      {
        groups: Object.fromEntries(
          Array.from({ length: 32 }, (_, i) => [`g${i}`, ['/a']]),
        ),
      },
    ],
    [
      '33 groups',
      {
        groups: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`g${i}`, ['/a']]),
        ),
      },
    ],
    ['a lowercase name', { groups: { a: ['/a'] } }],
    ['a hyphenated name', { groups: { 'a-b': ['/a'] } }],
    ['a digit-led name', { groups: { '9a': ['/a'] } }],
    ['the longest name', { groups: { ['x'.repeat(64)]: ['/a'] } }],
    ['a name one too long', { groups: { ['x'.repeat(65)]: ['/a'] } }],
    ['an uppercase name', { groups: { A_b: ['/a'] } }],
    ['an underscore name', { groups: { a_b: ['/a'] } }],
    ['a leading hyphen name', { groups: { '-a': ['/a'] } }],
    ['an empty name', { groups: { '': ['/a'] } }],
    ['an unknown key beside groups', { groups: { a: ['/a'] }, extra: 1 }],
    ...pinParityCases,
  ]

  it.each(cases)('%s', (_label, block) => {
    const zod = SystematicConfigSchema.safeParse({ connect: block })
    expect(validateConnectBlock(block).ok).toBe(zod.success)
  })

  it('hands back the same pins the zod schema parses', () => {
    const block = {
      pins: [pin(), pin({ file: 'deps/lock.jsonc', key: 'a.b' })],
    }
    const zod = SystematicConfigSchema.safeParse({ connect: block })
    const plain = validateConnectBlock(block)
    expect(zod.success && plain.ok).toBe(true)
    if (zod.success && plain.ok) {
      expect(plain.pins).toEqual(zod.data.connect?.pins ?? [])
    }
  })
})

describe('checkHostSupport', () => {
  // Versions in the injected tables sit far from any shipped row, so these
  // tests describe the rule and not a host release.
  const row = (overrides: Partial<HostSupportRow> = {}): HostSupportRow => ({
    host: 'opencode-v1',
    version: '9999.19.5',
    observedBy: 'tests/integration/opencode-v1-isolation.test.ts',
    ...overrides,
  })
  const knownBad = (
    overrides: Partial<KnownBadHostVersion> = {},
  ): KnownBadHostVersion => ({
    host: 'opencode-v1',
    version: '9999.19.7',
    evidence: 'a recorded refusal that did not hold',
    ...overrides,
  })

  it('lists nothing from an empty table', () => {
    expect(checkHostSupport('opencode-v1', '9999.19.5', [])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
  })

  it('supports the floor itself and returns the row that observed it', () => {
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

  describe('versions above the floor in the same major', () => {
    const floor = row()

    it.each([
      ['a newer patch', '9999.19.6'],
      ['a newer minor', '9999.20.0'],
      ['a much newer minor', '9999.40.2'],
      ['a prefixed newer patch', 'v9999.19.6'],
    ])('supports %s: %s', (_label, version) => {
      expect(checkHostSupport('opencode-v1', version, [floor])).toEqual({
        supported: true,
        row: floor,
      })
    })

    it('compares each part as a number, not as text', () => {
      const ninth = row({ version: '9999.19.9' })
      expect(checkHostSupport('opencode-v1', '9999.19.10', [ninth])).toEqual({
        supported: true,
        row: ninth,
      })
      const lowMinor = row({ version: '9999.9.0' })
      expect(checkHostSupport('opencode-v1', '9999.10.0', [lowMinor])).toEqual({
        supported: true,
        row: lowMinor,
      })
      expect(checkHostSupport('opencode-v1', '9999.100.0', [lowMinor])).toEqual(
        { supported: true, row: lowMinor },
      )
    })

    it('does not let a leading zero or a long number change the order', () => {
      expect(
        checkHostSupport('opencode-v1', '9999.019.05', [row()]).supported,
      ).toBe(true)
      expect(
        checkHostSupport('opencode-v1', '9999.19.99999999999999999999999', [
          row(),
        ]).supported,
      ).toBe(true)
      expect(
        checkHostSupport('opencode-v1', '9999.19.4', [
          row({ version: '9999.19.00000000000000000000005' }),
        ]),
      ).toEqual({ supported: false, reason: 'below-floor' })
    })

    it('fills a missing trailing part with zero', () => {
      expect(
        checkHostSupport('opencode-v1', '9999.20', [row()]).supported,
      ).toBe(true)
      expect(
        checkHostSupport('opencode-v1', '9999.19', [row()]).supported,
      ).toBe(false)
    })

    it('picks the highest floor at or below the version when a host has several rows', () => {
      const low = row({ version: '9999.1.0' })
      const high = row({ version: '9999.5.0' })
      expect(checkHostSupport('opencode-v1', '9999.7.3', [low, high])).toEqual({
        supported: true,
        row: high,
      })
      expect(checkHostSupport('opencode-v1', '9999.3.0', [high, low])).toEqual({
        supported: true,
        row: low,
      })
    })
  })

  describe('versions below the floor', () => {
    it.each([
      '9999.19.4',
      '9999.18.29',
      '9999.9.99',
      '9999.19',
      '9998.99.99',
      '1.0.0',
    ])('refuses %s with the reason below-floor', (version) => {
      expect(checkHostSupport('opencode-v1', version, [row()])).toEqual({
        supported: false,
        reason: 'below-floor',
      })
    })
  })

  describe('another major', () => {
    it.each(['10000.0.0', '10000.19.5', '10001.0.0'])(
      'does not carry a floor into the higher major %s',
      (version) => {
        expect(checkHostSupport('opencode-v1', version, [row()])).toEqual({
          supported: false,
          reason: 'unlisted',
        })
      },
    )

    it('supports a major that has its own row, by that row', () => {
      const next = row({ version: '10000.2.0' })
      expect(
        checkHostSupport('opencode-v1', '10000.3.1', [row(), next]),
      ).toEqual({ supported: true, row: next })
      expect(
        checkHostSupport('opencode-v1', '10000.1.9', [row(), next]),
      ).toEqual({ supported: false, reason: 'below-floor' })
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
    ])('ignores everything from the first plus: %s is the floor', (version) => {
      expect(checkHostSupport('opencode-v1', version, table)).toEqual({
        supported: true,
        row: listed,
      })
    })

    it.each(['9999.19.9+harness.abc', '9999.19.10+build.1'])(
      'supports a newer version that carries build metadata: %s',
      (version) => {
        expect(checkHostSupport('opencode-v1', version, table)).toEqual({
          supported: true,
          row: listed,
        })
      },
    )

    it('refuses an older version that carries build metadata', () => {
      expect(
        checkHostSupport('opencode-v1', '9999.19.4+build.1', table),
      ).toEqual({ supported: false, reason: 'below-floor' })
    })

    it.each(['+', '+abc', 'v+abc', ' +harness '])(
      'treats %s, which has no version before the plus, as unobserved',
      (version) => {
        expect(checkHostSupport('opencode-v1', version, table)).toEqual({
          supported: false,
          reason: 'unobserved',
        })
      },
    )

    it('supports the installed fork build of a shipped row and anything newer', () => {
      for (const entry of HOST_SUPPORT_TABLE) {
        expect(
          checkHostSupport(entry.host, `${entry.version}+harness.bf7f7dfe`)
            .supported,
        ).toBe(true)
      }
    })
  })

  describe('prerelease versions', () => {
    const table = [row()]

    it.each([
      '9999.19.5-rc.1',
      '9999.19.6-rc.1',
      '9999.20.0-beta',
      '9999.19.6-rc.1+build.7',
      '9999.19.4-rc.1',
    ])('are not supported by a floor: %s', (version) => {
      expect(checkHostSupport('opencode-v1', version, table)).toEqual({
        supported: false,
        reason: 'unlisted',
      })
    })

    it('are supported only when a row names that exact prerelease', () => {
      const candidate = row({ version: '9999.20.0-rc.1' })
      expect(
        checkHostSupport('opencode-v1', '9999.20.0-rc.1+build.2', [candidate]),
      ).toEqual({ supported: true, row: candidate })
      expect(
        checkHostSupport('opencode-v1', '9999.20.0-rc.2', [candidate])
          .supported,
      ).toBe(false)
    })
  })

  it('rejects a host with no row, and a version listed for another host', () => {
    expect(checkHostSupport('pi', '9999.19.5', [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
    expect(
      checkHostSupport('opencode-v2', '9999.19.5', [row()]).supported,
    ).toBe(false)
  })

  it('treats an unknown host name as unsupported at any version', () => {
    expect(checkHostSupport('vscode', '9999.20.0', [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
    expect(checkHostSupport(undefined, '9999.19.5', [row()])).toEqual({
      supported: false,
      reason: 'unlisted',
    })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a non-string', 1.195],
    ['text with no digits', 'latest'],
    ['a letter in a part', '9999.x.5'],
    ['an empty part', '9999..5'],
    ['a trailing dot', '9999.19.'],
    ['a leading dot', '.19.5'],
    ['a bare tag', '-rc.1'],
    ['the whole line a host printed', '9999.19.5 (Claude Code)'],
    ['a signed part', '9999.-1.5'],
    ['an empty prerelease', '9999.19.5-'],
  ])('treats %s as an unobserved version', (_label, version) => {
    expect(checkHostSupport('opencode-v1', version, [row()])).toEqual({
      supported: false,
      reason: 'unobserved',
    })
  })

  it.each([
    ['an empty observedBy', ''],
    ['a blank observedBy', '   '],
  ])('a row with %s never supports anything', (_label, observedBy) => {
    expect(
      checkHostSupport('opencode-v1', '9999.19.5', [row({ observedBy })]),
    ).toEqual({ supported: false, reason: 'unlisted' })
    expect(
      checkHostSupport('opencode-v1', '9999.30.0', [row({ observedBy })]),
    ).toEqual({ supported: false, reason: 'unlisted' })
  })

  it('a row with no observedBy key at all never supports anything', () => {
    const bare = { host: 'opencode-v1', version: '9999.19.5' } as HostSupportRow
    expect(checkHostSupport('opencode-v1', '9999.19.5', [bare]).supported).toBe(
      false,
    )
    expect(checkHostSupport('opencode-v1', '9999.30.0', [bare]).supported).toBe(
      false,
    )
  })

  describe('the known-bad list', () => {
    const floor = row()
    const table = [floor, row({ host: 'opencode-v2', version: '9999.22.5' })]
    const list = [knownBad()]

    it('refuses a listed pair above the floor with its own reason', () => {
      expect(checkHostSupport('opencode-v1', '9999.19.7', table, list)).toEqual(
        { supported: false, reason: 'known-bad' },
      )
    })

    it('leaves the versions on both sides of it supported', () => {
      for (const version of ['9999.19.5', '9999.19.6', '9999.19.8']) {
        expect(checkHostSupport('opencode-v1', version, table, list)).toEqual({
          supported: true,
          row: floor,
        })
      }
    })

    it('matches through the same normalising as the table', () => {
      for (const version of [
        'v9999.19.7',
        ' 9999.19.7 ',
        '9999.19.7+harness.abc',
      ]) {
        expect(checkHostSupport('opencode-v1', version, table, list)).toEqual({
          supported: false,
          reason: 'known-bad',
        })
      }
    })

    it('names a host and version, so another host at that version is not refused', () => {
      expect(
        checkHostSupport('opencode-v2', '9999.22.5', table, list).supported,
      ).toBe(true)
      const other = [knownBad({ host: 'opencode-v2', version: '9999.22.5' })]
      expect(
        checkHostSupport('opencode-v2', '9999.22.5', table, other),
      ).toEqual({ supported: false, reason: 'known-bad' })
      expect(
        checkHostSupport('opencode-v1', '9999.22.5', table, other).supported,
      ).toBe(true)
    })

    it('refuses the floor itself when the floor is listed', () => {
      const bad = [knownBad({ version: '9999.19.5' })]
      expect(checkHostSupport('opencode-v1', '9999.19.5', table, bad)).toEqual({
        supported: false,
        reason: 'known-bad',
      })
    })

    it('refuses an exact prerelease row that is listed', () => {
      const candidate = row({ version: '9999.20.0-rc.1' })
      const bad = [knownBad({ version: '9999.20.0-rc.1' })]
      expect(
        checkHostSupport('opencode-v1', '9999.20.0-rc.1', [candidate], bad),
      ).toEqual({ supported: false, reason: 'known-bad' })
    })

    it('does not support a listed pair that no row covers, and says why', () => {
      expect(checkHostSupport('opencode-v1', '9999.19.7', [], list)).toEqual({
        supported: false,
        reason: 'known-bad',
      })
    })

    it('reads an unobservable version as unobserved before the list', () => {
      expect(checkHostSupport('opencode-v1', undefined, table, list)).toEqual({
        supported: false,
        reason: 'unobserved',
      })
    })

    it('an empty list changes nothing', () => {
      expect(
        checkHostSupport('opencode-v1', '9999.19.7', table, []).supported,
      ).toBe(true)
    })
  })
})

// A row is added only for a host and version where the shipped researcher's
// denies were seen on a real host. These tests keep each row tied to a proof
// test that still exists under that title, and check the rule against the
// shipped rows without naming a host release.
describe('the shipped host-support table', () => {
  const root = path.join(import.meta.dirname, '../..')

  /** The same version with its major raised by one. */
  const nextMajor = (version: string): string => {
    const [major = '0', ...rest] = version.split('.')
    return [String(Number(major) + 1), ...rest].join('.')
  }

  it('reads the version the skill sends from what `claude --version` prints', () => {
    // The skill sends the first token that starts with a digit.
    const printed = '2.1.319 (Claude Code)'
    const sent = printed.split(/\s+/).find((token) => /^v?\d/.test(token))
    expect(sent).toBe('2.1.319')
    expect(checkHostSupport('claude-code', sent)).toMatchObject({
      supported: true,
      row: { host: 'claude-code' },
    })
    // The whole line is not a version.
    expect(checkHostSupport('claude-code', printed)).toEqual({
      supported: false,
      reason: 'unobserved',
    })
  })

  it('supports each row at its floor, refuses a prerelease of it, and refuses an unknown host', () => {
    for (const entry of HOST_SUPPORT_TABLE) {
      expect(checkHostSupport(entry.host, entry.version)).toEqual({
        supported: true,
        row: entry,
      })
      expect(
        checkHostSupport(entry.host, `${entry.version}-beta`).supported,
      ).toBe(false)
      expect(checkHostSupport('vscode', entry.version).supported).toBe(false)
    }
  })

  it('applies one rule to every row: a newer release in its major is supported, an older one and a higher major are not', () => {
    for (const entry of HOST_SUPPORT_TABLE) {
      const [major = '0', minor = '0'] = entry.version.split('.')
      expect(
        checkHostSupport(entry.host, `${major}.${Number(minor) + 1}.0`)
          .supported,
      ).toBe(true)
      expect(checkHostSupport(entry.host, `${major}.${minor}.99999`)).toEqual({
        supported: true,
        row: entry,
      })
      expect(checkHostSupport(entry.host, '0.0.1')).toEqual({
        supported: false,
        reason: 'below-floor',
      })
      expect(checkHostSupport(entry.host, nextMajor(entry.version))).toEqual({
        supported: false,
        reason: 'unlisted',
      })
    }
  })

  it('does not apply one host row to another host', () => {
    const v1 = HOST_SUPPORT_TABLE.find((entry) => entry.host === 'opencode-v1')
    if (v1 === undefined) throw new Error('no shipped v1 row')
    expect(checkHostSupport('claude-code', v1.version).supported).toBe(false)
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
