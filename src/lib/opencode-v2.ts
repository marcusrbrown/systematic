import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin'
import { type AssetPlan, buildAssetPlan } from './asset-plan.js'
import { composeBootstrapContent } from './bootstrap.js'
import { loadConfigWithSources, type SystematicConfig } from './config.js'

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

const noopInstaller: V2Installer = () => {}

/** Empty slots. Each domain replaces its own entry when it lands. */
const DEFAULT_INSTALLERS: V2Installers = {
  agents: noopInstaller,
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
