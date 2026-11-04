import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfigWithSources } from '../../src/lib/config.js'
import { loadExternalSources } from '../../src/lib/search-external.js'
import {
  type ActiveSource,
  type InspectedSource,
  inspectSearch,
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

  describe('a start directory with its own .opencode file', () => {
    const BELOW_ROOT = 'is below the repository root'

    function below(env: Env): { deep: string; nested: string } {
      writeProject(env.repo, { sources: [projectSource('from-root')] })
      const deep = path.join(env.repo, 'packages/app')
      writeProject(deep, { sources: [projectSource('nested')] })
      return { deep, nested: path.join(deep, '.opencode/systematic.json') }
    }

    test('warns that the file is not read, with the text the config loader uses, once', () => {
      const env = makeEnv()
      const { deep, nested } = below(env)
      writeUser(env, { allow_project_sources: [env.repo] })

      const result = resolve(env, deep)
      expect(names(result.sources)).toEqual(['from-root'])
      const loaderWarnings: string[] = []
      loadConfigWithSources(deep, {
        ...env.configOptions,
        warningSink: (message) => loaderWarnings.push(message),
      })
      const expected = loaderWarnings.filter((w) => w.includes(BELOW_ROOT))
      expect(expected).toHaveLength(1)
      expect(expected[0]).toContain(nested)
      expect(result.warnings.filter((w) => w.includes(BELOW_ROOT))).toEqual(
        expected,
      )
    })

    test('warns for a project that is not allowed as well', () => {
      const env = makeEnv()
      const { deep } = below(env)
      const result = resolve(env, deep)
      expect(result.project.kind).toBe('not-allowed')
      expect(result.warnings.some((w) => w.includes(BELOW_ROOT))).toBe(true)
    })

    test('does not warn from the root, from a start directory with no file of its own, or when that file is the selected one', () => {
      const env = makeEnv()
      const { deep } = below(env)
      expect(
        resolve(env, env.repo).warnings.some((w) => w.includes(BELOW_ROOT)),
      ).toBe(false)

      const bare = path.join(env.repo, 'packages/bare')
      fs.mkdirSync(bare, { recursive: true })
      expect(
        resolve(env, bare).warnings.some((w) => w.includes(BELOW_ROOT)),
      ).toBe(false)

      fs.rmSync(path.join(deep, '.opencode'), { recursive: true })
      fs.mkdirSync(path.join(deep, '.opencode'))
      fs.symlinkSync(
        path.join(env.repo, '.opencode/systematic.json'),
        path.join(deep, '.opencode/systematic.json'),
      )
      expect(
        resolve(env, deep).warnings.some((w) => w.includes(BELOW_ROOT)),
      ).toBe(false)
    })

    test('does not name the root own .opencode file as below the root when a root file shadows it', () => {
      const env = makeEnv()
      writeProject(env.repo, { sources: [projectSource('shadowed')] })
      fs.writeFileSync(
        path.join(env.repo, '.systematic.json'),
        JSON.stringify({ search: { sources: [projectSource('from-root')] } }),
      )
      const warnings = resolve(env, env.repo).warnings
      expect(warnings.some((w) => w.includes('takes precedence over'))).toBe(
        true,
      )
      expect(warnings.some((w) => w.includes(BELOW_ROOT))).toBe(false)
    })

    test('does not warn outside any repository, even when the start directory is reached through a link', () => {
      const env = makeEnv()
      const loose = makeDir('extsrc-loose-')
      writeProject(loose, { sources: [projectSource('loose')] })
      fs.writeFileSync(path.join(loose, '.systematic.json'), '{}')
      const link = path.join(makeDir('extsrc-link-'), 'via')
      fs.symlinkSync(loose, link)
      expect(
        resolve(env, link).warnings.some((w) => w.includes(BELOW_ROOT)),
      ).toBe(false)
    })

    test('does not warn outside any repository', () => {
      const env = makeEnv()
      const loose = makeDir('extsrc-loose-')
      writeProject(loose, { sources: [projectSource('loose')] })
      expect(
        resolve(env, loose).warnings.some((w) => w.includes(BELOW_ROOT)),
      ).toBe(false)
    })
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

describe('resolveExternalSources: warnings of a project that is not allowed', () => {
  const proposals = (env: Env) => {
    writeProject(env.repo, {
      sources: [
        { ...projectSource('quokka-notes'), exclude: ['[bad]'] },
        { name: 'quokka-broken', format: 'markdown', roots: ['..'] },
        42,
        projectSource('quokka-twin'),
        projectSource('quokka-twin'),
      ],
    })
  }
  const resolve = (env: Env) =>
    resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })

  test('forwards no warning that names a proposal, and inspection keeps them', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: ['/somewhere/else'] })
    proposals(env)

    const result = resolve(env)
    expect(result.project.kind).toBe('not-allowed')
    expect(result.warnings.join('\n')).not.toContain('quokka')
    expect(result.warnings.join('\n')).not.toContain('search source')

    const inspected = inspectSearch({
      checkoutRoot: env.repo,
      configOptions: env.configOptions,
    })
    const byName = (name: string) =>
      inspected.sources.find((source) => source.name === name)
    expect(byName('quokka-notes')?.warnings.join('\n')).toContain('exclude[0]')
    expect(byName('quokka-broken')?.warnings.join('\n')).toContain('dropped')
    const twins = inspected.sources.filter(
      (source) => source.name === 'quokka-twin',
    )
    expect(twins.map((twin) => twin.status)).toEqual([
      'not allowed',
      'dropped invalid',
    ])
    expect(twins[0]?.warnings).toEqual([])
    expect(twins[1]?.warnings.join('\n')).toContain('already used')
  })

  test('forwards the same warnings when the project is allowed', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [env.repo] })
    proposals(env)

    const text = resolve(env).warnings.join('\n')
    expect(text).toContain('exclude[0]')
    expect(text).toContain('"quokka-broken"')
    expect(text).toContain('"quokka-twin"')
  })

  test('keeps a project warning that names no proposal, and drops entry warnings when no valid proposal is left', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: ['/somewhere/else'] })
    fs.writeFileSync(
      path.join(env.repo, '.systematic.json'),
      JSON.stringify({
        search: {
          sources: [
            { name: 'quokka-broken', format: 'markdown', roots: ['..'] },
          ],
        },
      }),
    )
    writeProject(env.repo, { sources: [projectSource('shadowed')] })

    const result = resolve(env)
    expect(result.project).toEqual({ kind: 'none' })
    expect(result.warnings.join('\n')).not.toContain('quokka')
    expect(result.warnings.join('\n')).toContain('takes precedence over')
  })
})

describe('inspectSearch', () => {
  function inspect(env: Env) {
    return inspectSearch({
      checkoutRoot: env.repo,
      configOptions: env.configOptions,
    })
  }

  function writeLocal(env: Env, search: unknown): void {
    fs.writeFileSync(
      path.join(env.userConfigDir, 'systematic.local.json'),
      JSON.stringify({ search }),
    )
  }

  function mkRoot(env: Env, name: string): string {
    const dir = path.join(env.homeDir, 'vaults', name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  function find(sources: readonly InspectedSource[], name: string) {
    return sources.find((source) => source.name === name)
  }

  test('reports enabled, the allow list and whether this project is on it', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [env.repo] })

    const result = inspect(env)
    expect(result.enabled).toBe(true)
    expect(result.allowProjectSources).toEqual([env.repo])
    expect(result.projectAllowed).toBe(true)
    expect(result.projectRoot).toBe(env.repo)
  })

  test('a project that is not on the allow list is reported as not allowed', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: ['/somewhere/else'] })

    const result = inspect(env)
    expect(result.projectAllowed).toBe(false)
    expect(result.allowProjectSources).toEqual(['/somewhere/else'])
  })

  test('search is enabled unless a user-level file switches it off', () => {
    const env = makeEnv()
    expect(inspect(env).enabled).toBe(true)
    writeLocal(env, { enabled: false })
    expect(inspect(env).enabled).toBe(false)
  })

  test('a source and an allow entry defined in a local file appear with the local layer', () => {
    const env = makeEnv()
    const root = mkRoot(env, 'wiki')
    writeUser(env, { sources: [userSource('base', [env.repo], root)] })
    writeLocal(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('wiki', [env.repo], root)],
    })

    const result = inspect(env)
    expect(result.projectAllowed).toBe(true)
    expect(result.allowProjectSources).toEqual([env.repo])
    expect(find(result.sources, 'base')?.origin).toBe('user')
    const wiki = find(result.sources, 'wiki')
    expect(wiki?.origin).toBe('user.local')
    expect(wiki).toMatchObject({
      status: 'active',
      format: 'markdown',
      roots: [{ path: root, present: true }],
      exclude: [],
    })
  })

  test('a custom-directory source carries the custom layer', () => {
    const env = makeEnv()
    const custom = path.join(env.homeDir, 'custom')
    fs.mkdirSync(custom, { recursive: true })
    const root = mkRoot(env, 'notes')
    fs.writeFileSync(
      path.join(custom, 'systematic.local.json'),
      JSON.stringify({
        search: { sources: [userSource('notes', [env.repo], root)] },
      }),
    )

    const result = inspectSearch({
      checkoutRoot: env.repo,
      configOptions: { homeDir: env.homeDir, customConfigDir: custom },
    })
    expect(find(result.sources, 'notes')?.origin).toBe('custom.local')
  })

  test('one fixture produces active, missing root, over source cap and dropped invalid', () => {
    const env = makeEnv()
    const present = mkRoot(env, 'present')
    const sources = [
      userSource('active-one', [env.repo], present),
      userSource('gone', [env.repo], path.join(env.homeDir, 'no-such-root')),
      ...Array.from({ length: 6 }, (_, index) =>
        userSource(`fill${index}`, [env.repo], present),
      ),
      userSource('ninth', [env.repo], present),
      { name: 'broken', format: 'markdown', roots: ['relative/root'] },
    ]
    writeUser(env, { allow_project_sources: [env.repo], sources })

    const result = inspect(env)
    expect(find(result.sources, 'active-one')?.status).toBe('active')
    expect(find(result.sources, 'gone')).toMatchObject({
      status: 'missing root',
      roots: [{ path: path.join(env.homeDir, 'no-such-root'), present: false }],
    })
    expect(find(result.sources, 'ninth')?.status).toBe('over source cap')
    const broken = find(result.sources, 'broken')
    expect(broken).toMatchObject({ status: 'dropped invalid', origin: 'user' })
    expect(broken && 'reason' in broken ? broken.reason : '').toContain('root')
    expect(
      result.sources.filter((source) => source.status === 'active'),
    ).toHaveLength(MAX_ACTIVE_SOURCES - 1)
  })

  test('an allowed project proposal beyond the cap is over source cap; one within it is active', () => {
    const env = makeEnv()
    const present = mkRoot(env, 'present')
    fs.mkdirSync(path.join(env.repo, 'docs/decisions'), { recursive: true })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: Array.from({ length: MAX_ACTIVE_SOURCES }, (_, index) =>
        userSource(`u${index}`, [env.repo], present),
      ),
    })
    writeProject(env.repo, { sources: [projectSource('decisions')] })

    const result = inspect(env)
    expect(find(result.sources, 'decisions')).toMatchObject({
      status: 'over source cap',
      origin: 'project',
    })
  })

  test('a project proposal on the allow list is active when its root exists', () => {
    const env = makeEnv()
    fs.mkdirSync(path.join(env.repo, 'docs/decisions'), { recursive: true })
    writeUser(env, { allow_project_sources: [env.repo] })
    writeProject(env.repo, {
      sources: [projectSource('decisions'), projectSource('absent')],
    })

    const result = inspect(env)
    expect(find(result.sources, 'decisions')).toMatchObject({
      status: 'active',
      origin: 'project',
      roots: [{ path: path.join(env.repo, 'docs/decisions'), present: true }],
    })
    expect(find(result.sources, 'absent')?.status).toBe('missing root')
  })

  test('a project proposal off the allow list shows its name and roots as not allowed', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: ['/somewhere/else'] })
    writeProject(env.repo, {
      sources: [projectSource('quokka-notes', 'docs/quokka-vault')],
    })

    const result = inspect(env)
    expect(find(result.sources, 'quokka-notes')).toMatchObject({
      status: 'not allowed',
      origin: 'project',
      roots: [
        { path: path.join(env.repo, 'docs/quokka-vault'), present: null },
      ],
    })
  })

  test('a dropped project entry is listed with its reason', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [env.repo] })
    writeProject(env.repo, {
      sources: [
        { name: 'escape', format: 'markdown', roots: ['../outside'] },
        projectSource('fine'),
      ],
    })

    const dropped = find(inspect(env).sources, 'escape')
    expect(dropped).toMatchObject({
      status: 'dropped invalid',
      origin: 'project',
    })
  })

  test('an unreadable project file is flagged and proposes nothing', () => {
    const env = makeEnv()
    writeUser(env, { allow_project_sources: [env.repo] })
    fs.mkdirSync(path.join(env.repo, '.opencode'))
    fs.writeFileSync(path.join(env.repo, '.opencode/systematic.json'), '{ "s')

    const result = inspect(env)
    expect(result.projectConfigUnreadable).toBe(true)
    expect(result.sources).toEqual([])
    expect(result.warnings.join('\n')).toContain('could not be read')
  })

  test('a user source mapped only to other projects is left out', () => {
    const env = makeEnv()
    const root = mkRoot(env, 'elsewhere')
    writeUser(env, {
      sources: [
        userSource('theirs', ['/some/other/project'], root),
        userSource('mine', [env.repo], root),
      ],
    })

    const result = inspect(env)
    expect(find(result.sources, 'theirs')).toBeUndefined()
    expect(find(result.sources, 'mine')?.status).toBe('active')
  })

  test('a project proposal replaced by a same-named mapped user source is not listed', () => {
    const env = makeEnv()
    const root = mkRoot(env, 'shadow')
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [userSource('decisions', [env.repo], root)],
    })
    writeProject(env.repo, { sources: [projectSource('decisions')] })

    const result = inspect(env)
    const matching = result.sources.filter((s) => s.name === 'decisions')
    expect(matching).toHaveLength(1)
    expect(matching[0]?.origin).toBe('user')
  })

  test('a project proposal off the allow list is still listed when a mapped user source holds the same name', () => {
    const env = makeEnv()
    const root = mkRoot(env, 'wiki')
    writeUser(env, {
      allow_project_sources: ['/somewhere/else'],
      sources: [userSource('wiki', [env.repo], root)],
    })
    writeProject(env.repo, { sources: [projectSource('wiki')] })

    const rows = inspect(env)
      .sources.filter((source) => source.name === 'wiki')
      .map((source) => [source.origin, source.status])
    expect(rows).toEqual([
      ['user', 'active'],
      ['project', 'not allowed'],
    ])
  })

  describe('a project root the loader rejects', () => {
    const SYMLINK_ROOT = 'a project root is a symlink'
    const SYMLINK_ANCESTOR = 'a project root passes through a symlink'

    function layout(env: Env, roots: string[]): void {
      fs.mkdirSync(path.join(env.repo, 'real/sub'), { recursive: true })
      fs.writeFileSync(path.join(env.repo, 'real/sub/a.md'), '# A\n')
      fs.mkdirSync(path.join(env.repo, 'docs'), { recursive: true })
      fs.symlinkSync(
        path.join(env.repo, 'real'),
        path.join(env.repo, 'docs/linked'),
      )
      writeUser(env, { allow_project_sources: [env.repo] })
      writeProject(env.repo, {
        sources: roots.map((root, index) => ({
          name: `s${index}`,
          format: 'markdown',
          roots: [root],
        })),
      })
    }

    test('a root that is a symlink and a root below a symlink are not active, and the loader drops the same sources', () => {
      const env = makeEnv()
      layout(env, ['docs/linked', 'docs/linked/sub', 'real/sub'])

      const inspected = inspect(env)
      expect(find(inspected.sources, 's0')).toMatchObject({
        status: 'root rejected',
        origin: 'project',
        reason: SYMLINK_ROOT,
      })
      expect(find(inspected.sources, 's1')).toMatchObject({
        status: 'root rejected',
        reason: SYMLINK_ANCESTOR,
      })
      expect(find(inspected.sources, 's2')?.status).toBe('active')

      const loads = loadExternalSources({
        sources: resolveExternalSources({
          startDir: env.repo,
          configOptions: env.configOptions,
        }).sources,
        checkoutRoot: env.repo,
      })
      expect(loads.map((load) => [load.name, load.state])).toEqual([
        ['s0', 'dropped'],
        ['s1', 'dropped'],
        ['s2', 'loaded'],
      ])
    })

    test('a root whose real path leaves the checkout is rejected, and the loader drops it', () => {
      const env = makeEnv()
      const outside = makeDir('extsrc-outside-')
      fs.writeFileSync(path.join(outside, 'a.md'), '# Outside\n')
      fs.symlinkSync(outside, path.join(env.repo, 'via'))
      writeUser(env, { allow_project_sources: [env.repo] })
      writeProject(env.repo, { sources: [projectSource('escape', 'via')] })

      expect(find(inspect(env).sources, 'escape')).toMatchObject({
        status: 'root rejected',
        origin: 'project',
      })
      const loads = loadExternalSources({
        sources: resolveExternalSources({
          startDir: env.repo,
          configOptions: env.configOptions,
        }).sources,
        checkoutRoot: env.repo,
      })
      expect(loads.map((load) => load.state)).toEqual(['dropped'])
    })

    test('a user source with a symlinked root is not held to the checkout', () => {
      const env = makeEnv()
      const target = mkRoot(env, 'target')
      const link = path.join(env.homeDir, 'vaults/link')
      fs.symlinkSync(target, link)
      writeUser(env, { sources: [userSource('wiki', [env.repo], link)] })

      expect(find(inspect(env).sources, 'wiki')?.status).toBe('active')
    })
  })

  describe('a warning belongs to the declaration that produced it', () => {
    const BAD_EXCLUDE = ['[bad]']
    const userFile = (env: Env) =>
      path.join(env.userConfigDir, 'systematic.json')
    const localFile = (env: Env) =>
      path.join(env.userConfigDir, 'systematic.local.json')
    const projectFile = (env: Env) =>
      path.join(env.repo, '.opencode/systematic.json')

    /** Every inspected row named `name`, with its status, origin and warnings. */
    function rowsNamed(env: Env, name: string) {
      return inspectSearch({
        checkoutRoot: env.repo,
        configOptions: env.configOptions,
      })
        .sources.filter((source) => source.name === name)
        .map((source) => ({
          status: source.status,
          origin: source.origin,
          warnings: source.warnings,
        }))
    }
    const sectionWarnings = (env: Env) =>
      inspectSearch({
        checkoutRoot: env.repo,
        configOptions: env.configOptions,
      }).warnings

    test('a valid user source and an invalid project source of one name each keep their own warning', () => {
      const env = makeEnv()
      const root = mkRoot(env, 'notes')
      writeUser(env, {
        allow_project_sources: [env.repo],
        sources: [
          { ...userSource('notes', [env.repo], root), exclude: BAD_EXCLUDE },
        ],
      })
      writeProject(env.repo, {
        sources: [{ name: 'notes', format: 'markdown', roots: ['..'] }],
      })

      const rows = rowsNamed(env, 'notes')
      expect(rows).toHaveLength(2)
      const valid = rows.find((row) => row.status === 'active')
      const dropped = rows.find((row) => row.status === 'dropped invalid')
      expect(valid?.warnings).toHaveLength(1)
      expect(valid?.warnings[0]).toContain('exclude[0]')
      expect(valid?.warnings[0]).toContain(userFile(env))
      expect(dropped?.origin).toBe('project')
      expect(dropped?.warnings).toHaveLength(1)
      expect(dropped?.warnings[0]).toContain('was dropped')
      expect(dropped?.warnings[0]).toContain(projectFile(env))
      expect(sectionWarnings(env)).toEqual([])
    })

    test('a valid project source and an invalid user source of one name each keep their own warning', () => {
      const env = makeEnv()
      writeUser(env, {
        allow_project_sources: [env.repo],
        sources: [{ name: 'notes', format: 'markdown', roots: ['/srv/notes'] }],
      })
      writeProject(env.repo, {
        sources: [{ ...projectSource('notes'), exclude: BAD_EXCLUDE }],
      })

      const rows = rowsNamed(env, 'notes')
      const valid = rows.find((row) => row.origin === 'project')
      const dropped = rows.find((row) => row.status === 'dropped invalid')
      expect(valid?.warnings).toHaveLength(1)
      expect(valid?.warnings[0]).toContain('exclude[0]')
      expect(dropped?.origin).toBe('user')
      expect(dropped?.warnings).toHaveLength(1)
      expect(dropped?.warnings[0]).toContain('was dropped')
      expect(dropped?.warnings[0]).toContain(userFile(env))
    })

    test('an invalid base entry and a valid local entry of one name: the valid row carries nothing from the base', () => {
      const env = makeEnv()
      const root = mkRoot(env, 'notes')
      writeUser(env, {
        sources: [{ name: 'notes', format: 'markdown', roots: ['/srv/notes'] }],
      })
      writeLocal(env, { sources: [userSource('notes', [env.repo], root)] })

      const rows = rowsNamed(env, 'notes')
      const valid = rows.find((row) => row.status === 'active')
      const dropped = rows.find((row) => row.status === 'dropped invalid')
      expect(valid?.origin).toBe('user.local')
      expect(valid?.warnings).toEqual([])
      expect(dropped?.warnings).toHaveLength(1)
      expect(dropped?.warnings[0]).toContain(userFile(env))
    })

    test('a valid base entry and an invalid local entry of one name: each row keeps its own warning', () => {
      const env = makeEnv()
      const root = mkRoot(env, 'notes')
      writeUser(env, {
        sources: [
          { ...userSource('notes', [env.repo], root), exclude: BAD_EXCLUDE },
        ],
      })
      writeLocal(env, {
        sources: [{ name: 'notes', format: 'markdown', roots: ['/srv/notes'] }],
      })

      const rows = rowsNamed(env, 'notes')
      const valid = rows.find((row) => row.status === 'active')
      const dropped = rows.find((row) => row.status === 'dropped invalid')
      expect(valid?.origin).toBe('user')
      expect(valid?.warnings).toHaveLength(1)
      expect(valid?.warnings[0]).toContain('exclude[0]')
      expect(valid?.warnings[0]).toContain(userFile(env))
      expect(dropped?.warnings).toHaveLength(1)
      expect(dropped?.warnings[0]).toContain('was dropped')
      expect(dropped?.warnings[0]).toContain(localFile(env))
    })

    test('a local entry that replaces a base entry leaves the base warning in the section list, not on the row', () => {
      const env = makeEnv()
      const root = mkRoot(env, 'notes')
      writeUser(env, {
        sources: [
          { ...userSource('notes', [env.repo], root), exclude: BAD_EXCLUDE },
        ],
      })
      writeLocal(env, { sources: [userSource('notes', [env.repo], root)] })

      const rows = rowsNamed(env, 'notes')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.origin).toBe('user.local')
      expect(rows[0]?.warnings).toEqual([])
      const section = sectionWarnings(env)
      expect(section).toHaveLength(1)
      expect(section[0]).toContain('exclude[0]')
      expect(section[0]).toContain(userFile(env))
    })

    test('two entries of one name in one file: the kept one keeps its warning and the repeat keeps its own', () => {
      const env = makeEnv()
      const root = mkRoot(env, 'notes')
      writeUser(env, {
        sources: [
          { ...userSource('notes', [env.repo], root), exclude: BAD_EXCLUDE },
          userSource('notes', [env.repo], root),
        ],
      })

      const rows = rowsNamed(env, 'notes')
      const valid = rows.find((row) => row.status === 'active')
      const dropped = rows.find((row) => row.status === 'dropped invalid')
      expect(valid?.warnings).toHaveLength(1)
      expect(valid?.warnings[0]).toContain('exclude[0]')
      expect(dropped?.warnings).toHaveLength(1)
      expect(dropped?.warnings[0]).toContain('already used')
    })
  })

  test('exclude patterns appear on the source and its warnings never carry pattern text', () => {
    const env = makeEnv()
    const root = mkRoot(env, 'wiki')
    writeUser(env, {
      sources: [
        {
          ...userSource('wiki', [env.repo], root),
          exclude: ['log.md', '[secret-pattern]', '.stryker-tmp'],
        },
        userSource('plain', [env.repo], root),
      ],
    })

    const result = inspect(env)
    const wiki = find(result.sources, 'wiki')
    expect(wiki && 'exclude' in wiki ? wiki.exclude : []).toEqual([
      'log.md',
      '.stryker-tmp',
    ])
    expect(wiki?.warnings).toHaveLength(1)
    expect(wiki?.warnings[0]).toContain('exclude[1]')
    expect(JSON.stringify(result)).not.toContain('secret-pattern')
    expect(find(result.sources, 'plain')?.warnings).toEqual([])
    // The warning belongs to the source, so the section list does not repeat it.
    expect(result.warnings).toEqual([])
  })

  test('lists the four built-in kinds with their directory and state', () => {
    const env = makeEnv()
    const docs = path.join(env.repo, 'docs')
    fs.mkdirSync(path.join(docs, 'solutions'), { recursive: true })
    fs.writeFileSync(path.join(docs, 'solutions/fix.md'), '# Fix\n')
    fs.mkdirSync(path.join(docs, 'plans'), { recursive: true })
    fs.writeFileSync(path.join(docs, 'plans/README.md'), '# Plans\n')

    const result = inspect(env)
    expect(result.builtIn.map((kind) => kind.kind)).toEqual([
      'solution',
      'plan',
      'brainstorm',
      'ideation',
    ])
    expect(result.builtIn).toEqual([
      {
        kind: 'solution',
        directory: path.join(docs, 'solutions'),
        state: 'present',
      },
      { kind: 'plan', directory: path.join(docs, 'plans'), state: 'empty' },
      {
        kind: 'brainstorm',
        directory: path.join(docs, 'brainstorms'),
        state: 'missing',
      },
      {
        kind: 'ideation',
        directory: path.join(docs, 'ideation'),
        state: 'missing',
      },
    ])
  })

  test.skipIf(process.getuid?.() === 0)(
    'a locked built-in directory is reported unreadable',
    () => {
      const env = makeEnv()
      const locked = path.join(env.repo, 'docs/ideation')
      fs.mkdirSync(locked, { recursive: true })
      fs.writeFileSync(path.join(locked, 'idea.md'), '# Idea\n')
      fs.chmodSync(locked, 0o000)
      try {
        const ideation = inspect(env).builtIn.find((k) => k.kind === 'ideation')
        expect(ideation?.state).toBe('unreadable')
      } finally {
        fs.chmodSync(locked, 0o755)
      }
    },
  )

  test('the active sources match what resolveExternalSources resolves', () => {
    const env = makeEnv()
    const present = mkRoot(env, 'present')
    fs.mkdirSync(path.join(env.repo, 'docs/decisions'), { recursive: true })
    writeUser(env, {
      allow_project_sources: [env.repo],
      sources: [
        userSource('one', [env.repo], present),
        userSource('other-project', ['/not/this/one'], present),
      ],
    })
    writeProject(env.repo, {
      sources: [projectSource('decisions'), projectSource('one')],
    })

    const resolved = resolveExternalSources({
      startDir: env.repo,
      configOptions: env.configOptions,
    })
    const inspected = inspect(env)
    expect(
      inspected.sources.filter((s) => s.status === 'active').map((s) => s.name),
    ).toEqual(names(resolved.sources))
  })

  test('reads no document and walks no external source', () => {
    const env = makeEnv()
    const root = mkRoot(env, 'wiki')
    fs.writeFileSync(path.join(root, 'entry.md'), '# Secret entry\n')
    fs.mkdirSync(path.join(env.repo, 'docs/solutions'), { recursive: true })
    fs.writeFileSync(path.join(env.repo, 'docs/solutions/fix.md'), '# Fix\n')
    writeUser(env, { sources: [userSource('wiki', [env.repo], root)] })

    const spies = [
      spyOn(fs, 'readFileSync'),
      spyOn(fs, 'openSync'),
      spyOn(fs, 'opendirSync'),
    ]
    let touched: string[] = []
    try {
      inspect(env)
      touched = spies.flatMap((spy) =>
        spy.mock.calls.flatMap((call) =>
          typeof call[0] === 'string' ? [call[0]] : [],
        ),
      )
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    expect(touched.length).toBeGreaterThan(0)
    expect(touched.filter((target) => target.endsWith('.md'))).toEqual([])
    expect(touched.some((target) => target.startsWith(root))).toBe(false)
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
