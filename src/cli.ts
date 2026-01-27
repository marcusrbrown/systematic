#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {
  type AgentMode,
  type ContentType,
  convertContent,
} from './lib/converter.js'
import * as skillsCore from './lib/skills-core.js'

const VERSION = '0.1.0'

const HELP = `
systematic - OpenCode plugin for systematic engineering workflows

Usage:
  systematic <command> [options]

Commands:
  list [type]          List available skills, agents, or commands
  convert <type> <file> [--mode=primary|subagent]
                       Convert and inspect a file (outputs to stdout)
  config [subcommand]  Configuration management
    show               Show configuration
    path               Print config file locations

Options:
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  systematic list skills
  systematic list agents
  systematic convert agent ./agents/my-agent.md
  systematic convert agent ./agents/my-agent.md --mode=primary
  systematic convert skill ./skills/my-skill/SKILL.md
  systematic config show
`

function getUserConfigDir(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.config/opencode',
  )
}

function getProjectConfigDir(): string {
  return path.join(process.cwd(), '.opencode')
}

function listItems(type: string): void {
  const packageRoot = path.resolve(import.meta.dirname, '..')
  const bundledDir = packageRoot

  let finder: (
    dir: string,
    sourceType: 'bundled',
  ) => Array<{ name: string; sourceType: string }>
  let subdir: string

  switch (type) {
    case 'skills':
      finder = skillsCore.findSkillsInDir
      subdir = 'skills'
      break
    case 'agents':
      finder = skillsCore.findAgentsInDir
      subdir = 'agents'
      break
    case 'commands':
      finder = skillsCore.findCommandsInDir
      subdir = 'commands'
      break
    default:
      console.error(`Unknown type: ${type}. Use: skills, agents, commands`)
      process.exit(1)
  }

  const items = finder(path.join(bundledDir, subdir), 'bundled')

  if (items.length === 0) {
    console.log(`No ${type} found.`)
    return
  }

  console.log(`Available ${type}:\n`)
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${item.name} (${item.sourceType})`)
  }
}

function runConvert(type: string, filePath: string, modeArg?: string): void {
  const validTypes = ['skill', 'agent', 'command']
  if (!validTypes.includes(type)) {
    console.error(
      `Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`,
    )
    process.exit(1)
  }

  const resolvedPath = path.resolve(filePath)
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`)
    process.exit(1)
  }

  let agentMode: AgentMode = 'subagent'
  if (modeArg) {
    const modeMatch = modeArg.match(/^--mode=(primary|subagent)$/)
    if (modeMatch) {
      agentMode = modeMatch[1] as AgentMode
    } else {
      console.error(
        'Invalid --mode flag. Use: --mode=primary or --mode=subagent',
      )
      process.exit(1)
    }
  }

  const content = fs.readFileSync(resolvedPath, 'utf8')
  const converted = convertContent(content, type as ContentType, { agentMode })

  console.log(converted)
}

function configShow(): void {
  const userDir = getUserConfigDir()
  const projectDir = getProjectConfigDir()

  console.log('Configuration locations:\n')
  console.log(`  User config:    ${path.join(userDir, 'systematic.json')}`)
  console.log(`  Project config: ${path.join(projectDir, 'systematic.json')}`)

  const projectConfig = path.join(projectDir, 'systematic.json')
  if (fs.existsSync(projectConfig)) {
    console.log('\nProject configuration:')
    console.log(fs.readFileSync(projectConfig, 'utf-8'))
  }

  const userConfig = path.join(userDir, 'systematic.json')
  if (fs.existsSync(userConfig)) {
    console.log('\nUser configuration:')
    console.log(fs.readFileSync(userConfig, 'utf-8'))
  }
}

function configPath(): void {
  const userDir = getUserConfigDir()
  const projectDir = getProjectConfigDir()

  console.log('Config file paths:')
  console.log(`  User:    ${path.join(userDir, 'systematic.json')}`)
  console.log(`  Project: ${path.join(projectDir, 'systematic.json')}`)
}

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'list':
    listItems(args[1] || 'skills')
    break
  case 'convert':
    if (!args[1] || !args[2]) {
      console.error(
        'Usage: systematic convert <type> <file> [--mode=primary|subagent]',
      )
      console.error('  type: skill, agent, or command')
      process.exit(1)
    }
    runConvert(args[1], args[2], args[3])
    break
  case 'config':
    switch (args[1]) {
      case 'show':
      case undefined:
        configShow()
        break
      case 'path':
        configPath()
        break
      default:
        console.error(`Unknown config subcommand: ${args[1]}`)
        console.log('Available: show, path')
        process.exit(1)
    }
    break
  case 'version':
  case '--version':
  case '-v':
    console.log(`systematic v${VERSION}`)
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(HELP)
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.log(HELP)
    process.exit(1)
}
