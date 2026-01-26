import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseJsonc } from 'jsonc-parser'

export interface BootstrapConfig {
  enabled: boolean
  file?: string
}

export interface SystematicConfig {
  disabled_skills: string[]
  disabled_agents: string[]
  disabled_commands: string[]
  bootstrap: BootstrapConfig
}

export const DEFAULT_CONFIG: SystematicConfig = {
  disabled_skills: [],
  disabled_agents: [],
  disabled_commands: [],
  bootstrap: {
    enabled: true,
  },
}

function loadJsoncFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    return parseJsonc(content) as T
  } catch {
    return null
  }
}

function mergeArraysUnique<T>(arr1: T[] | undefined, arr2: T[] | undefined): T[] {
  const set = new Set<T>()
  if (arr1) arr1.forEach((item) => set.add(item))
  if (arr2) arr2.forEach((item) => set.add(item))
  return Array.from(set)
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  ...overrides: Array<Partial<T> | null>
): T {
  const result = { ...base }

  for (const override of overrides) {
    if (!override) continue
    for (const [key, value] of Object.entries(override)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        ;(result as Record<string, unknown>)[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>
        )
      } else if (value !== undefined) {
        ;(result as Record<string, unknown>)[key] = value
      }
    }
  }

  return result
}

export function loadConfig(projectDir: string): SystematicConfig {
  const homeDir = os.homedir()
  const userConfigPath = path.join(homeDir, '.config/opencode/systematic.json')
  const projectConfigPath = path.join(projectDir, '.opencode/systematic.json')

  const userConfig = loadJsoncFile<Partial<SystematicConfig>>(userConfigPath)
  const projectConfig = loadJsoncFile<Partial<SystematicConfig>>(projectConfigPath)

  const result: SystematicConfig = {
    disabled_skills: mergeArraysUnique(
      mergeArraysUnique(DEFAULT_CONFIG.disabled_skills, userConfig?.disabled_skills),
      projectConfig?.disabled_skills
    ),
    disabled_agents: mergeArraysUnique(
      mergeArraysUnique(DEFAULT_CONFIG.disabled_agents, userConfig?.disabled_agents),
      projectConfig?.disabled_agents
    ),
    disabled_commands: mergeArraysUnique(
      mergeArraysUnique(DEFAULT_CONFIG.disabled_commands, userConfig?.disabled_commands),
      projectConfig?.disabled_commands
    ),
    bootstrap: {
      ...DEFAULT_CONFIG.bootstrap,
      ...userConfig?.bootstrap,
      ...projectConfig?.bootstrap,
    },
  }

  return result
}

export function getConfigPaths(projectDir: string) {
  const homeDir = os.homedir()
  return {
    userConfig: path.join(homeDir, '.config/opencode/systematic.json'),
    projectConfig: path.join(projectDir, '.opencode/systematic.json'),
    userDir: path.join(homeDir, '.config/opencode/systematic'),
    projectDir: path.join(projectDir, '.opencode/systematic'),
  }
}
