import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Shared fixtures for the git-worktree script tests. Everything runs real git
// against throwaway repositories with a local bare `origin`, so no test depends
// on the developer's git config, home directory or network.

export const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
export const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/git-worktree/scripts/worktree-manager.sh',
)

const tempDirs: string[] = []

/** A fresh temp directory, symlink-resolved (`/tmp` is `/private/tmp` on macOS). */
export function makeDir(prefix = 'git-worktree-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function withoutGitEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('GIT_') && entry[1] !== undefined,
    ),
  )
}

function isolatedEnv(): Record<string, string> {
  const home = makeDir('git-worktree-home-')
  return {
    ...withoutGitEnv(),
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'test',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 't@t.test',
    GIT_CONFIG_KEY_2: 'protocol.file.allow',
    GIT_CONFIG_VALUE_2: 'always',
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** Runs git with isolated config and returns trimmed stdout. Throws on failure. */
export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv(),
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.replace(/\n$/, '')
}

/** Like `git`, but returns the exit status instead of throwing. */
export function gitStatus(cwd: string, args: readonly string[]): number {
  return (
    spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      env: isolatedEnv(),
    }).status ?? -1
  )
}

export function commitFiles(
  work: string,
  files: Record<string, string>,
  message = 'commit',
): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(work, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  git(work, ['add', '-f', '-A', ...Object.keys(files)])
  git(work, ['commit', '-q', '-m', message, '--no-verify'])
  return git(work, ['rev-parse', 'HEAD'])
}

export interface Repo {
  readonly root: string
  readonly work: string
  readonly origin: string
}

/**
 * A working clone with a bare `origin`. The default branch is pushed to
 * origin. `origin/HEAD` is not set locally, as in a `git init` + `remote add`.
 */
export function createRepo(
  options: {
    readonly defaultBranch?: string
    readonly files?: Record<string, string>
  } = {},
): Repo {
  const defaultBranch = options.defaultBranch ?? 'main'
  const root = makeDir()
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  git(root, ['init', '-q', '--bare', '-b', defaultBranch, origin])
  fs.mkdirSync(work)
  git(work, ['init', '-q', '-b', defaultBranch])
  git(work, ['remote', 'add', 'origin', origin])
  commitFiles(work, { 'README.md': 'base\n', ...options.files }, 'base')
  git(work, ['push', '-q', 'origin', defaultBranch])
  return { root, work, origin }
}

/** Moves `origin`'s default branch forward without touching the work clone. */
export function advanceOrigin(repo: Repo, branch = 'main'): string {
  const scratch = path.join(makeDir(), 'scratch')
  git(repo.root, ['clone', '-q', repo.origin, scratch])
  const sha = commitFiles(scratch, { 'advance.txt': 'later\n' }, 'advance')
  git(scratch, ['push', '-q', 'origin', branch])
  return sha
}

/** Points `origin` at a URL that cannot be reached, so any fetch fails. */
export function breakRemote(repo: Repo): void {
  git(repo.work, [
    'remote',
    'set-url',
    'origin',
    path.join(repo.root, 'does-not-exist.git'),
  ])
}

/** Layouts the script refuses. Each returns a directory to run from. */
export function createBareRepo(): string {
  const source = createRepo()
  const bare = path.join(source.root, 'bare.git')
  git(source.root, ['clone', '-q', '--bare', source.work, bare])
  return bare
}

export function createCoreBareRepo(): string {
  const repo = createRepo()
  git(repo.work, ['config', 'core.bare', 'true'])
  return repo.work
}

export function createSeparateGitDirRepo(): string {
  const root = makeDir()
  const work = path.join(root, 'work')
  fs.mkdirSync(work)
  git(work, [
    'init',
    '-q',
    '-b',
    'main',
    `--separate-git-dir=${path.join(root, 'elsewhere.git')}`,
  ])
  commitFiles(work, { 'README.md': 'base\n' }, 'base')
  return work
}

/**
 * Git metadata at `storage/.git` (a directory literally named `.git`) for a
 * checkout elsewhere: the git dir is not inside its work tree.
 */
export function createDetachedDotGitRepo(): {
  readonly work: string
  readonly storage: string
} {
  const root = makeDir()
  const work = path.join(root, 'checkout')
  const storage = path.join(root, 'storage')
  fs.mkdirSync(work)
  fs.mkdirSync(storage)
  git(work, [
    'init',
    '-q',
    '-b',
    'main',
    `--separate-git-dir=${path.join(storage, '.git')}`,
  ])
  git(work, ['config', 'core.worktree', work])
  commitFiles(work, { 'README.md': 'base\n' }, 'base')
  return { work, storage }
}

export function createSubmoduleRepo(): string {
  const library = createRepo()
  const host = createRepo()
  git(host.work, ['submodule', 'add', '-q', library.work, 'vendor/library'])
  git(host.work, ['commit', '-q', '-m', 'add submodule', '--no-verify'])
  return path.join(host.work, 'vendor/library')
}

// ── Running the script ─────────────────────────────────────────────────────

export interface RunOptions {
  readonly cwd: string
  /** Extra environment, applied last (may set `GIT_*` to prove they are ignored). */
  readonly env?: Record<string, string>
  /** Directories placed ahead of PATH, for command stubs. */
  readonly pathPrefix?: readonly string[]
  /** Text written to stdin. Default: stdin is closed (/dev/null). */
  readonly stdin?: string
}

export interface ScriptRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs the script under `TEST_BASH` (default `bash`) with a 30 s timeout. */
export function run(args: readonly string[], options: RunOptions): ScriptRun {
  const result = spawnSync(
    process.env.TEST_BASH ?? 'bash',
    [SCRIPT_PATH, ...args],
    {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input: options.stdin,
      timeout: 30_000,
      env: {
        ...isolatedEnv(),
        PATH: [...(options.pathPrefix ?? []), process.env.PATH ?? ''].join(
          path.delimiter,
        ),
        ...options.env,
      },
    },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Runs `create` and fails the test setup loudly if it does not succeed. */
export function create(
  cwd: string,
  branch: string,
  extra: readonly string[] = [],
): string {
  const result = run(['create', branch, ...extra], { cwd })
  if (result.status !== 0) {
    throw new Error(`create ${branch} failed: ${result.stderr}`)
  }
  const created = fields(result.stdout.trim().split('\n').pop() ?? '').path
  if (created === undefined || !path.isAbsolute(created)) {
    // An empty path would make later path.join() calls write into the cwd.
    throw new Error(`create ${branch} printed no path=: ${result.stdout}`)
  }
  return created
}

/** Parses a tab-separated `key=value` line (or a single `key=value`). */
export function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of line.split('\t')) {
    const eq = part.indexOf('=')
    if (eq > 0) {
      out[part.slice(0, eq)] = part.slice(eq + 1)
    }
  }
  return out
}

/** Parses every non-empty stdout line of `key=value` fields. */
export function rows(stdout: string): Record<string, string>[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map(fields)
}

/** Parses the one-per-line `key=value` output of `create` into one record. */
export function createdFields(stdout: string): Record<string, string> {
  return Object.assign({}, ...rows(stdout))
}
