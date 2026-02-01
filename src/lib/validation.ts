/**
 * Shared type guards and validation utilities for agent/skill/command frontmatter.
 */

export type AgentMode = 'subagent' | 'primary' | 'all'

export type PermissionSetting = 'ask' | 'allow' | 'deny'

export interface PermissionConfig {
  edit?: PermissionSetting
  bash?: PermissionSetting | Record<string, PermissionSetting>
  webfetch?: PermissionSetting
  doom_loop?: PermissionSetting
  external_directory?: PermissionSetting
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

function extractSimplePermission(
  data: Record<string, unknown>,
  key: keyof PermissionConfig,
): PermissionSetting | null | undefined {
  if (!(key in data)) return undefined
  const value = data[key]
  return isPermissionSetting(value) ? value : null
}

function extractBashPermission(
  data: Record<string, unknown>,
): PermissionConfig['bash'] | null | undefined {
  if (!('bash' in data)) return undefined

  const bash = data.bash
  if (isPermissionSetting(bash)) return bash

  if (isRecord(bash)) {
    const entries = Object.entries(bash)
    if (entries.every(([, setting]) => isPermissionSetting(setting))) {
      return Object.fromEntries(entries) as Record<string, PermissionSetting>
    }
  }
  return null
}

function buildPermissionObject(
  edit: PermissionSetting | null | undefined,
  bash: PermissionConfig['bash'] | null | undefined,
  webfetch: PermissionSetting | null | undefined,
  doom_loop: PermissionSetting | null | undefined,
  external_directory: PermissionSetting | null | undefined,
): PermissionConfig | undefined {
  const permission: PermissionConfig = {}
  if (edit) permission.edit = edit
  if (bash) permission.bash = bash
  if (webfetch) permission.webfetch = webfetch
  if (doom_loop) permission.doom_loop = doom_loop
  if (external_directory) permission.external_directory = external_directory
  return Object.keys(permission).length > 0 ? permission : undefined
}

export function normalizePermission(
  value: unknown,
): PermissionConfig | undefined {
  if (!isRecord(value)) return undefined

  const bash = extractBashPermission(value)
  if (bash === null) return undefined

  const edit = extractSimplePermission(value, 'edit')
  if (edit === null) return undefined

  const webfetch = extractSimplePermission(value, 'webfetch')
  if (webfetch === null) return undefined

  const doom_loop = extractSimplePermission(value, 'doom_loop')
  if (doom_loop === null) return undefined

  const external_directory = extractSimplePermission(
    value,
    'external_directory',
  )
  if (external_directory === null) return undefined

  return buildPermissionObject(
    edit,
    bash,
    webfetch,
    doom_loop,
    external_directory,
  )
}
