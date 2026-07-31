import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_LIMITS = {
  maxCommandOutputBytes: 1_048_576,
  maxCommandTimeoutMs: 5_000,
  maxFiles: 4096,
  maxTotalFileBytes: 16_777_216,
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

export interface OperationObserverLimits {
  readonly maxCommandOutputBytes?: number
  readonly maxCommandTimeoutMs?: number
  readonly maxFiles?: number
  readonly maxTotalFileBytes?: number
  readonly maxPathBytes?: number
}

export interface OperationObserverFileStat {
  readonly isFile: boolean
  readonly isSymbolicLink: boolean
  readonly isDirectory: boolean
  readonly mode: number
  readonly size: number
}

export interface OpencodeOperationObserverOptions {
  readonly targetDirectory: string
  readonly commandRunner?: OperationObserverCommandRunner
  readonly remoteCommandRunner?: OperationObserverRemoteCommandRunner
  readonly fileReader?: (filePath: string) => Uint8Array
  readonly symlinkReader?: (filePath: string) => string
  readonly statReader?: (filePath: string) => OperationObserverFileStat
  readonly realPath?: (filePath: string) => string
  readonly limits?: OperationObserverLimits
}

export interface OpencodeOperationObserver {
  readonly targetDigest: string
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
}

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

function defaultCommandRunner(
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  timeoutMs: number,
): OperationObserverCommandResult {
  try {
    const result = spawnSync('git', [...args], {
      cwd,
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
  if (result.timedOut) {
    return { status: 'error', reasonCode: 'command-timeout' }
  }
  if (
    outputBytes(result.stdout) > limits.maxCommandOutputBytes ||
    outputBytes(result.stderr) > limits.maxCommandOutputBytes
  ) {
    return { status: 'error', reasonCode: 'command-output-limit' }
  }
  if (result.status !== 0) {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  return { status: 'ok', output: { stdout: result.stdout } }
}

function readRevision(
  runner: OperationObserverCommandRunner,
  context: RepositoryContext,
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

  let head: OperationObserverCommandResult
  try {
    head = runner(
      ['rev-parse', '--verify', 'HEAD'],
      context.commandDirectory,
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'command-failed' }
  }
  if (head.timedOut) {
    return { status: 'error', reasonCode: 'command-timeout' }
  }
  if (
    outputBytes(head.stdout) > limits.maxCommandOutputBytes ||
    outputBytes(head.stderr) > limits.maxCommandOutputBytes
  ) {
    return { status: 'error', reasonCode: 'command-output-limit' }
  }
  const headValue = head.status === 0 ? head.stdout.trim() : 'unborn'
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
      headValue,
      branchValue,
      inside.output.stdout.trim(),
    ]),
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function appendSubmoduleFact(
  hash: ReturnType<typeof createHash>,
  runner: OperationObserverCommandRunner,
  submodulePath: string,
  relativePath: string,
  limits: Limits,
  totalBytes: number,
):
  | { status: 'ok'; totalBytes: number }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
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
  return { status: 'ok', totalBytes }
}

function appendSymlinkFact(
  hash: ReturnType<typeof createHash>,
  symlinkReader: (filePath: string) => string,
  absolutePath: string,
  relativePath: string,
  limits: Limits,
  totalBytes: number,
):
  | { status: 'ok'; totalBytes: number }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  let target: string
  try {
    target = symlinkReader(absolutePath)
  } catch (error) {
    return isEnoent(error)
      ? { status: 'ok', totalBytes }
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  const targetBytes = Buffer.from(target, 'utf8')
  const nextTotalBytes = totalBytes + targetBytes.byteLength
  if (
    targetBytes.byteLength > limits.maxPathBytes ||
    nextTotalBytes > limits.maxTotalFileBytes
  ) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  hash.update('symlink\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update(targetBytes)
  hash.update('\0')
  return { status: 'ok', totalBytes: nextTotalBytes }
}

function appendRegularFact(
  hash: ReturnType<typeof createHash>,
  fileReader: (filePath: string) => Uint8Array,
  absolutePath: string,
  relativePath: string,
  stat: OperationObserverFileStat,
  limits: Limits,
  totalBytes: number,
):
  | { status: 'ok'; totalBytes: number }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  if (!stat.isFile || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  if (totalBytes + stat.size > limits.maxTotalFileBytes) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  let content: Uint8Array
  try {
    content = fileReader(absolutePath)
  } catch (error) {
    return isEnoent(error)
      ? { status: 'ok', totalBytes }
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  if (totalBytes + content.byteLength > limits.maxTotalFileBytes) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  hash.update('regular\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update((stat.mode & 0o111) !== 0 ? 'executable\0' : 'non-executable\0')
  hash.update(content)
  hash.update('\0')
  return { status: 'ok', totalBytes: totalBytes + content.byteLength }
}

function appendFileFactV2(
  hash: ReturnType<typeof createHash>,
  runner: OperationObserverCommandRunner,
  fileReader: (filePath: string) => Uint8Array,
  symlinkReader: (filePath: string) => string,
  statReader: (filePath: string) => OperationObserverFileStat,
  context: RepositoryContext,
  entry: Pick<StageEntry, 'mode' | 'relativePath'>,
  limits: Limits,
  totalBytes: number,
):
  | { status: 'ok'; totalBytes: number }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const { mode, relativePath } = entry
  const absolutePath = safePath(context.worktreeRoot, relativePath)
  if (!absolutePath || outputBytes(relativePath) > limits.maxPathBytes) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  let stat: OperationObserverFileStat
  try {
    stat = statReader(absolutePath)
  } catch (error) {
    return isEnoent(error)
      ? { status: 'ok', totalBytes }
      : { status: 'error', reasonCode: 'file-read-failed' }
  }
  if (mode === '160000')
    return appendSubmoduleFact(
      hash,
      runner,
      absolutePath,
      relativePath,
      limits,
      totalBytes,
    )
  if (stat.isSymbolicLink) {
    return appendSymlinkFact(
      hash,
      symlinkReader,
      absolutePath,
      relativePath,
      limits,
      totalBytes,
    )
  }
  return appendRegularFact(
    hash,
    fileReader,
    absolutePath,
    relativePath,
    stat,
    limits,
    totalBytes,
  )
}

function readWorktreeRevisionV2(
  runner: OperationObserverCommandRunner,
  fileReader: (filePath: string) => Uint8Array,
  symlinkReader: (filePath: string) => string,
  statReader: (filePath: string) => OperationObserverFileStat,
  context: RepositoryContext,
  limits: Limits,
):
  | { status: 'ok'; digest: string }
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
  const stageEntries = parseStageEntries(
    staged.output.stdout,
    limits.maxPathBytes,
  )
  if (!stageEntries) return { status: 'error', reasonCode: 'file-read-failed' }
  const modes = new Map(
    stageEntries.map((entry) => [entry.relativePath, entry.mode]),
  )
  const paths = [
    ...new Set([
      ...splitRecords(tracked.output.stdout),
      ...splitRecords(untracked.output.stdout),
    ]),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (paths.length > limits.maxFiles) {
    return { status: 'error', reasonCode: 'file-limit' }
  }
  const hash = createHash('sha256')
  hash.update('systematic:opencode-observer:worktree:v2\0')
  let totalBytes = 0
  for (const relativePath of paths) {
    const result = appendFileFactV2(
      hash,
      runner,
      fileReader,
      symlinkReader,
      statReader,
      context,
      { relativePath, mode: modes.get(relativePath) ?? '' },
      limits,
      totalBytes,
    )
    if (result.status === 'error') return result
    totalBytes = result.totalBytes
  }
  return { status: 'ok', digest: hash.digest('hex') }
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
  if (diff.timedOut) {
    return { status: 'error', reasonCode: 'command-timeout' }
  }
  if (
    outputBytes(diff.stdout) > limits.maxCommandOutputBytes ||
    outputBytes(diff.stderr) > limits.maxCommandOutputBytes
  ) {
    return { status: 'error', reasonCode: 'command-output-limit' }
  }
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
      limits.maxCommandOutputBytes,
      limits.maxCommandTimeoutMs,
    )
  } catch {
    return { status: 'error', reasonCode: 'remote-command-failed' }
  }
  if (result.timedOut) {
    return { status: 'error', reasonCode: 'command-timeout' }
  }
  if (
    outputBytes(result.stdout) > limits.maxCommandOutputBytes ||
    outputBytes(result.stderr) > limits.maxCommandOutputBytes
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
    Object.keys(record).length > limits.maxFiles
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
    value.length > limits.maxFiles
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
  const targetDigest = digest('target', [targetDirectory])
  const runner = options.commandRunner ?? defaultCommandRunner
  const remoteRunner = options.remoteCommandRunner ?? defaultRemoteCommandRunner
  const fileReader = options.fileReader ?? fs.readFileSync
  const symlinkReader = options.symlinkReader ?? fs.readlinkSync
  const statReader =
    options.statReader ??
    ((filePath: string): OperationObserverFileStat => {
      const stat = fs.lstatSync(filePath)
      return {
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        isDirectory: stat.isDirectory(),
        mode: stat.mode,
        size: stat.size,
      }
    })

  return {
    targetDigest,
    async snapshot(): Promise<OperationObserverResult> {
      const rootResult = runCommand(
        runner,
        ['rev-parse', '--show-toplevel'],
        targetDirectory,
        limits,
      )
      if (rootResult.status === 'error') return unavailable(rootResult)
      const root = rootResult.output.stdout.trim()
      if (root.length === 0 || outputBytes(root) > limits.maxPathBytes) {
        return { status: 'unavailable', reasonCode: 'target-unavailable' }
      }
      const context: RepositoryContext = {
        commandDirectory: targetDirectory,
        worktreeRoot: root,
      }
      const repository = readRevision(runner, context, limits)
      if (repository.status === 'error') return unavailable(repository)
      const worktree = readWorktreeRevisionV2(
        runner,
        fileReader,
        symlinkReader,
        statReader,
        context,
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
