#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as agents from './lib/agents.js'
import * as commands from './lib/commands.js'
import { getConfigPaths } from './lib/config.js'
import { type ContentType, convertContent } from './lib/converter.js'
import * as skills from './lib/skills.js'
import type { AgentMode } from './lib/validation.js'

const getPackageVersion = (): string => {
  try {
    const packageJsonPath = path.resolve(
      import.meta.dirname,
      '..',
      'package.json',
    )
    if (!fs.existsSync(packageJsonPath)) return 'unknown'
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(content) as { version?: string }
    return parsed.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const VERSION = getPackageVersion()

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

function listItems(type: string): void {
  const packageRoot = path.resolve(import.meta.dirname, '..')
  const bundledDir = packageRoot

  let finder: (dir: string) => Array<{ name: string }>
  let subdir: string

  switch (type) {
    case 'skills':
      finder = skills.findSkillsInDir
      subdir = 'skills'
      break
    case 'agents':
      finder = agents.findAgentsInDir
      subdir = 'agents'
      break
    case 'commands':
      finder = commands.findCommandsInDir
      subdir = 'commands'
      break
    default:
      console.error(`Unknown type: ${type}. Use: skills, agents, commands`)
      process.exit(1)
  }

  const items = finder(path.join(bundledDir, subdir))

  if (items.length === 0) {
    console.log(`No ${type} found.`)
    return
  }

  console.log(`Available ${type}:\n`)
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${item.name}`)
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
  const paths = getConfigPaths(process.cwd())

  console.log('Configuration locations:\n')
  console.log(`  User config:    ${paths.userConfig}`)
  console.log(`  Project config: ${paths.projectConfig}`)

  if (fs.existsSync(paths.projectConfig)) {
    console.log('\nProject configuration:')
    console.log(fs.readFileSync(paths.projectConfig, 'utf-8'))
  }

  if (fs.existsSync(paths.userConfig)) {
    console.log('\nUser configuration:')
    console.log(fs.readFileSync(paths.userConfig, 'utf-8'))
  }
}

function configPath(): void {
  const paths = getConfigPaths(process.cwd())

  console.log('Config file paths:')
  console.log(`  User:    ${paths.userConfig}`)
  console.log(`  Project: ${paths.projectConfig}`)
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
