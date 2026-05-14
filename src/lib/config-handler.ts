import type { Config } from '@opencode-ai/plugin'
import type { AgentConfig } from '@opencode-ai/sdk'
import {
  assertSourceCategoryModelCoverage,
  buildBundledAgentInventory,
  inferBuiltInTemperature,
  type ResolvedAgentOverlaySet,
  resolveAgentOverlaySet,
  validateAgentOverlays,
} from './agent-overlays.js'
import { extractAgentFrontmatter, findAgentsInDir } from './agents.js'
import { extractCommandFrontmatter, findCommandsInDir } from './commands.js'
import { loadConfigWithSources } from './config.js'
import { convertFileWithCache } from './converter.js'
import { parseFrontmatter } from './frontmatter.js'
import {
  getAvailableModels,
  type OpencodeClientLike,
} from './model-availability.js'
import { type LoadedSkill, loadSkill } from './skill-loader.js'
import { findSkillsInDir } from './skills.js'
import { resolveSourceModel } from './source-model-defaults.js'
import { isRecord, type PermissionSetting } from './validation.js'

export interface ConfigHandlerDeps {
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
  /** OpenCode client for availability lookup. When omitted, availability falls back to empty set (last-resort resolution). */
  client?: OpencodeClientLike
}

type CommandConfig = NonNullable<Config['command']>[string]

function isSystematicAgentConfig(agent: AgentConfig | undefined): boolean {
  const description = agent?.description
  return (
    typeof description === 'string' && /\(.* - Systematic\)$/.test(description)
  )
}

function isSystematicCommandConfig(
  command: CommandConfig | undefined,
): boolean {
  const description = command?.description
  return (
    typeof description === 'string' &&
    (description.startsWith('(Systematic) ') ||
      description.startsWith('(Systematic - Skill) '))
  )
}

function mergeSystematicEntries<T>(
  existing: Record<string, T> | undefined,
  emitted: Record<string, T>,
  isSystematicEntry: (value: T | undefined) => boolean,
): Record<string, T> {
  const merged: Record<string, T> = {}

  for (const [key, value] of Object.entries(existing ?? {})) {
    if (isSystematicEntry(value)) continue
    merged[key] = value
  }

  for (const [key, value] of Object.entries(emitted)) {
    if (Object.hasOwn(merged, key)) continue
    merged[key] = value
  }

  return merged
}

export function toTitleCase(name: string): string {
  return name
    .split('-')
    .map((segment) =>
      segment.length > 0
        ? segment.charAt(0).toUpperCase() + segment.slice(1)
        : segment,
    )
    .join('-')
}

export function formatAgentDescription(
  name: string,
  description: string | undefined,
): string {
  const baseDescription = description || `${name} agent`
  const suffix = `(${toTitleCase(name)} - Systematic)`
  if (baseDescription.endsWith(suffix)) {
    return baseDescription
  }
  return `${baseDescription} ${suffix}`
}

function loadAgentAsConfig(agentInfo: {
  name: string
  file: string
  category?: string
}): AgentConfig | null {
  try {
    const converted = convertFileWithCache(agentInfo.file, 'agent', {
      source: 'bundled',
      agentMode: 'subagent',
    })
    const {
      description,
      prompt,
      model,
      variant,
      temperature,
      top_p,
      tools,
      disable,
      mode,
      color,
      steps,
      hidden,
      permission,
    } = extractAgentFrontmatter(converted)

    const config: AgentConfig = {
      description: formatAgentDescription(agentInfo.name, description),
      prompt,
    }

    if (model !== undefined) config.model = model
    if (variant !== undefined) config.variant = variant
    if (temperature !== undefined) config.temperature = temperature
    if (top_p !== undefined) config.top_p = top_p
    if (tools !== undefined) config.tools = tools
    if (disable !== undefined) config.disable = disable
    if (mode !== undefined) config.mode = mode
    if (color !== undefined) config.color = color
    if (steps !== undefined) config.steps = steps
    if (hidden !== undefined) config.hidden = hidden
    if (permission !== undefined) config.permission = permission

    return config
  } catch {
    return null
  }
}

function loadCommandAsConfig(commandInfo: {
  name: string
  file: string
  category?: string
}): CommandConfig | null {
  try {
    const converted = convertFileWithCache(commandInfo.file, 'command', {
      source: 'bundled',
    })
    const { name, description, agent, model, subtask } =
      extractCommandFrontmatter(converted)
    const { body } = parseFrontmatter(converted)

    const cleanName = commandInfo.name.replace(/^\//, '')

    const baseDescription = description || `${name || cleanName} command`

    const wrappedTemplate = `<command-instruction>
${body.trim()}
</command-instruction>

<user-request>
$ARGUMENTS
</user-request>`

    const config: CommandConfig = {
      template: wrappedTemplate,
      description: `(Systematic) ${baseDescription}`,
    }

    if (agent !== undefined) config.agent = agent
    if (model !== undefined) config.model = model
    if (subtask !== undefined) config.subtask = subtask

    return config
  } catch {
    return null
  }
}

function loadSkillAsCommand(loaded: LoadedSkill): CommandConfig {
  const config: CommandConfig = {
    template: loaded.wrappedTemplate,
    description: loaded.description,
  }

  if (loaded.agent !== undefined) config.agent = loaded.agent
  if (loaded.model !== undefined) config.model = loaded.model
  if (loaded.subtask !== undefined) config.subtask = loaded.subtask

  return config
}

/**
 * Source-default model resolution skips when `availabilitySet` is
 * `undefined`. That happens when both the client API call and the
 * models.json fallback failed — pinning a source default would risk
 * emitting agents the user cannot use, so we leave bundled agents to
 * inherit OpenCode's parent model instead.
 */
function collectAgents(
  dir: string,
  disabledAgents: string[],
  nativeAgents: Record<string, unknown>,
  overlays: ResolvedAgentOverlaySet,
  availabilitySet: ReadonlySet<string> | undefined,
): NonNullable<Config['agent']> {
  const agents: NonNullable<Config['agent']> = {}
  const agentList = findAgentsInDir(dir)
  const disabledSet = new Set(disabledAgents)

  for (const agentInfo of agentList) {
    const id = agentInfo.category
      ? `${agentInfo.category}/${agentInfo.name}`
      : agentInfo.name
    if (disabledSet.has(agentInfo.name) || disabledSet.has(id)) continue
    if (Object.hasOwn(nativeAgents, agentInfo.name)) continue

    const exactOverlay = overlays.agentsByTargetId.get(id)
    if (exactOverlay?.value.disable === true) continue

    const config = loadAgentAsConfig(agentInfo)
    if (config) {
      agents[agentInfo.name] = applyAgentOverlays(
        config,
        agentInfo,
        overlays,
        availabilitySet,
      )
    }
  }

  return agents
}

function applyAgentOverlays(
  config: AgentConfig,
  agentInfo: { name: string; category?: string },
  overlays: ResolvedAgentOverlaySet,
  availabilitySet: ReadonlySet<string> | undefined,
): AgentConfig {
  const id = agentInfo.category
    ? `${agentInfo.category}/${agentInfo.name}`
    : agentInfo.name
  const categoryOverlay = agentInfo.category
    ? overlays.categoriesByKey.get(agentInfo.category)
    : undefined
  const exactOverlay = overlays.agentsByTargetId.get(id)
  const result: AgentConfig = { ...config }
  const permissionRules = createPermissionRuleAccumulator()
  const hasPermissionOverlay =
    overlayControlsPermission(categoryOverlay?.value) ||
    overlayControlsPermission(exactOverlay?.value)

  if (hasPermissionOverlay && isRecord(config.permission)) {
    addPermissionRules(permissionRules, config.permission)
  }

  result.temperature = inferBuiltInTemperature(
    agentInfo.name,
    result.description,
  )

  applySourceModelDefault(result, agentInfo, availabilitySet)
  applyAgentOverlay(result, categoryOverlay?.value, permissionRules)
  applyAgentOverlay(result, exactOverlay?.value, permissionRules)
  applyPermissionOverlay(result, permissionRules, hasPermissionOverlay)

  return result
}

function applySourceModelDefault(
  target: AgentConfig,
  agentInfo: { category?: string },
  availabilitySet: ReadonlySet<string> | undefined,
): void {
  if (!agentInfo.category || availabilitySet === undefined) return

  const resolved = resolveSourceModel(agentInfo.category, availabilitySet)
  target.model = `${resolved.provider}/${resolved.model}`
  if (resolved.variant !== undefined) {
    target.variant = resolved.variant
  } else {
    delete target.variant
  }
}

function applyAgentOverlay(
  target: AgentConfig,
  overlay: Record<string, unknown> | undefined,
  permissionRules: PermissionRuleAccumulator,
): void {
  if (overlay === undefined) return
  applyOverlayObjectWithVariantClearing(target, overlay, permissionRules)
}

function applyPermissionOverlay(
  target: AgentConfig,
  permissionRules: PermissionRuleAccumulator,
  hasPermissionOverlay: boolean,
): void {
  if (!hasPermissionOverlay) return

  const permission = permissionFromRules(permissionRules)
  if (permission) {
    target.permission = permission as AgentConfig['permission']
  } else {
    delete target.permission
  }
}

function overlayControlsPermission(
  overlay: Record<string, unknown> | undefined,
): boolean {
  return (
    overlay !== undefined &&
    (Object.hasOwn(overlay, 'permission') || Object.hasOwn(overlay, 'skills'))
  )
}

const OVERLAY_ASSIGN_FIELDS = [
  'model',
  'variant',
  'temperature',
  'top_p',
  'mode',
  'color',
  'steps',
  'hidden',
] as const

function applyOverlayObjectWithVariantClearing(
  target: AgentConfig,
  overlay: Record<string, unknown>,
  permissionRules: PermissionRuleAccumulator,
): void {
  // When an overlay sets model but not variant, clear any lower-precedence
  // variant so the user-selected model is not paired with a stale source variant.
  // `model: null` (explicit inheritance opt-out) also counts as setting
  // model — without this, `model: null` without `variant` would silently
  // keep a stale source variant attached to OpenCode's inherited parent
  // model.
  const overlayHasModel = Object.hasOwn(overlay, 'model')
  const overlayHasVariant = Object.hasOwn(overlay, 'variant')
  if (overlayHasModel && !overlayHasVariant) {
    delete target.variant
  }

  for (const field of OVERLAY_ASSIGN_FIELDS) {
    if (Object.hasOwn(overlay, field)) {
      // model: null means "restore inheritance" — delete any source default
      if (field === 'model' && overlay[field] === null) {
        delete target[field]
      } else {
        ;(target as Record<string, unknown>)[field] = overlay[field]
      }
    }
  }

  if (isRecord(overlay.permission)) {
    addPermissionRules(permissionRules, overlay.permission)
  }
  if (Array.isArray(overlay.skills)) {
    addManagedSkillRules(permissionRules, overlay.skills)
  }
}

type PermissionRuleAccumulator = Map<string, Map<string, PermissionSetting>>

function createPermissionRuleAccumulator(): PermissionRuleAccumulator {
  return new Map<string, Map<string, PermissionSetting>>()
}

function addPermissionRules(
  accumulator: PermissionRuleAccumulator,
  permission: Record<string, unknown>,
): void {
  for (const [tool, rule] of Object.entries(permission)) {
    if (isPermissionSettingValue(rule)) {
      setPermissionRule(accumulator, tool, '*', rule)
      continue
    }
    if (!isRecord(rule)) continue
    for (const [pattern, setting] of Object.entries(rule)) {
      if (isPermissionSettingValue(setting)) {
        setPermissionRule(accumulator, tool, pattern, setting)
      }
    }
  }
}

function addManagedSkillRules(
  accumulator: PermissionRuleAccumulator,
  skills: unknown[],
): void {
  setPermissionRule(accumulator, 'skill', '*', 'deny')
  for (const skill of skills) {
    if (typeof skill === 'string') {
      setPermissionRule(accumulator, 'skill', skill, 'allow')
    }
  }
}

function permissionFromRules(
  accumulator: PermissionRuleAccumulator,
): Record<string, Record<string, PermissionSetting>> | undefined {
  const permission: Record<string, Record<string, PermissionSetting>> = {}
  for (const [tool, rules] of accumulator) {
    permission[tool] = Object.fromEntries(rules)
  }
  return Object.keys(permission).length > 0 ? permission : undefined
}

function setPermissionRule(
  accumulator: PermissionRuleAccumulator,
  tool: string,
  pattern: string,
  setting: PermissionSetting,
): void {
  const rules = accumulator.get(tool) ?? new Map<string, PermissionSetting>()
  // OpenCode permission evaluation uses the last matching rule. Map insertion
  // order is therefore intentional here: delete before set moves same-pattern
  // overrides to the end so stronger exact overlays beat weaker category rules.
  if (rules.has(pattern)) rules.delete(pattern)
  rules.set(pattern, setting)
  accumulator.set(tool, rules)
}

function isPermissionSettingValue(value: unknown): value is PermissionSetting {
  return value === 'ask' || value === 'allow' || value === 'deny'
}

/**
 * Collect commands from a directory. The bundled commands/ directory was removed
 * (all commands converted to skills), but this path is retained for backward
 * compatibility with any future bundled commands or external tooling.
 * walkDir returns an empty array when the directory does not exist.
 */
function collectCommands(
  dir: string,
  disabledCommands: string[],
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}
  const commandList = findCommandsInDir(dir)

  for (const commandInfo of commandList) {
    const cleanName = commandInfo.name.replace(/^\//, '')
    if (disabledCommands.includes(cleanName)) continue

    const config = loadCommandAsConfig(commandInfo)
    if (config) {
      // Prefix commands without a colon with 'systematic:'
      const prefixedName = cleanName.includes(':')
        ? cleanName
        : `systematic:${cleanName}`
      commands[prefixedName] = config
    }
  }

  return commands
}

function collectSkillsAsCommands(
  dir: string,
  disabledSkills: string[],
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}
  const skillList = findSkillsInDir(dir)

  for (const skillInfo of skillList) {
    if (disabledSkills.includes(skillInfo.name)) continue

    const loaded = loadSkill(skillInfo)
    if (loaded) {
      if (loaded.userInvocable === false) continue

      commands[loaded.prefixedName] = loadSkillAsCommand(loaded)
    }
  }

  return commands
}

function collectEnabledSkillNames(
  dir: string,
  disabledSkills: string[],
): string[] {
  const disabledSet = new Set(disabledSkills)
  return findSkillsInDir(dir)
    .filter((skillInfo) => !disabledSet.has(skillInfo.name))
    .map((skillInfo) => skillInfo.name)
}

/**
 * Create the config hook handler for the Systematic plugin.
 *
 * This follows the pattern used by oh-my-opencode to inject bundled agents,
 * skills (as commands), and commands into OpenCode's configuration.
 *
 * Bundled content is loaded and then tuned with Systematic agent overlays.
 * Existing native OpenCode agents with the same emitted key are preserved as
 * replacements for bundled agents.
 */
export function createConfigHandler(deps: ConfigHandlerDeps) {
  const { directory, bundledSkillsDir, bundledAgentsDir, bundledCommandsDir } =
    deps

  return async (config: Config): Promise<void> => {
    const { config: systematicConfig, overlays } =
      loadConfigWithSources(directory)
    const existingAgents = { ...(config.agent ?? {}) }
    const existingCommands = { ...(config.command ?? {}) }
    const nativeAgents = Object.fromEntries(
      Object.entries(existingAgents).filter(
        ([, agent]) => !isSystematicAgentConfig(agent),
      ),
    ) as Record<string, unknown>

    const bundledSkills = collectSkillsAsCommands(
      bundledSkillsDir,
      systematicConfig.disabled_skills,
    )
    const enabledSkillNames = collectEnabledSkillNames(
      bundledSkillsDir,
      systematicConfig.disabled_skills,
    )
    const inventory = buildBundledAgentInventory(
      bundledAgentsDir,
      systematicConfig.disabled_agents,
    )
    assertSourceCategoryModelCoverage(inventory.categories)
    const validatedOverlays = validateAgentOverlays({
      inventory,
      overlays,
      nativeAgents,
      enabledSkills: enabledSkillNames,
    })
    const resolvedOverlays = resolveAgentOverlaySet(validatedOverlays)

    // When the client is unavailable (tests that don't inject it), or when
    // discovery fails entirely (API + cache both unreachable), we fall
    // through to OpenCode parent-model inheritance for bundled agents
    // rather than pinning potentially-wrong defaults.
    const availability = deps.client
      ? await getAvailableModels(deps.client)
      : undefined
    const availabilitySet =
      availability && availability.status !== 'unknown'
        ? availability.models
        : undefined
    const bundledAgents = collectAgents(
      bundledAgentsDir,
      systematicConfig.disabled_agents,
      nativeAgents,
      resolvedOverlays,
      availabilitySet,
    )

    const bundledCommands = collectCommands(
      bundledCommandsDir,
      systematicConfig.disabled_commands,
    )

    config.agent = mergeSystematicEntries(
      existingAgents as Record<string, AgentConfig>,
      bundledAgents as Record<string, AgentConfig>,
      isSystematicAgentConfig,
    )

    const emittedCommands = { ...bundledCommands, ...bundledSkills }
    config.command = mergeSystematicEntries(
      existingCommands as Record<string, CommandConfig>,
      emittedCommands as Record<string, CommandConfig>,
      isSystematicCommandConfig,
    )

    // skills.paths exists at runtime (v2 SDK types) but not in our v1 import
    registerSkillsPaths(config, bundledSkillsDir)
  }
}

// Config.skills exists in v2 SDK types but not v1 — bridge until import upgrade
type ConfigWithSkills = Config & {
  skills?: { paths?: string[] }
}

/** Register a directory for OpenCode's native skill discovery (`skill` tool). */
export function registerSkillsPaths(config: Config, skillsDir: string): void {
  const extended = config as ConfigWithSkills
  const paths = extended.skills?.paths ?? []
  const nextPaths = removeSystematicSkillPaths(paths)
  if (!nextPaths.includes(skillsDir)) nextPaths.push(skillsDir)
  extended.skills = {
    ...extended.skills,
    paths: nextPaths,
  }
}

function removeSystematicSkillPaths(paths: string[]): string[] {
  return paths.filter((path) => !isSystematicSkillPath(path))
}

function isSystematicSkillPath(path: string): boolean {
  return /(?:^|[\\/])systematic(?:[\\/])skills(?:$|[\\/])/u.test(path)
}
