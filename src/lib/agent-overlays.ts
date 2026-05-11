import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { z } from 'zod'
import type { SourcedOverlayConfigMap } from './config.js'
import {
  AgentOverlaySchema,
  assertSourceCategoryModelDefaults,
  CategoryOverlaySchema,
} from './config-schema.js'
import { isRecord } from './validation.js'

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

/**
 * Read which providers are authenticated from OpenCode's auth.json.
 *
 * Reads only top-level keys (provider IDs). Nested values are NEVER
 * inspected, logged, persisted, or transmitted. This is a hard contract:
 * the auth file holds API keys and OAuth tokens, and Systematic must
 * never expose them via stderr, telemetry, or any other channel.
 *
 * Intended for one invocation per plugin config(cfg) cycle. Repeated
 * calls trigger repeated file reads and, on malformed input, repeated
 * stderr diagnostics.
 *
 * @param rootDirOverride - Optional path override for tests. When
 *   non-empty, the auth file is resolved as
 *   `path.join(rootDirOverride, 'opencode', 'auth.json')`. When
 *   omitted, resolution follows XDG_DATA_HOME -> ~/.local/share
 *   convention.
 * @returns A readonly set of authenticated provider IDs (empty set on
 *   any failure).
 */
export function getAuthenticatedProviders(
  rootDirOverride?: string,
): ReadonlySet<string> {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim()
  const rootDir =
    rootDirOverride ||
    (xdgDataHome && path.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : path.join(os.homedir(), '.local/share'))
  const authPath = path.join(rootDir, 'opencode', 'auth.json')

  let raw: string
  try {
    raw = fs.readFileSync(authPath, 'utf8')
  } catch (err: unknown) {
    if (isSystemError(err) && err.code === 'ENOENT') {
      return new Set()
    }
    console.warn(`[systematic] auth.json unreadable at ${authPath}; ignoring`)
    return new Set()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[systematic] auth.json malformed at ${authPath}; ignoring`)
    return new Set()
  }

  if (!isRecord(parsed)) {
    console.warn(`[systematic] auth.json malformed at ${authPath}; ignoring`)
    return new Set()
  }

  return new Set(Object.keys(parsed))
}

export function getSourceCategoryModel(
  category: string | undefined,
  authedProviders?: ReadonlySet<string>,
): string | undefined {
  if (!category) return undefined
  const candidates = (
    SOURCE_CATEGORY_MODEL_DEFAULTS as Record<
      string,
      readonly string[] | undefined
    >
  )[category]
  if (!candidates || candidates.length === 0) return undefined
  if (!authedProviders || authedProviders.size === 0) return candidates[0]

  for (const entry of candidates) {
    const slashIndex = entry.indexOf('/')
    if (slashIndex <= 0) continue
    const providerId = entry.slice(0, slashIndex)
    if (authedProviders.has(providerId)) {
      return entry
    }
  }

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
  assertSourceCategoryModelDefaults(defaults)
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

function hasPermissionSkill(permission: unknown): boolean {
  return isRecord(permission) && Object.hasOwn(permission, 'skill')
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

  const result = parseOverlayShape(overlay, targetType)
  validateOverlaySkills(overlay, result.skills, enabledSkills)
}

function parseOverlayShape(
  overlay: {
    value: Record<string, unknown>
    sourcePath: string
    keyPath: string
  },
  targetType: 'agent' | 'category',
): { skills: string[] | undefined } {
  const schema =
    targetType === 'agent' ? AgentOverlaySchema : CategoryOverlaySchema
  const result = schema.safeParse(overlay.value)

  if (!result.success) {
    throwOverlaySchemaError(overlay, result.error.issues[0])
  }

  return { skills: result.data.skills }
}

function throwOverlaySchemaError(
  overlay: { sourcePath: string; keyPath: string },
  issue: z.core.$ZodIssue,
): never {
  const zodPath =
    issue.code === 'unrecognized_keys'
      ? (issue.message.match(/"([^"]+)"/)?.[1] ?? issue.path.join('.'))
      : issue.path.join('.')
  const fullPath = zodPath ? `${overlay.keyPath}.${zodPath}` : overlay.keyPath
  throwConfigError(overlay.sourcePath, fullPath, issue.message)
}

function validateOverlaySkills(
  overlay: { sourcePath: string; keyPath: string },
  skills: string[] | undefined,
  enabledSkills: Set<string> | undefined,
): void {
  if (!enabledSkills || !skills) return

  for (const skill of skills) {
    if (!enabledSkills.has(skill)) {
      throwConfigError(
        overlay.sourcePath,
        `${overlay.keyPath}.skills`,
        `unknown or disabled skill "${skill}"`,
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

function isSystemError(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  )
}
