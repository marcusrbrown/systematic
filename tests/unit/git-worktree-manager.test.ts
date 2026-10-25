import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  advanceOrigin,
  breakRemote,
  cleanupTempDirs,
  commitFiles,
  create,
  createBareRepo,
  createCoreBareRepo,
  createdFields,
  createRepo,
  createSeparateGitDirRepo,
  createSubmoduleRepo,
  fields,
  git,
  gitStatus,
  makeDir,
  rows,
  run,
} from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

describe('create: placement', () => {
  it('places the worktree at <root>/.worktrees/<branch> and prints the contract', () => {
    const repo = createRepo()
    const result = run(['create', 'feat/x'], { cwd: repo.work })

    expect(result.status).toBe(0)
    const out = createdFields(result.stdout)
    expect(out.branch).toBe('feat/x')
    expect(out.base).toBe('origin/main')
    expect(out.path).toBe(path.join(repo.work, '.worktrees/feat/x'))
    expect(result.stdout.trim().split('\n').pop()).toBe(`path=${out.path}`)
    expect(git(out.path ?? '', ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
      'feat/x',
    )
    expect(git(out.path ?? '', ['rev-parse', 'HEAD'])).toBe(
      git(repo.work, ['rev-parse', 'origin/main']),
    )
  })

  it('lands at the main root when run from a subdirectory', () => {
    const repo = createRepo({ files: { 'src/a.txt': 'a\n' } })
    const result = run(['create', 'fix/y'], {
      cwd: path.join(repo.work, 'src'),
    })

    expect(result.status).toBe(0)
    expect(createdFields(result.stdout).path).toBe(
      path.join(repo.work, '.worktrees/fix/y'),
    )
  })

  it('lands at the main root when run from inside a linked worktree', () => {
    const repo = createRepo()
    const first = create(repo.work, 'feat/a')
    const result = run(['create', 'feat/b'], { cwd: first })

    expect(result.status).toBe(0)
    expect(createdFields(result.stdout).path).toBe(
      path.join(repo.work, '.worktrees/feat/b'),
    )
  })

  it.each([
    ['a bare repository', () => createBareRepo()],
    ['core.bare', () => createCoreBareRepo()],
    ['a separate git dir', () => createSeparateGitDirRepo()],
    ['a submodule', () => createSubmoduleRepo()],
  ])('refuses %s with exit 3 unsupported-layout', (_label, setup) => {
    const cwd = setup()
    const result = run(['create', 'feat/x'], { cwd })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('error: unsupported-layout:')
    expect(fs.existsSync(path.join(cwd, '.worktrees'))).toBe(false)
  })
})

describe('create: ignore policy', () => {
  it('writes .worktrees/.gitignore once, leaves root .gitignore alone and status clean', () => {
    const repo = createRepo()
    create(repo.work, 'feat/a')
    const ignore = path.join(repo.work, '.worktrees/.gitignore')

    expect(fs.readFileSync(ignore, 'utf8')).toBe('*\n')
    expect(fs.existsSync(path.join(repo.work, '.gitignore'))).toBe(false)

    const before = fs.statSync(ignore).mtimeMs
    create(repo.work, 'feat/b')
    expect(fs.readFileSync(ignore, 'utf8')).toBe('*\n')
    expect(fs.statSync(ignore).mtimeMs).toBe(before)
    expect(git(repo.work, ['status', '--porcelain'])).toBe('')
  })

  it('keeps a root .gitignore byte-identical, with no trailing newline too', () => {
    const repo = createRepo({ files: { '.gitignore': 'node_modules' } })
    create(repo.work, 'feat/a')

    expect(fs.readFileSync(path.join(repo.work, '.gitignore'), 'utf8')).toBe(
      'node_modules',
    )
    expect(git(repo.work, ['status', '--porcelain'])).toBe('')
  })

  it('stays clean when the root .gitignore has an unrelated entry named x', () => {
    const repo = createRepo({ files: { '.gitignore': 'x\n' } })
    const result = run(['create', 'feat/y'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(fs.existsSync(path.join(repo.work, '.worktrees/.gitignore'))).toBe(
      true,
    )
    expect(git(repo.work, ['status', '--porcelain'])).toBe('')
  })

  it('leaves an existing .worktrees/.gitignore as it is', () => {
    const repo = createRepo()
    const ignore = path.join(repo.work, '.worktrees/.gitignore')
    fs.mkdirSync(path.dirname(ignore))
    fs.writeFileSync(ignore, '*\n# mine\n')
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(fs.readFileSync(ignore, 'utf8')).toBe('*\n# mine\n')
  })

  it('warns and never edits a tracked .worktrees/.gitignore', () => {
    const repo = createRepo({ files: { '.worktrees/.gitignore': '*\n' } })
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('tracked')
    expect(
      fs.readFileSync(path.join(repo.work, '.worktrees/.gitignore'), 'utf8'),
    ).toBe('*\n')
    expect(git(repo.work, ['status', '--porcelain'])).toBe('')
  })

  it('exits 1 not-ignored when .worktrees still shows in status', () => {
    const repo = createRepo({ files: { '.worktrees/.gitignore': 'other\n' } })
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('error: not-ignored:')
    expect(
      fs.readFileSync(path.join(repo.work, '.worktrees/.gitignore'), 'utf8'),
    ).toBe('other\n')
  })
})

describe('create: main checkout', () => {
  it('leaves a dirty main checkout untouched', () => {
    const repo = createRepo({ files: { 'tracked.txt': 'one\n' } })
    git(repo.work, ['checkout', '-q', '-b', 'topic'])
    commitFiles(repo.work, { 'topic.txt': 't\n' }, 'topic')
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'edited\n')
    fs.writeFileSync(path.join(repo.work, 'staged.txt'), 's\n')
    git(repo.work, ['add', 'staged.txt'])
    fs.writeFileSync(path.join(repo.work, 'loose.txt'), 'l\n')
    const head = git(repo.work, ['rev-parse', 'HEAD'])
    const status = git(repo.work, ['status', '--porcelain'])

    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(git(repo.work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('topic')
    expect(git(repo.work, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(repo.work, ['status', '--porcelain'])).toBe(status)
    expect(git(repo.work, ['stash', 'list'])).toBe('')
    expect(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8')).toBe(
      'edited\n',
    )
  })
})

describe('create: base', () => {
  it('fetches and branches from origin/<default>', () => {
    const repo = createRepo()
    const later = advanceOrigin(repo)
    const out = createdFields(
      run(['create', 'feat/a'], { cwd: repo.work }).stdout,
    )

    expect(git(out.path ?? '', ['rev-parse', 'HEAD'])).toBe(later)
  })

  it('resolves a non-main default branch through ls-remote when origin/HEAD is unset', () => {
    const repo = createRepo({ defaultBranch: 'master' })
    expect(
      gitStatus(repo.work, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']),
    ).not.toBe(0)

    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(0)
    const out = createdFields(result.stdout)
    expect(out.base).toBe('origin/master')
    expect(git(out.path ?? '', ['rev-parse', 'HEAD'])).toBe(
      git(repo.work, ['rev-parse', 'origin/master']),
    )
  })

  it('exits 3 base-unresolved instead of guessing main', () => {
    const repo = createRepo()
    git(repo.work, ['remote', 'remove', 'origin'])
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('error: base-unresolved:')
    expect(result.stderr).toContain('--base')
    expect(fs.existsSync(path.join(repo.work, '.worktrees'))).toBe(false)
  })

  it('exits 1 with the fetch error and suggests --base when the fetch fails', () => {
    const repo = createRepo()
    git(repo.work, ['remote', 'set-head', 'origin', 'main'])
    breakRemote(repo)
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('error: fetch-failed:')
    expect(result.stderr).toContain('--base')
    expect(fs.existsSync(path.join(repo.work, '.worktrees'))).toBe(false)
  })

  it('uses a local --base without fetching', () => {
    const repo = createRepo()
    commitFiles(repo.work, { 'local.txt': 'l\n' }, 'local only')
    const local = git(repo.work, ['rev-parse', 'HEAD'])
    breakRemote(repo)
    const result = run(['create', 'feat/a', '--base', 'main'], {
      cwd: repo.work,
    })

    expect(result.status).toBe(0)
    const out = createdFields(result.stdout)
    expect(out.base).toBe('main')
    expect(git(out.path ?? '', ['rev-parse', 'HEAD'])).toBe(local)
  })

  it('exits 3 base-unresolved when --base does not resolve locally', () => {
    const repo = createRepo()
    const result = run(['create', 'feat/a', '--base', 'origin/nope'], {
      cwd: repo.work,
    })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('error: base-unresolved:')
  })

  it('creates the branch without an upstream', () => {
    const repo = createRepo()
    const out = createdFields(
      run(['create', 'feat/a'], { cwd: repo.work }).stdout,
    )

    expect(
      gitStatus(out.path ?? '', [
        'rev-parse',
        '--abbrev-ref',
        'feat/a@{upstream}',
      ]),
    ).not.toBe(0)
  })
})

describe('create: existing branch or target', () => {
  it('exits 3 branch-exists', () => {
    const repo = createRepo()
    git(repo.work, ['branch', 'feat/a'])
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('error: branch-exists:')
  })

  it('exits 3 target-exists with the path for a non-empty directory', () => {
    const repo = createRepo()
    const leftover = path.join(repo.work, '.worktrees/feat/a')
    fs.mkdirSync(leftover, { recursive: true })
    fs.writeFileSync(path.join(leftover, 'keep.txt'), 'keep\n')
    const result = run(['create', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('error: target-exists:')
    expect(result.stderr).toContain(leftover)
    expect(fs.readFileSync(path.join(leftover, 'keep.txt'), 'utf8')).toBe(
      'keep\n',
    )
  })

  it('accepts an empty target directory', () => {
    const repo = createRepo()
    fs.mkdirSync(path.join(repo.work, '.worktrees/feat/a'), { recursive: true })

    expect(run(['create', 'feat/a'], { cwd: repo.work }).status).toBe(0)
  })
})

describe('create: environment', () => {
  it('reads no stdin and runs mise and direnv with stdin closed', () => {
    const repo = createRepo({
      files: { 'mise.toml': '[tools]\n', '.envrc': 'x\n' },
    })
    const stubs = makeDir('git-worktree-stubs-')
    const log = path.join(stubs, 'calls.log')
    for (const tool of ['mise', 'direnv']) {
      const stub = path.join(stubs, tool)
      fs.writeFileSync(
        stub,
        `#!/bin/bash\necho "${tool} $* stdin=$(cat)" >> "${log}"\n`,
      )
      fs.chmodSync(stub, 0o755)
    }
    const result = run(['create', 'feat/a'], {
      cwd: repo.work,
      pathPrefix: [stubs],
      stdin: 'y\n',
    })

    expect(result.status).toBe(0)
    const calls = fs.readFileSync(log, 'utf8')
    expect(calls).toContain('mise trust mise.toml --quiet stdin=\n')
    expect(calls).toContain('direnv allow stdin=\n')
  })

  it('ignores GIT_DIR and GIT_WORK_TREE pointing at another repository', () => {
    const repo = createRepo()
    const other = createRepo()
    const result = run(['create', 'feat/a'], {
      cwd: repo.work,
      env: {
        GIT_DIR: path.join(other.work, '.git'),
        GIT_WORK_TREE: other.work,
      },
    })

    expect(result.status).toBe(0)
    expect(createdFields(result.stdout).path).toBe(
      path.join(repo.work, '.worktrees/feat/a'),
    )
    expect(fs.existsSync(path.join(other.work, '.worktrees'))).toBe(false)
  })
})

describe('list and switch', () => {
  it('lists a nested feat/x', () => {
    const repo = createRepo()
    const created = create(repo.work, 'feat/x')
    const listed = rows(run(['list'], { cwd: repo.work }).stdout)

    expect(listed.map((row) => row.name)).toEqual(['(main)', 'feat/x'])
    expect(listed[1]?.path).toBe(created)
    expect(listed[1]?.branch).toBe('feat/x')
  })

  it('switch prints the path only', () => {
    const repo = createRepo()
    const created = create(repo.work, 'feat/x')
    const result = run(['switch', 'feat/x'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${created}\n`)
  })

  it('switch exits 2 for an unknown name and lists candidates', () => {
    const repo = createRepo()
    create(repo.work, 'feat/x')
    const result = run(['switch', 'nope'], { cwd: repo.work })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('candidate: feat/x')
  })

  it('help exits 0 and an unknown command exits 2', () => {
    const repo = createRepo()

    expect(run(['help'], { cwd: repo.work }).stdout).toContain('Usage:')
    expect(run(['bogus'], { cwd: repo.work }).status).toBe(2)
  })
})

describe('copy-env', () => {
  function envRepo() {
    const repo = createRepo({
      files: { '.gitignore': '.env*\n!.env.keep\n', '.env.example': 'ex\n' },
    })
    fs.writeFileSync(path.join(repo.work, '.env'), 'secret=1\n')
    fs.writeFileSync(path.join(repo.work, '.env.local'), 'local=1\n')
    fs.writeFileSync(path.join(repo.work, '.env.keep'), 'tracked-by-rule\n')
    fs.symlinkSync('.env', path.join(repo.work, '.env.link'))
    return repo
  }

  it('copies only ignored regular files and skips tracked files and symlinks', () => {
    const repo = envRepo()
    const wt = create(repo.work, 'feat/a')

    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('secret=1\n')
    expect(fs.readFileSync(path.join(wt, '.env.local'), 'utf8')).toBe(
      'local=1\n',
    )
    // Tracked files arrive through the checkout itself; a symlink is not copied.
    expect(fs.readFileSync(path.join(wt, '.env.example'), 'utf8')).toBe('ex\n')
    expect(fs.existsSync(path.join(wt, '.env.link'))).toBe(false)
    expect(fs.existsSync(path.join(wt, '.env.keep'))).toBe(false)
  })

  it('never overwrites an existing file or directory and makes no backups', () => {
    const repo = envRepo()
    const wt = create(repo.work, 'feat/a')
    fs.writeFileSync(path.join(wt, '.env'), 'changed\n')
    fs.rmSync(path.join(wt, '.env.local'))
    fs.mkdirSync(path.join(wt, '.env.local'))

    const result = run(['copy-env', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('changed\n')
    expect(fs.statSync(path.join(wt, '.env.local')).isDirectory()).toBe(true)
    expect(fs.readdirSync(wt).filter((f) => f.endsWith('.backup'))).toEqual([])
  })

  it('copies into the current worktree when no name is given', () => {
    const repo = envRepo()
    const wt = create(repo.work, 'feat/a')
    fs.rmSync(path.join(wt, '.env'))

    const result = run(['copy-env'], { cwd: wt })

    expect(result.status).toBe(0)
    expect(fields(result.stdout.trim()).copied).toBe('1')
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('secret=1\n')
  })
})
