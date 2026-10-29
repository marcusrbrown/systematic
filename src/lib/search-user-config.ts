/**
 * The `search` config field: its zod schema piece, the pure merge rule, the
 * user-level file selection, and a reader that never touches project config.
 *
 * Import rule: this module may import only zod, jsonc-parser, node builtins
 * and TYPES from `search-core.ts`. It must never import `config.ts` or
 * `config-schema.ts`. The `systematic-search` bin bundles it, and
 * pulling in `config.ts` would drag the whole config loader (and its jsonc
 * build) into that bundle. `trustProtected` is applied only in
 * `config-schema.ts`, which imports the schema piece from here.
 *
 * Why it exists as one place: the plugin loader (`config.ts`) and the bin both
 * need "validate the `search` block, then merge user and custom". The block is
 * validated on its own, so a bad `search` block drops with one warning and
 * leaves the rest of the file loading. Search then runs lexical-only with an
 * `unreadable` state. Search must never be the reason the plugin fails to load.
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
import type { SearchSettings } from './search-core.js'

/** Env var names: a letter or underscore first, then letters, digits or underscores. */
const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Bounds on `embeddings.timeout_ms`. The 15,000 ms default is applied at use time in the core. */
export const SEARCH_TIMEOUT_MS_MIN = 500
export const SEARCH_TIMEOUT_MS_MAX = 60_000

const embeddingsSchema = z
  .object({
    provider: z.enum(['ollama', 'openai-compatible'] as const).meta({
      description:
        'Embedding API flavor. `ollama` calls `/api/embed`; `openai-compatible` calls `/embeddings` under `base_url`.',
      examples: ['ollama', 'openai-compatible'],
    }),
    base_url: z
      .string()
      .min(1)
      .meta({
        description:
          'SDK-style root of the embedding endpoint, for example `http://localhost:11434` or `https://api.openai.com/v1`. Only the shape is checked here; the scheme, userinfo, query and fragment are checked when search runs.',
        examples: ['http://localhost:11434', 'https://api.openai.com/v1'],
      }),
    model: z
      .string()
      .min(1)
      .meta({
        description: 'Embedding model name sent to the endpoint.',
        examples: ['nomic-embed-text', 'text-embedding-3-small'],
      }),
    dimensions: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({
        description:
          'Expected vector length. When set, every response must match it. When unset, the first response sets the length.',
        examples: [768, 1536],
      }),
    api_key_env: z
      .string()
      .regex(API_KEY_ENV_PATTERN)
      .optional()
      .meta({
        description:
          'Name of the environment variable that holds the API key. The key itself is never stored in config. If the variable is unset or empty, no key is sent.',
        examples: ['OPENAI_API_KEY'],
      }),
    query_prefix: z
      .string()
      .optional()
      .meta({
        description:
          'Text prepended to the query before embedding, for models that need task prefixes.',
        examples: ['search_query: '],
      }),
    document_prefix: z
      .string()
      .optional()
      .meta({
        description:
          'Text prepended to each document chunk before embedding, for models that need task prefixes (nomic-embed-text does).',
        examples: ['search_document: '],
      }),
    timeout_ms: z
      .number()
      .int()
      .min(SEARCH_TIMEOUT_MS_MIN)
      .max(SEARCH_TIMEOUT_MS_MAX)
      .optional()
      .meta({
        description: `Per-request timeout in milliseconds, from ${SEARCH_TIMEOUT_MS_MIN} to ${SEARCH_TIMEOUT_MS_MAX}. When unset, search uses 15000.`,
        examples: [15_000],
      }),
  })
  .strict()
  .meta({
    description:
      'Embedding endpoint for the optional semantic lane. Replaced as a whole by the last source that defines it.',
    examples: [
      {
        provider: 'ollama',
        base_url: 'http://localhost:11434',
        model: 'nomic-embed-text',
      },
    ],
  })

/**
 * The `search` block. No zod defaults anywhere: an absent `search` stays
 * absent, and the core applies its own defaults at use time.
 */
export const SearchSettingsSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .meta({
        description:
          'Set to false to remove the search tool. Defaults to true when unset.',
        examples: [false],
      }),
    embeddings: embeddingsSchema.optional(),
  })
  .strict()
  .meta({
    description:
      'Durable-output search settings. Lexical search needs none. Only user config and OPENCODE_CONFIG_DIR config may set this field; a project config that sets it has the whole field ignored with a warning, so a repository cannot point search at an endpoint or switch it off. An invalid block is dropped with a warning and search runs lexical-only; the rest of the file still loads.',
    examples: [
      { enabled: false },
      {
        embeddings: {
          provider: 'ollama',
          base_url: 'http://localhost:11434',
          model: 'nomic-embed-text',
          document_prefix: 'search_document: ',
          query_prefix: 'search_query: ',
        },
      },
    ],
  })

/** What a successful parse of the `search` block yields. Assignable to the core's `SearchSettings`. */
export type SearchSchemaOutput = z.output<typeof SearchSettingsSchema>

// ── Validating one block ────────────────────────────────────────────────────

export type SearchBlockValidation =
  | { readonly ok: true; readonly settings: SearchSchemaOutput }
  | { readonly ok: false; readonly fields: readonly string[] }

/**
 * Validate a raw `search` value on its own. A failure lists the offending
 * field paths (`search.embeddings.timeout_ms`) and never a value: a path from
 * a strict object names the parent for an unknown key, so a user-authored key
 * name is not echoed either.
 */
export function validateSearchBlock(value: unknown): SearchBlockValidation {
  const parsed = SearchSettingsSchema.safeParse(value)
  if (parsed.success) return { ok: true, settings: parsed.data }
  const fields: string[] = []
  for (const issue of parsed.error.issues) {
    const field = ['search', ...issue.path.map(String)].join('.')
    if (!fields.includes(field)) fields.push(field)
  }
  return { ok: false, fields }
}

const MAX_WARNING_FIELDS = 5
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

/** The one warning for a `search` block that failed its schema. It names fields and no value. */
export function formatSearchBlockWarning(
  sourcePath: string,
  fields: readonly string[],
): string {
  const shown = fields.slice(0, MAX_WARNING_FIELDS).join(', ')
  const more =
    fields.length > MAX_WARNING_FIELDS
      ? ` and ${fields.length - MAX_WARNING_FIELDS} more`
      : ''
  return `[systematic] \`search\` in ${displaySafe(sourcePath)} is invalid (${shown}${more}) and has been ignored; search runs lexical-only (config unreadable). The rest of the file still loads.`
}

/** The one warning for a user-level file the reader could not parse. */
function formatSearchFileWarning(sourcePath: string, reason: string): string {
  return `[systematic] search settings in ${displaySafe(sourcePath)} could not be read (${reason}); search runs lexical-only (config unreadable).`
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
}

export interface MergedSearchSettings {
  readonly settings: SearchSettings | undefined
  readonly unreadable: boolean
}

/**
 * The one merge rule, used by both `config.ts` and the reader. Sources arrive
 * in priority order, user then custom. `enabled` takes the last source that
 * defines it, and `embeddings` is replaced whole by the last source that
 * defines it, so a custom endpoint never inherits a user `api_key_env`.
 * `unreadable` is set when any source was.
 */
export function mergeSearchSettings(
  sources: readonly SearchSettingsSource[],
): MergedSearchSettings {
  let enabled: SearchSettings['enabled']
  let embeddings: SearchSettings['embeddings']
  let unreadable = false
  for (const source of sources) {
    if (source.unreadable) unreadable = true
    if (source.settings?.enabled !== undefined)
      enabled = source.settings.enabled
    if (source.settings?.embeddings !== undefined) {
      embeddings = source.settings.embeddings
    }
  }
  if (enabled === undefined && embeddings === undefined) {
    return { settings: undefined, unreadable }
  }
  return {
    settings: {
      ...(enabled !== undefined && { enabled }),
      ...(embeddings !== undefined && { embeddings }),
    },
    unreadable,
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

// ── The user-level reader ───────────────────────────────────────────────────

export interface UserLevelSearchLoad {
  readonly settings: SearchSettings | undefined
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSearchBlock(filePath: string): FileRead {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'failed', reason: 'unable to read file' }
  }
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
    const validation = validateSearchBlock(read.searchBlock)
    if (validation.ok) {
      sources.push({ settings: validation.settings, unreadable: false })
    } else {
      warnings.push(formatSearchBlockWarning(filePath, validation.fields))
      sources.push({ unreadable: true })
    }
  }
  const merged = mergeSearchSettings(sources)
  return { ...merged, warnings }
}
