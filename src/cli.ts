#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAgentCatalog } from './lib/agent-resolver.js'
import * as agents from './lib/agents.js'
import {
  buildCapabilitySnapshot,
  type CapabilityClock,
  type CapabilityFactInput,
  type CapabilityOutputSink,
  type ConfigObservationMetadata,
} from './lib/capability-snapshot.js'
import * as commands from './lib/commands.js'
import { getConfigPaths, loadConfigWithSources } from './lib/config.js'
import {
  discoverSkills,
  type SkillDiscoveryIssueCode,
} from './lib/discovered-skills.js'
import {
  cleanup,
  exportPersonas,
  MANIFEST_FILENAME,
  preview,
  refresh,
  resolveAgentsRoot,
} from './lib/pi-subagents-export.js'
import {
  formatReviewArtifactIssuePath,
  isLegacyReviewArtifact,
  readReviewArtifact,
  resolveReviewArtifactPath,
} from './lib/review-artifact-path.js'
import { ReviewArtifactSchema } from './lib/review-artifact-schema.js'
import { type Harness, setupHarness } from './lib/setup.js'
import * as skills from './lib/skills.js'

interface PackageMetadata {
  readonly name?: string
  readonly version?: string
}

function readPackageMetadata(packageRoot: string): PackageMetadata {
  try {
    const packageJsonPath = path.join(packageRoot, 'package.json')
    if (!fs.existsSync(packageJsonPath)) return {}
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.version === 'string'
        ? { version: record.version }
        : {}),
    }
  } catch {
    return {}
  }
}

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')
const VERSION = readPackageMetadata(PACKAGE_ROOT).version ?? 'unknown'

const HELP = `
systematic - OpenCode plugin for systematic engineering workflows

Usage:
  systematic <command> [options]

Commands:
  list [type]                  List available skills, agents, or commands
  capabilities                 Read-only standalone-CLI observation; not a host-runtime or canonical-registry view
  validate-review-artifact <path>
                               Validate a ce:review run artifact
                               The <path> argument is required by design; no artifact discovery is performed.
                               Exit statuses: 0 valid artifact, 1 validation failure,
                               2 operational failure, 3 legacy artifact with no schema_version
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
  systematic capabilities
  systematic validate-review-artifact .context/systematic/ce-review/review-summary.json
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

const VALIDATE_REVIEW_ARTIFACT_USAGE =
  'Usage: systematic validate-review-artifact <path>'
const REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/review-summary-schema.json'

interface CapabilityCliRoots {
  readonly agentsRoot: string
  readonly cwd: string
  readonly homeDir: string
  readonly packageRoot: string
  readonly configDir?: string
  readonly opencodeConfigDirOverride?: string
}

interface CapabilityCliOptions {
  readonly argv: readonly string[]
  readonly roots: CapabilityCliRoots
  readonly clock?: CapabilityClock
  readonly config?: ConfigObservationMetadata
  readonly outputSink?: CapabilityOutputSink
  readonly errorSink?: (message: string) => void
}

function defaultCapabilityRoots(): CapabilityCliRoots {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
    : path.join(os.homedir(), '.config/opencode')
  return {
    agentsRoot: path.join(PACKAGE_ROOT, 'agents'),
    configDir,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    opencodeConfigDirOverride:
      process.env.OPENCODE_CONFIG_DIR?.trim() || undefined,
    packageRoot: PACKAGE_ROOT,
  }
}

function sourceErrorForSkillIssue(
  issue: SkillDiscoveryIssueCode,
): 'source-malformed' | 'source-read-failed' {
  return issue === 'read-failed' ? 'source-read-failed' : 'source-malformed'
}

function discoverySummaryFact(
  discoveryId: 'agents' | 'skills',
  count: number,
  winningRoots: readonly string[],
): CapabilityFactInput {
  return {
    count,
    discoveryId,
    factId: 'discovery-summary',
    kind: 'discovery',
    sourceId: `discovery:${discoveryId}`,
    status: 'available',
    winningRoots,
  }
}

function unavailableDiscoveryFact(
  discoveryId: 'agents' | 'skills',
  errorCode: 'source-malformed' | 'source-read-failed' | 'structural-invalid',
): CapabilityFactInput {
  return {
    errorCode,
    factId: 'discovery-summary',
    sourceId: `discovery:${discoveryId}`,
    status: 'unavailable',
  }
}

function discoverySourceIssueFact(
  errorCode: 'source-malformed' | 'source-read-failed',
): CapabilityFactInput {
  return {
    errorCode,
    factId: 'discovery-source-issue',
    kind: 'status',
    sourceId: 'discovery:skills',
    status: 'unavailable',
  }
}

function collectSkillFacts(roots: CapabilityCliRoots): CapabilityFactInput[] {
  let issue: SkillDiscoveryIssueCode | undefined
  try {
    const skills = discoverSkills({
      configDir: roots.configDir,
      homeDir: roots.homeDir,
      onIssue: (nextIssue) => {
        issue ??= nextIssue
      },
      opencodeConfigDirOverride: roots.opencodeConfigDirOverride,
      startDir: roots.cwd,
    })
    const winningRoots = [...new Set(skills.map((skill) => skill.root))].sort()
    const facts = [discoverySummaryFact('skills', skills.length, winningRoots)]
    if (issue !== undefined) {
      facts.push(discoverySourceIssueFact(sourceErrorForSkillIssue(issue)))
    }
    return facts
  } catch {
    return [discoverySourceIssueFact('source-malformed')]
  }
}

function collectAgentFact(agentsRoot: string): CapabilityFactInput {
  try {
    const catalog = buildAgentCatalog(agentsRoot)
    return discoverySummaryFact('agents', catalog.length, ['agents'])
  } catch {
    return unavailableDiscoveryFact('agents', 'structural-invalid')
  }
}

function collectDiscoveryFacts(
  roots: CapabilityCliRoots,
): CapabilityFactInput[] {
  return [
    {
      factId: 'host-runtime',
      limitationCode: 'host-runtime-unobservable',
      status: 'unknown',
    },
    ...collectSkillFacts(roots),
    collectAgentFact(roots.agentsRoot),
  ]
}

function collectConfigMetadata(
  roots: CapabilityCliRoots,
  injected?: ConfigObservationMetadata,
): ConfigObservationMetadata | undefined {
  if (injected !== undefined) return injected
  try {
    return loadConfigWithSources(roots.cwd, {
      customConfigDir: roots.opencodeConfigDirOverride ?? null,
      homeDir: roots.homeDir,
      invalidSource: 'report',
      userConfigDir: roots.configDir,
      warningSink: () => undefined,
    }).metadata
  } catch {
    return undefined
  }
}

function resolveCapabilityRootPath(root: string): string {
  try {
    return fs.realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

function capabilityRoots(roots: CapabilityCliRoots): readonly {
  id: 'agents' | 'cwd' | 'package' | 'skills' | 'user'
  path: string
}[] {
  return [
    { id: 'agents', path: resolveCapabilityRootPath(roots.agentsRoot) },
    { id: 'cwd', path: resolveCapabilityRootPath(roots.cwd) },
    { id: 'package', path: resolveCapabilityRootPath(roots.packageRoot) },
    {
      id: 'skills',
      path: resolveCapabilityRootPath(path.join(roots.packageRoot, 'skills')),
    },
    { id: 'user', path: resolveCapabilityRootPath(roots.homeDir) },
  ]
}

function capabilityPackage(packageRoot: string): {
  readonly name: string
  readonly version: string
} {
  const metadata = readPackageMetadata(packageRoot)
  return {
    name: metadata.name ?? 'unknown',
    version: metadata.version ?? 'unknown',
  }
}

function runCapabilities(options: CapabilityCliOptions): number {
  const outputSink =
    options.outputSink ?? ((value: string) => console.log(value))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const isFullArgv =
    options.argv.length === 2 &&
    options.argv[0] === 'systematic' &&
    options.argv[1] === 'capabilities'
  const isCommandOnlyArgv =
    options.argv.length === 1 && options.argv[0] === 'capabilities'
  if (!isFullArgv && !isCommandOnlyArgv) {
    errorSink('Usage: systematic capabilities')
    return 2
  }
  const builderArgv = isFullArgv ? options.argv : ['systematic', 'capabilities']

  try {
    buildCapabilitySnapshot({
      argv: builderArgv,
      clock: options.clock,
      config: collectConfigMetadata(options.roots, options.config),
      facts: collectDiscoveryFacts(options.roots),
      outputSink,
      package: capabilityPackage(options.roots.packageRoot),
      roots: capabilityRoots(options.roots),
    })
    return 0
  } catch {
    errorSink('Capabilities diagnostic unavailable')
    return 1
  }
}

export function runCapabilitiesCli(options: CapabilityCliOptions): number {
  return runCapabilities(options)
}

interface ValidateReviewArtifactCliOptions {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

function validateReviewArtifactArgument(
  argv: readonly string[],
): string | undefined {
  const commandIndex = argv[0] === 'systematic' ? 1 : 0
  if (argv[commandIndex] !== 'validate-review-artifact') return undefined
  if (argv.length !== commandIndex + 2) return undefined
  return argv[commandIndex + 1]
}

function runValidateReviewArtifact(
  options: ValidateReviewArtifactCliOptions,
): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const input = validateReviewArtifactArgument(options.argv)
  if (input === undefined) {
    errorSink(VALIDATE_REVIEW_ARTIFACT_USAGE)
    return 2
  }

  const resolved = resolveReviewArtifactPath(
    input,
    options.cwd ?? process.cwd(),
  )
  if (!resolved.ok) {
    errorSink(resolved.message)
    return 2
  }

  const artifact = readReviewArtifact(resolved.path)
  if (!artifact.ok) {
    errorSink(artifact.message)
    return 2
  }

  if (isLegacyReviewArtifact(artifact.value)) {
    errorSink('Legacy review artifact: no schema_version field')
    return 3
  }

  const result = ReviewArtifactSchema.safeParse(artifact.value)
  if (!result.success) {
    for (const issue of result.error.issues) {
      const issuePath = formatReviewArtifactIssuePath(issue.path)
      // The custom-message exception depends on author-written constants;
      // tests/unit/review-artifact-schema.test.ts enforces that contract.
      const authoredMessage =
        issue.code === 'custom' ? `: ${issue.message}` : ''
      errorSink(`${issuePath} ${issue.code}${authoredMessage}`)
    }
    errorSink(`Schema: ${REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH}`)
    errorSink(
      `Review artifact validation failed: ${result.error.issues.length} issue(s)`,
    )
    return 1
  }

  outputSink('Review artifact is valid')
  return 0
}

export function runValidateReviewArtifactCli(
  options: ValidateReviewArtifactCliOptions,
): number {
  return runValidateReviewArtifact(options)
}

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

function runPreview(agentsRoot: string, scope: 'project' | 'global'): void {
  const plan = preview(agentsRoot, { scope, cwd: process.cwd() })
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

function runExport(agentsRoot: string, scope: 'project' | 'global'): void {
  const configOptions = { scope, cwd: process.cwd() }
  const plan = preview(agentsRoot, configOptions)
  if (plan.status === 'error') {
    console.error(
      `Export failed (preview step): ${plan.error ?? 'unknown error'}`,
    )
    process.exit(1)
  }
  console.log(`Target: ${plan.agentsRoot}`)
  const hasWork = plan.actions.some(
    (a) =>
      a.action === 'create' ||
      a.action === 'update' ||
      a.action === 'refuse' ||
      a.action === 'remove',
  )
  if (plan.actions.length > 0) {
    console.log('')
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
  if (!hasWork) {
    console.log('All persona files are already up to date. No changes.')
    return
  }
  const result = exportPersonas(agentsRoot, configOptions)
  if (result.status === 'error') {
    console.error(`Export failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const hadRemovals = plan.actions.some((a) => a.action === 'remove')
  if (result.written === 0 && result.refused.length === 0 && !hadRemovals) {
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

function runRefresh(agentsRoot: string, scope: 'project' | 'global'): void {
  const result = refresh(agentsRoot, { scope, cwd: process.cwd() })
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

function runCleanup(agentsRoot: string, scope: 'project' | 'global'): void {
  let result: ReturnType<typeof cleanup>
  try {
    result = cleanup(agentsRoot, { scope, cwd: process.cwd() })
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
      runPreview(agentsRoot, scope)
      break
    case 'export':
      runExport(agentsRoot, scope)
      break
    case 'refresh':
      runRefresh(agentsRoot, scope)
      break
    case 'cleanup':
      runCleanup(agentsRoot, scope)
      break
    default:
      console.error(`Unknown pi-subagents subcommand: ${subcommand}`)
      console.error(PI_SUBAGENTS_USAGE)
      process.exit(1)
  }
}

function runLegacyCli(args: string[]): void {
  const command = args[0]

  switch (command) {
    case 'list':
      listItems(args[1] || 'skills')
      break
    case 'capabilities': {
      const status = runCapabilitiesCli({
        argv: ['systematic', ...args],
        errorSink: console.error,
        outputSink: console.log,
        roots: defaultCapabilityRoots(),
      })
      if (status !== 0) process.exit(status)
      break
    }
    case 'validate-review-artifact': {
      const status = runValidateReviewArtifactCli({
        argv: ['systematic', ...args],
        cwd: process.cwd(),
        errorSink: console.error,
        outputSink: console.log,
      })
      if (status !== 0) process.exit(status)
      break
    }
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
}

if (import.meta.main) {
  runLegacyCli(process.argv.slice(2))
}
