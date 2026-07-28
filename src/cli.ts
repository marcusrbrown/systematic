#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as agents from './lib/agents.js'
import * as commands from './lib/commands.js'
import { getConfigPaths } from './lib/config.js'
import {
  cleanup,
  exportPersonas,
  MANIFEST_FILENAME,
  preview,
  refresh,
  resolveAgentsRoot,
} from './lib/pi-subagents-export.js'
import { type Harness, setupHarness } from './lib/setup.js'
import * as skills from './lib/skills.js'

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
  list [type]                  List available skills, agents, or commands
  config [subcommand]          Configuration management
    show                       Show configuration
    path                       Print config file locations
  setup --harness opencode|pi  Configure a harness to load Systematic (project-local only)
  pi-subagents <subcommand>    Manage Systematic persona export for pi-subagents
    preview [--scope project|global]   Show what export would do (no writes)
    export  [--scope project|global]   Write persona files to agents dir
    refresh [--scope project|global]   Replace stale owned files from current source
    cleanup [--scope project|global]   Remove all generated files and manifest

Options:
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  systematic list skills
  systematic list agents
  systematic config show
  systematic setup --harness opencode
  systematic setup --harness pi
  systematic pi-subagents preview
  systematic pi-subagents export
  systematic pi-subagents export --scope global
  systematic pi-subagents refresh
  systematic pi-subagents cleanup
`

const PI_SUBAGENTS_USAGE = `Usage: systematic pi-subagents <subcommand> [--scope project|global]

Subcommands:
  preview   Show what export would do (no writes)
  export    Write persona files to agents dir
  refresh   Replace stale owned files from current source
  cleanup   Remove all generated files and manifest

Scope:
  project   <cwd>/.pi/agents (default)
  global    $PI_CODING_AGENT_DIR/agents or ~/.pi/agent/agents
`

function isHarness(value: string): value is Harness {
  return value === 'opencode' || value === 'pi'
}

function setupCommand(rest: string[]): void {
  if (rest[0] !== '--harness' || rest.length !== 2) {
    console.error(
      'Usage: systematic setup --harness opencode|pi (project-local only, no --global)',
    )
    process.exit(1)
  }

  const harnessArg = rest[1]
  if (!harnessArg || !isHarness(harnessArg)) {
    console.error(`Unknown or missing --harness value: ${harnessArg ?? ''}`)
    console.error('Available: opencode, pi')
    process.exit(1)
  }

  try {
    const result = setupHarness(harnessArg, process.cwd())
    if (result.status === 'already-configured') {
      console.log(`Already configured: ${result.targetPath}`)
    } else {
      console.log(`Configured: ${result.targetPath}`)
    }
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

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

function parsePiSubagentsArgs(rest: string[]): {
  subcommand: string | undefined
  scope: 'project' | 'global'
} {
  let subcommand: string | undefined
  let scope: 'project' | 'global' = 'project'
  let i = 0
  while (i < rest.length) {
    const arg = rest[i]
    if (arg === '--scope') {
      i++
      const val = rest[i]
      if (val !== 'project' && val !== 'global') {
        console.error(
          `Invalid --scope value: ${val ?? ''}. Use: project, global`,
        )
        process.exit(1)
      }
      scope = val
    } else if (
      subcommand === undefined &&
      arg !== undefined &&
      !arg.startsWith('-')
    ) {
      subcommand = arg
    } else if (arg !== undefined) {
      console.error(`Unknown argument: ${arg}`)
      console.error(PI_SUBAGENTS_USAGE)
      process.exit(1)
    }
    i++
  }
  return { subcommand, scope }
}

function printActionLine(
  a: ReturnType<typeof preview>['actions'][number],
): void {
  if (a.action === 'create') console.log(`  + ${a.filename}  (create)`)
  else if (a.action === 'update') console.log(`  ~ ${a.filename}  (update)`)
  else if (a.action === 'refuse')
    console.log(`  ! ${a.filename}  (refuse: ${a.reason})`)
  else if (a.action === 'remove')
    console.log(`  - ${a.filename}  (remove stale)`)
  else console.log(`  = ${a.filename}  (up to date)`)
}

function runPreview(agentsRoot: string): void {
  const plan = preview(agentsRoot)
  if (plan.status === 'error') {
    console.error(`Preview failed: ${plan.error ?? 'unknown error'}`)
    process.exit(1)
  }
  console.log(`Target: ${plan.agentsRoot}`)
  console.log('')
  if (plan.actions.length === 0) {
    console.log('No actions needed (nothing to export).')
    return
  }
  const counts = { create: 0, update: 0, refuse: 0, remove: 0, skip: 0 }
  for (const a of plan.actions) {
    counts[a.action]++
    printActionLine(a)
  }
  console.log('')
  console.log(
    `Summary: ${counts.create} create, ${counts.update} update, ` +
      `${counts.skip} skip, ${counts.refuse} refuse, ${counts.remove} remove`,
  )
}

function runExport(agentsRoot: string): void {
  const plan = preview(agentsRoot)
  if (plan.status === 'error') {
    console.error(
      `Export failed (preview step): ${plan.error ?? 'unknown error'}`,
    )
    process.exit(1)
  }
  console.log(`Target: ${plan.agentsRoot}`)
  const hasWork =
    plan.actions.some((a) => a.action === 'create' || a.action === 'update') ||
    plan.actions.some((a) => a.action === 'refuse')
  if (!hasWork) {
    console.log('All persona files are already up to date. No changes.')
    return
  }
  const result = exportPersonas(agentsRoot)
  if (result.status === 'error') {
    console.error(`Export failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }
  if (result.written === 0 && result.refused.length === 0) {
    console.log('All persona files are already up to date. No changes.')
  } else {
    console.log(
      `Exported ${result.written} file(s) to ${agentsRoot}/ (${result.skipped} already up to date).`,
    )
  }
  if (result.refused.length > 0) {
    console.log('\nRefused (pre-existing unowned files not overwritten):')
    for (const r of result.refused)
      console.log(`  ! ${r.filename}: ${r.reason}`)
  }
}

function runRefresh(agentsRoot: string): void {
  const result = refresh(agentsRoot)
  if (result.status === 'error') {
    console.error(`Refresh failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }
  if (result.updated === 0) {
    console.log('All owned persona files are up to date. No changes.')
  } else {
    console.log(
      `Refreshed: updated ${result.updated} file(s) in ${agentsRoot}/.`,
    )
  }
  if (result.skippedUnowned > 0)
    console.log(
      `  Skipped ${result.skippedUnowned} unowned file(s) (not touched).`,
    )
}

function runCleanup(agentsRoot: string): void {
  let result: ReturnType<typeof cleanup>
  try {
    result = cleanup(agentsRoot)
  } catch (err) {
    console.error(
      `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
  if (result.status === 'error') {
    console.error(`Cleanup failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }
  console.log(
    `Cleaned up generated persona files from ${agentsRoot}/. Manifest (${MANIFEST_FILENAME}) removed.`,
  )
}

function piSubagentsCommand(rest: string[]): void {
  const { subcommand, scope } = parsePiSubagentsArgs(rest)
  if (!subcommand) {
    console.error('Error: pi-subagents requires a subcommand.')
    console.error(PI_SUBAGENTS_USAGE)
    process.exit(1)
  }
  const agentsRoot = resolveAgentsRoot(scope, process.cwd())
  switch (subcommand) {
    case 'preview':
      runPreview(agentsRoot)
      break
    case 'export':
      runExport(agentsRoot)
      break
    case 'refresh':
      runRefresh(agentsRoot)
      break
    case 'cleanup':
      runCleanup(agentsRoot)
      break
    default:
      console.error(`Unknown pi-subagents subcommand: ${subcommand}`)
      console.error(PI_SUBAGENTS_USAGE)
      process.exit(1)
  }
}

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'list':
    listItems(args[1] || 'skills')
    break
  case 'setup':
    setupCommand(args.slice(1))
    break
  case 'pi-subagents':
    piSubagentsCommand(args.slice(1))
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
