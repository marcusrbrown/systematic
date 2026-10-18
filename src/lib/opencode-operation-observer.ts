import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_LIMITS = {
  maxCommandOutputBytes: 8_388_608,
  maxCommandTimeoutMs: 5_000,
  maxFiles: 20_000,
  maxGitlinks: 32,
  maxRemoteCommandOutputBytes: 1_048_576,
  maxRemoteItems: 4096,
  maxTotalFileBytes: 134_217_728,
  maxPathBytes: 4096,
} as const

// A full git object id: 40 hex digits (sha1) or 64 (sha256). Ids are lowercased
// once, where they are parsed, so every comparison is in one case.
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

const STAGE_LIST_ARGS = [
  'ls-files',
  '--stage',
  '--full-name',
  '-z',
  '--',
  ':/',
] as const

const UNTRACKED_FILES_ARGS = [
  'ls-files',
  '--others',
  '--exclude-standard',
  '--full-name',
  '-z',
  '--',
  ':/',
] as const

// Forced on every local git call, before the subcommand, so repository config
// and refs cannot hide changes (`core.ignorecase`), run commands
// (`core.fsmonitor`) or redirect `HEAD`'s tree (replace refs).
const FORCED_GIT_PREFIX = [
  '--no-replace-objects',
  '-c',
  'core.ignorecase=false',
  '-c',
  'core.fsmonitor=false',
] as const

// `ignoreBOM` keeps a leading U+FEFF in a path instead of stripping it.
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
})

// The domain tag versions the worktree identity. v3 adds the ignore sources and
// the HEAD-tree path set.
const WORKTREE_DIGEST_DOMAIN = 'systematic:opencode-observer:worktree:v4\0'

// Self-ignored untracked `.gitignore` files never appear in the plain untracked
// listing, yet they change what is hidden, so they are discovered separately.
const IGNORED_GITIGNORE_ARGS = [
  'ls-files',
  '-o',
  '-i',
  '--exclude-standard',
  '--directory',
  '--full-name',
  '-z',
  '--',
  // `top` roots the pathspec at the repository, not at the command directory.
  ':(top,glob)**/.gitignore',
] as const

const MAX_IGNORE_SOURCE_BYTES = 1_048_576

export type OperationObserverReasonCode =
  | 'target-unavailable'
  | 'command-failed'
  | 'command-timeout'
  | 'command-output-limit'
  | 'file-limit'
  | 'file-output-limit'
  | 'file-read-failed'
  | 'remote-command-failed'
  | 'remote-command-output-limit'
  | 'remote-invalid-json'
  | 'remote-missing-field'
  | 'remote-item-limit'
  | 'remote-not-advanced'
  | 'commit-not-closed'
  | 'worktree-unstable'

export interface RegisteredWorktreeParentIdentity {
  readonly targetRoot: string
  readonly gitDir: string
  readonly commonDir: string
  readonly registeredWorktreeRoots: readonly string[]
}

export interface RegisteredWorktreeValidationOptions {
  readonly commandRunner?: OperationObserverCommandRunner
  readonly limits?: OperationObserverLimits
  readonly realPath?: (filePath: string) => string
}

export type RegisteredWorktreeValidationResult =
  | {
      readonly status: 'ok'
      readonly targetRoot: string
      readonly gitDir: string
      readonly commonDir: string
    }
  | {
      readonly status: 'error'
      readonly reasonCode: OperationObserverReasonCode
    }

export type RemoteOperation =
  | 'push'
  | 'pr-creation'
  | 'check-readback'
  | 'review-readback'
export type RemoteReadbackPhase = 'before' | 'after'

export interface OperationObserverSnapshot {
  readonly targetDigest: string
  readonly repositoryRevisionDigest: string
  readonly worktreeRevisionDigest: string
  readonly commitClosure?: boolean
}

export type OperationObserverResult =
  | {
      readonly status: 'available'
      readonly snapshot: OperationObserverSnapshot
    }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: OperationObserverReasonCode
    }

export interface OperationObserverCommandResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
  /** stdout was not valid UTF-8; `stdout` must not be trusted. */
  readonly invalidOutput?: boolean
}

export interface OperationObserverRemoteCommandResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
}

export type OperationObserverCommandRunner = (
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  timeoutMs: number,
) => OperationObserverCommandResult

export type OperationObserverRemoteCommandRunner = (
  executable: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  timeoutMs: number,
) => OperationObserverRemoteCommandResult

export interface OperationObserverRemoteSnapshot {
  readonly resourceIdentity: string
  readonly resourceRevisionIdentity: string
  readonly pullRequest?: {
    readonly identity: string
    readonly state: 'open' | 'closed' | 'merged'
  }
  readonly checkState?: 'completed-success' | 'completed-failure' | 'pending'
  readonly reviewDecision?:
    | 'approved'
    | 'changes-requested'
    | 'commented'
    | 'pending'
}

export type OperationObserverRemoteResult =
  | {
      readonly status: 'available'
      readonly snapshot: OperationObserverRemoteSnapshot
    }
  | { readonly status: 'missing-resource' }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: OperationObserverReasonCode
    }

// The local limits (`maxCommandOutputBytes`, `maxFiles`) do not control remote
// bounds; those are set by `maxRemoteCommandOutputBytes` and `maxRemoteItems`.
export interface OperationObserverLimits {
  readonly maxCommandOutputBytes?: number
  readonly maxCommandTimeoutMs?: number
  readonly maxFiles?: number
  readonly maxGitlinks?: number
  readonly maxRemoteCommandOutputBytes?: number
  readonly maxRemoteItems?: number
  readonly maxTotalFileBytes?: number
  readonly maxPathBytes?: number
}

export interface OperationObserverFileStat {
  readonly isFile: boolean
  readonly isSymbolicLink: boolean
  readonly isDirectory: boolean
  readonly mode: number
  readonly size: number
  // Optional identity fields. The race checks compare them before and after a
  // read; a seam that omits them compares equal (`undefined === undefined`).
  readonly dev?: number | bigint
  readonly ino?: number | bigint
  readonly mtimeNs?: number | bigint
  readonly ctimeNs?: number | bigint
}

export interface OpencodeOperationObserverOptions {
  readonly targetDirectory: string
  readonly commandRunner?: OperationObserverCommandRunner
  readonly remoteCommandRunner?: OperationObserverRemoteCommandRunner
  readonly fileReader?: (filePath: string) => Uint8Array
  readonly symlinkReader?: (filePath: string) => Uint8Array
  readonly statReader?: (filePath: string) => OperationObserverFileStat
  readonly realPath?: (filePath: string) => string
  readonly limits?: OperationObserverLimits
}

export interface OpencodeOperationObserver {
  readonly targetDigest: string
  validateRegisteredWorktree(
    candidateDirectory: string,
  ): RegisteredWorktreeValidationResult
  snapshot(): Promise<OperationObserverResult>
  remoteSnapshot?(
    operation: RemoteOperation,
    phase: RemoteReadbackPhase,
  ): Promise<OperationObserverRemoteResult>
}

interface Limits {
  readonly maxCommandOutputBytes: number
  readonly maxCommandTimeoutMs: number
  readonly maxFiles: number
  readonly maxGitlinks: number
  readonly maxRemoteCommandOutputBytes: number
  readonly maxRemoteItems: number
  readonly maxTotalFileBytes: number
  readonly maxPathBytes: number
}

interface GitCommandOutput {
  readonly stdout: string
}

interface StageEntry {
  readonly mode: string
  /** The staged object id, lowercase. */
  readonly id: string
  readonly relativePath: string
}

interface RepositoryContext {
  readonly commandDirectory: string
  readonly worktreeRoot: string
  /** Absolute path of the repository's `info/exclude`. */
  readonly infoExcludePath: string
  /** The root, git directory and common directory every read is bound to. */
  readonly pin: RootPin
}

/** Git object format; selects the hash used for blob ids. */
export type ObjectFormat = 'sha1' | 'sha256'

export type WorktreeRecordKind = 'regular' | 'symlink' | 'gitlink' | 'missing'

/**
 * One record per observed path. `id` is the git blob id of the raw bytes read
 * (a symlink's target bytes for a symlink), or the submodule `HEAD` for a
 * gitlink. A `missing` path (listed but gone by the time it was read) has an
 * empty `mode` and no `id`.
 */
export interface WorktreeRecord {
  readonly path: string
  readonly kind: WorktreeRecordKind
  /** Git-style mode: `100644`, `100755`, `120000` or `160000`. */
  readonly mode: string
  readonly id: string | undefined
}

/**
 * What one `snapshot()` has spent so far, shared by reference by everything
 * that reads for it. The file and gitlink counts are enforced up front against
 * a repository's path set; the bytes are spent as the files are read.
 */
interface WalkState {
  bytes: number
  files: number
  gitlinks: number
}

function createWalkState(): WalkState {
  return { bytes: 0, files: 0, gitlinks: 0 }
}

type RegularReadOutcome =
  | { status: 'ok'; content: Uint8Array }
  | { status: 'missing' }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

/** Reads a regular file under a byte budget. `expected` is the prior lstat. */
type RegularContentReader = (
  absolutePath: string,
  expected: OperationObserverFileStat,
  maxBytes: number,
) => RegularReadOutcome

/** What the final pass re-checks for one observed path. */
interface PathObservation {
  readonly absolutePath: string
  readonly record: WorktreeRecord
  /**
   * Post-read stat. Compared in the final pass, never hashed. `undefined` for
   * a gitlink (a directory whose times churn with submodule activity) and for
   * a `missing` path (which must stay missing).
   */
  readonly stat: OperationObserverFileStat | undefined
  /**
   * A tracked path that is now a real directory. Its record is a deletion, and
   * the directory is still the stable state the final pass must accept.
   */
  readonly displacedByDirectory?: true
  /**
   * What a gitlink held when it was hashed. The record carries only the
   * commit, which an uninitialized and an unborn checkout both lack.
   */
  readonly gitlinkState?: GitlinkState
  /**
   * The checkout read for a gitlink that has one. Its own final pass replaces
   * the parent's re-inspection of the gitlink.
   */
  readonly walked?: RepositorySnapshot
}

interface WorktreeReaders {
  readonly runner: OperationObserverCommandRunner
  readonly realPath: (filePath: string) => string
  readonly readRegular: RegularContentReader
  readonly symlinkReader: (filePath: string) => Uint8Array
  readonly statReader: (filePath: string) => OperationObserverFileStat
}

interface RootPin {
  readonly targetRoot: string
  readonly gitDir: string
  /** Where objects and refs live. A linked worktree's `commondir` names it. */
  readonly commonDir: string
}

type RootPinCaptureResult =
  | { status: 'ok'; pin: RootPin }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

type RepositoryAnchorResult =
  | {
      status: 'ok'
      toplevel: string
      gitDir: string
      commonDir: string
      /** Full object id, or `undefined` for an unborn `HEAD`. */
      head: string | undefined
      infoExcludePath: string
      /** What `rev-parse --is-inside-work-tree` answered. */
      insideWorkTree: boolean
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

type RepositoryAnchor = Extract<RepositoryAnchorResult, { status: 'ok' }>

type ParentIdentityCaptureResult =
  | { status: 'ok'; identity: RegisteredWorktreeParentIdentity }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

function unavailable(result: {
  readonly status: 'error'
  readonly reasonCode: OperationObserverReasonCode
}): OperationObserverResult {
  return { status: 'unavailable', reasonCode: result.reasonCode }
}

function digest(domain: string, facts: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(`systematic:opencode-observer:${domain}:v1\0`)
  for (const fact of facts) {
    hash.update(fact)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function isCommandTimeout(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ETIMEDOUT'
  )
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) {
      delete env[key]
    }
  }
  return env
}

/**
 * The one place local git stdout is decoded. Fails closed: bytes that are not
 * valid UTF-8 are reported as invalid instead of being replaced with U+FFFD,
 * which would let distinct paths collide. A genuine U+FFFD in a name is valid
 * UTF-8 and decodes unchanged.
 */
function decodeCommandStdout(raw: unknown): {
  readonly text: string
  readonly invalid: boolean
} {
  if (typeof raw === 'string') return { text: raw, invalid: false }
  if (raw instanceof Uint8Array) {
    try {
      return { text: STRICT_UTF8_DECODER.decode(raw), invalid: false }
    } catch {
      return { text: '', invalid: true }
    }
  }
  // A missing stdout (spawn failure) is empty; any other shape is untrusted.
  return { text: '', invalid: raw !== null && raw !== undefined }
}

function defaultCommandRunner(
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  timeoutMs: number,
): OperationObserverCommandResult {
  try {
    const result = spawnSync('git', [...args], {
      cwd,
      env: sanitizedEnvironment(),
      encoding: 'buffer',
      maxBuffer: maxOutputBytes,
      timeout: timeoutMs,
    })
    const stdout = decodeCommandStdout(result.stdout)
    return {
      status: result.status ?? -1,
      stdout: stdout.text,
      stderr: Buffer.isBuffer(result.stderr)
        ? result.stderr.toString('utf8')
        : '',
      timedOut: isCommandTimeout(result.error),
      ...(stdout.invalid ? { invalidOutput: true } : {}),
    }
  } catch {
    return { status: -1, stdout: '', stderr: '' }
  }
}

function withForcedGitPrefix(
  runner: OperationObserverCommandRunner,
): OperationObserverCommandRunner {
  return (args, cwd, maxOutputBytes, timeoutMs) =>
    runner([...FORCED_GIT_PREFIX, ...args], cwd, maxOutputBytes, timeoutMs)
}

function defaultRemoteCommandRunner(
  executable: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  timeoutMs: number,
): OperationObserverRemoteCommandResult {
  try {
    const result = spawnSync(executable, [...args], {
      cwd,
      env: sanitizedEnvironment(),
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
      timeout: timeoutMs,
    })
    return {
      status: result.status ?? -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      timedOut: isCommandTimeout(result.error),
    }
  } catch {
    return { status: -1, stdout: '', stderr: '' }
  }
}

function mergeLimits(input?: OperationObserverLimits): Limits {
  return {
    maxCommandOutputBytes:
      input?.maxCommandOutputBytes ?? DEFAULT_LIMITS.maxCommandOutputBytes,
    maxCommandTimeoutMs:
      input?.maxCommandTimeoutMs ?? DEFAULT_LIMITS.maxCommandTimeoutMs,
    maxFiles: input?.maxFiles ?? DEFAULT_LIMITS.maxFiles,
    maxGitlinks: input?.maxGitlinks ?? DEFAULT_LIMITS.maxGitlinks,
    maxRemoteCommandOutputBytes:
      input?.maxRemoteCommandOutputBytes ??
      DEFAULT_LIMITS.maxRemoteCommandOutputBytes,
    maxRemoteItems: input?.maxRemoteItems ?? DEFAULT_LIMITS.maxRemoteItems,
    maxTotalFileBytes:
      input?.maxTotalFileBytes ?? DEFAULT_LIMITS.maxTotalFileBytes,
    maxPathBytes: input?.maxPathBytes ?? DEFAULT_LIMITS.maxPathBytes,
  }
}

function outputBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function splitRecords(output: string): string[] {
  return output.split('\0').filter((record) => record.length > 0)
}

function parseStageEntries(
  output: string,
  maxPathBytes: number,
): StageEntry[] | undefined {
  const entries: StageEntry[] = []
  for (const record of splitRecords(output)) {
    const separator = record.indexOf('\t')
    if (separator <= 0) return undefined
    const header = record.slice(0, separator)
    const relativePath = record.slice(separator + 1)
    if (outputBytes(relativePath) > maxPathBytes) return undefined
    const [mode, id] = header.split(' ')
    if (!mode || !id || !GIT_OBJECT_ID.test(id)) return undefined
    entries.push({ mode, id: id.toLowerCase(), relativePath })
  }
  return entries.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )
}

function safePath(root: string, relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) return undefined
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return undefined
  }
  return absolutePath
}

function commandResultError(
  result: OperationObserverCommandResult,
  limits: Limits,
): OperationObserverReasonCode | undefined {
  if (result.timedOut) return 'command-timeout'
  if (result.invalidOutput) return 'file-read-failed'
  if (
    outputBytes(result.stdout) > limits.maxCommandOutputBytes ||
    outputBytes(result.stderr) > limits.maxCommandOutputBytes
  ) {
    return 'command-output-limit'
  }
  return undefined
}

/**
 * Runs a git command and maps every failure to a reason code. Some commands
 * use a non-zero exit to answer (`-q` prints nothing and exits 1 for an unborn
 * `HEAD`, `config --get` exits 1 for an unset key), so the exit codes that
 * count as success are the caller's choice.
 */
function runCommandAllowingExit(
  runner: OperationObserverCommandRunner,
  args: readonly string[],
  cwd: string,
  limits: Limits,
  acceptedExits: readonly number[],
):
  | { status: 'ok'; output: GitCommandOutput; exitCode: number }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  let result: OperationObserverCommandResult
  try {
    result = runner(
      args,
      cwd,
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const resultError = commandResultError(result, limits)
  if (resultError) return { status: 'error', reasonCode: resultError }
  if (!acceptedExits.includes(result.status)) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  return {
    status: 'ok',
    output: { stdout: result.stdout },
    exitCode: result.status,
  }
}

function runCommand(
  runner: OperationObserverCommandRunner,
  args: readonly string[],
  cwd: string,
  limits: Limits,
):
  | { status: 'ok'; output: GitCommandOutput }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  return runCommandAllowingExit(runner, args, cwd, limits, [0])
}

function canonicalPath(
  filePath: string,
  realPath: (filePath: string) => string = fs.realpathSync,
): string | undefined {
  try {
    return realPath(filePath)
  } catch {
    return undefined
  }
}

function requiredGitPath(
  runner: OperationObserverCommandRunner,
  args: readonly string[],
  cwd: string,
  limits: Limits,
  realPath: (filePath: string) => string = fs.realpathSync,
):
  | { status: 'ok'; value: string }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const result = runCommand(runner, args, cwd, limits)
  if (result.status === 'error') return result
  const rawValue = result.output.stdout.trim()
  if (!path.isAbsolute(rawValue)) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  const value = canonicalPath(rawValue, realPath)
  return value === undefined
    ? { status: 'error', reasonCode: 'target-unavailable' }
    : { status: 'ok', value }
}

/**
 * Reads and canonicalizes the toplevel and git directory once, at
 * construction. `snapshot()` pins every later read against these values.
 */
function captureRootPin(
  targetDirectory: string,
  runner: OperationObserverCommandRunner,
  limits: Limits,
  realPath: (filePath: string) => string,
): RootPinCaptureResult {
  const targetRoot = requiredGitPath(
    runner,
    ['rev-parse', '--show-toplevel'],
    targetDirectory,
    limits,
    realPath,
  )
  if (targetRoot.status === 'error') return targetRoot
  const gitDir = requiredGitPath(
    runner,
    ['rev-parse', '--absolute-git-dir'],
    targetDirectory,
    limits,
    realPath,
  )
  if (gitDir.status === 'error') return gitDir
  const commonDir = requiredGitPath(
    runner,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    targetDirectory,
    limits,
    realPath,
  )
  if (commonDir.status === 'error') return commonDir
  return {
    status: 'ok',
    pin: {
      targetRoot: targetRoot.value,
      gitDir: gitDir.value,
      commonDir: commonDir.value,
    },
  }
}

function captureParentIdentity(
  targetDirectory: string,
  pin: RootPin,
  runner: OperationObserverCommandRunner,
  limits: Limits,
  realPath: (filePath: string) => string = fs.realpathSync,
): ParentIdentityCaptureResult {
  const commonDir = requiredGitPath(
    runner,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    targetDirectory,
    limits,
    realPath,
  )
  if (commonDir.status === 'error') return commonDir
  const worktreeList = runCommand(
    runner,
    ['worktree', 'list', '--porcelain', '-z'],
    targetDirectory,
    limits,
  )
  if (worktreeList.status === 'error') return worktreeList
  const registeredWorktreeRoots = worktreeList.output.stdout
    .split('\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record) => canonicalPath(record.slice('worktree '.length), realPath))
  if (registeredWorktreeRoots.some((root) => root === undefined)) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  const roots = registeredWorktreeRoots.filter(
    (root): root is string => root !== undefined,
  )
  return roots.length > 0
    ? {
        status: 'ok',
        identity: {
          targetRoot: pin.targetRoot,
          gitDir: pin.gitDir,
          commonDir: commonDir.value,
          registeredWorktreeRoots: roots,
        },
      }
    : { status: 'error', reasonCode: 'target-unavailable' }
}

function readGitfileTarget(
  gitfilePath: string,
  realPath: (filePath: string) => string = fs.realpathSync,
): string | undefined {
  let contents: string
  try {
    contents = fs.readFileSync(gitfilePath, 'utf8')
  } catch {
    return undefined
  }
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(contents)
  if (!match) return undefined
  const [, gitdirTarget = ''] = match
  const target = path.isAbsolute(gitdirTarget)
    ? gitdirTarget
    : path.resolve(path.dirname(gitfilePath), gitdirTarget)
  return canonicalPath(target, realPath)
}

function readGitdirBacklink(
  backlinkPath: string,
  realPath: (filePath: string) => string,
): string | undefined {
  let contents: string
  try {
    contents = fs.readFileSync(backlinkPath, 'utf8').trim()
  } catch {
    return undefined
  }
  if (contents.length === 0) return undefined
  const target = path.isAbsolute(contents)
    ? contents
    : path.resolve(path.dirname(backlinkPath), contents)
  return canonicalPath(target, realPath)
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function validateDotGitLinkage(
  targetRoot: string,
  gitDir: string,
  commonDir: string,
  realPath: (filePath: string) => string,
): boolean {
  const dotGit = path.join(targetRoot, '.git')
  let dotGitStat: fs.Stats
  try {
    dotGitStat = fs.lstatSync(dotGit)
  } catch {
    return false
  }
  if (dotGitStat.isDirectory()) {
    return gitDir === commonDir && canonicalPath(dotGit, realPath) === commonDir
  }
  if (
    !dotGitStat.isFile() ||
    dotGitStat.isSymbolicLink() ||
    !isPathWithin(path.join(commonDir, 'worktrees'), gitDir) ||
    readGitfileTarget(dotGit, realPath) !== gitDir
  ) {
    return false
  }

  const backlinkPath = path.join(gitDir, 'gitdir')
  let backlinkStat: fs.Stats
  try {
    backlinkStat = fs.lstatSync(backlinkPath)
  } catch {
    return false
  }
  return (
    backlinkStat.isFile() &&
    !backlinkStat.isSymbolicLink() &&
    readGitdirBacklink(backlinkPath, realPath) ===
      canonicalPath(dotGit, realPath)
  )
}

export function validateRegisteredWorktree(
  candidateDirectory: string,
  parentIdentity: RegisteredWorktreeParentIdentity,
  options: RegisteredWorktreeValidationOptions = {},
): RegisteredWorktreeValidationResult {
  // A runner passed in (e.g. by the observer) is already wrapped; only the
  // default is wrapped here, so the prefix is never applied twice.
  const runner =
    options.commandRunner ?? withForcedGitPrefix(defaultCommandRunner)
  const limits = mergeLimits(options.limits)
  const realPath = options.realPath ?? fs.realpathSync
  const candidateRoot = canonicalPath(candidateDirectory, realPath)
  if (candidateRoot === undefined) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  const inside = runCommand(
    runner,
    ['rev-parse', '--is-inside-work-tree'],
    candidateRoot,
    limits,
  )
  if (inside.status === 'error') return inside
  if (inside.output.stdout.trim() !== 'true') {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  const targetRoot = requiredGitPath(
    runner,
    ['rev-parse', '--show-toplevel'],
    candidateRoot,
    limits,
    realPath,
  )
  if (targetRoot.status === 'error') return targetRoot
  const gitDir = requiredGitPath(
    runner,
    ['rev-parse', '--absolute-git-dir'],
    candidateRoot,
    limits,
    realPath,
  )
  if (gitDir.status === 'error') return gitDir
  const commonDir = requiredGitPath(
    runner,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    candidateRoot,
    limits,
    realPath,
  )
  if (commonDir.status === 'error') return commonDir
  if (
    commonDir.value !== parentIdentity.commonDir ||
    !parentIdentity.registeredWorktreeRoots.includes(targetRoot.value)
  ) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  if (
    !validateDotGitLinkage(
      targetRoot.value,
      gitDir.value,
      commonDir.value,
      realPath,
    )
  ) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  return {
    status: 'ok',
    targetRoot: targetRoot.value,
    gitDir: gitDir.value,
    commonDir: commonDir.value,
  }
}

function readRevision(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  head: string | undefined,
  insideWorkTree: boolean,
  limits: Limits,
):
  | { status: 'ok'; digest: string }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const branch = runCommand(
    runner,
    ['symbolic-ref', '--short', 'HEAD'],
    context.commandDirectory,
    limits,
  )
  if (branch.status === 'error' && branch.reasonCode !== 'command-failed') {
    return branch
  }
  const branchValue =
    branch.status === 'ok' ? branch.output.stdout.trim() : 'detached'
  return {
    status: 'ok',
    digest: digest('repository-revision', [
      head ?? 'unborn',
      branchValue,
      // The digest has always carried the answer as git prints it.
      String(insideWorkTree),
    ]),
  }
}

/**
 * One `rev-parse` returns toplevel, absolute git dir, the `info/exclude` path,
 * the in-work-tree answer, the absolute common dir and the `HEAD` id, in that
 * order. `--verify -q` makes an unborn `HEAD` exit 1 with only the first five
 * lines, so unborn is distinguishable from every other failure. `--git-path`
 * prints a path relative to `cwd` (absolute for a linked worktree), so it is
 * resolved against `cwd`.
 */
function readRepositoryAnchor(
  runner: OperationObserverCommandRunner,
  cwd: string,
  limits: Limits,
  realPath: (filePath: string) => string,
): RepositoryAnchorResult {
  const result = runCommandAllowingExit(
    runner,
    [
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-path',
      'info/exclude',
      '--is-inside-work-tree',
      '--path-format=absolute',
      '--git-common-dir',
      '--verify',
      '-q',
      'HEAD',
    ],
    cwd,
    limits,
    [0, 1],
  )
  if (result.status === 'error') return result
  const lines = result.output.stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const unborn = result.exitCode === 1 && lines.length === 5
  if (result.exitCode !== 0 && !unborn) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const [
    toplevelLine,
    gitDirLine,
    excludeLine,
    insideLine,
    commonDirLine,
    headLine,
  ] = lines
  const malformed =
    lines.length !== (unborn ? 5 : 6) ||
    commonDirLine === undefined ||
    (insideLine !== 'true' && insideLine !== 'false') ||
    toplevelLine === undefined ||
    gitDirLine === undefined ||
    excludeLine === undefined ||
    excludeLine.length === 0 ||
    outputBytes(toplevelLine) > limits.maxPathBytes ||
    (headLine !== undefined && !GIT_OBJECT_ID.test(headLine))
  if (malformed) return { status: 'error', reasonCode: 'target-unavailable' }
  const toplevel = absoluteCanonicalPath(toplevelLine, realPath)
  const gitDir = absoluteCanonicalPath(gitDirLine, realPath)
  const commonDir = absoluteCanonicalPath(commonDirLine, realPath)
  if (
    toplevel === undefined ||
    gitDir === undefined ||
    commonDir === undefined
  ) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  return {
    status: 'ok',
    toplevel,
    gitDir,
    commonDir,
    head: headLine?.toLowerCase(),
    infoExcludePath: path.resolve(cwd, excludeLine),
    insideWorkTree: insideLine === 'true',
  }
}

function absoluteCanonicalPath(
  value: string,
  realPath: (filePath: string) => string,
): string | undefined {
  return path.isAbsolute(value) ? canonicalPath(value, realPath) : undefined
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

type ObservationResult =
  | { status: 'ok'; observation: PathObservation }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

function observed(
  absolutePath: string,
  record: WorktreeRecord,
  stat: OperationObserverFileStat | undefined,
  displacedByDirectory = false,
  gitlinkState?: GitlinkState,
  walked?: RepositorySnapshot,
): ObservationResult {
  return {
    status: 'ok',
    observation: {
      absolutePath,
      record,
      stat,
      ...(displacedByDirectory ? { displacedByDirectory: true as const } : {}),
      ...(gitlinkState ? { gitlinkState } : {}),
      ...(walked ? { walked } : {}),
    },
  }
}

/**
 * Feeds one variable-length field into a digest as `<byte length>:<bytes>`, so
 * the boundary between two fields is part of what is hashed. Without it, a
 * file whose content spells out the next record would hash like two files.
 *
 * @internal Exported for the framing test only.
 */
export function hashField(
  hash: ReturnType<typeof createHash>,
  field: string | Uint8Array,
): void {
  const bytes = typeof field === 'string' ? Buffer.from(field) : field
  hash.update(`${bytes.byteLength}:`)
  hash.update(bytes)
}

function gitBlobId(content: Uint8Array, format: ObjectFormat): string {
  return createHash(format)
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

function missingObservation(
  absolutePath: string,
  relativePath: string,
  displacedByDirectory = false,
): ObservationResult {
  // A deleted path adds nothing to the digest: the worktree reads the same
  // whether or not `HEAD` still lists it. The record carries the deletion.
  return observed(
    absolutePath,
    { path: relativePath, kind: 'missing', mode: '', id: undefined },
    undefined,
    displacedByDirectory,
  )
}

/**
 * A listed path that is gone. A tracked path is a deletion. An untracked path
 * was listed moments ago, so its disappearance is a race.
 */
function vanishedPath(
  tracked: boolean,
  absolutePath: string,
  relativePath: string,
): ObservationResult {
  return tracked
    ? missingObservation(absolutePath, relativePath)
    : { status: 'error', reasonCode: 'worktree-unstable' }
}

function sameStat(
  left: OperationObserverFileStat,
  right: OperationObserverFileStat,
): boolean {
  return (
    left.isFile === right.isFile &&
    left.isSymbolicLink === right.isSymbolicLink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function hasErrorCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  )
}

function openWithoutFollowing(
  absolutePath: string,
):
  | { status: 'ok'; fd: number }
  | { status: 'missing' }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  // O_NONBLOCK keeps a path swapped for a FIFO from blocking the open.
  // O_NOFOLLOW is undefined on Windows; the lstat comparison covers it there.
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0)
  try {
    return { status: 'ok', fd: fs.openSync(absolutePath, flags) }
  } catch (error) {
    if (isEnoent(error)) return { status: 'missing' }
    // The prior lstat said regular, so a symlink here was swapped in.
    if (hasErrorCode(error, 'ELOOP', 'EMLINK')) {
      return { status: 'error', reasonCode: 'worktree-unstable' }
    }
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
}

function readOpenedRegularFile(
  fd: number,
  expected: OperationObserverFileStat,
  maxBytes: number,
): RegularReadOutcome {
  const opened = fs.fstatSync(fd, { bigint: true })
  const identityKnown = expected.dev !== undefined && expected.ino !== undefined
  if (
    !opened.isFile() ||
    (identityKnown &&
      (opened.dev !== BigInt(expected.dev ?? 0) ||
        opened.ino !== BigInt(expected.ino ?? 0)))
  ) {
    return { status: 'error', reasonCode: 'worktree-unstable' }
  }
  // One buffer sized from lstat plus a byte, so a file that stays its size
  // reaches EOF without a second allocation. A file that grew is enlarged,
  // never beyond one byte past the cap. The cap applies to the bytes actually
  // read, not to what lstat promised.
  let buffer = Buffer.allocUnsafe(
    Math.min(Math.max(expected.size, 0), maxBytes) + 1,
  )
  let total = 0
  for (;;) {
    if (total === buffer.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(buffer.length * 2, maxBytes + 1),
      )
      buffer.copy(grown, 0, 0, total)
      buffer = grown
    }
    const count = fs.readSync(fd, buffer, total, buffer.length - total, null)
    if (count === 0) break
    total += count
    if (total > maxBytes) {
      return { status: 'error', reasonCode: 'file-output-limit' }
    }
  }
  return { status: 'ok', content: buffer.subarray(0, total) }
}

/**
 * The hardened default reader: open without following or blocking, require the
 * opened inode to be the one already lstat'd, and read to EOF under the budget.
 */
function readRegularFileHardened(
  absolutePath: string,
  expected: OperationObserverFileStat,
  maxBytes: number,
): RegularReadOutcome {
  const opened = openWithoutFollowing(absolutePath)
  if (opened.status !== 'ok') return opened
  try {
    return readOpenedRegularFile(opened.fd, expected, maxBytes)
  } catch {
    return { status: 'error', reasonCode: 'file-read-failed' }
  } finally {
    try {
      fs.closeSync(opened.fd)
    } catch {
      // The content was already read; a failed close changes nothing.
    }
  }
}

/** Keeps an injected `fileReader` on its existing contract. */
function adaptInjectedFileReader(
  fileReader: (filePath: string) => Uint8Array,
): RegularContentReader {
  return (absolutePath) => {
    try {
      return { status: 'ok', content: fileReader(absolutePath) }
    } catch (error) {
      return isEnoent(error)
        ? { status: 'missing' }
        : { status: 'error', reasonCode: 'file-read-failed' }
    }
  }
}

/**
 * What a gitlink path holds on disk: nothing checked out (`uninitialized`), a
 * checkout with no commit yet (`unborn`), or a checkout at a commit.
 */
type GitlinkState = 'uninitialized' | 'unborn' | 'initialized'

type GitlinkInspection =
  | { status: 'initialized'; id: string; anchor: RepositoryAnchor }
  | { status: 'unborn'; anchor: RepositoryAnchor }
  | { status: 'uninitialized' }
  /** Nothing on disk at the path, as after a submodule is removed. */
  | { status: 'absent' }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

function directoryEmptiness(
  absolutePath: string,
): 'empty' | 'non-empty' | 'unreadable' {
  let directory: fs.Dir
  try {
    directory = fs.opendirSync(absolutePath)
  } catch (error) {
    // Gone by now is as good as empty; anything else is unreadable.
    return hasErrorCode(error, 'ENOENT', 'ENOTDIR') ? 'empty' : 'unreadable'
  }
  // One entry decides it, however large the directory is.
  try {
    return directory.readSync() === null ? 'empty' : 'non-empty'
  } catch {
    return 'unreadable'
  } finally {
    try {
      directory.closeSync()
    } catch {
      // The answer is already known; a failed close cannot change it.
    }
  }
}

/**
 * Reads the submodule's anchor in one call. The toplevel must be the submodule
 * path itself: a bare or empty `.git` makes git walk up and answer with the
 * parent, which would otherwise hash the parent's `HEAD`. A checkout with no
 * commit is `unborn`, not a failure.
 */
function readCheckedOutGitlink(
  readers: WorktreeReaders,
  absolutePath: string,
  limits: Limits,
): GitlinkInspection {
  const anchor = readRepositoryAnchor(
    readers.runner,
    absolutePath,
    limits,
    readers.realPath,
  )
  if (anchor.status === 'error') {
    // Output that does not parse is a malformed checkout here, as it always was.
    return anchor.reasonCode === 'target-unavailable'
      ? { status: 'error', reasonCode: 'file-read-failed' }
      : anchor
  }
  const submodule = canonicalPath(absolutePath, readers.realPath)
  if (submodule === undefined || submodule !== anchor.toplevel) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  return anchor.head === undefined
    ? { status: 'unborn', anchor }
    : { status: 'initialized', id: anchor.head, anchor }
}

function inspectGitlink(
  readers: WorktreeReaders,
  absolutePath: string,
  limits: Limits,
): GitlinkInspection {
  let directory: OperationObserverFileStat
  try {
    directory = readers.statReader(absolutePath)
  } catch (error) {
    // A removed submodule leaves no directory. That is a deletion, unlike an
    // existing empty directory, which is a checkout that was never populated.
    return hasErrorCode(error, 'ENOENT', 'ENOTDIR')
      ? { status: 'absent' }
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  // A symlink or file at a gitlink path would be read through, or is not a
  // checkout at all.
  if (!directory.isDirectory) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  try {
    readers.statReader(path.join(absolutePath, '.git'))
  } catch (error) {
    if (!isEnoent(error)) {
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    // No `.git`: uninitialized only if the directory is empty.
    switch (directoryEmptiness(absolutePath)) {
      case 'empty':
        return { status: 'uninitialized' }
      case 'non-empty':
      case 'unreadable':
        return { status: 'error', reasonCode: 'file-read-failed' }
    }
  }
  return readCheckedOutGitlink(readers, absolutePath, limits)
}

function appendSubmoduleFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  absolutePath: string,
  relativePath: string,
  limits: Limits,
  walk: WalkState,
): ObservationResult {
  const inspected = inspectGitlink(readers, absolutePath, limits)
  if (inspected.status === 'error') return inspected
  if (inspected.status === 'absent') {
    return missingObservation(absolutePath, relativePath)
  }
  // A checkout is read like the parent: its files are part of the digest.
  const walked =
    inspected.status === 'uninitialized'
      ? undefined
      : readRepositorySnapshot(
          readers,
          contextForCheckout(absolutePath, inspected.anchor),
          inspected.anchor.head,
          limits,
          walk,
        )
  if (walked?.status === 'error') return walked
  const id = inspected.status === 'initialized' ? inspected.id : undefined
  hash.update('gitlink')
  hashField(hash, relativePath)
  hashField(hash, gitlinkIdentity(inspected))
  // The checkout's digest is folded in at the gitlink's own sorted position.
  if (walked) hashField(hash, walked.digest)
  return observed(
    absolutePath,
    { path: relativePath, kind: 'gitlink', mode: '160000', id },
    undefined,
    false,
    inspected.status,
    walked,
  )
}

/** A checkout's own root, command directory and `info/exclude`, bound to its anchor. */
function contextForCheckout(
  absolutePath: string,
  anchor: RepositoryAnchor,
): RepositoryContext {
  return {
    commandDirectory: absolutePath,
    worktreeRoot: anchor.toplevel,
    infoExcludePath: anchor.infoExcludePath,
    pin: {
      targetRoot: anchor.toplevel,
      gitDir: anchor.gitDir,
      commonDir: anchor.commonDir,
    },
  }
}

/**
 * What a gitlink contributes to the digest: its commit when it has one, else
 * its state. Neither state name is hex, so none can collide with a revision,
 * and an unborn checkout digests differently from an absent one.
 */
function gitlinkIdentity(
  inspected: Extract<
    GitlinkInspection,
    { status: 'initialized' | 'unborn' | 'uninitialized' }
  >,
): string {
  return inspected.status === 'initialized' ? inspected.id : inspected.status
}

function appendSymlinkFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  absolutePath: string,
  relativePath: string,
  stat: OperationObserverFileStat,
  limits: Limits,
  budget: WalkState,
  format: ObjectFormat,
  tracked: boolean,
): ObservationResult {
  let target: Uint8Array
  try {
    target = readers.symlinkReader(absolutePath)
  } catch (error) {
    return isEnoent(error)
      ? vanishedPath(tracked, absolutePath, relativePath)
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  const nextBytes = budget.bytes + target.byteLength
  if (
    target.byteLength > limits.maxPathBytes ||
    nextBytes > limits.maxTotalFileBytes
  ) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  hash.update('symlink')
  hashField(hash, relativePath)
  hashField(hash, target)
  budget.bytes = nextBytes
  return observed(
    absolutePath,
    {
      path: relativePath,
      kind: 'symlink',
      mode: '120000',
      id: gitBlobId(target, format),
    },
    // The pre-read stat is what the final pass compares against a fresh one.
    stat,
  )
}

function appendRegularFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  absolutePath: string,
  relativePath: string,
  stat: OperationObserverFileStat,
  limits: Limits,
  budget: WalkState,
  format: ObjectFormat,
  tracked: boolean,
): ObservationResult {
  if (!stat.isFile || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const remaining = limits.maxTotalFileBytes - budget.bytes
  if (stat.size > remaining) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  const read = readers.readRegular(absolutePath, stat, remaining)
  if (read.status === 'missing')
    return vanishedPath(tracked, absolutePath, relativePath)
  if (read.status === 'error') return read
  const { content } = read
  if (content.byteLength > remaining) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  hash.update('regular')
  hashField(hash, relativePath)
  hashField(hash, (stat.mode & 0o111) !== 0 ? 'executable' : 'non-executable')
  hashField(hash, content)
  budget.bytes += content.byteLength
  return observed(
    absolutePath,
    {
      path: relativePath,
      kind: 'regular',
      // Git's rule: only the owner execute bit matters.
      mode: (stat.mode & 0o100) !== 0 ? '100755' : '100644',
      id: gitBlobId(content, format),
    },
    // The pre-read stat is what the final pass compares against a fresh one.
    stat,
  )
}

type AncestorCheck =
  | { status: 'ok' }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

/**
 * Requires every directory between the worktree root and `absolutePath` to be
 * a real directory. A symlinked ancestor would let a tracked path read
 * content from outside the worktree, hidden behind an ignore rule. Directories
 * already seen this snapshot are skipped, so each is checked once. A missing
 * or non-directory ancestor is left for the path's own stat to report.
 */
function checkAncestorDirectories(
  worktreeRoot: string,
  relativePath: string,
  verified: Set<string>,
): AncestorCheck {
  const parts = relativePath.split('/').slice(0, -1)
  let current = worktreeRoot
  for (const part of parts) {
    current = path.join(current, part)
    if (verified.has(current)) continue
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { status: 'ok' }
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    if (stat.isSymbolicLink()) {
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    if (!stat.isDirectory()) return { status: 'ok' }
    verified.add(current)
  }
  return { status: 'ok' }
}

/** The directories checked during the snapshot must still be real directories. */
function verifyAncestorsUnchanged(
  verified: ReadonlySet<string>,
): StabilityResult {
  for (const directory of verified) {
    try {
      const stat = fs.lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return UNSTABLE
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) {
        return { status: 'error', reasonCode: 'file-read-failed' }
      }
      return UNSTABLE
    }
  }
  return { status: 'ok' }
}

/** A path to observe, with its tracked mode when it has one. */
interface PathEntry {
  readonly relativePath: string
  /**
   * The mode from the index, else from the `HEAD` tree. Empty means the path
   * is in neither, that is, untracked.
   */
  readonly mode: string
  /**
   * A gitlink that only `HEAD` still lists, under which the index or the
   * listings now hold ordinary files. The submodule was converted, so the
   * historical path is a deletion and the files are observed on their own.
   */
  readonly displacedGitlink?: true
}

function appendPathFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  context: RepositoryContext,
  entry: PathEntry,
  limits: Limits,
  budget: WalkState,
  format: ObjectFormat,
  verifiedDirectories: Set<string>,
): ObservationResult {
  const { mode, relativePath } = entry
  const absolutePath = safePath(context.worktreeRoot, relativePath)
  if (!absolutePath || outputBytes(relativePath) > limits.maxPathBytes) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const ancestors = checkAncestorDirectories(
    context.worktreeRoot,
    relativePath,
    verifiedDirectories,
  )
  if (ancestors.status === 'error') return ancestors
  const tracked = mode !== ''
  if (entry.displacedGitlink) {
    return missingObservation(absolutePath, relativePath, true)
  }
  // A gitlink inspects its own directory, so it is dispatched before the stat.
  if (mode === '160000') {
    return appendSubmoduleFact(
      hash,
      readers,
      absolutePath,
      relativePath,
      limits,
      budget,
    )
  }
  let stat: OperationObserverFileStat
  try {
    stat = readers.statReader(absolutePath)
  } catch (error) {
    // ENOTDIR means an ancestor is now a file. For a tracked path that is the
    // same deletion as ENOENT; the file itself is observed on its own.
    return hasErrorCode(error, 'ENOENT', 'ENOTDIR')
      ? vanishedPath(tracked, absolutePath, relativePath)
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  // A real directory where a tracked file was: the file is gone, and what
  // replaced it is observed through its own paths. A symlink is not a
  // directory here, so a link in the way is still read as a link.
  if (tracked && stat.isDirectory && !stat.isSymbolicLink) {
    return missingObservation(absolutePath, relativePath, true)
  }
  return stat.isSymbolicLink
    ? appendSymlinkFact(
        hash,
        readers,
        absolutePath,
        relativePath,
        stat,
        limits,
        budget,
        format,
        tracked,
      )
    : appendRegularFact(
        hash,
        readers,
        absolutePath,
        relativePath,
        stat,
        limits,
        budget,
        format,
        tracked,
      )
}

/** The three listings that decide the path set, as git printed them. */
interface RawListings {
  readonly staged: string
  readonly untracked: string
  readonly ignoredGitignores: string
}

/** Everything the final pass compares against, taken during the first pass. */
interface FirstPass extends RawListings {
  readonly ignoreSources: readonly IgnoreSourceFact[]
}

/** Lists the index, the untracked files and the self-ignored `.gitignore` files. */
function listWorktreePaths(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
):
  | ({ status: 'ok' } & RawListings)
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const staged = runCommand(
    runner,
    STAGE_LIST_ARGS,
    context.commandDirectory,
    limits,
  )
  if (staged.status === 'error') return staged
  const untracked = runCommand(
    runner,
    UNTRACKED_FILES_ARGS,
    context.commandDirectory,
    limits,
  )
  if (untracked.status === 'error') return untracked
  const ignoredGitignores = runCommand(
    runner,
    IGNORED_GITIGNORE_ARGS,
    context.commandDirectory,
    limits,
  )
  if (ignoredGitignores.status === 'error') return ignoredGitignores
  return {
    status: 'ok',
    staged: staged.output.stdout,
    untracked: untracked.output.stdout,
    ignoredGitignores: ignoredGitignores.output.stdout,
  }
}

type StabilityResult =
  | { status: 'ok' }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

const UNSTABLE: StabilityResult = {
  status: 'error',
  reasonCode: 'worktree-unstable',
}

/** The observer was bound to a root that has since moved. */
const ROOT_MOVED: StabilityResult = {
  status: 'error',
  reasonCode: 'target-unavailable',
}

/**
 * A gitlink is re-inspected rather than re-stat'd: its directory times churn
 * with submodule activity, but its state and `HEAD` id are what was hashed.
 */
function verifyGitlinkUnchanged(
  readers: WorktreeReaders,
  limits: Limits,
  { absolutePath, record, gitlinkState, walked }: PathObservation,
): StabilityResult {
  if (walked)
    return verifyCheckoutUnchanged(readers, limits, absolutePath, walked)
  const fresh = inspectGitlink(readers, absolutePath, limits)
  if (fresh.status === 'error') {
    // The first read of this directory succeeded, so a read failure now means
    // the directory changed underneath the snapshot.
    return fresh.reasonCode === 'file-read-failed' ? UNSTABLE : fresh
  }
  // A gitlink that vanished is not the checkout that was hashed, and neither
  // is one that changed state: a checkout appearing or going away, or a first
  // commit landing, moved underneath the snapshot.
  if (fresh.status === 'absent' || fresh.status !== gitlinkState) {
    return UNSTABLE
  }
  const id = fresh.status === 'initialized' ? fresh.id : undefined
  return id === record.id ? { status: 'ok' } : UNSTABLE
}

/**
 * A walked checkout is verified the way the parent is: its own final pass,
 * including a comparison of its whole anchor, any difference in which is
 * `worktree-unstable`. The directory and its `.git` are stat'd first, because
 * git run in a directory that is gone would fail for the wrong reason.
 */
function verifyCheckoutUnchanged(
  readers: WorktreeReaders,
  limits: Limits,
  absolutePath: string,
  walked: RepositorySnapshot,
): StabilityResult {
  for (const target of [absolutePath, path.join(absolutePath, '.git')]) {
    try {
      readers.statReader(target)
    } catch (error) {
      return hasErrorCode(error, 'ENOENT', 'ENOTDIR')
        ? UNSTABLE
        : { status: 'error', reasonCode: 'file-read-failed' }
    }
  }
  return runFinalPass(readers, limits, walked.pass, UNSTABLE)
}

function verifyObservationUnchanged(
  readers: WorktreeReaders,
  limits: Limits,
  observation: PathObservation,
): StabilityResult {
  const { absolutePath, record, stat } = observation
  if (record.kind === 'gitlink') {
    return verifyGitlinkUnchanged(readers, limits, observation)
  }
  let fresh: OperationObserverFileStat
  try {
    fresh = readers.statReader(absolutePath)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) {
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    // A missing record must stay missing; anything else vanished mid-snapshot.
    return record.kind === 'missing' ? { status: 'ok' } : UNSTABLE
  }
  if (record.kind === 'missing') {
    // A path displaced by a directory is stable while it stays a real directory.
    const stillDisplaced =
      observation.displacedByDirectory === true &&
      fresh.isDirectory &&
      !fresh.isSymbolicLink
    return stillDisplaced ? { status: 'ok' } : UNSTABLE
  }
  if (stat === undefined) return UNSTABLE
  return sameStat(stat, fresh) ? { status: 'ok' } : UNSTABLE
}

function verifyObservationsUnchanged(
  readers: WorktreeReaders,
  limits: Limits,
  observations: readonly PathObservation[],
): StabilityResult {
  for (const observation of observations) {
    const result = verifyObservationUnchanged(readers, limits, observation)
    if (result.status === 'error') return result
  }
  return { status: 'ok' }
}

function verifyListingsUnchanged(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
  first: FirstPass,
): StabilityResult {
  const fresh = listWorktreePaths(runner, context, limits)
  if (fresh.status === 'error') return fresh
  return fresh.staged === first.staged &&
    fresh.untracked === first.untracked &&
    fresh.ignoredGitignores === first.ignoredGitignores
    ? { status: 'ok' }
    : UNSTABLE
}

function verifyIgnoreSourcesUnchanged(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
  first: FirstPass,
): StabilityResult {
  const fresh = readIgnoreSources(runner, context, limits)
  if (fresh.status === 'error') return fresh
  return sameIgnoreSources(first.ignoreSources, fresh.facts)
    ? { status: 'ok' }
    : UNSTABLE
}

/**
 * Re-runs the anchor `rev-parse` and compares all of it with what the snapshot
 * was bound to. A root, git directory or common directory that moved after the
 * start redirected the git listings away from the files that were read, which
 * is the same condition `snapshot()` rejects up front, so it is reported the
 * same way (`target-unavailable`). A `HEAD` that moved is a transient change
 * (`worktree-unstable`). A walked checkout was bound to nothing before its
 * first pass, so for it a move of any part of the anchor is `moved` as given
 * (`worktree-unstable`).
 */
function verifyAnchorUnchanged(
  readers: WorktreeReaders,
  context: RepositoryContext,
  limits: Limits,
  head: string | undefined,
  moved: StabilityResult,
): StabilityResult {
  const anchor = readRepositoryAnchor(
    readers.runner,
    context.commandDirectory,
    limits,
    readers.realPath,
  )
  if (anchor.status === 'error') return anchor
  const { pin } = context
  if (
    anchor.toplevel !== pin.targetRoot ||
    anchor.gitDir !== pin.gitDir ||
    anchor.commonDir !== pin.commonDir
  ) {
    return moved
  }
  return anchor.head === head ? { status: 'ok' } : UNSTABLE
}

/**
 * The final pass. Any difference from what the snapshot saw means the tree
 * moved underneath it, so the snapshot cannot be trusted.
 */
function runFinalPass(
  readers: WorktreeReaders,
  limits: Limits,
  pass: RepositoryPass,
  moved: StabilityResult,
): StabilityResult {
  const { context, head, first, observations, verifiedDirectories } = pass
  // Ignore sources first: a source swapped for a FIFO or a huge file must be
  // caught by our own bounded read before any git listing reads it.
  const sources = verifyIgnoreSourcesUnchanged(
    readers.runner,
    context,
    limits,
    first,
  )
  if (sources.status === 'error') return sources
  const ancestors = verifyAncestorsUnchanged(verifiedDirectories)
  if (ancestors.status === 'error') return ancestors
  const unchanged = verifyObservationsUnchanged(readers, limits, observations)
  if (unchanged.status === 'error') return unchanged
  const listings = verifyListingsUnchanged(
    readers.runner,
    context,
    limits,
    first,
  )
  if (listings.status === 'error') return listings
  return verifyAnchorUnchanged(readers, context, limits, head, moved)
}

interface IgnoreSourceFact {
  readonly label: 'info-exclude' | 'core-excludes-file'
  /** `undefined` means the file is absent, which differs from an empty file. */
  readonly content: Uint8Array | undefined
}

type IgnoreSourceFileResult =
  | { status: 'ok'; fact: IgnoreSourceFact }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

/**
 * Reads one ignore-source file. Symlinks are resolved, and only a regular file
 * of at most 1 MiB is read. The stat comes before the open, and the open is
 * non-blocking, so a FIFO or a device can never hang or flood the read.
 */
function readIgnoreSourceFile(
  label: IgnoreSourceFact['label'],
  filePath: string,
): IgnoreSourceFileResult {
  const absent: IgnoreSourceFileResult = {
    status: 'ok',
    fact: { label, content: undefined },
  }
  let resolved: string
  let stat: fs.BigIntStats
  try {
    resolved = fs.realpathSync(filePath)
    stat = fs.statSync(resolved, { bigint: true })
  } catch (error) {
    return hasErrorCode(error, 'ENOENT', 'ENOTDIR')
      ? absent
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  if (!stat.isFile() || stat.size > BigInt(MAX_IGNORE_SOURCE_BYTES)) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const read = readRegularFileHardened(
    resolved,
    {
      isFile: true,
      isSymbolicLink: false,
      isDirectory: false,
      mode: Number(stat.mode),
      size: Number(stat.size),
      dev: stat.dev,
      ino: stat.ino,
    },
    MAX_IGNORE_SOURCE_BYTES,
  )
  if (read.status === 'missing') {
    return { status: 'error', reasonCode: 'worktree-unstable' }
  }
  if (read.status === 'error') {
    return {
      status: 'error',
      reasonCode:
        read.reasonCode === 'file-output-limit'
          ? 'file-read-failed'
          : read.reasonCode,
    }
  }
  return { status: 'ok', fact: { label, content: read.content } }
}

function defaultExcludesFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, 'git', 'ignore')
  return path.join(process.env.HOME || os.homedir(), '.config', 'git', 'ignore')
}

/**
 * `core.excludesFile` as git resolves it: the configured path, or the XDG
 * default when unset. `undefined` means a configured-empty value, which names
 * no file.
 */
function resolveExcludesFilePath(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
):
  | { status: 'ok'; filePath: string | undefined }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const result = runCommandAllowingExit(
    runner,
    ['config', '--type=path', '--get', 'core.excludesFile'],
    context.commandDirectory,
    limits,
    [0, 1],
  )
  if (result.status === 'error') return result
  // Exit 1 means the key is unset.
  if (result.exitCode === 1) {
    return { status: 'ok', filePath: defaultExcludesFilePath() }
  }
  const configured = result.output.stdout.replace(/\n$/, '')
  return {
    status: 'ok',
    filePath:
      configured.length === 0
        ? undefined
        : path.resolve(context.worktreeRoot, configured),
  }
}

/** `info/exclude` and `core.excludesFile`, in that fixed order. */
function readIgnoreSources(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
):
  | { status: 'ok'; facts: readonly IgnoreSourceFact[] }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const infoExclude = readIgnoreSourceFile(
    'info-exclude',
    context.infoExcludePath,
  )
  if (infoExclude.status === 'error') return infoExclude
  const configured = resolveExcludesFilePath(runner, context, limits)
  if (configured.status === 'error') return configured
  const global =
    configured.filePath === undefined
      ? ({
          status: 'ok',
          fact: { label: 'core-excludes-file', content: undefined },
        } as const)
      : readIgnoreSourceFile('core-excludes-file', configured.filePath)
  if (global.status === 'error') return global
  return { status: 'ok', facts: [infoExclude.fact, global.fact] }
}

function hashIgnoreSource(
  hash: ReturnType<typeof createHash>,
  fact: IgnoreSourceFact,
): void {
  // No path of any kind enters the identity, only the label and the bytes.
  hash.update('ignore-source')
  hashField(hash, fact.label)
  hashField(hash, fact.content === undefined ? 'absent' : 'present')
  hashField(hash, fact.content ?? '')
}

function sameIgnoreSources(
  left: readonly IgnoreSourceFact[],
  right: readonly IgnoreSourceFact[],
): boolean {
  return (
    left.length === right.length &&
    left.every((fact, index) => {
      const other = right[index]
      if (other === undefined || fact.label !== other.label) return false
      if (fact.content === undefined || other.content === undefined) {
        return fact.content === other.content
      }
      return Buffer.compare(fact.content, other.content) === 0
    })
  )
}

export interface HeadTreeEntry {
  readonly mode: string
  readonly id: string
}

type HeadTreeResult =
  | {
      status: 'ok'
      entries: ReadonlyMap<string, HeadTreeEntry>
      ids: readonly string[]
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

/** `ls-tree -r -z --full-tree <sha>`, read once per snapshot. */
function readHeadTree(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  head: string | undefined,
  limits: Limits,
): HeadTreeResult {
  const entries = new Map<string, HeadTreeEntry>()
  if (head === undefined) return { status: 'ok', entries, ids: [] }
  const listing = runCommand(
    runner,
    ['ls-tree', '-r', '-z', '--full-tree', head],
    context.commandDirectory,
    limits,
  )
  if (listing.status === 'error') return listing
  for (const record of splitRecords(listing.output.stdout)) {
    const separator = record.indexOf('\t')
    const [mode, , id] = record.slice(0, separator).split(' ')
    const entryPath = record.slice(separator + 1)
    if (
      separator <= 0 ||
      !mode ||
      !id ||
      !/^[0-7]{6}$/.test(mode) ||
      !GIT_OBJECT_ID.test(id) ||
      outputBytes(entryPath) > limits.maxPathBytes
    ) {
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    entries.set(entryPath, { mode, id: id.toLowerCase() })
  }
  return {
    status: 'ok',
    entries,
    ids: [...entries.values()].map((entry) => entry.id),
  }
}

/** 40 hex digits is sha1, 64 is sha256. Mixed lengths cannot happen in one repo. */
function inferObjectFormat(ids: readonly string[]): ObjectFormat | undefined {
  const lengths = new Set(ids.map((id) => id.length))
  if (lengths.size === 0) return 'sha1'
  if (lengths.size > 1) return undefined
  return lengths.has(64) ? 'sha256' : 'sha1'
}

interface WorktreeListings {
  readonly first: RawListings
  readonly stageEntries: readonly StageEntry[]
  readonly paths: readonly string[]
}

/** The first listing, and the sorted union of every path to observe. */
function readWorktreeListings(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  headTree: ReadonlyMap<string, HeadTreeEntry>,
  limits: Limits,
):
  | ({ status: 'ok' } & WorktreeListings)
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const first = listWorktreePaths(runner, context, limits)
  if (first.status === 'error') return first
  const stageEntries = parseStageEntries(first.staged, limits.maxPathBytes)
  if (!stageEntries) return { status: 'error', reasonCode: 'file-read-failed' }
  // A trailing slash marks a wholly ignored directory, whose contents are
  // ignored and so stay out of the identity.
  const selfIgnored = splitRecords(first.ignoredGitignores).filter(
    (entry) => !entry.endsWith('/'),
  )
  const unique = new Set([
    ...stageEntries.map((entry) => entry.relativePath),
    ...headTree.keys(),
    ...splitRecords(first.untracked),
    ...selfIgnored,
  ])
  // Sort by raw UTF-8 bytes. The keys are built once, not on every comparison.
  const paths = [...unique]
    .map((entry) => ({ entry, key: Buffer.from(entry) }))
    .sort((left, right) => left.key.compare(right.key))
    .map(({ entry }) => entry)
  return { status: 'ok', first, stageEntries, paths }
}

/**
 * Whether any path in `sortedPaths` lies beneath `directory`. The list is in
 * byte order, so every path beneath `directory/` is contiguous and starts at
 * the first entry that is `>= 'directory/'`. One binary search finds it, and
 * a prefix check on that entry decides. Nothing is built per path.
 */
function hasPathBeneath(
  sortedPaths: readonly string[],
  directory: string,
): boolean {
  const prefix = `${directory}/`
  const key = Buffer.from(prefix)
  let low = 0
  let high = sortedPaths.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const candidate = sortedPaths[middle]
    if (candidate !== undefined && Buffer.from(candidate).compare(key) < 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return (
    low < sortedPaths.length && (sortedPaths[low]?.startsWith(prefix) ?? false)
  )
}

/**
 * Gitlinks that only `HEAD` lists and that now have paths beneath them. A
 * gitlink in the index is current, so it is never displaced: a populated
 * directory without `.git` there is still malformed.
 *
 * `sortedPaths` must be in UTF-8 byte order, as the path set is.
 *
 * @internal Exported for tests only.
 */
export function findDisplacedGitlinks(
  sortedPaths: readonly string[],
  indexModes: ReadonlyMap<string, string>,
  headTree: ReadonlyMap<string, HeadTreeEntry>,
): ReadonlySet<string> {
  // Usually none, or one: a repository seldom has more than a few submodules.
  const candidates = sortedPaths.filter(
    (entry) => !indexModes.has(entry) && headTree.get(entry)?.mode === '160000',
  )
  return new Set(
    candidates.filter((entry) => hasPathBeneath(sortedPaths, entry)),
  )
}

/** What the final pass compares against, taken during one repository's first pass. */
interface RepositoryPass {
  readonly context: RepositoryContext
  readonly head: string | undefined
  readonly first: FirstPass
  readonly observations: readonly PathObservation[]
  readonly verifiedDirectories: ReadonlySet<string>
}

/** One repository's first pass: its digest, its records and what it must still prove. */
interface RepositorySnapshot {
  readonly digest: string
  readonly records: readonly WorktreeRecord[]
  /** The `HEAD` tree by path, for the commit closure. Empty when unborn. */
  readonly headTree: ReadonlyMap<string, HeadTreeEntry>
  /** What each observed gitlink held, for the commit closure. */
  readonly gitlinkStates: ReadonlyMap<string, GitlinkState>
  readonly pass: RepositoryPass
}

type RepositorySnapshotResult =
  | ({ status: 'ok' } & RepositorySnapshot)
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

/**
 * The first pass over one repository, parent or checkout: ignore sources, the
 * `HEAD` tree, the path set and a fact for every path. A gitlink with a
 * checkout is read the same way from inside `appendPathFact`, sharing `walk`.
 * The final pass is the caller's, so a checkout's runs inside its parent's.
 */
function readRepositorySnapshot(
  readers: WorktreeReaders,
  context: RepositoryContext,
  head: string | undefined,
  limits: Limits,
  walk: WalkState,
): RepositorySnapshotResult {
  const { runner } = readers
  // Ignore sources are read before any listing: git itself reads them while
  // listing, so a FIFO or a device must be rejected before that happens.
  const sources = readIgnoreSources(runner, context, limits)
  if (sources.status === 'error') return sources
  const tree = readHeadTree(runner, context, head, limits)
  if (tree.status === 'error') return tree
  const listings = readWorktreeListings(runner, context, tree.entries, limits)
  if (listings.status === 'error') return listings
  const format = inferObjectFormat([
    ...tree.ids,
    ...listings.stageEntries.map((entry) => entry.id),
  ])
  if (format === undefined) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const { paths } = listings
  // Counted against everything this snapshot has read so far.
  if (walk.files + paths.length > limits.maxFiles) {
    return { status: 'error', reasonCode: 'file-limit' }
  }
  walk.files += paths.length
  const modes = new Map(
    listings.stageEntries.map((entry) => [entry.relativePath, entry.mode]),
  )
  const modeOf = (relativePath: string): string =>
    // Index first, then the HEAD tree; empty means not tracked at all.
    modes.get(relativePath) ?? tree.entries.get(relativePath)?.mode ?? ''
  const displacedGitlinks = findDisplacedGitlinks(paths, modes, tree.entries)
  // Counted from the index and the HEAD tree before any submodule spawn. A
  // displaced gitlink is never read, so it does not count.
  const gitlinkCount = paths.filter(
    (entry) => modeOf(entry) === '160000' && !displacedGitlinks.has(entry),
  ).length
  if (walk.gitlinks + gitlinkCount > limits.maxGitlinks) {
    return { status: 'error', reasonCode: 'file-limit' }
  }
  walk.gitlinks += gitlinkCount
  const hash = createHash('sha256')
  hash.update(WORKTREE_DIGEST_DOMAIN)
  const observations: PathObservation[] = []
  const verifiedDirectories = new Set<string>()
  for (const relativePath of paths) {
    const result = appendPathFact(
      hash,
      readers,
      context,
      {
        relativePath,
        mode: modeOf(relativePath),
        ...(displacedGitlinks.has(relativePath)
          ? { displacedGitlink: true as const }
          : {}),
      },
      limits,
      walk,
      format,
      verifiedDirectories,
    )
    if (result.status === 'error') return result
    observations.push(result.observation)
  }
  for (const fact of sources.facts) hashIgnoreSource(hash, fact)
  return {
    status: 'ok',
    digest: hash.digest('hex'),
    records: observations.map((observation) => observation.record),
    headTree: tree.entries,
    gitlinkStates: new Map(
      observations.flatMap(({ record, gitlinkState }) =>
        gitlinkState ? [[record.path, gitlinkState] as const] : [],
      ),
    ),
    pass: {
      context,
      head,
      first: { ...listings.first, ignoreSources: sources.facts },
      observations,
      verifiedDirectories,
    },
  }
}

/**
 * Closed means this repository equals its `HEAD` tree and so does every
 * checkout it walked. A dirty checkout is not a failure: it is available, not
 * closed, with a changed digest.
 */
function isRepositoryClosed(snapshot: RepositorySnapshot): boolean {
  return (
    deriveCommitClosure(
      snapshot.records,
      snapshot.headTree,
      snapshot.pass.head,
      snapshot.gitlinkStates,
    ) &&
    snapshot.pass.observations.every(
      ({ walked }) => walked === undefined || isRepositoryClosed(walked),
    )
  )
}

function readWorktreeSnapshot(
  readers: WorktreeReaders,
  context: RepositoryContext,
  head: string | undefined,
  limits: Limits,
  walk: WalkState,
):
  | {
      status: 'ok'
      digest: string
      records: readonly WorktreeRecord[]
      /** The `HEAD` tree by path. Empty when unborn. */
      headTree: ReadonlyMap<string, HeadTreeEntry>
      /** The parent and every walked checkout equal their `HEAD` trees. */
      commitClosure: boolean
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const snapshot = readRepositorySnapshot(readers, context, head, limits, walk)
  if (snapshot.status === 'error') return snapshot
  const stable = runFinalPass(readers, limits, snapshot.pass, ROOT_MOVED)
  if (stable.status === 'error') return stable
  return {
    status: 'ok',
    digest: snapshot.digest,
    records: snapshot.records,
    headTree: snapshot.headTree,
    commitClosure: isRepositoryClosed(snapshot),
  }
}

function recordKindForTreeMode(mode: string): WorktreeRecordKind {
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'gitlink'
  return 'regular'
}

/** One observed path equals its `HEAD` entry in kind, mode and object id. */
function recordMatchesTreeEntry(
  record: WorktreeRecord,
  entry: HeadTreeEntry,
): boolean {
  // A `missing` path carries no id and never matches. An uninitialized gitlink
  // has none either; `deriveCommitClosure` decides that case.
  return (
    record.id !== undefined &&
    record.id === entry.id &&
    record.mode === entry.mode &&
    record.kind === recordKindForTreeMode(entry.mode)
  )
}

/**
 * Closed means the observed tree is exactly the `HEAD` tree: every `HEAD`
 * entry was observed with the same kind, mode and id, and nothing else was
 * observed. Untracked, intent-to-add and self-ignored files are extra records;
 * a deleted path is a `missing` record that matches nothing. An unborn `HEAD`
 * has no tree to equal, so it is never closed. Only the records are compared,
 * so no git filter, replace ref or normalization can speak for the files, and
 * the index is not consulted.
 *
 * Two gitlink states have no commit to compare. An uninitialized submodule is
 * a clone that did not fetch it, so it matches the gitlink `HEAD` records. An
 * unborn one holds a checkout with no commit, which `HEAD` cannot have
 * recorded: its record has no id, so it matches nothing and is never closed.
 */
function deriveCommitClosure(
  records: readonly WorktreeRecord[],
  headTree: ReadonlyMap<string, HeadTreeEntry>,
  head: string | undefined,
  gitlinkStates: ReadonlyMap<string, GitlinkState>,
): boolean {
  if (head === undefined) return false
  let matched = 0
  for (const record of records) {
    const entry = headTree.get(record.path)
    if (entry === undefined) return false
    const state = gitlinkStates.get(record.path)
    const matches =
      state === 'uninitialized'
        ? entry.mode === '160000'
        : recordMatchesTreeEntry(record, entry)
    if (!matches) return false
    matched += 1
  }
  // Records have unique paths, so this means every `HEAD` entry was observed.
  return matched === headTree.size
}

function runRemoteCommand(
  runner: OperationObserverRemoteCommandRunner,
  executable: 'git' | 'gh',
  args: readonly string[],
  root: string,
  limits: Limits,
):
  | { status: 'ok'; stdout: string }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  let result: OperationObserverRemoteCommandResult
  try {
    result = runner(
      executable,
      args,
      root,
      limits.maxRemoteCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'remote-command-failed' }
  }
  if (result.timedOut) {
    return { status: 'error', reasonCode: 'command-timeout' }
  }
  if (
    outputBytes(result.stdout) > limits.maxRemoteCommandOutputBytes ||
    outputBytes(result.stderr) > limits.maxRemoteCommandOutputBytes
  ) {
    return { status: 'error', reasonCode: 'remote-command-output-limit' }
  }
  if (result.status !== 0) {
    return { status: 'error', reasonCode: 'remote-command-failed' }
  }
  return { status: 'ok', stdout: result.stdout }
}

function readRemoteGitValue(
  runner: OperationObserverRemoteCommandRunner,
  args: readonly string[],
  root: string,
  limits: Limits,
):
  | { status: 'ok'; value: string }
  | { status: 'missing-resource' }
  | { status: 'unavailable'; reasonCode: OperationObserverReasonCode } {
  const result = runRemoteCommand(runner, 'git', args, root, limits)
  if (result.status === 'error') {
    return result.reasonCode === 'remote-command-failed'
      ? { status: 'missing-resource' }
      : { status: 'unavailable', reasonCode: result.reasonCode }
  }
  const value = result.stdout.trim()
  return value.length > 0
    ? { status: 'ok', value }
    : { status: 'unavailable', reasonCode: 'remote-missing-field' }
}

function parseRemoteJson(
  result:
    | { status: 'ok'; stdout: string }
    | { status: 'error'; reasonCode: OperationObserverReasonCode },
):
  | { status: 'ok'; value: unknown }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  if (result.status === 'error') return result
  try {
    return { status: 'ok', value: JSON.parse(result.stdout) as unknown }
  } catch {
    return { status: 'error', reasonCode: 'remote-invalid-json' }
  }
}

function isHexRevision(value: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(value)
}

function remoteState(value: unknown): 'open' | 'closed' | 'merged' | undefined {
  if (value === 'OPEN') return 'open'
  if (value === 'CLOSED') return 'closed'
  if (value === 'MERGED') return 'merged'
  return undefined
}

function parsePullRequest(
  value: unknown,
  limits: Limits,
):
  | {
      status: 'ok'
      number: number
      state: 'open' | 'closed' | 'merged'
      headRefOid: string
      reviewDecision?: unknown
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'error', reasonCode: 'remote-missing-field' }
  }
  const record = value as Record<string, unknown>
  const number = record.number
  const state = remoteState(record.state)
  const headRefOid = record.headRefOid
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    state === undefined ||
    typeof headRefOid !== 'string' ||
    !isHexRevision(headRefOid) ||
    Object.keys(record).length > limits.maxRemoteItems
  ) {
    return { status: 'error', reasonCode: 'remote-missing-field' }
  }
  return {
    status: 'ok',
    number,
    state,
    headRefOid,
    reviewDecision: record.reviewDecision,
  }
}

function reviewState(
  value: unknown,
): 'approved' | 'changes-requested' | 'commented' | 'pending' | undefined {
  if (value === null || value === 'REVIEW_REQUIRED') return 'pending'
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes-requested'
  if (value === 'COMMENTED') return 'commented'
  return undefined
}

function checkState(
  value: unknown,
  limits: Limits,
): 'completed-success' | 'completed-failure' | 'pending' | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > limits.maxRemoteItems
  )
    return undefined
  let pending = false
  let failed = false
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return undefined
    const state = (entry as Record<string, unknown>).state
    if (state === 'SUCCESS') continue
    if (
      state === 'PENDING' ||
      state === 'QUEUED' ||
      state === 'IN_PROGRESS' ||
      state === 'EXPECTED'
    ) {
      pending = true
      continue
    }
    failed = true
  }
  if (pending) return 'pending'
  return failed ? 'completed-failure' : 'completed-success'
}

function remoteResultFromPullRequest(
  pullRequest: {
    number: number
    state: 'open' | 'closed' | 'merged'
    headRefOid: string
  },
  extra: {
    checkState?: OperationObserverRemoteSnapshot['checkState']
    reviewDecision?: OperationObserverRemoteSnapshot['reviewDecision']
  } = {},
): OperationObserverRemoteResult {
  const resourceIdentity = digest('remote-resource', [
    String(pullRequest.number),
  ])
  const resourceRevisionIdentity = digest('remote-resource-revision', [
    pullRequest.headRefOid.toLowerCase(),
  ])
  return {
    status: 'available',
    snapshot: {
      resourceIdentity,
      resourceRevisionIdentity,
      pullRequest: {
        identity: resourceIdentity,
        state: pullRequest.state,
      },
      ...extra,
    },
  }
}

function readPushRemoteSnapshot(
  runner: OperationObserverRemoteCommandRunner,
  phase: RemoteReadbackPhase,
  root: string,
  limits: Limits,
): OperationObserverRemoteResult {
  const upstream = readRemoteGitValue(
    runner,
    ['rev-parse', '--abbrev-ref', '@{upstream}'],
    root,
    limits,
  )
  if (upstream.status !== 'ok') {
    return upstream.status === 'missing-resource'
      ? upstream
      : { status: 'unavailable', reasonCode: upstream.reasonCode }
  }
  const revision = readRemoteGitValue(
    runner,
    ['rev-parse', '@{upstream}'],
    root,
    limits,
  )
  if (revision.status !== 'ok') {
    return revision.status === 'missing-resource'
      ? revision
      : { status: 'unavailable', reasonCode: revision.reasonCode }
  }
  if (phase === 'after') {
    const localHead = readRemoteGitValue(
      runner,
      ['rev-parse', 'HEAD'],
      root,
      limits,
    )
    if (localHead.status !== 'ok') {
      return localHead.status === 'missing-resource'
        ? localHead
        : { status: 'unavailable', reasonCode: localHead.reasonCode }
    }
    if (revision.value !== localHead.value) {
      return { status: 'unavailable', reasonCode: 'remote-not-advanced' }
    }
  }
  return {
    status: 'available',
    snapshot: {
      resourceIdentity: digest('remote-resource', [upstream.value]),
      resourceRevisionIdentity: digest('remote-resource-revision', [
        revision.value,
      ]),
    },
  }
}

function readRemotePullRequest(
  runner: OperationObserverRemoteCommandRunner,
  operation: Exclude<RemoteOperation, 'push'>,
  root: string,
  limits: Limits,
): OperationObserverRemoteResult {
  const viewArgs =
    operation === 'review-readback'
      ? ['pr', 'view', '--json', 'number,state,headRefOid,reviewDecision']
      : ['pr', 'view', '--json', 'number,state,headRefOid']
  const view = runRemoteCommand(runner, 'gh', viewArgs, root, limits)
  if (view.status === 'error') {
    return view.reasonCode === 'remote-command-failed'
      ? { status: 'missing-resource' }
      : { status: 'unavailable', reasonCode: view.reasonCode }
  }
  const parsed = parseRemoteJson(view)
  if (parsed.status === 'error')
    return { status: 'unavailable', reasonCode: parsed.reasonCode }
  const pullRequest = parsePullRequest(parsed.value, limits)
  if (pullRequest.status === 'error')
    return { status: 'unavailable', reasonCode: pullRequest.reasonCode }
  return operation === 'review-readback'
    ? readReviewReadback(pullRequest)
    : readCheckReadback(runner, root, limits, pullRequest)
}

function readReviewReadback(pullRequest: {
  number: number
  state: 'open' | 'closed' | 'merged'
  headRefOid: string
  reviewDecision?: unknown
}): OperationObserverRemoteResult {
  const decision = reviewState(pullRequest.reviewDecision)
  return decision === undefined
    ? { status: 'unavailable', reasonCode: 'remote-missing-field' }
    : remoteResultFromPullRequest(pullRequest, { reviewDecision: decision })
}

function readCheckReadback(
  runner: OperationObserverRemoteCommandRunner,
  root: string,
  limits: Limits,
  pullRequest: {
    number: number
    state: 'open' | 'closed' | 'merged'
    headRefOid: string
  },
): OperationObserverRemoteResult {
  const checks = runRemoteCommand(
    runner,
    'gh',
    ['pr', 'checks', '--json', 'state'],
    root,
    limits,
  )
  if (checks.status === 'error') {
    return checks.reasonCode === 'remote-command-failed'
      ? { status: 'missing-resource' }
      : { status: 'unavailable', reasonCode: checks.reasonCode }
  }
  const parsedChecks = parseRemoteJson(checks)
  if (parsedChecks.status === 'error') {
    return { status: 'unavailable', reasonCode: parsedChecks.reasonCode }
  }
  const state = checkState(parsedChecks.value, limits)
  return state === undefined
    ? { status: 'unavailable', reasonCode: 'remote-missing-field' }
    : remoteResultFromPullRequest(pullRequest, { checkState: state })
}

function readRemoteSnapshot(
  runner: OperationObserverRemoteCommandRunner,
  operation: RemoteOperation,
  phase: RemoteReadbackPhase,
  commandDirectory: string,
  limits: Limits,
): OperationObserverRemoteResult {
  return operation === 'push'
    ? readPushRemoteSnapshot(runner, phase, commandDirectory, limits)
    : readRemotePullRequest(runner, operation, commandDirectory, limits)
}

function resolveWorktreeReaders(
  runner: OperationObserverCommandRunner,
  options: Pick<
    OpencodeOperationObserverOptions,
    'fileReader' | 'symlinkReader' | 'statReader' | 'realPath'
  >,
): WorktreeReaders {
  return {
    runner,
    realPath: options.realPath ?? fs.realpathSync,
    readRegular: options.fileReader
      ? adaptInjectedFileReader(options.fileReader)
      : readRegularFileHardened,
    symlinkReader:
      options.symlinkReader ??
      ((filePath: string): Uint8Array =>
        fs.readlinkSync(filePath, { encoding: 'buffer' })),
    statReader:
      options.statReader ??
      ((filePath: string): OperationObserverFileStat => {
        const stat = fs.lstatSync(filePath, { bigint: true })
        return {
          isFile: stat.isFile(),
          isSymbolicLink: stat.isSymbolicLink(),
          isDirectory: stat.isDirectory(),
          mode: Number(stat.mode),
          size: Number(stat.size),
          dev: stat.dev,
          ino: stat.ino,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
        }
      }),
  }
}

/**
 * @internal Test hook: runs the worktree read on its own and returns the path
 * records beside the digest. The observer API does not expose records.
 */
export function readWorktreeRecords(
  targetDirectory: string,
  options: Omit<
    OpencodeOperationObserverOptions,
    'targetDirectory' | 'remoteCommandRunner'
  > = {},
):
  | {
      status: 'ok'
      digest: string
      records: readonly WorktreeRecord[]
      headTree: ReadonlyMap<string, HeadTreeEntry>
      commitClosure: boolean
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const limits = mergeLimits(options.limits)
  const realPath = options.realPath ?? fs.realpathSync
  const runner = withForcedGitPrefix(
    options.commandRunner ?? defaultCommandRunner,
  )
  const anchor = readRepositoryAnchor(runner, targetDirectory, limits, realPath)
  if (anchor.status === 'error') return anchor
  return readWorktreeSnapshot(
    resolveWorktreeReaders(runner, options),
    {
      commandDirectory: targetDirectory,
      worktreeRoot: anchor.toplevel,
      infoExcludePath: anchor.infoExcludePath,
      pin: {
        targetRoot: anchor.toplevel,
        gitDir: anchor.gitDir,
        commonDir: anchor.commonDir,
      },
    },
    anchor.head,
    limits,
    createWalkState(),
  )
}

export function createOpencodeOperationObserver(
  options: OpencodeOperationObserverOptions,
): OpencodeOperationObserver {
  const limits = mergeLimits(options.limits)
  let targetDirectory: string
  try {
    targetDirectory = (options.realPath ?? fs.realpathSync)(
      options.targetDirectory,
    )
  } catch {
    targetDirectory = path.resolve(options.targetDirectory)
  }
  // Wrapped exactly once; everything below, including the registered-worktree
  // validator, receives this runner and must not wrap it again.
  const runner = withForcedGitPrefix(
    options.commandRunner ?? defaultCommandRunner,
  )
  const remoteRunner = options.remoteCommandRunner ?? defaultRemoteCommandRunner
  const realPath = options.realPath ?? fs.realpathSync
  const rootPinResult = captureRootPin(
    targetDirectory,
    runner,
    limits,
    realPath,
  )
  const parentIdentityResult: ParentIdentityCaptureResult =
    rootPinResult.status === 'error'
      ? rootPinResult
      : captureParentIdentity(
          targetDirectory,
          rootPinResult.pin,
          runner,
          limits,
          realPath,
        )
  const targetDigest = digest('target', [targetDirectory])
  const readers = resolveWorktreeReaders(runner, options)
  return {
    targetDigest,
    validateRegisteredWorktree(candidateDirectory) {
      if (parentIdentityResult.status === 'error') return parentIdentityResult
      return validateRegisteredWorktree(
        candidateDirectory,
        parentIdentityResult.identity,
        { commandRunner: runner, limits, realPath },
      )
    },
    async snapshot(): Promise<OperationObserverResult> {
      const anchor = readRepositoryAnchor(
        runner,
        targetDirectory,
        limits,
        realPath,
      )
      if (anchor.status === 'error') return unavailable(anchor)
      if (rootPinResult.status === 'error') return unavailable(rootPinResult)
      // A `core.worktree` or gitfile redirect after construction must not
      // quietly point the observer at different content.
      if (
        anchor.toplevel !== rootPinResult.pin.targetRoot ||
        anchor.gitDir !== rootPinResult.pin.gitDir ||
        anchor.commonDir !== rootPinResult.pin.commonDir
      ) {
        return { status: 'unavailable', reasonCode: 'target-unavailable' }
      }
      const context: RepositoryContext = {
        commandDirectory: targetDirectory,
        worktreeRoot: anchor.toplevel,
        infoExcludePath: anchor.infoExcludePath,
        pin: rootPinResult.pin,
      }
      const repository = readRevision(
        runner,
        context,
        anchor.head,
        anchor.insideWorkTree,
        limits,
      )
      if (repository.status === 'error') return unavailable(repository)
      const worktree = readWorktreeSnapshot(
        readers,
        context,
        anchor.head,
        limits,
        createWalkState(),
      )
      if (worktree.status === 'error') return unavailable(worktree)
      return {
        status: 'available',
        snapshot: {
          targetDigest,
          repositoryRevisionDigest: repository.digest,
          worktreeRevisionDigest: worktree.digest,
          commitClosure: worktree.commitClosure,
        },
      }
    },
    async remoteSnapshot(operation, phase) {
      const rootResult = runCommand(
        runner,
        ['rev-parse', '--show-toplevel'],
        targetDirectory,
        limits,
      )
      if (rootResult.status === 'error') {
        return { status: 'unavailable', reasonCode: rootResult.reasonCode }
      }
      const root = rootResult.output.stdout.trim()
      if (root.length === 0 || outputBytes(root) > limits.maxPathBytes) {
        return { status: 'unavailable', reasonCode: 'target-unavailable' }
      }
      return readRemoteSnapshot(
        remoteRunner,
        operation,
        phase,
        targetDirectory,
        limits,
      )
    },
  }
}
