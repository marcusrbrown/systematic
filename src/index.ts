import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { createConfigHandler } from './lib/config-handler.js'
import { type SystematicConfig, loadConfig } from './lib/config.js'
import * as skillsCore from './lib/skills-core.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Find package root: dist/index.js -> ../
const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')

type NamedItem = { name: string; sourceType: string }

function formatItemList(
  items: NamedItem[],
  emptyMessage: string,
  header: string,
): string {
  if (items.length === 0) return emptyMessage

  let output = header
  for (const item of items) {
    output += `- ${item.name} (${item.sourceType})\n`
  }
  return output
}

const getBootstrapContent = (
  config: SystematicConfig,
  _compact = false,
): string | null => {
  if (!config.bootstrap.enabled) return null

  if (config.bootstrap.file) {
    const customPath = config.bootstrap.file.startsWith('~/')
      ? path.join(os.homedir(), config.bootstrap.file.slice(2))
      : config.bootstrap.file
    if (fs.existsSync(customPath)) {
      return fs.readFileSync(customPath, 'utf8')
    }
  }

  const usingSystematicPath = path.join(
    bundledSkillsDir,
    'using-systematic/SKILL.md',
  )
  if (!fs.existsSync(usingSystematicPath)) return null

  const fullContent = fs.readFileSync(usingSystematicPath, 'utf8')
  const content = skillsCore.stripFrontmatter(fullContent)

  const toolMapping = `**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- \`TodoWrite\` → \`update_plan\`
- \`Task\` tool with subagents → Use OpenCode's subagent system (@mention)
- \`Skill\` tool → OpenCode's native \`skill\` tool
- \`Read\`, \`Write\`, \`Edit\`, \`Bash\` → Your native tools

**Skills naming:**
- Bundled skills use the \`systematic:\` prefix (e.g., \`systematic:brainstorming\`)
- Skills can also be invoked without prefix if unambiguous`

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-systematic" again - that would be redundant.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
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
      systematic_find_skills: tool({
        description: 'List all available skills in the bundled skill library.',
        args: {},
        execute: async (): Promise<string> => {
          const bundledSkills = skillsCore.findSkillsInDir(
            bundledSkillsDir,
            'bundled',
            3,
          )

          const allSkills = bundledSkills.filter(
            (s) => !config.disabled_skills.includes(s.name),
          )

          if (allSkills.length === 0) {
            return 'No skills found. Skills are bundled with the systematic plugin.'
          }

          let output = 'Available skills:\n\n'

          for (const skill of allSkills) {
            output += `systematic:${skill.name}\n`
            if (skill.description) {
              output += `  ${skill.description}\n`
            }
            output += `  Directory: ${skill.path}\n\n`
          }

          return output
        },
      }),

      systematic_find_agents: tool({
        description: 'List all available review agents.',
        args: {},
        execute: async (): Promise<string> => {
          const bundledAgents = skillsCore.findAgentsInDir(
            bundledAgentsDir,
            'bundled',
          )

          const agents = bundledAgents
            .filter((a) => !config.disabled_agents.includes(a.name))
            .sort((a, b) => a.name.localeCompare(b.name))

          return formatItemList(
            agents,
            'No agents available.',
            'Available agents:\n\n',
          )
        },
      }),

      systematic_find_commands: tool({
        description: 'List all available commands.',
        args: {},
        execute: async (): Promise<string> => {
          const bundledCommands = skillsCore.findCommandsInDir(
            bundledCommandsDir,
            'bundled',
          )

          const commands = bundledCommands
            .filter(
              (c) =>
                !config.disabled_commands.includes(c.name.replace(/^\//, '')),
            )
            .sort((a, b) => a.name.localeCompare(b.name))

          return formatItemList(
            commands,
            'No commands available.',
            'Available commands:\n\n',
          )
        },
      }),
    },

    // Workaround for session.prompt() model reset issue
    // See: https://github.com/obra/superpowers/pull/226
    'experimental.chat.system.transform': async (_input, output) => {
      const content = getBootstrapContent(config, false)
      if (content) {
        if (!output.system) {
          output.system = []
        }
        output.system.push(content)
      }
    },
  }
}

export default SystematicPlugin
