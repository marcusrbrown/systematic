#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as converter from './lib/converter.js'
import * as skillsCore from './lib/skills-core.js'

const VERSION = '0.1.0'

const HELP = `
systematic - OpenCode plugin for systematic engineering workflows

Usage:
  systematic <command> [options]

Commands:
  init [--project]     Initialize systematic (global or project-local)
  list [type]          List available skills, agents, or commands
  convert <type> <source> [--output <path>] [--dry-run]
                       Convert Claude Code content to OpenCode format
    Types: skill, agent, command
  config [subcommand]  Configuration management
    show               Show merged configuration
    scaffold           Create user override directories
    path               Print config file locations

Options:
  --project            Apply to current project only (for init)
  --output, -o         Output path for convert command
  --dry-run            Preview conversion without writing files
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  systematic init                # Initialize globally
  systematic init --project      # Initialize for current project
  systematic list skills
  systematic convert skill /path/to/cep/skills/agent-browser -o ./skills/agent-browser
  systematic convert agent /path/to/agent.md --dry-run
  systematic config scaffold
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

function init(projectOnly: boolean): void {
  if (projectOnly) {
    initProject()
  } else {
    initGlobal()
  }
}

function initProject(): void {
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

  console.log('\nSystematic initialized for project!')
}

function initGlobal(): void {
  const userDir = getUserConfigDir()
  const systematicDir = path.join(userDir, 'systematic')
  const skillsDir = path.join(systematicDir, 'skills')
  const agentsDir = path.join(systematicDir, 'agents')
  const commandsDir = path.join(systematicDir, 'commands')

  const dirs = [skillsDir, agentsDir, commandsDir]

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(`Created: ${dir}`)
    } else {
      console.log(`Exists: ${dir}`)
    }
  }

  const configPath = path.join(userDir, 'systematic.json')
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

  const opencodeConfig = path.join(userDir, 'config.json')
  if (fs.existsSync(opencodeConfig)) {
    console.log(
      `\nNote: Add "@fro.bot/systematic" to plugins in ${opencodeConfig}`,
    )
  }

  console.log('\nSystematic initialized globally!')
}

type SourceType = 'project' | 'user' | 'bundled'

function listItems(type: string): void {
  const userDir = getUserConfigDir()
  const projectDir = getProjectConfigDir()
  const packageRoot = path.resolve(import.meta.dirname, '..')
  const bundledDir = packageRoot

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

function configScaffold(): void {
  const userDir = getUserConfigDir()
  const systematicDir = path.join(userDir, 'systematic')
  const skillsDir = path.join(systematicDir, 'skills')
  const agentsDir = path.join(systematicDir, 'agents')
  const commandsDir = path.join(systematicDir, 'commands')

  const dirs = [skillsDir, agentsDir, commandsDir]

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(`Created: ${dir}`)
    } else {
      console.log(`Exists: ${dir}`)
    }
  }

  const configPath = path.join(userDir, 'systematic.json')
  if (!fs.existsSync(configPath)) {
    const config = {
      disabled_skills: [],
      disabled_agents: [],
      disabled_commands: [],
      bootstrap: {
        enabled: true,
      },
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    console.log(`Created: ${configPath}`)
  } else {
    console.log(`Exists: ${configPath}`)
  }

  console.log('\nUser override directories created!')
  console.log('Add custom skills/agents/commands to these directories.')
}

function configPath(): void {
  const userDir = getUserConfigDir()
  const projectDir = getProjectConfigDir()

  console.log('Config file paths:')
  console.log(`  User:    ${path.join(userDir, 'systematic.json')}`)
  console.log(`  Project: ${path.join(projectDir, 'systematic.json')}`)
}

function runConvert(args: string[]): void {
  const typeArg = args[1]
  const sourceArg = args[2]

  if (!typeArg || !sourceArg) {
    console.error(
      'Usage: systematic convert <type> <source> [--output <path>] [--dry-run]',
    )
    console.error('Types: skill, agent, command')
    process.exit(1)
  }

  const validTypes = ['skill', 'agent', 'command']
  if (!validTypes.includes(typeArg)) {
    console.error(
      `Invalid type: ${typeArg}. Must be one of: ${validTypes.join(', ')}`,
    )
    process.exit(1)
  }

  const sourcePath = path.resolve(sourceArg)
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`)
    process.exit(1)
  }

  const outputIndex = args.findIndex((a) => a === '--output' || a === '-o')
  const outputPath =
    outputIndex !== -1 ? path.resolve(args[outputIndex + 1]) : undefined
  const dryRun = args.includes('--dry-run')

  try {
    const result = converter.convert(
      typeArg as converter.ConvertType,
      sourcePath,
      { output: outputPath, dryRun },
    )

    if (dryRun) {
      console.log(`[DRY RUN] Would convert ${result.type}:`)
    } else {
      console.log(`Converted ${result.type}:`)
    }
    console.log(`  Source: ${result.sourcePath}`)
    console.log(`  Output: ${result.outputPath}`)
    console.log('  Files:')
    for (const file of result.files) {
      console.log(`    - ${file}`)
    }
  } catch (err) {
    console.error(`Conversion failed: ${(err as Error).message}`)
    process.exit(1)
  }
}

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'init':
    init(args.includes('--project') || args.includes('-p'))
    break
  case 'list':
    listItems(args[1] || 'skills')
    break
  case 'convert':
    runConvert(args)
    break
  case 'config':
    switch (args[1]) {
      case 'show':
      case undefined:
        configShow()
        break
      case 'scaffold':
        configScaffold()
        break
      case 'path':
        configPath()
        break
      default:
        console.error(`Unknown config subcommand: ${args[1]}`)
        console.log('Available: show, scaffold, path')
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
