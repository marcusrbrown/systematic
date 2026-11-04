/**
 * The `search` config field: its zod schema piece, the pure merge rule, the
 * user-level file selection, and a reader that never touches project config.
 *
 * Import rule: this module may import only zod, jsonc-parser, node builtins,
 * `search-bounded-read.ts` (node builtins only) and TYPES from `search-core.ts`. It must never import `config.ts` or
 * `config-schema.ts`; both of those import this module, never the reverse.
 * The `systematic-search` bin bundles it, and pulling in `config.ts` would
 * drag the whole config loader (and its jsonc build) into that bundle.
 * `trustProtected` lives in `config-schema.ts`, so the two user-only fields
 * carry the same `trust: 'project-or-higher'` meta inline here.
 *
 * Trust, per field: `enabled` and `allow_project_sources` are user-only (user
 * config and `OPENCODE_CONFIG_DIR` config). A project config may set `sources`
 * only. `config.ts` strips the two user-only fields from a project with
 * per-path warnings, validates the project's `sources` with the validators
 * here, and then discards them; the per-call reader is their only consumer.
 *
 * Why it exists as one place: the plugin loader (`config.ts`), the per-call
 * reader and the bin all need "validate the `search` block, then merge user
 * and custom". The block is validated field by field and entry by entry, so
 * one bad field or source entry drops alone with a warning and leaves its
 * valid siblings and the rest of the file loading. Search still runs, and
 * its results carry a `config unreadable` note when a setting that changes
 * what search does was dropped (the `unreadable` state). Search must never be
 * the reason the plugin fails to load.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser'
import { z } from 'zod'
import { readBytesBounded } from './search-bounded-read.js'
import {
  type ExcludeIssue,
  MAX_EXCLUDE_PATTERN_LENGTH,
  MAX_EXCLUDE_PATTERNS,
  validateExcludeList,
} from './search-exclude.js'

/** The two formats a source may declare. */
export const SEARCH_SOURCE_FORMATS = ['markdown', 'deciduous'] as const

export type SearchSourceFormat = (typeof SEARCH_SOURCE_FORMATS)[number]

/** Letters, digits, `-` and `_`, 1 to 40 characters. Case-sensitive. */
const SOURCE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/** A source takes at most this many roots. */
export const MAX_SOURCE_ROOTS = 8

const sourceNameSchema = z
  .string()
  .regex(SOURCE_NAME_PATTERN)
  .meta({
    description:
      'Source name: letters, digits, `-` and `_`, at most 40 characters. Case-sensitive. Search results label the source with it, and a user source with the same name as a project source replaces it when the user source is mapped to the project.',
    examples: ['team-rfcs', 'ops_runbooks'],
  })

const sourceFormatSchema = z.enum(SEARCH_SOURCE_FORMATS).meta({
  description:
    'How the source stores records. `markdown` reads `.md` files under each root; `deciduous` reads Deciduous sync JSON (`nodes/` and `edges/`).',
  examples: ['markdown', 'deciduous'],
})

const sourceRootsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_SOURCE_ROOTS)
  .meta({
    description:
      'One to eight folders to read. In a project config each root is a relative path under the checkout (no `.`, no `..`, no dot segment, except `.deciduous/<subfolder>` for a `deciduous` source). In user config each root is an absolute or `~`-prefixed path. Symlinks inside a root are skipped.',
    examples: [['docs/rfcs'], ['~/src/wiki/pages', '/srv/runbooks']],
  })

const sourceProjectsSchema = z
  .array(z.string().min(1))
  .optional()
  .meta({
    description:
      'User config only, and required there: at least one absolute or `~`-prefixed main repository root this source applies to. A user source that omits it or leaves it empty is dropped with a warning, so a source can never apply to every project by accident. A project config may not set it.',
    examples: [['~/src/github.com/me/app']],
  })

/**
 * The schema declares a plain string array. The count and length limits and
 * the per-pattern rules live in `validateExcludeList`, which drops a bad
 * pattern alone; a strict array schema would reject the whole value instead.
 */
const sourceExcludeSchema = z
  .array(z.string())
  .optional()
  .meta({
    description: `Patterns for files and folders to skip under each root. A pattern with no \`/\` matches a file or folder name at any depth (\`log.md\`, \`.stryker-tmp\`), and a matched folder is skipped with everything below it. A pattern with a \`/\` is anchored at the root: \`drafts/*.md\` matches \`drafts/a.md\` but not \`notes/drafts/a.md\`. \`*\` matches any run of characters inside one name, \`?\` matches one character, and \`**\` as a whole segment matches any number of folders (\`a/**/b\`). Matching is case-sensitive. Negation (\`!\`), character classes (\`[ ]\`), a leading \`/\` or \`./\`, \`..\`, and backslashes are not supported. A source takes at most ${MAX_EXCLUDE_PATTERNS} patterns of at most ${MAX_EXCLUDE_PATTERN_LENGTH} characters. An invalid pattern is dropped with a warning that names its position, and the other patterns still apply. Allowed in user and project config.`,
    examples: [
      ['log.md', '.stryker-tmp'],
      ['drafts/*.md', 'archive/**/old'],
    ],
  })

/**
 * One entry of `search.sources`. `projects` is user-config only, and a user
 * entry must carry at least one; the validators enforce both. The schema keeps
 * it optional because the project variant may not set it.
 */
export const SearchSourceSchema = z
  .object({
    name: sourceNameSchema,
    format: sourceFormatSchema,
    roots: sourceRootsSchema,
    projects: sourceProjectsSchema,
    exclude: sourceExcludeSchema,
  })
  .strict()
  .meta({
    description:
      'One opt-in decision source: a name, a format and one or more roots.',
    examples: [{ name: 'team-rfcs', format: 'markdown', roots: ['docs/rfcs'] }],
  })

export type SearchSourceEntry = z.output<typeof SearchSourceSchema>

/**
 * The `search` block. No zod defaults anywhere: an absent `search` stays
 * absent, and the core applies its own defaults at use time.
 *
 * `enabled` and `allow_project_sources` are user-only and carry the trust tag
 * inline (the same `trust: 'project-or-higher'` meta `trustProtected` writes
 * in `config-schema.ts`, which this module may not import). `sources` is the
 * one field a project may set.
 */
export const SearchSettingsSchema = z
  .object({
    enabled: z
      .boolean()
      .meta({
        description:
          'Set to false to remove the search tool. Defaults to true when unset. User-owned: only valid in user config or OPENCODE_CONFIG_DIR config.',
        examples: [false],
        trust: 'project-or-higher',
      })
      .optional(),
    allow_project_sources: z
      .array(z.string().min(1))
      .meta({
        description:
          "Main repository roots (absolute or `~`-prefixed) whose project config may propose `search.sources`. A project's sources are read only when its main root is listed here; matching is exact, a linked worktree matches its main checkout, and an allowed project covers whatever any of its branches proposes. User-owned: only valid in user config or OPENCODE_CONFIG_DIR config; the lists in both are combined.",
        examples: [['~/src/github.com/me/app']],
        trust: 'project-or-higher',
      })
      .optional(),
    sources: z
      .array(SearchSourceSchema)
      .optional()
      .meta({
        description:
          'Opt-in external decision sources for `kind: "external"` search: folders of Markdown or Deciduous sync JSON. A project config may propose sources inside its own checkout, but none is read until the user lists that project in `allow_project_sources`. User config may map folders anywhere on disk to projects with `projects`, which every user source must list (at least one project root). An invalid entry is dropped with a warning and its valid siblings stay.',
        examples: [
          [{ name: 'team-rfcs', format: 'markdown', roots: ['docs/rfcs'] }],
          [
            {
              name: 'decisions',
              format: 'deciduous',
              roots: ['~/src/github.com/me/app/.deciduous/sync'],
              projects: ['~/src/github.com/me/app'],
            },
          ],
        ],
      }),
  })
  .strict()
  .meta({
    description:
      'Search settings. `enabled` and `allow_project_sources` are user-owned: only user config and OPENCODE_CONFIG_DIR config may set them, and a project config that sets either has that field ignored with a warning. A project config may set `sources`. An invalid field or entry is dropped with a warning; the rest of the file still loads.',
    examples: [
      { enabled: false },
      {
        allow_project_sources: ['~/src/github.com/me/app'],
        sources: [
          {
            name: 'team-rfcs',
            format: 'markdown',
            roots: ['/srv/rfcs'],
            projects: ['~/src/github.com/me/app'],
          },
        ],
      },
    ],
  })

/** What a successful parse of the `search` block yields. Assignable to the core's `SearchSettings`. */
export type SearchSchemaOutput = z.output<typeof SearchSettingsSchema>

// ── Validating one block ────────────────────────────────────────────────────

/** Which rules apply: user and custom config, or project config (`sources` only). */
export type SearchConfigTrust = 'user' | 'project'

export interface SearchConfigValidation {
  /**
   * The valid parts of the block. Absent only when the block itself was not an
   * object. An object block with nothing valid gives `{}`.
   */
  readonly settings: SearchSchemaOutput | undefined
  /**
   * Set when something that changes what search does was dropped: a bad
   * `enabled`, a bad or non-array allow list or allow entry, a non-array
   * `sources`, an unknown key, or a block that is not an object. A dropped
   * source entry alone does not set it.
   */
  readonly unreadable: boolean
  /** Set when a container is invalid: the block is not an object, or `sources` is not an array. */
  readonly structural: boolean
  /** Bounded warnings. They name fields and source names, never a value. */
  readonly warnings: readonly string[]
  /**
   * Every source entry that was dropped whole, with the label the warning
   * uses (`"name"`, or `#index` when the name is unusable) and the reason. A
   * dropped exclude pattern is not listed here: its source stays.
   */
  readonly dropped: readonly DroppedSearchEntry[]
}

/** One source entry the validator dropped, as the warning names it. */
export interface DroppedSearchEntry {
  readonly label: string
  readonly reason: string
}

const MAX_DETAIL_WARNINGS = 5
const MAX_PATH_CHARS = 200

/** Escape control characters and cap the length of a path before it goes into a warning. */
function displaySafe(text: string): string {
  let out = ''
  for (const char of text) {
    if (out.length >= MAX_PATH_CHARS) return `${out}\u2026`
    const code = char.codePointAt(0) ?? 0
    const isControl =
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    out += isControl ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }
  return out
}

/** ASCII control characters (C0 and DEL). */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The tail every user-level warning carries. A project warning says nothing about a note. */
function unreadableTail(trust: SearchConfigTrust): string {
  return trust === 'user'
    ? '; search still runs and its results carry a `config unreadable` note. The rest of the file still loads.'
    : '. The rest of the file still loads.'
}

function fieldWarning(
  trust: SearchConfigTrust,
  sourcePath: string,
  field: string,
): string {
  return `[systematic] \`${field}\` in ${sourcePath} is invalid and has been ignored${unreadableTail(trust)}`
}

function unknownKeyWarning(
  trust: SearchConfigTrust,
  sourcePath: string,
): string {
  return `[systematic] \`search\` in ${sourcePath} contains an unknown field (its name is not shown) that has been ignored${unreadableTail(trust)}`
}

function entryWarning(
  sourcePath: string,
  label: string,
  reason: string,
): string {
  return `[systematic] search source ${label} in ${sourcePath} was dropped: ${reason}. Its valid siblings still load.`
}

function excludeWarning(
  sourcePath: string,
  label: string,
  issue: ExcludeIssue,
): string {
  return `[systematic] \`exclude[${issue.index}]\` of search source ${label} in ${sourcePath} was dropped: ${issue.reason}. The source and its other patterns still load.`
}

/** `~`, `~/...` or `~\...`. A `~name` form is not a home directory. */
function isTildePath(value: string): boolean {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\')
}

/** The form every user root, `projects[]` entry and allow entry must take. */
function isUserPathForm(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !hasControlChar(value) &&
    (isTildePath(value) || path.isAbsolute(value))
  )
}

function isAbsoluteAnywhere(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
}

/**
 * Whether a project root is a strict, dot-free subfolder. Both
 * separators count. One named exception: a `deciduous` source may start with
 * `.deciduous/` when at least one non-dot segment follows.
 */
function isProjectRoot(root: string, format: SearchSourceFormat): boolean {
  if (root.length === 0 || hasControlChar(root)) return false
  if (isAbsoluteAnywhere(root)) return false
  const segments = root.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return false
  const exempt =
    format === 'deciduous' &&
    segments[0] === '.deciduous' &&
    segments.length > 1
  const checked = exempt ? segments.slice(1) : segments
  return checked.every((segment) => !segment.startsWith('.'))
}

type EntryResult =
  | {
      readonly ok: true
      readonly entry: SearchSourceEntry
      readonly excludeIssues: readonly ExcludeIssue[]
    }
  | { readonly ok: false; readonly label: string; readonly reason: string }

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'format',
  'roots',
  'projects',
  'exclude',
])

function isFormat(value: unknown): value is SearchSourceFormat {
  return (
    typeof value === 'string' &&
    (SEARCH_SOURCE_FORMATS as readonly string[]).includes(value)
  )
}

function rejectEntry(label: string, reason: string): EntryResult {
  return { ok: false, label, reason }
}

function validateRoots(
  roots: unknown,
  format: SearchSourceFormat,
  trust: SearchConfigTrust,
): readonly string[] | string {
  if (
    !Array.isArray(roots) ||
    roots.length < 1 ||
    roots.length > MAX_SOURCE_ROOTS
  ) {
    return `it needs 1 to ${MAX_SOURCE_ROOTS} roots`
  }
  const valid: string[] = []
  for (const root of roots) {
    if (typeof root !== 'string') return 'a root is not a string'
    if (trust === 'user' && !isUserPathForm(root)) {
      return 'a root must be an absolute or ~-prefixed path'
    }
    if (trust === 'project' && !isProjectRoot(root, format)) {
      return 'a root must be a relative subfolder of the project with no ".", ".." or dot segment (only .deciduous/<subfolder> is allowed, for deciduous sources)'
    }
    valid.push(root)
  }
  return valid
}

function validateProjects(
  projects: unknown,
  trust: SearchConfigTrust,
): readonly string[] | undefined | string {
  if (trust === 'project') {
    return projects === undefined
      ? undefined
      : 'projects is only valid in user config'
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    return 'a user source needs a projects list with at least one project root'
  }
  if (!projects.every(isUserPathForm)) {
    return 'a projects entry must be an absolute or ~-prefixed path'
  }
  return projects
}

function validateEntry(
  raw: unknown,
  index: number,
  trust: SearchConfigTrust,
): EntryResult {
  const indexLabel = `#${index}`
  if (!isRecord(raw)) return rejectEntry(indexLabel, 'it is not an object')
  const name = raw.name
  if (typeof name !== 'string' || !SOURCE_NAME_PATTERN.test(name)) {
    return rejectEntry(
      indexLabel,
      'the name must be 1 to 40 letters, digits, "-" or "_"',
    )
  }
  const label = `"${name}"`
  if (Object.keys(raw).some((key) => !ENTRY_KEYS.has(key))) {
    return rejectEntry(label, 'it has an unknown field')
  }
  const format = raw.format
  if (!isFormat(format)) {
    return rejectEntry(label, 'the format must be markdown or deciduous')
  }
  const roots = validateRoots(raw.roots, format, trust)
  if (typeof roots === 'string') return rejectEntry(label, roots)
  const projects = validateProjects(raw.projects, trust)
  if (typeof projects === 'string') return rejectEntry(label, projects)
  const exclude = Object.hasOwn(raw, 'exclude')
    ? validateExcludeList(raw.exclude)
    : undefined
  if (exclude?.ok === false) {
    return rejectEntry(label, `exclude is invalid (${exclude.reason})`)
  }
  const patterns = exclude?.patterns ?? []
  return {
    ok: true,
    entry: {
      name,
      format,
      roots: [...roots],
      ...(projects !== undefined && { projects: [...projects] }),
      ...(patterns.length > 0 && { exclude: [...patterns] }),
    },
    excludeIssues: exclude?.issues ?? [],
  }
}

interface ValidationState {
  readonly trust: SearchConfigTrust
  readonly sourcePath: string
  readonly warnings: string[]
  readonly dropped: DroppedSearchEntry[]
  suppressed: number
  unreadable: boolean
  structural: boolean
}

function warn(state: ValidationState, message: string): void {
  if (state.warnings.length < MAX_DETAIL_WARNINGS) state.warnings.push(message)
  else state.suppressed += 1
}

function validateSources(
  raw: unknown,
  state: ValidationState,
): SearchSourceEntry[] | undefined {
  if (!Array.isArray(raw)) {
    state.structural = true
    state.unreadable = true
    warn(state, fieldWarning(state.trust, state.sourcePath, 'search.sources'))
    return undefined
  }
  const kept: SearchSourceEntry[] = []
  const seen = new Set<string>()
  raw.forEach((item: unknown, index) => {
    const result = validateEntry(item, index, state.trust)
    if (!result.ok) {
      dropEntry(state, result.label, result.reason)
      return
    }
    if (seen.has(result.entry.name)) {
      dropEntry(
        state,
        `"${result.entry.name}"`,
        'the name is already used earlier in this file, so the first entry is kept',
      )
      return
    }
    seen.add(result.entry.name)
    kept.push(result.entry)
    for (const issue of result.excludeIssues) {
      warn(
        state,
        excludeWarning(state.sourcePath, `"${result.entry.name}"`, issue),
      )
    }
  })
  return kept
}

/** Record a dropped entry and warn about it. */
function dropEntry(
  state: ValidationState,
  label: string,
  reason: string,
): void {
  state.dropped.push({ label, reason })
  warn(state, entryWarning(state.sourcePath, label, reason))
}

function validateAllowList(
  raw: unknown,
  state: ValidationState,
): string[] | undefined {
  if (!Array.isArray(raw)) {
    state.unreadable = true
    warn(
      state,
      fieldWarning(
        state.trust,
        state.sourcePath,
        'search.allow_project_sources',
      ),
    )
    return undefined
  }
  const kept: string[] = []
  let rejected = 0
  for (const item of raw as unknown[]) {
    if (!isUserPathForm(item)) rejected += 1
    else if (!kept.includes(item)) kept.push(item)
  }
  if (rejected > 0) {
    state.unreadable = true
    warn(
      state,
      `[systematic] ${rejected} ${rejected === 1 ? 'entry' : 'entries'} in \`search.allow_project_sources\` in ${state.sourcePath} ${rejected === 1 ? 'is' : 'are'} not an absolute or ~-prefixed path and ${rejected === 1 ? 'has' : 'have'} been ignored; ${rejected === 1 ? 'it allows' : 'they allow'} nothing${unreadableTail(state.trust)}`,
    )
  }
  return kept
}

const USER_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'allow_project_sources',
  'sources',
])

/**
 * A project block is read for `sources` alone, but `enabled` and
 * `allow_project_sources` are known keys there (`config.ts` strips them with
 * their own warnings), so only a name outside all three is unknown.
 */
function hasUnknownKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => !USER_KEYS.has(key))
}

type MutableSettings = {
  enabled?: boolean
  allow_project_sources?: string[]
  sources?: SearchSourceEntry[]
}

/** `enabled` and `allow_project_sources`: user and custom config only. */
function validateUserOnlyFields(
  value: Record<string, unknown>,
  state: ValidationState,
  settings: MutableSettings,
): void {
  if (Object.hasOwn(value, 'enabled')) {
    if (typeof value.enabled === 'boolean') settings.enabled = value.enabled
    else {
      state.unreadable = true
      warn(state, fieldWarning(state.trust, state.sourcePath, 'search.enabled'))
    }
  }
  if (Object.hasOwn(value, 'allow_project_sources')) {
    const allow = validateAllowList(value.allow_project_sources, state)
    if (allow !== undefined && allow.length > 0) {
      settings.allow_project_sources = allow
    }
  }
}

/**
 * Validate a raw `search` value field by field and entry by entry, so a
 * typo in `sources` can never lose `enabled: false`. This is the one
 * validator `config.ts` and the per-call reader both call.
 *
 * A structural error (the block is not an object, or `sources` is not an
 * array) drops the affected container. An entry error drops that entry only.
 * `trust: 'project'` reads `sources` alone; `enabled` and `allow_project_sources`
 * are ignored here because `config.ts` strips them from project config with
 * their own per-path warnings. Warnings name fields and source names and
 * never a value.
 */
export function validateSearchConfig(
  value: unknown,
  trust: SearchConfigTrust,
  sourcePath: string,
): SearchConfigValidation {
  const state: ValidationState = {
    trust,
    sourcePath: displaySafe(sourcePath),
    warnings: [],
    dropped: [],
    suppressed: 0,
    unreadable: false,
    structural: false,
  }
  if (!isRecord(value)) {
    warn(state, fieldWarning(trust, state.sourcePath, 'search'))
    return {
      settings: undefined,
      unreadable: true,
      structural: true,
      warnings: state.warnings,
      dropped: state.dropped,
    }
  }

  const settings: MutableSettings = {}
  if (hasUnknownKey(value)) {
    state.unreadable = true
    warn(state, unknownKeyWarning(trust, state.sourcePath))
  }
  if (trust === 'user') validateUserOnlyFields(value, state, settings)
  if (Object.hasOwn(value, 'sources')) {
    const sources = validateSources(value.sources, state)
    if (sources !== undefined && sources.length > 0) settings.sources = sources
  }

  if (state.suppressed > 0) {
    state.warnings.push(
      `[systematic] ${state.suppressed} more \`search\` problem(s) in ${state.sourcePath} were not listed.`,
    )
  }
  return {
    settings,
    unreadable: state.unreadable,
    structural: state.structural,
    warnings: state.warnings,
    dropped: state.dropped,
  }
}

/** The one warning for a user-level file the reader could not parse. */
function formatSearchFileWarning(sourcePath: string, reason: string): string {
  return `[systematic] search settings in ${displaySafe(sourcePath)} could not be read (${reason}); the settings were ignored, search still runs and its results carry a \`config unreadable\` note.`
}

// ── Merging ─────────────────────────────────────────────────────────────────

/**
 * One source's `search` block after schema validation. `settings` is the
 * schema-parsed block, absent when the source has none. `unreadable` is true
 * when the block failed its schema or the file could not be parsed.
 */
export interface SearchSettingsSource {
  readonly settings?: SearchSchemaOutput | undefined
  readonly unreadable: boolean
  /** The layer this source was read from. Callers that do not track layers leave it out. */
  readonly layer?: UserLevelLayer | undefined
}

export interface MergedSearchSettings {
  readonly settings: SearchSchemaOutput | undefined
  readonly unreadable: boolean
  /**
   * The layer each surviving source entry came from, by source name: the layer
   * of the last source that defined that name. Names defined only by sources
   * with no `layer` are absent.
   */
  readonly sourceLayers: ReadonlyMap<string, UserLevelLayer>
}

/**
 * The one merge rule, used by both `config.ts` and the reader. Sources arrive
 * in priority order: user, user.local, custom, custom.local. `enabled` takes
 * the last source that defines it, `allow_project_sources` is the union, and
 * `sources` merge by name with the later source replacing the earlier entry
 * whole (in the earlier entry's position). `unreadable` is set when any source
 * was.
 */
export function mergeSearchSettings(
  sources: readonly SearchSettingsSource[],
): MergedSearchSettings {
  const acc: MergeAccumulator = {
    allow: [],
    byName: new Map(),
    layers: new Map(),
  }
  let unreadable = false
  for (const source of sources) {
    if (source.unreadable) unreadable = true
    if (source.settings !== undefined) {
      absorb(acc, source.settings, source.layer)
    }
  }
  const merged: SearchSchemaOutput = {
    ...(acc.enabled !== undefined && { enabled: acc.enabled }),
    ...(acc.allow.length > 0 && { allow_project_sources: acc.allow }),
    ...(acc.byName.size > 0 && { sources: [...acc.byName.values()] }),
  }
  if (Object.keys(merged).length === 0) {
    return { settings: undefined, unreadable, sourceLayers: acc.layers }
  }
  return { settings: merged, unreadable, sourceLayers: acc.layers }
}

interface MergeAccumulator {
  enabled?: boolean
  readonly allow: string[]
  readonly byName: Map<string, SearchSourceEntry>
  readonly layers: Map<string, UserLevelLayer>
}

/** Fold one source's settings into the running merge. */
function absorb(
  acc: MergeAccumulator,
  settings: SearchSchemaOutput,
  layer: UserLevelLayer | undefined,
): void {
  if (settings.enabled !== undefined) acc.enabled = settings.enabled
  for (const entry of settings.allow_project_sources ?? []) {
    if (!acc.allow.includes(entry)) acc.allow.push(entry)
  }
  for (const entry of settings.sources ?? []) {
    acc.byName.set(entry.name, entry)
    if (layer === undefined) acc.layers.delete(entry.name)
    else acc.layers.set(entry.name, layer)
  }
}

// ── File selection ──────────────────────────────────────────────────────────

/**
 * Pick a config file in `dir`: `<basename>.jsonc` when it exists, else the
 * `.json` path (returned even when absent, so callers that stat it still work).
 */
export function selectConfigFile(dir: string, basename: string): string {
  const jsoncPath = path.join(dir, `${basename}.jsonc`)
  if (fs.existsSync(jsoncPath)) return jsoncPath
  return path.join(dir, `${basename}.json`)
}

export interface UserLevelConfigDirOptions {
  readonly homeDir?: string
  readonly userConfigDir?: string
  /** `null` or a blank string means no custom directory. Leave the key out to read `OPENCODE_CONFIG_DIR`. */
  readonly customConfigDir?: string | null
}

export interface UserLevelConfigDirs {
  readonly homeDir: string
  readonly userConfigDir: string
  readonly customConfigDir: string | undefined
}

/**
 * The user-level config directories: `<home>/.config/opencode`, and the
 * `OPENCODE_CONFIG_DIR` directory when it is set. The variable is trimmed and
 * a blank value counts as unset. `config.ts` and the reader both call this.
 */
export function resolveUserLevelConfigDirs(
  options?: UserLevelConfigDirOptions,
): UserLevelConfigDirs {
  const homeDir = options?.homeDir ?? os.homedir()
  const userConfigDir =
    options?.userConfigDir ?? path.join(homeDir, '.config/opencode')
  const rawCustom =
    options !== undefined && Object.hasOwn(options, 'customConfigDir')
      ? options.customConfigDir?.trim()
      : process.env.OPENCODE_CONFIG_DIR?.trim()
  return { homeDir, userConfigDir, customConfigDir: rawCustom || undefined }
}

/** The four user-level layers, in the order their search settings merge. */
export type UserLevelLayer = 'user' | 'user.local' | 'custom' | 'custom.local'

/** One selected user-level file: the layer it feeds and the path to read. */
export interface UserLevelConfigFile {
  readonly layer: UserLevelLayer
  readonly path: string
}

export interface UserLevelFileSelection {
  /**
   * The selected files in layer order: user, user.local, then custom and
   * custom.local when a custom directory is set. A local file is selected even
   * when its sibling is absent, and the path of an absent file is still
   * returned (`selectConfigFile` rule).
   */
  readonly files: readonly UserLevelConfigFile[]
  /**
   * The custom directory is the user directory, spelled the same way or
   * reached through a symlink. The custom layers stay in `files` so the custom
   * file keeps its precedence, but they name the same two files as `user` and
   * `user.local`: a reader reads each file once and reuses the result.
   */
  readonly aliased: boolean
}

function realpathOrResolved(dir: string): string {
  const resolved = path.resolve(dir)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

/**
 * Pick the user-level config files for the resolved directories. The
 * basenames are `systematic` and `systematic.local`, each choosing `.jsonc`
 * before `.json`. Selection looks at existence only, never validity.
 */
export function selectUserLevelConfigFiles(
  dirs: UserLevelConfigDirs,
): UserLevelFileSelection {
  const files: UserLevelConfigFile[] = [
    {
      layer: 'user',
      path: selectConfigFile(dirs.userConfigDir, 'systematic'),
    },
    {
      layer: 'user.local',
      path: selectConfigFile(dirs.userConfigDir, 'systematic.local'),
    },
  ]
  const custom = dirs.customConfigDir
  if (!custom) return { files, aliased: false }
  files.push(
    { layer: 'custom', path: selectConfigFile(custom, 'systematic') },
    {
      layer: 'custom.local',
      path: selectConfigFile(custom, 'systematic.local'),
    },
  )
  const aliased =
    path.resolve(custom) === path.resolve(dirs.userConfigDir) ||
    realpathOrResolved(custom) === realpathOrResolved(dirs.userConfigDir)
  return { files, aliased }
}

export interface ProjectConfigSelection {
  /** The project file to read. When none exists, the `.opencode/systematic.json` path. */
  readonly path: string
  /**
   * The `.opencode/` file a repo-root file shadowed. Present only when a root
   * file won and an `.opencode/` file also exists.
   */
  readonly ignoredPath?: string
}

/**
 * Pick the project config file under the repository root: `.systematic.jsonc`,
 * else `.systematic.json`, else `.opencode/systematic.jsonc`, else
 * `.opencode/systematic.json`. A root file wins even when invalid; selection
 * looks at existence only and never falls back past a broken file.
 */
export function selectProjectConfigFile(
  repoRoot: string,
): ProjectConfigSelection {
  const opencodeFile = selectConfigFile(
    path.join(repoRoot, '.opencode'),
    'systematic',
  )
  const rootFile = selectConfigFile(repoRoot, '.systematic')
  if (!fs.existsSync(rootFile)) return { path: opencodeFile }
  return fs.existsSync(opencodeFile)
    ? { path: rootFile, ignoredPath: opencodeFile }
    : { path: rootFile }
}

// ── The user-level reader ───────────────────────────────────────────────────

export interface UserLevelSearchLoad {
  readonly settings: SearchSchemaOutput | undefined
  readonly warnings: readonly string[]
  readonly unreadable: boolean
}

type FileRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'read'
      readonly searchBlock: unknown
      readonly has: boolean
    }

type TextRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'text'; readonly content: string }

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** Largest project config file the bin-safe project reader accepts. */
export const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024

/**
 * Read a text file with the shared bounded fd read: never more than
 * `maxBytes + 1` bytes, regular files only, and a non-blocking open so a FIFO
 * planted at the path cannot hang the reader.
 */
function readTextBounded(filePath: string, maxBytes: number): TextRead {
  const read = readBytesBounded(filePath, maxBytes)
  switch (read.kind) {
    case 'bytes':
      return { kind: 'text', content: read.bytes.toString('utf-8') }
    case 'absent':
      return { kind: 'absent' }
    case 'not-regular':
      return { kind: 'failed', reason: 'not a regular file' }
    case 'too-large':
      return {
        kind: 'failed',
        reason: `file is larger than ${maxBytes / (1024 * 1024)} MB`,
      }
    case 'failed':
      return { kind: 'failed', reason: 'unable to read file' }
  }
}

function readTextWhole(filePath: string): TextRead {
  try {
    return { kind: 'text', content: fs.readFileSync(filePath, 'utf-8') }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' }
    return { kind: 'failed', reason: 'unable to read file' }
  }
}

/**
 * Read and parse one config file's `search` block. `maxBytes` bounds the read
 * (used for project config, which a cloned repository controls); user-level
 * files are read whole, as before.
 */
function readSearchBlock(filePath: string, maxBytes?: number): FileRead {
  const text =
    maxBytes === undefined
      ? readTextWhole(filePath)
      : readTextBounded(filePath, maxBytes)
  if (text.kind !== 'text') return text
  const content = text.content
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(content, errors)
  const firstError = errors[0]
  if (firstError) {
    return {
      kind: 'failed',
      reason: `JSONC parse error: ${printParseErrorCode(firstError.error)}`,
    }
  }
  if (!isRecord(parsed)) {
    return { kind: 'failed', reason: 'root must be an object' }
  }
  return {
    kind: 'read',
    has: Object.hasOwn(parsed, 'search'),
    searchBlock: parsed.search,
  }
}

/**
 * Read the `search` block from the two user-level files, user then custom, and
 * merge them. It never reads project config and never throws: an unparseable
 * file or an invalid block gives one warning and `unreadable: true`.
 */
export function loadUserLevelSearchSettings(
  options?: UserLevelConfigDirOptions,
): UserLevelSearchLoad {
  const dirs = resolveUserLevelConfigDirs(options)
  const files = [
    selectConfigFile(dirs.userConfigDir, 'systematic'),
    ...(dirs.customConfigDir
      ? [selectConfigFile(dirs.customConfigDir, 'systematic')]
      : []),
  ]
  const warnings: string[] = []
  const sources: SearchSettingsSource[] = []
  for (const filePath of files) {
    const read = readSearchBlock(filePath)
    if (read.kind === 'absent') continue
    if (read.kind === 'failed') {
      warnings.push(formatSearchFileWarning(filePath, read.reason))
      sources.push({ unreadable: true })
      continue
    }
    if (!read.has) continue
    const validation = validateSearchConfig(read.searchBlock, 'user', filePath)
    warnings.push(...validation.warnings)
    sources.push({
      settings: validation.settings,
      unreadable: validation.unreadable,
    })
  }
  const merged = mergeSearchSettings(sources)
  return {
    settings: merged.settings,
    unreadable: merged.unreadable,
    warnings,
  }
}

// ── The project-level reader ────────────────────────────────────────────────

export interface ProjectSearchLoad {
  /** The valid proposed sources. Empty for an absent file, a structural error or no `sources`. */
  readonly sources: readonly SearchSourceEntry[]
  /** Bounded warnings. They name fields and source names, never a value. */
  readonly warnings: readonly string[]
  /**
   * The project config is unreadable: the file could not be read (including
   * over `MAX_PROJECT_CONFIG_BYTES`) or parsed, or a container is invalid
   * (`search` is not an object, `sources` is not an array). An invalid entry
   * alone does not set it. This is not the user-config `config unreadable` note.
   */
  readonly unreadable: boolean
}

function formatProjectFileWarning(sourcePath: string, reason: string): string {
  return `[systematic] project search settings in ${displaySafe(sourcePath)} could not be read (${reason}); the sources it proposes were ignored.`
}

/**
 * Read the sources a project config proposes, from the checkout root's
 * `.opencode/systematic.jsonc` (falling back to `.json`, as `getConfigPaths`
 * in `config.ts` does). Bin-safe: it needs no `config.ts`. The read is capped
 * at `MAX_PROJECT_CONFIG_BYTES`, the file is validated with the project rules
 * (`sources` only; `enabled` and `allow_project_sources` are never read), and
 * it never throws. A missing file or a missing `search` block is normal.
 */
export function loadProjectSearchSources(
  checkoutRoot: string,
): ProjectSearchLoad {
  const filePath = selectConfigFile(
    path.join(checkoutRoot, '.opencode'),
    'systematic',
  )
  const read = readSearchBlock(filePath, MAX_PROJECT_CONFIG_BYTES)
  if (read.kind === 'absent') {
    return { sources: [], warnings: [], unreadable: false }
  }
  if (read.kind === 'failed') {
    return {
      sources: [],
      warnings: [formatProjectFileWarning(filePath, read.reason)],
      unreadable: true,
    }
  }
  if (!read.has) return { sources: [], warnings: [], unreadable: false }
  const validation = validateSearchConfig(read.searchBlock, 'project', filePath)
  return {
    sources: validation.structural ? [] : (validation.settings?.sources ?? []),
    warnings: validation.warnings,
    unreadable: validation.structural,
  }
}
