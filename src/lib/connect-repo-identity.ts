/**
 * The portable identity of a checkout for `ce:connect`: `owner/repo` of its
 * GitHub `origin` remote and the commit its HEAD names. A run record that
 * carries both can be matched to another machine's checkout of the same
 * project after the run's own paths are gone.
 *
 * Reads files under `.git/` only, through the contained reader (no symlink is
 * followed, every read is bounded). No git process and no network is used, and
 * nothing in a remote URL except the validated `owner/repo` is ever returned,
 * so credentials in a URL cannot reach a record. Import rule: node builtins
 * and `connect-evidence.ts` only, because the `ce:connect` helper bundles it.
 * Never throws: anything unreadable, unexpected or not GitHub is absent.
 */

import { readContainedFile } from './connect-evidence.js'

const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_HEAD_BYTES = 4096
const MAX_REF_BYTES = 4096
const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024

export interface RepoIdentity {
  /** Lowercase `owner/repo` of the GitHub `origin` remote. */
  readonly repo?: string
  /** The full hash HEAD names. */
  readonly commit?: string
}

// ── The remote ──────────────────────────────────────────────────────────────

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const HTTPS_FORM = /^https:\/\/(?:[^/@\s]*@)?github\.com\/(\S+)$/i
const SSH_URL_FORM = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?github\.com\/(\S+)$/i
const SCP_FORM = /^(?:[A-Za-z0-9._-]+@)?github\.com:(\S+)$/i

function ownerAndRepo(pathPart: string): string | undefined {
  const segments = pathPart.replace(/\/+$/, '').split('/')
  if (segments.length !== 2) return undefined
  const [owner = '', named = ''] = segments
  const repo = named.endsWith('.git') ? named.slice(0, -'.git'.length) : named
  if (!OWNER.test(owner) || !REPO.test(repo)) return undefined
  if (repo === '.' || repo === '..') return undefined
  return `${owner}/${repo}`.toLowerCase()
}

/**
 * `owner/repo` of a GitHub remote URL, lowercase, or nothing. Three forms are
 * read: an https URL, `git@github.com:o/r` and an `ssh://` URL, each with or
 * without `.git` and a trailing slash. Another host, a port, a query, a
 * fragment or a local path is not GitHub here. Userinfo is dropped and never
 * returned.
 */
export function normalizeGithubRemote(url: string): string | undefined {
  const match =
    HTTPS_FORM.exec(url) ?? SSH_URL_FORM.exec(url) ?? SCP_FORM.exec(url)
  const rest = match?.[1]
  return rest === undefined ? undefined : ownerAndRepo(rest)
}

/** A git config value: quotes group text, an unquoted `#` or `;` starts a comment. */
function configValue(raw: string): string {
  let out = ''
  let quoted = false
  for (const ch of raw.trim()) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && (ch === '#' || ch === ';')) break
    out += ch
  }
  return out.trim()
}

/** Whether a section header's text is the origin remote: the section name ignores case, the subsection does not. */
function isOriginSection(header: string): boolean {
  const match = /^([A-Za-z]+)[ \t]+"([^"]*)"$/.exec(header.trim())
  return match?.[1]?.toLowerCase() === 'remote' && match[2] === 'origin'
}

/** The first `url` of the origin remote in the git config text. Includes are not followed. */
function originUrl(config: string): string | undefined {
  let inOrigin = false
  for (const raw of config.split('\n')) {
    let line = raw.trim()
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end === -1) {
        inOrigin = false
        continue
      }
      inOrigin = isOriginSection(line.slice(1, end))
      line = line.slice(end + 1).trim()
    }
    if (!inOrigin) continue
    const key = /^url[ \t]*=(.*)$/i.exec(line)
    if (key?.[1] !== undefined) return configValue(key[1])
  }
  return undefined
}

// ── HEAD ────────────────────────────────────────────────────────────────────

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REF_NAME = /^refs\/[A-Za-z0-9._/-]+$/

function readGitText(
  mainRoot: string,
  rel: string,
  maxBytes: number,
): string | undefined {
  const read = readContainedFile(mainRoot, rel, { maxBytes })
  return read.kind === 'bytes' ? read.bytes.toString('utf8') : undefined
}

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').replace(/\r$/, '').trim()
}

function safeRefName(ref: string): boolean {
  return (
    REF_NAME.test(ref) &&
    ref
      .split('/')
      .every(
        (part) =>
          part !== '' && !part.startsWith('.') && !part.endsWith('.lock'),
      )
  )
}

function packedRef(packed: string, ref: string): string | undefined {
  for (const raw of packed.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('^')) continue
    const [id, name, ...rest] = line.split(/\s+/)
    if (rest.length === 0 && name === ref && OBJECT_ID.test(id ?? '')) return id
  }
  return undefined
}

/** The hash HEAD names: a detached hash itself, or a branch through its loose ref and then `packed-refs`. */
function headCommit(mainRoot: string): string | undefined {
  const head = readGitText(mainRoot, '.git/HEAD', MAX_HEAD_BYTES)
  if (head === undefined) return undefined
  const line = firstLine(head)
  if (OBJECT_ID.test(line)) return line
  const symbolic = /^ref:[ \t]*(\S+)$/.exec(line)?.[1]
  if (symbolic === undefined || !safeRefName(symbolic)) return undefined

  const loose = readGitText(mainRoot, `.git/${symbolic}`, MAX_REF_BYTES)
  const looseId = loose === undefined ? '' : firstLine(loose)
  if (OBJECT_ID.test(looseId)) return looseId
  const packed = readGitText(
    mainRoot,
    '.git/packed-refs',
    MAX_PACKED_REFS_BYTES,
  )
  return packed === undefined ? undefined : packedRef(packed, symbolic)
}

// ── Entry ───────────────────────────────────────────────────────────────────

/**
 * The repository identity of the checkout whose main root is `mainRoot`. A
 * root whose `.git` is not a real directory (a linked worktree, a submodule, a
 * symlink) has neither field.
 */
export function readRepoIdentity(mainRoot: string): RepoIdentity {
  try {
    const config = readGitText(mainRoot, '.git/config', MAX_CONFIG_BYTES)
    const url = config === undefined ? undefined : originUrl(config)
    const repo = url === undefined ? undefined : normalizeGithubRemote(url)
    const commit = headCommit(mainRoot)
    return {
      ...(repo === undefined ? {} : { repo }),
      ...(commit === undefined ? {} : { commit }),
    }
  } catch {
    return {}
  }
}
