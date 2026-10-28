import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin'
import {
  type AssetPlan,
  buildAssetPlan,
  type PlannedAgent,
} from './asset-plan.js'
import { composeBootstrapContent } from './bootstrap.js'
import { loadConfigWithSources, type SystematicConfig } from './config.js'
import {
  permissionMapToTriples,
  translatePermissionRules,
  type V2PermissionRule,
} from './opencode-v2-permissions.js'

/**
 * OpenCode v2 adapter scaffold.
 *
 * `setup` runs once per location. It loads config once, builds one frozen
 * snapshot (the asset plan plus the bootstrap content) and passes that same
 * object to each domain installer. The installers for agents, skills, commands
 * and bootstrap are empty slots here; each domain fills its own slot.
 *
 * Two failure rules shape the module:
 *
 * - Invalid config rejects `setup`, as it throws on v1. The host then logs that
 *   the plugin failed to load and carries on without it.
 * - Nothing else may throw into the host. A throwing transform disables the
 *   whole plugin, and a throwing hook breaks the turn it runs in. Every
 *   installer and every callback an installer registers therefore runs through
 *   the guard from {@link createSafeGuard}.
 *
 * No state lives at module scope. The host gives each location a fresh module
 * instance, and a transform replay must start from nothing but the snapshot.
 */

/** Prefix on every diagnostic: the only channel a v2 plugin has is server stderr. */
const DIAGNOSTIC_PREFIX = 'systematic:'

export interface SafeGuard {
  /** Wraps a synchronous callback. A throw is reported and the call returns `undefined`. */
  sync<Args extends unknown[], Result>(
    label: string,
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result | undefined
  /** Wraps an async callback. A throw or rejection is reported and the call resolves to `undefined`. */
  async<Args extends unknown[], Result>(
    label: string,
    callback: (...args: Args) => Promise<Result> | Result,
  ): (...args: Args) => Promise<Result | undefined>
}

function describeFailure(error: unknown): string {
  // Only an Error's message is reported. Any other thrown value could carry
  // user data, so it is never stringified into the log.
  return error instanceof Error ? error.message : 'unknown error'
}

function reportFailure(label: string, error: unknown): void {
  console.error(
    `${DIAGNOSTIC_PREFIX} ${label} failed: ${describeFailure(error)}`,
  )
}

/** Builds the never-throw wrapper that every installer and registered callback runs through. */
export function createSafeGuard(): SafeGuard {
  return {
    sync(label, callback) {
      return (...args) => {
        try {
          return callback(...args)
        } catch (error) {
          reportFailure(label, error)
          return undefined
        }
      }
    },
    async(label, callback) {
      return async (...args) => {
        try {
          return await callback(...args)
        } catch (error) {
          reportFailure(label, error)
          return undefined
        }
      }
    },
  }
}

/** Everything the installers share. Built once per `setup`, frozen, never rebuilt. */
export interface V2Snapshot {
  readonly config: SystematicConfig
  readonly plan: AssetPlan
  /** The composed bootstrap block, or `null` when bootstrap is disabled or empty. */
  readonly bootstrapContent: string | null
  /** The project directory the config was loaded for. */
  readonly directory: string
  readonly packageRoot: string
}

export interface V2InstallInput {
  readonly ctx: Plugin.Context
  readonly snapshot: V2Snapshot
  /** Wrap every callback registered with the host in this guard. */
  readonly guard: SafeGuard
}

export type V2Installer = (input: V2InstallInput) => Promise<void> | void

export interface V2Installers {
  agents: V2Installer
  skills: V2Installer
  commands: V2Installer
  bootstrap: V2Installer
}

/**
 * The part of a v2 agent this module reads and writes. The host's own agent
 * type is wider; it is assignable to this one, so no cast is needed.
 */
export interface V2AgentRecord {
  system?: string
  description?: string
  mode: 'primary' | 'subagent' | 'all'
  hidden: boolean
  color?: string
  steps?: number
  model?: { providerID: string; id: string; variant?: string }
  request: { body: Record<string, unknown> }
  permissions: V2PermissionRule[]
}

export interface V2AgentEditor {
  get(id: string): unknown
  update(id: string, update: (agent: V2AgentRecord) => void): void
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** `provider/model` to the v2 model shape. The model id may contain further slashes. */
function parseModel(
  model: string,
  variant: string | undefined,
): V2AgentRecord['model'] {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return undefined
  const providerID = model.slice(0, slash)
  const id = model.slice(slash + 1)
  return variant === undefined
    ? { providerID, id }
    : { providerID, id, variant }
}

function writeAgentModel(
  agent: V2AgentRecord,
  planned: PlannedAgent,
  reported: Set<string>,
): void {
  const { model, variant } = planned.config
  if (model === undefined) return
  const parsed = parseModel(
    model,
    typeof variant === 'string' ? variant : undefined,
  )
  if (parsed !== undefined) {
    agent.model = parsed
    return
  }
  const key = `model:${planned.name}`
  if (reported.has(key)) return
  reported.add(key)
  console.error(
    `${DIAGNOSTIC_PREFIX} agent "${planned.name}" has model "${model}", which is not provider/model; leaving its model unset`,
  )
}

/** The rules to append: a managed list, or the agent's own `permission` map. */
function agentPermissionRules(planned: PlannedAgent): V2PermissionRule[] {
  return translatePermissionRules(
    planned.permission.kind === 'managed'
      ? planned.permission.rules
      : permissionMapToTriples(planned.config.permission),
  )
}

/**
 * Fill a new v2 agent from its plan. Fields the plan leaves out keep the
 * host's defaults, so a bundled agent without a model inherits the session's.
 */
function writeAgentFields(
  agent: V2AgentRecord,
  planned: PlannedAgent,
  reported: Set<string>,
): void {
  const { config } = planned
  if (config.prompt !== undefined) agent.system = config.prompt
  if (config.description !== undefined) agent.description = config.description
  // v1 defaults an agent without a mode to `all`; the v2 default is `primary`.
  agent.mode = config.mode ?? 'all'
  if (typeof config.hidden === 'boolean') agent.hidden = config.hidden
  if (typeof config.steps === 'number') agent.steps = config.steps
  // v2 colors are six-digit hex; a v1 color token has no v2 spelling.
  if (config.color !== undefined && HEX_COLOR.test(config.color)) {
    agent.color = config.color
  }
  if (config.temperature !== undefined) {
    agent.request.body.temperature = config.temperature
  }
  if (config.top_p !== undefined) agent.request.body.top_p = config.top_p
  writeAgentModel(agent, planned, reported)
  // Appended after the host's default rules, so the last match still wins and
  // a tool the plan says nothing about keeps the host default.
  agent.permissions.push(...agentPermissionRules(planned))
}

/**
 * Create one planned agent on a transform editor. An id that already exists
 * belongs to the host or another plugin and is left alone. A same-named user
 * agent needs no check: user config applies after every plugin transform and
 * overlays what is created here.
 */
export function applyPlannedAgent(
  editor: V2AgentEditor,
  planned: PlannedAgent,
  reported: Set<string> = new Set(),
): void {
  if (planned.config.disable === true) return
  if (editor.get(planned.name) !== undefined) {
    const key = `clash:${planned.name}`
    if (reported.has(key)) return
    reported.add(key)
    console.error(
      `${DIAGNOSTIC_PREFIX} agent "${planned.name}" is already defined by the host or another plugin; skipping the bundled agent`,
    )
    return
  }
  editor.update(planned.name, (agent) => {
    writeAgentFields(agent, planned, reported)
  })
}

/**
 * Registers the planned agents through one transform. Each agent runs under
 * its own guard, so one failing `update` leaves the others registered. The
 * diagnostic set belongs to this `setup`; it only keeps a replay from
 * repeating a message and never changes what a replay produces.
 */
export const installAgents: V2Installer = async ({ ctx, snapshot, guard }) => {
  const reported = new Set<string>()
  await ctx.agent.transform(
    guard.sync('agent transform', (editor) => {
      for (const planned of Object.values(snapshot.plan.agents)) {
        const apply = guard.sync(`agent "${planned.name}"`, applyPlannedAgent)
        apply(editor, planned, reported)
      }
    }),
  )
}

const noopInstaller: V2Installer = () => {}

/** Slots not yet filled stay empty. Each domain replaces its own entry when it lands. */
const DEFAULT_INSTALLERS: V2Installers = {
  agents: installAgents,
  skills: noopInstaller,
  commands: noopInstaller,
  bootstrap: noopInstaller,
}

/** Installers run in this order. */
const INSTALLER_ORDER = [
  'agents',
  'skills',
  'commands',
  'bootstrap',
] as const satisfies readonly (keyof V2Installers)[]

export interface OpenCodeV2Deps {
  /**
   * Directory holding `skills/`, `agents/`, `commands/` and `package.json`.
   * Supplied by the entry point for the same reason as on v1: only the entry
   * point knows how far below the package root it sits.
   */
  packageRoot: string
  /** Home directory for user-level config and skill discovery. Defaults to `os.homedir()`; tests inject a temp dir. */
  homeDir?: string
  /** User-level OpenCode config directory. Defaults to `<homeDir>/.config/opencode`. */
  opencodeConfigDir?: string
  /** Replaces individual installer slots. Slots left out stay empty. */
  installers?: Partial<V2Installers>
}

/** The host promises a project directory; an empty or missing one means no project. */
function resolveProjectDirectory(ctx: Plugin.Context): string | undefined {
  const directory: unknown = ctx.location?.directory
  return typeof directory === 'string' && directory.length > 0
    ? directory
    : undefined
}

function buildSnapshot(ctx: Plugin.Context, deps: OpenCodeV2Deps): V2Snapshot {
  const { packageRoot } = deps
  const homeDir = deps.homeDir ?? os.homedir()
  const opencodeConfigDir =
    deps.opencodeConfigDir ?? path.join(homeDir, '.config/opencode')
  const opencodeConfigDirOverride = process.env.OPENCODE_CONFIG_DIR?.trim()
    ? process.env.OPENCODE_CONFIG_DIR
    : undefined
  const bundledSkillsDir = path.join(packageRoot, 'skills')

  const projectDirectory = resolveProjectDirectory(ctx)
  if (projectDirectory === undefined) {
    console.error(
      `${DIAGNOSTIC_PREFIX} the host gave no project directory; loading user-level config only`,
    )
  }
  // Without a project directory, discovery is rooted at the home directory so
  // it never falls back to the process working directory (which, inside a
  // shared v2 service, belongs to a different project).
  const directory = projectDirectory ?? homeDir

  // Invalid config throws here, before any plan is built. Not fail-open.
  const { config, overlays } = loadConfigWithSources(directory, {
    homeDir,
    userConfigDir: opencodeConfigDir,
    includeProject: projectDirectory !== undefined,
  })

  const plan = buildAssetPlan({
    config,
    overlays,
    // A user agent of the same name overlays ours after every plugin
    // transform runs, so there is nothing to check for ahead of time.
    nativeAgentNames: [],
    directory,
    bundledSkillsDir,
    bundledAgentsDir: path.join(packageRoot, 'agents'),
    bundledCommandsDir: path.join(packageRoot, 'commands'),
    homeDir,
    opencodeConfigDir,
    opencodeConfigDirOverride,
  })

  const bootstrapContent = composeBootstrapContent(config, {
    bundledSkillsDir,
    profile: 'opencode',
  })

  return Object.freeze({
    config,
    plan,
    bootstrapContent,
    directory,
    packageRoot,
  })
}

/**
 * Runs the v2 `setup` for one location: one config load, one snapshot, then
 * each installer in turn. Rejects on invalid config. An installer failure is
 * reported and never stops the next installer.
 */
export async function setupOpenCodeV2(
  ctx: Plugin.Context,
  deps: OpenCodeV2Deps,
): Promise<void> {
  const snapshot = buildSnapshot(ctx, deps)
  const guard = createSafeGuard()
  const installers: V2Installers = { ...DEFAULT_INSTALLERS, ...deps.installers }

  for (const slot of INSTALLER_ORDER) {
    const install = guard.async(`${slot} installer`, installers[slot])
    await install({ ctx, snapshot, guard })
  }
}
