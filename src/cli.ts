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
  list [type]          List available skills, agents, or commands
  convert <type> <source> [--output <path>] [--dry-run]
                       Convert Claude Code content to OpenCode format
    Types: skill, agent, command
  config [subcommand]  Configuration management
    show               Show configuration
    path               Print config file locations

Options:
  --output, -o         Output path for convert command
  --dry-run            Preview conversion without writing files
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  systematic list skills
  systematic convert skill /path/to/cep/skills/agent-browser -o ./skills/agent-browser
  systematic convert agent /path/to/agent.md --dry-run
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
