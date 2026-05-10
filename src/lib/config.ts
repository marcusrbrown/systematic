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
  getSecurityOverlayFields,
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

const SECURITY_OVERLAY_FIELDS = new Set(getSecurityOverlayFields())

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
 * Throw a schema validation error for a top-level config source.
 *
 * Mirrors the error-message format used by `throwConfigError` in
 * `agent-overlays.ts` and `throwOverlaySchemaError` for overlay fields,
 * so every config error includes the source file path and the offending
 * field path. The thrown error carries `_tag`, `filePath`, and `issues`
 * properties for programmatic inspection.
 */
function throwTopLevelConfigSchemaError(
  filePath: string,
  trust: ConfigSource['trust'],
  issues: readonly z.core.$ZodIssue[],
): never {
  const issue = issues[0]
  if (!issue) {
    throw Object.assign(
      new Error(
        `Invalid Systematic config in ${filePath}: schema validation failed`,
      ),
      { _tag: 'ConfigSchemaError' as const, filePath, trust, issues },
    )
  }
  const fieldPath =
    issue.code === 'unrecognized_keys'
      ? (issue.message.match(/"([^"]+)"/)?.[1] ?? issue.path.join('.'))
      : issue.path.join('.')
  const message = fieldPath
    ? `Invalid Systematic config in ${filePath}: ${fieldPath} ${issue.message}`
    : `Invalid Systematic config in ${filePath}: ${issue.message}`
  throw Object.assign(new Error(message), {
    _tag: 'ConfigSchemaError' as const,
    filePath,
    trust,
    issues,
  })
}

/**
 * Type guard for errors thrown by the top-level config schema validator.
 * Use this to distinguish schema validation failures from JSONC parse errors
 * or file read errors.
 */
export function isConfigSchemaError(err: unknown): err is Error & {
  _tag: 'ConfigSchemaError'
  filePath: string
  trust: ConfigSource['trust']
  issues: readonly z.core.$ZodIssue[]
} {
  return (
    err instanceof Error &&
    (err as unknown as { _tag: unknown })._tag === 'ConfigSchemaError'
  )
}

function loadConfigSource(
  filePath: string,
  trust: ConfigSource['trust'],
): ConfigSource | null {
  const rawConfig = loadJsoncFile(filePath)
  if (!rawConfig) return null

  const result = SystematicConfigSchema.safeParse(rawConfig)
  if (!result.success) {
    throwTopLevelConfigSchemaError(filePath, trust, result.error.issues)
  }

  return { path: filePath, config: result.data, trust }
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
