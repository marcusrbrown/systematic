import fs from 'node:fs'
import path from 'node:path'
import type { SourcedOverlayConfigMap } from './config.js'
import { isAgentMode, isPermissionSetting, isRecord } from './validation.js'

export interface BundledAgentInventoryEntry {
  id: string
  key: string
  category: string
  file: string
  disabled: boolean
}

export interface BundledAgentInventory {
  agentsByQualifiedId: Record<string, BundledAgentInventoryEntry>
  aliases: Record<string, string>
  categories: string[]
}

export interface ValidatedAgentOverlay {
  key: string
  target: BundledAgentInventoryEntry
  value: Record<string, unknown>
  sourcePath: string
  keyPath: string
}

export interface ValidatedCategoryOverlay {
  key: string
  value: Record<string, unknown>
  sourcePath: string
  keyPath: string
}

export interface ValidatedAgentOverlays {
  agents: ValidatedAgentOverlay[]
  categories: ValidatedCategoryOverlay[]
}

export interface ValidateAgentOverlaysOptions {
  inventory: BundledAgentInventory
  overlays: SourcedOverlayConfigMap
  nativeAgents?: Record<string, unknown>
}

const ALLOWED_OVERLAY_FIELDS = new Set([
  'model',
  'variant',
  'temperature',
  'top_p',
  'permission',
  'mode',
  'color',
  'steps',
  'hidden',
  'disable',
  'skills',
])

export function buildBundledAgentInventory(
  agentsDir: string,
  disabledAgents: string[],
): BundledAgentInventory {
  const categories = readCategoryDirs(agentsDir)
  const agentsByQualifiedId: Record<string, BundledAgentInventoryEntry> = {}
  const stemCategories = new Map<string, string[]>()
  const disabledSet = new Set(disabledAgents)

  for (const category of categories) {
    for (const fileName of readMarkdownFiles(path.join(agentsDir, category))) {
      const key = fileName.replace(/\.md$/, '')
      const id = `${category}/${key}`
      agentsByQualifiedId[id] = {
        id,
        key,
        category,
        file: path.join(agentsDir, category, fileName),
        disabled: disabledSet.has(key) || disabledSet.has(id),
      }

      const existing = stemCategories.get(key) ?? []
      existing.push(category)
      stemCategories.set(key, existing)
    }
  }

  const duplicateStems = Array.from(stemCategories.entries()).filter(
    ([, seenCategories]) => seenCategories.length > 1,
  )
  if (duplicateStems.length > 0) {
    const details = duplicateStems
      .map(
        ([stem, seenCategories]) =>
          `Duplicate bundled agent stem "${stem}" in categories: ${seenCategories.join(', ')}`,
      )
      .join('; ')
    throw new Error(details)
  }

  const aliases: Record<string, string> = {}
  for (const entry of Object.values(agentsByQualifiedId)) {
    aliases[entry.id] = entry.id
    aliases[entry.key] = entry.id
  }

  return { agentsByQualifiedId, aliases, categories }
}

export function validateAgentOverlays({
  inventory,
  overlays,
  nativeAgents = {},
}: ValidateAgentOverlaysOptions): ValidatedAgentOverlays {
  const agents = validateExactAgentOverlays(inventory, overlays, nativeAgents)
  const categories = validateCategoryOverlays(inventory, overlays)

  return { agents, categories }
}

function validateExactAgentOverlays(
  inventory: BundledAgentInventory,
  overlays: SourcedOverlayConfigMap,
  nativeAgents: Record<string, unknown>,
): ValidatedAgentOverlay[] {
  const result: ValidatedAgentOverlay[] = []
  const seenTargets = new Map<string, string>()

  for (const [key, overlay] of Object.entries(overlays.agents)) {
    const targetId = inventory.aliases[key]
    if (!targetId) {
      throwConfigError(
        overlay.sourcePath,
        overlay.keyPath,
        `unknown bundled agent. Valid agents: ${validAgentKeys(inventory).join(', ')}`,
      )
    }

    const previousKeyPath = seenTargets.get(targetId)
    if (previousKeyPath) {
      throwConfigError(
        overlay.sourcePath,
        overlay.keyPath,
        `Duplicate Systematic agent overlay target "${targetId}" from ${previousKeyPath} and ${overlay.keyPath}`,
      )
    }
    seenTargets.set(targetId, overlay.keyPath)

    const target = inventory.agentsByQualifiedId[targetId]
    if (!target) {
      throwConfigError(
        overlay.sourcePath,
        overlay.keyPath,
        `unknown bundled agent target "${targetId}"`,
      )
    }

    if (Object.hasOwn(nativeAgents, target.key)) {
      throwConfigError(
        overlay.sourcePath,
        overlay.keyPath,
        `conflicts with native OpenCode agent.${target.key}; native agents are replacements for bundled agents`,
      )
    }

    validateOverlayFields(overlay, 'agent')
    result.push({
      key,
      target,
      value: overlay.value,
      sourcePath: overlay.sourcePath,
      keyPath: overlay.keyPath,
    })
  }

  return result
}

function validateCategoryOverlays(
  inventory: BundledAgentInventory,
  overlays: SourcedOverlayConfigMap,
): ValidatedCategoryOverlay[] {
  const categories = new Set(inventory.categories)
  const result: ValidatedCategoryOverlay[] = []

  for (const [key, overlay] of Object.entries(overlays.categories)) {
    if (!categories.has(key)) {
      throwConfigError(
        overlay.sourcePath,
        overlay.keyPath,
        `unknown bundled agent category. Valid categories: ${inventory.categories.join(', ')}`,
      )
    }

    validateOverlayFields(overlay, 'category')
    result.push({
      key,
      value: overlay.value,
      sourcePath: overlay.sourcePath,
      keyPath: overlay.keyPath,
    })
  }

  return result
}

function validateOverlayFields(
  overlay: {
    value: Record<string, unknown>
    sourcePath: string
    keyPath: string
  },
  targetType: 'agent' | 'category',
): void {
  for (const [field, value] of Object.entries(overlay.value)) {
    const keyPath = `${overlay.keyPath}.${field}`
    if (!ALLOWED_OVERLAY_FIELDS.has(field)) {
      throwConfigError(
        overlay.sourcePath,
        keyPath,
        `unsupported agent overlay field "${field}"`,
      )
    }

    if (targetType === 'category' && field === 'disable') {
      throwConfigError(
        overlay.sourcePath,
        keyPath,
        'disable is only valid for exact agent overlays',
      )
    }

    validateOverlayFieldValue(overlay.sourcePath, keyPath, field, value)
  }
}

function validateOverlayFieldValue(
  sourcePath: string,
  keyPath: string,
  field: string,
  value: unknown,
): void {
  switch (field) {
    case 'model':
      validateModel(sourcePath, keyPath, value)
      return
    case 'variant':
      validateNonEmptyString(sourcePath, keyPath, value)
      return
    case 'temperature':
    case 'top_p':
      validateFiniteNumber(sourcePath, keyPath, value)
      return
    case 'permission':
      validatePermission(sourcePath, keyPath, value)
      return
    case 'mode':
      validateMode(sourcePath, keyPath, value)
      return
    case 'color':
      validateColor(sourcePath, keyPath, value)
      return
    case 'steps':
      validatePositiveInteger(sourcePath, keyPath, value)
      return
    case 'hidden':
    case 'disable':
      validateBoolean(sourcePath, keyPath, value)
      return
    case 'skills':
      validateSkills(sourcePath, keyPath, value)
      return
  }
}

function validateModel(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'string') {
    throwConfigError(sourcePath, keyPath, 'must be a provider/model string')
  }

  const trimmed = value.trim()
  const slashIndex = trimmed.indexOf('/')
  if (trimmed === '' || slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    throwConfigError(sourcePath, keyPath, 'must be a provider/model string')
  }
}

function validateNonEmptyString(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throwConfigError(sourcePath, keyPath, 'must be a non-empty string')
  }
}

function validateFiniteNumber(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwConfigError(sourcePath, keyPath, 'must be a finite number')
  }
}

function validatePositiveInteger(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throwConfigError(sourcePath, keyPath, 'must be a positive integer')
  }
}

function validateBoolean(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'boolean') {
    throwConfigError(sourcePath, keyPath, 'must be a boolean')
  }
}

function validateMode(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (!isAgentMode(value)) {
    throwConfigError(
      sourcePath,
      keyPath,
      'must be one of: subagent, primary, all',
    )
  }
}

function validateColor(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'string' || !isOpenCodeColor(value.trim())) {
    throwConfigError(
      sourcePath,
      keyPath,
      'must be an OpenCode-compatible color string',
    )
  }
}

function isOpenCodeColor(value: string): boolean {
  if (value === '') return false
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) return true
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(value)
}

function validateSkills(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (
    !Array.isArray(value) ||
    !value.every((skill) => typeof skill === 'string' && skill.trim() !== '')
  ) {
    throwConfigError(
      sourcePath,
      keyPath,
      'must be an array of non-empty strings',
    )
  }
}

function validatePermission(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    throwConfigError(sourcePath, keyPath, 'must be an object')
  }

  for (const [toolKey, rule] of Object.entries(value)) {
    if (toolKey.trim() === '') {
      throwConfigError(
        sourcePath,
        `${keyPath}.${toolKey}`,
        'must use a non-empty tool key',
      )
    }

    validatePermissionRule(sourcePath, `${keyPath}.${toolKey}`, rule)
  }
}

function validatePermissionRule(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (isPermissionSetting(value)) return

  if (!isRecord(value)) {
    throwConfigError(
      sourcePath,
      keyPath,
      'must be ask, allow, deny, or an object of pattern rules',
    )
  }

  for (const [pattern, setting] of Object.entries(value)) {
    if (pattern.trim() === '') {
      throwConfigError(
        sourcePath,
        `${keyPath}.${pattern}`,
        'must use a non-empty permission pattern',
      )
    }
    if (!isPermissionSetting(setting)) {
      throwConfigError(
        sourcePath,
        `${keyPath}.${pattern}`,
        'must be ask, allow, or deny',
      )
    }
  }
}

function readCategoryDirs(agentsDir: string): string[] {
  try {
    return fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function readMarkdownFiles(categoryDir: string): string[] {
  try {
    return fs
      .readdirSync(categoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function validAgentKeys(inventory: BundledAgentInventory): string[] {
  return Object.keys(inventory.aliases).sort()
}

function throwConfigError(
  sourcePath: string,
  keyPath: string,
  message: string,
): never {
  throw new Error(
    `Invalid Systematic config in ${sourcePath}: ${keyPath} ${message}`,
  )
}
