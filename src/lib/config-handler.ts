import type { AgentConfig, Config } from '@opencode-ai/sdk'
import { extractAgentFrontmatter, findAgentsInDir } from './agents.js'
import { extractCommandFrontmatter, findCommandsInDir } from './commands.js'
import { loadConfig } from './config.js'
import { convertFileWithCache } from './converter.js'
import { parseFrontmatter } from './frontmatter.js'
import { type LoadedSkill, loadSkill } from './skill-loader.js'
import { findSkillsInDir } from './skills.js'

export interface ConfigHandlerDeps {
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
}

type CommandConfig = NonNullable<Config['command']>[string]

function loadAgentAsConfig(agentInfo: {
  name: string
  file: string
  category?: string
}): AgentConfig | null {
  try {
    const converted = convertFileWithCache(agentInfo.file, 'agent', {
      source: 'bundled',
      agentMode: 'subagent',
    })
    const {
      description,
      prompt,
      model,
      temperature,
      top_p,
      tools,
      disable,
      mode,
      color,
      maxSteps,
      permission,
    } = extractAgentFrontmatter(converted)

    const config: AgentConfig = {
      description: description || `${agentInfo.name} agent`,
      prompt,
    }

    if (model !== undefined) config.model = model
    if (temperature !== undefined) config.temperature = temperature
    if (top_p !== undefined) config.top_p = top_p
    if (tools !== undefined) config.tools = tools
    if (disable !== undefined) config.disable = disable
    if (mode !== undefined) config.mode = mode
    if (color !== undefined) config.color = color
    if (maxSteps !== undefined) config.maxSteps = maxSteps
    if (permission !== undefined) config.permission = permission

    return config
  } catch {
    return null
  }
}

function loadCommandAsConfig(commandInfo: {
  name: string
  file: string
  category?: string
}): CommandConfig | null {
  try {
    const converted = convertFileWithCache(commandInfo.file, 'command', {
      source: 'bundled',
    })
    const { name, description } = extractCommandFrontmatter(converted)
    const { body } = parseFrontmatter(converted)

    const cleanName = commandInfo.name.replace(/^\//, '')

    return {
      template: body.trim(),
      description: description || `${name || cleanName} command`,
    }
  } catch {
    return null
  }
}

function loadSkillAsCommand(loaded: LoadedSkill): CommandConfig {
  return {
    template: loaded.wrappedTemplate,
    description: loaded.description,
  }
}

function collectAgents(
  dir: string,
  disabledAgents: string[],
): NonNullable<Config['agent']> {
  const agents: NonNullable<Config['agent']> = {}
  const agentList = findAgentsInDir(dir)

  for (const agentInfo of agentList) {
    if (disabledAgents.includes(agentInfo.name)) continue

    const config = loadAgentAsConfig(agentInfo)
    if (config) {
      agents[agentInfo.name] = config
    }
  }

  return agents
}

function collectCommands(
  dir: string,
  disabledCommands: string[],
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}
  const commandList = findCommandsInDir(dir)

  for (const commandInfo of commandList) {
    const cleanName = commandInfo.name.replace(/^\//, '')
    if (disabledCommands.includes(cleanName)) continue

    const config = loadCommandAsConfig(commandInfo)
    if (config) {
      commands[cleanName] = config
    }
  }

  return commands
}

function collectSkillsAsCommands(
  dir: string,
  disabledSkills: string[],
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}
  const skillList = findSkillsInDir(dir)

  for (const skillInfo of skillList) {
    if (disabledSkills.includes(skillInfo.name)) continue

    const loaded = loadSkill(skillInfo)
    if (loaded) {
      commands[loaded.prefixedName] = loadSkillAsCommand(loaded)
    }
  }

  return commands
}

/**
 * Create the config hook handler for the Systematic plugin.
 *
 * This follows the pattern used by oh-my-opencode to inject bundled agents,
 * skills (as commands), and commands into OpenCode's configuration.
 *
 * Only bundled content is loaded. User/project overrides are not supported.
 * Existing OpenCode config is preserved and takes precedence.
 */
export function createConfigHandler(deps: ConfigHandlerDeps) {
  const { directory, bundledSkillsDir, bundledAgentsDir, bundledCommandsDir } =
    deps

  return async (config: Config): Promise<void> => {
    const systematicConfig = loadConfig(directory)

    const bundledAgents = collectAgents(
      bundledAgentsDir,
      systematicConfig.disabled_agents,
    )

    const bundledCommands = collectCommands(
      bundledCommandsDir,
      systematicConfig.disabled_commands,
    )

    const bundledSkills = collectSkillsAsCommands(
      bundledSkillsDir,
      systematicConfig.disabled_skills,
    )

    const existingAgents = config.agent ?? {}
    config.agent = {
      ...bundledAgents,
      ...existingAgents,
    }

    const existingCommands = config.command ?? {}
    config.command = {
      ...bundledCommands,
      ...bundledSkills,
      ...existingCommands,
    }
  }
}
