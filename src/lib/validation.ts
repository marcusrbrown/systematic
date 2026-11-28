/**
 * Shared type guards and validation utilities for agent/skill/command frontmatter.
 */

export type AgentMode = 'subagent' | 'primary' | 'all'

export type PermissionSetting = 'ask' | 'allow' | 'deny'

type PermissionValue = PermissionSetting | Record<string, PermissionSetting>

/**
 * A frontmatter permission block. The eight named keys may carry a value
 * checked for their own shape (`bash` also takes a pattern map). Any other key,
 * `'*'` included, holds a bare setting. Keys are in file order.
 */
export interface PermissionConfig {
  edit?: PermissionSetting
  bash?: PermissionSetting | Record<string, PermissionSetting>
  webfetch?: PermissionSetting
  websearch?: PermissionSetting
  doom_loop?: PermissionSetting
  external_directory?: PermissionSetting
  task?: PermissionSetting
  skill?: PermissionSetting
  [tool: string]: PermissionValue | undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPermissionSetting(
  value: unknown,
): value is PermissionSetting {
  return value === 'ask' || value === 'allow' || value === 'deny'
}

export function isToolsMap(value: unknown): value is Record<string, boolean> {
  if (!isRecord(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'boolean')
}

export function isAgentMode(value: unknown): value is AgentMode {
  return value === 'subagent' || value === 'primary' || value === 'all'
}

function extractBashPermission(value: unknown): PermissionValue | null {
  if (isPermissionSetting(value)) return value
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.every(([, setting]) => isPermissionSetting(setting))) {
      return Object.fromEntries(entries) as Record<string, PermissionSetting>
    }
  }
  return null
}

const NAMED_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  'edit',
  'bash',
  'webfetch',
  'websearch',
  'doom_loop',
  'external_directory',
  'task',
  'skill',
])

function checkNamedPermission(
  key: string,
  setting: unknown,
): PermissionValue | null {
  if (key === 'bash') return extractBashPermission(setting)
  return isPermissionSetting(setting) ? setting : null
}

/**
 * Keeps a frontmatter permission block in file order. A named key with a bad
 * value drops the whole block. Any other key is kept when its value is a bare
 * setting and ignored otherwise. A block with no kept key is `undefined`.
 */
export function normalizePermission(
  value: unknown,
): PermissionConfig | undefined {
  if (!isRecord(value)) return undefined

  const entries: [string, PermissionValue][] = []
  for (const [key, setting] of Object.entries(value)) {
    if (NAMED_PERMISSION_KEYS.has(key)) {
      const checked = checkNamedPermission(key, setting)
      if (checked === null) return undefined
      entries.push([key, checked])
    } else if (isPermissionSetting(setting)) {
      entries.push([key, setting])
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Shared frontmatter extraction helpers.
 * Centralized to ensure consistent behavior across agents, commands, and skills.
 */

export function extractString(
  data: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = data[key]
  return typeof value === 'string' ? value : fallback
}

export function extractNonEmptyString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed !== '' ? trimmed : undefined
}

export function extractNumber(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key]
  return typeof value === 'number' ? value : undefined
}

export function extractBoolean(
  data: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return undefined
}
