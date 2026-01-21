import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tool } from '@opencode-ai/plugin/tool'
import { type SystematicConfig, loadConfig } from '../lib/config'
import * as skillsCore from '../lib/skills-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const bundledSkillsDir = path.resolve(__dirname, '../../skills')
const bundledAgentsDir = path.resolve(__dirname, '../../agents')
const bundledCommandsDir = path.resolve(__dirname, '../../commands')

interface PluginContext {
  client: {
    session: {
      prompt: (options: {
        path: { id: string }
        body: {
          agent?: string
          noReply: boolean
          parts: Array<{ type: string; text: string; synthetic?: boolean }>
        }
      }) => Promise<void>
    }
  }
  directory: string
}

interface ExecuteContext {
  sessionID: string
  agent?: string
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
- \`Skill\` tool → \`systematic_use_skill\` custom tool
- \`Read\`, \`Write\`, \`Edit\`, \`Bash\` → Your native tools

**Skills naming (priority order):**
- Project skills: \`project:skill-name\` (in .opencode/systematic/skills/)
- User skills: \`skill-name\` (in ${configDir}/systematic/skills/)
- Bundled skills: \`sys:skill-name\` or \`systematic:skill-name\`
- Project overrides user, which overrides bundled when names match`

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use systematic_use_skill to load "using-systematic" - that would be redundant. Use systematic_use_skill only for OTHER skills.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
}

export const SystematicPlugin = async ({
  client,
  directory,
}: PluginContext) => {
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
      systematic_use_skill: tool({
        description:
          'Load and read a specific skill to guide your work. Skills contain proven workflows, mandatory processes, and expert techniques.',
        args: {
          skill_name: tool.schema
            .string()
            .describe(
              'Name of the skill to load (e.g., "sys:brainstorming", "my-custom-skill", or "project:my-skill")',
            ),
        },
        execute: async (
          args: { skill_name: string },
          ctx: unknown,
        ): Promise<string> => {
          const context = ctx as ExecuteContext
          const { skill_name } = args

          const actualName = skill_name.replace(
            /^(project:|sys:|systematic:)/,
            '',
          )
          if (config.disabled_skills.includes(actualName)) {
            return `Error: Skill "${skill_name}" is disabled in configuration.`
          }

          const resolved = skillsCore.resolveSkillPath(
            skill_name,
            bundledSkillsDir,
            userSkillsDir,
            projectSkillsDir,
          )

          if (!resolved) {
            return `Error: Skill "${skill_name}" not found.\n\nRun systematic_find_skills to see available skills.`
          }

          const fullContent = fs.readFileSync(resolved.skillFile, 'utf8')
          const { name, description } = skillsCore.extractFrontmatter(
            resolved.skillFile,
          )
          const content = skillsCore.stripFrontmatter(fullContent)
          const skillDirectory = path.dirname(resolved.skillFile)

          const skillHeader = `# ${name || skill_name}
# ${description || ''}
# Supporting tools and docs are in ${skillDirectory}
# ============================================`

          try {
            await client.session.prompt({
              path: { id: context.sessionID },
              body: {
                agent: context.agent,
                noReply: true,
                parts: [
                  {
                    type: 'text',
                    text: `Loading skill: ${name || skill_name}`,
                    synthetic: true,
                  },
                  {
                    type: 'text',
                    text: `${skillHeader}\n\n${content}`,
                    synthetic: true,
                  },
                ],
              },
            })
          } catch {
            return `${skillHeader}\n\n${content}`
          }

          return `Launching skill: ${name || skill_name}`
        },
      }),

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

          const seen = new Set<string>()
          const agents: Array<{ name: string; sourceType: string }> = []

          for (const list of [projectAgents, userAgents, bundledAgents]) {
            for (const agent of list) {
              if (seen.has(agent.name)) continue
              if (config.disabled_agents.includes(agent.name)) continue
              seen.add(agent.name)
              agents.push({ name: agent.name, sourceType: agent.sourceType })
            }
          }

          if (agents.length === 0) {
            return 'No agents available.'
          }

          let output = 'Available agents:\n\n'
          for (const agent of agents.sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            output += `- ${agent.name} (${agent.sourceType})\n`
          }

          return output
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

          const seen = new Set<string>()
          const commands: Array<{ name: string; sourceType: string }> = []

          for (const list of [projectCommands, userCommands, bundledCommands]) {
            for (const cmd of list) {
              if (seen.has(cmd.name)) continue
              if (config.disabled_commands.includes(cmd.name)) continue
              seen.add(cmd.name)
              commands.push({ name: cmd.name, sourceType: cmd.sourceType })
            }
          }

          if (commands.length === 0) {
            return 'No commands available.'
          }

          let output = 'Available commands:\n\n'
          for (const cmd of commands.sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            output += `- ${cmd.name} (${cmd.sourceType})\n`
          }

          return output
        },
      }),
    },

    event: async () => {
      // Bootstrap injection uses experimental.chat.system.transform instead
    },

    // Workaround for session.prompt() model reset issue
    // See: https://github.com/obra/superpowers/pull/228
    experimental: {
      chat: {
        system: {
          transform: async ({
            output,
          }: {
            output: { system?: string }
          }) => {
            const content = getBootstrapContent(config, false)
            if (content) {
              output.system = output.system
                ? `${output.system}\n\n${content}`
                : content
            }
          },
        },
      },
    },
  }
}

export default SystematicPlugin
