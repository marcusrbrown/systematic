import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  isAllowedProject,
  type ProjectIdentity,
  resolveProjectIdentity,
} from '../../src/lib/search-project-identity.js'
import {
  cleanupTempDirs,
  createBareRepo,
  createDetachedDotGitRepo,
  createRepo,
  createSeparateGitDirRepo,
  createSubmoduleRepo,
  git,
  makeDir,
} from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

function addWorktree(
  from: string,
  branch: string,
  extra: readonly string[] = [],
): string {
  const target = path.join(makeDir('identity-wt-'), 'wt')
  git(from, ['worktree', 'add', '-q', ...extra, '-b', branch, target])
  return target
}

function expectResolved(identity: ProjectIdentity, root: string): void {
  expect(identity).toEqual({ status: 'resolved', mainRoot: root })
}

function expectUnresolved(identity: ProjectIdentity): void {
  expect(identity.status).toBe('unresolved')
  expect(isAllowedProject(identity, ['/', '~', makeDir()])).toBe(false)
}

// ── Git version probe ──────────────────────────────────────────────────────
// `worktree.useRelativePaths` needs git 2.48. An older git skips that case; a
// probe that fails or prints something unparseable must fail it, not skip it.

type GitProbe =
  | { readonly ok: true; readonly major: number; readonly minor: number }
  | { readonly ok: false; readonly error: Error }

function probeGitVersion(): GitProbe {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (result.error !== undefined) {
    return { ok: false, error: result.error }
  }
  const match = /git version (\d+)\.(\d+)/.exec(result.stdout)
  if (result.status !== 0 || match === null) {
    return {
      ok: false,
      error: new Error(`cannot parse git version: ${result.stdout}`),
    }
  }
  return { ok: true, major: Number(match[1]), minor: Number(match[2]) }
}

const gitProbe = probeGitVersion()
const supportsRelativePaths =
  gitProbe.ok &&
  (gitProbe.major > 2 || (gitProbe.major === 2 && gitProbe.minor >= 48))

describe('resolveProjectIdentity: own root', () => {
  it('returns the checkout root of a plain checkout', () => {
    const repo = createRepo()
    expectResolved(resolveProjectIdentity(repo.work), repo.work)
  })

  it('treats a nested repo as its own project', () => {
    const outer = createRepo()
    const inner = path.join(outer.work, 'packages/inner')
    fs.mkdirSync(inner, { recursive: true })
    git(inner, ['init', '-q', '-b', 'main'])
    expectResolved(resolveProjectIdentity(inner), inner)
  })

  it('treats a submodule checkout (.git file under modules/) as its own root', () => {
    const submodule = createSubmoduleRepo()
    expect(fs.statSync(path.join(submodule, '.git')).isFile()).toBe(true)
    expectResolved(resolveProjectIdentity(submodule), submodule)
  })

  it('returns unresolved for a directory with no .git', () => {
    expectUnresolved(resolveProjectIdentity(makeDir()))
  })

  it('returns unresolved for a path that does not exist', () => {
    expectUnresolved(resolveProjectIdentity(path.join(makeDir(), 'missing')))
  })
})

describe('resolveProjectIdentity: linked worktrees', () => {
  it('maps a git worktree to the main checkout (AE4)', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true)
    expectResolved(resolveProjectIdentity(wt), repo.work)
  })

  it('maps a worktree created from another linked worktree to the main root', () => {
    const repo = createRepo()
    const first = addWorktree(repo.work, 'feat/a')
    const second = addWorktree(first, 'feat/b')
    expectResolved(resolveProjectIdentity(second), repo.work)
  })

  it('gives a worktree and its main checkout the same identity', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    expect(resolveProjectIdentity(wt)).toEqual(
      resolveProjectIdentity(repo.work),
    )
  })

  it('resolves a worktree whose .git file holds a relative gitdir', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const gitFile = path.join(wt, '.git')
    const absolute = fs
      .readFileSync(gitFile, 'utf8')
      .replace(/^gitdir:\s*/, '')
      .trim()
    fs.writeFileSync(gitFile, `gitdir: ${path.relative(wt, absolute)}\n`)
    expectResolved(resolveProjectIdentity(wt), repo.work)
  })

  it('compares realpaths: a symlinked checkout path resolves like the real path', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const links = makeDir('identity-links-')
    const wtLink = path.join(links, 'wt-link')
    const mainLink = path.join(links, 'main-link')
    fs.symlinkSync(wt, wtLink)
    fs.symlinkSync(repo.work, mainLink)
    expectResolved(resolveProjectIdentity(wtLink), repo.work)
    expectResolved(resolveProjectIdentity(mainLink), repo.work)
  })

  it('verifies the back-pointer by realpath when the main checkout is reached through a symlink', () => {
    const repo = createRepo()
    const links = makeDir('identity-links-')
    const mainLink = path.join(links, 'main-link')
    fs.symlinkSync(repo.work, mainLink)
    const wt = addWorktree(mainLink, 'feat/a')
    expectResolved(resolveProjectIdentity(wt), repo.work)
  })

  it('resolves relative back-pointers written by worktree.useRelativePaths', () => {
    if (!gitProbe.ok) {
      throw gitProbe.error
    }
    if (!supportsRelativePaths) {
      return
    }
    const repo = createRepo()
    git(repo.work, ['config', 'worktree.useRelativePaths', 'true'])
    const wt = addWorktree(repo.work, 'feat/rel')

    // Prove the fixture really is relative, otherwise this test proves nothing.
    const gitFile = fs.readFileSync(path.join(wt, '.git'), 'utf8')
    expect(gitFile).toMatch(/^gitdir: \.\./)
    const entry = path.join(repo.work, '.git/worktrees/wt/gitdir')
    expect(path.isAbsolute(fs.readFileSync(entry, 'utf8').trim())).toBe(false)

    expectResolved(resolveProjectIdentity(wt), repo.work)
  })
})

describe('git version probe', () => {
  it('succeeds (a probe error fails, it never skips)', () => {
    if (!gitProbe.ok) {
      throw gitProbe.error
    }
    expect(gitProbe.major).toBeGreaterThanOrEqual(2)
  })
})

describe('resolveProjectIdentity: forgery and fail-closed', () => {
  function writeGitFile(checkout: string, target: string): void {
    fs.mkdirSync(checkout, { recursive: true })
    fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${target}\n`)
  }

  it('rejects a forged .git that points at a real worktree gitdir without a back-pointer', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const entry = path.join(repo.work, '.git/worktrees/wt')
    expect(fs.existsSync(entry)).toBe(true)
    const evil = path.join(makeDir('identity-evil-'), 'evil')
    writeGitFile(evil, entry)

    expectUnresolved(resolveProjectIdentity(evil))
    // The real worktree is untouched by the forgery.
    expectResolved(resolveProjectIdentity(wt), repo.work)
  })

  it('rejects a self-consistent forgery: attacker-written gitdir, commondir and back-pointer', () => {
    const victim = createRepo()
    // A real entry of the same name exists in the victim's common directory.
    addWorktree(victim.work, 'feat/a')
    const realName = 'wt'
    expect(
      fs.existsSync(path.join(victim.work, '.git/worktrees', realName)),
    ).toBe(true)

    const evil = path.join(makeDir('identity-evil-'), 'evil')
    const forgedGitdir = path.join(evil, 'worktrees', realName)
    fs.mkdirSync(forgedGitdir, { recursive: true })
    writeGitFile(evil, forgedGitdir)
    fs.writeFileSync(
      path.join(forgedGitdir, 'commondir'),
      `${path.join(victim.work, '.git')}\n`,
    )
    fs.writeFileSync(
      path.join(forgedGitdir, 'gitdir'),
      `${path.join(evil, '.git')}\n`,
    )

    const identity = resolveProjectIdentity(evil)
    expectUnresolved(identity)
    expect(isAllowedProject(identity, [victim.work])).toBe(false)
  })

  it('rejects a forged entry name the common directory has no worktrees/ entry for', () => {
    const victim = createRepo()
    const evil = path.join(makeDir('identity-evil-'), 'evil')
    const ghost = path.join(victim.work, '.git/worktrees/ghost')
    writeGitFile(evil, ghost)
    expectUnresolved(resolveProjectIdentity(evil))
    // Nothing was created in the victim's repository by resolving.
    expect(fs.existsSync(ghost)).toBe(false)
  })

  it('cannot inherit an allowed identity from a wholly self-made layout', () => {
    const victim = createRepo()
    const evil = path.join(makeDir('identity-evil-'), 'evil')
    const fakeCommon = path.join(evil, 'fake/.git')
    const entry = path.join(fakeCommon, 'worktrees/w')
    fs.mkdirSync(entry, { recursive: true })
    fs.writeFileSync(path.join(fakeCommon, 'config'), '[core]\n')
    fs.writeFileSync(path.join(entry, 'commondir'), '../..\n')
    fs.writeFileSync(path.join(entry, 'gitdir'), `${path.join(evil, '.git')}\n`)
    writeGitFile(evil, entry)

    const identity = resolveProjectIdentity(evil)
    expect(isAllowedProject(identity, [victim.work])).toBe(false)
    if (identity.status === 'resolved') {
      expect(identity.mainRoot).not.toBe(victim.work)
    }
  })

  it('rejects a .git that is a symlink to a real worktree .git file', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const evil = makeDir('identity-evil-')
    fs.symlinkSync(path.join(wt, '.git'), path.join(evil, '.git'))

    // Without the lstat check the back-pointer would compare equal by realpath.
    expectUnresolved(resolveProjectIdentity(evil))
  })

  it('returns unresolved when the gitdir sits under worktrees/ but has no commondir', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    fs.rmSync(path.join(repo.work, '.git/worktrees/wt/commondir'))
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved when commondir cannot be read', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const commondir = path.join(repo.work, '.git/worktrees/wt/commondir')
    fs.rmSync(commondir)
    fs.mkdirSync(commondir)
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved when commondir names a different repository', () => {
    const repo = createRepo()
    const other = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    fs.writeFileSync(
      path.join(repo.work, '.git/worktrees/wt/commondir'),
      `${path.join(other.work, '.git')}\n`,
    )
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved when the back-pointer names another checkout', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    fs.writeFileSync(
      path.join(repo.work, '.git/worktrees/wt/gitdir'),
      `${path.join(repo.work, '.git')}\n`,
    )
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved when the back-pointer is missing', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    fs.rmSync(path.join(repo.work, '.git/worktrees/wt/gitdir'))
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved when the common directory sets core.worktree', () => {
    const { work, storage } = createDetachedDotGitRepo(true)
    const wt = addWorktree(work, 'feat/a')
    const common = path.join(storage, '.git')
    expect(fs.readFileSync(path.join(common, 'config'), 'utf8')).toContain(
      'worktree =',
    )
    // The linked worktree has a healthy commondir and back-pointer; only the
    // core.worktree setting makes it refuse.
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('accepts the same layout once core.worktree is gone', () => {
    const { work, storage } = createDetachedDotGitRepo(true)
    const wt = addWorktree(work, 'feat/a')
    git(work, ['config', '--unset', 'core.worktree'])
    expectResolved(resolveProjectIdentity(wt), storage)
  })

  it('matches core.worktree case-insensitively and ignores other sections', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const config = path.join(repo.work, '.git/config')
    const original = fs.readFileSync(config, 'utf8')

    fs.writeFileSync(
      config,
      `${original}[remote "x"]\n\tworktree = /not/core\n`,
    )
    expectResolved(resolveProjectIdentity(wt), repo.work)

    fs.writeFileSync(config, `${original}[CORE]\n\tWorkTree = /elsewhere\n`)
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved when the common directory config is unreadable', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    const config = path.join(repo.work, '.git/config')
    fs.rmSync(config)
    fs.mkdirSync(config)
    expectUnresolved(resolveProjectIdentity(wt))
  })

  it('returns unresolved for a worktree of a bare repository', () => {
    const bare = createBareRepo()
    const wt = path.join(makeDir('identity-wt-'), 'wt')
    git(bare, ['worktree', 'add', '-q', '-b', 'feat/a', wt])
    expectUnresolved(resolveProjectIdentity(wt))
    expectUnresolved(resolveProjectIdentity(bare))
  })

  it('returns unresolved for a separate git dir (neither modules/ nor worktrees/)', () => {
    expectUnresolved(resolveProjectIdentity(createSeparateGitDirRepo()))
    expectUnresolved(resolveProjectIdentity(createDetachedDotGitRepo().work))
  })

  it('returns unresolved, without throwing, for a corrupt .git file', () => {
    const dir = makeDir('identity-corrupt-')
    for (const content of [
      '',
      'not a gitdir line\n',
      'gitdir:\n',
      'gitdir: \n',
      '\u0000\u0001\u0002',
    ]) {
      fs.writeFileSync(path.join(dir, '.git'), content)
      expectUnresolved(resolveProjectIdentity(dir))
    }
  })

  it('returns unresolved when the .git file points at a missing gitdir', () => {
    const dir = makeDir('identity-missing-')
    fs.writeFileSync(
      path.join(dir, '.git'),
      `gitdir: ${path.join(dir, 'modules/gone')}\n`,
    )
    expectUnresolved(resolveProjectIdentity(dir))
  })

  it('returns unresolved for an oversized .git file', () => {
    const dir = makeDir('identity-big-')
    fs.writeFileSync(
      path.join(dir, '.git'),
      `gitdir: ${'a'.repeat(2 * 1024 * 1024)}\n`,
    )
    expectUnresolved(resolveProjectIdentity(dir))
  })
})

describe('isAllowedProject', () => {
  it('matches the exact main root, and a worktree matches through its main root', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    expect(isAllowedProject(resolveProjectIdentity(wt), [repo.work])).toBe(true)
    expect(
      isAllowedProject(resolveProjectIdentity(repo.work), [repo.work]),
    ).toBe(true)
  })

  it('does not match a worktree path listed as the allow entry', () => {
    const repo = createRepo()
    const wt = addWorktree(repo.work, 'feat/a')
    expect(isAllowedProject(resolveProjectIdentity(wt), [wt])).toBe(false)
  })

  it('matches only the exact root, not a parent or a child', () => {
    const repo = createRepo()
    const identity = resolveProjectIdentity(repo.work)
    expect(isAllowedProject(identity, [path.dirname(repo.work)])).toBe(false)
    const child = path.join(repo.work, 'sub')
    fs.mkdirSync(child)
    expect(isAllowedProject(identity, [child])).toBe(false)
    expect(isAllowedProject(resolveProjectIdentity(child), [repo.work])).toBe(
      false,
    )
  })

  it('compares realpaths on both sides', () => {
    const repo = createRepo()
    const link = path.join(makeDir('identity-links-'), 'link')
    fs.symlinkSync(repo.work, link)
    expect(isAllowedProject(resolveProjectIdentity(repo.work), [link])).toBe(
      true,
    )
    expect(
      isAllowedProject(resolveProjectIdentity(link), [`${repo.work}/`]),
    ).toBe(true)
  })

  it('expands ~ and ~/ against the home directory', () => {
    const home = makeDir('identity-home-')
    const project = path.join(home, 'src/proj')
    fs.mkdirSync(project, { recursive: true })
    git(project, ['init', '-q', '-b', 'main'])
    const identity = resolveProjectIdentity(project)
    expect(isAllowedProject(identity, ['~/src/proj'], { homeDir: home })).toBe(
      true,
    )
    expect(isAllowedProject(identity, ['~/src/other'], { homeDir: home })).toBe(
      false,
    )
    expect(isAllowedProject(identity, ['~'], { homeDir: home })).toBe(false)

    git(home, ['init', '-q', '-b', 'main'])
    expect(
      isAllowedProject(resolveProjectIdentity(home), ['~'], { homeDir: home }),
    ).toBe(true)
  })

  it('treats a stale (non-existent) allow entry as a silent non-match', () => {
    const repo = createRepo()
    const identity = resolveProjectIdentity(repo.work)
    expect(
      isAllowedProject(identity, [
        path.join(makeDir(), 'gone'),
        '~/does-not-exist-anywhere',
      ]),
    ).toBe(false)
    // A stale entry does not hide a later valid one.
    expect(
      isAllowedProject(identity, [path.join(makeDir(), 'gone'), repo.work]),
    ).toBe(true)
  })

  it('never matches a relative, empty or non-string entry', () => {
    const repo = createRepo()
    const identity = resolveProjectIdentity(repo.work)
    const relative = path.relative(process.cwd(), repo.work)
    expect(isAllowedProject(identity, [relative, '', '.', '~user/x'])).toBe(
      false,
    )
    expect(isAllowedProject(identity, [])).toBe(false)
  })

  it('never matches an unresolved identity, whatever the allow list holds', () => {
    const identity = resolveProjectIdentity(makeDir())
    expect(identity.status).toBe('unresolved')
    expect(isAllowedProject(identity, ['/', makeDir()])).toBe(false)
  })
})
