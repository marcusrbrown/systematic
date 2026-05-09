import type { Config } from '@opencode-ai/plugin'
import type { AgentConfig } from '@opencode-ai/sdk'
import {
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
import { type LoadedSkill, loadSkill } from './skill-loader.js'
import { findSkillsInDir } from './skills.js'
import { isRecord, type PermissionSetting } from './validation.js'

export interface ConfigHandlerDeps {
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
}

type CommandConfig = NonNullable<Config['command']>[string]

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

function collectAgents(
  dir: string,
  disabledAgents: string[],
  nativeAgents: Record<string, unknown>,
  overlays: ResolvedAgentOverlaySet,
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
      agents[agentInfo.name] = applyAgentOverlays(config, agentInfo, overlays)
    }
  }

  return agents
}

function applyAgentOverlays(
  config: AgentConfig,
  agentInfo: { name: string; category?: string },
  overlays: ResolvedAgentOverlaySet,
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

  if (categoryOverlay) {
    applyOverlayObject(result, categoryOverlay.value, permissionRules)
  }
  if (exactOverlay) {
    applyOverlayObject(result, exactOverlay.value, permissionRules)
  }

  if (hasPermissionOverlay) {
    const permission = permissionFromRules(permissionRules)
    if (permission) {
      result.permission = permission as AgentConfig['permission']
    } else {
      delete result.permission
    }
  }

  return result
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

function applyOverlayObject(
  target: AgentConfig,
  overlay: Record<string, unknown>,
  permissionRules: PermissionRuleAccumulator,
): void {
  for (const field of OVERLAY_ASSIGN_FIELDS) {
    if (Object.hasOwn(overlay, field)) {
      ;(target as Record<string, unknown>)[field] = overlay[field]
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
    const validatedOverlays = validateAgentOverlays({
      inventory,
      overlays,
      nativeAgents: existingAgents,
      enabledSkills: enabledSkillNames,
    })
    const resolvedOverlays = resolveAgentOverlaySet(validatedOverlays)

    const bundledAgents = collectAgents(
      bundledAgentsDir,
      systematicConfig.disabled_agents,
      existingAgents,
      resolvedOverlays,
    )

    const bundledCommands = collectCommands(
      bundledCommandsDir,
      systematicConfig.disabled_commands,
    )

    config.agent = {
      ...bundledAgents,
      ...existingAgents,
    }

    config.command = {
      ...bundledCommands,
      ...bundledSkills,
      ...existingCommands,
    }

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
  const nextPaths = paths.includes(skillsDir)
    ? [...paths]
    : [...paths, skillsDir]
  extended.skills = {
    ...extended.skills,
    paths: nextPaths,
  }
}
