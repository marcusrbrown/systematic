/**
 * Project identity for external search sources: the main repository root of a
 * checkout, derived by filesystem reads alone, and the exact-path allow match.
 *
 * Imports node builtins only, because the `systematic-search` bin bundles it.
 * Never throws: anything corrupt, inconsistent or unreadable is `unresolved`,
 * and an unresolved identity matches no allow entry.
 *
 * A linked worktree is verified from the common-directory side. The `.git`
 * file is attacker-writable (it ships inside a cloned project), so it is only
 * a claim: the claimed gitdir must be `<commondir>/worktrees/<name>`, and that
 * entry's own `gitdir` back-pointer must name this exact `.git`. A forged
 * `.git` cannot satisfy both, because the real common directory's entries
 * point at the real worktrees.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Largest identity file read (`.git` file, `commondir`, back-pointer, `config`). */
const MAX_IDENTITY_FILE_BYTES = 1024 * 1024

export type UnresolvedReason =
  | 'not-a-checkout'
  | 'symlinked-git'
  | 'corrupt-git-file'
  | 'unsupported-layout'
  | 'missing-commondir'
  | 'inconsistent'
  | 'core-worktree'
  | 'unreadable'

export type ProjectIdentity =
  | { readonly status: 'resolved'; readonly mainRoot: string }
  | { readonly status: 'unresolved'; readonly reason: UnresolvedReason }

export interface AllowMatchOptions {
  /** Home directory for `~` entries. Defaults to `os.homedir()`. */
  readonly homeDir?: string
}

type Derivation =
  | { readonly root: string }
  | { readonly reason: UnresolvedReason }

function realpath(target: string): string {
  return fs.realpathSync.native(target)
}

/** Reads a small text file; a larger file is refused rather than truncated. */
function readSmallFile(file: string): string {
  if (fs.statSync(file).size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error(`${path.basename(file)} exceeds the identity read cap`)
  }
  return fs.readFileSync(file, 'utf8')
}

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').replace(/\r$/, '').trim()
}

/** Resolves `value` against `base` unless it is already absolute. */
function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value)
}

/**
 * Whether the git config text sets `core.worktree`. A pure text read: section
 * and key names are case-insensitive, other sections are ignored, and
 * `include` directives are not followed.
 */
function setsCoreWorktree(config: string): boolean {
  let inCore = false
  for (const raw of config.split('\n')) {
    let line = raw.trim()
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end === -1) {
        inCore = false
        continue
      }
      inCore = line.slice(1, end).trim().toLowerCase() === 'core'
      line = line.slice(end + 1).trim()
    }
    if (inCore && /^worktree\s*(=|$)/i.test(line)) {
      return true
    }
  }
  return false
}

function isSubmoduleGitdir(gitdir: string): boolean {
  return gitdir.split(path.sep).includes('modules')
}

function resolveLinkedWorktree(gitFile: string, gitdir: string): Derivation {
  const commonFile = path.join(gitdir, 'commondir')
  if (!fs.existsSync(commonFile)) {
    return { reason: 'missing-commondir' }
  }
  const commonRaw = firstLine(readSmallFile(commonFile))
  if (commonRaw === '') {
    return { reason: 'corrupt-git-file' }
  }
  const common = realpath(resolveFrom(gitdir, commonRaw))

  // The claimed gitdir must be exactly `<commondir>/worktrees/<name>`.
  if (gitdir !== path.join(common, 'worktrees', path.basename(gitdir))) {
    return { reason: 'inconsistent' }
  }

  // The common directory's own entry must point back at this `.git`. The
  // back-pointer is relative to its own directory when git wrote it with
  // worktree.useRelativePaths.
  const backRaw = firstLine(readSmallFile(path.join(gitdir, 'gitdir')))
  if (backRaw === '') {
    return { reason: 'corrupt-git-file' }
  }
  if (realpath(resolveFrom(gitdir, backRaw)) !== realpath(gitFile)) {
    return { reason: 'inconsistent' }
  }

  // A bare repository or a separate git directory has no main work tree.
  if (path.basename(common) !== '.git') {
    return { reason: 'unsupported-layout' }
  }
  if (setsCoreWorktree(readSmallFile(path.join(common, 'config')))) {
    return { reason: 'core-worktree' }
  }
  return { root: path.dirname(common) }
}

function deriveMainRoot(checkoutRoot: string): Derivation {
  const root = realpath(checkoutRoot)
  const gitPath = path.join(root, '.git')

  // lstat, not stat: a `.git` symlink to a real worktree's `.git` file would
  // otherwise pass the back-pointer comparison, which is by realpath.
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(gitPath)
  } catch {
    return { reason: 'not-a-checkout' }
  }
  if (stat.isSymbolicLink()) {
    return { reason: 'symlinked-git' }
  }
  if (stat.isDirectory()) {
    return { root }
  }
  if (!stat.isFile()) {
    return { reason: 'corrupt-git-file' }
  }

  const match = /^gitdir:[ \t]*(.+)$/.exec(firstLine(readSmallFile(gitPath)))
  const claimed = match?.[1]?.trim()
  if (claimed === undefined || claimed === '') {
    return { reason: 'corrupt-git-file' }
  }
  const gitdir = realpath(resolveFrom(root, claimed))
  if (!fs.statSync(gitdir).isDirectory()) {
    return { reason: 'corrupt-git-file' }
  }

  // Check `worktrees/` first: a worktree of a submodule also sits under
  // `modules/`, and must not be mistaken for the submodule itself.
  if (path.basename(path.dirname(gitdir)) === 'worktrees') {
    return resolveLinkedWorktree(gitPath, gitdir)
  }
  if (isSubmoduleGitdir(gitdir)) {
    return { root }
  }
  return { reason: 'unsupported-layout' }
}

/**
 * The main repository root of `checkoutRoot` (the checkout root that
 * `resolveSearchRoot` returns), as a realpath, or `unresolved` with a reason.
 * A linked worktree maps to its main checkout; a submodule and a nested repo
 * are their own projects.
 */
export function resolveProjectIdentity(checkoutRoot: string): ProjectIdentity {
  try {
    const derived = deriveMainRoot(checkoutRoot)
    return 'root' in derived
      ? { status: 'resolved', mainRoot: derived.root }
      : { status: 'unresolved', reason: derived.reason }
  } catch {
    return { status: 'unresolved', reason: 'unreadable' }
  }
}

function expandHome(entry: string, homeDir: string): string | undefined {
  if (entry === '~') {
    return homeDir
  }
  if (entry.startsWith('~/') || entry.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, entry.slice(2))
  }
  return entry
}

/**
 * Whether the identity's main root equals one allow entry. Entries are
 * absolute or `~`-prefixed; both sides are compared as realpaths, exactly, so
 * a parent or child never matches. A stale entry, a relative entry or a bad
 * entry is a silent non-match, and an unresolved identity matches nothing.
 */
export function isAllowedProject(
  identity: ProjectIdentity,
  allowList: readonly string[],
  options: AllowMatchOptions = {},
): boolean {
  if (identity.status !== 'resolved') {
    return false
  }
  let mainRoot: string
  try {
    mainRoot = realpath(identity.mainRoot)
  } catch {
    return false
  }
  const homeDir = options.homeDir ?? os.homedir()
  for (const entry of allowList) {
    if (typeof entry !== 'string' || entry === '') {
      continue
    }
    const expanded = expandHome(entry, homeDir)
    if (expanded === undefined || !path.isAbsolute(expanded)) {
      continue
    }
    try {
      if (realpath(expanded) === mainRoot) {
        return true
      }
    } catch {
      // Stale entry: silent non-match.
    }
  }
  return false
}
