import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  normalizeGithubRemote,
  readRepoIdentity,
} from '../../src/lib/connect-repo-identity.js'
import {
  cleanupTempDirs,
  commitFiles,
  git,
  makeDir,
} from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A real repository with one commit; `remote` becomes `origin` when given. */
function createClone(remote?: string): { work: string; head: string } {
  const work = path.join(makeDir('connect-identity-'), 'work')
  fs.mkdirSync(work)
  git(work, ['init', '-q', '-b', 'main'])
  git(work, ['config', 'gc.auto', '0'])
  if (remote !== undefined) git(work, ['remote', 'add', 'origin', remote])
  const head = commitFiles(work, { 'README.md': 'base\n' }, 'base')
  return { work, head }
}

// ── Remote normalization ────────────────────────────────────────────────────

describe('normalizeGithubRemote', () => {
  it.each([
    ['https://github.com/Owner/Repo.git', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo/', 'owner/repo'],
    ['https://github.com/owner/repo.git/', 'owner/repo'],
    ['git@github.com:Owner/Repo.git', 'owner/repo'],
    ['git@github.com:owner/repo', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo/', 'owner/repo'],
    ['HTTPS://GITHUB.COM/Owner/Repo.git', 'owner/repo'],
    ['https://github.com/owner/my.repo-name_1.git', 'owner/my.repo-name_1'],
  ])('reads %s as %s', (url, expected) => {
    expect(normalizeGithubRemote(url)).toBe(expected)
  })

  it.each([
    'https://gitlab.com/owner/repo.git',
    'https://github.example.com/owner/repo.git',
    'git@github.example.com:owner/repo.git',
    'ssh://git@ssh.github.com:443/owner/repo.git',
    'file:///srv/git/owner/repo.git',
    '/srv/git/owner/repo.git',
    '../owner/repo',
    'http://github.com/owner/repo.git',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    'https://github.com/owner/repo.git?ref=main',
    'https://github.com/owner/repo#readme',
    'https://github.com/owner/..',
    'https://github.com/-owner/repo',
    'https://github.com.evil.test/owner/repo',
    'https://evil.test/github.com/owner/repo',
    'https://github.com/owner/re po',
    '',
  ])('records no repo for %p', (url) => {
    expect(normalizeGithubRemote(url)).toBeUndefined()
  })

  it('drops userinfo and never lets it into the result', () => {
    const result = normalizeGithubRemote(
      'https://user:ghp_secrettoken@github.com/o/r.git',
    )
    expect(result).toBe('o/r')
  })
})

// ── The repository identity of a checkout ───────────────────────────────────

describe('readRepoIdentity', () => {
  it('reads the origin remote and the HEAD commit of a real clone', () => {
    const { work, head } = createClone('https://github.com/Owner/Repo.git')
    expect(readRepoIdentity(work)).toEqual({ repo: 'owner/repo', commit: head })
  })

  it('reads a commit whose branch ref exists only in packed-refs', () => {
    const { work, head } = createClone('git@github.com:owner/repo.git')
    git(work, ['pack-refs', '--all', '--prune'])
    expect(fs.existsSync(path.join(work, '.git/refs/heads/main'))).toBe(false)
    expect(
      fs.readFileSync(path.join(work, '.git/packed-refs'), 'utf8'),
    ).toContain(head)
    expect(readRepoIdentity(work).commit).toBe(head)
  })

  it('reads the commit of a detached HEAD', () => {
    const { work, head } = createClone('git@github.com:owner/repo.git')
    commitFiles(work, { 'two.txt': 'two\n' }, 'two')
    git(work, ['checkout', '-q', '--detach', head])
    expect(fs.readFileSync(path.join(work, '.git/HEAD'), 'utf8').trim()).toBe(
      head,
    )
    expect(readRepoIdentity(work).commit).toBe(head)
  })

  it('reads a branch name that contains a slash', () => {
    const { work } = createClone('git@github.com:owner/repo.git')
    git(work, ['checkout', '-q', '-b', 'feat/nested/name'])
    const head = commitFiles(work, { 'three.txt': 'three\n' }, 'three')
    expect(readRepoIdentity(work).commit).toBe(head)
    git(work, ['pack-refs', '--all', '--prune'])
    expect(readRepoIdentity(work).commit).toBe(head)
  })

  it('records no commit for an unborn branch and still records the repo', () => {
    const work = path.join(makeDir('connect-identity-unborn-'), 'work')
    fs.mkdirSync(work)
    git(work, ['init', '-q', '-b', 'main'])
    git(work, ['remote', 'add', 'origin', 'https://github.com/o/r.git'])
    expect(readRepoIdentity(work)).toEqual({ repo: 'o/r' })
  })

  it('uses origin only when a second remote exists', () => {
    const { work } = createClone('https://github.com/o/origin-repo.git')
    git(work, [
      'remote',
      'add',
      'upstream',
      'https://github.com/o/upstream-repo.git',
    ])
    expect(readRepoIdentity(work).repo).toBe('o/origin-repo')
  })

  it('does not take a remote that is not named origin', () => {
    const { work, head } = createClone()
    git(work, [
      'remote',
      'add',
      'upstream',
      'https://github.com/o/upstream.git',
    ])
    expect(readRepoIdentity(work)).toEqual({ commit: head })
  })

  it('records no repo for a remote on another host, and still reads the commit', () => {
    for (const url of [
      'https://gitlab.com/o/r.git',
      'https://github.example.com/o/r.git',
      'file:///srv/git/o/r.git',
    ]) {
      const { work, head } = createClone(url)
      expect(readRepoIdentity(work)).toEqual({ commit: head })
    }
  })

  it('records no repo for a clone with no remote', () => {
    const { work, head } = createClone()
    expect(readRepoIdentity(work)).toEqual({ commit: head })
  })

  it('records the repo and none of the credential for a URL with credentials', () => {
    const { work, head } = createClone(
      'https://user:ghp_secrettoken@github.com/o/r.git',
    )
    const identity = readRepoIdentity(work)
    expect(identity).toEqual({ repo: 'o/r', commit: head })
    expect(JSON.stringify(identity)).not.toContain('secrettoken')
    expect(JSON.stringify(identity)).not.toContain('user')
  })

  it('reads the first url of the origin section, ignoring comments and quotes', () => {
    const { work, head } = createClone()
    fs.appendFileSync(
      path.join(work, '.git/config'),
      [
        '[REMOTE "origin"]',
        '\turl = "https://github.com/Quoted/Repo.git" ; a comment',
        '\turl = https://github.com/other/ignored.git',
        '',
      ].join('\n'),
    )
    expect(readRepoIdentity(work)).toEqual({
      repo: 'quoted/repo',
      commit: head,
    })
  })

  it('takes a url that follows an unrelated section into the origin section only', () => {
    const { work, head } = createClone()
    fs.appendFileSync(
      path.join(work, '.git/config'),
      [
        '[remote "origin"]',
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '[remote "other"]',
        '\turl = https://github.com/o/other.git',
        '',
      ].join('\n'),
    )
    expect(readRepoIdentity(work)).toEqual({ commit: head })
  })

  it('records nothing for a .git/config over the bound, and never throws', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    fs.appendFileSync(
      path.join(work, '.git/config'),
      `\n# ${'x'.repeat(1024 * 1024 + 10)}\n`,
    )
    expect(readRepoIdentity(work)).toEqual({ commit: head })
  })

  it('records no repo for a symlinked .git/config', () => {
    const { work, head } = createClone()
    const real = path.join(makeDir('connect-identity-real-'), 'config')
    fs.writeFileSync(
      real,
      '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    )
    fs.rmSync(path.join(work, '.git/config'))
    fs.symlinkSync(real, path.join(work, '.git/config'))
    expect(readRepoIdentity(work)).toEqual({ commit: head })
  })

  it('records no commit for a symlinked .git/HEAD', () => {
    const { work } = createClone('https://github.com/o/r.git')
    const real = path.join(makeDir('connect-identity-head-'), 'HEAD')
    fs.writeFileSync(real, `${'a'.repeat(40)}\n`)
    fs.rmSync(path.join(work, '.git/HEAD'))
    fs.symlinkSync(real, path.join(work, '.git/HEAD'))
    expect(readRepoIdentity(work)).toEqual({ repo: 'o/r' })
  })

  it('records nothing when .git is a file', () => {
    const { work } = createClone('https://github.com/o/r.git')
    const linked = path.join(makeDir('connect-identity-linked-'), 'linked')
    git(work, ['worktree', 'add', '-q', '--detach', linked])
    expect(fs.lstatSync(path.join(linked, '.git')).isFile()).toBe(true)
    expect(readRepoIdentity(linked)).toEqual({})
  })

  it('records nothing when .git is a symlink to a repository', () => {
    const { work } = createClone('https://github.com/o/r.git')
    const outer = makeDir('connect-identity-symlink-')
    fs.symlinkSync(path.join(work, '.git'), path.join(outer, '.git'))
    expect(readRepoIdentity(outer)).toEqual({})
  })

  it('records nothing for a directory that is not a repository, and for a missing one', () => {
    expect(readRepoIdentity(makeDir('connect-identity-empty-'))).toEqual({})
    expect(readRepoIdentity('/nonexistent/connect-identity')).toEqual({})
  })

  it('ignores a HEAD that is not a symbolic ref or a full hash', () => {
    const { work } = createClone('https://github.com/o/r.git')
    for (const text of [
      'ref: ../../outside\n',
      'ref: refs/heads/../../escape\n',
      'ref: refs/heads//double\n',
      'abc123\n',
      'ref: refs/heads/main extra\n',
      '',
    ]) {
      fs.writeFileSync(path.join(work, '.git/HEAD'), text)
      expect(readRepoIdentity(work)).toEqual({ repo: 'o/r' })
    }
  })

  it('ignores a loose ref whose content is not a hash and falls back to packed-refs', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['pack-refs', '--all'])
    fs.writeFileSync(path.join(work, '.git/refs/heads/main'), 'not a hash\n')
    expect(readRepoIdentity(work).commit).toBe(head)
  })

  it('does not read a commit past a packed-refs peeled line or comment', () => {
    const { work } = createClone('https://github.com/o/r.git')
    const other = 'b'.repeat(40)
    fs.rmSync(path.join(work, '.git/refs/heads/main'))
    fs.writeFileSync(
      path.join(work, '.git/packed-refs'),
      [
        '# pack-refs with: peeled fully-peeled sorted',
        `${other} refs/tags/v1`,
        `^${'c'.repeat(40)}`,
        `${other} refs/heads/main-other`,
        '',
      ].join('\n'),
    )
    expect(readRepoIdentity(work)).toEqual({ repo: 'o/r' })
  })
})
