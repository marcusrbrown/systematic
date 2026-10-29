import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/plugin'
import type { AgentConfig } from '@opencode-ai/sdk'
import {
  type AssetPlan,
  buildAssetPlan,
  type PermissionRuleTriple,
  type PlannedAgent,
} from './asset-plan.js'
import { loadConfigWithSources } from './config.js'
import { formatSkillCommandName } from './skill-loader.js'
import { isRecord, type PermissionSetting } from './validation.js'

// The agent-description helpers moved to the shared asset plan; keep the
// long-standing import path working.
export { formatAgentDescription, toTitleCase } from './asset-plan.js'

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

/**
 * Per-tool permission rule map as actually emitted by {@link foldPermissionRulesToV1Map}:
 * each key is a match pattern (`'*'` or an exact name) mapped to a setting.
 */
export type AgentPermissionRuleMap = Record<string, PermissionSetting>

/**
 * Agent permission shape as emitted onto `AgentConfig.permission`, narrowed at
 * this module's boundary to include `skill`. The `@opencode-ai/sdk` v1 `Config`
 * type this module targets omits `skill` from `AgentConfig['permission']`
 * (it only appears on the SDK's v2 `PermissionRuleConfig` surface), but
 * `toV1AgentConfig` genuinely writes a `skill` rule map identical in shape
 * to `bash`. This type documents and reads that
 * real runtime shape without migrating the module to the v2 type surface.
 *
 * `foldPermissionRulesToV1Map` emits a rule map for whatever permission key
 * appears in the rule list — not just the named keys below (e.g. `task`, per
 * `PermissionConfig` in validation.ts and the `task` overlay field applied in
 * the asset plan's overlay pass). The named keys stay for documentation of
 * the common cases; the index signature covers every other emitted tool key.
 */
export interface EmittedAgentPermission {
  edit?: AgentPermissionRuleMap
  bash?: AgentPermissionRuleMap
  webfetch?: AgentPermissionRuleMap
  doom_loop?: AgentPermissionRuleMap
  external_directory?: AgentPermissionRuleMap
  skill?: AgentPermissionRuleMap
  readonly [tool: string]: AgentPermissionRuleMap | undefined
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

/**
 * Fold the shared core's ordered permission list into the v1 object map.
 *
 * This is the v1-only step that loses information: a plain object hoists
 * integer-like keys, so a skills list such as `['10', 'alpha', '2']` becomes
 * `{2, 10, *, alpha}` here even though the list kept true insertion order.
 * That hoisting is today's v1 behavior (pinned by the v1 golden tests) and is
 * reproduced on purpose.
 *
 * A repeated permission and pattern is last-match-wins and moves to the end,
 * as in the accumulator that produced the list. Returns `undefined` for an
 * empty list.
 *
 * v1 has two skill tools that ask permission under two names: the native
 * `skill` tool with the bare name, `systematic_skill` with `systematic:<name>`.
 * A rule reaches only the tool whose form it uses. A bare allow whose winning
 * rule came from a managed `skills` list (`fromSkillsList`) is followed by the
 * same allow for the prefixed form, so the list reaches both tools. A rule the
 * user wrote by hand is never mirrored, and a mirror never replaces a deny or
 * ask the user wrote for the prefixed name, wherever it sits in the list:
 * explicit rules beat generated ones. A hand-written prefixed allow agrees with
 * the mirror, so the mirror still moves it after the list's `*` deny.
 */
export function foldPermissionRulesToV1Map(
  rules: readonly PermissionRuleTriple[],
): Record<string, Record<string, PermissionSetting>> | undefined {
  const explicitSkillSettings = new Map<string, PermissionSetting>()
  for (const rule of rules) {
    if (rule.permission === 'skill' && !rule.fromSkillsList) {
      explicitSkillSettings.set(rule.pattern, rule.setting)
    }
  }
  const byPermission = new Map<string, Map<string, PermissionSetting>>()
  const setRule = (
    permission: string,
    pattern: string,
    setting: PermissionSetting,
  ): void => {
    const patterns =
      byPermission.get(permission) ?? new Map<string, PermissionSetting>()
    if (patterns.has(pattern)) patterns.delete(pattern)
    patterns.set(pattern, setting)
    byPermission.set(permission, patterns)
  }
  for (const { permission, pattern, setting, fromSkillsList } of rules) {
    setRule(permission, pattern, setting)
    if (permission !== 'skill' || setting !== 'allow' || !fromSkillsList) {
      continue
    }
    const prefixed = formatSkillCommandName(pattern)
    const explicit = explicitSkillSettings.get(prefixed)
    if (prefixed !== pattern && (explicit ?? 'allow') === 'allow') {
      setRule(permission, prefixed, setting)
    }
  }

  const folded: Record<string, Record<string, PermissionSetting>> = {}
  for (const [permission, patterns] of byPermission) {
    folded[permission] = Object.fromEntries(patterns)
  }
  return Object.keys(folded).length > 0 ? folded : undefined
}

/**
 * Turn a planned agent into the v1 `config.agent` entry. A managed
 * permission replaces the agent's own permission in place (key position is
 * kept) or removes it when the folded map is empty.
 */
export function toV1AgentConfig(planned: PlannedAgent): AgentConfig {
  const result: AgentConfig = { ...planned.config }
  if (planned.permission.kind === 'unmanaged') return result

  const permission = foldPermissionRulesToV1Map(planned.permission.rules)
  if (permission) {
    result.permission = permission as AgentConfig['permission']
  } else {
    delete result.permission
  }
  return result
}

/**
 * Agents OpenCode v1 always defines for a command to name: `build`, `plan`,
 * `general` and `explore` (`packages/opencode/src/agent/agent.ts` at v1.19.4).
 * The host also keeps three hidden internal agents (`compaction`, `title`,
 * `summary`); a skill has no reason to route there, so they are left out.
 */
const OPENCODE_V1_BUILT_IN_AGENTS = [
  'build',
  'plan',
  'general',
  'explore',
] as const

/**
 * Agent names a command can route to once every plugin has merged its agents:
 * the built-ins plus every key of `config.agent`, except an agent switched off
 * with `disable: true`, which the host removes. The host matches names exactly.
 */
function knownAgentNames(
  agents: Record<string, AgentConfig | undefined> | undefined,
): Set<string> {
  const known = new Set<string>(OPENCODE_V1_BUILT_IN_AGENTS)
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (agent?.disable === true) known.delete(name)
    else known.add(name)
  }
  return known
}

/** Why a declared agent cannot be passed on, or `undefined` when it can. */
function agentProblem(
  agent: string,
  isSubtask: boolean,
  known: ReadonlySet<string>,
): string | undefined {
  if (!isSubtask) {
    return `sets agent "${agent}" but does not run as a subtask (context: fork or subtask: true)`
  }
  return known.has(agent)
    ? undefined
    : `sets agent "${agent}", which is not an OpenCode agent`
}

/**
 * Why a declared model cannot be passed on, or `undefined` when it can. The
 * shape is `provider/model` with both sides non-empty; whether the provider
 * exists is the host's call.
 */
function modelProblem(model: string): string | undefined {
  const slash = model.indexOf('/')
  return slash > 0 && slash < model.length - 1
    ? undefined
    : `sets model "${model}", which is not in provider/model form`
}

const IGNORED_ROUTING_HINT =
  'it is ignored. Write an OpenCode command to route it.'

/**
 * Copy the routing a discovered skill declared onto its emitted command, but
 * only the parts OpenCode v1 can run. A value the host would reject (an unknown
 * agent, a model that is not `provider/model`) would make the whole command
 * fail, so it is dropped with one warning instead.
 *
 * - `subtask` passes through as declared, `false` included.
 * - `agent` passes only for a subtask, and only when it names a known agent.
 * - `model` passes only in `provider/model` form.
 *
 * A command that is not the one this hook emitted (a user command of the same
 * name won the merge) is left alone, and nothing is reported for it.
 */
function applyDiscoveredRouting(
  config: Config,
  plan: AssetPlan,
  reported: Set<string>,
): void {
  const known = knownAgentNames(
    config.agent as Record<string, AgentConfig | undefined> | undefined,
  )
  const drop = (name: string, field: string, reason: string): void => {
    const key = `${name}\0${field}`
    if (reported.has(key)) return
    reported.add(key)
    console.warn(
      `[systematic] skill "${name}" ${reason}; ${IGNORED_ROUTING_HINT}`,
    )
  }

  for (const [name, declared] of Object.entries(plan.discoveredRouting)) {
    const command = config.command?.[name]
    if (command === undefined || command !== plan.commands[name]) continue

    const { agent, model, subtask } = declared
    if (agent !== undefined) {
      const problem = agentProblem(agent, subtask === true, known)
      if (problem === undefined) command.agent = agent
      else drop(name, 'agent', problem)
    }
    if (model !== undefined) {
      const problem = modelProblem(model)
      if (problem === undefined) command.model = model
      else drop(name, 'model', problem)
    }
    if (subtask !== undefined) command.subtask = subtask
  }
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
  // Routing warnings already written, so a repeat run of this hook stays quiet.
  const reportedRouting = new Set<string>()

  return async (config: Config): Promise<void> => {
    // Invalid config throws here, before any plan is built. v1 is not fail-open.
    const { config: systematicConfig, overlays } =
      loadConfigWithSources(directory)
    const existingAgents = { ...(config.agent ?? {}) }
    const existingCommands = { ...(config.command ?? {}) }
    const nativeAgentNames = Object.entries(existingAgents)
      .filter(([, agent]) => !isSystematicAgentConfig(agent))
      .map(([name]) => name)

    const plan = buildAssetPlan({
      config: systematicConfig,
      overlays,
      nativeAgentNames,
      directory,
      bundledSkillsDir,
      bundledAgentsDir,
      bundledCommandsDir,
      homeDir,
      opencodeConfigDir,
      opencodeConfigDirOverride,
    })
    const bundledAgents: Record<string, AgentConfig> = Object.fromEntries(
      Object.entries(plan.agents).map(([name, planned]) => [
        name,
        toV1AgentConfig(planned),
      ]),
    )

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
      bundledAgents,
      (key, agent) =>
        bundledAgentKeys.has(key) && isSystematicAgentConfig(agent),
    )

    // Bundled commands/skills carry the `(Systematic) ` marker and are
    // dropped-then-re-emitted every load (refresh semantics). Discovered-skill
    // commands are intentionally UNMARKED — they're the user's own skills,
    // not Systematic's — so they're add-if-absent and never refreshed or
    // cleaned up across reloads. That's fine: OpenCode rebuilds config
    // in-memory on every launch, so a deleted skill just isn't re-emitted;
    // nothing stale persists to disk.
    config.command = mergeSystematicEntries(
      existingCommands as Record<string, CommandConfig>,
      plan.commands,
      (_key, command) => isSystematicCommandConfig(command),
    )
    applyDiscoveredRouting(config, plan, reportedRouting)

    // skills.paths exists at runtime (v2 SDK types) but not in our v1 import
    registerSkillsPaths(config, plan.skillsDir)

    // The whole bundled skills directory is registered above, so OpenCode's
    // native `skill` tool would still list and load a disabled skill.
    denyDisabledSkills(config, systematicConfig.disabled_skills)
  }
}

/**
 * The deny rules this hook added to a config object, and the rule maps it wrote
 * them into. A deny on a bare name looks the same as one the user wrote, so the
 * hook remembers which it added and removes only those when a skill is enabled
 * again. The record is trusted only while `permission` and `permission.skill`
 * are still the same objects: if either was replaced, the user's map is not
 * ours and nothing in it is removed.
 */
interface OwnedSkillDenies {
  permission: RuleMap
  skill: RuleMap
  patterns: readonly string[]
}

const ownedSkillDenies = new WeakMap<object, OwnedSkillDenies>()

type RuleMap = Record<string, unknown>

/** The top-level `permission` as a rule map; a string shorthand becomes its `*` rule. */
function readPermissionMap(host: RuleMap): RuleMap {
  if (isRecord(host.permission)) return host.permission
  return typeof host.permission === 'string' ? { '*': host.permission } : {}
}

/** The `permission.skill` rule map; a string shorthand becomes its `*` rule. */
function readSkillRuleMap(permission: RuleMap): RuleMap {
  if (isRecord(permission.skill)) return permission.skill
  return typeof permission.skill === 'string' ? { '*': permission.skill } : {}
}

/** The bare name and, when it differs, the `systematic:` name of each skill. */
function skillDenyPatterns(skills: readonly string[]): string[] {
  return [...new Set(skills.flatMap((s) => [s, formatSkillCommandName(s)]))]
}

/**
 * Deny each disabled bundled skill for the native `skill` tool (bare name) and
 * for `systematic_skill` (`systematic:<name>`), at the top level of the
 * host config. Per-agent managed allows still override it.
 *
 * Re-running refreshes the denies: the ones added last time are removed first,
 * so a skill that is enabled again loses its denies and a repeat run changes
 * nothing. A rule the user already wrote for the same name is left alone, and
 * is not removed later. If the user replaced `permission` or `permission.skill`
 * since the last run, nothing is removed from the new map. A config with
 * nothing disabled is not touched.
 */
function denyDisabledSkills(
  config: Config,
  disabledSkills: readonly string[],
): void {
  const host = config as RuleMap
  const owned = ownedSkillDenies.get(config)
  const current = isRecord(host.permission) ? host.permission : undefined
  const stillOurs =
    owned !== undefined &&
    owned.permission === current &&
    owned.skill === current.skill
  const previous = stillOurs ? owned.patterns : []
  const wanted = skillDenyPatterns(disabledSkills)
  if (previous.length === 0 && wanted.length === 0) {
    ownedSkillDenies.delete(config)
    return
  }

  const permission = readPermissionMap(host)
  const skill = readSkillRuleMap(permission)

  for (const pattern of previous) {
    if (skill[pattern] === 'deny') delete skill[pattern]
  }
  const added = wanted.filter((pattern) => !Object.hasOwn(skill, pattern))
  for (const pattern of added) skill[pattern] = 'deny'

  if (Object.keys(skill).length > 0) permission.skill = skill
  else delete permission.skill
  if (Object.keys(permission).length > 0) host.permission = permission
  else delete host.permission

  if (added.length > 0) {
    ownedSkillDenies.set(config, { permission, skill, patterns: added })
  } else {
    ownedSkillDenies.delete(config)
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
