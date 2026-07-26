import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_LIMITS = {
  maxCommandOutputBytes: 1_048_576,
  maxFiles: 4096,
  maxTotalFileBytes: 16_777_216,
  maxPathBytes: 4096,
} as const

export type OperationObserverReasonCode =
  | 'target-unavailable'
  | 'command-failed'
  | 'command-output-limit'
  | 'file-limit'
  | 'file-output-limit'
  | 'file-read-failed'

export interface OperationObserverSnapshot {
  readonly targetDigest: string
  readonly repositoryRevisionDigest: string
  readonly worktreeRevisionDigest: string
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
}

export type OperationObserverCommandRunner = (
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
) => OperationObserverCommandResult

export interface OperationObserverLimits {
  readonly maxCommandOutputBytes?: number
  readonly maxFiles?: number
  readonly maxTotalFileBytes?: number
  readonly maxPathBytes?: number
}

export interface OpencodeOperationObserverOptions {
  readonly targetDirectory: string
  readonly commandRunner?: OperationObserverCommandRunner
  readonly fileReader?: (filePath: string) => Uint8Array
  readonly symlinkReader?: (filePath: string) => string
  readonly realPath?: (filePath: string) => string
  readonly limits?: OperationObserverLimits
}

export interface OpencodeOperationObserver {
  readonly targetDigest: string
  snapshot(): Promise<OperationObserverResult>
}

interface Limits {
  readonly maxCommandOutputBytes: number
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

function defaultCommandRunner(
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
): OperationObserverCommandResult {
  try {
    const result = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
    })
    return {
      status: result.status ?? -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
  } catch {
    return { status: -1, stdout: '', stderr: '' }
  }
}

function mergeLimits(input?: OperationObserverLimits): Limits {
  return {
    maxCommandOutputBytes:
      input?.maxCommandOutputBytes ?? DEFAULT_LIMITS.maxCommandOutputBytes,
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
  const result = runner(args, cwd, limits.maxCommandOutputBytes)
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
  root: string,
  limits: Limits,
):
  | { status: 'ok'; digest: string }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const branch = runCommand(
    runner,
    ['symbolic-ref', '--short', 'HEAD'],
    root,
    limits,
  )
  if (branch.status === 'error' && branch.reasonCode !== 'command-failed') {
    return branch
  }
  const branchValue =
    branch.status === 'ok' ? branch.output.stdout.trim() : 'detached'

  const head = runner(
    ['rev-parse', '--verify', 'HEAD'],
    root,
    limits.maxCommandOutputBytes,
  )
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
    root,
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

function appendFileFact(
  hash: ReturnType<typeof createHash>,
  fileReader: (filePath: string) => Uint8Array,
  symlinkReader: (filePath: string) => string,
  root: string,
  entry: Pick<StageEntry, 'mode' | 'relativePath'>,
  limits: Limits,
  totalBytes: number,
):
  | { status: 'ok'; totalBytes: number }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const { mode, relativePath } = entry
  const absolutePath = safePath(root, relativePath)
  if (!absolutePath || outputBytes(relativePath) > limits.maxPathBytes) {
    return { status: 'error', reasonCode: 'file-read-failed' }
  }
  if (mode === '120000') {
    let linkTarget: string
    try {
      linkTarget = symlinkReader(absolutePath)
    } catch {
      hash.update('deleted\0')
      hash.update(relativePath)
      hash.update('\0')
      return { status: 'ok', totalBytes }
    }
    const linkBytes = Buffer.byteLength(linkTarget, 'utf8')
    if (linkBytes > limits.maxPathBytes) {
      return { status: 'error', reasonCode: 'file-output-limit' }
    }
    const nextTotalBytes = totalBytes + linkBytes
    if (nextTotalBytes > limits.maxTotalFileBytes) {
      return { status: 'error', reasonCode: 'file-output-limit' }
    }
    const linkContentDigest = createHash('sha256')
      .update(linkTarget)
      .digest('hex')
    hash.update('symlink\0')
    hash.update(relativePath)
    hash.update('\0')
    hash.update(linkContentDigest)
    hash.update('\0')
    return { status: 'ok', totalBytes: nextTotalBytes }
  }
  let content: Uint8Array
  try {
    content = fileReader(absolutePath)
  } catch {
    if (mode === '160000') return { status: 'ok', totalBytes }
    hash.update('deleted\0')
    hash.update(relativePath)
    hash.update('\0')
    return { status: 'ok', totalBytes }
  }
  const nextTotalBytes = totalBytes + content.byteLength
  if (nextTotalBytes > limits.maxTotalFileBytes) {
    return { status: 'error', reasonCode: 'file-output-limit' }
  }
  const contentDigest = createHash('sha256').update(content).digest('hex')
  hash.update(mode === '' ? 'untracked\0' : 'tracked\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update(contentDigest)
  hash.update('\0')
  return { status: 'ok', totalBytes: nextTotalBytes }
}

function readWorktreeRevision(
  runner: OperationObserverCommandRunner,
  fileReader: (filePath: string) => Uint8Array,
  symlinkReader: (filePath: string) => string,
  root: string,
  limits: Limits,
):
  | { status: 'ok'; digest: string }
  | { status: 'error'; reasonCode: OperationObserverReasonCode } {
  const staged = runCommand(runner, ['ls-files', '--stage', '-z'], root, limits)
  if (staged.status === 'error') return staged
  const untracked = runCommand(
    runner,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    root,
    limits,
  )
  if (untracked.status === 'error') return untracked
  const stageEntries = parseStageEntries(
    staged.output.stdout,
    limits.maxPathBytes,
  )
  if (!stageEntries) return { status: 'error', reasonCode: 'file-read-failed' }
  const untrackedPaths = splitRecords(untracked.output.stdout).sort()
  if (stageEntries.length + untrackedPaths.length > limits.maxFiles) {
    return { status: 'error', reasonCode: 'file-limit' }
  }

  const hash = createHash('sha256')
  hash.update('systematic:opencode-observer:worktree:v1\0')
  for (const entry of stageEntries) {
    hash.update('index\0')
    hash.update(entry.record)
    hash.update('\0')
  }

  let totalBytes = 0
  const entries = [
    ...stageEntries,
    ...untrackedPaths.map((relativePath) => ({ relativePath, mode: '' })),
  ]
  for (const entry of entries) {
    const fileResult = appendFileFact(
      hash,
      fileReader,
      symlinkReader,
      root,
      entry,
      limits,
      totalBytes,
    )
    if (fileResult.status === 'error') return fileResult
    totalBytes = fileResult.totalBytes
  }
  return { status: 'ok', digest: hash.digest('hex') }
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
  const fileReader = options.fileReader ?? fs.readFileSync
  const symlinkReader = options.symlinkReader ?? fs.readlinkSync

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
      const repository = readRevision(runner, root, limits)
      if (repository.status === 'error') return unavailable(repository)
      const worktree = readWorktreeRevision(
        runner,
        fileReader,
        symlinkReader,
        root,
        limits,
      )
      if (worktree.status === 'error') return unavailable(worktree)
      return {
        status: 'available',
        snapshot: {
          targetDigest,
          repositoryRevisionDigest: repository.digest,
          worktreeRevisionDigest: worktree.digest,
        },
      }
    },
  }
}
