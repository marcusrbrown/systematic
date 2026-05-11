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
import { createSkillTool } from './lib/skill-tool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')
const packageJsonPath = path.join(packageRoot, 'package.json')

const BOOTSTRAP_MARKER_OPEN = '<SYSTEMATIC_WORKFLOWS>'
const BOOTSTRAP_MARKER_CLOSE = '</SYSTEMATIC_WORKFLOWS>'

const findBootstrapMarkerBlock = (
  entry: string,
): { start: number; end: number } | null => {
  const start = entry.indexOf(BOOTSTRAP_MARKER_OPEN)
  if (start === -1) return null
  const closeStart = entry.indexOf(
    BOOTSTRAP_MARKER_CLOSE,
    start + BOOTSTRAP_MARKER_OPEN.length,
  )
  if (closeStart === -1) return null
  return { start, end: closeStart + BOOTSTRAP_MARKER_CLOSE.length }
}

export const applyBootstrapContent = (
  output: { system: string[] },
  content: string,
): void => {
  for (let i = 0; i < output.system.length; i++) {
    const entry = output.system[i]
    const block = findBootstrapMarkerBlock(entry)
    if (block !== null) {
      output.system[i] =
        entry.slice(0, block.start) + content + entry.slice(block.end)
      return
    }
  }
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

const initializePlugin = async ({ client, directory }: PluginInput) => {
  let hasLoggedInit = false
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
  return initializePlugin(input)
}

export default SystematicPlugin
