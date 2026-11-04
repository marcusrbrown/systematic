import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfigWithSources } from '../../src/lib/config.js'
import {
  type ActiveSource,
  MAX_ACTIVE_SOURCES,
  resolveExternalSources,
} from '../../src/lib/search-external-sources.js'
import type { ProjectIdentity } from '../../src/lib/search-project-identity.js'
import {
  loadUserLevelSearchSettings,
  MAX_PROJECT_CONFIG_BYTES,
} from '../../src/lib/search-user-config.js'
import {
  cleanupTempDirs,
  createRepo,
  git,
  makeDir,
} from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

interface Env {
  /** The checkout root: a directory holding a `.git` directory. */
  readonly repo: string
  readonly homeDir: string
  readonly userConfigDir: string
  readonly configOptions: { homeDir: string; customConfigDir: string | null }
}

function makeEnv(): Env {
  const root = makeDir('extsrc-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  const homeDir = path.join(root, 'home')
  const userConfigDir = path.join(homeDir, '.config/opencode')
  fs.mkdirSync(userConfigDir, { recursive: true })
  return {
    repo,
    homeDir,
    userConfigDir,
    configOptions: { homeDir, customConfigDir: null },
  }
}

function writeUser(env: Env, search: unknown): void {
  fs.writeFileSync(
    path.join(env.userConfigDir, 'systematic.json'),
    JSON.stringify({ search }),
  )
}

function writeProject(
  checkout: string,
  search: unknown,
  name = 'systematic.json',
) {
  const dir = path.join(checkout, '.opencode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ search }))
}

const projectSource = (name: string, root = `docs/${name}`) => ({
  name,
  format: 'markdown' as const,
  roots: [root],
})

const userSource = (
  name: string,
  projects?: string[],
  root = `/srv/${name}`,
) => ({
  name,
  format: 'markdown' as const,
  roots: [root],
  ...(projects !== undefined && { projects }),
})

function names(sources: readonly ActiveSource[]): string[] {
  return sources.map((source) => source.name)
}

describe('resolveExternalSources: exclude', () => {
  test('a user source carries its validated patterns', () => {
    const env = makeEnv()
    writeUser(env, {
      sources: [
        {
          ...userSource('wiki', [env.repo]),
          exclude: ['log.md', '[bad]', '.stryker-tmp'],
        },
      ],
    })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.origin).toBe('user')
    expect(result.sources[0]?.exclude).toEqual(['log.md', '.stryker-tmp'])
    expect(result.warnings.join('\n')).toContain('exclude[1]')
    expect(result.warnings.join('\n')).not.toContain('[bad]')
  })

  test('a project source carries its validated patterns', () => {
    const env = makeEnv()
    writeProject(env.repo, {
      sources: [
        { ...projectSource('decisions'), exclude: ['drafts/*.md', '!log.md'] },
      ],
    })
    writeUser(env, { allow_project_sources: [env.repo] })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.origin).toBe('project')
    expect(result.sources[0]?.exclude).toEqual(['drafts/*.md'])
    expect(result.warnings.join('\n')).toContain('exclude[1]')
    expect(result.warnings.join('\n')).not.toContain('log.md')
  })

  test('a source with no exclude gets an empty list', () => {
    const env = makeEnv()
    writeUser(env, { sources: [userSource('wiki', [env.repo])] })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources[0]?.exclude).toEqual([])
  })

  test('a user source whose exclude is not an array is dropped with a warning', () => {
    const env = makeEnv()
    writeUser(env, {
      sources: [
        { ...userSource('wiki', [env.repo]), exclude: 'log.md' },
        userSource('keeper', [env.repo]),
      ],
    })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['keeper'])
    expect(result.warnings.join('\n')).toContain('"wiki"')
  })
})

describe('resolveExternalSources: project proposals', () => {
  test('an allowed project resolves its proposal as a project source', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('decisions')] })
    writeUser(env, { allow_project_sources: [env.repo] })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })

    expect(result.sources).toEqual([
      {
        name: 'decisions',
        format: 'markdown',
        roots: [path.join(fs.realpathSync(env.repo), 'docs/decisions')],
        origin: 'project',
        exclude: [],
      },
    ])
    expect(result.project).toEqual({ kind: 'allowed', proposals: 1 })
    expect(result.userConfigUnreadable).toBe(false)
  })

  test('a start directory below the checkout root reads the root config', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('decisions')] })
    writeUser(env, { allow_project_sources: [env.repo] })
    const deep = path.join(env.repo, 'src/deep')
    fs.mkdirSync(deep, { recursive: true })

    const result = resolveExternalSources({
      startDir: deep,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['decisions'])
    expect(result.sources[0]?.roots).toEqual([
      path.join(fs.realpathSync(env.repo), 'docs/decisions'),
    ])
  })

  test('with no allow entry the proposal resolves to nothing and echoes no names or roots', () => {
    const env = makeEnv()
    writeProject(env.repo, {
      sources: [
        projectSource('secret-name', 'docs/secret-root'),
        projectSource('b'),
      ],
    })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })

    expect(result.sources).toEqual([])
    expect(result.project).toEqual({
      kind: 'not-allowed',
      proposals: 2,
      mainRoot: fs.realpathSync(env.repo),
    })
    const echoed = JSON.stringify(result)
    expect(echoed).not.toContain('secret-name')
    expect(echoed).not.toContain('secret-root')
  })

  test('an allow entry for a different project does not allow this one', () => {
    const env = makeEnv()
    const other = makeDir('extsrc-other-')
    fs.mkdirSync(path.join(other, '.git'))
    writeProject(env.repo, { sources: [projectSource('decisions')] })
    writeUser(env, { allow_project_sources: [other] })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources).toEqual([])
    expect(result.project.kind).toBe('not-allowed')
  })

  test('a project with no proposals is not "not allowed"', () => {
    const env = makeEnv()
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.project).toEqual({ kind: 'none' })
    expect(result.sources).toEqual([])
  })

  test('an unresolved identity allows nothing and carries no main-root string', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('decisions')] })
    writeUser(env, {
      allow_project_sources: [env.repo, '/', '~'],
      sources: [userSource('mapped', [env.repo])],
    })
    const identity: ProjectIdentity = {
      status: 'unresolved',
      reason: 'inconsistent',
    }

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
      identity,
    })

    expect(result.sources).toEqual([])
    expect(result.project).toEqual({ kind: 'not-allowed', proposals: 1 })
    expect(JSON.stringify(result)).not.toContain('mainRoot')
  })

  test('a directory with no .git ancestor allows nothing and does not throw', () => {
    const env = makeEnv()
    const bare = makeDir('extsrc-nogit-')
    writeUser(env, { allow_project_sources: [bare] })
    writeProject(bare, { sources: [projectSource('decisions')] })

    const result = resolveExternalSources({
      startDir: bare,
      configOptions: env.configOptions,
    })
    expect(result.sources).toEqual([])
  })
})

describe('resolveExternalSources: project file problems', () => {
  function allowed(): Env {
    const env = makeEnv()
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('mine', [env.repo])],
    })
    return env
  }

  function resolve(env: Env) {
    return resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
  }

  test.each([
    ['malformed JSONC', '{ "search": { "sources": [ '],
    ['sources that is not an array', '{"search":{"sources":"docs"}}'],
    ['a search block that is not an object', '{"search":[]}'],
  ])(
    '%s: zero proposals, project config unreadable, user side unaffected',
    (_label, content) => {
      const env = allowed()
      fs.mkdirSync(path.join(env.repo, '.opencode'))
      fs.writeFileSync(
        path.join(env.repo, '.opencode/systematic.json'),
        content,
      )

      const result = resolve(env)

      expect(names(result.sources)).toEqual(['mine'])
      expect(result.project).toEqual({ kind: 'config-unreadable' })
      expect(result.userConfigUnreadable).toBe(false)
    },
  )

  test('a project file over 1 MB is rejected the same way', () => {
    const env = allowed()
    fs.mkdirSync(path.join(env.repo, '.opencode'))
    const base = JSON.stringify({ search: { sources: [projectSource('big')] } })
    fs.writeFileSync(
      path.join(env.repo, '.opencode/systematic.json'),
      base + ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1 - base.length),
    )

    const result = resolve(env)
    expect(names(result.sources)).toEqual(['mine'])
    expect(result.project).toEqual({ kind: 'config-unreadable' })
  })

  test('one valid and one invalid entry: the valid one loads and nothing is unreadable', () => {
    const env = allowed()
    writeProject(env.repo, {
      sources: [projectSource('good'), projectSource('bad', '../escape')],
    })

    const result = resolve(env)

    expect(names(result.sources)).toEqual(['mine', 'good'])
    expect(result.project).toEqual({ kind: 'allowed', proposals: 1 })
    expect(result.warnings.some((w) => w.includes('"bad"'))).toBe(true)
  })

  test('a project enabled:false or allow list changes nothing', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [env.repo] })
    writeProject(env.repo, {
      enabled: false,
      allow_project_sources: ['/'],
      sources: [projectSource('good')],
    })
    const result = resolve(env)
    expect(names(result.sources)).toEqual(['good'])
  })

  test('reads .json when .jsonc is absent and prefers .jsonc when both exist', () => {
    const env = allowed()
    writeProject(env.repo, { sources: [projectSource('from-json')] })
    expect(names(resolve(env).sources)).toEqual(['mine', 'from-json'])

    writeProject(
      env.repo,
      { sources: [projectSource('from-jsonc')] },
      'systematic.jsonc',
    )
    expect(names(resolve(env).sources)).toEqual(['mine', 'from-jsonc'])
  })
})

describe('resolveExternalSources: worktrees', () => {
  function worktreeOf(main: string): string {
    const target = path.join(makeDir('extsrc-wt-'), 'wt')
    git(main, ['worktree', 'add', '-q', '-b', 'feature', target])
    return fs.realpathSync(target)
  }

  test('a user source mapped to the main root resolves at the repo root and at a real worktree, not at an unrelated repo', () => {
    const repo = createRepo()
    const unrelated = createRepo()
    const wt = worktreeOf(repo.work)
    const env = makeEnv()
    writeUser(env, { sources: [userSource('agent-wiki', [repo.work])] })
    const at = (startDir: string) =>
      resolveExternalSources({ startDir, configOptions: env.configOptions })

    expect(names(at(repo.work).sources)).toEqual(['agent-wiki'])
    expect(names(at(wt).sources)).toEqual(['agent-wiki'])
    expect(at(unrelated.work).sources).toEqual([])
  })

  test('a worktree matches its main root allow entry but reads its own project config copy', () => {
    const repo = createRepo()
    const wt = worktreeOf(repo.work)
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [repo.work] })
    writeProject(repo.work, { sources: [projectSource('main-copy')] })
    writeProject(wt, { sources: [projectSource('worktree-copy')] })

    const atWorktree = resolveExternalSources({
      startDir: wt,
      configOptions: env.configOptions,
    })
    expect(names(atWorktree.sources)).toEqual(['worktree-copy'])
    expect(atWorktree.sources[0]?.roots).toEqual([
      path.join(wt, 'docs/worktree-copy'),
    ])

    const atMain = resolveExternalSources({
      startDir: repo.work,
      configOptions: env.configOptions,
    })
    expect(names(atMain.sources)).toEqual(['main-copy'])
  })

  test('a worktree falls back to .json when .jsonc is absent and prefers .jsonc', () => {
    const repo = createRepo()
    const wt = worktreeOf(repo.work)
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [repo.work] })
    const at = () =>
      names(
        resolveExternalSources({
          startDir: wt,
          configOptions: env.configOptions,
        }).sources,
      )

    writeProject(wt, { sources: [projectSource('json-copy')] })
    expect(at()).toEqual(['json-copy'])
    writeProject(
      wt,
      { sources: [projectSource('jsonc-copy')] },
      'systematic.jsonc',
    )
    expect(at()).toEqual(['jsonc-copy'])
  })
})

describe('resolveExternalSources: user sources, shadowing and order', () => {
  test('a user source mapped to this project shadows a same-named project source', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('wiki', 'docs/proj')] })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('wiki', [env.repo], '/srv/user-wiki')],
    })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources).toEqual([
      {
        name: 'wiki',
        format: 'markdown',
        roots: ['/srv/user-wiki'],
        origin: 'user',
        exclude: [],
      },
    ])
  })

  test('a user source mapped elsewhere does not shadow: the project source loads', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('wiki', 'docs/proj')] })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('wiki', ['/somewhere/else'], '/srv/user-wiki')],
    })

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources.map((s) => [s.name, s.origin])).toEqual([
      ['wiki', 'project'],
    ])
  })

  test('a not-allowed project still reports its proposals while the mapped user source resolves', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('wiki')] })
    writeUser(env, { sources: [userSource('wiki', [env.repo])] })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources.map((s) => s.origin)).toEqual(['user'])
    expect(result.project.kind).toBe('not-allowed')
  })

  test('a user source with no projects, or an empty list, is dropped with a visible warning', () => {
    const env = makeEnv()
    writeUser(env, {
      sources: [
        userSource('unmapped'),
        userSource('empty', []),
        userSource('mapped', [env.repo]),
      ],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['mapped'])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.some((w) => w.includes('"unmapped"'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('"empty"'))).toBe(true)
    expect(result.userConfigUnreadable).toBe(false)
  })

  test('names are case-sensitive: Wiki and wiki coexist', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('wiki')] })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('Wiki', [env.repo])],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['Wiki', 'wiki'])
  })

  test('user roots expand ~ against the home directory and absolute roots stay as given', () => {
    const env = makeEnv()
    writeUser(env, {
      sources: [
        {
          name: 'mixed',
          format: 'markdown',
          roots: ['~/notes', '~', '/srv/abs'],
          projects: [env.repo],
        },
      ],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources[0]?.roots).toEqual([
      path.join(env.homeDir, 'notes'),
      env.homeDir,
      '/srv/abs',
    ])
  })

  test('a projects entry written with ~ maps to this project', () => {
    const env = makeEnv()
    const underHome = path.join(env.homeDir, 'src/app')
    fs.mkdirSync(path.join(underHome, '.git'), { recursive: true })
    writeUser(env, { sources: [userSource('wiki', ['~/src/app'])] })
    const result = resolveExternalSources({
      startDir: underHome,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['wiki'])
  })

  test('user sources come before project sources', () => {
    const env = makeEnv()
    writeProject(env.repo, {
      sources: [projectSource('p1'), projectSource('p2')],
    })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('u1', [env.repo]), userSource('u2', [env.repo])],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['u1', 'u2', 'p1', 'p2'])
  })
})

describe('resolveExternalSources: the source cap', () => {
  test('the cap is 8', () => {
    expect(MAX_ACTIVE_SOURCES).toBe(8)
  })

  test('ten user sources cap at 8 in declared order, with a warning naming the dropped ones first', () => {
    const env = makeEnv()
    const declared = Array.from({ length: 10 }, (_, i) => `s${i + 1}`)
    writeUser(env, {
      sources: declared.map((name) => userSource(name, [env.repo])),
      // An invalid entry gives a later, unrelated warning.
      allow_project_sources: ['relative'],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })

    expect(names(result.sources)).toEqual(declared.slice(0, 8))
    expect(result.warnings.length).toBeGreaterThan(1)
    const first = result.warnings[0] ?? ''
    expect(first).toContain('s9')
    expect(first).toContain('s10')
    expect(first).not.toContain('s8')
  })

  test('user sources fill the cap before project sources, which are the ones dropped', () => {
    const env = makeEnv()
    writeProject(env.repo, {
      sources: Array.from({ length: 5 }, (_, i) => projectSource(`p${i + 1}`)),
    })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: Array.from({ length: 5 }, (_, i) =>
        userSource(`u${i + 1}`, [env.repo]),
      ),
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual([
      'u1',
      'u2',
      'u3',
      'u4',
      'u5',
      'p1',
      'p2',
      'p3',
    ])
    expect(result.warnings[0]).toContain('p4')
    expect(result.warnings[0]).toContain('p5')
  })

  test('exactly 8 sources raise no cap warning', () => {
    const env = makeEnv()
    writeUser(env, {
      sources: Array.from({ length: 8 }, (_, i) =>
        userSource(`s${i + 1}`, [env.repo]),
      ),
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources).toHaveLength(8)
    expect(result.warnings).toEqual([])
  })
})

describe('resolveExternalSources: user and custom config dirs', () => {
  test('allow lists union and same-named sources resolve with the custom dir winning', () => {
    const env = makeEnv()
    const custom = makeDir('extsrc-custom-')
    writeProject(env.repo, { sources: [projectSource('proj')] })
    writeUser(env, {
      sources: [userSource('shared', [env.repo], '/srv/from-user')],
    })
    fs.writeFileSync(
      path.join(custom, 'systematic.json'),
      JSON.stringify({
        search: {
          allow_project_sources: [env.repo],
          sources: [userSource('shared', [env.repo], '/srv/from-custom')],
        },
      }),
    )

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: { homeDir: env.homeDir, customConfigDir: custom },
    })

    expect(result.sources.map((s) => [s.name, s.roots[0]])).toEqual([
      ['shared', '/srv/from-custom'],
      ['proj', path.join(fs.realpathSync(env.repo), 'docs/proj')],
    ])
  })

  test('each of the two files contributes its own allow entry', () => {
    const env = makeEnv()
    const custom = makeDir('extsrc-custom-')
    const other = makeDir('extsrc-other-')
    fs.mkdirSync(path.join(other, '.git'))
    writeProject(env.repo, { sources: [projectSource('proj')] })
    writeProject(other, { sources: [projectSource('other-proj')] })
    writeUser(env, { allow_project_sources: [other] })
    fs.writeFileSync(
      path.join(custom, 'systematic.json'),
      JSON.stringify({ search: { allow_project_sources: [env.repo] } }),
    )
    const configOptions = { homeDir: env.homeDir, customConfigDir: custom }

    expect(
      names(
        resolveExternalSources({ startDir: env.repo, configOptions }).sources,
      ),
    ).toEqual(['proj'])
    expect(
      names(resolveExternalSources({ startDir: other, configOptions }).sources),
    ).toEqual(['other-proj'])
  })
})

describe('resolveExternalSources: user config problems', () => {
  test('a bad allow entry allows nothing, sets the user note, and keeps valid siblings', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('proj')] })
    writeUser(env, {
      allow_project_sources: ['relative/path', 7],
      sources: [userSource('mine', [env.repo])],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['mine'])
    expect(result.project.kind).toBe('not-allowed')
    expect(result.userConfigUnreadable).toBe(true)
  })

  test('an unparseable user file is the user note, allows nothing and maps nothing', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('proj')] })
    fs.writeFileSync(path.join(env.userConfigDir, 'systematic.json'), '{ nope')
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.sources).toEqual([])
    expect(result.userConfigUnreadable).toBe(true)
    expect(result.project.kind).toBe('not-allowed')
  })

  test('a missing user config is normal', () => {
    const env = makeEnv()
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(result.userConfigUnreadable).toBe(false)
    expect(result.warnings).toEqual([])
  })
})

describe('resolveExternalSources: enabled belongs to the fixed init settings', () => {
  test('enabled:false in the user file and in the project file changes neither sources nor the result shape', () => {
    const env = makeEnv()
    writeProject(env.repo, { enabled: false, sources: [projectSource('proj')] })
    writeUser(env, {
      enabled: false,
      allow_project_sources: [env.repo],
      sources: [userSource('mine', [env.repo])],
    })
    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    expect(names(result.sources)).toEqual(['mine', 'proj'])
    expect(Object.keys(result).sort()).toEqual([
      'dropped',
      'project',
      'sources',
      'userConfigUnreadable',
      'warnings',
    ])
  })
})

describe('the mixed file agrees across the config.ts path and the per-call reader', () => {
  test('same kept entries, enabled:false and bad allow entry through both', () => {
    const env = makeEnv()
    const mixed = {
      enabled: false,
      allow_project_sources: ['/work/app', 12],
      sources: [
        userSource('good', [env.repo]),
        { ...userSource('bad-format', [env.repo]), format: 'yaml' },
        { ...userSource('bad-root', [env.repo]), roots: ['relative'] },
        userSource('good', [env.repo], '/dup'),
        userSource('second', [env.repo]),
      ],
    }
    writeUser(env, mixed)

    const viaConfig = loadConfigWithSources(env.repo, {
      homeDir: env.homeDir,
      customConfigDir: null,
      warningSink: () => {},
    }).config
    const viaReader = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    const viaUserLoader = loadUserLevelSearchSettings(env.configOptions)

    // config.ts keeps enabled:false and the two valid entries.
    expect(viaConfig.search?.enabled).toBe(false)
    const kept = (viaConfig.search?.sources ?? []).map((s) => s.name)
    expect(kept).toEqual(['good', 'second'])
    // The user-file reader the composer calls sees the same block.
    expect(viaUserLoader.settings).toEqual(viaConfig.search)
    // The per-call reader resolves exactly those entries, and the bad
    // entries and the bad allow entry did not take enabled:false with them.
    expect(names(viaReader.sources)).toEqual(kept)
    expect(viaReader.sources[0]?.roots).toEqual(['/srv/good'])
    expect(viaReader.userConfigUnreadable).toBe(
      viaConfig.searchUnreadable === true,
    )
    expect(viaReader.userConfigUnreadable).toBe(true)
  })
})

describe('C2: nothing is cached between calls', () => {
  test('editing the allow list and the project file changes the next call', () => {
    const env = makeEnv()
    const call = () =>
      resolveExternalSources({
        startDir: env.repo,
        configOptions: env.configOptions,
      })

    writeProject(env.repo, { sources: [projectSource('first')] })
    expect(call().sources).toEqual([])
    expect(call().project.kind).toBe('not-allowed')

    writeUser(env, { allow_project_sources: [env.repo] })
    expect(names(call().sources)).toEqual(['first'])

    writeProject(env.repo, { sources: [projectSource('second')] })
    expect(names(call().sources)).toEqual(['second'])

    writeUser(env, { allow_project_sources: [] })
    expect(call().sources).toEqual([])
  })
})

describe('resolveExternalSources: locations, local overlays and diagnostics', () => {
  const resolve = (env: Env, startDir = env.repo) =>
    resolveExternalSources({ startDir, configOptions: env.configOptions })

  test('a root project file is read from a start directory below the root, and the shadowed .opencode/ file is named once', () => {
    const env = makeEnv()
    const rootFile = path.join(env.repo, '.systematic.jsonc')
    fs.writeFileSync(
      rootFile,
      `// proposals\n${JSON.stringify({ search: { sources: [projectSource('from-root')] } })}`,
    )
    writeProject(env.repo, { sources: [projectSource('from-opencode')] })
    writeUser(env, { allow_project_sources: [env.repo] })
    const deep = path.join(env.repo, 'packages/app')
    fs.mkdirSync(deep, { recursive: true })

    const result = resolve(env, deep)
    expect(names(result.sources)).toEqual(['from-root'])
    const shadow = result.warnings.filter((w) =>
      w.includes(path.join(env.repo, '.opencode')),
    )
    expect(shadow).toHaveLength(1)
    expect(shadow[0]).toContain('.systematic.jsonc')
  })

  test('a source defined in user.local is active, and a local allow entry allows the project', () => {
    const env = makeEnv()
    writeProject(env.repo, { sources: [projectSource('decisions')] })
    fs.writeFileSync(
      path.join(env.userConfigDir, 'systematic.local.json'),
      JSON.stringify({
        search: {
          allow_project_sources: [env.repo],
          sources: [userSource('wiki', [env.repo])],
        },
      }),
    )

    const result = resolve(env)
    expect(names(result.sources)).toEqual(['wiki', 'decisions'])
    expect(result.project).toEqual({ kind: 'allowed', proposals: 1 })
  })

  test('entries dropped in the user files and in the project file are passed through, apart', () => {
    const env = makeEnv()
    writeUser(env, {
      sources: [{ name: 'no-projects', format: 'markdown', roots: ['/srv/x'] }],
    })
    writeProject(env.repo, {
      sources: [
        projectSource('good'),
        { name: 'escape', format: 'markdown', roots: ['..'] },
      ],
    })

    const result = resolve(env)
    expect(result.dropped.user.map((d) => d.label)).toEqual(['"no-projects"'])
    expect(result.dropped.project.map((d) => d.label)).toEqual(['"escape"'])
    expect(result.dropped.user[0]?.reason).toEqual(expect.any(String))
  })

  test('a broken user.local is reported once even when the custom directory is the user directory', () => {
    const env = makeEnv()
    const brokenLocal = path.join(env.userConfigDir, 'systematic.local.json')
    fs.writeFileSync(brokenLocal, '{ "search": ')

    const result = resolveExternalSources({
      startDir: env.repo,
      configOptions: {
        homeDir: env.homeDir,
        customConfigDir: env.userConfigDir,
      },
    })
    expect(result.userConfigUnreadable).toBe(true)
    expect(result.warnings.filter((w) => w.includes(brokenLocal))).toHaveLength(
      1,
    )
  })

  test('the same failed file is reported once per call, and a second call reports its own', () => {
    const env = makeEnv()
    const broken = path.join(env.userConfigDir, 'systematic.json')
    fs.writeFileSync(broken, '{ nope')

    for (const _call of [1, 2]) {
      const result = resolve(env)
      expect(result.warnings.filter((w) => w.includes(broken))).toHaveLength(1)
    }
  })

  test('an oversized root file leaves the project unreadable and does not fall back to .opencode/', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [env.repo] })
    writeProject(env.repo, { sources: [projectSource('from-opencode')] })
    const base = JSON.stringify({
      search: { sources: [projectSource('from-root')] },
    })
    fs.writeFileSync(
      path.join(env.repo, '.systematic.json'),
      base + ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1 - base.length),
    )

    const result = resolve(env)
    expect(result.sources).toEqual([])
    expect(result.project).toEqual({ kind: 'config-unreadable' })
  })
})

describe('module graph', () => {
  const LIB = path.resolve(import.meta.dirname, '../../src/lib')

  function runtimeImports(file: string): string[] {
    const text = fs.readFileSync(file, 'utf8')
    const found: string[] = []
    const pattern =
      /^(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]
      if (spec !== undefined)
        found.push(
          path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')),
        )
    }
    return found
  }

  function reachable(entry: string): Set<string> {
    const seen = new Set<string>()
    const queue = [entry]
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue
      seen.add(file)
      queue.push(...runtimeImports(file))
    }
    return seen
  }

  test('nothing under the per-call reader imports config.ts or config-schema.ts', () => {
    const graph = [
      ...reachable(path.join(LIB, 'search-external-sources.ts')),
    ].map((file) => path.basename(file))
    expect(graph).toContain('search-external-sources.ts')
    expect(graph).toContain('search-user-config.ts')
    expect(graph).toContain('search-project-identity.ts')
    expect(graph).not.toContain('config.ts')
    expect(graph).not.toContain('config-schema.ts')
  })
})
