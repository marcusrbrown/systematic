import type { AgentConfig, Config } from '@opencode-ai/sdk'
import { extractAgentFrontmatter, findAgentsInDir } from './agents.js'
import { extractCommandFrontmatter, findCommandsInDir } from './commands.js'
import { loadConfig } from './config.js'
import { convertFileWithCache } from './converter.js'
import { stripFrontmatter } from './frontmatter.js'
import { findSkillsInDir, type SkillInfo } from './skills.js'

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
    const { description, prompt } = extractAgentFrontmatter(converted)

    return {
      description: description || `${agentInfo.name} agent`,
      prompt: prompt || stripFrontmatter(converted),
    }
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

    const cleanName = commandInfo.name.replace(/^\//, '')

    return {
      template: stripFrontmatter(converted),
      description: description || `${name || cleanName} command`,
    }
  } catch {
    return null
  }
}

function loadSkillAsCommand(skillInfo: SkillInfo): CommandConfig | null {
  try {
    const converted = convertFileWithCache(skillInfo.skillFile, 'skill', {
      source: 'bundled',
    })

    return {
      template: stripFrontmatter(converted),
      description: skillInfo.description || `${skillInfo.name} skill`,
    }
  } catch {
    return null
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

    const config = loadSkillAsCommand(skillInfo)
    if (config) {
      commands[skillInfo.name] = config
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
