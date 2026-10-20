import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  applyBootstrapContent,
  getBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
  readHarnessProfile,
} from './lib/bootstrap.js'
import { loadConfig } from './lib/config.js'
import { createConfigHandler } from './lib/config-handler.js'
import {
  createSkillOutputStore,
  createSkillTool,
  restoreCompactedSkillResults,
  restoreSkillOutput,
} from './lib/skill-tool.js'
import { isRecord } from './lib/validation.js'

// Keep this local because OpenCode's plugin loader requires a default export
// only. The content-integrity gate reads this typed inventory instead of
// inferring hooks from the returned object shape.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')
const packageJsonPath = path.join(packageRoot, 'package.json')

const getPackageVersion = (): string => {
  try {
    if (!fs.existsSync(packageJsonPath)) return 'unknown'
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(content) as { version?: string }
    return parsed.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const initializePlugin = async ({ client, directory }: PluginInput) => {
  let hasLoggedInit = false
  let userOutputLimitSet = false
  const skillOutputStore = createSkillOutputStore()
  const config = loadConfig(directory)
  // Snapshot bootstrap once per plugin init so the cached system prefix stays
  // stable across requests. Custom bootstrap file edits take effect on restart.
  // Profile files owned by skills/using-systematic/references/ — Unit 2 of 2026-07-16-001 plan.
  const bootstrapContent = getBootstrapContent(config, {
    bundledSkillsDir,
    profileBlock: readHarnessProfile(bundledSkillsDir, 'opencode') ?? undefined,
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
        const packageVersion = getPackageVersion()
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

const SystematicPlugin: Plugin = async (input) => {
  return initializePlugin(input)
}

export default SystematicPlugin
