import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfig, Config } from '@opencode-ai/sdk'
import { loadConfig } from './config.js'
import * as skillsCore from './skills-core.js'

export interface ConfigHandlerDeps {
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
}

type CommandConfig = NonNullable<Config['command']>[string]

function loadAgentAsConfig(
  agentInfo: { name: string; file: string; sourceType: string; category?: string }
): AgentConfig | null {
  try {
    const content = fs.readFileSync(agentInfo.file, 'utf8')
    const { name, description, prompt } = skillsCore.extractAgentFrontmatter(content)

    return {
      description: description || `${name || agentInfo.name} agent`,
      prompt: prompt || skillsCore.stripFrontmatter(content),
    }
  } catch {
    return null
  }
}

function loadCommandAsConfig(
  commandInfo: { name: string; file: string; sourceType: string; category?: string }
): CommandConfig | null {
  try {
    const content = fs.readFileSync(commandInfo.file, 'utf8')
    const { name, description } = skillsCore.extractCommandFrontmatter(content)

    const cleanName = commandInfo.name.replace(/^\//, '')

    return {
      template: skillsCore.stripFrontmatter(content),
      description: description || `${name || cleanName} command`,
    }
  } catch {
    return null
  }
}

function loadSkillAsCommand(
  skillInfo: skillsCore.SkillInfo
): CommandConfig | null {
  try {
    const content = fs.readFileSync(skillInfo.skillFile, 'utf8')

    return {
      template: skillsCore.stripFrontmatter(content),
      description: skillInfo.description || `${skillInfo.name} skill`,
    }
  } catch {
    return null
  }
}

function collectAgents(
  dir: string,
  sourceType: 'project' | 'user' | 'bundled',
  disabledAgents: string[]
): NonNullable<Config['agent']> {
  const agents: NonNullable<Config['agent']> = {}
  const agentList = skillsCore.findAgentsInDir(dir, sourceType)

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
  sourceType: 'project' | 'user' | 'bundled',
  disabledCommands: string[]
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}
  const commandList = skillsCore.findCommandsInDir(dir, sourceType)

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
  sourceType: 'project' | 'user' | 'bundled',
  disabledSkills: string[]
): NonNullable<Config['command']> {
  const commands: NonNullable<Config['command']> = {}
  const skillList = skillsCore.findSkillsInDir(dir, sourceType, 3)

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
 * Priority order (highest priority last, so they override earlier):
 * 1. Bundled content (from this plugin)
 * 2. User content (~/.config/opencode/systematic/)
 * 3. Project content (.opencode/systematic/)
 * 4. Existing OpenCode config (preserved)
 */
export function createConfigHandler(deps: ConfigHandlerDeps) {
  const { directory, bundledSkillsDir, bundledAgentsDir, bundledCommandsDir } = deps

  return async (config: Config): Promise<void> => {
    const systematicConfig = loadConfig(directory)

    const userSkillsDir = systematicConfig.paths.user_skills
    const userAgentsDir = systematicConfig.paths.user_agents
    const userCommandsDir = systematicConfig.paths.user_commands
    const projectSkillsDir = path.join(directory, '.opencode/systematic/skills')
    const projectAgentsDir = path.join(directory, '.opencode/systematic/agents')
    const projectCommandsDir = path.join(directory, '.opencode/systematic/commands')

    const bundledAgents = collectAgents(
      bundledAgentsDir,
      'bundled',
      systematicConfig.disabled_agents
    )
    const userAgents = collectAgents(
      userAgentsDir,
      'user',
      systematicConfig.disabled_agents
    )
    const projectAgents = collectAgents(
      projectAgentsDir,
      'project',
      systematicConfig.disabled_agents
    )

    const bundledCommands = collectCommands(
      bundledCommandsDir,
      'bundled',
      systematicConfig.disabled_commands
    )
    const userCommands = collectCommands(
      userCommandsDir,
      'user',
      systematicConfig.disabled_commands
    )
    const projectCommands = collectCommands(
      projectCommandsDir,
      'project',
      systematicConfig.disabled_commands
    )

    const bundledSkills = collectSkillsAsCommands(
      bundledSkillsDir,
      'bundled',
      systematicConfig.disabled_skills
    )
    const userSkills = collectSkillsAsCommands(
      userSkillsDir,
      'user',
      systematicConfig.disabled_skills
    )
    const projectSkills = collectSkillsAsCommands(
      projectSkillsDir,
      'project',
      systematicConfig.disabled_skills
    )

    const existingAgents = config.agent ?? {}
    config.agent = {
      ...bundledAgents,
      ...userAgents,
      ...projectAgents,
      ...existingAgents,
    }

    const existingCommands = config.command ?? {}
    config.command = {
      ...bundledCommands,
      ...bundledSkills,
      ...userCommands,
      ...userSkills,
      ...projectCommands,
      ...projectSkills,
      ...existingCommands,
    }
  }
}
