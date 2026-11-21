/**
 * The portable identity of a checkout for `ce:connect`: `owner/repo` of its
 * GitHub `origin` remote and the commit its HEAD names. A run record that
 * carries both can be matched to another machine's checkout of the same
 * project after the run's own paths are gone.
 *
 * Reads files under `.git/` only, through the contained reader (no symlink is
 * followed, every read is bounded). No git process and no network is used, and
 * nothing in a remote URL except the validated `owner/repo` is ever returned,
 * so credentials in a URL cannot reach a record. Import rule: node builtins,
 * `connect-evidence.ts` and `connect-config.ts` only, because the `ce:connect`
 * helper bundles it. Never throws: anything unreadable, unexpected or not GitHub is absent.
 *
 * `readTagAtHead` adds the tag a checkout's HEAD sits on, read from loose refs,
 * `packed-refs` and loose tag objects only, with every walk and inflate bounded.
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { isGithubOwnerRepo } from './connect-config.js'
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

// `isGithubOwnerRepo` is defined in `connect-config.ts`, which the `connect.pins`
// guard needs and which this module's own imports already depend on, so the
// shape rule lives below both. It is re-exported so every caller keeps one name.
export { isGithubOwnerRepo }

const HTTPS_FORM = /^https:\/\/(?:[^/@\s]*@)?github\.com\/(\S+)$/i
const SSH_URL_FORM = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?github\.com\/(\S+)$/i
const SCP_FORM = /^(?:[A-Za-z0-9._-]+@)?github\.com:(\S+)$/i

function ownerAndRepo(pathPart: string): string | undefined {
  const segments = pathPart.replace(/\/+$/, '').split('/')
  if (segments.length !== 2) return undefined
  const [owner = '', named = ''] = segments
  const repo = named.endsWith('.git') ? named.slice(0, -'.git'.length) : named
  const slug = `${owner}/${repo}`
  return isGithubOwnerRepo(slug) ? slug.toLowerCase() : undefined
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
// `+` is a legal git ref character (a tag such as `v1.2.3+build`); it is not
// a path separator or a traversal character, so `safeRefName` stays safe.
const REF_NAME = /^refs\/[A-Za-z0-9._+/-]+$/

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

// ── The tag at HEAD ─────────────────────────────────────────────────────────

/** The most `refs/tags` entries (files and directories) one walk visits. */
const MAX_TAG_ENTRIES = 1024
/** The deepest directory nesting below `refs/tags` that the walk enters. */
const MAX_TAG_DEPTH = 8
/** The most `refs/tags` lines read from `packed-refs`. */
const MAX_PACKED_TAG_LINES = 50_000
/** A loose object larger than this (compressed) is not read. */
const MAX_LOOSE_OBJECT_BYTES = 4096
/** The most one loose object may inflate to. A tag or commit header is far smaller. */
const MAX_INFLATED_OBJECT_BYTES = 8192
/** The most objects inflated for one checkout. */
const MAX_TAG_INFLATIONS = 16
/** The most bytes all inflations for one checkout may produce. */
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024

/**
 * A tag name that may be rendered: it starts alphanumeric, uses a short safe
 * charset and is at most 64 characters. A `/` is allowed because a tag such as
 * `release/1.2` is a real nested ref; nothing here can hold whitespace, a
 * control character or markup.
 */
export const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$/

export type TagAtHead =
  | { readonly kind: 'tag'; readonly name: string }
  | { readonly kind: 'unknown' }

const UNKNOWN_TAG: TagAtHead = { kind: 'unknown' }
const TAGS_PREFIX = 'refs/tags/'

type EntryKind = 'missing' | 'directory' | 'file' | 'other'

/** What `target` is, by `lstat`. A symlink and an unreadable entry are `other`. */
function entryKind(target: string): EntryKind {
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) return 'other'
    if (stat.isDirectory()) return 'directory'
    return stat.isFile() ? 'file' : 'other'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other'
  }
}

/** Whether `.git`, `.git/refs` and `.git/refs/tags` are real directories: yes, no, or absent below `.git`. */
function tagsDirectory(mainRoot: string): 'present' | 'absent' | 'unsafe' {
  const chain = ['.git', '.git/refs', '.git/refs/tags']
  for (const [index, rel] of chain.entries()) {
    const kind = entryKind(`${mainRoot}/${rel}`)
    if (kind === 'missing') return index === 0 ? 'unsafe' : 'absent'
    if (kind !== 'directory') return 'unsafe'
  }
  return 'present'
}

interface TagWalk {
  readonly root: string
  readonly names: string[]
  entries: number
}

/** One entry of a `refs/tags` directory: a file is recorded, a directory is entered, anything else fails the walk. */
function visitTagEntry(walk: TagWalk, rel: string, depth: number): boolean {
  if (!safeRefName(`${TAGS_PREFIX}${rel}`)) return false
  const kind = entryKind(`${walk.root}/.git/refs/tags/${rel}`)
  if (kind === 'file') {
    walk.names.push(rel)
    return true
  }
  return (
    kind === 'directory' &&
    depth < MAX_TAG_DEPTH &&
    walkTagDir(walk, rel, depth + 1)
  )
}

/** Lists `relDir` under `refs/tags` ('' is the root) into `walk`, within the entry and depth caps. */
function walkTagDir(walk: TagWalk, relDir: string, depth: number): boolean {
  const dir = fs.opendirSync(`${walk.root}/.git/refs/tags/${relDir}`)
  try {
    for (let next = dir.readSync(); next !== null; next = dir.readSync()) {
      walk.entries += 1
      if (walk.entries > MAX_TAG_ENTRIES) return false
      const rel = relDir === '' ? next.name : `${relDir}/${next.name}`
      if (!visitTagEntry(walk, rel, depth)) return false
    }
    return true
  } finally {
    dir.closeSync()
  }
}

/**
 * The names under `.git/refs/tags` as `a/b` paths, or undefined when the walk
 * cannot be trusted: `.git` is not a real directory, a symlink or a special
 * file is met, a name is unsafe, or a cap is passed. A missing `refs` or
 * `refs/tags` is an empty list, not a failure.
 */
function looseTagNames(mainRoot: string): string[] | undefined {
  const state = tagsDirectory(mainRoot)
  if (state === 'unsafe') return undefined
  if (state === 'absent') return []
  const walk: TagWalk = { root: mainRoot, names: [], entries: 0 }
  return walkTagDir(walk, '', 0) ? walk.names : undefined
}

interface InflateBudget {
  inflations: number
  bytes: number
}

const OBJECT_HEADER = /^(commit|tag|tree|blob) (\d{1,6})$/
const TAG_HEAD = /^object (\S+)\ntype (\S+)\n/

/**
 * Whether the loose object `id` is a tag that names `head` as a commit.
 * Undefined means it could not be read as a loose object: stored in a pack,
 * over its compressed cap, not zlib, over its inflate cap or budget,
 * malformed, or a tag that points at another tag.
 */
function looseObjectNamesHead(
  mainRoot: string,
  id: string,
  head: string,
  budget: InflateBudget,
): boolean | undefined {
  if (!OBJECT_ID.test(id)) return undefined
  const read = readContainedFile(
    mainRoot,
    `.git/objects/${id.slice(0, 2)}/${id.slice(2)}`,
    { maxBytes: MAX_LOOSE_OBJECT_BYTES },
  )
  if (read.kind !== 'bytes') return undefined
  const room = MAX_TOTAL_INFLATED_BYTES - budget.bytes
  if (budget.inflations >= MAX_TAG_INFLATIONS || room <= 0) return undefined
  budget.inflations += 1
  let raw: Buffer
  try {
    raw = zlib.inflateSync(read.bytes, {
      maxOutputLength: Math.min(MAX_INFLATED_OBJECT_BYTES, room),
    })
  } catch {
    return undefined
  }
  budget.bytes += raw.length

  const nul = raw.indexOf(0)
  if (nul < 1) return undefined
  const header = OBJECT_HEADER.exec(raw.subarray(0, nul).toString('latin1'))
  const type = header?.[1]
  if (type === undefined || Number(header?.[2]) !== raw.length - nul - 1) {
    return undefined
  }
  // A commit, tree or blob is not a tag object, so it cannot name HEAD as a
  // tagged commit; a lightweight tag on an older commit lands here.
  if (type !== 'tag') return false

  const body = TAG_HEAD.exec(raw.subarray(nul + 1).toString('utf8'))
  const target = body?.[1]
  const targetType = body?.[2]
  if (target === undefined || !OBJECT_ID.test(target)) return undefined
  if (targetType === 'commit') return target === head
  return targetType === 'tree' || targetType === 'blob' ? false : undefined
}

interface PackedTag {
  readonly name: string
  readonly id: string
  peeled?: string
}

/** The `packed-refs` tag line `line` describes, `none` for a line that is not a tag, `bad` for a tag line that cannot be trusted. */
function packedTagLine(line: string): PackedTag | 'none' | 'bad' {
  const [id = '', ref = '', ...rest] = line.split(/\s+/)
  if (!ref.startsWith(TAGS_PREFIX)) return 'none'
  if (rest.length > 0 || !OBJECT_ID.test(id) || !safeRefName(ref)) return 'bad'
  return { name: ref.slice(TAGS_PREFIX.length), id }
}

interface PackedScan {
  readonly tags: PackedTag[]
  /** The tag line just read, which a `^` line right after it peels. */
  last: PackedTag | undefined
}

/** Applies one `packed-refs` line to `scan`; false when the line cannot be trusted. */
function scanPackedLine(scan: PackedScan, line: string): boolean {
  if (line === '' || line.startsWith('#')) return true
  const { last } = scan
  scan.last = undefined
  if (line.startsWith('^')) {
    const peeled = line.slice(1)
    if (last === undefined) return true
    if (!OBJECT_ID.test(peeled)) return false
    last.peeled = peeled
    return true
  }
  const entry = packedTagLine(line)
  if (entry === 'none') return true
  if (entry === 'bad' || scan.tags.length >= MAX_PACKED_TAG_LINES) return false
  scan.tags.push(entry)
  scan.last = entry
  return true
}

interface PackedTags {
  readonly tags: PackedTag[]
  /** Git's own claim that a tag line with no `^` line is not an annotated tag. */
  readonly fullyPeeled: boolean
}

const NO_PACKED_TAGS: PackedTags = { tags: [], fullyPeeled: false }

/**
 * Whether the first line of `packed-refs` is a `# pack-refs with:` header that
 * lists `fully-peeled`. Git reads only the first line and splits its traits on
 * spaces (refs/packed-backend.c, `create_snapshot`): a header like that makes
 * a ref with no `^` line "not peelable", so a tag with none is not an
 * annotated tag. A file with no such header makes no claim.
 */
function isFullyPeeled(text: string): boolean {
  const [header = ''] = text.split('\n', 1)
  const traits = /^# pack-refs with: (.*)$/.exec(header)?.[1]
  return traits?.split(' ').includes('fully-peeled') ?? false
}

/** The tag lines of `packed-refs`, or undefined when the file or a tag line is unusable. A missing file has none. */
function packedTags(mainRoot: string): PackedTags | undefined {
  const read = readContainedFile(mainRoot, '.git/packed-refs', {
    maxBytes: MAX_PACKED_REFS_BYTES,
  })
  if (read.kind === 'refused') {
    return read.reason === 'missing' ? NO_PACKED_TAGS : undefined
  }
  const text = read.bytes.toString('utf8')
  const scan: PackedScan = { tags: [], last: undefined }
  for (const raw of text.split('\n')) {
    if (!scanPackedLine(scan, raw.trim())) return undefined
  }
  return { tags: scan.tags, fullyPeeled: isFullyPeeled(text) }
}

/** The loose tag names whose ref names HEAD directly or through a tag object, or undefined when any ref cannot be judged. */
function looseMatches(
  mainRoot: string,
  head: string,
  names: readonly string[],
  budget: InflateBudget,
): Set<string> | undefined {
  const matched = new Set<string>()
  for (const name of names) {
    const text = readGitText(
      mainRoot,
      `.git/${TAGS_PREFIX}${name}`,
      MAX_REF_BYTES,
    )
    const id = text === undefined ? '' : firstLine(text)
    if (!OBJECT_ID.test(id)) return undefined
    // A ref that names HEAD itself is a lightweight tag and needs no object.
    const names =
      id === head || looseObjectNamesHead(mainRoot, id, head, budget)
    if (names === undefined) return undefined
    if (names) matched.add(name)
  }
  return matched
}

/**
 * Whether a packed tag names `head`, directly or through a tag object.
 * Undefined means it cannot be told. An entry with no `^` line whose id is not
 * `head` may still be an annotated tag at `head` unless the file is fully
 * peeled, so its object is read under the same budget as a loose ref's;
 * when that read fails, the tag set is unresolved.
 */
function packedEntryNamesHead(
  mainRoot: string,
  head: string,
  entry: PackedTag,
  packed: PackedTags,
  budget: InflateBudget,
): boolean | undefined {
  if (entry.id === head || entry.peeled === head) return true
  if (entry.peeled !== undefined || packed.fullyPeeled) return false
  return looseObjectNamesHead(mainRoot, entry.id, head, budget)
}

function resolveTagAtHead(mainRoot: string, head: string): TagAtHead {
  if (!OBJECT_ID.test(head)) return UNKNOWN_TAG
  const budget: InflateBudget = { inflations: 0, bytes: 0 }
  const loose = looseTagNames(mainRoot)
  const matched = loose && looseMatches(mainRoot, head, loose, budget)
  const packed = packedTags(mainRoot)
  if (loose === undefined || matched === undefined || packed === undefined) {
    return UNKNOWN_TAG
  }

  const seen = new Set<string>(loose)
  for (const entry of packed.tags) {
    // A loose ref of the same name wins, as it does in git, and counts once.
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    const names = packedEntryNamesHead(mainRoot, head, entry, packed, budget)
    if (names === undefined) return UNKNOWN_TAG
    if (names) matched.add(entry.name)
  }

  const [name, ...others] = matched
  if (name === undefined || others.length > 0) return UNKNOWN_TAG
  return TAG_NAME_PATTERN.test(name) ? { kind: 'tag', name } : UNKNOWN_TAG
}

/**
 * The one tag whose commit is `head`, for the main checkout at `mainRoot`, or
 * `unknown`. Unknown is the answer for no tag, several tags, a tag object that
 * is not a readable loose object (in a pack, oversize, malformed, nested; a
 * packed tag with no `^` line counts when `packed-refs` is not fully peeled), a
 * walk or inflate past its cap, a symlink, an unsafe name or id and a name
 * that cannot be rendered. Reads `.git` files only and never throws.
 */
export function readTagAtHead(mainRoot: string, head: string): TagAtHead {
  try {
    return resolveTagAtHead(mainRoot, head)
  } catch {
    return UNKNOWN_TAG
  }
}
