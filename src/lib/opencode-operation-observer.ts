import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_LIMITS = {
  maxCommandOutputBytes: 8_388_608,
  maxCommandTimeoutMs: 5_000,
  maxFiles: 20_000,
  maxRemoteCommandOutputBytes: 1_048_576,
  maxRemoteItems: 4096,
  maxTotalFileBytes: 134_217_728,
  maxPathBytes: 4096,
} as const

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
const WORKTREE_DIGEST_DOMAIN = 'systematic:opencode-observer:worktree:v3\0'

// Self-ignored untracked `.gitignore` files never appear in the plain untracked
// listing, yet they change what is hidden, so they are discovered separately.
const IGNORED_GITIGNORE_ARGS = [
  'ls-files',
  '-o',
  '-i',
  '--exclude-standard',
  '--directory',
  '-z',
  '--',
  ':(glob)**/.gitignore',
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
  readonly maxRemoteCommandOutputBytes: number
  readonly maxRemoteItems: number
  readonly maxTotalFileBytes: number
  readonly maxPathBytes: number
}

interface GitCommandOutput {
  readonly stdout: string
}

interface StageEntry {
  readonly record: string
  readonly mode: string
  readonly relativePath: string
}

interface RepositoryContext {
  readonly commandDirectory: string
  readonly worktreeRoot: string
  /** Absolute path of the repository's `info/exclude`. */
  readonly infoExcludePath: string
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

/** One budget for the whole snapshot. `gitlinks` is counted, not yet enforced. */
interface SnapshotBudget {
  files: number
  bytes: number
  gitlinks: number
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
}

interface WorktreeReaders {
  readonly runner: OperationObserverCommandRunner
  readonly readRegular: RegularContentReader
  readonly symlinkReader: (filePath: string) => Uint8Array
  readonly statReader: (filePath: string) => OperationObserverFileStat
}

interface RootPin {
  readonly targetRoot: string
  readonly gitDir: string
}

type RootPinCaptureResult =
  | { status: 'ok'; pin: RootPin }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

type RepositoryAnchorResult =
  | {
      status: 'ok'
      toplevel: string
      gitDir: string
      /** Full object id, or `undefined` for an unborn `HEAD`. */
      head: string | undefined
      infoExcludePath: string
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

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
    const [mode] = header.split(' ')
    if (!mode) return undefined
    entries.push({ record, mode, relativePath })
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

function runCommand(
  runner: OperationObserverCommandRunner,
  args: readonly string[],
  cwd: string,
  limits: Limits,
):
  | { status: 'ok'; output: GitCommandOutput }
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
  if (result.status !== 0) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  return { status: 'ok', output: { stdout: result.stdout } }
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
  return {
    status: 'ok',
    pin: { targetRoot: targetRoot.value, gitDir: gitDir.value },
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
  const inside = runCommand(
    runner,
    ['rev-parse', '--is-inside-work-tree'],
    context.commandDirectory,
    limits,
  )
  if (inside.status === 'error') return inside
  return {
    status: 'ok',
    digest: digest('repository-revision', [
      head ?? 'unborn',
      branchValue,
      inside.output.stdout.trim(),
    ]),
  }
}

/**
 * One `rev-parse` returns toplevel, absolute git dir, the `info/exclude` path
 * and the `HEAD` id, in that order. `--verify -q` makes an unborn `HEAD` exit 1
 * with only the first three lines, so unborn is distinguishable from every
 * other failure. `--git-path` prints a path relative to `cwd` (absolute for a
 * linked worktree), so it is resolved against `cwd`.
 */
function readRepositoryAnchor(
  runner: OperationObserverCommandRunner,
  cwd: string,
  limits: Limits,
  realPath: (filePath: string) => string,
): RepositoryAnchorResult {
  let result: OperationObserverCommandResult
  try {
    result = runner(
      [
        'rev-parse',
        '--show-toplevel',
        '--absolute-git-dir',
        '--git-path',
        'info/exclude',
        '--verify',
        '-q',
        'HEAD',
      ],
      cwd,
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const resultError = commandResultError(result, limits)
  if (resultError) return { status: 'error', reasonCode: resultError }
  const lines = result.stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const unborn = result.status === 1 && lines.length === 3
  if (result.status !== 0 && !unborn) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const [toplevelLine, gitDirLine, excludeLine, head] = lines
  const malformed =
    lines.length !== (unborn ? 3 : 4) ||
    toplevelLine === undefined ||
    gitDirLine === undefined ||
    excludeLine === undefined ||
    excludeLine.length === 0 ||
    outputBytes(toplevelLine) > limits.maxPathBytes ||
    (head !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head))
  if (malformed) return { status: 'error', reasonCode: 'target-unavailable' }
  const toplevel = absoluteCanonicalPath(toplevelLine, realPath)
  const gitDir = absoluteCanonicalPath(gitDirLine, realPath)
  if (toplevel === undefined || gitDir === undefined) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  return {
    status: 'ok',
    toplevel,
    gitDir,
    head,
    infoExcludePath: path.resolve(cwd, excludeLine),
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

type FactResult =
  | {
      status: 'ok'
      record: WorktreeRecord
      stat: OperationObserverFileStat | undefined
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

type ObservationResult =
  | { status: 'ok'; observation: PathObservation }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

function gitBlobId(content: Uint8Array, format: ObjectFormat): string {
  return createHash(format)
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

function missingRecord(relativePath: string): FactResult {
  return {
    status: 'ok',
    record: { path: relativePath, kind: 'missing', mode: '', id: undefined },
    stat: undefined,
  }
}

/**
 * A listed path that is gone. A tracked path is a deletion. An untracked path
 * was listed moments ago, so its disappearance is a race.
 */
function vanishedPath(tracked: boolean, relativePath: string): FactResult {
  return tracked
    ? missingRecord(relativePath)
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

/** Takes a fresh stat and requires it to equal `before`. */
function confirmStat(
  readers: WorktreeReaders,
  absolutePath: string,
  before: OperationObserverFileStat,
):
  | { status: 'ok'; stat: OperationObserverFileStat }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  let after: OperationObserverFileStat
  try {
    after = readers.statReader(absolutePath)
  } catch (error) {
    return {
      status: 'error',
      reasonCode: isEnoent(error) ? 'worktree-unstable' : 'file-read-failed',
    }
  }
  return sameStat(before, after)
    ? { status: 'ok', stat: after }
    : { status: 'error', reasonCode: 'worktree-unstable' }
}

const READ_CHUNK_BYTES = 65_536
// Reads are synchronous, so one scratch buffer is never shared across calls.
const READ_SCRATCH = Buffer.allocUnsafe(READ_CHUNK_BYTES)

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
  // Cap on the bytes actually read, not on what lstat promised.
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const count = fs.readSync(fd, READ_SCRATCH, 0, READ_CHUNK_BYTES, null)
    if (count === 0) break
    total += count
    if (total > maxBytes) {
      return { status: 'error', reasonCode: 'file-output-limit' }
    }
    chunks.push(Buffer.from(READ_SCRATCH.subarray(0, count)))
  }
  return { status: 'ok', content: Buffer.concat(chunks, total) }
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

function appendSubmoduleFact(
  hash: ReturnType<typeof createHash>,
  runner: OperationObserverCommandRunner,
  submodulePath: string,
  relativePath: string,
  limits: Limits,
  budget: SnapshotBudget,
): FactResult {
  const submodule = runCommand(
    runner,
    ['rev-parse', '--verify', 'HEAD'],
    submodulePath,
    limits,
  )
  if (submodule.status === 'error') return submodule
  const revision = submodule.output.stdout.trim()
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  hash.update('gitlink\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update(revision.toLowerCase())
  hash.update('\0')
  budget.gitlinks += 1
  return {
    status: 'ok',
    record: {
      path: relativePath,
      kind: 'gitlink',
      mode: '160000',
      id: revision.toLowerCase(),
    },
    stat: undefined,
  }
}

function appendSymlinkFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  absolutePath: string,
  relativePath: string,
  stat: OperationObserverFileStat,
  limits: Limits,
  budget: SnapshotBudget,
  format: ObjectFormat,
  tracked: boolean,
): FactResult {
  let target: Uint8Array
  try {
    target = readers.symlinkReader(absolutePath)
  } catch (error) {
    return isEnoent(error)
      ? vanishedPath(tracked, relativePath)
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  const nextBytes = budget.bytes + target.byteLength
  if (
    target.byteLength > limits.maxPathBytes ||
    nextBytes > limits.maxTotalFileBytes
  ) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  const confirmed = confirmStat(readers, absolutePath, stat)
  if (confirmed.status === 'error') return confirmed
  hash.update('symlink\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update(target)
  hash.update('\0')
  budget.bytes = nextBytes
  return {
    status: 'ok',
    record: {
      path: relativePath,
      kind: 'symlink',
      mode: '120000',
      id: gitBlobId(target, format),
    },
    stat: confirmed.stat,
  }
}

function appendRegularFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  absolutePath: string,
  relativePath: string,
  stat: OperationObserverFileStat,
  limits: Limits,
  budget: SnapshotBudget,
  format: ObjectFormat,
  tracked: boolean,
): FactResult {
  if (!stat.isFile || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const remaining = limits.maxTotalFileBytes - budget.bytes
  if (stat.size > remaining) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  const read = readers.readRegular(absolutePath, stat, remaining)
  if (read.status === 'missing') return vanishedPath(tracked, relativePath)
  if (read.status === 'error') return read
  const { content } = read
  if (content.byteLength > remaining) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  const confirmed = confirmStat(readers, absolutePath, stat)
  if (confirmed.status === 'error') return confirmed
  hash.update('regular\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update((stat.mode & 0o111) !== 0 ? 'executable\0' : 'non-executable\0')
  hash.update(content)
  hash.update('\0')
  budget.bytes += content.byteLength
  return {
    status: 'ok',
    record: {
      path: relativePath,
      kind: 'regular',
      // Git's rule: only the owner execute bit matters.
      mode: (stat.mode & 0o100) !== 0 ? '100755' : '100644',
      id: gitBlobId(content, format),
    },
    stat: confirmed.stat,
  }
}

function appendResolvedFact(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  absolutePath: string,
  entry: Pick<StageEntry, 'mode' | 'relativePath'>,
  limits: Limits,
  budget: SnapshotBudget,
  format: ObjectFormat,
): FactResult {
  const { mode, relativePath } = entry
  // An empty mode means the path is not in the index.
  const tracked = mode !== ''
  let stat: OperationObserverFileStat
  try {
    stat = readers.statReader(absolutePath)
  } catch (error) {
    return isEnoent(error)
      ? vanishedPath(tracked, relativePath)
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  if (mode === '160000') {
    return appendSubmoduleFact(
      hash,
      readers.runner,
      absolutePath,
      relativePath,
      limits,
      budget,
    )
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

function appendFileFactV2(
  hash: ReturnType<typeof createHash>,
  readers: WorktreeReaders,
  context: RepositoryContext,
  entry: Pick<StageEntry, 'mode' | 'relativePath'>,
  limits: Limits,
  budget: SnapshotBudget,
  format: ObjectFormat,
): ObservationResult {
  const absolutePath = safePath(context.worktreeRoot, entry.relativePath)
  if (!absolutePath || outputBytes(entry.relativePath) > limits.maxPathBytes) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const fact = appendResolvedFact(
    hash,
    readers,
    absolutePath,
    entry,
    limits,
    budget,
    format,
  )
  if (fact.status === 'error') return fact
  return {
    status: 'ok',
    observation: { absolutePath, record: fact.record, stat: fact.stat },
  }
}

/** Everything the final pass compares against, taken during the first pass. */
interface FirstPass {
  readonly staged: string
  readonly untracked: string
  readonly ignoredGitignores: string
  readonly ignoreSources: readonly IgnoreSourceFact[]
}

type StabilityResult =
  | { status: 'ok' }
  | { status: 'error'; reasonCode: OperationObserverReasonCode }

const UNSTABLE: StabilityResult = {
  status: 'error',
  reasonCode: 'worktree-unstable',
}

function verifyObservationUnchanged(
  readers: WorktreeReaders,
  { absolutePath, record, stat }: PathObservation,
): StabilityResult {
  // A gitlink directory's times churn with submodule activity, which this
  // snapshot does not cover.
  if (record.kind === 'gitlink') return { status: 'ok' }
  let fresh: OperationObserverFileStat
  try {
    fresh = readers.statReader(absolutePath)
  } catch (error) {
    if (!isEnoent(error)) {
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    // A missing record must stay missing; anything else vanished mid-snapshot.
    return record.kind === 'missing' ? { status: 'ok' } : UNSTABLE
  }
  if (record.kind === 'missing' || stat === undefined) return UNSTABLE
  return sameStat(stat, fresh) ? { status: 'ok' } : UNSTABLE
}

function verifyObservationsUnchanged(
  readers: WorktreeReaders,
  observations: readonly PathObservation[],
): StabilityResult {
  for (const observation of observations) {
    const result = verifyObservationUnchanged(readers, observation)
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
  const staged = runCommand(
    runner,
    ['ls-files', '--stage', '--full-name', '-z', '--', ':/'],
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
  return staged.output.stdout === first.staged &&
    untracked.output.stdout === first.untracked &&
    ignoredGitignores.output.stdout === first.ignoredGitignores
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

function verifyHeadUnchanged(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
  head: string | undefined,
): StabilityResult {
  let result: OperationObserverCommandResult
  try {
    result = runner(
      ['rev-parse', '--verify', '-q', 'HEAD'],
      context.commandDirectory,
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const resultError = commandResultError(result, limits)
  if (resultError) return { status: 'error', reasonCode: resultError }
  // Exit 1 under `-q` is an unborn HEAD.
  if (result.status !== 0 && result.status !== 1) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const current = result.status === 0 ? result.stdout.trim() : undefined
  return current === head ? { status: 'ok' } : UNSTABLE
}

/**
 * The final pass. Any difference from what the snapshot saw means the tree
 * moved underneath it, so the snapshot cannot be trusted.
 */
function runFinalPass(
  readers: WorktreeReaders,
  context: RepositoryContext,
  limits: Limits,
  head: string | undefined,
  first: FirstPass,
  observations: readonly PathObservation[],
): StabilityResult {
  // Ignore sources first: a source swapped for a FIFO or a huge file must be
  // caught by our own bounded read before any git listing reads it.
  const sources = verifyIgnoreSourcesUnchanged(
    readers.runner,
    context,
    limits,
    first,
  )
  if (sources.status === 'error') return sources
  const unchanged = verifyObservationsUnchanged(readers, observations)
  if (unchanged.status === 'error') return unchanged
  const listings = verifyListingsUnchanged(
    readers.runner,
    context,
    limits,
    first,
  )
  if (listings.status === 'error') return listings
  return verifyHeadUnchanged(readers.runner, context, limits, head)
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
  let result: OperationObserverCommandResult
  try {
    result = runner(
      ['config', '--type=path', '--get', 'core.excludesFile'],
      context.commandDirectory,
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const resultError = commandResultError(result, limits)
  if (resultError) return { status: 'error', reasonCode: resultError }
  // Exit 1 means the key is unset.
  if (result.status === 1) {
    return { status: 'ok', filePath: defaultExcludesFilePath() }
  }
  if (result.status !== 0) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const configured = result.stdout.replace(/\n$/, '')
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
  hash.update('ignore-source\0')
  hash.update(fact.label)
  hash.update('\0')
  hash.update(fact.content === undefined ? 'absent' : 'present')
  hash.update('\0')
  if (fact.content !== undefined) hash.update(fact.content)
  hash.update('\0')
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
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id) ||
      outputBytes(entryPath) > limits.maxPathBytes
    ) {
      return { status: 'error', reasonCode: 'file-read-failed' }
    }
    entries.set(entryPath, { mode, id })
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
  readonly first: Omit<FirstPass, 'ignoreSources'>
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
  const tracked = runCommand(
    runner,
    ['ls-files', '--full-name', '-z', '--', ':/'],
    context.commandDirectory,
    limits,
  )
  if (tracked.status === 'error') return tracked
  const staged = runCommand(
    runner,
    ['ls-files', '--stage', '--full-name', '-z', '--', ':/'],
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
  const stageEntries = parseStageEntries(
    staged.output.stdout,
    limits.maxPathBytes,
  )
  if (!stageEntries) return { status: 'error', reasonCode: 'file-read-failed' }
  // A trailing slash marks a wholly ignored directory, whose contents are
  // ignored and so stay out of the identity.
  const selfIgnored = splitRecords(ignoredGitignores.output.stdout).filter(
    (entry) => !entry.endsWith('/'),
  )
  const paths = [
    ...new Set([
      ...splitRecords(tracked.output.stdout),
      ...headTree.keys(),
      ...splitRecords(untracked.output.stdout),
      ...selfIgnored,
    ]),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  return {
    status: 'ok',
    first: {
      staged: staged.output.stdout,
      untracked: untracked.output.stdout,
      ignoredGitignores: ignoredGitignores.output.stdout,
    },
    stageEntries,
    paths,
  }
}

function readWorktreeRevisionV2(
  readers: WorktreeReaders,
  context: RepositoryContext,
  head: string | undefined,
  limits: Limits,
):
  | {
      status: 'ok'
      digest: string
      records: readonly WorktreeRecord[]
      /** The `HEAD` tree by path, for the commit closure. Empty when unborn. */
      headTree: ReadonlyMap<string, HeadTreeEntry>
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
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
    ...listings.stageEntries.map((entry) => entry.record.split(' ')[1] ?? ''),
  ])
  if (format === undefined) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  const { paths } = listings
  if (paths.length > limits.maxFiles) {
    return { status: 'error', reasonCode: 'file-limit' }
  }
  const modes = new Map(
    listings.stageEntries.map((entry) => [entry.relativePath, entry.mode]),
  )
  const hash = createHash('sha256')
  hash.update(WORKTREE_DIGEST_DOMAIN)
  const budget: SnapshotBudget = { files: 0, bytes: 0, gitlinks: 0 }
  const observations: PathObservation[] = []
  for (const relativePath of paths) {
    const result = appendFileFactV2(
      hash,
      readers,
      context,
      {
        relativePath,
        // Index first, then the HEAD tree; empty means not tracked at all.
        mode:
          modes.get(relativePath) ?? tree.entries.get(relativePath)?.mode ?? '',
      },
      limits,
      budget,
      format,
    )
    if (result.status === 'error') return result
    budget.files += 1
    observations.push(result.observation)
  }
  for (const fact of sources.facts) hashIgnoreSource(hash, fact)
  const stable = runFinalPass(
    readers,
    context,
    limits,
    head,
    { ...listings.first, ignoreSources: sources.facts },
    observations,
  )
  if (stable.status === 'error') return stable
  return {
    status: 'ok',
    digest: hash.digest('hex'),
    records: observations.map((observation) => observation.record),
    headTree: tree.entries,
  }
}

function readCommitClosure(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
  limits: Limits,
):
  | { status: 'ok'; closed: boolean }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  let diff: OperationObserverCommandResult
  try {
    diff = runner(
      ['diff', '--quiet', 'HEAD', '--', ':/'],
      context.commandDirectory,
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const diffError = commandResultError(diff, limits)
  if (diffError) return { status: 'error', reasonCode: diffError }
  if (diff.status !== 0 && diff.status !== 1) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  const untracked = runCommand(
    runner,
    UNTRACKED_FILES_ARGS,
    context.commandDirectory,
    limits,
  )
  if (untracked.status === 'error') return untracked
  return {
    status: 'ok',
    closed: diff.status === 0 && untracked.output.stdout.length === 0,
  }
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
    'fileReader' | 'symlinkReader' | 'statReader'
  >,
): WorktreeReaders {
  return {
    runner,
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
    }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const limits = mergeLimits(options.limits)
  const realPath = options.realPath ?? fs.realpathSync
  const runner = withForcedGitPrefix(
    options.commandRunner ?? defaultCommandRunner,
  )
  const anchor = readRepositoryAnchor(runner, targetDirectory, limits, realPath)
  if (anchor.status === 'error') return anchor
  return readWorktreeRevisionV2(
    resolveWorktreeReaders(runner, options),
    {
      commandDirectory: targetDirectory,
      worktreeRoot: anchor.toplevel,
      infoExcludePath: anchor.infoExcludePath,
    },
    anchor.head,
    limits,
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
        anchor.gitDir !== rootPinResult.pin.gitDir
      ) {
        return { status: 'unavailable', reasonCode: 'target-unavailable' }
      }
      const context: RepositoryContext = {
        commandDirectory: targetDirectory,
        worktreeRoot: anchor.toplevel,
        infoExcludePath: anchor.infoExcludePath,
      }
      const repository = readRevision(runner, context, anchor.head, limits)
      if (repository.status === 'error') return unavailable(repository)
      const worktree = readWorktreeRevisionV2(
        readers,
        context,
        anchor.head,
        limits,
      )
      if (worktree.status === 'error') return unavailable(worktree)
      const closure = readCommitClosure(runner, context, limits)
      if (closure.status === 'error') return unavailable(closure)
      return {
        status: 'available',
        snapshot: {
          targetDigest,
          repositoryRevisionDigest: repository.digest,
          worktreeRevisionDigest: worktree.digest,
          commitClosure: closure.closed,
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
