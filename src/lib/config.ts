import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  const paths = getConfigPaths(projectDir)

  const userConfig = loadJsoncFile<Partial<SystematicConfig>>(paths.userConfig)
  const projectConfig = loadJsoncFile<Partial<SystematicConfig>>(
    paths.projectConfig,
  )

  const result: SystematicConfig = {
    disabled_skills: mergeArraysUnique(
      mergeArraysUnique(
        DEFAULT_CONFIG.disabled_skills,
        userConfig?.disabled_skills,
      ),
      projectConfig?.disabled_skills,
    ),
    disabled_agents: mergeArraysUnique(
      mergeArraysUnique(
        DEFAULT_CONFIG.disabled_agents,
        userConfig?.disabled_agents,
      ),
      projectConfig?.disabled_agents,
    ),
    disabled_commands: mergeArraysUnique(
      mergeArraysUnique(
        DEFAULT_CONFIG.disabled_commands,
        userConfig?.disabled_commands,
      ),
      projectConfig?.disabled_commands,
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
