/**
 * Dependency pins for `ce:connect`: the version a project pins an upstream at,
 * read from the project's own files, and the hint lines `begin` renders from
 * it.
 *
 * `resolvePins` turns declared pins into hint lines. A pin matches only a
 * project the run has already selected and scanned, by the entry as written or
 * by its resolved root; a path a pin declares itself is never resolved or
 * opened. It reads nothing until a pin has matched a selected project and a
 * selected checkout of the upstream. The line is a fixed template whose slots
 * passed strict charsets, and it names projects by the roots the `begin`
 * answer lists, never by name or key.
 *
 * `readPinValue` reads one pin value live from a project's working tree. The
 * read is contained and bounded (`readContainedFile`: safe relative path, no
 * symlink, size cap), parsed as JSON or JSONC, and walked by a dotted key
 * path. The result is a plain string that passed `PIN_VALUE_PATTERN` or one
 * fixed failure code. A failure never carries file content, a key, a value or
 * a path, so a code is safe to show. The file is untrusted data: a value that
 * fails the charset is rejected, never cleaned up.
 *
 * Import rule: node builtins, `jsonc-parser` and sibling connect modules only.
 * Never zod, `config.ts` or `config-schema.ts`, because the `ce:connect`
 * helper bundles this module. Never throws.
 */

import { type ParseError, parse as parseJsonc } from 'jsonc-parser'
import {
  type ConnectPin,
  isGithubOwnerRepo,
  isPinKey,
  MAX_PIN_FILE_LENGTH,
  PIN_FILE_PATTERN,
} from './connect-config.js'
import { readContainedFile } from './connect-evidence.js'
import {
  readTagAtHead,
  TAG_NAME_PATTERN,
  type TagAtHead,
} from './connect-repo-identity.js'

// ── Charset ─────────────────────────────────────────────────────────────────

/**
 * The shape of a pin value, and so of the version a rendered hint states: one
 * leading letter or digit, then letters, digits, `.`, `_`, `+` and `-`, 64
 * characters at most. It is `TAG_NAME_PATTERN` without the `/`: a tag may be
 * `release/1.2`, but a pinned version names no path, and refusing the slash
 * keeps a value from reading as one. Reject, do not sanitize.
 */
export const PIN_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

// ── Reading a pin value ─────────────────────────────────────────────────────

/** Why a pin value could not be read. The only text a failure carries. */
export type PinFailureCode =
  | 'pin-file-missing'
  | 'pin-file-too-large'
  | 'pin-file-invalid'
  | 'pin-key-absent'
  | 'pin-value-invalid'

export type PinValueResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'failed'; readonly code: PinFailureCode }

function failed(code: PinFailureCode): PinValueResult {
  return { kind: 'failed', code }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The value at a dotted key path, or `undefined` when no own property chain
 * leads there. Each step needs a plain object and an own property, so an
 * array, a primitive, `null` and an inherited name (`constructor`, `toString`,
 * `__proto__`) all end the walk.
 */
function walkKey(root: unknown, key: string): unknown {
  let current = root
  for (const segment of key.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

/**
 * Read the string at `key` in the JSON or JSONC file `file` under `root`.
 *
 * `root` must be a trusted real path. `file` is repo-relative and `key` is
 * dotted segments with no array index. The working tree is read as it is:
 * tracked status is not checked, so an untracked file works.
 *
 * - `pin-file-missing`: no such file, a directory, a symlink, a path outside
 *   the root, or a file that cannot be read.
 * - `pin-file-too-large`: over the read cap.
 * - `pin-file-invalid`: empty, malformed, or not UTF-8 JSONC.
 * - `pin-key-absent`: the key does not lead to an own property.
 * - `pin-value-invalid`: the value is not a string that passes
 *   `PIN_VALUE_PATTERN`.
 */
export function readPinValue(
  root: string,
  file: string,
  key: string,
): PinValueResult {
  const read = readContainedFile(root, file)
  if (read.kind === 'refused') {
    return failed(
      read.reason === 'too-large' ? 'pin-file-too-large' : 'pin-file-missing',
    )
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
  } catch {
    return failed('pin-file-invalid')
  }
  const errors: ParseError[] = []
  let parsed: unknown
  try {
    parsed = parseJsonc(text, errors, { allowTrailingComma: true })
  } catch {
    // The parser recurses per nesting level, so a deeply nested file under the
    // byte cap can overflow the stack.
    return failed('pin-file-invalid')
  }
  if (errors.length > 0 || parsed === undefined)
    return failed('pin-file-invalid')
  if (!isPinKey(key)) return failed('pin-key-absent')
  const value = walkKey(parsed, key)
  if (value === undefined) return failed('pin-key-absent')
  if (typeof value !== 'string' || !PIN_VALUE_PATTERN.test(value)) {
    return failed('pin-value-invalid')
  }
  return { kind: 'ok', value }
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** The most hint lines one run returns. */
export const MAX_PIN_HINTS = 8

/** The most notes one run returns. */
export const MAX_PIN_NOTES = 8

/** The most characters a rendered project root has. */
export const MAX_PIN_ROOT_LENGTH = 256

/**
 * A project root as a hint line may name it: absolute, with letters, digits,
 * `.`, `_`, `-` and `/` only. A root with a space, a quote, a `$`, a backtick,
 * a control character or a non-ASCII character is not rendered, so a root
 * cannot break the one-line shape or read as markup.
 */
const PIN_ROOT_PATTERN = /^\/[A-Za-z0-9._/-]*$/

/** A project key: `projectKey` in `connect-helper-core.ts` makes twelve lowercase hex digits. */
const PROJECT_KEY_PATTERN = /^[0-9a-f]{12}$/

/** Why a pin gave no line, or what the run cut. A fixed vocabulary; a note never echoes data. */
export type PinNoteCode =
  | PinFailureCode
  | 'pin-conflict'
  | 'hints-truncated'
  | 'notes-truncated'

/**
 * One reason, with the key of the pinning project when the reason belongs to
 * one. `pin-conflict`, `hints-truncated` and `notes-truncated` carry no
 * identifier and no count.
 */
export interface PinNote {
  readonly code: PinNoteCode
  readonly project?: string
}

const NOTE_CODES: ReadonlySet<string> = new Set<PinNoteCode>([
  'pin-file-missing',
  'pin-file-too-large',
  'pin-file-invalid',
  'pin-key-absent',
  'pin-value-invalid',
  'pin-conflict',
  'hints-truncated',
  'notes-truncated',
])

/** A project the run selected and scanned, as `begin` lists it. */
export interface PinProject {
  /** The allow-list entry as written. */
  readonly entry: string
  /** The resolved main root, as the `projects` block lists it. */
  readonly root: string
  /** `projectKey(root)`. */
  readonly key: string
  /** Lowercase `owner/repo` of the GitHub `origin`, when the checkout has one. */
  readonly repo?: string
  /** The commit HEAD names, when it can be read. */
  readonly commit?: string
}

/** The two reads a pin needs. A seam for tests; the defaults are the real readers. */
export interface PinReaders {
  readonly readPin: (root: string, file: string, key: string) => PinValueResult
  readonly readTag: (root: string, head: string) => TagAtHead
}

const REAL_READERS: PinReaders = {
  readPin: readPinValue,
  readTag: readTagAtHead,
}

export interface PinResolution {
  /** Hint lines by the key of the pinning project. */
  readonly hints: Record<string, string[]>
  /** Sorted, deduplicated and capped. Never a reason to degrade a run. */
  readonly notes: PinNote[]
}

function validRoot(root: string): boolean {
  return root.length <= MAX_PIN_ROOT_LENGTH && PIN_ROOT_PATTERN.test(root)
}

/**
 * The fixed one-line hint. Every slot passed its charset before this is called.
 * The closing sentence is constant text: it says what to check and what to
 * report. It is not evidence. A candidate still has to cite real files and the
 * validator is unchanged.
 */
function renderLine(parts: {
  readonly projectRoot: string
  readonly upstream: string
  readonly value: string
  readonly file: string
  readonly checkoutRoot: string
  readonly tag: string
}): string {
  const { projectRoot, upstream, value, file, checkoutRoot, tag } = parts
  return `pin: ${projectRoot} pins ${upstream} at ${value} (${file}); allowed checkout ${checkoutRoot} is ${upstream} at ${tag}. Check claims about ${upstream} at both versions; if a claim holds at one and not the other, report a \`code-mismatch\` with reason \`unscoped\` and cite the evidence from the other checkout.`
}

function tagLabel(tag: TagAtHead): string {
  return tag.kind === 'tag' && TAG_NAME_PATTERN.test(tag.name)
    ? tag.name
    : 'unknown'
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

interface PinGroup {
  readonly pinning: PinProject
  /** Lowercase. */
  readonly upstream: string
  readonly key: string
  readonly files: Set<string>
}

/**
 * The project a pin's `project` names: the selected project whose entry equals
 * it as written, else the one whose resolved root equals it. Nothing else
 * matches, and a pin's `project` is never resolved.
 */
function matchProject(
  declared: string,
  projects: readonly PinProject[],
): PinProject | undefined {
  return (
    projects.find((item) => item.entry === declared) ??
    projects.find((item) => item.root === declared)
  )
}

/** Group the matched pins by (resolved root, upstream, key). Unmatched pins vanish here. */
function groupPins(
  pins: readonly ConnectPin[],
  projects: readonly PinProject[],
): PinGroup[] {
  const groups = new Map<string, PinGroup>()
  for (const pin of pins) {
    if (!isGithubOwnerRepo(pin.upstream)) continue
    const pinning = matchProject(pin.project, projects)
    if (pinning === undefined) continue
    const upstream = pin.upstream.toLowerCase()
    const identity = JSON.stringify([pinning.root, upstream, pin.key])
    const group = groups.get(identity)
    if (group === undefined) {
      groups.set(identity, {
        pinning,
        upstream,
        key: pin.key,
        files: new Set([pin.file]),
      })
    } else {
      group.files.add(pin.file)
    }
  }
  return [...groups.values()]
}

interface HintEntry {
  readonly pinKey: string
  readonly upstream: string
  readonly key: string
  readonly checkoutKey: string
  readonly line: string
}

function sortNotes(notes: readonly PinNote[]): PinNote[] {
  return [...notes].sort(
    (a, b) =>
      compareText(a.code, b.code) ||
      compareText(a.project ?? '', b.project ?? ''),
  )
}

function capNotes(notes: readonly PinNote[]): PinNote[] {
  const sorted = sortNotes(notes)
  if (sorted.length <= MAX_PIN_NOTES) return sorted
  return sortNotes([
    ...sorted.slice(0, MAX_PIN_NOTES - 1),
    { code: 'notes-truncated' },
  ])
}

/** Whether the pin's file and the pinning project's key may be used, shape only. */
function usableDeclaration(file: string, pinning: PinProject): boolean {
  return (
    file.length <= MAX_PIN_FILE_LENGTH &&
    PIN_FILE_PATTERN.test(file) &&
    PROJECT_KEY_PATTERN.test(pinning.key)
  )
}

/**
 * The hint entries of one group, or none. A group with two files is a
 * conflict. A group with no selected checkout of the upstream gives nothing
 * and reads nothing. Roots that cannot be rendered cost their pair a line and
 * add one `pin-value-invalid` note; only then is the pin value read, once, and
 * each checkout's tag.
 */
function resolveGroup(
  group: PinGroup,
  projects: readonly PinProject[],
  readers: PinReaders,
  addNote: (note: PinNote) => void,
): HintEntry[] {
  const { pinning, upstream } = group
  const [file] = group.files
  if (group.files.size > 1 || file === undefined) {
    addNote({ code: 'pin-conflict' })
    return []
  }
  const checkouts = projects.filter(
    (item) => item.root !== pinning.root && item.repo === upstream,
  )
  if (checkouts.length === 0) return []
  const invalid = (): void =>
    addNote({ code: 'pin-value-invalid', project: pinning.key })
  if (!usableDeclaration(file, pinning)) {
    invalid()
    return []
  }
  const renderable = checkouts.filter((item) => validRoot(item.root))
  const pinningRenderable = validRoot(pinning.root)
  if (renderable.length < checkouts.length || !pinningRenderable) invalid()
  if (renderable.length === 0 || !pinningRenderable) return []

  const value = readers.readPin(pinning.root, file, group.key)
  if (value.kind === 'failed') {
    addNote({ code: value.code, project: pinning.key })
    return []
  }
  if (!PIN_VALUE_PATTERN.test(value.value)) {
    invalid()
    return []
  }
  return renderable.map((checkout) => {
    const tag: TagAtHead =
      checkout.commit === undefined
        ? { kind: 'unknown' }
        : readers.readTag(checkout.root, checkout.commit)
    return {
      pinKey: pinning.key,
      upstream,
      key: group.key,
      checkoutKey: checkout.key,
      line: renderLine({
        projectRoot: pinning.root,
        upstream,
        value: value.value,
        file,
        checkoutRoot: checkout.root,
        tag: tagLabel(tag),
      }),
    }
  })
}

/**
 * Turn declared pins into hint lines and notes. Never throws, and opens
 * nothing a selected project does not own.
 *
 * Order: match each pin to a selected project, group by (resolved root,
 * upstream, key), drop a group whose entries name different files (one
 * `pin-conflict` note, never a pick), find the selected checkouts of the
 * upstream other than the pinning project, and only then read the pin value
 * and each checkout's tag. A pin with no selected matching checkout gives
 * nothing, no note either: that case cannot be told from an out-of-selection
 * one without a read.
 */
export function resolvePins(
  pins: readonly ConnectPin[],
  projects: readonly PinProject[],
  overrides: Partial<PinReaders> = {},
): PinResolution {
  const readers: PinReaders = { ...REAL_READERS, ...overrides }
  const notes = new Map<string, PinNote>()
  const addNote = (note: PinNote): void => {
    notes.set(`${note.code}\0${note.project ?? ''}`, note)
  }
  const entries = groupPins(pins, projects).flatMap((group) =>
    resolveGroup(group, projects, readers, addNote),
  )

  entries.sort(
    (a, b) =>
      compareText(a.pinKey, b.pinKey) ||
      compareText(a.upstream, b.upstream) ||
      compareText(a.key, b.key) ||
      compareText(a.checkoutKey, b.checkoutKey),
  )
  const kept = entries.slice(0, MAX_PIN_HINTS)
  if (kept.length < entries.length) addNote({ code: 'hints-truncated' })
  const hints: Record<string, string[]> = {}
  for (const entry of kept) {
    const lines = hints[entry.pinKey] ?? []
    lines.push(entry.line)
    hints[entry.pinKey] = lines
  }
  return { hints, notes: capNotes([...notes.values()]) }
}

// ── Notes in a summary ──────────────────────────────────────────────────────

/**
 * The well-formed notes of an untrusted value, such as a snapshot read back
 * from disk: a known code, and a project that is a project key. Anything else
 * is dropped, so a stored note cannot carry text into a summary.
 */
export function readPinNotes(value: unknown): PinNote[] {
  if (!Array.isArray(value)) return []
  const notes: PinNote[] = []
  for (const item of value as unknown[]) {
    const note = readPinNote(item)
    if (note !== undefined) notes.push(note)
  }
  return notes.slice(0, MAX_PIN_NOTES)
}

const GLOBAL_NOTE_CODES: ReadonlySet<string> = new Set<PinNoteCode>([
  'pin-conflict',
  'hints-truncated',
  'notes-truncated',
])

function readPinNote(item: unknown): PinNote | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { code, project } = item as { code?: unknown; project?: unknown }
  if (typeof code !== 'string' || !NOTE_CODES.has(code)) return undefined
  if (GLOBAL_NOTE_CODES.has(code)) {
    return project === undefined ? { code: code as PinNoteCode } : undefined
  }
  return typeof project === 'string' && PROJECT_KEY_PATTERN.test(project)
    ? { code: code as PinNoteCode, project }
    : undefined
}

/**
 * The fixed-form summary line for a run's notes: `Pins: <code>[ (<key>)], ...`,
 * or nothing when there are none. Built from codes and keys only, so it holds
 * no file, key path, value or upstream.
 */
export function renderPinsLine(notes: readonly PinNote[]): string {
  if (notes.length === 0) return ''
  const parts = notes.map((note) =>
    note.project === undefined ? note.code : `${note.code} (${note.project})`,
  )
  return `Pins: ${parts.join(', ')}.`
}
