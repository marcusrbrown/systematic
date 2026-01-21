#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as skillsCore from '../lib/skills-core.js'

const VERSION = '0.1.0'

const HELP = `
systematic - OpenCode plugin for systematic engineering workflows

Usage:
  systematic <command> [options]

Commands:
  init              Initialize systematic in current project
  list [type]       List available skills, agents, or commands
  config            Show current configuration
  help              Show this help message
  version           Show version

Examples:
  systematic init
  systematic list skills
  systematic list agents
  systematic config
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

function init(): void {
  const projectDir = getProjectConfigDir()
  const skillsDir = path.join(projectDir, 'skills')
  const agentsDir = path.join(projectDir, 'agents')
  const commandsDir = path.join(projectDir, 'commands')

  const dirs = [skillsDir, agentsDir, commandsDir]

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(`Created: ${dir}`)
    } else {
      console.log(`Exists: ${dir}`)
    }
  }

  const configPath = path.join(projectDir, 'systematic.json')
  if (!fs.existsSync(configPath)) {
    const config = {
      disabled_skills: [],
      disabled_agents: [],
      disabled_commands: [],
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    console.log(`Created: ${configPath}`)
  } else {
    console.log(`Exists: ${configPath}`)
  }

  console.log('\nSystematic initialized successfully!')
}

type SourceType = 'project' | 'user' | 'bundled'

function listItems(type: string): void {
  const userDir = getUserConfigDir()
  const projectDir = getProjectConfigDir()
  const packageRoot = path.resolve(import.meta.dirname, '../..')
  const bundledDir = path.join(packageRoot, 'defaults')

  let finder: (
    dir: string,
    sourceType: SourceType,
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

  const projectItems = finder(path.join(projectDir, subdir), 'project')
  const userItems = finder(path.join(userDir, subdir), 'user')
  const bundledItems = finder(path.join(bundledDir, subdir), 'bundled')

  const seen = new Set<string>()
  const items: Array<{ name: string; sourceType: string }> = []

  for (const list of [projectItems, userItems, bundledItems]) {
    for (const item of list) {
      if (seen.has(item.name)) continue
      seen.add(item.name)
      items.push(item)
    }
  }

  if (items.length === 0) {
    console.log(`No ${type} found.`)
    return
  }

  console.log(`Available ${type}:\n`)
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${item.name} (${item.sourceType})`)
  }
}

function showConfig(): void {
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

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'init':
    init()
    break
  case 'list':
    listItems(args[1] || 'skills')
    break
  case 'config':
    showConfig()
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
