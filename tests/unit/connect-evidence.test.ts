import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildGitArgv,
  CONNECT_BOUNDS,
  checkCitation,
  extractCitations,
  GIT_HARDENING_ARGS,
  GIT_SUBCOMMANDS,
  gitEnvironment,
  inventoryProject,
  readContainedFile,
  reportProjectCitations,
  runGit,
} from '../../src/lib/connect-evidence.js'
import { MAX_DELEGATE_TURNS } from '../../src/lib/pi-delegate-tool.js'
import { cleanupTempDirs, git, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

const IS_ROOT = process.getuid?.() === 0

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** A repository whose files are all tracked (force-added, so ignore rules do not hide them). */
function createProject(files: Record<string, string>): string {
  const work = makeDir('connect-evidence-')
  git(work, ['init', '-q', '-b', 'main'])
  // No background maintenance: it would write into .git while a test snapshots it.
  git(work, ['config', 'gc.auto', '0'])
  git(work, ['config', 'maintenance.auto', 'false'])
  addFiles(work, files)
  git(work, ['commit', '-q', '-m', 'base', '--no-verify', '--allow-empty'])
  return work
}

function addFiles(work: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(work, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    git(work, ['add', '-f', '--', `:(literal)${rel}`])
  }
}

function listPaths(result: ReturnType<typeof inventoryProject>): string[] {
  if (result.status !== 'ok') throw new Error(`inventory ${result.status}`)
  return result.files.map((file) => file.path)
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile())
        out[path.relative(dir, full)] = sha256(fs.readFileSync(full))
      else out[path.relative(dir, full)] = 'non-file'
    }
  }
  walk(dir)
  return out
}

describe('bounds', () => {
  it('pins the frozen values, so a change is a deliberate edit of this list', () => {
    expect({ ...CONNECT_BOUNDS }).toEqual({
      maxFilesPerProject: 4000,
      maxFileBytes: 256 * 1024,
      maxHashedBytesPerProject: 32 * 1024 * 1024,
      maxListingBytes: 16 * 1024 * 1024,
      maxCitationsPerProject: 500,
      maxRulesPerFamily: 8,
      maxCandidatesPerBatch: 5,
      maxFamiliesPerRun: 6,
    })
  })

  it('sizes a family so that serial tool use still fits the Pi delegate turn cap', () => {
    // Three turns to orient and one to answer, then at most one search turn and
    // one read turn per rule when the model makes one call per turn.
    const fixedTurns = 3
    const turnsPerRule = 2
    expect(
      fixedTurns + turnsPerRule * CONNECT_BOUNDS.maxRulesPerFamily,
    ).toBeLessThanOrEqual(MAX_DELEGATE_TURNS)
    expect(
      fixedTurns + turnsPerRule * (CONNECT_BOUNDS.maxRulesPerFamily + 1),
    ).toBeGreaterThan(MAX_DELEGATE_TURNS - 1)
  })

  it('names every bound as a positive integer', () => {
    for (const key of [
      'maxFilesPerProject',
      'maxFileBytes',
      'maxHashedBytesPerProject',
      'maxRulesPerFamily',
      'maxCandidatesPerBatch',
      'maxFamiliesPerRun',
      'maxCitationsPerProject',
      'maxListingBytes',
    ] as const) {
      const value = CONNECT_BOUNDS[key]
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(CONNECT_BOUNDS)).toBe(true)
  })
})

describe('git boundary', () => {
  it('allows exactly ls-files, cat-file and check-ignore', () => {
    expect([...GIT_SUBCOMMANDS]).toEqual([
      'ls-files',
      'cat-file',
      'check-ignore',
    ])
  })

  it('puts the hardening flags before the subcommand and the arguments after it', () => {
    expect(buildGitArgv('ls-files', ['-z', '--cached', '--stage'])).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.untrackedCache=false',
      'ls-files',
      '-z',
      '--cached',
      '--stage',
    ])
    expect(GIT_HARDENING_ARGS).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.untrackedCache=false',
    ])
  })

  it('puts -- before path arguments, so a name that starts with - is a path', () => {
    expect(buildGitArgv('ls-files', ['-z'], ['-dash.json', 'b'])).toEqual([
      ...GIT_HARDENING_ARGS,
      'ls-files',
      '-z',
      '--',
      '-dash.json',
      'b',
    ])
    const work = createProject({
      '-dash.json': '{}\n',
      'docs/solutions/new\nline.md': '# nl\n',
      'other.json': '{}\n',
    })
    const run = runGit(work, 'ls-files', ['-z', '--cached'], {
      paths: ['-dash.json', 'docs/solutions/new\nline.md'],
    })
    if (run.status !== 'ok') throw new Error(run.status)
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString().split('\0').filter(Boolean)).toEqual([
      '-dash.json',
      'docs/solutions/new\nline.md',
    ])
  })

  it('refuses every other subcommand without spawning git', () => {
    const work = createProject({ 'a.json': '{}\n' })
    for (const subcommand of [
      'status',
      'diff',
      'log',
      'config',
      'fetch',
      '-c',
      '',
    ]) {
      const result = runGit(work, subcommand, [])
      expect(result.status).toBe('refused')
    }
  })

  it('builds a scrubbed environment: no inherited GIT_ variables, no optional locks, literal pathspecs', () => {
    const env = gitEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
      GIT_EXTERNAL_DIFF: '/bin/evil',
      SECRET_TOKEN: 'abc',
    })
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_LITERAL_PATHSPECS).toBeUndefined()
    expect(gitEnvironment({}, true).GIT_LITERAL_PATHSPECS).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/x')
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(env.SECRET_TOKEN).toBeUndefined()
  })

  it('is not redirected by GIT_DIR in the calling process', () => {
    const work = createProject({ 'a.json': '{}\n' })
    const decoy = createProject({ 'decoy.json': '{}\n' })
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(decoy, '.git')
    try {
      expect(listPaths(inventoryProject(work))).toEqual(['a.json'])
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })

  describe('fsmonitor hook (negative control)', () => {
    function plantHook(work: string): string {
      const dir = makeDir('connect-hook-')
      const marker = path.join(dir, 'fired')
      const hook = path.join(dir, 'hook.sh')
      fs.writeFileSync(
        hook,
        `#!/bin/sh\necho fired >> "${marker}"\nprintf '\\0'\n`,
        {
          mode: 0o755,
        },
      )
      git(work, ['config', 'core.fsmonitor', hook])
      return marker
    }

    function rawGit(work: string, args: readonly string[]): number {
      return (
        spawnSync('git', [...args], {
          cwd: work,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            HOME: makeDir('connect-hook-home-'),
            GIT_CONFIG_NOSYSTEM: '1',
          },
        }).status ?? -1
      )
    }

    it('fires under an unhardened git status, which is what the hardening prevents', () => {
      const work = createProject({ 'a.json': '{}\n' })
      const marker = plantHook(work)
      expect(rawGit(work, ['status'])).toBe(0)
      expect(fs.existsSync(marker)).toBe(true)
    })

    it('does not fire under the hardening flags, even for status', () => {
      const work = createProject({ 'a.json': '{}\n' })
      const marker = plantHook(work)
      expect(rawGit(work, [...GIT_HARDENING_ARGS, 'status'])).toBe(0)
      expect(fs.existsSync(marker)).toBe(false)
    })

    it('does not fire for the inventory or any allowed subcommand, and leaves .git unchanged', () => {
      const work = createProject({
        'docs/solutions/a.md': 'learning\n',
        'src/a.ts': 'export const a = 1\n',
      })
      const marker = plantHook(work)
      const before = snapshotTree(path.join(work, '.git'))
      expect(inventoryProject(work).status).toBe('ok')
      const listing = runGit(work, 'ls-files', ['-z', '--cached', '--stage'])
      expect(listing.status).toBe('ok')
      expect(
        runGit(work, 'check-ignore', ['-z', '--', 'src/a.ts']).status,
      ).toBe('ok')
      const sha = git(work, ['rev-parse', 'HEAD:src/a.ts'])
      expect(runGit(work, 'cat-file', ['-t', sha]).status).toBe('ok')
      expect(fs.existsSync(marker)).toBe(false)
      expect(snapshotTree(path.join(work, '.git'))).toEqual(before)
    })
  })

  it('reports git as unavailable instead of throwing', () => {
    const work = createProject({ 'a.json': '{}\n' })
    const result = inventoryProject(work, { gitBinary: '/nonexistent/git' })
    expect(result).toEqual({ status: 'failed', reason: 'git-unavailable' })
  })

  it('fails when the listing is larger than the listing cap', () => {
    const work = createProject({ 'a.json': '{}\n', 'b.json': '{}\n' })
    const result = inventoryProject(work, { bounds: { maxListingBytes: 8 } })
    expect(result).toEqual({ status: 'failed', reason: 'listing-too-large' })
  })
})

describe('inventoryProject: identity', () => {
  it('reads a main checkout and returns its realpath', () => {
    const work = createProject({ 'a.json': '{}\n' })
    const result = inventoryProject(work)
    expect(result.status).toBe('ok')
    if (result.status === 'ok')
      expect(result.mainRoot).toBe(fs.realpathSync(work))
  })

  it('refuses a subdirectory, a linked worktree and a stale path, reusing the allow-entry reasons', () => {
    const work = createProject({ 'sub/a.json': '{}\n' })
    expect(inventoryProject(path.join(work, 'sub'))).toEqual({
      status: 'unmatched',
      reason: 'not-main-root',
    })
    const linked = path.join(makeDir('connect-wt-'), 'wt')
    git(work, ['worktree', 'add', '-q', '-b', 'other', linked])
    expect(inventoryProject(linked)).toEqual({
      status: 'unmatched',
      reason: 'not-main-root',
    })
    expect(inventoryProject(path.join(work, 'missing'))).toEqual({
      status: 'unmatched',
      reason: 'stale',
    })
  })
})

describe('inventoryProject: eligibility', () => {
  it('lists tracked corpus, workflow, config and code files with role, size and hash', () => {
    const files = {
      'docs/solutions/best-practices/x.md': '# x\n',
      'docs/plans/p.md': '# p\n',
      'docs/brainstorms/b.md': '# b\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      'package.json': '{"name":"x"}\n',
      'src/a.ts': 'export const a = 1\n',
    }
    const work = createProject(files)
    const result = inventoryProject(work)
    if (result.status !== 'ok') throw new Error(result.status)
    const byPath = new Map(result.files.map((file) => [file.path, file]))
    expect(byPath.get('docs/solutions/best-practices/x.md')?.role).toBe(
      'learning',
    )
    expect(byPath.get('docs/plans/p.md')?.role).toBe('plan')
    expect(byPath.get('docs/brainstorms/b.md')?.role).toBe('brainstorm')
    expect(byPath.get('.github/workflows/ci.yml')?.role).toBe('workflow')
    expect(byPath.get('package.json')?.role).toBe('config')
    expect(byPath.get('src/a.ts')?.role).toBe('code')
    for (const [rel, content] of Object.entries(files)) {
      expect(byPath.get(rel)?.sha256).toBe(sha256(content))
      expect(byPath.get(rel)?.bytes).toBe(Buffer.byteLength(content))
    }
  })

  it('orders corpus files before workflows, config and code', () => {
    const work = createProject({
      'src/a.ts': 'export const a = 1\n',
      'package.json': '{}\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      'docs/solutions/x.md': '# x\n',
      'docs/plans/p.md': '# p\n',
      'docs/brainstorms/b.md': '# b\n',
    })
    expect(listPaths(inventoryProject(work))).toEqual([
      'docs/solutions/x.md',
      'docs/plans/p.md',
      'docs/brainstorms/b.md',
      '.github/workflows/ci.yml',
      'package.json',
      'src/a.ts',
    ])
  })

  it('leaves out files that are not evidence: other documents, lockfiles, vendored code, env files', () => {
    const work = createProject({
      'README.md': '# readme\n',
      'bun.lock': '{}\n',
      'package-lock.json': '{}\n',
      'node_modules/dep/index.js': 'x\n',
      '.env': 'TOKEN=1\n',
      'src/keep.ts': 'export const keep = 1\n',
    })
    expect(listPaths(inventoryProject(work))).toEqual(['src/keep.ts'])
  })

  describe('exclusions', () => {
    // Each name is paired with a sibling the exclusion must not catch. A name
    // whose extension is outside the config and code lists would be dropped
    // anyway, so the `decisive` entries carry an extension the lists accept:
    // only the exclusion rule keeps them out.
    const EXCLUDED: ReadonlyArray<{
      readonly name: string
      readonly decisive: boolean
      readonly sibling: string
    }> = [
      { name: '.env', decisive: false, sibling: 'environment.json' },
      { name: '.env.local', decisive: false, sibling: 'environment.json' },
      { name: '.env.json', decisive: true, sibling: 'environment.json' },
      {
        name: '.env.production.yml',
        decisive: true,
        sibling: 'environment.yml',
      },
      { name: 'src/.env.ts', decisive: true, sibling: 'src/environment.ts' },
      { name: 'node_modules/x.js', decisive: true, sibling: 'src/x.js' },
      {
        name: 'node_modules/pkg/config.json',
        decisive: true,
        sibling: 'pkg/config.json',
      },
      {
        name: 'package-lock.json',
        decisive: true,
        sibling: 'package-locks.json',
      },
      { name: 'pnpm-lock.yaml', decisive: true, sibling: 'pnpm-locks.yaml' },
      { name: 'bun.lockb', decisive: false, sibling: 'src/bun.ts' },
      { name: 'Cargo.lock', decisive: false, sibling: 'src/lockfile.ts' },
      { name: 'yarn.lock', decisive: false, sibling: 'src/lockfile.ts' },
      { name: 'go.sum', decisive: false, sibling: 'src/sum.go' },
      { name: 'dist/app.min.js', decisive: true, sibling: 'dist/app.js' },
      { name: 'dist/app.js.map', decisive: false, sibling: 'dist/app.js' },
    ]

    for (const { name, sibling } of EXCLUDED) {
      it(`leaves out ${name} and keeps its sibling ${sibling}`, () => {
        const work = createProject({
          [name]: '{}\n',
          [sibling]: sibling.endsWith('.go')
            ? 'package main\n'
            : 'export const sibling = 1\n',
        })
        const result = inventoryProject(work)
        expect(listPaths(result)).toEqual([sibling])
        if (result.status === 'ok') expect(result.excluded.ineligible).toBe(1)
      })
    }

    it('leaves out all of them together, counts each one, and keeps every sibling', () => {
      const files: Record<string, string> = {}
      for (const { name, sibling } of EXCLUDED) {
        files[name] = '{}\n'
        files[sibling] = sibling.endsWith('.go')
          ? 'package main\n'
          : 'export const sibling = 1\n'
      }
      const result = inventoryProject(createProject(files))
      if (result.status !== 'ok') throw new Error(result.status)
      const siblings = new Set(EXCLUDED.map((item) => item.sibling))
      expect(result.files.map((file) => file.path).sort()).toEqual(
        [...siblings].sort(),
      )
      expect(result.excluded.ineligible).toBe(EXCLUDED.length)
      expect(result.skippedCount).toBe(0)
    })

    it('matches the node_modules directory name only, not a longer name', () => {
      const work = createProject({
        'node_modules_notes/a.ts': 'export const a = 1\n',
        'src/node_modules.ts': 'export const b = 1\n',
      })
      expect(listPaths(inventoryProject(work)).sort()).toEqual([
        'node_modules_notes/a.ts',
        'src/node_modules.ts',
      ])
    })
  })

  it('excludes untracked files and untracked ignored files', () => {
    const work = createProject({ 'src/tracked.ts': 'export const t = 1\n' })
    fs.writeFileSync(
      path.join(work, 'src/untracked.ts'),
      'export const u = 1\n',
    )
    fs.writeFileSync(path.join(work, '.gitignore'), 'ignored.ts\n')
    fs.writeFileSync(path.join(work, 'ignored.ts'), 'export const i = 1\n')
    expect(listPaths(inventoryProject(work))).toEqual(['src/tracked.ts'])
  })

  it('excludes a tracked file that an ignore rule matches', () => {
    const work = createProject({
      'src/keep.ts': 'export const k = 1\n',
      'src/forced.ts': 'export const f = 1\n',
    })
    fs.writeFileSync(path.join(work, '.gitignore'), 'forced.ts\n')
    const result = inventoryProject(work)
    expect(listPaths(result)).toEqual(['src/keep.ts'])
    if (result.status === 'ok') expect(result.excluded.ignored).toBe(1)
  })

  it('drops a tracked symlink that points outside the repository', () => {
    const work = createProject({ 'src/keep.ts': 'export const k = 1\n' })
    const outside = path.join(makeDir('connect-outside-'), 'secret.md')
    fs.writeFileSync(outside, 'secret\n')
    fs.mkdirSync(path.join(work, 'docs/solutions'), { recursive: true })
    fs.symlinkSync(outside, path.join(work, 'docs/solutions/link.md'))
    git(work, ['add', '-f', '--', 'docs/solutions/link.md'])
    const result = inventoryProject(work)
    expect(listPaths(result)).toEqual(['src/keep.ts'])
    if (result.status === 'ok') expect(result.excluded.symlinks).toBe(1)
  })

  it('drops a submodule entry', () => {
    const work = createProject({ 'src/keep.ts': 'export const k = 1\n' })
    const head = git(work, ['rev-parse', 'HEAD'])
    git(work, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${head},vendor/sub`,
    ])
    const result = inventoryProject(work)
    expect(listPaths(result)).toEqual(['src/keep.ts'])
    if (result.status === 'ok') expect(result.excluded.submodules).toBe(1)
  })

  it('lists a name that starts with -, a name with a newline and a name that looks like pathspec magic', () => {
    const work = createProject({
      '-dash.json': '{}\n',
      'docs/solutions/new\nline.md': '# nl\n',
      ':(top)magic.json': '{}\n',
    })
    expect(listPaths(inventoryProject(work)).sort()).toEqual(
      [':(top)magic.json', '-dash.json', 'docs/solutions/new\nline.md'].sort(),
    )
  })

  it('applies the ignore filter to a name that starts with -', () => {
    const work = createProject({ '-keep.json': '{}\n', '-gone.json': '{}\n' })
    fs.writeFileSync(path.join(work, '.gitignore'), '/-gone.json\n')
    expect(listPaths(inventoryProject(work))).toEqual(['-keep.json'])
  })

  it('skips a listed file whose working copy became a symlink', () => {
    const work = createProject({ 'src/a.ts': 'export const a = 1\n' })
    fs.rmSync(path.join(work, 'src/a.ts'))
    fs.symlinkSync('/etc/hosts', path.join(work, 'src/a.ts'))
    const result = inventoryProject(work)
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.files).toEqual([])
    expect(result.skipped).toEqual([{ path: 'src/a.ts', reason: 'symlink' }])
    expect(result.skippedCount).toBe(1)
  })

  it('skips a file over the per-file cap and a file that is missing from the working tree', () => {
    const work = createProject({
      'src/big.ts': `export const big = '${'x'.repeat(200)}'\n`,
      'src/small.ts': 'export const s = 1\n',
      'src/gone.ts': 'export const g = 1\n',
    })
    fs.rmSync(path.join(work, 'src/gone.ts'))
    const result = inventoryProject(work, { bounds: { maxFileBytes: 100 } })
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.files.map((file) => file.path)).toEqual(['src/small.ts'])
    expect(result.skipped).toEqual([
      { path: 'src/big.ts', reason: 'too-large' },
      { path: 'src/gone.ts', reason: 'missing' },
    ])
    expect(result.truncated).toEqual({ files: false, hashCap: false })
  })
})

describe('inventoryProject: caps', () => {
  it('stops at the hashing cap and flags truncation', () => {
    const body = 'x'.repeat(40)
    const work = createProject({
      'src/a.ts': body,
      'src/b.ts': body,
      'src/c.ts': body,
    })
    const result = inventoryProject(work, {
      bounds: { maxHashedBytesPerProject: 90 },
    })
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.files.map((file) => file.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    expect(result.truncated.hashCap).toBe(true)
    expect(result.truncated.files).toBe(false)
  })

  it('stops at the file-count cap, keeps corpus files first and flags truncation', () => {
    const work = createProject({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 1\n',
      'docs/solutions/x.md': '# x\n',
    })
    const result = inventoryProject(work, { bounds: { maxFilesPerProject: 2 } })
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.files.map((file) => file.path)).toEqual([
      'docs/solutions/x.md',
      'src/a.ts',
    ])
    expect(result.truncated.files).toBe(true)
  })

  it('does not change the repository: git state and working tree are the same after', () => {
    const work = createProject({
      'docs/solutions/x.md': '# x\n',
      'src/a.ts': 'export const a = 1\n',
    })
    const before = snapshotTree(work)
    inventoryProject(work)
    expect(snapshotTree(work)).toEqual(before)
  })
})

describe('readContainedFile', () => {
  function project(files: Record<string, string> = {}): string {
    const dir = makeDir('connect-read-')
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
    return dir
  }

  it('reads a regular file with its hash', () => {
    const dir = project({ 'src/a.ts': 'export const a = 1\n' })
    const result = readContainedFile(dir, 'src/a.ts')
    expect(result.kind).toBe('bytes')
    if (result.kind === 'bytes') {
      expect(result.bytes.toString()).toBe('export const a = 1\n')
      expect(result.sha256).toBe(sha256('export const a = 1\n'))
    }
  })

  it('rejects a path that escapes the root, an absolute path and malformed paths', () => {
    const dir = project({ 'src/a.ts': 'x\n' })
    const outside = path.join(makeDir('connect-outside-'), 'o.ts')
    fs.writeFileSync(outside, 'secret\n')
    for (const rel of [
      '../../outside',
      '../o.ts',
      'src/../../o.ts',
      'src/../src/a.ts',
      './src/a.ts',
      outside,
      '/etc/hosts',
      '',
      'src//a.ts',
      'src/a.ts/',
      'src/\0a.ts',
    ]) {
      expect(readContainedFile(dir, rel)).toEqual({
        kind: 'refused',
        reason: 'outside-root',
      })
    }
  })

  it('rejects a path through a symlinked directory', () => {
    const dir = project({ 'real/a.ts': 'x\n' })
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'linked'))
    expect(readContainedFile(dir, 'linked/a.ts')).toEqual({
      kind: 'refused',
      reason: 'symlink',
    })
  })

  it('rejects a final component that is a symlink, even to a file inside the root', () => {
    const dir = project({ 'real.ts': 'x\n' })
    fs.symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'link.ts'))
    expect(readContainedFile(dir, 'link.ts')).toEqual({
      kind: 'refused',
      reason: 'symlink',
    })
  })

  it('reports a missing file and a missing directory', () => {
    const dir = project({ 'src/a.ts': 'x\n' })
    expect(readContainedFile(dir, 'src/none.ts')).toEqual({
      kind: 'refused',
      reason: 'missing',
    })
    expect(readContainedFile(dir, 'nodir/none.ts')).toEqual({
      kind: 'refused',
      reason: 'missing',
    })
  })

  it('reports a FIFO as not a regular file without blocking', () => {
    const dir = project()
    const fifo = path.join(dir, 'pipe.ts')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    expect(readContainedFile(dir, 'pipe.ts')).toEqual({
      kind: 'refused',
      reason: 'not-regular',
    })
  })

  it('reports a directory as not a regular file', () => {
    const dir = project({ 'src/a.ts': 'x\n' })
    expect(readContainedFile(dir, 'src')).toEqual({
      kind: 'refused',
      reason: 'not-regular',
    })
  })

  it('refuses a file over the cap', () => {
    const dir = project({ 'big.ts': 'x'.repeat(50) })
    expect(readContainedFile(dir, 'big.ts', { maxBytes: 49 })).toEqual({
      kind: 'refused',
      reason: 'too-large',
    })
    expect(readContainedFile(dir, 'big.ts', { maxBytes: 50 }).kind).toBe(
      'bytes',
    )
  })

  it.skipIf(IS_ROOT)('reports an unreadable file', () => {
    const dir = project({ 'secret.ts': 'x\n' })
    fs.chmodSync(path.join(dir, 'secret.ts'), 0o000)
    expect(readContainedFile(dir, 'secret.ts')).toEqual({
      kind: 'refused',
      reason: 'unreadable',
    })
  })

  it('fails the identity check when the file is replaced by a symlink after the lstat', () => {
    const dir = project({ 'a.ts': 'x\n' })
    const outside = path.join(makeDir('connect-outside-'), 'o.ts')
    fs.writeFileSync(outside, 'secret\n')
    const result = readContainedFile(dir, 'a.ts', {
      beforeOpen: () => {
        fs.rmSync(path.join(dir, 'a.ts'))
        fs.symlinkSync(outside, path.join(dir, 'a.ts'))
      },
    })
    expect(result).toEqual({ kind: 'refused', reason: 'changed' })
  })

  it('refuses a symlink swapped in after the lstat even when it points at the same inode', () => {
    const dir = project({ 'a.ts': 'x\n' })
    const result = readContainedFile(dir, 'a.ts', {
      beforeOpen: () => {
        fs.linkSync(path.join(dir, 'a.ts'), path.join(dir, 'twin.ts'))
        fs.rmSync(path.join(dir, 'a.ts'))
        fs.symlinkSync(path.join(dir, 'twin.ts'), path.join(dir, 'a.ts'))
      },
    })
    expect(result).toEqual({ kind: 'refused', reason: 'changed' })
  })

  it('fails the identity check when another regular file takes the path after the lstat', () => {
    const dir = project({ 'a.ts': 'x\n', 'b.ts': 'other\n' })
    const result = readContainedFile(dir, 'a.ts', {
      beforeOpen: () => {
        fs.renameSync(path.join(dir, 'b.ts'), path.join(dir, 'a.ts'))
      },
    })
    expect(result).toEqual({ kind: 'refused', reason: 'changed' })
  })

  it('fails when an ancestor directory becomes a symlink to the same file after the walk', () => {
    const dir = project({ 'sub/a.ts': 'x\n' })
    const result = readContainedFile(dir, 'sub/a.ts', {
      beforeOpen: () => {
        fs.renameSync(path.join(dir, 'sub'), path.join(dir, 'sub-real'))
        fs.symlinkSync(path.join(dir, 'sub-real'), path.join(dir, 'sub'))
      },
    })
    expect(result).toEqual({ kind: 'refused', reason: 'changed' })
  })
})

describe('checkCitation', () => {
  const source = [
    'line one',
    'export function targetThing() {',
    '  return 1',
    '}',
    'line five',
    'line six',
    'export function alphaBetaAsync() {}',
    '',
  ].join('\n')

  function project(): string {
    const dir = makeDir('connect-cite-')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src/a.ts'), source)
    return dir
  }

  it('passes when the symbol is in the cited span', () => {
    const dir = project()
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 2,
        end: 3,
        symbol: 'targetThing',
      }),
    ).toEqual({ verdict: 'passed' })
  })

  it('passes a single-line span and a span that ends on the last line', () => {
    const dir = project()
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 2,
        end: 2,
        symbol: 'targetThing',
      }).verdict,
    ).toBe('passed')
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 7,
        end: 7,
        symbol: 'alphaBetaAsync',
      }).verdict,
    ).toBe('passed')
  })

  it('reports not-in-span with found-elsewhere when the symbol moved out of its span', () => {
    const dir = project()
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 5,
        end: 6,
        symbol: 'targetThing',
      }),
    ).toEqual({ verdict: 'not-in-span', foundElsewhere: true })
  })

  it('reports not-in-span without found-elsewhere when the symbol is gone from the file', () => {
    const dir = project()
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 2,
        end: 3,
        symbol: 'vanishedThing',
      }),
    ).toEqual({ verdict: 'not-in-span', foundElsewhere: false })
  })

  it('matches whole names only', () => {
    const dir = project()
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 7,
        end: 7,
        symbol: 'alphaBeta',
      }),
    ).toEqual({ verdict: 'not-in-span', foundElsewhere: false })
  })

  it('treats a span past the end of the file as not in span', () => {
    const dir = project()
    expect(
      checkCitation(dir, {
        path: 'src/a.ts',
        start: 40,
        end: 50,
        symbol: 'targetThing',
      }),
    ).toEqual({ verdict: 'not-in-span', foundElsewhere: true })
  })

  it('is unchecked when no symbol is named', () => {
    const dir = project()
    for (const symbol of [undefined, '', '   ', 'two words', 'a'.repeat(300)]) {
      expect(
        checkCitation(dir, { path: 'src/a.ts', start: 2, end: 3, symbol }),
      ).toEqual({
        verdict: 'unchecked',
        reason: 'no-symbol',
      })
    }
  })

  it('is unchecked for an invalid span', () => {
    const dir = project()
    for (const [start, end] of [
      [0, 3],
      [3, 2],
      [-1, 2],
      [1.5, 2],
      [Number.NaN, 2],
    ] as const) {
      expect(
        checkCitation(dir, {
          path: 'src/a.ts',
          start,
          end,
          symbol: 'targetThing',
        }),
      ).toEqual({ verdict: 'unchecked', reason: 'invalid-span' })
    }
  })

  it('is unchecked with a containment reason for an escaping, absolute or symlinked path', () => {
    const dir = project()
    fs.symlinkSync(path.join(dir, 'src'), path.join(dir, 'linked'))
    const symbol = 'targetThing'
    expect(
      checkCitation(dir, { path: '../../outside', start: 1, end: 2, symbol }),
    ).toEqual({
      verdict: 'unchecked',
      reason: 'outside-root',
    })
    expect(
      checkCitation(dir, { path: '/etc/hosts', start: 1, end: 2, symbol }),
    ).toEqual({
      verdict: 'unchecked',
      reason: 'outside-root',
    })
    expect(
      checkCitation(dir, { path: 'linked/a.ts', start: 1, end: 2, symbol }),
    ).toEqual({
      verdict: 'unchecked',
      reason: 'symlink',
    })
  })

  it('is unchecked with a read-failure reason for a FIFO, an oversize file and a missing file', () => {
    const dir = project()
    expect(spawnSync('mkfifo', [path.join(dir, 'pipe.ts')]).status).toBe(0)
    const symbol = 'targetThing'
    expect(
      checkCitation(dir, { path: 'pipe.ts', start: 1, end: 1, symbol }),
    ).toEqual({
      verdict: 'unchecked',
      reason: 'not-regular',
    })
    expect(
      checkCitation(
        dir,
        { path: 'src/a.ts', start: 1, end: 1, symbol },
        { maxBytes: 10 },
      ),
    ).toEqual({ verdict: 'unchecked', reason: 'too-large' })
    expect(
      checkCitation(dir, { path: 'src/none.ts', start: 1, end: 1, symbol }),
    ).toEqual({
      verdict: 'unchecked',
      reason: 'missing',
    })
  })
})

describe('extractCitations', () => {
  it('takes the path, span and the identifier the citing sentence names', () => {
    const found = extractCitations(
      'The guard lives in `src/lib/a.ts:10-20`, where `parseThing` checks input.\n',
    )
    expect(found).toEqual([
      {
        path: 'src/lib/a.ts',
        start: 10,
        end: 20,
        symbol: 'parseThing',
        line: 1,
      },
    ])
  })

  it('reads a single line and leaves the symbol out when the sentence names none', () => {
    expect(extractCitations('See src/a.ts:7 for the rule.\n')).toEqual([
      { path: 'src/a.ts', start: 7, end: 7, line: 1 },
    ])
  })

  it('uses a symbol from the same sentence only', () => {
    const found = extractCitations(
      'The first one is `OTHER_NAME` here. See src/a.ts:7 now.\n',
    )
    expect(found).toEqual([{ path: 'src/a.ts', start: 7, end: 7, line: 1 }])
  })

  it('follows a sentence across wrapped lines and reports the citation line', () => {
    const found = extractCitations(
      'Intro line.\nThe check in `loadSettings`\nis at src/a.ts:42.\n',
    )
    expect(found).toEqual([
      { path: 'src/a.ts', start: 42, end: 42, symbol: 'loadSettings', line: 3 },
    ])
  })

  it('ignores URLs, stack frames, parent paths, absolute paths and fenced blocks', () => {
    const text = [
      'See https://example.com/a.ts:10 for details.',
      'The trace is src/a.ts:10:5 here.',
      'Do not follow ../x.ts:3 or /etc/passwd.txt:4.',
      '```',
      'src/fenced.ts:1',
      '```',
      '',
    ].join('\n')
    expect(extractCitations(text)).toEqual([])
  })

  it('ignores a sentence boundary inside backticks', () => {
    const found = extractCitations('Use `a_b.c_d` at src/a.ts:3.\n')
    expect(found).toEqual([
      { path: 'src/a.ts', start: 3, end: 3, symbol: 'a_b.c_d', line: 1 },
    ])
  })
})

describe('reportProjectCitations', () => {
  function project(): string {
    const dir = makeDir('connect-report-')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(
      path.join(dir, 'src/a.ts'),
      'line\nexport function targetThing() {}\nline\n',
    )
    return dir
  }

  it('checks every citation in the documents and names the document and line', () => {
    const dir = project()
    const report = reportProjectCitations(dir, [
      {
        path: 'docs/solutions/a.md',
        text: 'Held in `targetThing`, src/a.ts:2.\n',
      },
      {
        path: 'docs/solutions/b.md',
        text: 'Moved: `targetThing` at src/a.ts:1.\n',
      },
      { path: 'docs/solutions/c.md', text: 'No symbol at src/a.ts:3.\n' },
    ])
    expect(report.unsupported).toBe(false)
    expect(report.truncated).toBe(false)
    expect(
      report.citations.map((item) => [item.document, item.line, item.result]),
    ).toEqual([
      ['docs/solutions/a.md', 1, { verdict: 'passed' }],
      [
        'docs/solutions/b.md',
        1,
        { verdict: 'not-in-span', foundElsewhere: true },
      ],
      ['docs/solutions/c.md', 1, { verdict: 'unchecked', reason: 'no-symbol' }],
    ])
  })

  it('flags a project with no path-and-line citations as unsupported', () => {
    const dir = project()
    const report = reportProjectCitations(dir, [
      { path: 'docs/solutions/a.md', text: 'Prose with no citation at all.\n' },
    ])
    expect(report).toEqual({
      unsupported: true,
      citations: [],
      truncated: false,
    })
    expect(reportProjectCitations(dir, [])).toEqual({
      unsupported: true,
      citations: [],
      truncated: false,
    })
  })

  it('stops at the citation cap and flags truncation', () => {
    const dir = project()
    const text = Array.from(
      { length: 5 },
      () => 'Held in `targetThing`, src/a.ts:2.',
    ).join('\n')
    const report = reportProjectCitations(
      dir,
      [{ path: 'docs/solutions/a.md', text }],
      {
        bounds: { maxCitationsPerProject: 3 },
      },
    )
    expect(report.citations).toHaveLength(3)
    expect(report.truncated).toBe(true)
  })
})
