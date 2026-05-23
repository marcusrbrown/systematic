import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser'
import type { z } from 'zod'
import {
  SECURITY_OVERLAY_FIELDS as SCHEMA_SECURITY_OVERLAY_FIELDS,
  SystematicConfigSchema,
} from './config-schema.js'

export interface BootstrapConfig {
  enabled: boolean
  file?: string
}

export type OverlayConfig = Record<string, unknown>

export type OverlayConfigMap = Record<string, OverlayConfig>

export interface SourcedOverlayConfig {
  value: OverlayConfig
  sourcePath: string
  keyPath: string
}

export interface SourcedOverlayConfigMap {
  agents: Record<string, SourcedOverlayConfig>
  categories: Record<string, SourcedOverlayConfig>
}

export interface SourceAwareConfigResult {
  config: SystematicConfig
  overlays: SourcedOverlayConfigMap
}

export interface SystematicConfig {
  disabled_skills: string[]
  disabled_agents: string[]
  disabled_commands: string[]
  bootstrap: BootstrapConfig
  agents?: OverlayConfigMap
  categories?: OverlayConfigMap
}

export const DEFAULT_CONFIG: SystematicConfig = {
  disabled_skills: [],
  disabled_agents: [],
  disabled_commands: [],
  bootstrap: {
    enabled: true,
  },
  agents: {},
  categories: {},
}

interface RawSystematicConfig
  extends Omit<Partial<SystematicConfig>, 'agents' | 'categories'> {
  agents?: unknown
  categories?: unknown
}

interface ConfigSource {
  path: string
  config: RawSystematicConfig
  trust: 'user' | 'project' | 'custom'
}

const SECURITY_OVERLAY_FIELDS = new Set(SCHEMA_SECURITY_OVERLAY_FIELDS)

/**
 * Resolve a config file path by checking `.jsonc` first, then `.json`.
 * Returns the first existing file, or the `.json` path as fallback so
 * callers that `fs.existsSync` the result still work.
 */
function resolveConfigPath(dir: string, basename: string): string {
  const jsoncPath = path.join(dir, `${basename}.jsonc`)
  if (fs.existsSync(jsoncPath)) return jsoncPath
  return path.join(dir, `${basename}.json`)
}

function isErrorWithCode(error: unknown): error is Error & { code?: unknown } {
  return error instanceof Error && 'code' in error
}

function loadJsoncFile(filePath: string): RawSystematicConfig | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') return null
    throw new Error(
      `Invalid Systematic config in ${filePath}: unable to read file`,
      { cause: error },
    )
  }

  const errors: ParseError[] = []
  const parsed = parseJsonc(content, errors) as unknown
  if (errors.length > 0) {
    const error = errors[0]
    const message = error
      ? `${printParseErrorCode(error.error)} at offset ${error.offset}`
      : 'unknown parse error'
    throw new Error(
      `Invalid Systematic config in ${filePath}: JSONC parse error: ${message}`,
    )
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Invalid Systematic config in ${filePath}: root must be an object`,
    )
  }

  return parsed as RawSystematicConfig
}

/**
 * Documentation URL for the full list of valid bundled agent and skill names.
 * Appended to unrecognized-key error messages so users can self-serve without
 * having to dump all 100+ names inline in the error.
 */
const TYPED_VALIDATION_DOCS_URL =
  'https://fro.bot/systematic/reference/configuration#typed-validation'

/**
 * Fields in the top-level config where an unrecognized key means a typo'd
 * bundled name. For these paths we append the docs URL to the error message.
 */
const TYPED_KEY_FIELDS = new Set([
  'agents',
  'disabled_agents',
  'disabled_skills',
])

/**
 * Format the human-readable hint for unrecognized-key issues. Requires a
 * non-empty `badKeys` array — Zod 4's $ZodIssueUnrecognizedKeys carries at
 * least one key by construction, so the empty case is unreachable in practice.
 */
function formatUnrecognizedKeysHint(
  badKeys: readonly string[],
  topField: string,
): string {
  if (badKeys.length === 0) {
    // Defensive: Zod 4's $ZodIssueUnrecognizedKeys always carries non-empty
    // keys; this branch is unreachable under the current Zod 4 contract.
    throw new Error('formatUnrecognizedKeysHint requires non-empty keys')
  }
  if (badKeys.length === 1) {
    return `Unrecognized key '${badKeys[0]}' in \`${topField}\`. This must be a bundled name. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
  }
  const joined = badKeys.map((k) => `'${k}'`).join(', ')
  return `Unrecognized keys ${joined} in \`${topField}\`. These must be bundled names. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
}

/**
 * Post-process Zod issues to enrich unrecognized-key errors on typed fields
 * (agents, disabled_agents, disabled_skills) with a pointer to the docs URL
 * where the full list of valid bundled names is published.
 *
 * Also suppresses the verbose enum list that Zod emits for invalid_value
 * issues on disabled_agents and disabled_skills, replacing it with a short
 * hint that surfaces the bad value and points at the docs URL.
 *
 * Returns the issues array unchanged when no enrichment is needed.
 */
function enrichUnrecognizedKeyIssues(
  issues: readonly z.core.$ZodIssue[],
  rawInput: unknown,
): readonly z.core.$ZodIssue[] {
  return issues.map((issue) => {
    const topField = issue.path[0]
    if (typeof topField !== 'string' || !TYPED_KEY_FIELDS.has(topField)) {
      return issue
    }

    // Handle unrecognized_keys (typo'd agents overlay keys).
    // Use issue.keys (Zod 4 structured field) — avoids regex and handles any key value.
    if (issue.code === 'unrecognized_keys') {
      const hint = formatUnrecognizedKeysHint(issue.keys, topField)
      return { ...issue, message: hint }
    }

    // Handle invalid_value (typo'd disabled_agents / disabled_skills entries) —
    // suppress the verbose enum list Zod emits by default.
    // Zod 4's $ZodIssueInvalidValue does not carry the bad value in the issue
    // object itself, so we resolve it from the raw input via the issue path.
    if (
      issue.code === 'invalid_value' &&
      (topField === 'disabled_agents' || topField === 'disabled_skills')
    ) {
      const badValue = resolveValueAtPath(rawInput, issue.path)
      const kind = topField === 'disabled_agents' ? 'agent' : 'skill'
      const hint =
        typeof badValue === 'string'
          ? `Unrecognized ${kind} name '${badValue}' in \`${topField}\`. This must be a bundled name. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
          : `Invalid value in \`${topField}\`. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
      return { ...issue, message: hint }
    }

    return issue
  })
}

/**
 * Walk a path of string/number keys into a nested object/array structure and
 * return the value at that location, or undefined if any step is missing.
 */
function resolveValueAtPath(
  root: unknown,
  path: readonly (string | number | symbol)[],
): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (typeof segment === 'symbol') {
      // Defensive: Zod 4's path type includes symbol, but issues never carry
      // symbol segments at runtime. If a future Zod release changes that, this
      // returns undefined so the fallback "Invalid value" hint is used instead
      // of crashing.
      return undefined
    }
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (!isRecord(current)) return undefined
      current = current[segment]
    }
  }
  return current
}

function throwTopLevelConfigSchemaError(
  filePath: string,
  trust: ConfigSource['trust'],
  rawIssues: readonly z.core.$ZodIssue[],
  rawInput: unknown,
): never {
  const issues = enrichUnrecognizedKeyIssues(rawIssues, rawInput)
  // Defensive fallback. Zod 4 invariant: safeParse never returns success: false with an
  // empty issues array, but enrichUnrecognizedKeyIssues is a pure transform and could in
  // principle yield zero entries from a future Zod that emits issues we filter out.
  if (issues.length === 0) {
    throw Object.assign(
      new Error(
        `Invalid Systematic config in ${filePath}: schema validation failed`,
      ),
      { _tag: 'ConfigSchemaError' as const, filePath, trust, issues },
    )
  }
  const formatIssue = (issue: z.core.$ZodIssue): string => {
    const fieldPath =
      issue.code === 'unrecognized_keys' ? null : issue.path.join('.')
    return fieldPath ? `${fieldPath} ${issue.message}` : issue.message
  }
  const formatted = issues.map(formatIssue)
  // Single-issue case keeps the one-line shape for backward compatibility with existing
  // user expectations. Multi-issue case uses a bullet list so every problem surfaces.
  const message =
    formatted.length === 1
      ? `Invalid Systematic config in ${filePath}: ${formatted[0]}`
      : `Invalid Systematic config in ${filePath}:\n${formatted.map((entry) => `  - ${entry}`).join('\n')}`
  throw Object.assign(new Error(message), {
    _tag: 'ConfigSchemaError' as const,
    filePath,
    trust,
    issues,
  })
}

function loadConfigSource(
  filePath: string,
  trust: ConfigSource['trust'],
): ConfigSource | null {
  const rawConfig = loadJsoncFile(filePath)
  if (!rawConfig) return null

  const result = SystematicConfigSchema.safeParse(rawConfig)
  if (!result.success) {
    throwTopLevelConfigSchemaError(
      filePath,
      trust,
      result.error.issues,
      rawConfig,
    )
  }

  // Validation succeeded; propagate raw parsed JSONC so the merge layer
  // sees undefined for unset fields (preserves merge semantics where a
  // higher-priority empty config does NOT override a lower-priority explicit
  // setting). The schema's defaults are applied by the merge layer via
  // DEFAULT_CONFIG at the top of the spread chain.
  return { path: filePath, config: rawConfig, trust }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeArraysUnique<T>(
  arr1: T[] | undefined,
  arr2: T[] | undefined,
): T[] {
  const set = new Set<T>()
  if (arr1) for (const item of arr1) set.add(item)
  if (arr2) for (const item of arr2) set.add(item)
  return Array.from(set)
}

export function loadConfig(projectDir: string): SystematicConfig {
  return loadConfigWithSources(projectDir).config
}

export function loadConfigWithSources(
  projectDir: string,
): SourceAwareConfigResult {
  const paths = getConfigPaths(projectDir)

  const userSource = loadConfigSource(paths.userConfig, 'user')
  const projectSource = loadConfigSource(paths.projectConfig, 'project')
  const customSource = paths.customConfig
    ? loadConfigSource(paths.customConfig, 'custom')
    : null
  const sources = [userSource, projectSource, customSource].filter(
    (source): source is ConfigSource => source !== null,
  )

  const overlays = mergeOverlaySources(sources)
  const userConfig = userSource?.config
  const projectConfig = projectSource?.config
  const customConfig = customSource?.config

  const result: SystematicConfig = {
    disabled_skills: mergeArraysUnique(
      mergeArraysUnique(
        mergeArraysUnique(
          DEFAULT_CONFIG.disabled_skills,
          userConfig?.disabled_skills,
        ),
        projectConfig?.disabled_skills,
      ),
      customConfig?.disabled_skills,
    ),
    disabled_agents: mergeArraysUnique(
      mergeArraysUnique(
        mergeArraysUnique(
          DEFAULT_CONFIG.disabled_agents,
          userConfig?.disabled_agents,
        ),
        projectConfig?.disabled_agents,
      ),
      customConfig?.disabled_agents,
    ),
    disabled_commands: mergeArraysUnique(
      mergeArraysUnique(
        mergeArraysUnique(
          DEFAULT_CONFIG.disabled_commands,
          userConfig?.disabled_commands,
        ),
        projectConfig?.disabled_commands,
      ),
      customConfig?.disabled_commands,
    ),
    bootstrap: {
      ...DEFAULT_CONFIG.bootstrap,
      ...userConfig?.bootstrap,
      ...projectConfig?.bootstrap,
      ...customConfig?.bootstrap,
    },
    agents: overlayValues(overlays.agents),
    categories: overlayValues(overlays.categories),
  }

  return { config: result, overlays }
}

function mergeOverlaySources(sources: ConfigSource[]): SourcedOverlayConfigMap {
  const result: SourcedOverlayConfigMap = {
    agents: {},
    categories: {},
  }

  for (const source of sources) {
    mergeOverlayMap(result.agents, source, 'agents')
    mergeOverlayMap(result.categories, source, 'categories')
  }

  return result
}

function mergeOverlayMap(
  target: Record<string, SourcedOverlayConfig>,
  source: ConfigSource,
  mapKey: 'agents' | 'categories',
): void {
  const overlayMap = source.config[mapKey]
  if (overlayMap === undefined) return

  if (!isRecord(overlayMap)) {
    throwInvalidOverlay(source.path, mapKey)
  }

  for (const [key, value] of Object.entries(overlayMap)) {
    const keyPath = `${mapKey}.${key}`
    if (!isRecord(value)) {
      throwInvalidOverlay(source.path, keyPath)
    }

    if (source.trust === 'project') {
      rejectProjectSecurityOverlay(source.path, keyPath, value)
    }

    const previous = target[key]
    const nextValue =
      source.trust === 'project' && previous
        ? preserveSecurityFields(previous.value, value)
        : value

    target[key] = {
      value: nextValue,
      sourcePath: source.path,
      keyPath,
    }
  }
}

function rejectProjectSecurityOverlay(
  sourcePath: string,
  keyPath: string,
  value: Record<string, unknown>,
): void {
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new Error(
        `Invalid Systematic config in ${sourcePath}: ${keyPath}.${field} is only valid in user config or OPENCODE_CONFIG_DIR config`,
      )
    }
  }
}

function preserveSecurityFields(
  previous: OverlayConfig,
  next: OverlayConfig,
): OverlayConfig {
  const result: OverlayConfig = { ...next }
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(previous, field)) {
      result[field] = previous[field]
    }
  }
  return result
}

function overlayValues(
  overlays: Record<string, SourcedOverlayConfig>,
): OverlayConfigMap {
  const result: OverlayConfigMap = {}

  for (const [key, overlay] of Object.entries(overlays)) {
    result[key] = overlay.value
  }

  return result
}

function throwInvalidOverlay(sourcePath: string, keyPath: string): never {
  throw new Error(
    `Invalid Systematic config in ${sourcePath}: ${keyPath} must be an object`,
  )
}

export function getConfigPaths(projectDir: string) {
  const homeDir = os.homedir()
  const customConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim()

  const result = {
    userConfig: resolveConfigPath(
      path.join(homeDir, '.config/opencode'),
      'systematic',
    ),
    projectConfig: resolveConfigPath(
      path.join(projectDir, '.opencode'),
      'systematic',
    ),
    userDir: path.join(homeDir, '.config/opencode/systematic'),
    projectDir: path.join(projectDir, '.opencode/systematic'),
    ...(customConfigDir && {
      customConfig: resolveConfigPath(customConfigDir, 'systematic'),
      customDir: path.join(customConfigDir, 'systematic'),
    }),
  }

  return result
}
