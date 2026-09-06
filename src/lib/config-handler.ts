import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/plugin'
import type { AgentConfig } from '@opencode-ai/sdk'
import {
  buildBundledAgentInventory,
  type ResolvedAgentOverlaySet,
  resolveAgentOverlaySet,
  validateAgentOverlays,
} from './agent-overlays.js'
import { extractAgentFrontmatter, findAgentsInDir } from './agents.js'
import { extractCommandFrontmatter, findCommandsInDir } from './commands.js'
import {
  loadConfigWithSources,
  type SourcedOverlayConfigMap,
} from './config.js'
import { type DiscoveredSkill, discoverSkills } from './discovered-skills.js'
import { parseFrontmatter } from './frontmatter.js'
import { type RoutingResolution, resolveRouting } from './routing-resolver.js'
import {
  type LoadedSkill,
  loadSkill,
  wrapSkillTemplate,
} from './skill-loader.js'
import { findSkillsInDir } from './skills.js'
import { isRecord, type PermissionSetting } from './validation.js'

export interface ConfigHandlerDeps {
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
  /** Home directory for discovered-skill lookups. Defaults to `os.homedir()`; inject a temp dir in tests. */
  homeDir?: string
  /** OpenCode global config directory override for discovered-skill lookups. Defaults to `<homeDir>/.config/opencode`. */
  opencodeConfigDir?: string
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
    typeof description === 'string' && description.startsWith('(Systematic) ')
  )
}

function mergeSystematicEntries<T>(
  existing: Record<string, T> | undefined,
  emitted: Record<string, T>,
  shouldDropExisting: (key: string, value: T | undefined) => boolean,
): Record<string, T> {
  const merged: Record<string, T> = { ...(existing ?? {}) }

  for (const [key, value] of Object.entries(existing ?? {})) {
    if (shouldDropExisting(key, value)) {
      delete merged[key]
    }
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
    const content = fs.readFileSync(agentInfo.file, 'utf8')
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
    } = extractAgentFrontmatter(content)

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
    const content = fs.readFileSync(commandInfo.file, 'utf8')
    const { name, description, agent, model, subtask } =
      extractCommandFrontmatter(content)
    const { body } = parseFrontmatter(content)

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
  rawOverlays: SourcedOverlayConfigMap,
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
        rawOverlays,
      )
    }
  }

  return agents
}

/**
 * `pi_subagents` overlays are irrelevant to the `opencode` harness — the
 * legacy `thinking` fallback the resolver consults is `pi`-only
 * (`resolveRouting` never reads it for `harness: 'opencode'`). A shared
 * empty constant avoids allocating a throwaway map per agent.
 */
const EMPTY_PI_SUBAGENTS_OVERLAYS: SourcedOverlayConfigMap = {
  agents: {},
  categories: {},
}

function applyAgentOverlays(
  config: AgentConfig,
  agentInfo: { name: string; category?: string },
  overlays: ResolvedAgentOverlaySet,
  rawOverlays: SourcedOverlayConfigMap,
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

  // `model`/`variant` are resolved once via the shared opencode routing
  // answer (agent block > agent flat > category block > category flat,
  // per R3a) instead of being read directly off each raw overlay object.
  // `resolution.source.{model,qualifier}.level` says which pass
  // ('category' or 'agent') the winning value came from, so it is applied
  // at that pass's point in the pipeline below — this preserves the exact
  // key-insertion order a config with no harness blocks or profiles
  // produced before this resolver existed (see
  // tests/unit/config-handler.test.ts's byte-identity corpus).
  const routing = resolveRouting({
    overlays: rawOverlays,
    piSubagentsOverlays: EMPTY_PI_SUBAGENTS_OVERLAYS,
    target: { agentKey: agentInfo.name, category: agentInfo.category ?? '' },
    harness: 'opencode',
  })

  applyAgentOverlayPass(
    result,
    categoryOverlay?.value,
    permissionRules,
    routing,
    'category',
  )
  applyAgentOverlayPass(
    result,
    exactOverlay?.value,
    permissionRules,
    routing,
    'agent',
  )
  applyPermissionOverlay(result, permissionRules, hasPermissionOverlay)

  return result
}

/**
 * Apply one overlay pass (category, then agent) to `target`: the routing
 * resolver's `model`/`variant` answer (only when this pass is where it won),
 * followed by the pass's own non-routing overlay fields and
 * permission/skills accumulation. Mirrors the pre-resolver two-pass
 * structure exactly so key insertion order is unaffected when no harness
 * block or profile changes the winning layer.
 */
function applyAgentOverlayPass(
  target: AgentConfig,
  overlay: Record<string, unknown> | undefined,
  permissionRules: PermissionRuleAccumulator,
  routing: RoutingResolution,
  level: 'agent' | 'category',
): void {
  if (routing.source.model?.level === level) {
    applyRoutingModel(target, routing.model)
  }
  if (routing.source.qualifier?.level === level) {
    target.variant = routing.qualifier
  }

  if (overlay === undefined) return
  applyOverlayObjectFields(target, overlay)

  if (isRecord(overlay.permission)) {
    addPermissionRules(permissionRules, overlay.permission)
  }
  if (Array.isArray(overlay.skills)) {
    addManagedSkillRules(permissionRules, overlay.skills)
  }
}

/** `model: null` means "restore inheritance" — remove any emitted model. */
function applyRoutingModel(
  target: AgentConfig,
  model: string | null | undefined,
): void {
  if (model === null) {
    delete target.model
  } else if (model !== undefined) {
    target.model = model
  }
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

/**
 * Per-tool permission rule map as actually emitted by {@link permissionFromRules}:
 * each key is a match pattern (`'*'` or an exact name) mapped to a setting.
 */
export type AgentPermissionRuleMap = Record<string, PermissionSetting>

/**
 * Agent permission shape as emitted onto `AgentConfig.permission`, narrowed at
 * this module's boundary to include `skill`. The `@opencode-ai/sdk` v1 `Config`
 * type this module targets omits `skill` from `AgentConfig['permission']`
 * (it only appears on the SDK's v2 `PermissionRuleConfig` surface), but
 * `applyPermissionOverlay`/`addManagedSkillRules` genuinely write a `skill`
 * rule map identical in shape to `bash`. This type documents and reads that
 * real runtime shape without migrating the module to the v2 type surface.
 */
export interface EmittedAgentPermission {
  edit?: AgentPermissionRuleMap
  bash?: AgentPermissionRuleMap
  webfetch?: AgentPermissionRuleMap
  doom_loop?: AgentPermissionRuleMap
  external_directory?: AgentPermissionRuleMap
  skill?: AgentPermissionRuleMap
}

/**
 * Read an agent's emitted permission map, narrowed to include `skill` (see
 * {@link EmittedAgentPermission}). Use this instead of `AgentConfig['permission']`
 * when a caller needs to observe the `skill` rule map this module writes.
 */
export function readEmittedAgentPermission(
  agent: AgentConfig | undefined,
): EmittedAgentPermission | undefined {
  if (agent?.permission === undefined) return undefined
  return agent.permission as EmittedAgentPermission
}

function overlayControlsPermission(
  overlay: Record<string, unknown> | undefined,
): boolean {
  return (
    overlay !== undefined &&
    (Object.hasOwn(overlay, 'permission') || Object.hasOwn(overlay, 'skills'))
  )
}

// `model`/`variant` are no longer read from here — see `applyAgentOverlayPass`
// and `resolveRouting`. Every other overlay-assignable field keeps its
// original direct-copy path, unchanged by the model-config-profiles feature.
const OVERLAY_ASSIGN_FIELDS = [
  'temperature',
  'top_p',
  'mode',
  'color',
  'steps',
  'hidden',
] as const

function applyOverlayObjectFields(
  target: AgentConfig,
  overlay: Record<string, unknown>,
): void {
  for (const field of OVERLAY_ASSIGN_FIELDS) {
    if (Object.hasOwn(overlay, field)) {
      ;(target as Record<string, unknown>)[field] = overlay[field]
    }
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

/**
 * Convert a discovered (non-bundled) skill into a `config.command` entry.
 *
 * Model-invocable skills get a one-line shim instructing the agent to load
 * the skill via OpenCode's native `skill` tool, with the argument string
 * wrapped as data (never concatenated into instruction text). Command-only
 * skills (`disable-model-invocation: true`) get the raw SKILL.md body
 * inlined instead — the sole R3 exception (R6).
 *
 * R6 honesty limit: Systematic cannot unregister a skill from OpenCode's own
 * model-facing skill tool/catalog — there is no API to hide a discovered
 * skill from the model. This function only controls the *command* surface
 * (`/skill-name`); the skill remains loadable by the model via the `skill`
 * tool regardless of `disable-model-invocation`. Do not attempt to mutate
 * OpenCode's skill registry or permissions here to compensate.
 */
function loadDiscoveredSkillAsCommand(skill: DiscoveredSkill): CommandConfig {
  const description = skill.description || `${skill.name} skill`

  if (skill.frontmatter.disableModelInvocation === true) {
    // Body was read once at discovery time (DiscoveredSkill.body); no re-read.
    return {
      template: wrapSkillTemplate(skill.skillPath, skill.body),
      description,
    }
  }

  return {
    template: buildDiscoveredSkillShimTemplate(skill.name),
    description,
  }
}

/**
 * Model-invocable shim template instructing the agent to load a discovered
 * skill via OpenCode's native `skill` tool. The argument string is wrapped as
 * data (`$ARGUMENTS` inside `<user-request>`), never concatenated into
 * instruction text.
 */
function buildDiscoveredSkillShimTemplate(skillName: string): string {
  return `Load the "${skillName}" skill using the skill tool, then follow its instructions to address this request:

<user-request>
$ARGUMENTS
</user-request>`
}

/**
 * Collect discovered (non-bundled) user/project skills as `config.command`
 * entries. Never throws: `discoverSkills` is defect-swallowing by contract,
 * and any unexpected error reading/parsing an individual skill degrades to
 * skipping that skill rather than aborting emission (hook-defect-swallow
 * learning — config hook code must not throw).
 */
function collectDiscoveredSkillsAsCommands(
  startDir: string,
  homeDir: string,
  configDir: string,
  opencodeConfigDirOverride: string | undefined,
  disabledCommands: string[],
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}

  let discovered: DiscoveredSkill[]
  try {
    discovered = discoverSkills({
      startDir,
      homeDir,
      configDir,
      opencodeConfigDirOverride,
    })
  } catch {
    // Config hook code must not throw (hook-defect-swallow): degrade to no
    // discovered commands this pass rather than aborting the whole config hook.
    return commands
  }

  for (const skill of discovered) {
    if (skill.frontmatter.userInvocable === false) continue
    // A discovered skill registers as a command under its bare name; the
    // strict `disabled_skills` enum only accepts bundled names, so the
    // free-form `disabled_commands` field is the suppression path here.
    if (disabledCommands.includes(skill.name)) continue

    try {
      commands[skill.name] = loadDiscoveredSkillAsCommand(skill)
    } catch {
      // Config hook code must not throw (hook-defect-swallow): skip this
      // skill; never let one bad SKILL.md abort emission for the rest.
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
  const homeDir = deps.homeDir ?? os.homedir()
  const opencodeConfigDir =
    deps.opencodeConfigDir ?? path.join(homeDir, '.config/opencode')
  const opencodeConfigDirOverride = process.env.OPENCODE_CONFIG_DIR?.trim()
    ? process.env.OPENCODE_CONFIG_DIR
    : undefined

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

    const validatedOverlays = validateAgentOverlays({
      inventory,
      overlays,
      nativeAgents,
      enabledSkills: enabledSkillNames,
    })
    const resolvedOverlays = resolveAgentOverlaySet(validatedOverlays)
    const bundledAgents = collectAgents(
      bundledAgentsDir,
      systematicConfig.disabled_agents,
      nativeAgents,
      resolvedOverlays,
      overlays,
    )

    const bundledCommands = collectCommands(
      bundledCommandsDir,
      systematicConfig.disabled_commands,
    )

    const discoveredSkillCommands =
      systematicConfig.skills_as_commands !== false
        ? collectDiscoveredSkillsAsCommands(
            directory,
            homeDir,
            opencodeConfigDir,
            opencodeConfigDirOverride,
            systematicConfig.disabled_commands,
          )
        : {}

    // The drop predicate uses the explicit emitted-key set instead of
    // `Object.hasOwn(bundledAgents, key)` so the invariant ("only drop a prior
    // entry when this hook is emitting a replacement") is self-evident and
    // independent of how `collectAgents` builds its result. The
    // `isSystematicAgentConfig` regex matches descriptions ending with
    // `(<Name> - Systematic)`; this is a heuristic, not ownership proof. A
    // user-authored agent with a Systematic-styled description can be treated
    // as prior Systematic output. Acceptable today because the false-positive
    // only triggers when the user also reuses an emitted key — which already
    // signals an intentional override.
    const bundledAgentKeys = new Set(Object.keys(bundledAgents))
    config.agent = mergeSystematicEntries(
      existingAgents as Record<string, AgentConfig>,
      bundledAgents as Record<string, AgentConfig>,
      (key, agent) =>
        bundledAgentKeys.has(key) && isSystematicAgentConfig(agent),
    )

    const emittedCommands = {
      ...bundledCommands,
      ...bundledSkills,
      ...discoveredSkillCommands,
    }
    // Bundled commands/skills carry the `(Systematic) ` marker and are
    // dropped-then-re-emitted every load (refresh semantics). Discovered-skill
    // commands are intentionally UNMARKED — they're the user's own skills,
    // not Systematic's — so they're add-if-absent and never refreshed or
    // cleaned up across reloads. That's fine: OpenCode rebuilds config
    // in-memory on every launch, so a deleted skill just isn't re-emitted;
    // nothing stale persists to disk.
    config.command = mergeSystematicEntries(
      existingCommands as Record<string, CommandConfig>,
      emittedCommands as Record<string, CommandConfig>,
      (_key, command) => isSystematicCommandConfig(command),
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
  const normalizedPath = normalizePath(path)
  return (
    normalizedPath.endsWith('/.config/opencode/systematic/skills') ||
    normalizedPath.endsWith('/.cache/opencode/systematic/skills') ||
    normalizedPath.endsWith('/.local/share/opencode/systematic/skills') ||
    normalizedPath.endsWith('/.opencode/systematic/skills') ||
    /(?:^|\/)\.cache\/opencode\/packages\/@fro\.bot\/systematic@[^/]+\/node_modules\/@fro\.bot\/systematic\/skills(?:$|\/)/u.test(
      normalizedPath,
    )
  )
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/u, '')
}
