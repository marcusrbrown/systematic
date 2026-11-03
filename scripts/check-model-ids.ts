#!/usr/bin/env bun
/**
 * Check every `provider/model` ID Systematic ships against the models.dev
 * catalog. Dev-only: nothing runs this in CI, and it is not part of the
 * published package. Run it before approving a release PR that touches the
 * OMO profile or model IDs (see RELEASING.md).
 *
 * Scanned (committed or untracked-but-not-ignored files only):
 *   - registry/files/profiles/omo/**   the OMO profile and its AGENTS.md
 *   - docs/public/schemas/**           the committed config schema JSON
 *   - docs/src/content/docs/**         the docs pages
 * Not scanned: skills/**, dist/, TypeScript source, tests, docs/plans,
 * docs/solutions. Bundled agents carry no model IDs.
 *
 * Usage:
 *   bun scripts/check-model-ids.ts            # catalog from OpenCode's local cache
 *   bun scripts/check-model-ids.ts --fetch    # catalog from models.dev, in memory
 *
 * Environment:
 *   OPENCODE_MODELS_PATH   catalog file to read (overrides the cache location)
 *   XDG_CACHE_HOME         cache root; default is ~/.cache
 *   OPENCODE_MODELS_URL    catalog URL for --fetch; default https://models.dev/api.json
 *
 * Exit codes:
 *   0  every checked ID is in the catalog and not deprecated
 *   1  at least one ID is missing (or is not a complete token) or deprecated, or
 *      a variant is not one of the model's effort values
 *   2  no usable catalog (missing, unparseable, no providers, no model entries, a
 *      malformed model entry, fetch failed), a source-discovery or file-read
 *      failure, or bad usage
 *
 * The script never writes: not the files it checks and not OpenCode's cache.
 *
 * Known limit: models.dev can lag provider deprecations. `openai/gpt-5.3-codex`
 * was still listed without `status: deprecated` after OpenAI announced its API
 * shutdown (2027-04-01) and Codex sign-in dropped it. A pass here does not
 * replace reading the providers' own deprecation pages. The script does no
 * provider-specific scraping, on purpose.
 *
 * Known limit: a token is only recognised when its provider is a key in the
 * catalog, which is how `src/lib` and `docs/plans` stay out of the results. A
 * typo in the provider part (`anthopic/claude-opus-5-5`) is therefore not seen.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Node, parseTree } from 'jsonc-parser'

export const DEFAULT_MODELS_URL = 'https://models.dev/api.json'

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

/** Directories scanned, relative to the repo root. */
const SCANNED_DIRS = [
  'registry/files/profiles/omo',
  'docs/public/schemas',
  'docs/src/content/docs',
] as const

const SCANNED_EXTENSIONS = new Set(['.json', '.jsonc', '.md', '.mdx'])
const STRUCTURED_EXTENSIONS = new Set(['.json', '.jsonc'])

/**
 * One skipped occurrence: an exact path, the raw token as written (including
 * any `+suffix`) and why it is not a live ID. The match is on path and token
 * together. A whole path is never skipped, so a new stale ID on the same page
 * still fails.
 */
export interface ModelIdException {
  path: string
  id: string
  reason: string
}

const MIGRATION_PAGE =
  'docs/src/content/docs/guides/model-defaults-migration.mdx'
const RETIRED_DEFAULT =
  'Retired default recorded in the migration history table; migrating users need to recognize it.'

export const EXCEPTIONS: readonly ModelIdException[] = [
  ...[
    'github-copilot/gemini-3.1-pro-preview',
    'openai/gpt-5.5+high',
    'anthropic/claude-opus-4-7+max',
    'vercel/v0-1.5-md',
    'opencode/claude-sonnet-4-6',
    'openai/gpt-5.4-mini',
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.3-codex',
    'opencode/claude-haiku-4-5',
    'opencode-go/claude-haiku-4-5',
  ].map((id) => ({ path: MIGRATION_PAGE, id, reason: RETIRED_DEFAULT })),
  {
    path: 'docs/public/schemas/v3/systematic-config.schema.json',
    id: 'opencode/pi',
    reason:
      'Prose in a field description ("the opencode/pi harness blocks"), not a model ID.',
  },
]

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogModel {
  status?: unknown
  reasoning_options?: unknown
}

export interface ModelCatalog {
  providers: Record<string, { models: Record<string, CatalogModel> }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse models.dev / OpenCode `models.json`: an object keyed by provider, each with a `models` map of model objects. */
export function parseCatalog(text: string): ModelCatalog {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `catalog could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isRecord(raw)) {
    throw new Error('catalog is not a JSON object keyed by provider')
  }
  const providers: ModelCatalog['providers'] = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isRecord(value.models)) continue
    for (const [modelName, entry] of Object.entries(value.models)) {
      if (!isRecord(entry)) {
        throw new Error(
          `catalog has a malformed model entry: ${name}/${modelName} is not an object`,
        )
      }
    }
    providers[name] = { models: value.models as Record<string, CatalogModel> }
  }
  if (Object.keys(providers).length === 0) {
    throw new Error('catalog has no providers with a models map')
  }
  if (
    Object.values(providers).every((p) => Object.keys(p.models).length === 0)
  ) {
    throw new Error('catalog has no model entries in any provider')
  }
  return { providers }
}

/** Where the local catalog lives. Empty variables count as unset. */
export function resolveCatalogPath(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  if (env.OPENCODE_MODELS_PATH) return env.OPENCODE_MODELS_PATH
  if (env.XDG_CACHE_HOME) {
    return path.join(env.XDG_CACHE_HOME, 'opencode', 'models.json')
  }
  return path.join(homedir, '.cache', 'opencode', 'models.json')
}

function lookupModel(
  catalog: ModelCatalog,
  provider: string,
  model: string,
): CatalogModel | undefined {
  if (!Object.hasOwn(catalog.providers, provider)) return undefined
  const { models } = catalog.providers[provider] ?? { models: {} }
  return Object.hasOwn(models, model) ? models[model] : undefined
}

/** Values of every `type: "effort"` reasoning option, or `undefined` when the model has none. */
function effortValues(model: CatalogModel): string[] | undefined {
  if (!Array.isArray(model.reasoning_options)) return undefined
  const efforts = model.reasoning_options.filter(
    (option): option is { type: 'effort'; values: unknown } =>
      isRecord(option) && option.type === 'effort',
  )
  if (efforts.length === 0) return undefined
  return efforts.flatMap((option) =>
    Array.isArray(option.values)
      ? option.values.filter((v): v is string => typeof v === 'string')
      : [],
  )
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface Occurrence {
  /** `provider/model`, without any variant. */
  id: string
  provider: string
  model: string
  variant?: string
  /** The token as written, including `+variant`. */
  raw: string
  file: string
  line: number
  /** Zero-based character offset of the token in the file text. */
  offset: number
  /**
   * Set when the text names a known provider but is not a complete token: stray
   * characters follow it, or a JSON `model` value has characters left over.
   * `raw` is then the whole offending text, and the check reports it as missing.
   */
  malformed?: true
}

// Provider, then the model after the first `/` (which may itself contain `/`,
// as in `openrouter/anthropic/...`), then an optional `+variant`. Model parts
// end on a letter, digit or underscore so sentence punctuation is not taken.
const SEGMENT = '[A-Za-z0-9](?:[\\w.:@-]*\\w)?'
const TOKEN_BODY = `([a-z0-9][a-z0-9_-]*)\\/(${SEGMENT}(?:\\/${SEGMENT})*)(?:\\+([A-Za-z][\\w-]*))?`
// In prose the lookbehind keeps path segments, URLs and `a/b/c` tails out.
const TOKEN_PATTERN = new RegExp(`(?<![\\w@./:~+-])${TOKEN_BODY}`, 'g')
// A JSON `model` value must be exactly one token.
const TOKEN_WHOLE = new RegExp(`^${TOKEN_BODY}$`)
// What may not directly follow a token in prose: a character the pattern left
// unconsumed that would make it a longer, different token. Sentence
// punctuation (a `.` or `:` before a space) is fine.
const STRAY_AFTER = /^(?:[-+@/]|[.:]\w)/
const STRAY_RUN = /^[\w.:@+/-]*/

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Occurrences found in running text, including malformed ones. */
function scanText(
  file: string,
  text: string,
  providers: ReadonlySet<string>,
): Occurrence[] {
  const found: Occurrence[] = []
  let lineStart = 0
  text.split('\n').forEach((lineText, index) => {
    for (const match of lineText.matchAll(TOKEN_PATTERN)) {
      const [matched, provider, model, variant] = match
      if (!provider || !model || !providers.has(provider)) continue
      const where = {
        file,
        line: index + 1,
        offset: lineStart + match.index,
      }
      const rest = lineText.slice(match.index + matched.length)
      if (STRAY_AFTER.test(rest)) {
        const raw = (matched + (STRAY_RUN.exec(rest)?.[0] ?? '')).replace(
          /[.:]+$/,
          '',
        )
        found.push({
          id: raw,
          provider,
          model: raw.slice(provider.length + 1),
          raw,
          malformed: true,
          ...where,
        })
        continue
      }
      found.push({
        id: `${provider}/${model}`,
        provider,
        model,
        ...(variant ? { variant } : {}),
        raw: matched,
        ...where,
      })
    }
    lineStart += lineText.length + 1
  })
  return found
}

interface JsonModelValue {
  /** Source range of the `model` string value, quotes included. */
  start: number
  end: number
  /** The decoded string. */
  value: string
  /** The sibling `variant` string, when the object has one. */
  variant?: string
}

/** The string-valued `model` node of an object node, with its sibling `variant` string if any. */
function modelValueOf(node: Node): JsonModelValue | undefined {
  if (node.type !== 'object') return undefined
  const values = new Map<string, Node>()
  for (const property of node.children ?? []) {
    const [key, value] = property.children ?? []
    if (key && value && typeof key.value === 'string') {
      values.set(key.value, value)
    }
  }
  const model = values.get('model')
  if (model?.type !== 'string' || typeof model.value !== 'string') {
    return undefined
  }
  const variant = values.get('variant')
  return {
    start: model.offset,
    end: model.offset + model.length,
    value: model.value,
    ...(variant?.type === 'string' && typeof variant.value === 'string'
      ? { variant: variant.value }
      : {}),
  }
}

/**
 * Every string `model` value in a JSON/JSONC document, keyed by source range.
 * Offsets, not lines: one line can hold several model objects.
 */
function jsonModelValues(text: string): JsonModelValue[] {
  const values: JsonModelValue[] = []
  const visit = (node: Node | undefined): void => {
    if (!node) return
    const entry = modelValueOf(node)
    if (entry) values.push(entry)
    for (const child of node.children ?? []) visit(child)
  }
  visit(parseTree(text, [], { allowTrailingComma: true }))
  return values
}

/**
 * In JSON/JSONC, a `model` value must be one complete token. Where it is, it
 * picks up its sibling `variant`. Where it is not but still holds a known
 * provider's token (a trailing `-`, a leading space, two IDs), the text inside
 * is replaced by one malformed occurrence with the whole value as `raw`.
 */
function applyJsonModelValues(
  file: string,
  text: string,
  found: Occurrence[],
  providers: ReadonlySet<string>,
): Occurrence[] {
  let result = found
  for (const entry of jsonModelValues(text)) {
    const inside = (o: Occurrence) =>
      o.offset >= entry.start && o.offset < entry.end
    const whole = TOKEN_WHOLE.exec(entry.value)
    if (whole?.[1] && providers.has(whole[1])) {
      const { variant } = entry
      if (variant) {
        result = result.map((o) =>
          inside(o) && !o.variant ? { ...o, variant } : o,
        )
      }
    } else if (result.some(inside)) {
      const slash = entry.value.indexOf('/')
      result = [
        ...result.filter((o) => !inside(o)),
        {
          id: entry.value,
          provider: entry.value.slice(0, slash),
          model: entry.value.slice(slash + 1),
          raw: entry.value,
          malformed: true,
          file,
          line: lineOf(text, entry.start),
          offset: entry.start,
        },
      ]
    }
  }
  return result.sort((a, b) => a.offset - b.offset)
}

/**
 * Every `provider/model[+variant]` token whose provider is in `providers`.
 * Every occurrence is reported; dedup is the caller's concern. A token must be
 * complete: stray characters after it make it malformed instead of letting its
 * valid prefix pass. In `.json` and `.jsonc` files a `model` value is checked
 * whole and also picks up its sibling `variant` key.
 */
export function extractOccurrences(
  file: string,
  text: string,
  providers: ReadonlySet<string>,
): Occurrence[] {
  const found = scanText(file, text, providers)
  return STRUCTURED_EXTENSIONS.has(path.extname(file))
    ? applyJsonModelValues(file, text, found, providers)
    : found
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export type FindingKind = 'missing' | 'deprecated' | 'bad-variant'

export interface Finding {
  kind: FindingKind
  occurrence: Occurrence
  detail?: string
}

export interface CheckResult {
  findings: Finding[]
  /** Occurrences whose variant could not be checked: the model has no effort entry. */
  unchecked: Occurrence[]
  /** Occurrences skipped by the exception list. */
  skipped: { occurrence: Occurrence; exception: ModelIdException }[]
  /** Occurrences that were looked up in the catalog. */
  checked: Occurrence[]
}

export function checkOccurrences(
  occurrences: readonly Occurrence[],
  catalog: ModelCatalog,
  exceptions: readonly ModelIdException[] = EXCEPTIONS,
): CheckResult {
  const result: CheckResult = {
    findings: [],
    unchecked: [],
    skipped: [],
    checked: [],
  }
  for (const occurrence of occurrences) {
    const exception = exceptions.find(
      (e) => e.path === occurrence.file && e.id === occurrence.raw,
    )
    if (exception) {
      result.skipped.push({ occurrence, exception })
      continue
    }
    result.checked.push(occurrence)

    if (occurrence.malformed) {
      result.findings.push({
        kind: 'missing',
        occurrence,
        detail: 'not a complete provider/model ID',
      })
      continue
    }
    const model = lookupModel(catalog, occurrence.provider, occurrence.model)
    if (!model) {
      result.findings.push({ kind: 'missing', occurrence })
      continue
    }
    if (model.status === 'deprecated') {
      result.findings.push({ kind: 'deprecated', occurrence })
      continue
    }
    if (!occurrence.variant) continue

    const efforts = effortValues(model)
    if (!efforts) {
      result.unchecked.push(occurrence)
    } else if (!efforts.includes(occurrence.variant)) {
      result.findings.push({
        kind: 'bad-variant',
        occurrence,
        detail: `variant "${occurrence.variant}" is not one of: ${efforts.join(', ')}`,
      })
    }
  }
  return result
}

/** 0 when nothing failed, 1 otherwise. A variant that could not be checked never fails the run. */
export function exitCodeFor(result: CheckResult): 0 | 1 {
  return result.findings.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface SourceFile {
  path: string
  text: string
}

export interface CliDeps {
  env: Record<string, string | undefined>
  homedir: string
  readText(filePath: string): Promise<string>
  mtime(filePath: string): Promise<Date>
  fetchText(url: string): Promise<string>
  /** Repo-relative paths of the files to scan. */
  listSources(): Promise<string[]>
  /** Text of one path returned by `listSources`. */
  readSource(file: string): Promise<string>
}

export interface CliResult {
  exitCode: 0 | 1 | 2
  stdout: string
  stderr: string
}

const USAGE = 'usage: bun scripts/check-model-ids.ts [--fetch]'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Load the catalog and describe where it came from. Throws when none is usable. */
async function loadCatalog(
  useFetch: boolean,
  deps: CliDeps,
): Promise<{ catalog: ModelCatalog; source: string }> {
  if (useFetch) {
    const url = deps.env.OPENCODE_MODELS_URL || DEFAULT_MODELS_URL
    let text: string
    try {
      text = await deps.fetchText(url)
    } catch (error) {
      throw new Error(
        `no catalog available: fetch failed (${describeError(error)})`,
      )
    }
    return {
      catalog: parseCatalog(text),
      source: `${url} (fetched into memory; local cache not read)`,
    }
  }

  const catalogPath = resolveCatalogPath(deps.env, deps.homedir)
  let text: string
  let modified: Date
  try {
    text = await deps.readText(catalogPath)
    modified = await deps.mtime(catalogPath)
  } catch (error) {
    throw new Error(
      `no catalog available: could not read ${catalogPath} (${describeError(error)}). Install or run OpenCode to create it, set OPENCODE_MODELS_PATH, or pass --fetch.`,
    )
  }
  return {
    catalog: parseCatalog(text),
    source: `${catalogPath} (cache modified ${modified.toISOString()})`,
  }
}

function formatSkipped(skipped: CheckResult['skipped']): string[] {
  const grouped = new Map<ModelIdException, number[]>()
  for (const { occurrence, exception } of skipped) {
    grouped.set(exception, [...(grouped.get(exception) ?? []), occurrence.line])
  }
  const lines = [...grouped].map(
    ([exception, at]) =>
      `  ${exception.path}  ${exception.id}  (line ${at.join(', ')})`,
  )
  for (const reason of new Set([...grouped.keys()].map((e) => e.reason))) {
    lines.push(`  - ${reason}`)
  }
  return ['', `Skipped by exception (${skipped.length} occurrences):`, ...lines]
}

function formatReport(
  source: string,
  fileCount: number,
  result: CheckResult,
): string {
  const distinct = new Set(result.checked.map((o) => o.id))
  const out: string[] = [
    `Catalog: ${source}`,
    `Scanned ${fileCount} files: checked ${result.checked.length} occurrences of ${distinct.size} distinct IDs.`,
  ]
  if (result.skipped.length > 0) out.push(...formatSkipped(result.skipped))
  if (result.unchecked.length > 0) {
    out.push(
      '',
      `Variant not checked (${result.unchecked.length}): model has no effort entry`,
    )
    for (const o of result.unchecked) {
      out.push(`  ${o.file}:${o.line}  ${o.id}+${o.variant}`)
    }
  }
  if (result.findings.length === 0) {
    out.push('', 'OK: every checked ID is in the catalog and not deprecated.')
  } else {
    out.push('', `FAIL: ${result.findings.length} problem(s)`)
    for (const { kind, occurrence, detail } of result.findings) {
      out.push(
        `  ${kind.padEnd(11)} ${occurrence.file}:${occurrence.line}  ${occurrence.raw}${detail ? `  ${detail}` : ''}`,
      )
    }
  }
  return `${out.join('\n')}\n`
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  const unknown = argv.filter((arg) => arg !== '--fetch')
  if (unknown.length > 0) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `unknown argument: ${unknown.join(' ')}\n${USAGE}\n`,
    }
  }

  let loaded: Awaited<ReturnType<typeof loadCatalog>>
  try {
    loaded = await loadCatalog(argv.includes('--fetch'), deps)
  } catch (error) {
    return fail(describeError(error))
  }

  let sources: SourceFile[]
  try {
    sources = await readSources(deps)
  } catch (error) {
    return fail(describeError(error))
  }

  const providers = new Set(Object.keys(loaded.catalog.providers))
  const result = checkOccurrences(
    sources.flatMap((file) =>
      extractOccurrences(file.path, file.text, providers),
    ),
    loaded.catalog,
  )
  return {
    exitCode: exitCodeFor(result),
    stdout: formatReport(loaded.source, sources.length, result),
    stderr: '',
  }
}

function fail(message: string): CliResult {
  return { exitCode: 2, stdout: '', stderr: `${message}\n` }
}

/** List the files to scan and read them. Any failure names the step or the file. */
async function readSources(deps: CliDeps): Promise<SourceFile[]> {
  let paths: string[]
  try {
    paths = await deps.listSources()
  } catch (error) {
    throw new Error(`source discovery failed: ${describeError(error)}`)
  }
  const sources: SourceFile[] = []
  for (const file of paths) {
    try {
      sources.push({ path: file, text: await deps.readSource(file) })
    } catch (error) {
      throw new Error(`could not read ${file}: ${describeError(error)}`)
    }
  }
  return sources
}

async function listRepoSources(): Promise<string[]> {
  // git decides what is a source file: it skips ignored output such as the
  // docs pages generated from skills/**, and needs no hand-written globs.
  const listing = execFileSync(
    'git',
    [
      '-C',
      ROOT_DIR,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCANNED_DIRS,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const files = [...new Set(listing.split('\0').filter(Boolean))]
    .filter((file) => SCANNED_EXTENSIONS.has(path.extname(file)))
    .sort()
  return keepPresent(files, (file) => fs.access(path.join(ROOT_DIR, file)))
}

/**
 * `git ls-files --cached` also lists files deleted from the working tree. Skip
 * only those (ENOENT); any other access failure would silently shrink the scan,
 * so it is rethrown with the path and `runCli` exits 2.
 */
export async function keepPresent(
  files: readonly string[],
  access: (file: string) => Promise<unknown>,
): Promise<string[]> {
  const present: string[] = []
  for (const file of files) {
    try {
      await access(file)
      present.push(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return present
}

const realDeps: CliDeps = {
  env: process.env,
  homedir: os.homedir(),
  readText: (filePath) => fs.readFile(filePath, 'utf8'),
  mtime: async (filePath) => (await fs.stat(filePath)).mtime,
  fetchText: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`)
    }
    return response.text()
  },
  listSources: listRepoSources,
  readSource: (file) => fs.readFile(path.join(ROOT_DIR, file), 'utf8'),
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), realDeps)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}
