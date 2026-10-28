import fs from 'node:fs'
import path from 'node:path'
import type { Config, Hooks, PluginInput } from '@opencode-ai/plugin'
import {
  applyBootstrapContent,
  composeBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
} from './bootstrap.js'
import { loadConfig } from './config.js'
import { createConfigHandler } from './config-handler.js'
import {
  createSkillOutputStore,
  createSkillTool,
  restoreCompactedSkillResults,
  restoreSkillOutput,
} from './skill-tool.js'
import { isRecord } from './validation.js'

// The content-integrity gate reads this typed inventory instead of inferring
// hooks from the returned object shape. It lives with the hooks it describes:
// the OpenCode v1 adapter.
const REGISTERED_PLUGIN_HOOKS = [
  'config',
  'tool',
  'tool.execute.after',
  'experimental.chat.messages.transform',
  'experimental.chat.system.transform',
] as const satisfies readonly (keyof Hooks)[]

type RegisteredPluginHooks = Required<
  Pick<Hooks, (typeof REGISTERED_PLUGIN_HOOKS)[number]>
>

export interface OpenCodeV1Deps {
  /**
   * Directory holding `skills/`, `agents/`, `commands/` and `package.json`.
   *
   * The caller supplies it because only the entry point knows where it sits
   * relative to the package root: `src/index.ts` and the bundled `dist/*.js`
   * chunks are both one level down, while this module is two levels down in
   * source. Computing it here would break the built artifact.
   */
  packageRoot: string
}

const getPackageVersion = (packageJsonPath: string): string => {
  try {
    if (!fs.existsSync(packageJsonPath)) return 'unknown'
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(content) as { version?: string }
    return parsed.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * OpenCode v1 adapter: wires the shared core into the five v1 hooks. Its output is
 * pinned byte for byte by the v1 golden tests.
 */
export const createOpenCodeV1Hooks = async (
  { client, directory }: PluginInput,
  { packageRoot }: OpenCodeV1Deps,
): Promise<Hooks> => {
  const bundledSkillsDir = path.join(packageRoot, 'skills')
  const bundledAgentsDir = path.join(packageRoot, 'agents')
  const bundledCommandsDir = path.join(packageRoot, 'commands')
  const packageJsonPath = path.join(packageRoot, 'package.json')

  let hasLoggedInit = false
  let userOutputLimitSet = false
  const skillOutputStore = createSkillOutputStore()
  const config = loadConfig(directory)
  // Snapshot bootstrap once per plugin init so the cached system prefix stays
  // stable across requests. Custom bootstrap file edits take effect on restart.
  const bootstrapContent = composeBootstrapContent(config, {
    bundledSkillsDir,
    profile: 'opencode',
  })

  const configHandler = createConfigHandler({
    directory,
    bundledSkillsDir,
    bundledAgentsDir,
    bundledCommandsDir,
  })

  const hooks: RegisteredPluginHooks = {
    config: async (incomingConfig: Config): Promise<void> => {
      // Host doesn't type tool_output in Config yet; recompute on every call.
      const configUnknown: unknown = incomingConfig
      userOutputLimitSet =
        isRecord(configUnknown) &&
        isRecord(configUnknown.tool_output) &&
        (configUnknown.tool_output.max_lines !== undefined ||
          configUnknown.tool_output.max_bytes !== undefined)
      return configHandler(incomingConfig)
    },

    tool: {
      systematic_skill: createSkillTool({
        bundledSkillsDir,
        disabledSkills: config.disabled_skills,
        outputStore: skillOutputStore,
      }),
    },

    'tool.execute.after': async (input: unknown, output: unknown) => {
      try {
        restoreSkillOutput(skillOutputStore, input, output, {
          userOutputLimitSet,
        })
      } catch {
        // Output restoration is best-effort and never blocks the host.
      }
    },

    // Request-only: clears the prune placeholder flag on skill results so the
    // model sees the stored body. Best effort; a throw would fail the turn.
    'experimental.chat.messages.transform': async (
      _input: unknown,
      output: unknown,
    ) => {
      try {
        restoreCompactedSkillResults(output)
      } catch {
        // Never blocks the host.
      }
    },

    'experimental.chat.system.transform': async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!hasLoggedInit) {
        hasLoggedInit = true
        const packageVersion = getPackageVersion(packageJsonPath)
        try {
          await client.app.log({
            body: {
              service: 'systematic',
              level: 'info',
              message: 'Systematic plugin initialized',
              extra: {
                version: packageVersion,
                bootstrapEnabled: config.bootstrap.enabled,
                disabledSkillsCount: config.disabled_skills.length,
                disabledAgentsCount: config.disabled_agents.length,
                disabledCommandsCount: config.disabled_commands.length,
              },
            },
          })
        } catch {
          // ignore logging failures to avoid blocking the hook
        }
      }

      // Skip for title generation requests
      const existingSystem = output.system.join('\n').toLowerCase()
      if (
        INTERNAL_AGENT_SIGNATURES.some((sig) =>
          existingSystem.includes(sig.toLowerCase()),
        )
      ) {
        try {
          await client.app.log({
            body: {
              service: 'systematic',
              level: 'info',
              message: 'Skipping bootstrap prompt injection for internal agent',
            },
          })
        } catch {
          // ignore logging failures to avoid blocking the hook
        }
        return
      }

      if (bootstrapContent) {
        applyBootstrapContent(output, bootstrapContent)
      }
    },
  }

  return hooks
}
