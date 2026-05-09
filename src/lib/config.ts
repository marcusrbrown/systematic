import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

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
}

function loadJsoncFile(filePath: string): RawSystematicConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = parseJsonc(content) as unknown
    if (!isRecord(parsed)) return null
    return parsed as RawSystematicConfig
  } catch {
    return null
  }
}

function loadConfigSource(filePath: string): ConfigSource | null {
  const config = loadJsoncFile(filePath)
  if (!config) return null

  return { path: filePath, config }
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

  const userSource = loadConfigSource(paths.userConfig)
  const projectSource = loadConfigSource(paths.projectConfig)
  const customSource = paths.customConfig
    ? loadConfigSource(paths.customConfig)
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

    target[key] = {
      value,
      sourcePath: source.path,
      keyPath,
    }
  }
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
    userConfig: path.join(homeDir, '.config/opencode/systematic.json'),
    projectConfig: path.join(projectDir, '.opencode/systematic.json'),
    userDir: path.join(homeDir, '.config/opencode/systematic'),
    projectDir: path.join(projectDir, '.opencode/systematic'),
    ...(customConfigDir && {
      customConfig: path.join(customConfigDir, 'systematic.json'),
      customDir: path.join(customConfigDir, 'systematic'),
    }),
  }

  return result
}
