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
  enabledSkills?: string[]
}

export interface ResolvedAgentOverlaySet {
  agentsByTargetId: Map<string, ValidatedAgentOverlay>
  categoriesByKey: Map<string, ValidatedCategoryOverlay>
}

// Ordered preference lists, most preferred first. The resolver picks the
// first array entry whose provider is authenticated; entries are not a
// runtime fallback chain. Keep arrays non-empty.
const SOURCE_CATEGORY_MODEL_DEFAULTS = {
  design: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
  docs: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
  'document-review': ['anthropic/claude-opus-4.7', 'openai/gpt-5.5'],
  research: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
  review: ['anthropic/claude-opus-4.7', 'openai/gpt-5.5'],
  workflow: ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5'],
} as const satisfies Record<string, readonly string[]>

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
  enabledSkills,
}: ValidateAgentOverlaysOptions): ValidatedAgentOverlays {
  const skillSet = enabledSkills ? new Set(enabledSkills) : undefined
  const agents = validateExactAgentOverlays(
    inventory,
    overlays,
    nativeAgents,
    skillSet,
  )
  const categories = validateCategoryOverlays(inventory, overlays, skillSet)

  return { agents, categories }
}

export function resolveAgentOverlaySet(
  overlays: ValidatedAgentOverlays,
): ResolvedAgentOverlaySet {
  return {
    agentsByTargetId: new Map(
      overlays.agents.map((overlay) => [overlay.target.id, overlay]),
    ),
    categoriesByKey: new Map(
      overlays.categories.map((overlay) => [overlay.key, overlay]),
    ),
  }
}

export function inferBuiltInTemperature(
  name: string,
  description?: string,
): number {
  const sample = `${name} ${description ?? ''}`.toLowerCase()
  if (
    /(review|audit|security|sentinel|oracle|lint|verification|guardian)/.test(
      sample,
    )
  ) {
    return 0.1
  }
  if (
    /(plan|planning|architecture|strategist|analysis|research)/.test(sample)
  ) {
    return 0.2
  }
  if (/(doc|readme|changelog|editor|writer)/.test(sample)) {
    return 0.3
  }
  if (/(brainstorm|creative|ideate|design|concept)/.test(sample)) {
    return 0.6
  }
  return 0.3
}

export function getSourceCategoryModel(
  category: string | undefined,
): string | undefined {
  if (!category) return undefined
  const candidates = (
    SOURCE_CATEGORY_MODEL_DEFAULTS as Record<
      string,
      readonly string[] | undefined
    >
  )[category]
  if (!candidates || candidates.length === 0) return undefined
  return candidates[0]
}

export function assertSourceCategoryModelCoverage(categories: string[]): void {
  validateSourceCategoryModelDefaults()

  const missingCategories = categories.filter(
    (category) => !Object.hasOwn(SOURCE_CATEGORY_MODEL_DEFAULTS, category),
  )

  if (missingCategories.length > 0) {
    throw new Error(
      `Source category model defaults missing intentional coverage for: ${missingCategories.join(', ')}`,
    )
  }
}

export function validateSourceCategoryModelDefaults(
  defaults: Record<string, unknown> = SOURCE_CATEGORY_MODEL_DEFAULTS,
): void {
  for (const [category, value] of Object.entries(defaults)) {
    if (!Array.isArray(value)) {
      throw new Error(
        `Source category model defaults: ${category} must be a non-empty array of provider/model strings`,
      )
    }
    if (value.length === 0) {
      throw new Error(
        `Source category model defaults: ${category} must be a non-empty array of provider/model strings`,
      )
    }
    for (const [index, model] of value.entries()) {
      validateModel(
        'source category model defaults',
        `source category model defaults.${category}[${index}]`,
        model,
      )
    }
  }
}

function validateExactAgentOverlays(
  inventory: BundledAgentInventory,
  overlays: SourcedOverlayConfigMap,
  nativeAgents: Record<string, unknown>,
  enabledSkills: Set<string> | undefined,
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

    validateOverlayFields(overlay, 'agent', enabledSkills)
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
  enabledSkills: Set<string> | undefined,
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

    validateOverlayFields(overlay, 'category', enabledSkills)
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
  enabledSkills: Set<string> | undefined,
): void {
  if (
    Object.hasOwn(overlay.value, 'skills') &&
    hasPermissionSkill(overlay.value.permission)
  ) {
    throwConfigError(
      overlay.sourcePath,
      overlay.keyPath,
      'cannot set both skills and permission.skill in the same overlay object',
    )
  }

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

    validateOverlayFieldValue(
      overlay.sourcePath,
      keyPath,
      field,
      value,
      enabledSkills,
    )
  }
}

function hasPermissionSkill(permission: unknown): boolean {
  return isRecord(permission) && Object.hasOwn(permission, 'skill')
}

function validateOverlayFieldValue(
  sourcePath: string,
  keyPath: string,
  field: string,
  value: unknown,
  enabledSkills: Set<string> | undefined,
): void {
  switch (field) {
    case 'model':
      if (value === null) return // null opt-out: inherit parent model
      validateModel(sourcePath, keyPath, value)
      return
    case 'variant':
      validateNonEmptyString(sourcePath, keyPath, value)
      return
    case 'temperature':
      validateTemperature(sourcePath, keyPath, value)
      return
    case 'top_p':
      validateTopP(sourcePath, keyPath, value)
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
      validateSkills(sourcePath, keyPath, value, enabledSkills)
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

  if (value !== value.trim() || /\s/.test(value)) {
    throwConfigError(sourcePath, keyPath, 'must be a provider/model string')
  }

  const slashIndex = value.indexOf('/')
  if (value === '' || slashIndex <= 0 || slashIndex === value.length - 1) {
    throwConfigError(sourcePath, keyPath, 'must be a provider/model string')
  }
}

function validateNonEmptyString(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throwConfigError(sourcePath, keyPath, 'must be a non-empty string')
  }
}

function validateTemperature(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throwConfigError(
      sourcePath,
      keyPath,
      'must be a non-negative finite number',
    )
  }
}

function validateTopP(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throwConfigError(sourcePath, keyPath, 'must be a number from 0 to 1')
  }
}

function validatePositiveInteger(
  sourcePath: string,
  keyPath: string,
  value: unknown,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
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
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !isOpenCodeColor(value)
  ) {
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
  enabledSkills: Set<string> | undefined,
): void {
  if (
    !Array.isArray(value) ||
    !value.every(
      (skill) =>
        typeof skill === 'string' && skill !== '' && skill === skill.trim(),
    )
  ) {
    throwConfigError(
      sourcePath,
      keyPath,
      'must be an array of non-empty strings',
    )
  }

  if (!enabledSkills) return

  for (const skill of value) {
    if (!enabledSkills.has(skill)) {
      throwConfigError(
        sourcePath,
        keyPath,
        `unknown or disabled skill "${skill}"`,
      )
    }
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
