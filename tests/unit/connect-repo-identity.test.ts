import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  isGithubOwnerRepo,
  normalizeGithubRemote,
  readRepoIdentity,
  readTagAtHead,
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

// ── The shared owner/repo shape ─────────────────────────────────────────────

describe('isGithubOwnerRepo', () => {
  it.each([
    'fro-bot/agent',
    'marcusrbrown/systematic',
    'Owner/Repo',
    'o/r',
    'owner/my.repo-name_1',
    'owner/.github',
    `${'o'.repeat(39)}/${'r'.repeat(100)}`,
  ])('accepts %j', (value) => {
    expect(isGithubOwnerRepo(value)).toBe(true)
  })

  it.each([
    '',
    ' ',
    'fro-bot',
    'fro-bot/',
    '/agent',
    'fro-bot//agent',
    'fro bot/agent',
    'fro-bot/age nt',
    'fro-bot/agent/extra',
    'fro-bot/agent\n',
    'fro-bot/agent`',
    'fro-bot/agent:1',
    '-fro/agent',
    'fro-/agent',
    'fro_bot/agent',
    'fro-bot/..',
    'fro-bot/.',
    '../agent',
    './agent',
    `${'o'.repeat(40)}/agent`,
    `fro-bot/${'r'.repeat(101)}`,
    'fro-bot/agént',
    'fro-bot/agent.git/',
  ])('refuses %j', (value) => {
    expect(isGithubOwnerRepo(value)).toBe(false)
  })

  it('is the rule a remote URL is read by, so an owner it refuses is never an origin', () => {
    expect(
      normalizeGithubRemote('https://github.com/fro-/agent'),
    ).toBeUndefined()
    expect(normalizeGithubRemote('https://github.com/fro-bot/agent')).toBe(
      'fro-bot/agent',
    )
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

// ── The tag at HEAD ─────────────────────────────────────────────────────────

const UNKNOWN = { kind: 'unknown' } as const
const tag = (name: string) => ({ kind: 'tag', name }) as const

/** The tag reader for the clone's current HEAD, as `begin` would call it. */
function tagAtHead(work: string) {
  const commit = readRepoIdentity(work).commit
  if (commit === undefined) throw new Error('fixture has no HEAD commit')
  return readTagAtHead(work, commit)
}

/** A clone with `base` tagged `old` (annotated) and one commit after it. */
function createClonePastAnnotatedTag(): { work: string; head: string } {
  const { work } = createClone('https://github.com/o/r.git')
  git(work, ['tag', '-a', 'old', '-m', 'old'])
  const head = commitFiles(work, { 'two.txt': 'two\n' }, 'two')
  return { work, head }
}

function looseObjectFile(work: string, id: string): string {
  return path.join(work, '.git/objects', id.slice(0, 2), id.slice(2))
}

/** Writes `bytes` as the loose object `id` and a loose tag ref `name` that names it. */
function plantTag(
  work: string,
  name: string,
  id: string,
  bytes?: Buffer,
): void {
  if (bytes !== undefined) {
    fs.mkdirSync(path.dirname(looseObjectFile(work, id)), { recursive: true })
    fs.writeFileSync(looseObjectFile(work, id), bytes)
  }
  const ref = path.join(work, '.git/refs/tags', name)
  fs.mkdirSync(path.dirname(ref), { recursive: true })
  fs.writeFileSync(ref, `${id}\n`)
}

const FAKE_ID = '1234abcd'.repeat(5)
/** The header git writes: a tag with no peeled line is known not to be an annotated tag. */
const FULLY_PEELED = '# pack-refs with: peeled fully-peeled sorted \n'
const rawObject = (type: string, body: string): Buffer =>
  zlib.deflateSync(Buffer.from(`${type} ${Buffer.byteLength(body)}\0${body}`))

describe('readTagAtHead', () => {
  it('names a lightweight tag at HEAD, loose and then packed', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1.2.3'])
    expect(tagAtHead(work)).toEqual(tag('v1.2.3'))
    git(work, ['pack-refs', '--all', '--prune'])
    expect(fs.existsSync(path.join(work, '.git/refs/tags/v1.2.3'))).toBe(false)
    expect(tagAtHead(work)).toEqual(tag('v1.2.3'))
  })

  it('names a loose annotated tag at HEAD through its object, and a packed one through its peeled line', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', '-a', 'v2.0.0', '-m', 'release'])
    expect(tagAtHead(work)).toEqual(tag('v2.0.0'))
    git(work, ['pack-refs', '--all', '--prune'])
    expect(fs.existsSync(path.join(work, '.git/refs/tags/v2.0.0'))).toBe(false)
    expect(
      fs.readFileSync(path.join(work, '.git/packed-refs'), 'utf8'),
    ).toMatch(/^\^[0-9a-f]{40}$/m)
    expect(tagAtHead(work)).toEqual(tag('v2.0.0'))
  })

  it('names a tag from a real default clone and nothing from a --no-tags clone', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', '-a', 'v3.1.0', '-m', 'release'])
    git(work, ['tag', 'light'])
    git(work, ['tag', '-d', 'light'])
    const parent = makeDir('connect-identity-clone-')
    const full = path.join(parent, 'full')
    const bare = path.join(parent, 'bare')
    git(parent, ['clone', '-q', work, full])
    git(parent, ['clone', '-q', '--no-tags', work, bare])
    expect(tagAtHead(full)).toEqual(tag('v3.1.0'))
    expect(tagAtHead(bare)).toEqual(UNKNOWN)
  })

  it('does not name a tag once HEAD has moved past it, or a tag on an older commit', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    git(work, ['tag', '-a', 'v1-annotated', '-m', 'm'])
    commitFiles(work, { 'two.txt': 'two\n' }, 'two')
    expect(tagAtHead(work)).toEqual(UNKNOWN)
    git(work, ['pack-refs', '--all', '--prune'])
    expect(tagAtHead(work)).toEqual(UNKNOWN)
  })

  it('answers a tag on HEAD while an older annotated tag exists, and answers on a detached HEAD', () => {
    const { work, head } = createClonePastAnnotatedTag()
    expect(tagAtHead(work)).toEqual(UNKNOWN)
    git(work, ['tag', 'v2'])
    expect(tagAtHead(work)).toEqual(tag('v2'))
    git(work, ['checkout', '-q', '--detach', head])
    expect(fs.readFileSync(path.join(work, '.git/HEAD'), 'utf8').trim()).toBe(
      head,
    )
    expect(tagAtHead(work)).toEqual(tag('v2'))
    git(work, ['checkout', '-q', 'old'])
    expect(tagAtHead(work)).toEqual(tag('old'))
  })

  it('finds a tag whose name contains a slash in a nested refs/tags directory', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'release/1.2'])
    expect(
      fs.statSync(path.join(work, '.git/refs/tags/release')).isDirectory(),
    ).toBe(true)
    expect(tagAtHead(work)).toEqual(tag('release/1.2'))
    git(work, ['tag', 'v1.2'])
    expect(tagAtHead(work)).toEqual(UNKNOWN)
  })

  it('names a tag whose name contains a plus, loose and then packed', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1.2.3+build.5'])
    expect(tagAtHead(work)).toEqual(tag('v1.2.3+build.5'))
    git(work, ['pack-refs', '--all', '--prune'])
    expect(
      fs.existsSync(path.join(work, '.git/refs/tags/v1.2.3+build.5')),
    ).toBe(false)
    expect(tagAtHead(work)).toEqual(tag('v1.2.3+build.5'))
  })

  it('does not let an unrelated plus tag turn a matching tag into unknown', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    const other = commitFiles(work, { 'two.txt': 'two\n' }, 'two')
    git(work, ['tag', 'v1+old', head])
    git(work, ['tag', 'v2'])
    expect(readTagAtHead(work, other)).toEqual(tag('v2'))
    git(work, ['pack-refs', '--all', '--prune'])
    expect(readTagAtHead(work, other)).toEqual(tag('v2'))
  })

  it('is unknown with two tags at HEAD, one lightweight and one annotated, loose or packed', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'light'])
    git(work, ['tag', '-a', 'noted', '-m', 'm'])
    expect(tagAtHead(work)).toEqual(UNKNOWN)
    git(work, ['pack-refs', '--all', '--prune'])
    expect(tagAtHead(work)).toEqual(UNKNOWN)
  })

  it('counts one name once when it is both loose and listed in packed-refs', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', '-a', 'v1', '-m', 'm'])
    git(work, ['pack-refs', '--all', '--no-prune'])
    expect(fs.existsSync(path.join(work, '.git/refs/tags/v1'))).toBe(true)
    expect(
      fs.readFileSync(path.join(work, '.git/packed-refs'), 'utf8'),
    ).toContain('refs/tags/v1')
    expect(tagAtHead(work)).toEqual(tag('v1'))
  })

  it('lets the loose ref win over a stale packed-refs line of the same name', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    fs.writeFileSync(
      path.join(work, '.git/packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${'b'.repeat(40)} refs/tags/v1\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
  })

  it('lets a loose ref that names an older commit win over a packed line that names HEAD', () => {
    const { work, head: older } = createClone('https://github.com/o/r.git')
    const head = commitFiles(work, { 'two.txt': 'two\n' }, 'two')
    git(work, ['tag', 'v1'])
    git(work, ['pack-refs', '--all', '--no-prune'])
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
    fs.writeFileSync(path.join(work, '.git/refs/tags/v1'), `${older}\n`)
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it('is unknown when a loose annotated tag object lives in a pack', () => {
    const { work } = createClonePastAnnotatedTag()
    git(work, ['tag', 'v2'])
    expect(tagAtHead(work)).toEqual(tag('v2'))
    git(work, ['repack', '-a', '-d', '-q'])
    expect(fs.existsSync(path.join(work, '.git/refs/tags/old'))).toBe(true)
    expect(tagAtHead(work)).toEqual(UNKNOWN)
  })

  it.each([
    ['truncated zlib', () => rawObject('tag', 'object x\n').subarray(0, 6)],
    ['not zlib', () => Buffer.from('this is not a zlib stream at all')],
    ['an unknown object type', () => rawObject('bogus', 'abc')],
    [
      'a header whose size lies',
      () => zlib.deflateSync(Buffer.from('tag 99\0abc')),
    ],
    [
      'a tag body with no object line',
      () => rawObject('tag', 'type commit\n\nm\n'),
    ],
    [
      'a tag naming a malformed object id',
      () => rawObject('tag', 'object nothex\ntype commit\n\nm\n'),
    ],
  ])(
    'is unknown, and does not throw, for a loose tag object that is %s',
    (_label, build) => {
      const { work } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'v1'])
      plantTag(work, 'odd', FAKE_ID, build())
      expect(tagAtHead(work)).toEqual(UNKNOWN)
    },
  )

  it('reads a hand-built loose tag object, and refuses one whose header size lies', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    const body = `object ${head}\ntype commit\ntag forged\n\nm\n`
    plantTag(work, 'forged', FAKE_ID, rawObject('tag', body))
    expect(readTagAtHead(work, head)).toEqual(tag('forged'))
    plantTag(
      work,
      'forged',
      FAKE_ID,
      zlib.deflateSync(Buffer.from(`tag 3\0${body}`)),
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it('is unknown when a tag object points at another tag object', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', '-a', 'inner', '-m', 'inner'])
    git(work, ['tag', '-a', 'outer', '-m', 'outer', 'inner'])
    git(work, ['tag', '-d', 'inner'])
    expect(tagAtHead(work)).toEqual(UNKNOWN)
    git(work, ['tag', 'v1'])
    expect(tagAtHead(work)).toEqual(UNKNOWN)
  })

  it('does not count a tag that points at a tree or a blob as a second tag', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    const tree = git(work, ['rev-parse', 'HEAD^{tree}'])
    git(work, ['tag', 'tree-tag', tree])
    expect(tagAtHead(work)).toEqual(tag('v1'))
  })

  it('refuses a real high-ratio zlib bomb under its output cap', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    const bomb = zlib.deflateSync(Buffer.alloc(3 * 1024 * 1024), { level: 9 })
    expect(bomb.length).toBeLessThan(4096)
    plantTag(work, 'bomb', FAKE_ID, bomb)
    const inflate = spyOn(zlib, 'inflateSync')
    try {
      expect(tagAtHead(work)).toEqual(UNKNOWN)
      expect(inflate).toHaveBeenCalled()
      for (const call of inflate.mock.calls) {
        const options = call[1] as { maxOutputLength?: number } | undefined
        expect(options?.maxOutputLength).toBeGreaterThan(0)
        expect(options?.maxOutputLength).toBeLessThanOrEqual(16 * 1024)
      }
    } finally {
      inflate.mockRestore()
    }
  })

  it('is unknown, and inflates nothing, for a loose object over its compressed cap', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    const noise = Buffer.from(
      Array.from({ length: 6000 }, (_, i) => (i * 2654435761) & 0xff),
    )
    plantTag(work, 'big', FAKE_ID, zlib.deflateSync(noise, { level: 0 }))
    expect(fs.statSync(looseObjectFile(work, FAKE_ID)).size).toBeGreaterThan(
      4096,
    )
    const inflate = spyOn(zlib, 'inflateSync')
    try {
      expect(tagAtHead(work)).toEqual(UNKNOWN)
      expect(inflate).not.toHaveBeenCalled()
    } finally {
      inflate.mockRestore()
    }
  })

  it('inflates at most 16 objects, and 16 non-HEAD tag objects are still readable', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    const base = git(work, ['rev-parse', 'HEAD'])
    commitFiles(work, { 'two.txt': 'two\n' }, 'two')
    git(work, ['tag', 'v2'])
    for (let i = 0; i < 15; i += 1) {
      git(work, ['tag', '-a', `old-${i}`, '-m', `old ${i}`, base])
    }
    // `v1` is the sixteenth object: a lightweight tag on an older commit is
    // still read once to learn it is not a tag object.
    expect(tagAtHead(work)).toEqual(tag('v2'))
    git(work, ['tag', '-a', 'old-15', '-m', 'old 15', base])
    const inflate = spyOn(zlib, 'inflateSync')
    try {
      expect(tagAtHead(work)).toEqual(UNKNOWN)
      expect(inflate.mock.calls.length).toBeLessThanOrEqual(16)
    } finally {
      inflate.mockRestore()
    }
  })

  it('is unknown when the refs/tags tree is over its entry cap', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    expect(tagAtHead(work)).toEqual(tag('v1'))
    // Empty directories, as git leaves after a nested tag is deleted: only
    // the entry cap can turn this into unknown.
    for (let i = 0; i < 1100; i += 1) {
      fs.mkdirSync(path.join(work, '.git/refs/tags', `d${i}`))
    }
    expect(tagAtHead(work)).toEqual(UNKNOWN)
    const dir = path.join(work, '.git/refs/tags/many')
    fs.mkdirSync(dir)
    for (let i = 0; i < 1100; i += 1) {
      fs.writeFileSync(path.join(dir, `t${i}`), `${'a'.repeat(40)}\n`)
    }
    const inflate = spyOn(zlib, 'inflateSync')
    try {
      expect(tagAtHead(work)).toEqual(UNKNOWN)
      expect(inflate).not.toHaveBeenCalled()
    } finally {
      inflate.mockRestore()
    }
  })

  it('is unknown when refs/tags nests deeper than its depth cap', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    const deep = Array.from({ length: 12 }, () => 'd').join('/')
    plantTag(work, `${deep}/leaf`, head)
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it.each([
    ['a malformed id on a tag line', `${'z'.repeat(40)} refs/tags/v0\n`],
    [
      'a malformed peeled line',
      `${'b'.repeat(40)} refs/tags/v0\n^${'z'.repeat(5)}\n`,
    ],
    ['an unsafe tag name', `${'b'.repeat(40)} refs/tags/a b\n`],
  ])('is unknown for packed-refs with %s', (_label, line) => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    fs.writeFileSync(path.join(work, '.git/packed-refs'), line)
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it('is unknown for a packed-refs file with more tag lines than its cap', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    const other = 'b'.repeat(40)
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `${other} refs/tags/t${i}`)
    fs.writeFileSync(
      path.join(work, '.git/packed-refs'),
      `${FULLY_PEELED}${lines(50_000).join('\n')}\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
    fs.writeFileSync(
      path.join(work, '.git/packed-refs'),
      `${FULLY_PEELED}${lines(50_001).join('\n')}\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it('is unknown for a packed-refs file over its cap', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    fs.writeFileSync(
      path.join(work, '.git/packed-refs'),
      `# ${'x'.repeat(8 * 1024 * 1024 + 10)}\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it('ignores a packed ref with no peeled line whose id is not HEAD when the file is fully peeled', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    fs.writeFileSync(
      path.join(work, '.git/packed-refs'),
      `${FULLY_PEELED}${'b'.repeat(40)} refs/tags/other\n${'a'.repeat(40)} refs/tags/at-head\n^${head}\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(tag('at-head'))
  })

  it('is unknown for a packed tag whose id is HEAD but whose peeled line names another object', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    const packed = path.join(work, '.git/packed-refs')
    // A tag object at HEAD peels to HEAD, and a lightweight tag at HEAD has no
    // peeled line. An id of HEAD with a different peeled id is neither.
    fs.writeFileSync(
      packed,
      `${FULLY_PEELED}${head} refs/tags/odd\n^${'c'.repeat(40)}\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    // The same contradiction beside a consistent tag leaves the set unresolved.
    fs.writeFileSync(
      packed,
      `${FULLY_PEELED}${head} refs/tags/odd\n^${'c'.repeat(40)}\n${'a'.repeat(40)} refs/tags/real\n^${head}\n`,
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  describe('an unpeeled packed tag', () => {
    const packedRefs = (work: string) => path.join(work, '.git/packed-refs')

    /** Rewrites a real packed-refs file as an old git wrote it: no peeled lines and no `fully-peeled` trait. */
    function stripPeeling(work: string, keepPeeledLines = false): void {
      const text = fs
        .readFileSync(packedRefs(work), 'utf8')
        .split('\n')
        .filter((line) => keepPeeledLines || !line.startsWith('^'))
        .map((line) =>
          line.startsWith('# pack-refs with:')
            ? '# pack-refs with: sorted '
            : line,
        )
        .join('\n')
      fs.writeFileSync(packedRefs(work), text)
    }

    /** A distinct object id per `n`. */
    const fakeId = (n: number): string =>
      `${n.toString(16).padStart(2, '0')}${'cd'.repeat(19)}`

    const tagObjectElsewhere = rawObject(
      'tag',
      `object ${'b'.repeat(40)}\ntype commit\ntag t\n\nm\n`,
    )

    it('is not read when git wrote the file fully peeled', () => {
      const { work } = createClonePastAnnotatedTag()
      git(work, ['tag', 'light', git(work, ['rev-parse', 'old^{commit}'])])
      git(work, ['tag', 'v2'])
      git(work, ['pack-refs', '--all', '--prune'])
      expect(fs.readFileSync(packedRefs(work), 'utf8')).toMatch(
        /^# pack-refs with: .*\bfully-peeled\b/,
      )
      // `light` is a packed tag with no peeled line. Fully-peeled says that
      // means it is not a tag object, so no object is read.
      const inflate = spyOn(zlib, 'inflateSync')
      try {
        expect(tagAtHead(work)).toEqual(tag('v2'))
        expect(inflate).not.toHaveBeenCalled()
      } finally {
        inflate.mockRestore()
      }
    })

    it('is unknown beside a lightweight tag at HEAD when the file is not fully peeled', () => {
      const { work } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'light'])
      git(work, ['tag', '-a', 'noted', '-m', 'm'])
      git(work, ['pack-refs', '--all', '--prune'])
      expect(tagAtHead(work)).toEqual(UNKNOWN)
      stripPeeling(work)
      expect(fs.readFileSync(packedRefs(work), 'utf8')).not.toContain('^')
      expect(tagAtHead(work)).toEqual(UNKNOWN)
    })

    it('is unknown, never a single tag, when its object is stored in a pack', () => {
      const { work } = createClonePastAnnotatedTag()
      git(work, ['tag', 'v2'])
      git(work, ['pack-refs', '--all', '--prune'])
      git(work, ['repack', '-a', '-d', '-q'])
      const objectId = git(work, ['rev-parse', 'old'])
      expect(fs.existsSync(looseObjectFile(work, objectId))).toBe(false)
      expect(tagAtHead(work)).toEqual(tag('v2'))
      stripPeeling(work)
      expect(tagAtHead(work)).toEqual(UNKNOWN)
    })

    it.each([
      ['missing', undefined],
      ['not zlib', Buffer.from('not zlib')],
      ['over its inflate cap', zlib.deflateSync(Buffer.alloc(3 * 1024 * 1024))],
    ])('is unknown when its object is %s', (_label, bytes) => {
      const { work, head } = createClone('https://github.com/o/r.git')
      fs.writeFileSync(
        packedRefs(work),
        `# pack-refs with: sorted \n${head} refs/tags/v1\n${FAKE_ID} refs/tags/odd\n`,
      )
      if (bytes !== undefined) {
        fs.mkdirSync(path.dirname(looseObjectFile(work, FAKE_ID)), {
          recursive: true,
        })
        fs.writeFileSync(looseObjectFile(work, FAKE_ID), bytes)
      }
      expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    })

    it('still names the other tag when the unpeeled tag object resolves to another commit', () => {
      const { work } = createClonePastAnnotatedTag()
      git(work, ['tag', 'v2'])
      git(work, ['pack-refs', '--all', '--prune'])
      stripPeeling(work)
      expect(fs.readFileSync(packedRefs(work), 'utf8')).toContain(
        'refs/tags/old',
      )
      expect(tagAtHead(work)).toEqual(tag('v2'))
    })

    it('trusts a peeled line without reading the object, even when the file is not fully peeled', () => {
      const { work } = createClonePastAnnotatedTag()
      git(work, ['tag', 'v2'])
      git(work, ['pack-refs', '--all', '--prune'])
      git(work, ['repack', '-a', '-d', '-q'])
      stripPeeling(work, true)
      const text = fs.readFileSync(packedRefs(work), 'utf8')
      expect(text).toMatch(/^\^[0-9a-f]{40}$/m)
      expect(text).not.toContain('fully-peeled')
      const inflate = spyOn(zlib, 'inflateSync')
      try {
        expect(tagAtHead(work)).toEqual(tag('v2'))
        expect(inflate).not.toHaveBeenCalled()
      } finally {
        inflate.mockRestore()
      }
    })

    it('reads the fully-peeled trait from the first line only', () => {
      const { work, head } = createClone('https://github.com/o/r.git')
      fs.writeFileSync(
        packedRefs(work),
        `# pack-refs with: sorted \n${head} refs/tags/v1\n${FAKE_ID} refs/tags/odd\n# pack-refs with: peeled fully-peeled sorted \n`,
      )
      expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    })

    it('names the unpeeled annotated tag itself when it is the only tag at HEAD', () => {
      const { work } = createClone('https://github.com/o/r.git')
      git(work, ['tag', '-a', 'noted', '-m', 'm'])
      git(work, ['pack-refs', '--all', '--prune'])
      stripPeeling(work)
      expect(tagAtHead(work)).toEqual(tag('noted'))
    })

    it.each([
      [16, 0, true],
      [17, 0, false],
      [6, 10, true],
      [7, 10, false],
    ])(
      'shares the 16-object budget with loose refs: %i packed beside %i loose (readable: %p)',
      (packed, loose, readable) => {
        const { work, head } = createClone('https://github.com/o/r.git')
        git(work, ['tag', 'v1'])
        const lines = ['# pack-refs with: sorted ']
        for (let i = 0; i < packed; i += 1) {
          const id = fakeId(i)
          fs.mkdirSync(path.dirname(looseObjectFile(work, id)), {
            recursive: true,
          })
          fs.writeFileSync(looseObjectFile(work, id), tagObjectElsewhere)
          lines.push(`${id} refs/tags/p${i}`)
        }
        fs.writeFileSync(packedRefs(work), `${lines.join('\n')}\n`)
        for (let i = 0; i < loose; i += 1) {
          plantTag(work, `l${i}`, fakeId(100 + i), tagObjectElsewhere)
        }
        const inflate = spyOn(zlib, 'inflateSync')
        try {
          expect(readTagAtHead(work, head)).toEqual(
            readable ? tag('v1') : UNKNOWN,
          )
          expect(inflate.mock.calls.length).toBeLessThanOrEqual(16)
        } finally {
          inflate.mockRestore()
        }
      },
    )

    it('does not read an entry that a loose ref of the same name shadows', () => {
      const { work, head } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'v1'])
      fs.writeFileSync(
        packedRefs(work),
        `# pack-refs with: sorted \n${FAKE_ID} refs/tags/v1\n`,
      )
      const inflate = spyOn(zlib, 'inflateSync')
      try {
        expect(readTagAtHead(work, head)).toEqual(tag('v1'))
        expect(inflate).not.toHaveBeenCalled()
      } finally {
        inflate.mockRestore()
      }
    })
  })

  it.each([
    ['a control character', 'v1\u0007'],
    ['a space', 'v 1'],
    ['a character outside the charset', 'v1@home'],
    ['a non-ASCII character', 'v1-é'],
    ['a leading dot', '.hidden'],
    ['a .lock suffix', 'v1.lock'],
    ['more than 64 characters', 'a'.repeat(65)],
  ])('is unknown when a tag name has %s', (_label, name) => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
    // Beside a good tag at HEAD, the odd ref might be a second tag at HEAD,
    // so it is not skipped: it makes the answer unknown.
    plantTag(work, name, FAKE_ID)
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    fs.rmSync(path.join(work, '.git/refs/tags', name))
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
    // And a name that names HEAD itself is never returned unrendered.
    fs.rmSync(path.join(work, '.git/refs/tags/v1'))
    plantTag(work, name, head)
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  it('is unknown for a loose ref whose content is not an object id, or is ../-shaped', () => {
    for (const content of [
      '../../../HEAD\n',
      'not a hash\n',
      '',
      'ref: refs/heads/main\n',
    ]) {
      const { work, head } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'v1'])
      fs.writeFileSync(path.join(work, '.git/refs/tags/bad'), content)
      expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    }
  })

  it('refuses a ref over its size cap', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    fs.writeFileSync(
      path.join(work, '.git/refs/tags/huge'),
      `${head}\n${'x'.repeat(8192)}`,
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
  })

  describe('containment', () => {
    it('does not follow a symlinked refs/tags', () => {
      const { work, head } = createClone('https://github.com/o/r.git')
      const outside = path.join(makeDir('connect-identity-outside-'), 'tags')
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(outside, 'escaped'), `${head}\n`)
      fs.rmSync(path.join(work, '.git/refs/tags'), { recursive: true })
      fs.symlinkSync(outside, path.join(work, '.git/refs/tags'))
      const listed = spyOn(fs, 'opendirSync')
      try {
        expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
        expect(listed).not.toHaveBeenCalled()
      } finally {
        listed.mockRestore()
      }
    })

    it('does not follow a symlinked tag file, or a symlinked tag directory', () => {
      const { work, head } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'v1'])
      const outside = makeDir('connect-identity-outside-')
      fs.writeFileSync(path.join(outside, 'file'), `${head}\n`)
      fs.symlinkSync(
        path.join(outside, 'file'),
        path.join(work, '.git/refs/tags/linked'),
      )
      expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
      fs.rmSync(path.join(work, '.git/refs/tags/linked'))
      expect(readTagAtHead(work, head)).toEqual(tag('v1'))
      fs.symlinkSync(outside, path.join(work, '.git/refs/tags/dir'))
      const listed = spyOn(fs, 'opendirSync')
      try {
        expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
        for (const call of listed.mock.calls) {
          expect(String(call[0]).startsWith(outside)).toBe(false)
        }
      } finally {
        listed.mockRestore()
      }
    })

    it('does not follow a symlinked objects/xx directory', () => {
      const { work } = createClonePastAnnotatedTag()
      git(work, ['tag', 'v2'])
      const id = git(work, ['rev-parse', 'old'])
      const dir = path.join(work, '.git/objects', id.slice(0, 2))
      const outside = path.join(makeDir('connect-identity-outside-'), 'xx')
      fs.renameSync(dir, outside)
      fs.symlinkSync(outside, dir)
      expect(tagAtHead(work)).toEqual(UNKNOWN)
    })

    it('does not follow a symlinked objects directory or .git/refs', () => {
      const { work, head } = createClonePastAnnotatedTag()
      git(work, ['tag', 'v2'])
      const objects = path.join(work, '.git/objects')
      const moved = path.join(makeDir('connect-identity-outside-'), 'objects')
      fs.renameSync(objects, moved)
      fs.symlinkSync(moved, objects)
      expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
      fs.rmSync(objects)
      fs.renameSync(moved, objects)
      expect(readTagAtHead(work, head)).toEqual(tag('v2'))
      const refs = path.join(work, '.git/refs')
      const movedRefs = path.join(makeDir('connect-identity-outside-'), 'refs')
      fs.renameSync(refs, movedRefs)
      fs.symlinkSync(movedRefs, refs)
      expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    })

    it('opens nothing outside .git/refs/tags and .git/objects for a ../-shaped tag', () => {
      const { work, head } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'v1'])
      fs.writeFileSync(path.join(work, '.git/refs/tags/up'), '../../../HEAD\n')
      const read = spyOn(fs, 'openSync')
      try {
        expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
        const opened = read.mock.calls.map((call) => String(call[0]))
        const allowed = [
          path.join(work, '.git/refs/tags'),
          path.join(work, '.git/objects'),
          path.join(work, '.git/packed-refs'),
        ]
        for (const file of opened) {
          expect(allowed.some((root) => file.startsWith(root))).toBe(true)
        }
      } finally {
        read.mockRestore()
      }
    })

    it('is unknown when .git is a file, a symlink or missing', () => {
      const { work, head } = createClone('https://github.com/o/r.git')
      git(work, ['tag', 'v1'])
      const linked = path.join(makeDir('connect-identity-linked-'), 'linked')
      git(work, ['worktree', 'add', '-q', '--detach', linked])
      expect(readTagAtHead(linked, head)).toEqual(UNKNOWN)
      const outer = makeDir('connect-identity-symlink-')
      fs.symlinkSync(path.join(work, '.git'), path.join(outer, '.git'))
      expect(readTagAtHead(outer, head)).toEqual(UNKNOWN)
      expect(readTagAtHead(makeDir('connect-identity-empty-'), head)).toEqual(
        UNKNOWN,
      )
    })
  })

  it('is unknown for a missing root, a missing refs/tags and a HEAD that is not an object id, and never throws', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    expect(readTagAtHead('/nonexistent/connect-identity', head)).toEqual(
      UNKNOWN,
    )
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    git(work, ['tag', 'v1'])
    expect(readTagAtHead(work, 'not-a-hash')).toEqual(UNKNOWN)
    expect(readTagAtHead(work, '../../x')).toEqual(UNKNOWN)
    fs.rmSync(path.join(work, '.git/refs/tags'), { recursive: true })
    expect(readTagAtHead(work, head)).toEqual(UNKNOWN)
    git(work, ['tag', 'v1'])
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
  })

  it('finds a packed tag when .git/refs/tags is missing', () => {
    const { work, head } = createClone('https://github.com/o/r.git')
    git(work, ['tag', 'v1'])
    git(work, ['pack-refs', '--all', '--prune'])
    fs.rmSync(path.join(work, '.git/refs/tags'), { recursive: true })
    expect(readTagAtHead(work, head)).toEqual(tag('v1'))
  })

  it('reads a tag with git removed from PATH, so it starts no subprocess', () => {
    const { work } = createClone('https://github.com/o/r.git')
    git(work, ['tag', '-a', 'v9', '-m', 'm'])
    const commit = readRepoIdentity(work).commit ?? ''
    const original = process.env.PATH
    process.env.PATH = ''
    try {
      expect(readTagAtHead(work, commit)).toEqual(tag('v9'))
    } finally {
      process.env.PATH = original
    }
  })
})
