import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/plugin'
import type { AgentConfig } from '@opencode-ai/sdk'
import {
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
 * A rule reaches only the tool whose form it uses. `skillsListNames` is the
 * skills a managed `skills` list named; each such bare allow is followed by
 * the same allow for the prefixed form, so the list reaches both tools. A skill
 * rule the user wrote by hand is never mirrored: copying it could undo an
 * explicit rule for the other name.
 */
export function foldPermissionRulesToV1Map(
  rules: readonly PermissionRuleTriple[],
  skillsListNames: readonly string[] = [],
): Record<string, Record<string, PermissionSetting>> | undefined {
  const mirrored = new Set(skillsListNames)
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
  for (const { permission, pattern, setting } of rules) {
    setRule(permission, pattern, setting)
    if (
      permission === 'skill' &&
      setting === 'allow' &&
      mirrored.has(pattern)
    ) {
      const prefixed = formatSkillCommandName(pattern)
      if (prefixed !== pattern) setRule(permission, prefixed, setting)
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

  const permission = foldPermissionRulesToV1Map(
    planned.permission.rules,
    planned.permission.skillsListNames,
  )
  if (permission) {
    result.permission = permission as AgentConfig['permission']
  } else {
    delete result.permission
  }
  return result
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

    // skills.paths exists at runtime (v2 SDK types) but not in our v1 import
    registerSkillsPaths(config, plan.skillsDir)

    // The whole bundled skills directory is registered above, so OpenCode's
    // native `skill` tool would still list and load a disabled skill.
    denyDisabledSkills(config, systematicConfig.disabled_skills)
  }
}

/**
 * The deny rules this hook added to a config object, by config object. A deny
 * on a bare name looks the same as one the user wrote, so the hook remembers
 * which it added and removes only those when a skill is enabled again.
 */
const ownedSkillDenies = new WeakMap<object, string[]>()

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
 * is not removed later. A config with nothing disabled is not touched.
 */
function denyDisabledSkills(
  config: Config,
  disabledSkills: readonly string[],
): void {
  const previous = ownedSkillDenies.get(config) ?? []
  const wanted = skillDenyPatterns(disabledSkills)
  if (previous.length === 0 && wanted.length === 0) return

  const host = config as RuleMap
  const permission = readPermissionMap(host)
  const skill = readSkillRuleMap(permission)

  for (const pattern of previous) {
    if (skill[pattern] === 'deny') delete skill[pattern]
  }
  const added = wanted.filter((pattern) => !Object.hasOwn(skill, pattern))
  for (const pattern of added) skill[pattern] = 'deny'
  ownedSkillDenies.set(config, added)

  if (Object.keys(skill).length > 0) permission.skill = skill
  else delete permission.skill
  if (Object.keys(permission).length > 0) host.permission = permission
  else delete host.permission
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
