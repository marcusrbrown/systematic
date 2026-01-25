import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { type SystematicConfig, loadConfig } from './lib/config.js'
import * as skillsCore from './lib/skills-core.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Find package root: dist/index.js -> ../
const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')

type NamedItem = { name: string; sourceType: string }

function deduplicateItems(
  lists: NamedItem[][],
  disabled: string[],
): NamedItem[] {
  const seen = new Set<string>()
  const items: NamedItem[] = []

  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.name) || disabled.includes(item.name)) continue
      seen.add(item.name)
      items.push(item)
    }
  }

  return items.sort((a, b) => a.name.localeCompare(b.name))
}

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

  const homeDir = os.homedir()
  const configDir = path.join(homeDir, '.config/opencode')

  const toolMapping = `**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- \`TodoWrite\` → \`update_plan\`
- \`Task\` tool with subagents → Use OpenCode's subagent system (@mention)
- \`Skill\` tool → OpenCode's native \`skill\` tool
- \`Read\`, \`Write\`, \`Edit\`, \`Bash\` → Your native tools

**Skills naming (priority order):**
- Project skills: \`project:skill-name\` (in .opencode/systematic/skills/)
- User skills: \`skill-name\` (in ${configDir}/systematic/skills/)
- Bundled skills: \`sys:skill-name\` or \`systematic:skill-name\`
- Project overrides user, which overrides bundled when names match`

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-systematic" again - that would be redundant.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
}

export const SystematicPlugin: Plugin = async ({ client, directory }) => {
  const config = loadConfig(directory)

  const projectSkillsDir = path.join(directory, '.opencode/systematic/skills')
  const projectAgentsDir = path.join(directory, '.opencode/systematic/agents')
  const projectCommandsDir = path.join(
    directory,
    '.opencode/systematic/commands',
  )
  const userSkillsDir = config.paths.user_skills
  const userAgentsDir = config.paths.user_agents
  const userCommandsDir = config.paths.user_commands

  return {
    tool: {
      systematic_find_skills: tool({
        description:
          'List all available skills in the project, user, and bundled skill libraries.',
        args: {},
        execute: async (): Promise<string> => {
          const projectSkills = skillsCore.findSkillsInDir(
            projectSkillsDir,
            'project',
            3,
          )
          const userSkills = skillsCore.findSkillsInDir(
            userSkillsDir,
            'user',
            3,
          )
          const bundledSkills = skillsCore.findSkillsInDir(
            bundledSkillsDir,
            'bundled',
            3,
          )

          const filterDisabled = (skills: skillsCore.SkillInfo[]) =>
            skills.filter((s) => !config.disabled_skills.includes(s.name))

          const allSkills = [
            ...filterDisabled(projectSkills),
            ...filterDisabled(userSkills),
            ...filterDisabled(bundledSkills),
          ]

          if (allSkills.length === 0) {
            return `No skills found. Add skills to ${bundledSkillsDir}/ or ${userSkillsDir}/`
          }

          let output = 'Available skills:\n\n'

          for (const skill of allSkills) {
            let namespace: string
            switch (skill.sourceType) {
              case 'project':
                namespace = 'project:'
                break
              case 'user':
                namespace = ''
                break
              default:
                namespace = 'sys:'
            }

            output += `${namespace}${skill.name}\n`
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
          const projectAgents = skillsCore.findAgentsInDir(
            projectAgentsDir,
            'project',
          )
          const userAgents = skillsCore.findAgentsInDir(userAgentsDir, 'user')
          const bundledAgents = skillsCore.findAgentsInDir(
            bundledAgentsDir,
            'bundled',
          )

          const agents = deduplicateItems(
            [projectAgents, userAgents, bundledAgents],
            config.disabled_agents,
          )

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
          const projectCommands = skillsCore.findCommandsInDir(
            projectCommandsDir,
            'project',
          )
          const userCommands = skillsCore.findCommandsInDir(
            userCommandsDir,
            'user',
          )
          const bundledCommands = skillsCore.findCommandsInDir(
            bundledCommandsDir,
            'bundled',
          )

          const commands = deduplicateItems(
            [projectCommands, userCommands, bundledCommands],
            config.disabled_commands,
          )

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
