import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  getBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
} from './lib/bootstrap.js'
import { loadConfig } from './lib/config.js'
import { createConfigHandler } from './lib/config-handler.js'
import { plugInOnce } from './lib/plugin-singleton.js'
import { createSkillTool } from './lib/skill-tool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')
const packageJsonPath = path.join(packageRoot, 'package.json')
let hasLoggedInit = false

const applyBootstrapContent = (
  output: { system: string[] },
  content: string,
): void => {
  if (output.system.length > 0) {
    output.system[output.system.length - 1] += `\n\n${content}`
  } else {
    output.system.push(content)
  }
}

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

/**
 * Build the plugin hook surface for a single OpenCode plugin invocation.
 *
 * Extracted into a named initializer so the default export can wrap it through
 * `plugInOnce(...)`, making duplicate factory calls in the same process
 * converge on the same hooks promise. See `src/lib/plugin-singleton.ts` for
 * the duplicate-load justification.
 */
const initializePlugin = async ({ client, directory }: PluginInput) => {
  const config = loadConfig(directory)
  // Snapshot bootstrap once per plugin init so the cached system prefix stays
  // stable across requests. Custom bootstrap file edits take effect on restart.
  const bootstrapContent = getBootstrapContent(config, { bundledSkillsDir })

  const configHandler = createConfigHandler({
    directory,
    bundledSkillsDir,
    bundledAgentsDir,
    bundledCommandsDir,
  })

  return {
    config: configHandler,

    tool: {
      systematic_skill: createSkillTool({
        bundledSkillsDir,
        disabledSkills: config.disabled_skills,
      }),
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
}

const SystematicPlugin: Plugin = async (input) => {
  const { hooks } = await plugInOnce({
    doInit: () => initializePlugin(input),
  })
  // hooks is the real plugin hook surface on every invocation — first and
  // duplicate alike. Returning it unconditionally keeps every configured
  // plugin source functional instead of suppressing duplicates with `{}`.
  return hooks
}

export default SystematicPlugin
