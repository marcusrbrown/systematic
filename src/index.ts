import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { getBootstrapContent } from './lib/bootstrap.js'
import { loadConfig } from './lib/config.js'
import { createConfigHandler } from './lib/config-handler.js'
import { createSkillTool } from './lib/skill-tool.js'

const INTERNAL_AGENT_SIGNATURES = [
  'You are a title generator',
  'You are a helpful AI assistant tasked with summarizing conversations',
  'Summarize what was done in this conversation',
]

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')
const packageJsonPath = path.join(packageRoot, 'package.json')
let hasLoggedInit = false

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

export const SystematicPlugin: Plugin = async ({ client, directory }) => {
  const config = loadConfig(directory)

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

    'experimental.chat.system.transform': async (_input, output) => {
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
        await client.app.log({
          body: {
            service: 'systematic',
            level: 'info',
            message: 'Skipping bootstrap prompt injection for internal agent',
          },
        })
        return
      }

      const content = getBootstrapContent(config, { bundledSkillsDir })
      if (content) {
        if (output.system.length > 0) {
          output.system[output.system.length - 1] += `\n\n${content}`
        } else {
          output.system.push(content)
        }
      }
    },
  }
}

export default SystematicPlugin
