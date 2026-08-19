import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { SourcedOverlayConfigMap } from './config.js'
import { AgentOverlaySchema, CategoryOverlaySchema } from './config-schema.js'
import { isRecord } from './validation.js'
import { isDiscoverableMarkdown } from './walk-dir.js';

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
      .filter((entry) => entry.isFile() && isDiscoverableMarkdown(entry.name))
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
