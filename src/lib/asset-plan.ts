import fs from 'node:fs'
import type { AgentConfig } from '@opencode-ai/sdk'
import {
  buildBundledAgentInventory,
  type ResolvedAgentOverlaySet,
  resolveAgentOverlaySet,
  validateAgentOverlays,
} from './agent-overlays.js'
import { extractAgentFrontmatter, findAgentsInDir } from './agents.js'
import { extractCommandFrontmatter, findCommandsInDir } from './commands.js'
import type { SourcedOverlayConfigMap, SystematicConfig } from './config.js'
import { type DiscoveredSkill, discoverSkills } from './discovered-skills.js'
import { parseFrontmatter } from './frontmatter.js'
import { type RoutingResolution, resolveRouting } from './routing-resolver.js'
import {
  type LoadedSkill,
  loadSkill,
  wrapSkillTemplate,
} from './skill-loader.js'
import { findSkillsInDir } from './skills.js'
import { isAgentMode, isRecord, type PermissionSetting } from './validation.js'

/**
 * Host-neutral asset plan: which agents, commands and enabled skills the
 * plugin contributes, computed from the already-loaded Systematic config and
 * the bundled asset directories.
 *
 * The plan never reads or writes a host config object and never loads
 * `systematic.json` itself. Invalid config therefore stays a loader concern:
 * on OpenCode v1 `loadConfigWithSources` throws before a plan is built.
 *
 * Permissions are an ordered list of triples, not an object map. A JS object
 * hoists integer-like keys, so a map cannot carry a skills list such as
 * `['10', 'alpha', '2']` in true insertion order. The v1 adapter folds the
 * list into today's map; other adapters translate the list directly.
 */

/**
 * One permission rule. Within a `permission`, rules apply in list order and
 * the last matching rule wins, so a repeated pattern moves to the end.
 */
export interface PermissionRuleTriple {
  permission: string
  pattern: string
  setting: PermissionSetting
}

/**
 * Permission state of a planned agent.
 *
 * - `unmanaged`: no overlay controls permissions. The agent's own
 *   `config.permission` (from its frontmatter) applies untouched.
 * - `managed`: overlays control permissions. `rules` replaces
 *   `config.permission` entirely; an empty list means "no permission".
 */
export type PlannedAgentPermission =
  | { kind: 'unmanaged' }
  | { kind: 'managed'; rules: readonly PermissionRuleTriple[] }

export interface PlannedAgent {
  /** Emitted agent key (the bare agent name, category dropped). */
  name: string
  /** Agent config with every overlay applied except a managed permission. */
  config: AgentConfig
  permission: PlannedAgentPermission
}

export interface PlannedCommand {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

export interface AssetPlan {
  /** Bundled skills directory, for hosts that register it for native discovery. */
  skillsDir: string
  /** Bundled skill names that are not disabled. */
  enabledSkills: readonly string[]
  /** Agents keyed by emitted agent name, in discovery order. */
  agents: Record<string, PlannedAgent>
  /** Commands keyed by emitted command name: bundled commands, then skills, then discovered skills. */
  commands: Record<string, PlannedCommand>
}

export interface AssetPlanInput {
  /** Loaded Systematic config. The builder reads only the disabled lists and `skills_as_commands`. */
  config: Pick<
    SystematicConfig,
    | 'disabled_skills'
    | 'disabled_agents'
    | 'disabled_commands'
    | 'skills_as_commands'
  >
  overlays: SourcedOverlayConfigMap
  /** Agent names the user or host already owns. A bundled agent of the same name is not emitted. */
  nativeAgentNames: readonly string[]
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
  homeDir: string
  opencodeConfigDir: string
  opencodeConfigDirOverride?: string
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
}): PlannedCommand | null {
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

    const config: PlannedCommand = {
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

function loadSkillAsCommand(loaded: LoadedSkill): PlannedCommand {
  const config: PlannedCommand = {
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
  nativeAgentNames: ReadonlySet<string>,
  overlays: ResolvedAgentOverlaySet,
  rawOverlays: SourcedOverlayConfigMap,
): Record<string, PlannedAgent> {
  const agents: Record<string, PlannedAgent> = {}
  const agentList = findAgentsInDir(dir)
  const disabledSet = new Set(disabledAgents)

  for (const agentInfo of agentList) {
    const id = agentInfo.category
      ? `${agentInfo.category}/${agentInfo.name}`
      : agentInfo.name
    if (disabledSet.has(agentInfo.name) || disabledSet.has(id)) continue
    if (nativeAgentNames.has(agentInfo.name)) continue

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
): PlannedAgent {
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

  return {
    name: agentInfo.name,
    config: result,
    permission: hasPermissionOverlay
      ? { kind: 'managed', rules: permissionRulesToTriples(permissionRules) }
      : { kind: 'unmanaged' },
  }
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

function overlayControlsPermission(
  overlay: Record<string, unknown> | undefined,
): boolean {
  return (
    overlay !== undefined &&
    (Object.hasOwn(overlay, 'permission') || Object.hasOwn(overlay, 'skills'))
  )
}

// `model`/`variant` are no longer read from here — see `applyAgentOverlayPass`
// and `resolveRouting`. Every other overlay-assignable field is copied by its
// own guarded assignment, in this order, so key insertion order is unchanged.
// The config schema already types each field, so the guards drop nothing a
// validated overlay can hold.
function applyOverlayObjectFields(
  target: AgentConfig,
  overlay: Record<string, unknown>,
): void {
  if (typeof overlay.temperature === 'number') {
    target.temperature = overlay.temperature
  }
  if (typeof overlay.top_p === 'number') target.top_p = overlay.top_p
  if (isAgentMode(overlay.mode)) target.mode = overlay.mode
  if (typeof overlay.color === 'string') target.color = overlay.color
  if (typeof overlay.steps === 'number') target.steps = overlay.steps
  if (typeof overlay.hidden === 'boolean') target.hidden = overlay.hidden
}

/**
 * Accumulates rules per permission (insertion-ordered) and per pattern
 * (insertion-ordered). {@link permissionRulesToTriples} flattens it into the
 * ordered list the plan exposes: permissions in first-appearance order, each
 * permission's rules in last-set order.
 */
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

function permissionRulesToTriples(
  accumulator: PermissionRuleAccumulator,
): PermissionRuleTriple[] {
  const triples: PermissionRuleTriple[] = []
  for (const [permission, rules] of accumulator) {
    for (const [pattern, setting] of rules) {
      triples.push({ permission, pattern, setting })
    }
  }
  return triples
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
): Record<string, PlannedCommand> {
  const commands: Record<string, PlannedCommand> = {}
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
): Record<string, PlannedCommand> {
  const commands: Record<string, PlannedCommand> = {}
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
 * Convert a discovered (non-bundled) skill into a command entry.
 *
 * Every discovered skill's command inlines its full body via
 * `wrapSkillTemplate`. The resulting template goes through OpenCode's native
 * command processing (argument substitution and `!`-backtick snippet
 * execution) — the same handling OpenCode's own skill command gets when
 * Systematic doesn't shadow it.
 */
function loadDiscoveredSkillAsCommand(skill: DiscoveredSkill): PlannedCommand {
  const description = skill.description || `${skill.name} skill`

  // Body was read once at discovery time (DiscoveredSkill.body); no re-read.
  return {
    template: wrapSkillTemplate(skill.skillPath, skill.body),
    description,
  }
}

/**
 * Collect discovered (non-bundled) user/project skills as command entries.
 * Never throws: `discoverSkills` is defect-swallowing by contract,
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
): Record<string, PlannedCommand> {
  const commands: Record<string, PlannedCommand> = {}

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
 * Build the asset plan. The collection order below is load-bearing: warnings
 * and diagnostics from the collectors reach the console in this order, and the
 * v1 goldens pin them.
 */
export function buildAssetPlan(input: AssetPlanInput): AssetPlan {
  const { config, overlays, bundledSkillsDir, bundledAgentsDir } = input
  const nativeAgentNames = new Set(input.nativeAgentNames)

  const skillCommands = collectSkillsAsCommands(
    bundledSkillsDir,
    config.disabled_skills,
  )
  const enabledSkills = collectEnabledSkillNames(
    bundledSkillsDir,
    config.disabled_skills,
  )
  const inventory = buildBundledAgentInventory(
    bundledAgentsDir,
    config.disabled_agents,
  )

  const validatedOverlays = validateAgentOverlays({
    inventory,
    overlays,
    nativeAgents: Object.fromEntries(
      input.nativeAgentNames.map((name) => [name, true]),
    ),
    enabledSkills,
  })
  const resolvedOverlays = resolveAgentOverlaySet(validatedOverlays)
  const agents = collectAgents(
    bundledAgentsDir,
    config.disabled_agents,
    nativeAgentNames,
    resolvedOverlays,
    overlays,
  )

  const bundledCommands = collectCommands(
    input.bundledCommandsDir,
    config.disabled_commands,
  )

  const discoveredSkillCommands =
    config.skills_as_commands !== false
      ? collectDiscoveredSkillsAsCommands(
          input.directory,
          input.homeDir,
          input.opencodeConfigDir,
          input.opencodeConfigDirOverride,
          config.disabled_commands,
        )
      : {}

  return {
    skillsDir: bundledSkillsDir,
    enabledSkills,
    agents,
    commands: {
      ...bundledCommands,
      ...skillCommands,
      ...discoveredSkillCommands,
    },
  }
}
