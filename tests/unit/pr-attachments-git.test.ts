import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/pr-attachments/scripts/pr-attachments.mjs',
)

const CANARY = 'SECRET-CANARY-91d4a6c0'
const NO_SUCH_COMMIT = 'd'.repeat(40)
const A_PNG = 'docs/evidence/topic/a.png'
const B_PNG = 'docs/evidence/topic/b.png'

// ── Process harness ────────────────────────────────────────────────────────

function withoutGitEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('GIT_') && entry[1] !== undefined,
    ),
  )
}

const tempDirs: string[] = []

function makeDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pr-attachments-git-')),
  )
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

// Fixture git runs with no inherited `GIT_*` variables and no global or system
// config. The identity and signing options come from `-c`, so nothing is
// written to any config file.
function isolatedGit(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=test',
      '-c',
      'user.email=t@t.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    {
      cwd,
      env: {
        ...withoutGitEnv(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().replace(/\n$/, '')
}

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly report: Record<string, unknown>
}

interface RunOptions {
  readonly cwd: string
  readonly env?: Record<string, string>
}

function runHelper(
  operation: string,
  input: unknown,
  options: RunOptions,
): Run {
  const home = makeDir()
  const result = spawnSync('node', [SCRIPT_PATH, operation], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: options.cwd,
    env: {
      ...withoutGitEnv(),
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...options.env,
    },
  })
  const parsed: unknown = JSON.parse(result.stdout)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object on stdout')
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: parsed as Record<string, unknown>,
  }
}

function listOf(report: Record<string, unknown>, key: string): unknown[] {
  const value = report[key]
  if (!Array.isArray(value)) {
    throw new Error(`expected array field ${key}`)
  }
  return value
}

function records(
  report: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  return listOf(report, key).map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`expected object items in ${key}`)
    }
    return item as Record<string, unknown>
  })
}

function mapOf(
  report: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = report[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected object field ${key}`)
  }
  return value as Record<string, unknown>
}

// ── Repository fixtures ────────────────────────────────────────────────────

interface Repo {
  readonly work: string
  readonly origin: string
}

type Change = string | Buffer | null

function commitFiles(
  work: string,
  files: Record<string, Change>,
  message: string,
): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(work, rel)
    if (content === null) {
      fs.rmSync(file, { force: true })
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  }
  isolatedGit(work, ['add', '-A'])
  isolatedGit(work, ['commit', '-q', '-m', message, '--no-verify'])
  return isolatedGit(work, ['rev-parse', 'HEAD'])
}

/** A working clone with a local bare remote; `main` is pushed to `origin`. */
function createRepo(baseFiles: Record<string, Change> = {}): Repo {
  const root = makeDir()
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  isolatedGit(root, ['init', '-q', '--bare', '-b', 'main', origin])
  fs.mkdirSync(work)
  isolatedGit(work, ['init', '-q', '-b', 'main'])
  isolatedGit(work, ['remote', 'add', 'origin', origin])
  commitFiles(work, { 'README.md': 'base\n', ...baseFiles }, 'base')
  isolatedGit(work, ['push', '-q', 'origin', 'main'])
  return { work, origin }
}

function startPr(repo: Repo): void {
  isolatedGit(repo.work, ['checkout', '-q', '-b', 'feat/x'])
}

/** Commits on `main` and pushes, then returns to the PR branch. */
function advanceBase(repo: Repo, files: Record<string, Change>): void {
  isolatedGit(repo.work, ['checkout', '-q', 'main'])
  commitFiles(repo.work, files, 'base moves on')
  isolatedGit(repo.work, ['push', '-q', 'origin', 'main'])
  isolatedGit(repo.work, ['checkout', '-q', 'feat/x'])
}

function head(repo: Repo): string {
  return isolatedGit(repo.work, ['rev-parse', 'HEAD'])
}

function blobAt(repo: Repo, rev: string, file: string): string {
  return isolatedGit(repo.work, ['rev-parse', `${rev}:${file}`])
}

function png(label: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label),
  ])
}

// ── Operation wrappers ─────────────────────────────────────────────────────

interface UrlRef {
  readonly path: string
  readonly sha: string
}

function runPins(
  repo: Repo,
  headOid: string,
  urls: readonly UrlRef[],
  extra: Record<string, unknown> = {},
  options: Partial<RunOptions> = {},
): Run {
  return runHelper(
    'pins',
    { head_ref_oid: headOid, urls, ...extra },
    { cwd: repo.work, ...options },
  )
}

function runCleanup(
  repo: Repo,
  headOid: string,
  extra: Record<string, unknown> = {},
  options: Partial<RunOptions> = {},
): Run {
  return runHelper(
    'cleanup-set',
    {
      head_ref_oid: headOid,
      base_ref_name: 'main',
      remote: 'origin',
      ...extra,
    },
    { cwd: repo.work, ...options },
  )
}

function pathsOf(run: Run): string[] {
  return listOf(run.report, 'paths').map(String)
}

function currentFor(run: Run, file: string): Record<string, unknown> {
  const entry = records(run.report, 'paths').find((item) => item.path === file)
  if (entry === undefined) {
    throw new Error(`no entry for ${file}`)
  }
  return entry
}

function stagedStatus(repo: Repo): string {
  return isolatedGit(repo.work, ['diff', '--cached', '--name-status'])
}

// ── pins ───────────────────────────────────────────────────────────────────

describe('pins: choosing the newest add-or-modify commit', () => {
  it('re-pins to the commit that overwrote the image, and calls the old pin invalid', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')
    const overwriteB = commitFiles(repo.work, { [A_PNG]: png('B') }, 'swap B')

    const run = runPins(repo, head(repo), [{ path: A_PNG, sha: addA }])

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('repin-needed')
    const entry = currentFor(run, A_PNG)
    expect(entry.state).toBe('stale')
    expect(entry.newest_commit).toBe(overwriteB)
    expect(records(entry, 'current')).toEqual([
      { sha: addA, valid: false, reason: 'blob-differs' },
    ])
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: overwriteB })
    expect(listOf(run.report, 'unresolved_paths')).toEqual([])
  })

  it('reports already-valid when every pin serves the head bytes', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')
    const overwriteB = commitFiles(repo.work, { [A_PNG]: png('B') }, 'swap B')

    const run = runPins(repo, head(repo), [{ path: A_PNG, sha: overwriteB }])

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('already-valid')
    expect(currentFor(run, A_PNG).state).toBe('valid')
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: overwriteB })
  })

  it('keeps an older pin whose blob equals the newest commit blob', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')
    commitFiles(repo.work, { 'notes.txt': 'unrelated\n' }, 'touch another file')
    commitFiles(repo.work, { [A_PNG]: png('B') }, 'swap B')
    const backToA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'back to A')
    expect(backToA).not.toBe(addA)

    const run = runPins(repo, head(repo), [{ path: A_PNG, sha: addA }])

    expect(run.report.result).toBe('already-valid')
    expect(currentFor(run, A_PNG).newest_commit).toBe(backToA)
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: addA })
  })

  it('follows a merge that resolved the file to bytes neither side had', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')
    isolatedGit(repo.work, ['checkout', '-q', '-b', 'side'])
    commitFiles(repo.work, { [A_PNG]: png('side') }, 'side edit')
    isolatedGit(repo.work, ['checkout', '-q', 'feat/x'])
    commitFiles(repo.work, { [A_PNG]: png('feat') }, 'feat edit')
    // Both sides edited the file. The merge keeps neither version.
    isolatedGit(repo.work, [
      'merge',
      '-q',
      '-s',
      'ours',
      '--no-commit',
      '--no-ff',
      'side',
    ])
    fs.writeFileSync(path.join(repo.work, A_PNG), png('resolved'))
    isolatedGit(repo.work, ['add', A_PNG])
    isolatedGit(repo.work, ['commit', '-q', '-m', 'merge side', '--no-verify'])
    const merge = head(repo)

    const run = runPins(repo, merge, [{ path: A_PNG, sha: merge }])

    expect(currentFor(run, A_PNG).newest_commit).toBe(merge)
    expect(run.report.result).toBe('already-valid')
  })

  it('pins a file that arrived by rename to the commit that renamed it', () => {
    const repo = createRepo({ 'shots/a.png': png('A') })
    startPr(repo)
    fs.mkdirSync(path.join(repo.work, 'docs/evidence/topic'), {
      recursive: true,
    })
    isolatedGit(repo.work, ['mv', 'shots/a.png', A_PNG])
    isolatedGit(repo.work, ['commit', '-q', '-m', 'move in', '--no-verify'])
    const moved = head(repo)

    const run = runPins(repo, moved, [{ path: A_PNG, sha: NO_SUCH_COMMIT }])

    expect(currentFor(run, A_PNG).newest_commit).toBe(moved)
  })
})

describe('pins: when a pin is not valid', () => {
  it('rejects a commit that is not reachable from the head, even with equal bytes', () => {
    const repo = createRepo()
    isolatedGit(repo.work, ['checkout', '-q', '-b', 'side'])
    const onSide = commitFiles(repo.work, { [A_PNG]: png('A') }, 'side add')
    isolatedGit(repo.work, ['checkout', '-q', 'main'])
    startPr(repo)
    const onPr = commitFiles(repo.work, { [A_PNG]: png('A') }, 'pr add')
    expect(blobAt(repo, onSide, A_PNG)).toBe(blobAt(repo, onPr, A_PNG))

    const run = runPins(repo, onPr, [{ path: A_PNG, sha: onSide }])

    expect(run.report.result).toBe('repin-needed')
    expect(records(currentFor(run, A_PNG), 'current')).toEqual([
      { sha: onSide, valid: false, reason: 'not-reachable' },
    ])
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: onPr })
  })

  it('rejects a commit the repository does not have', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runPins(repo, addA, [{ path: A_PNG, sha: NO_SUCH_COMMIT }])

    expect(records(currentFor(run, A_PNG), 'current')).toEqual([
      { sha: NO_SUCH_COMMIT, valid: false, reason: 'commit-unknown' },
    ])
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: addA })
  })

  it('rejects a reachable commit from before the file existed', () => {
    const repo = createRepo()
    const before = head(repo)
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runPins(repo, addA, [{ path: A_PNG, sha: before }])

    expect(records(currentFor(run, A_PNG), 'current')).toEqual([
      { sha: before, valid: false, reason: 'path-missing' },
    ])
  })

  it('accepts an upper-case pin and reports it in lower case', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runPins(repo, addA, [{ path: A_PNG, sha: addA.toUpperCase() }])

    expect(run.report.result).toBe('already-valid')
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: addA })
  })
})

describe('pins: paths that cannot be resolved', () => {
  it('reports partial and names the path that never existed on the head', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runPins(repo, addA, [
      { path: A_PNG, sha: addA },
      { path: B_PNG, sha: addA },
    ])

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('partial')
    expect(listOf(run.report, 'unresolved_paths')).toEqual([B_PNG])
    expect(currentFor(run, B_PNG).state).toBe('unresolved')
    expect(currentFor(run, B_PNG).newest_commit).toBeNull()
    expect(mapOf(run.report, 'pins')).toEqual({ [A_PNG]: addA })
  })

  it('stops when no path ever existed on the head', () => {
    const repo = createRepo()
    startPr(repo)
    const other = commitFiles(repo.work, { 'x.txt': 'x\n' }, 'other')

    const run = runPins(repo, other, [
      { path: A_PNG, sha: other },
      { path: B_PNG, sha: other },
    ])

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('unresolved')
    expect(listOf(run.report, 'unresolved_paths')).toEqual([A_PNG, B_PNG])
    expect(mapOf(run.report, 'pins')).toEqual({})
  })

  it('resolves a path once for several embeds of it', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runPins(repo, addA, [
      { path: A_PNG, sha: addA },
      { path: A_PNG, sha: addA },
    ])

    expect(records(run.report, 'paths')).toHaveLength(1)
    expect(records(currentFor(run, A_PNG), 'current')).toHaveLength(1)
  })

  it('stops when the head commit is not in the repository', () => {
    const repo = createRepo()

    const run = runPins(repo, NO_SUCH_COMMIT, [
      { path: A_PNG, sha: NO_SUCH_COMMIT },
    ])

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('head-not-found')
  })
})

describe('pins: input', () => {
  const repo = () => createRepo()

  it('exits 2 for an empty url list', () => {
    const run = runPins(repo(), NO_SUCH_COMMIT, [])
    expect(run.status).toBe(2)
    expect(run.report.result).toBe('usage-error')
    expect(run.report.error).toBe('empty-paths')
  })

  it('accepts the output of the urls subcommand as it is', () => {
    const r = repo()
    startPr(r)
    const addA = commitFiles(r.work, { [A_PNG]: png('A') }, 'add A')
    const urls = [
      {
        owner: 'octo',
        repo: 'repo',
        sha: addA,
        path: A_PNG,
        form: 'raw',
      },
    ]

    const run = runHelper(
      'pins',
      { head_ref_oid: addA, urls, ignored: 3 },
      { cwd: r.work },
    )

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('already-valid')
  })

  for (const [name, input] of [
    ['a head that is not 40 hex', { head_ref_oid: 'main', urls: [] }],
    [
      'a path outside docs/evidence',
      {
        head_ref_oid: NO_SUCH_COMMIT,
        urls: [{ path: 'src/a.png', sha: NO_SUCH_COMMIT }],
      },
    ],
    [
      'a sha that is not 40 hex',
      {
        head_ref_oid: NO_SUCH_COMMIT,
        urls: [{ path: A_PNG, sha: 'abc123' }],
      },
    ],
    [
      'a timeout that is not a positive integer',
      {
        head_ref_oid: NO_SUCH_COMMIT,
        urls: [{ path: A_PNG, sha: NO_SUCH_COMMIT }],
        git_timeout_ms: 0,
      },
    ],
  ] as const) {
    it(`exits 2 for ${name}`, () => {
      const run = runHelper('pins', input, { cwd: repo().work })
      expect(run.status).toBe(2)
      expect(run.report.result).toBe('usage-error')
      expect(run.report.error).toBe('invalid-input')
    })
  }
})

// ── cleanup-set: the set ───────────────────────────────────────────────────

describe('cleanup-set: what the PR added under docs/evidence', () => {
  it('lists the added files in order, with a digest', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(
      repo.work,
      { [B_PNG]: png('B'), [A_PNG]: png('A') },
      'add evidence',
    )

    const run = runCleanup(repo, head(repo))

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('set')
    expect(pathsOf(run)).toEqual([A_PNG, B_PNG])
    expect(run.report.count).toBe(2)
    expect(run.report.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('includes a file renamed into docs/evidence from outside it', () => {
    const repo = createRepo({ 'shots/a.png': png('A') })
    startPr(repo)
    fs.mkdirSync(path.join(repo.work, 'docs/evidence/topic'), {
      recursive: true,
    })
    isolatedGit(repo.work, ['mv', 'shots/a.png', A_PNG])
    isolatedGit(repo.work, ['commit', '-q', '-m', 'move in', '--no-verify'])

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('includes a file renamed within docs/evidence, and not the old name', () => {
    const repo = createRepo({ 'docs/evidence/old/a.png': png('A') })
    startPr(repo)
    fs.mkdirSync(path.join(repo.work, 'docs/evidence/topic'), {
      recursive: true,
    })
    isolatedGit(repo.work, ['mv', 'docs/evidence/old/a.png', A_PNG])
    isolatedGit(repo.work, ['commit', '-q', '-m', 'rename', '--no-verify'])

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('excludes a path the base gained after the merge-base', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(
      repo.work,
      { [A_PNG]: png('A'), [B_PNG]: png('B') },
      'add evidence',
    )
    advanceBase(repo, { [B_PNG]: png('base B') })

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('excludes files the PR did not add', () => {
    const repo = createRepo({
      'docs/evidence/old/kept.png': png('kept'),
      'docs/evidence/old/edited.png': png('v1'),
    })
    startPr(repo)
    commitFiles(
      repo.work,
      { 'docs/evidence/old/edited.png': png('v2'), [A_PNG]: png('A') },
      'edit one, add one',
    )

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('excludes a file the PR modified even when the base later deleted it', () => {
    const modified = 'docs/evidence/old/modified.png'
    const repo = createRepo({ [modified]: png('v1') })
    startPr(repo)
    commitFiles(
      repo.work,
      { [modified]: png('v2'), [A_PNG]: png('A') },
      'modify one, add one',
    )
    // The base tip no longer has `modified`, so subtracting the base tip's
    // files cannot remove it. Only the add-only diff filter keeps it out.
    advanceBase(repo, { [modified]: null })

    const run = runCleanup(repo, head(repo))

    expect(run.status).toBe(0)
    expect(pathsOf(run)).toEqual([A_PNG])
    expect(pathsOf(run)).not.toContain(modified)
  })

  it('leaves out a file that the PR added and then deleted', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A'), [B_PNG]: png('B') }, 'add')
    commitFiles(repo.work, { [A_PNG]: null }, 'drop A')

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([B_PNG])
  })

  it('never lists a file outside docs/evidence', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(
      repo.work,
      {
        [A_PNG]: png('A'),
        'docs/evidence-old/x.png': png('x'),
        'docs/evidence.png': png('y'),
        'docs/other/evidence/z.png': png('z'),
        'src/main.ts': 'export {}\n',
        'evidence/q.png': png('q'),
      },
      'add several',
    )

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('reports an empty set with exit 0', () => {
    const repo = createRepo()
    startPr(repo)
    const other = commitFiles(repo.work, { 'x.txt': 'x\n' }, 'other')

    const run = runCleanup(repo, other)

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('empty')
    expect(pathsOf(run)).toEqual([])
    expect(run.report.count).toBe(0)
    expect(run.report.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lists names with spaces, wildcards and non-ASCII characters exactly', () => {
    const repo = createRepo()
    startPr(repo)
    const odd = [
      'docs/evidence/topic/a b.png',
      'docs/evidence/topic/a*.png',
      'docs/evidence/topic/caf\u00e9.png',
    ]
    commitFiles(
      repo.work,
      Object.fromEntries(odd.map((file) => [file, png(file)])),
      'odd names',
    )

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([...odd].sort())
  })

  it('works from a subdirectory of the repository', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runHelper(
      'cleanup-set',
      { head_ref_oid: head(repo), base_ref_name: 'main', remote: 'origin' },
      { cwd: path.join(repo.work, 'docs/evidence') },
    )

    expect(run.report.result).toBe('set')
    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('takes a resolved base ref in place of a name and a remote', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runHelper(
      'cleanup-set',
      { head_ref_oid: head(repo), base_ref: 'refs/remotes/origin/main' },
      { cwd: repo.work },
    )

    expect(run.status).toBe(0)
    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('reports the base tip and merge-base it used', () => {
    const repo = createRepo()
    const branchPoint = head(repo)
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')
    advanceBase(repo, { 'later.txt': 'later\n' })
    const baseTip = isolatedGit(repo.work, ['rev-parse', 'origin/main'])

    const run = runCleanup(repo, head(repo))

    expect(run.report.base_tip).toBe(baseTip)
    expect(run.report.merge_base).toBe(branchPoint)
  })
})

describe('cleanup-set: the digest', () => {
  it('is the same for the same set, in any commit order', () => {
    const first = createRepo()
    startPr(first)
    commitFiles(first.work, { [A_PNG]: png('A') }, 'A')
    commitFiles(first.work, { [B_PNG]: png('B') }, 'B')
    const second = createRepo()
    startPr(second)
    commitFiles(second.work, { [B_PNG]: png('other B') }, 'B')
    commitFiles(second.work, { [A_PNG]: png('other A') }, 'A')

    const one = runCleanup(first, head(first))
    const again = runCleanup(first, head(first))
    const two = runCleanup(second, head(second))

    expect(one.report.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(again.report.digest).toBe(one.report.digest)
    expect(two.report.digest).toBe(one.report.digest)
  })

  it('changes when the set changes', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'A')
    const before = runCleanup(repo, head(repo))
    commitFiles(repo.work, { [B_PNG]: png('B') }, 'B')
    const after = runCleanup(repo, head(repo))
    commitFiles(repo.work, { [B_PNG]: null }, 'drop B')
    const restored = runCleanup(repo, head(repo))

    expect(after.report.digest).not.toBe(before.report.digest)
    expect(restored.report.digest).toBe(before.report.digest)
  })

  it('tells sets of equal size apart', () => {
    const one = createRepo()
    startPr(one)
    commitFiles(one.work, { [A_PNG]: png('A') }, 'A')
    const two = createRepo()
    startPr(two)
    commitFiles(two.work, { [B_PNG]: png('A') }, 'B')

    expect(runCleanup(one, head(one)).report.digest).not.toBe(
      runCleanup(two, head(two)).report.digest,
    )
  })
})

// ── cleanup-set: removal ───────────────────────────────────────────────────

describe('cleanup-set: removal', () => {
  function prWithEvidence(): { repo: Repo; headOid: string; digest: string } {
    const repo = createRepo({ 'docs/evidence/old/kept.png': png('kept') })
    startPr(repo)
    commitFiles(
      repo.work,
      { [A_PNG]: png(CANARY), [B_PNG]: png('B'), 'src/keep.ts': 'keep\n' },
      'add evidence',
    )
    const headOid = head(repo)
    const listed = runCleanup(repo, headOid)
    return { repo, headOid, digest: String(listed.report.digest) }
  }

  it('removes exactly the set when the digest matches, and commits nothing', () => {
    const { repo, headOid, digest } = prWithEvidence()

    const run = runCleanup(repo, headOid, { remove_digest: digest })

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('removed')
    expect(pathsOf(run)).toEqual([A_PNG, B_PNG])
    expect(fs.existsSync(path.join(repo.work, A_PNG))).toBe(false)
    expect(fs.existsSync(path.join(repo.work, B_PNG))).toBe(false)
    expect(
      fs.existsSync(path.join(repo.work, 'docs/evidence/old/kept.png')),
    ).toBe(true)
    expect(fs.existsSync(path.join(repo.work, 'src/keep.ts'))).toBe(true)
    expect(stagedStatus(repo)).toBe(`D\t${A_PNG}\nD\t${B_PNG}`)
    expect(head(repo)).toBe(headOid)
  })

  it('refuses on a digest mismatch and removes nothing', () => {
    const { repo, headOid, digest } = prWithEvidence()
    const newHead = commitFiles(
      repo.work,
      { 'docs/evidence/topic/c.png': png('C') },
      'one more image',
    )

    const run = runCleanup(repo, newHead, { remove_digest: digest })

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('digest-mismatch')
    expect(pathsOf(run)).toEqual([A_PNG, B_PNG, 'docs/evidence/topic/c.png'])
    expect(run.report.digest).not.toBe(digest)
    expect(fs.existsSync(path.join(repo.work, A_PNG))).toBe(true)
    expect(stagedStatus(repo)).toBe('')
    expect(head(repo)).toBe(newHead)
    expect(headOid).not.toBe(newHead)
  })

  it('refuses when the checked-out commit is not the head commit', () => {
    const { repo, headOid, digest } = prWithEvidence()
    commitFiles(repo.work, { 'later.txt': 'later\n' }, 'unpushed work')

    const run = runCleanup(repo, headOid, { remove_digest: digest })

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('head-not-checked-out')
    expect(fs.existsSync(path.join(repo.work, A_PNG))).toBe(true)
    expect(stagedStatus(repo)).toBe('')
  })

  it('removes a file whose name looks like a wildcard and nothing else', () => {
    const repo = createRepo({ 'docs/evidence/topic/ab.png': png('base') })
    startPr(repo)
    const starred = 'docs/evidence/topic/a*.png'
    commitFiles(repo.work, { [starred]: png('star') }, 'add starred')
    const headOid = head(repo)
    const listed = runCleanup(repo, headOid)
    expect(pathsOf(listed)).toEqual([starred])

    const run = runCleanup(repo, headOid, {
      remove_digest: String(listed.report.digest),
    })

    expect(run.report.result).toBe('removed')
    expect(fs.existsSync(path.join(repo.work, starred))).toBe(false)
    expect(
      fs.existsSync(path.join(repo.work, 'docs/evidence/topic/ab.png')),
    ).toBe(true)
  })

  it('does nothing for an empty set, even with a matching digest', () => {
    const repo = createRepo()
    startPr(repo)
    const other = commitFiles(repo.work, { 'x.txt': 'x\n' }, 'other')
    const listed = runCleanup(repo, other)

    const run = runCleanup(repo, other, {
      remove_digest: String(listed.report.digest),
    })

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('empty')
    expect(stagedStatus(repo)).toBe('')
  })

  it('exits 1 and leaves the index alone when git rm cannot run', () => {
    const { repo, headOid, digest } = prWithEvidence()
    fs.writeFileSync(path.join(repo.work, '.git/index.lock'), '')

    const run = runCleanup(repo, headOid, { remove_digest: digest })

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('git-failed')
    expect(mapOf(run.report, 'reached').step).toBe('remove')
    expect(mapOf(run.report, 'reached').removal_attempted).toBe(true)
    expect(fs.existsSync(path.join(repo.work, A_PNG))).toBe(true)
  })
})

describe('cleanup-set: unresolved inputs', () => {
  it('stops when the base ref is not in the repository', () => {
    const repo = createRepo()
    startPr(repo)
    const headOid = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runCleanup(repo, headOid, { remote: 'upstream' })

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('base-not-found')
  })

  it('stops when the head commit is not in the repository', () => {
    const repo = createRepo()

    const run = runCleanup(repo, NO_SUCH_COMMIT)

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('head-not-found')
  })

  it('stops when the head and the base share no history', () => {
    const repo = createRepo()
    isolatedGit(repo.work, ['checkout', '-q', '--orphan', 'feat/x'])
    isolatedGit(repo.work, ['rm', '-rq', '--cached', '.'])
    const orphan = commitFiles(repo.work, { [A_PNG]: png('A') }, 'orphan')

    const run = runCleanup(repo, orphan)

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('no-merge-base')
  })
})

describe('cleanup-set: input', () => {
  const base = {
    head_ref_oid: NO_SUCH_COMMIT,
    base_ref_name: 'main',
    remote: 'origin',
  }

  for (const [name, input] of [
    ['no base at all', { head_ref_oid: NO_SUCH_COMMIT }],
    ['a name without a remote', { ...base, remote: undefined }],
    [
      'a name and a resolved ref together',
      { ...base, base_ref: 'refs/heads/x' },
    ],
    ['a head that is not 40 hex', { ...base, head_ref_oid: 'HEAD' }],
    ['a base name that starts with a dash', { ...base, base_ref_name: '-x' }],
    ['a base name with a parent segment', { ...base, base_ref_name: 'a/../b' }],
    ['a remote that starts with a dash', { ...base, remote: '--upload-pack' }],
    [
      'a resolved ref outside refs/',
      { head_ref_oid: NO_SUCH_COMMIT, base_ref: 'main' },
    ],
    ['a digest that is not 64 hex', { ...base, remove_digest: 'abc' }],
    ['an upper-case digest', { ...base, remove_digest: 'A'.repeat(64) }],
    ['a timeout of zero', { ...base, git_timeout_ms: 0 }],
  ] as const) {
    it(`exits 2 for ${name}`, () => {
      const run = runHelper('cleanup-set', input, { cwd: makeDir() })
      expect(run.status).toBe(2)
      expect(run.report.result).toBe('usage-error')
      expect(run.report.error).toBe('invalid-input')
    })
  }
})

// ── git environment, failure and timeout ───────────────────────────────────

describe('git runs in a sanitized environment', () => {
  it('ignores GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE from the caller', () => {
    const repo = createRepo()
    startPr(repo)
    commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')
    const decoy = makeDir()

    const run = runCleanup(
      repo,
      head(repo),
      {},
      {
        cwd: repo.work,
        env: {
          GIT_DIR: path.join(decoy, 'nowhere'),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: path.join(decoy, 'index'),
        },
      },
    )

    expect(run.status).toBe(0)
    expect(pathsOf(run)).toEqual([A_PNG])
  })

  it('reads no hostile diff.renames setting', () => {
    const repo = createRepo({ 'docs/evidence/old/a.png': png('A') })
    startPr(repo)
    fs.mkdirSync(path.join(repo.work, 'docs/evidence/topic'), {
      recursive: true,
    })
    isolatedGit(repo.work, ['mv', 'docs/evidence/old/a.png', A_PNG])
    isolatedGit(repo.work, ['commit', '-q', '-m', 'rename', '--no-verify'])
    isolatedGit(repo.work, ['config', 'diff.renames', 'copies'])

    const run = runCleanup(repo, head(repo))

    expect(pathsOf(run)).toEqual([A_PNG])
  })
})

describe('git failure and timeout', () => {
  function realGit(): string {
    const found = Bun.which('git')
    if (found === null) {
      throw new Error('git is not on PATH')
    }
    return found
  }

  function fakeGit(script: string): Record<string, string> {
    const dir = makeDir()
    const file = path.join(dir, 'git')
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }
  }

  const hangOn = (word: string) =>
    fakeGit(
      `for arg in "$@"; do if [ "$arg" = ${word} ]; then exec sleep 5; fi; done\nexec "${realGit()}" "$@"`,
    )

  it('exits 1 with git-timeout and the step reached, for cleanup-set', () => {
    const repo = createRepo()
    startPr(repo)
    const headOid = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runCleanup(
      repo,
      headOid,
      { git_timeout_ms: 400 },
      { cwd: repo.work, env: hangOn('merge-base') },
    )

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('git-timeout')
    expect(mapOf(run.report, 'reached').step).toBe('merge-base')
    expect(mapOf(run.report, 'reached').removal_attempted).toBe(false)
  })

  it('exits 1 with git-timeout and the progress made, for pins', () => {
    const repo = createRepo()
    startPr(repo)
    const addA = commitFiles(repo.work, { [A_PNG]: png('A') }, 'add A')

    const run = runPins(
      repo,
      addA,
      [{ path: A_PNG, sha: addA }],
      { git_timeout_ms: 400 },
      { cwd: repo.work, env: hangOn('log') },
    )

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('git-timeout')
    expect(mapOf(run.report, 'reached')).toEqual({
      step: 'newest-commit',
      paths_done: 0,
      paths_total: 1,
    })
  })

  it('exits 1 with git-failed when git itself fails', () => {
    const notARepo = makeDir()

    const run = runHelper(
      'cleanup-set',
      { head_ref_oid: NO_SUCH_COMMIT, base_ref_name: 'main', remote: 'origin' },
      { cwd: notARepo },
    )

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('git-failed')
    expect(mapOf(run.report, 'reached').step).toBe('locate-repo')
  })

  it('exits 1 with git-failed when git is not installed', () => {
    const repo = createRepo()
    const emptyBin = makeDir()
    const node = process.execPath

    const result = spawnSync(node, [SCRIPT_PATH, 'cleanup-set'], {
      input: JSON.stringify({
        head_ref_oid: NO_SUCH_COMMIT,
        base_ref_name: 'main',
        remote: 'origin',
      }),
      encoding: 'utf8',
      cwd: repo.work,
      env: { PATH: emptyBin },
    })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).result).toBe('git-failed')
  })

  it('does not echo git output or file content', () => {
    const repo = createRepo()
    startPr(repo)
    const headOid = commitFiles(
      repo.work,
      { [A_PNG]: png(CANARY), 'secret.txt': CANARY },
      'add',
    )

    const runs = [
      runCleanup(repo, headOid),
      runCleanup(repo, NO_SUCH_COMMIT),
      runPins(repo, headOid, [{ path: A_PNG, sha: NO_SUCH_COMMIT }]),
    ]

    expect(runs.map((run) => run.report.result)).toEqual([
      'set',
      'head-not-found',
      'repin-needed',
    ])
    for (const run of runs) {
      expect(run.stdout).not.toContain(CANARY)
      expect(run.stderr).toBe('')
    }
  })
})
